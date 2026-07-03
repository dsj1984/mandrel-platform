# Runner Fleet Health Monitor

> **Self-contained runbook** (not a thin stub). Unlike most templates in this
> directory, there is no canonical `docs/runbooks/` counterpart to link — this
> file IS the process, mirroring `runner-provisioning.md`. It documents the
> scheduled `.github/workflows/runner-fleet-health.yml` monitor (Story #258):
> what it checks, the token scope it needs, the alert semantics, and the
> operator response when it fires.

---

## Why this exists

All self-hosted runners across the fleet (`domio`, `athportal`, `swarm-os`)
are **co-resident on one operator Mac**. If that host sleeps, reboots for an
OS update, fills its disk, or a launchd runner service dies, **every
consumer's CI and deploy-trigger jobs silently queue** ("waiting for a
runner") with no alert. Nothing else watches this:

- The Better Stack uptime unit (`uptime-apply.yml`) monitors the **deployed
  apps**, not the runners.
- Deploy pipelines are `workflow_run`-gated, so a wedged runner can silently
  stall staging indefinitely — no failed job, no notification, just a queue
  that never drains.

`runner-fleet-health.yml` is the standing check that catches this fast.

## What it checks

Runs on a schedule (~every 15 minutes) plus `workflow_dispatch`, on
`ubuntu-latest` (deliberately GitHub-hosted so it keeps running when the Mac
is down). For each repo in `scripts/runner-fleet-consumers.json` it calls
`GET /repos/{owner}/{repo}/actions/runners` and:

1. **Offline runners** — flags any runner whose `status != online`.
2. **Count shortfall** — flags fewer online runners matching the repo's
   expected `labels` set than its configured `expectedCount`.
3. **Stale queued runs** (optional signal) — a `queued`/`waiting` workflow run
   older than `staleQueuedMinutes` (default 20) with no online runner matching
   its labels. This catches the case where the runner *looks* present in the
   roster count but is actually wedged and not claiming jobs.

It renders a per-repo dashboard on `GITHUB_STEP_SUMMARY`.

## Config-driven roster

Adding, removing, or resizing a runner needs **only a config edit** —
`scripts/runner-fleet-consumers.json`:

```jsonc
{
  "defaultStaleQueuedMinutes": 20,
  "repos": [
    { "name": "domio", "repo": "dsj1984/domio", "expectedCount": 3, "labels": ["self-hosted", "macOS", "ARM64", "domio-runner"] },
    // ... one object per repo
  ],
}
```

## Token scope: `PIN_DRIFT_TOKEN`

The monitor reuses the same fine-grained PAT `pin-drift.yml` already
provisions (`secrets.PIN_DRIFT_TOKEN`), falling back to the built-in
`github.token` when the secret is absent (the built-in token only grants read
access to the workflow's own repo — cross-repo rows then surface as `⚠️
error` rather than hard-failing this repo's own row).

For the runner reads, `PIN_DRIFT_TOKEN` must carry, on all three consumer
repos:

- **Administration: read** — required by `GET .../actions/runners` (the
  self-hosted runner list is an admin-surface endpoint; `actions:read` is
  NOT sufficient for it).
- **Actions: read** — required by `GET .../actions/runs` (the stale-queue
  check).

Resource-owner caveat: a fine-grained PAT is bound to a **single** resource
owner, so one fine-grained PAT cannot cover both `dsj1984/*` and
`Beestera/swarm-os`. To cover the whole roster with the one secret the
workflow reads, use a classic PAT with `repo` scope from an account with
admin access to all three repos.

When the token lacks visibility, GitHub returns **404** (not 403) and the
script treats the empty runner list as a real shortfall — the repo's row
reads `❌ degraded` with `0/N` online even when the runners are healthy. A
fleet-wide `0/N` across every repo is the token-misconfiguration signature;
check the secret before touching the runner host.

## Alert semantics

Alert-only by design (no host-side remediation) — the monitor never touches
the runner host itself. One channel fires on an unhealthy repo, deliberately
without adding a new external dependency:

- **Native GitHub failed-workflow notification.** The job script exits
  non-zero when any repo is unhealthy, so GitHub's own email/notification
  settings fire the standard "workflow run failed" alert to whoever
  watches this repo. No tracking issues are filed — the dashboard detail
  lives on the failed run's job summary.

A future Slack/PagerDuty push could layer on top of this later — deliberately
deferred (see the Story's Out of Scope) to avoid a new external dependency for
the initial alert-only default.

## Operator response

When the scheduled workflow run fails:

1. **Read the dashboard** on the workflow run's job summary — it names which
   signal fired (offline runner, count shortfall, or stale queued run) and
   for which repo.
2. **Wake or reboot the Mac** if it's asleep, powered off, or unresponsive
   over SSH.
3. **Check disk space** (`df -h`) — a full disk is a common launchd-runner
   death cause; free space and restart the affected runner service(s).
4. **Restart the launchd runner service(s)** for the affected repo:
   ```bash
   cd <RUNNER_DIR>          # see templates/runbooks/runner-provisioning.md
   ./svc.sh stop && ./svc.sh start
   ./svc.sh status          # expect: Started · running
   ```
5. **Re-run the monitor** (`workflow_dispatch` from the Actions tab, or wait
   for the next 15-minute tick) to confirm recovery — a green run means the
   fleet reports healthy again.

## Out of scope (Story #258)

- Host-side remediation / auto-recovery (waking the Mac, restarting services)
  — this monitor is alert-only; the operator performs the response above by
  hand.
- Host disk-usage monitoring — not exposable via the runners API anyway, and
  tracked separately.
- External paging integrations beyond the native failed-workflow
  notification.
- Cross-repo runner isolation / ephemeral-runner questions — explicitly
  deferred.

## Project-Specific Notes

<!-- Record host quirks, roster changes, or false-positive tuning
     (staleQueuedMinutes overrides) specific to this fleet. -->
