#!/usr/bin/env bash
#
# check-runner-env-drift.sh — report per-runner `.env` configuration drift
# across one host's runner pool (mandrel-platform runner kit).
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
#
# Nothing else observes a runner's LOCAL configuration. The fleet monitor
# (`scripts/check-runner-health.mjs`) reaches runners through
# `GET /repos/{owner}/{repo}/actions/runners`, which reports a runner's name,
# labels and online status — the endpoint cannot see `<RUNNER_DIR>/.env`, so
# hook configuration is invisible to it.
#
# The consequence is that a partially-provisioned pool never presents as a
# configuration fault. It presents as an unattributable behavioural difference
# between two runs of the SAME job on the SAME repo. That is issue #343: on one
# host, 16 of 19 runners carried ACTIONS_RUNNER_HOOK_JOB_STARTED; two of the
# hooked ones sat 5m29s in `Set up runner` while the same job on an unhooked
# runner finished in 54 seconds. Attributing that took far longer than reading
# nineteen `.env` files would have — which is precisely what this script does.
#
# ── WHAT IT REPORTS ─────────────────────────────────────────────────────────
#
# PRESENCE — never value — of the four keys `.env.example` mandates:
# ACTIONS_RUNNER_HOOK_JOB_STARTED, RUNNER_TOOL_CACHE, AGENT_TOOLSDIRECTORY,
# LANG. Values are deliberately not compared: every one of them embeds the
# runner's own absolute root path, so they are SUPPOSED to differ per runner.
#
# The drift signal is a key set on SOME runners but not all — the 16-of-19
# shape. A key absent from EVERY runner is a uniform gap: reported as such, and
# not on its own a non-zero exit. A fleet that has deliberately not adopted a
# key must not be a standing alarm, or the operator learns to ignore the exit
# code and the signal is worth nothing when it does fire.
#
# ── OPERATOR CONTRACT ───────────────────────────────────────────────────────
#
#   check-runner-env-drift.sh [--pool-root <dir>]
#
#   --pool-root <dir>  Directory holding one subdirectory per runner. Defaults
#                      to the PARENT of the directory containing this script:
#                      the kit installs it into <RUNNER_DIR>, and the runbook
#                      mandates one directory per runner under a common root,
#                      so the default is correct on any kit-provisioned host.
#
#   A child directory counts as a runner iff it contains `config.sh`. That
#   predicate keeps unrelated siblings (shared caches, scratch dirs) out of the
#   report without inventing a naming convention.
#
#   exit 0 — no drift: every mandated key is uniform across the pool (set
#            everywhere, or unset everywhere).
#   exit 1 — drift: at least one key is set on some runners but not all. The
#            non-zero exit IS the alert channel, matching the posture
#            `scripts/check-runner-health.mjs` already uses, so this can be
#            scheduled.
#   exit 2 — usage error: unknown flag, or a pool root that is not a directory
#            or holds no runners. Deliberately distinct from 0: reporting "no
#            drift" over an empty walk would read as evidence the fleet is
#            uniform.
#
# READ-ONLY, and never fails soft on a broken runner. It writes nothing into a
# runner root and never touches a launchd service. A runner whose `.env` is
# missing or unreadable is recorded as all four keys unset and the walk
# continues — one broken runner must not shrink the sample the verdict is
# computed over.
#
# This is an OPERATOR-run tool, not a job hook. Do not wire it into
# ACTIONS_RUNNER_HOOK_JOB_STARTED: that hook runs inside the job's clock, where
# every read is billed to `Set up runner` and counts against the job's
# `timeout-minutes` (issue #343). A pool-wide walk belongs outside that clock.
#
# ── PORTABILITY ─────────────────────────────────────────────────────────────
#
# Runs on the host with no repo checkout and no Node runtime, and stays
# compatible with macOS's system bash 3.2 — the same constraint
# `.github/actions/gitleaks-scan/action.yml` documents for this fleet. That
# rules out `declare -A`, `mapfile`/`readarray`, and `${var,,}`; it does NOT
# rule out plain INDEXED arrays, which 3.2 supports and which the accumulators
# below use. Only the per-key tally needs a second pass, because keeping a
# key->count table is the one thing an indexed array cannot do.
#
# Accumulating into arrays rather than splitting a delimited string on a
# reassigned `IFS` is deliberate and load-bearing: reassigning IFS globally is
# flagged by the platform's own SAST ruleset (`bash.lang.security.ifs-tampering`)
# because it silently changes the splitting behaviour of every later unquoted
# expansion in the script. Arrays give the same grouping with no global state
# and no quoting hazard for a runner directory whose name contains whitespace.

set -u

MANDATED_KEYS=(
  ACTIONS_RUNNER_HOOK_JOB_STARTED
  RUNNER_TOOL_CACHE
  AGENT_TOOLSDIRECTORY
  LANG
)

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
POOL_ROOT=$(dirname "$SCRIPT_DIR")

usage() {
  cat <<'USAGE'
Usage: check-runner-env-drift.sh [--pool-root <dir>]

Reports which runners in a pool are missing the `.env` keys the runner kit
mandates. Read-only.

  --pool-root <dir>   Pool root (default: the parent of this script's dir).
  -h, --help          Show this help.

Exit: 0 no drift · 1 drift · 2 usage error.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pool-root)
      if [ $# -lt 2 ]; then
        printf 'check-runner-env-drift: --pool-root requires a directory\n' >&2
        exit 2
      fi
      POOL_ROOT=$2
      shift 2
      ;;
    --pool-root=*)
      POOL_ROOT=${1#--pool-root=}
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'check-runner-env-drift: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$POOL_ROOT" ]; then
  printf 'check-runner-env-drift: pool root is not a directory: %s\n' "$POOL_ROOT" >&2
  exit 2
fi
POOL_ROOT=$(cd "$POOL_ROOT" && pwd)

# Presence test for one key in one runner's `.env`.
#
# The assignment form is `^[[:space:]]*KEY=` on a non-comment line. A commented
# line cannot match (the `#` is not whitespace), which is the case that matters:
# `.env.example` ships every key inside a block of explanatory prose, so a
# half-applied copy where the operator never uncommented a line is the most
# likely real drift shape — and matching the key name anywhere in the file would
# report that runner as fully provisioned. The trailing `=` is equally
# load-bearing: without it `LANGUAGE=` would satisfy `LANG`.
#
# A missing, unreadable, or non-regular `.env` returns "unset" rather than
# aborting, so the caller records all keys unset and keeps walking.
env_has_key() {
  env_file=$1
  env_key=$2

  [ -f "$env_file" ] || return 1
  [ -r "$env_file" ] || return 1
  grep -Eq "^[[:space:]]*${env_key}=" "$env_file" 2>/dev/null
}

key_total=${#MANDATED_KEYS[@]}

# Enumerate runners. A glob matching nothing stays literal and fails the `-d`
# test, so an empty pool root falls through to the exit-2 branch below.
runner_names=()
for candidate in "$POOL_ROOT"/*/; do
  [ -d "$candidate" ] || continue
  [ -f "${candidate}config.sh" ] || continue
  runner_names+=("$(basename "$candidate")")
done
runner_count=${#runner_names[@]}

if [ "$runner_count" -eq 0 ]; then
  printf 'check-runner-env-drift: no runner directories under %s\n' "$POOL_ROOT" >&2
  printf 'check-runner-env-drift: a runner is a child directory containing config.sh — is this the pool root?\n' >&2
  exit 2
fi

printf 'runner .env configuration drift report\n'
printf '  pool root: %s\n' "$POOL_ROOT"
printf '  runners:   %d\n' "$runner_count"
printf '\n'

printf 'per-runner:\n'
for name in "${runner_names[@]}"; do
  unset_keys=()
  for key in "${MANDATED_KEYS[@]}"; do
    if ! env_has_key "$POOL_ROOT/$name/.env" "$key"; then
      unset_keys+=("$key")
    fi
  done

  if [ "${#unset_keys[@]}" -eq 0 ]; then
    printf '  %s: all %d mandated keys set\n' "$name" "$key_total"
  else
    # `${arr[*]}` joins on the first character of IFS — a space, since this
    # script never reassigns it. Safe for key names, which carry no whitespace;
    # runner names are printed one per line below for exactly that reason.
    printf '  %s: unset %s\n' "$name" "${unset_keys[*]}"
  fi
done
printf '\n'

printf 'per-key:\n'
drift_count=0
for key in "${MANDATED_KEYS[@]}"; do
  set_count=0
  unset_names=()
  for name in "${runner_names[@]}"; do
    if env_has_key "$POOL_ROOT/$name/.env" "$key"; then
      set_count=$((set_count + 1))
    else
      unset_names+=("$name")
    fi
  done

  if [ "$set_count" -eq "$runner_count" ]; then
    printf '  %s: ok — set on %d of %d runners\n' "$key" "$set_count" "$runner_count"
  elif [ "$set_count" -eq 0 ]; then
    printf '  %s: uniformly unset — set on 0 of %d runners; a uniform gap, not drift\n' "$key" "$runner_count"
  else
    # Reached only when 0 < set_count < runner_count, so unset_names is
    # non-empty here — one name per line, because a runner directory name may
    # contain whitespace and a joined list would make it unactionable.
    drift_count=$((drift_count + 1))
    printf '  %s: DRIFT — set on %d of %d runners; unset on:\n' "$key" "$set_count" "$runner_count"
    for name in "${unset_names[@]}"; do
      printf '      %s\n' "$name"
    done
  fi
done
printf '\n'

if [ "$drift_count" -eq 0 ]; then
  printf 'no drift: every mandated key is uniform across the pool.\n'
  exit 0
fi

printf 'DRIFT: %d of %d mandated keys are set on some runners but not all.\n' "$drift_count" "$key_total"
printf 'Provision the runners named above from templates/runner/.env.example,\n'
printf 'then restart each one so it reloads .env: ./svc.sh stop && ./svc.sh start\n'
exit 1
