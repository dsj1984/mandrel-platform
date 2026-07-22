# Self-Hosted Runner Provisioning — <PROJECT_NAME>

> **Self-contained runbook** (not a thin stub). Unlike the other templates in
> this directory, there is no canonical `docs/runbooks/` counterpart to link —
> this file IS the process. It provisions a **persistent** (non-ephemeral)
> GitHub Actions runner on a macOS host using the mandrel-platform runner kit
> (`templates/runner/`), which ships the job-start hygiene hook
> (`job-cleanup.sh`) and the per-runner `.env` (`.env.example`).
>
> Placeholder convention: `<UPPER_SNAKE>` between angle brackets — search for
> `<` after copying to find everything that still needs a value.

---

## ⚠️ Read first: the shared-`$HOME` concurrency hazard

Every runner on a host typically runs as the **same OS user**, so anything
resolved against `$HOME` is **shared across all co-resident runners** — it is
*not* scoped to "this runner", no matter what a comment claims. The two
hazards this kit exists to close:

1. **`~/setup-pnpm` is shared.** `pnpm/action-setup`'s `dest` input defaults
   to `~/setup-pnpm`. With N runners on one host, N concurrent jobs race on
   one pnpm shim install. Worse, a cleanup hook that `pkill`s processes
   matching `~/setup-pnpm` or `rm -rf`s it at job start will **destroy a pnpm
   install a concurrent runner is mid-flight on**. The fix is ordering:
   **first** make the pnpm shim location per-runner (workflow-side, see
   [pnpm scoping](#3-pnpm-scoping-workflow-side-prerequisite) below), and only
   **then** is a reap/delete hook safe — and even then it must target only the
   runner-scoped path. The kit's `job-cleanup.sh` never touches
   `~/setup-pnpm`.
2. **The default tool cache is shared.** Without a runner-scoped
   `RUNNER_TOOL_CACHE`, toolchain actions extract into a host-shared cache
   and co-resident runners race on it. The kit's `.env` scopes it to the
   runner's own `_work/_tool`.

Do not roll the hook out to a host until every workflow that job's runner
serves installs pnpm to a runner-scoped `dest`. Rolling out the hook without
the pnpm-scoping prerequisite reintroduces the exact corruption it guards
against.

## Host Values

| Value | Setting |
|-------|---------|
| Runner host | `<RUNNER_HOST>` |
| Runner OS user | `<RUNNER_USER>` |
| Runner root dir | `<RUNNER_DIR>` (e.g. `~/Development/github-runners/<REPO>`) |
| Repository | `<OWNER>/<REPO>` |
| Runner name | `<REPO>-runner` (or `<REPO>-runner-<N>` for a pool) |
| Labels | `self-hosted, macOS, ARM64, <REPO>-runner` |
| Runner version | `<RUNNER_VERSION>` (latest from [actions/runner releases](https://github.com/actions/runner/releases)) |

## 1. Download and unpack the runner

One directory per runner — never share a runner root between registrations.

```bash
mkdir -p <RUNNER_DIR> && cd <RUNNER_DIR>
curl -o actions-runner-osx-arm64-<RUNNER_VERSION>.tar.gz -L \
  https://github.com/actions/runner/releases/download/v<RUNNER_VERSION>/actions-runner-osx-arm64-<RUNNER_VERSION>.tar.gz
# Verify the SHA-256 against the checksum published on the release page
# before unpacking — same download-and-verify posture as the platform's
# pinned gitleaks/actionlint installs.
shasum -a 256 actions-runner-osx-arm64-<RUNNER_VERSION>.tar.gz
tar xzf actions-runner-osx-arm64-<RUNNER_VERSION>.tar.gz
```

## ⚠️ Read second: keep the health-monitor roster in lockstep

Any change to a fleet's size — **adding or removing a runner** — **MUST** be
accompanied by an update to that repo's `expectedCount` in
[`scripts/runner-fleet-consumers.json`](../../scripts/runner-fleet-consumers.json).
That file is the roster the scheduled `runner-fleet-health.yml` monitor
(`scripts/check-runner-health.mjs`) compares the live fleet against.

- **Scale up (add a runner):** bump `expectedCount` so the shortfall floor
  keeps pace. Over-provisioning does not trip the alarm on its own (the
  monitor is **warn-below**: `shortfall = max(0, expectedCount - matchingOnline)`),
  but leaving the count stale hides a later drop back down to the old value.
- **Scale down (remove a runner):** lower `expectedCount` in the same change,
  otherwise the monitor will correctly flag the now-missing runner(s) as a
  shortfall and page the operator for a deliberate downsizing.

If the roster and the live fleet drift apart, the monitor either false-alarms
(count too high) or goes silent on real outages above the stale threshold
(count too low) — the exact mis-calibration this contract exists to prevent.
See also [`runner-fleet-health.md`](runner-fleet-health.md) for the operator
response when the monitor does fire.

## 2. Register with `config.sh` (repo-level)

Registration is **repo-level** (the fleet's standing model), not org-level.
Mint a short-lived registration token via the repo UI
(*Settings → Actions → Runners → New self-hosted runner*) or:

```bash
gh api -X POST repos/<OWNER>/<REPO>/actions/runners/registration-token --jq .token
```

Then configure:

```bash
cd <RUNNER_DIR>
./config.sh \
  --url https://github.com/<OWNER>/<REPO> \
  --token <REGISTRATION_TOKEN> \
  --name <REPO>-runner \
  --labels self-hosted,macOS,ARM64,<REPO>-runner \
  --work _work \
  --unattended
```

- `--labels` — the four-label contract the fleet's workflows target
  (`self-hosted, macOS, ARM64, <REPO>-runner`). The `<REPO>-runner` label is
  the routing key; keep it unique per repo.
- `--work _work` — keeps the work tree inside `<RUNNER_DIR>`, which is what
  makes every path in the hygiene kit runner-scoped.
- Registration tokens expire after ~1 hour; mint a fresh one per runner.

## 3. pnpm scoping (workflow-side prerequisite)

Before installing the hook, confirm every workflow this runner serves
installs the pnpm shim to a **runner-scoped** destination:

- Workflows using the platform's `setup-toolchain` composite action (all
  `pr-quality.yml` tiers) are already safe: it defaults `pnpm/action-setup`'s
  `dest` to `${{ runner.temp }}/pnpm`, i.e. `<RUNNER_DIR>/_work/_temp/pnpm`,
  unique per runner. `pr-quality.yml` also exposes a `pnpm-dest` input for
  explicit overrides.
- Workflows calling `pnpm/action-setup` directly MUST pass
  `dest: ${{ runner.temp }}/pnpm`. The action's default (`~/setup-pnpm`) is
  host-shared and unsafe under runner concurrency (see the hazard header).

There is **no runner-side override** for the pnpm `dest` — it is a workflow
input — which is why this step is a rollout gate, not an `.env` line.

## 4. Install the hygiene kit (hook + `.env`)

Copy the kit from the platform payload into the runner root:

```bash
cp node_modules/mandrel-platform/templates/runner/job-cleanup.sh <RUNNER_DIR>/job-cleanup.sh
chmod +x <RUNNER_DIR>/job-cleanup.sh
cp node_modules/mandrel-platform/templates/runner/.env.example <RUNNER_DIR>/.env
```

Then edit `<RUNNER_DIR>/.env` and replace every `<RUNNER_DIR>` placeholder
with the runner root's absolute path. The resulting file wires:

- `ACTIONS_RUNNER_HOOK_JOB_STARTED=<RUNNER_DIR>/job-cleanup.sh` — the
  job-start hook. It reaps orphaned pnpm/node processes parented to **this**
  runner's work tree, clears stale runner-scoped pnpm installs, and
  age-gate-sweeps shared-`$TMPDIR` gitleaks leftovers. It never fails a job
  (always exits 0) and never touches another runner's state.
- `RUNNER_TOOL_CACHE=<RUNNER_DIR>/_work/_tool` and
  `AGENT_TOOLSDIRECTORY=<RUNNER_DIR>/_work/_tool` — runner-scoped tool cache
  (two env names, one dir; some actions read the legacy name).
- `LANG=en_US.UTF-8`.

The hook needs no per-runner editing: it derives `RUNNER_DIR` from its own
location, so the same file works verbatim on every runner.

## 5. Install as a launchd service (`svc.sh`)

```bash
cd <RUNNER_DIR>
./svc.sh install   # generates the launchd plist for the current user
./svc.sh start
./svc.sh status    # expect: Started · running
```

Verify end-to-end: push a trivial workflow run targeting
`runs-on: [self-hosted, macOS, ARM64, <REPO>-runner]` and confirm (a) the job
is picked up and (b) the job log shows the `Set up runner` hook phase running
`job-cleanup.sh` before the first step.

The runner loads `.env` at service start — after any `.env` change, restart:

```bash
./svc.sh stop && ./svc.sh start
```

## 6. Update / rotation guidance

- **Runner version updates.** Persistent runners self-update by default when
  GitHub releases a new runner version; no action needed. If a runner is
  pinned or the self-update wedges, stop the service, download/unpack the new
  tarball over `<RUNNER_DIR>` (config and `.env` survive), and restart via
  `svc.sh`.
- **Kit updates.** The hook and `.env.example` are versioned in
  mandrel-platform. On a platform release that touches `templates/runner/`,
  re-copy `job-cleanup.sh` (verbatim — it is parameterized) and diff
  `.env.example` against the live `.env`, then `./svc.sh stop && ./svc.sh
  start`. There is no `mandrel sync` equivalent for a runner host's
  filesystem — this is an operator-applied step.
- **Token/registration rotation.** Registration tokens are one-shot at
  config time; nothing persists to rotate. To move a runner between repos or
  rename it: `./svc.sh stop && ./svc.sh uninstall && ./config.sh remove
  --token <REMOVAL_TOKEN>`, then re-register (§2) and reinstall the service
  (§5). Mint the removal token via
  `gh api -X POST repos/<OWNER>/<REPO>/actions/runners/remove-token --jq .token`.
- **Decommission.** Same removal sequence, then delete `<RUNNER_DIR>`.
  Confirm the runner disappeared from *Settings → Actions → Runners*, **and**
  lower the repo's `expectedCount` in `scripts/runner-fleet-consumers.json`
  (see the roster-lockstep callout above) so the health monitor does not flag
  the intentional removal as a shortfall.

## Project-Specific Notes

<!-- Record host quirks: co-resident runner inventory for this host, Xcode /
     toolchain versions the workloads assume, monitoring hooks, etc. -->
