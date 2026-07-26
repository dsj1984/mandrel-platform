#!/usr/bin/env bash
#
# ACTIONS_RUNNER_HOOK_JOB_STARTED hook — generalized, runner-scoped hygiene
# for PERSISTENT self-hosted runners (mandrel-platform runner kit).
#
# A persistent runner (launchd/systemd service) leaks state from a prior job
# into the next one: the runner does not always reap the job's child process
# tree, and some actions leave files in shared locations. Observed breakage
# classes this hook guards against:
#
#   - an orphaned `pnpm`/`node` process (e.g. a hung install or lint) still
#     mutating the pnpm shim install, corrupting the pnpm CLI for the next job;
#   - leftover tool-download temp dirs (gitleaks, OSV-scanner, the semgrep
#     venv) accumulating in the runner's own job temp.
#
# Running this before every job gives each job a clean slate ("fresh per job"
# without the cost of re-registering an ephemeral runner).
#
# ── CONCURRENCY SAFETY (the load-bearing design constraint) ─────────────────
#
# Multiple runners on one host typically run as the SAME OS user, so anything
# under $HOME (notably `~/setup-pnpm`, the pnpm/action-setup DEFAULT install
# destination) is SHARED across all co-resident runners. A hook that reaps
# processes matching `~/setup-pnpm` or `rm -rf`s it will destroy a pnpm
# install a CONCURRENT runner is mid-flight on. This hook therefore:
#
#   1. NEVER touches `~/setup-pnpm` or any other $HOME-shared pnpm path.
#      The pnpm shim MUST instead be runner-scoped at install time: the
#      platform's `setup-toolchain` composite action already defaults
#      pnpm/action-setup's `dest` to `${{ runner.temp }}/pnpm` (i.e.
#      `<RUNNER_DIR>/_work/_temp/pnpm`, unique per runner), and
#      `pr-quality.yml` exposes a `pnpm-dest` input for explicit overrides.
#      See templates/runbooks/runner-provisioning.md § "pnpm scoping".
#   2. Reaps ONLY processes whose command line resolves inside THIS runner's
#      own work tree (`<RUNNER_DIR>/_work/...`). Every path below derives
#      from RUNNER_DIR, which is unique per runner, so a co-resident
#      runner's processes and files are never matched.
#   3. NEVER READS the shared OS temp root, either. Reading is not free: the
#      hook runs inside the JOB's clock, so any cost here is charged to
#      `Set up runner` and counts against the job's own `timeout-minutes`.
#      $TMPDIR is unbounded and shared with every other process on the host,
#      so a sweep rooted there costs a function of how much UNRELATED junk
#      the host has accumulated — see the incident note below.
#
# ── WHY THE SHARED-$TMPDIR SWEEP IS GONE (issue #343) ───────────────────────
#
# This hook used to age-gate two `find "$TMPDIR" -maxdepth 1 -name …` sweeps
# for `gitleaks.tmp` / `gitleaks-*`. `-maxdepth 1 -name <literal>` is a FULL
# directory enumeration for what is really an existence check, so its cost
# scaled with host churn. On the swarm-os runner host $TMPDIR reached 841,690
# entries; one scan measured 42s, the hook ran two of them, and up to 16
# co-resident runners ran it concurrently. `Set up runner` reached 5m29s, and
# every job whose `timeout-minutes` sat at or below that was killed before its
# first real step — surfacing as `cancelled` on an innocent diff.
#
# It was also a no-op: the platform's actions extract via `mktemp -d`, so
# nothing ever created `gitleaks.tmp` or `gitleaks-*`. The sweep paid an
# unbounded cost hunting names that never existed, while the dirs the actions
# DID leave went unswept.
#
# The fix is ownership, not tuning: every platform action now extracts into
# `${RUNNER_TEMP}` (== RUNNER_TMP below), which is unique per runner. A
# co-resident runner's in-flight download is therefore unreachable from here
# by construction — which is what retired the age gate outright (along with
# the stale-minutes env knob that tuned it), rather than merely shrinking its
# blast radius. Keep it that way: a sweep added here MUST be rooted at
# RUNNER_TMP.
#
# ── PARAMETERIZATION ────────────────────────────────────────────────────────
#
# No hardcoded usernames, repo names, or runner names. All paths derive from:
#
#   RUNNER_DIR   — the runner's root directory. Defaults to the directory
#                  containing this script (the kit installs the hook into the
#                  runner root, next to config.sh / run.sh). Override via env
#                  only if you install the hook elsewhere.
#   RUNNER_TMP   — the runner's per-runner job temp (`runner.temp`), always
#                  `${RUNNER_DIR}/_work/_temp`. Every path this hook touches
#                  lives under it.
#
# Configured via `ACTIONS_RUNNER_HOOK_JOB_STARTED=<RUNNER_DIR>/job-cleanup.sh`
# in the runner's `.env` (see .env.example in this directory).
#
# NEVER fails the job — best-effort cleanup, always exits 0.

set +e

RUNNER_DIR="${RUNNER_DIR:-$(cd "$(dirname "$0")" && pwd)}"
RUNNER_WORK="${RUNNER_DIR}/_work"
RUNNER_TMP="${RUNNER_WORK}/_temp"

# 1) Reap orphaned pnpm/node processes from prior jobs — scoped to THIS
#    runner's work tree only. The patterns target executable paths INSIDE the
#    runner-scoped install locations (`.../node_modules`), so they match the
#    actual pnpm/node binaries that ran from these dirs — not a shell that
#    merely references the path. RUNNER_TMP and RUNNER_WORK are unique per
#    runner, so co-resident runners and unrelated user processes are never
#    hit. The shared `~/setup-pnpm` is deliberately NOT a reap target (see
#    the concurrency-safety header).
pkill -9 -f "${RUNNER_TMP}/pnpm/node_modules"       2>/dev/null
pkill -9 -f "${RUNNER_TMP}/setup-pnpm/node_modules" 2>/dev/null
pkill -9 -f "${RUNNER_WORK}/_tool/[^ ]*node_modules" 2>/dev/null

# 2) Remove stale runner-scoped pnpm shim installs so the next job's
#    pnpm/action-setup starts from a clean slate. Only paths under THIS
#    runner's `_work/_temp` are deleted — never `~/setup-pnpm`.
rm -rf "${RUNNER_TMP}/pnpm"       2>/dev/null
rm -rf "${RUNNER_TMP}/setup-pnpm" 2>/dev/null

# 3) Remove this runner's own leftover tool-download temp dirs. The platform's
#    composite actions and workflows create these via
#    `mktemp -d "${RUNNER_TEMP}/<tool>.XXXXXX"`, so every one of them is
#    runner-scoped and a co-resident runner's in-flight download is
#    unreachable here — no age gate is needed (see the issue #343 note above).
#
#    Globbing is what keeps this bounded: the shell expands these against
#    RUNNER_TMP alone, so the cost is a function of THIS runner's leftovers,
#    never of host-wide churn. Do not replace it with a `find` over a parent.
#    A glob that matches nothing stays literal, and `rm -rf` on a nonexistent
#    path is silent — hence the nullglob-free form plus 2>/dev/null.
rm -rf "${RUNNER_TMP}"/gitleaks.*    2>/dev/null
rm -rf "${RUNNER_TMP}"/osv-scanner.* 2>/dev/null
rm -rf "${RUNNER_TMP}"/semgrep.*     2>/dev/null
rm -f  "${RUNNER_TMP}"/gh-api-err.*  2>/dev/null

exit 0
