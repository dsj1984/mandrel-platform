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
#   - leftover `gitleaks.tmp` / `gitleaks-*` artifacts in the shared $TMPDIR
#     blocking the next gitleaks download.
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
#   3. Age-gates cleanup of the genuinely shared $TMPDIR gitleaks artifacts,
#      so a fresh (in-flight) download owned by a concurrent job is never
#      deleted — only stale leftovers are.
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
#                  `${RUNNER_DIR}/_work/_temp`.
#   JOB_CLEANUP_STALE_MINUTES
#                — age threshold (minutes) for the shared-$TMPDIR gitleaks
#                  sweep. Default 60. Artifacts younger than this are assumed
#                  in-flight and left alone.
#
# Configured via `ACTIONS_RUNNER_HOOK_JOB_STARTED=<RUNNER_DIR>/job-cleanup.sh`
# in the runner's `.env` (see .env.example in this directory).
#
# NEVER fails the job — best-effort cleanup, always exits 0.

set +e

RUNNER_DIR="${RUNNER_DIR:-$(cd "$(dirname "$0")" && pwd)}"
RUNNER_WORK="${RUNNER_DIR}/_work"
RUNNER_TMP="${RUNNER_WORK}/_temp"
TMP="${TMPDIR:-/tmp}"
STALE_MINUTES="${JOB_CLEANUP_STALE_MINUTES:-60}"

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

# 3) Sweep stale gitleaks artifacts from the SHARED $TMPDIR. Because this
#    location is shared by every runner on the host, deletion is age-gated:
#    only artifacts older than STALE_MINUTES are removed, so a concurrent
#    runner's in-flight download is never deleted mid-job.
find "${TMP}" -maxdepth 1 -name 'gitleaks.tmp' -mmin "+${STALE_MINUTES}" \
  -exec rm -f  {} + 2>/dev/null
find "${TMP}" -maxdepth 1 -name 'gitleaks-*'   -mmin "+${STALE_MINUTES}" \
  -exec rm -rf {} + 2>/dev/null

exit 0
