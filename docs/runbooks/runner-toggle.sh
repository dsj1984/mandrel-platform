#!/usr/bin/env bash
# runner-toggle.sh — interactively set how many self-hosted GitHub Actions
# runners in one fleet folder are active on this machine.
#
#   ./runner-toggle
#
# That is the whole interface. The script walks you through:
#   1. pick a fleet folder (numbered list with "active of total" counts)
#   2. read the fleet's status table
#   3. type how many runners should be active (blank leaves it as is)
#   4. if the target cannot be reached without stopping a runner that is
#      mid-job, choose whether to wait for those jobs to finish
#
# VERSION: 2.2.0  (2026-09-10)
#
# WHY THIS EXISTS
# ---------------
# A developer Mac hosts several runner fleets, one folder per fleet, one
# sub-folder per registered runner (github-runners/<fleet>/<fleet>-<n>/).
# Each runner is a launchd LaunchAgent that the stock `svc.sh` in its folder
# can start, stop and query. Scaling a fleet by hand means `cd`-ing into each
# folder in turn, and `launchctl list` output is unreadable at a dozen
# runners. This script turns that into one guided prompt: "make it N".
#
# It is deliberately interactive-only (v2). Earlier revisions took
# `<fleet> <N> --wait --dry-run` arguments; the operator asked for a single
# guided flow instead, so those were removed rather than kept as a parallel
# path. Every step prints what it is about to do, and each `svc.sh` call is
# echoed, so the transcript doubles as the audit trail.
#
# LAYOUT ASSUMPTIONS (the only coupling to the runner install)
# -------------------------------------------------------------
#   <fleet-dir>/<runner>/svc.sh     stock GitHub runner service script
#   <fleet-dir>/<runner>/.service   absolute path of the runner's launchd plist
#   <fleet-dir>/<runner>/bin/Runner.Listener   the always-on listener process
#   <fleet-dir>/<runner>/bin/Runner.Worker     exists only while a job is running
#
# A "fleet" is any folder under the resolved fleet root (see step 0) holding
# at least one sub-folder with svc.sh + .service. Other sub-folders (tarballs,
# notes) are ignored.
#
# The runner folders are the source of truth, NOT ~/Library/LaunchAgents:
# that directory accumulates plists for runners whose folders were deleted,
# and iterating folders sidesteps those orphans.
#
# ORDERING
# --------
# Runner numbering is rarely contiguous (a fleet may have 1-7, 11, 12, 16-18),
# and a lexical sort puts `x-11` before `x-2`, so runners are ordered by their
# trailing integer. A folder with no numeric suffix sorts as 0. "N active"
# always means "the N lowest-numbered": scale-up starts from the bottom,
# scale-down stops from the top.
#
# SAFETY: busy runners
# --------------------
# `svc.sh stop` is a plain `launchctl unload`, which kills the listener and
# CANCELS any job it is running. So a runner whose Runner.Worker exists is
# "busy" and is never stopped without asking. That verdict is only as good as
# the match behind it, so `is_busy` compares the worker path LITERALLY — as a
# whole argv token in one `ps` snapshot, never as a regex and never through a
# `grep` that would match its own command line. See the function's own comment
# for the two ways the old `pgrep -f` form got this wrong.
# Idle runners are stopped first;
# if busy ones remain in the way, you are asked whether to wait. Waiting
# polls every 10s and stops each busy runner the moment its job finishes;
# Ctrl-C abandons the wait (the idle stops already made stay made). There is
# deliberately no "cancel the job" option: that should be an explicit
# `./svc.sh stop` in the runner's own folder.
#
# PERSISTENCE
# -----------
# Unloading the plist means a stopped runner stays down across logout and
# reboot; `svc.sh start` uses `launchctl load -w`, which re-enables it. So
# the count you set is durable until you change it.
#
# STATES in the status table
# --------------------------
#   idle     loaded, listener has a PID, no job running
#   busy     loaded, listener has a PID, Runner.Worker present
#   dead     loaded in launchd but the listener has no PID (crashed / exited);
#            counts as inactive; a scale-up unloads then loads it
#   stopped  not loaded in launchd
#
# EXIT CODES
# ----------
#   0  target reached, or the session was left as is
#   1  bad input, no fleets found, a svc.sh call failed, or busy runners were
#      left running because you chose not to wait (target NOT reached)
#
# PORTABILITY
# -----------
# macOS only (launchd). Written for the stock /bin/bash 3.2: no mapfile, no
# associative arrays, `${arr[@]+"${arr[@]}"}` for possibly-empty arrays.
# `ci.yml`'s `runner-kit-bash32` job runs `bash -n` on this file and
# `scripts/runner-toggle.test.mjs` under that same system bash, so a 3.2
# syntax regression surfaces in CI rather than at an operator's prompt.
#
# TESTABILITY
# -----------
# Everything above the `BASH_SOURCE[0] == $0` guard near the bottom is
# definitions only, so `scripts/runner-toggle.test.mjs` can source this file
# and call the real `is_busy` against a stub `ps` on PATH. Sourcing it must
# stay side-effect free: no prompt, no output, no launchd or fleet lookup.
#
# CANONICAL COPY
# --------------
# mandrel-platform/docs/runbooks/runner-toggle.sh — see runner-fleet.md next
# to it. The installed copy is a real COPY, deliberately not a symlink into
# that repo: mandrel-platform is branched constantly (story-<id> branches), and
# a symlink dangles the moment a checkout lands on a branch without this file.
# An operator tool must not break because of an unrelated branch switch.
# `runner-fleet.md` carries the one-line reinstall; the VERSION above is how
# you tell an installed copy from the canonical one.

set -euo pipefail

POLL_SECS=10

# Fallback fleet root for a PATH install, where SELF_DIR is a bin directory
# with no fleets in it.
DEFAULT_ROOT="${HOME}/Development/github-runners"

# The launchctl snapshot every pid lookup reads. Declared empty here and
# filled by the interactive body below: taking it at load time would make
# sourcing this file run a command, and `pid_of` must stay safe under
# `set -u` for a test that only wants the helpers.
LAUNCHCTL=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
is_runner() { [ -f "$1/svc.sh" ] && [ -f "$1/.service" ]; }

# list_runners <fleet-dir>: one record per runner on stdout,
# "<num>\t<dir>\t<launchd-label>", ordered by the numeric suffix.
list_runners() {
  local d name num svc
  for d in "$1"/*/; do
    d="${d%/}"
    is_runner "$d" || continue
    name="$(basename "$d")"
    num="${name##*-}"; [[ "$num" =~ ^[0-9]+$ ]] || num=0
    svc="$(basename "$(cat "$d/.service")" .plist)"   # launchd label
    printf '%s\t%s\t%s\n' "$num" "$d" "$svc"
  done | sort -n -k1,1
}

dir_of()  { cut -f2 <<<"$1"; }
svc_of()  { cut -f3 <<<"$1"; }
pid_of()  { awk -v s="$1" '$3==s {print $1}' <<<"$LAUNCHCTL"; }  # "" unloaded, "-" loaded/no pid
is_up()   { [[ "$(pid_of "$1")" =~ ^[0-9]+$ ]]; }                # loaded AND running

# is_busy <runner-dir>: true while that runner's Runner.Worker is running.
#
# The match is LITERAL, and that is the whole point. This used to be
# `pgrep -qf "$1/bin/Runner.Worker"`, whose pattern is an extended REGEX
# over the process table: a fleet path holding `+`, `(` or `[` then matched
# paths it never should (`rnr+x(1)/...` also matches `rnrx1/...`), so a
# scale-down could read a mid-job runner as idle and cancel its job. A
# `ps ... | grep -F` pipeline is not the fix either: grep's own command line
# carries the needle, so it matches itself and reads EVERY runner as busy.
#
# So: one process-table snapshot, compared as whole argv tokens by bash's
# own `case`. The needle is inside double quotes, so it is data and never a
# pattern however the path is spelled. `ps` is resolved from PATH, which is
# what lets scripts/runner-toggle.test.mjs stub the table.
#
# An unreadable process table reports BUSY, not idle: the only action this
# answer gates is a stop that would cancel a running job.
is_busy() {
  local needle table line
  needle="$1/bin/Runner.Worker"
  table="$(ps -Aww -o args= 2>/dev/null)" || {
    echo "  WARNING: could not read the process table (ps failed); treating $(basename "$1") as busy" >&2
    return 0
  }
  while IFS= read -r line; do
    case " $line " in
      *" $needle "*) return 0 ;;
    esac
  done <<<"$table"
  return 1
}

# svc <dir> start|stop — wraps the stock svc.sh, which must run from its folder.
svc() {
  echo "  $2 $(basename "$1")"
  ( cd "$1" && ./svc.sh "$2" >/dev/null ) || { echo "  FAILED: $2 $(basename "$1")" >&2; return 1; }
}

# has_fleet <dir>: true when <dir> holds at least one fleet folder, i.e. a
# sub-folder with at least one runner in it. Used by the root resolution in
# the interactive body below.
has_fleet() {
  local d r
  [ -d "$1" ] || return 1
  for d in "$1"/*/; do
    for r in "${d%/}"/*/; do
      is_runner "${r%/}" && return 0
    done
  done
  return 1
}

# ---------------------------------------------------------------------------
# The interactive body
# ---------------------------------------------------------------------------
# Everything above is definitions; everything below prompts, reads launchd and
# calls svc.sh. `BASH_SOURCE[0] == $0` iff this file was RUN rather than
# sourced (the shape scripts/select-semgrep-python.sh uses), so
# scripts/runner-toggle.test.mjs can source it and exercise the real is_busy
# against a stub process table without a terminal, a fleet or a prompt.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  if [ $# -gt 0 ]; then
    echo "runner-toggle takes no arguments; just run it and follow the prompts." >&2
    exit 1
  fi
  [ -t 0 ] || { echo "runner-toggle is interactive and needs a terminal on stdin" >&2; exit 1; }

  # Where this script itself lives. Used as one candidate for the fleet root,
  # resolved further down once is_runner() exists.
  SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

  # ---------------------------------------------------------------------------
  # 0. Resolve the fleet root
  # ---------------------------------------------------------------------------
  # The "fleet root" is the folder that HOLDS the fleet folders. Two install
  # shapes must both work, so the root is the first candidate that actually
  # contains a fleet:
  #
  #   1. $RUNNER_TOGGLE_ROOT — explicit override. If set it is used verbatim;
  #      a root with no fleets in it is an error rather than a silent fallback,
  #      because a typo'd override should not quietly scale the wrong machine.
  #   2. this script's own directory — the "installed in the runners folder"
  #      shape, run as ./runner-toggle.
  #   3. DEFAULT_ROOT — the "installed on PATH" shape (e.g. ~/.local/bin), where
  #      the script's directory is a bin dir holding no runners.
  if [ -n "${RUNNER_TOGGLE_ROOT:-}" ]; then
    ROOT="$RUNNER_TOGGLE_ROOT"
    has_fleet "$ROOT" || { echo "RUNNER_TOGGLE_ROOT=$ROOT holds no runner fleets" >&2; exit 1; }
  elif has_fleet "$SELF_DIR"; then
    ROOT="$SELF_DIR"
  elif has_fleet "$DEFAULT_ROOT"; then
    ROOT="$DEFAULT_ROOT"
  else
    echo "no runner fleets found. Tried:" >&2
    echo "  \$RUNNER_TOGGLE_ROOT  (unset)" >&2
    echo "  $SELF_DIR  (this script's directory)" >&2
    echo "  $DEFAULT_ROOT  (default)" >&2
    echo "Set RUNNER_TOGGLE_ROOT to the folder holding your fleet folders." >&2
    exit 1
  fi
  ROOT="$(cd "$ROOT" && pwd)"

  # One launchctl snapshot per pass; refreshed before the closing table. Taken
  # here rather than at load time so sourcing this file runs no command.
  LAUNCHCTL="$(launchctl list)"

  # ---------------------------------------------------------------------------
  # 1. Pick a fleet
  # ---------------------------------------------------------------------------
  FLEETS=()
  for d in "$ROOT"/*/; do
    d="${d%/}"
    for r in "$d"/*/; do
      if is_runner "${r%/}"; then FLEETS+=("$d"); break; fi
    done
  done
  [ "${#FLEETS[@]}" -gt 0 ] || { echo "no fleet folders found under $ROOT" >&2; exit 1; }

  echo "Fleets under $ROOT:"
  i=0
  for d in "${FLEETS[@]}"; do
    i=$((i+1)); up=0; total=0
    while IFS= read -r rec; do
      total=$((total+1)); is_up "$(svc_of "$rec")" && up=$((up+1))
    done < <(list_runners "$d")
    printf '  %d) %-20s %d of %d active\n' "$i" "$(basename "$d")" "$up" "$total"
  done
  read -r -p "Fleet [1-${#FLEETS[@]}]: " choice
  [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#FLEETS[@]}" ] \
    || { echo "not a valid choice: '$choice'" >&2; exit 1; }
  FLEET="${FLEETS[$((choice-1))]}"
  echo

  # ---------------------------------------------------------------------------
  # 2. Show the fleet
  # ---------------------------------------------------------------------------
  RUNNERS=()
  while IFS= read -r line; do RUNNERS+=("$line"); done < <(list_runners "$FLEET")

  UP=(); DOWN=()   # active / inactive, numeric order preserved
  for r in "${RUNNERS[@]}"; do
    if is_up "$(svc_of "$r")"; then UP+=("$r"); else DOWN+=("$r"); fi
  done

  status_table() {
    local up=0 busy=0 r d s p state
    printf '%-16s %-8s %-7s %s\n' "RUNNER" "STATE" "PID" "SERVICE"
    for r in "${RUNNERS[@]}"; do
      d="$(dir_of "$r")"; s="$(svc_of "$r")"; p="$(pid_of "$s")"
      if   [ -z "$p" ];     then state="stopped"
      elif [ "$p" = "-" ];  then state="dead"
      elif is_busy "$d";    then state="busy"; up=$((up+1)); busy=$((busy+1))
      else                       state="idle"; up=$((up+1)); fi
      printf '%-16s %-8s %-7s %s\n' "$(basename "$d")" "$state" "$p" "$s"
    done
    echo
    echo "$up of ${#RUNNERS[@]} active ($busy busy)"
  }
  status_table
  echo

  # ---------------------------------------------------------------------------
  # 3. Ask for the target
  # ---------------------------------------------------------------------------
  read -r -p "How many should be active? [0-${#RUNNERS[@]}, blank = leave as is] " TARGET
  [ -n "$TARGET" ] || exit 0
  [[ "$TARGET" =~ ^[0-9]+$ ]] && [ "$TARGET" -le "${#RUNNERS[@]}" ] \
    || { echo "not a number between 0 and ${#RUNNERS[@]}: '$TARGET'" >&2; exit 1; }
  echo
  echo "$(basename "$FLEET"): ${#UP[@]} active, target $TARGET"

  # ---------------------------------------------------------------------------
  # 4. Reconcile
  # ---------------------------------------------------------------------------
  rc=0
  if [ "$TARGET" -gt "${#UP[@]}" ]; then
    # ---- scale up: lowest-numbered inactive runners first -------------------
    need=$((TARGET - ${#UP[@]}))
    for r in "${DOWN[@]+"${DOWN[@]}"}"; do
      [ "$need" -gt 0 ] || break
      d="$(dir_of "$r")"; s="$(svc_of "$r")"
      # A "dead" runner is still loaded; `launchctl load` would refuse it.
      if [ "$(pid_of "$s")" = "-" ]; then svc "$d" stop || true; fi
      if svc "$d" start; then need=$((need-1)); else rc=1; fi
    done

  elif [ "$TARGET" -lt "${#UP[@]}" ]; then
    # ---- scale down: highest-numbered active runners first ------------------
    # Idle candidates stop immediately. Busy candidates are queued in PENDING;
    # they still count toward `need`, so the walk stops once idle stops plus
    # queued busy runners cover the deficit.
    need=$((${#UP[@]} - TARGET))
    PENDING=()
    for (( i=${#UP[@]}-1; i>=0; i-- )); do
      [ "$((need - ${#PENDING[@]}))" -gt 0 ] || break
      d="$(dir_of "${UP[$i]}")"
      if is_busy "$d"; then
        PENDING+=("$d")
      elif svc "$d" stop; then
        need=$((need-1))
      else
        rc=1
      fi
    done

    if [ "${#PENDING[@]}" -gt 0 ]; then
      echo "  ${#PENDING[@]} runner(s) are mid-job and would be cancelled by a stop: ${PENDING[*]##*/}"
      read -r -p "  Wait for those jobs to finish, then stop them? (Ctrl-C abandons the wait) [y/N] " yn
      if [[ "$yn" =~ ^[Yy] ]]; then
        while [ "${#PENDING[@]}" -gt 0 ]; do
          still=()
          for d in "${PENDING[@]}"; do
            if is_busy "$d"; then still+=("$d"); else svc "$d" stop || rc=1; fi
          done
          PENDING=("${still[@]+"${still[@]}"}")
          [ "${#PENDING[@]}" -gt 0 ] || break
          printf '  still busy: %s (next check in %ss)\n' "${PENDING[*]##*/}" "$POLL_SECS"
          sleep "$POLL_SECS"
        done
      else
        echo "  left running: ${PENDING[*]##*/} (target not reached)" >&2
        rc=1
      fi
    fi
  fi

  echo
  LAUNCHCTL="$(launchctl list)"
  status_table
  exit $rc
fi
