#!/usr/bin/env bash
#
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED hook — reap THIS job's own surviving
# process tree at job end, on PERSISTENT self-hosted runners
# (mandrel-platform runner kit).
#
# ── WHY A SECOND HOOK (the gap job-cleanup.sh cannot close) ─────────────────
#
# `job-cleanup.sh` (ACTIONS_RUNNER_HOOK_JOB_STARTED) reaps a PREVIOUS job's
# orphans at the START of the next one. That is the right defence for a job
# that has not begun — but it runs before the new job's own processes exist,
# so it can do nothing once that job is minutes in. Nothing reaped a job's
# tree when the job ENDED, and a cancelled job is exactly where the tree
# survives: the runner terminates the step it is executing, not everything
# that step forked.
#
# The observed failure (consumer run 34854313590, 2026-09-14): a `Unit` job
# exited 143 (SIGTERM) two minutes into a 32-minute budget with every test
# passing and no cancellation request in the runner's own `Worker_*.log` —
# i.e. the signal came from outside the runner. Four minutes earlier the SAME
# runner had hosted a `cancelled` Unit job for a superseded push. Every
# concurrent job on the pool's other runners passed. A survivor of the
# cancelled job — a vitest fork or a dev server — was still on that runner
# with the next job's processes.
#
# This hook runs after the last step of every job, cancelled or not, and
# terminates whatever of that job's tree is still alive: SIGTERM, a bounded
# grace period, then SIGKILL. Together the two hooks are belt and braces —
# started = defence against the PREVIOUS job, completed = the job cleans up
# after itself while the runner still knows whose processes these are.
#
# ── CONCURRENCY SAFETY (the same load-bearing constraints as job-cleanup.sh)
#
# Multiple runners on one host typically run as the SAME OS user, so anything
# resolved against $HOME is SHARED across every co-resident runner. This hook
# therefore honours the constraints issue #343 produced, one for one:
#
#   1. NEVER a $HOME-shared path. `~/setup-pnpm` (pnpm/action-setup's DEFAULT
#      `dest`) is not a reap target here any more than it is in
#      job-cleanup.sh: a co-resident runner may be mid-install in it. The
#      pnpm shim is runner-scoped at install time instead — see
#      templates/runbooks/runner-provisioning.md § "pnpm scoping".
#   2. NEVER a shared $TMPDIR scan, and no directory enumeration at all. The
#      hook runs on the JOB's clock, so every read is billed to the job. Its
#      whole input is ONE `ps` snapshot, whose cost is a function of the
#      host's process count — bounded and small — never of the 841,690-entry
#      temp root that made `Set up runner` take 5m29s in #343.
#   3. EVERY path derives from RUNNER_DIR, which is unique per runner. A
#      process is a reap candidate only when its command line resolves inside
#      THIS runner's `<RUNNER_DIR>/_work/` tree, so a co-resident runner's
#      processes are unreachable from here by construction.
#   4. NEVER this script, its own ancestors, or the runner itself. The
#      ancestor chain is walked and protected explicitly, and
#      `Runner.Worker` / `Runner.Listener` are excluded by name — signalling
#      either would take the runner offline mid-job.
#
# ── WHAT IS REAPED ──────────────────────────────────────────────────────────
#
# Seed: processes whose command line contains `<RUNNER_DIR>/_work/`. Then the
# seeds' DESCENDANTS, transitively, by parent pid — a job's `sleep`, `esbuild`
# or worker fork carries no runner path in its own argv, so matching on the
# path alone would leave the leaves of the tree behind. Descendants of a
# runner-scoped process are runner-scoped by parentage, so the expansion does
# not widen the blast radius beyond this runner.
#
# ── PORTABILITY ─────────────────────────────────────────────────────────────
#
# macOS AND Linux runners, and macOS's system bash 3.2 (Apple cannot ship a
# GPL3 bash) — so no `declare -A`, no `mapfile`/`readarray`, no `${var,,}`.
# Process handling uses only forms both platforms have: `ps -A -w -w -o
# pid=,ppid=,command=` and `kill -TERM` / `-KILL` / `-0` with explicit pids.
# Deliberately NOT `pkill -f`: a pattern kill cannot exclude this script, its
# ancestors, or a co-resident runner's lookalike, and its matching semantics
# differ between the two platforms. The repeated `-w` is load-bearing —
# without it BSD `ps` truncates argv and a runner path late in a long node
# command line would go unseen.
#
# ── PARAMETERIZATION ────────────────────────────────────────────────────────
#
#   RUNNER_DIR — the runner's root directory. Defaults to the directory
#                containing this script (the kit installs the hook into the
#                runner root, next to config.sh / run.sh). Override via env
#                only if you install the hook elsewhere.
#
# Configured via
# `ACTIONS_RUNNER_HOOK_JOB_COMPLETED=<RUNNER_DIR>/job-completed.sh` in the
# runner's `.env` (see .env.example in this directory).
#
# NEVER fails the job — best-effort cleanup, always exits 0. Findings go to
# the job log, where they are attributable to the job that leaked them.

set -u

RUNNER_DIR="${RUNNER_DIR:-$(cd "$(dirname "$0")" && pwd)}"
RUNNER_WORK="${RUNNER_DIR}/_work"

# Grace between SIGTERM and SIGKILL: 30 polls × 0.1s = 3s worst case. Polled
# rather than slept whole, so a tree that exits on SIGTERM — the normal case —
# costs one poll, and a job with nothing to reap sleeps not at all.
GRACE_POLLS=30
POLL_INTERVAL=0.1

log() {
  printf 'job-completed: %s\n' "$1"
}

# Protected set: this script and every one of its ancestors. On a real runner
# the chain runs job-completed.sh -> Runner.Worker -> Runner.Listener, and
# signalling any of them would end the job's own bookkeeping or the runner
# service. Bounded at 32 hops so a cycle in a hostile process table cannot
# spin here on the job's clock.
self_pid=$$
protected=" ${self_pid} "
ancestor=${self_pid}
hops=0
while [ "$hops" -lt 32 ]; do
  parent=$(ps -o ppid= -p "$ancestor" 2>/dev/null | tr -d '[:space:]')
  case "$parent" in
    "" | 0 | 1) break ;;
  esac
  protected="${protected}${parent} "
  ancestor=$parent
  hops=$((hops + 1))
done

# ONE snapshot, reused for the seed pass and every expansion round. Re-running
# `ps` per round would bill the job for each; it would also let the table shift
# underneath the walk, so a single snapshot is the cheaper AND the more
# consistent choice.
snapshot=$(ps -A -w -w -o pid=,ppid=,command= 2>/dev/null)
if [ -z "$snapshot" ]; then
  log "process table unavailable — nothing reaped"
  exit 0
fi

# Seed: command lines resolving inside THIS runner's work tree. The pattern is
# quoted inside the `case`, so a metacharacter in a runner path is matched
# literally rather than globbed.
doomed=""
while read -r pid ppid command; do
  [ -n "$pid" ] || continue
  case "$protected" in
    *" ${pid} "*) continue ;;
  esac
  case "$command" in
    *Runner.Worker* | *Runner.Listener*) continue ;;
  esac
  case "$command" in
    *"${RUNNER_WORK}/"*) doomed="${doomed}${pid} " ;;
  esac
done <<SNAPSHOT
$snapshot
SNAPSHOT

# Expand to descendants, transitively. Each round adds the children of pids
# already condemned; the loop stops as soon as a round adds nothing, and is
# bounded at 32 rounds (a deeper live tree than any job produces) so a
# malformed table cannot loop forever.
rounds=0
while [ "$rounds" -lt 32 ]; do
  added=0
  while read -r pid ppid command; do
    [ -n "$pid" ] || continue
    case "$protected" in
      *" ${pid} "*) continue ;;
    esac
    case " ${doomed}" in
      *" ${pid} "*) continue ;;
    esac
    case "$command" in
      *Runner.Worker* | *Runner.Listener*) continue ;;
    esac
    case " ${doomed}" in
      *" ${ppid} "*)
        doomed="${doomed}${pid} "
        added=1
        ;;
    esac
  done <<SNAPSHOT
$snapshot
SNAPSHOT
  [ "$added" -eq 1 ] || break
  rounds=$((rounds + 1))
done

if [ -z "$doomed" ]; then
  log "no surviving processes under ${RUNNER_WORK} — nothing to reap"
  exit 0
fi

log "reaping processes that outlived this job under ${RUNNER_WORK}: ${doomed% }"
for pid in $doomed; do
  kill -TERM "$pid" 2>/dev/null
done

# Liveness is read from the process state, not from `kill -0`: a ZOMBIE still
# answers signal 0 but can never be signalled again — it disappears when its
# parent waits, or when init reaps it after the parent dies. Polling one out
# would spend the whole grace period, on the job's clock, waiting for
# something already dead. An empty state means the pid is gone.
polls=0
while :; do
  alive=""
  for pid in $doomed; do
    state=$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')
    case "$state" in
      "" | Z*) continue ;;
    esac
    alive="${alive}${pid} "
  done
  [ -n "$alive" ] || break
  [ "$polls" -lt "$GRACE_POLLS" ] || break
  sleep "$POLL_INTERVAL"
  polls=$((polls + 1))
done

if [ -n "$alive" ]; then
  log "grace expired — escalating to SIGKILL: ${alive% }"
  for pid in $alive; do
    kill -KILL "$pid" 2>/dev/null
  done
fi

exit 0
