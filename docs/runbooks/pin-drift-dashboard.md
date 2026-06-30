# Cross-Consumer Pin-Drift Dashboard

> Story #67 / MP-12. A standing check that surfaces the split-pin /
> release-lag state across mandrel-platform consumers automatically — across
> both the workflow `uses:` pins **and** the `mandrel-platform` npm dependency
> — so the drift that went undetected for several releases is caught the next
> time it happens.

## What it does

mandrel-platform ships on **two surfaces** that a consumer pins
independently:

- The reusable workflows and composite actions, pinned by full commit SHA —
  e.g.
  <!-- staleness-ignore: quality-yml-ref -->
  `uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<sha>`.
- The **npm config package** (`mandrel-platform` in `package.json`), which
  supplies `tsconfig.base.json`, `biome.base.json`, and the Renovate preset.

Because the two surfaces are pinned separately, several failure modes
accumulate silently:

1. **Split pin** — a single consumer pins **more than one** platform SHA
   across its workflow chains (e.g. two different release SHAs on the
   <!-- staleness-ignore: quality-yml-ref -->
   `pr-quality.yml` and `deploy-cloudflare.yml` chains).
2. **Release lag** — a consumer's single `uses:` pin is **behind** the latest
   mandrel-platform release.
3. **npm lag** — a consumer's `mandrel-platform` npm dependency is **behind**
   the latest release version (so its config bases are stale even when the
   workflows are current).
4. **Surface skew** — the npm pin and the workflow `uses:` pins disagree about
   being current (one is on the latest release, the other lags). This is the
   class the original `uses:`-only check missed: swarm-os ran npm `0.11.3`
   while its workflows tracked `v0.11.6` while the latest was `v0.11.7`.
5. **Stale pin literal** (Story #110) — a platform-ref SHA/tag echoed in a
   **comment** or a **`run:`/echo step string** drifts away from the consumer's
   canonical `uses:` pin. The `uses:`-only scan never saw these, so a
   hand-maintained `deploy-cloudflare.yml@<sha>` echoed in a deploy-summary
   string could lag the real pin indefinitely. The checker now also extracts
   every loose platform-ref literal and flags any whose ref no longer matches
   the canonical `uses:` pin (`stale`) — or that has no canonical pin to track
   at all (`orphan`).

The dashboard reads each consumer's `.github/workflows/` **and** its
`package.json` over the GitHub API, extracts every platform `uses:` ref across
all chains plus the `mandrel-platform` npm version, and reports a per-consumer
verdict: `✅ current`, `⚠️ lagging`, `❌ split pin`, `❌ npm/uses skew`,
`❌ stale pin literal`, `⏳ holding` (see below), or `❔ unknown` (floating
tags / unresolved SHA). A consumer that adopts the workflows but not the npm
config package reports its npm column as `absent` — informational, not drift.

A **stale pin literal** is never suppressed by the `minimumReleaseAge` hold
(below) — it lags the consumer's *own* `uses:` pin, not the platform release,
so the hold window is irrelevant. The fix is to **adopt the resolved-ref step
summary** `deploy-cloudflare.yml` now emits: its final `deploy-summary` job
echoes the runtime-resolved `github.job_workflow_sha` (and
`github.workflow_ref`) into `GITHUB_STEP_SUMMARY` as the single source of
truth, so a consumer reads the resolved pin off the job summary instead of
hand-maintaining a `deploy-cloudflare.yml@<sha>` literal that then drifts.

## The `minimumReleaseAge` coupling — why a fresh release does not page

> **Invariant (Story #107):** a consumer's pinned reusable-workflow tag and its
> `mandrel-platform` npm devDependency minor must not drift apart **undetected**
> — but the **transient skew during a Renovate `minimumReleaseAge` hold is not
> drift**.

The shared Renovate preset ([`default.json`](../../default.json)) gates every
bump behind a **3-day `minimumReleaseAge`** supply-chain hold. For the first
~3 days after a platform release, **every** consumer legitimately lags the new
tag — Renovate has not raised the grouped *"mandrel-platform workflows"* /
npm-bump PR yet. If the dashboard scored that window as drift it would fire a
false positive on **every** release, training operators to ignore it.

So the checker reads the latest release's `published_at`, compares it against
the `minimumReleaseAge` window (configurable via the top-level
`minimumReleaseAge` key in
[`pin-drift-consumers.json`](../../scripts/pin-drift-consumers.json), default
`3 days` to mirror the preset), and **suppresses lag/skew that is fully
explained by the hold**:

- A consumer whose **only** deviation is "not yet on a release younger than the
  hold window" is reported as **`⏳ holding`** — informational, listed under a
  separate **Holding** section, and **does not** count toward `--strict` drift.
- Lag against a release **older** than the window is real **drift** again
  (`⚠️ lagging` / `❌ npm/uses skew`), because the hold has expired and Renovate
  *should* have bumped the consumer by now.
- A **`❌ split pin`** is a real configuration error and is **never** suppressed
  by the hold — a consumer pinning two platform SHAs at once is wrong
  regardless of release age.

This is the permanent close of the swarm-os three-way split (npm `0.11.3` /
workflows `@v0.11.6` / latest `v0.11.7`): before the coupling existed, a genuine
two-surface divergence was indistinguishable from a fresh-release hold, so the
class could not be enforced without false positives. Keep the
`minimumReleaseAge` in `pin-drift-consumers.json` in lockstep with the value in
`default.json`.

## Components

| Component | Path | Role |
| --------- | ---- | ---- |
| Consumer registry | [`scripts/pin-drift-consumers.json`](../../scripts/pin-drift-consumers.json) | Data-driven list of consumers + the `minimumReleaseAge` hold window. **Adding a consumer is one object here.** |
| Checker | [`scripts/check-pin-drift.mjs`](../../scripts/check-pin-drift.mjs) | Resolves the latest release, fetches each consumer's workflows **and `package.json`**, classifies `uses:` + npm drift, renders the report. |
| Tests | [`scripts/check-pin-drift.test.mjs`](../../scripts/check-pin-drift.test.mjs) | `node:test` suite exercising the pure classifiers and the full pipeline with an injected `gh` runner (offline). Wired into `npm test`. |
| Scheduled workflow | [`.github/workflows/pin-drift.yml`](../../.github/workflows/pin-drift.yml) | Runs the checker weekly (Mondays 07:00 UTC) and on demand; renders the report to the job summary. |
| Repair loop | [`scripts/platform-repair.mjs`](../../scripts/platform-repair.mjs) | Reads the detector's verdict and, per consumer with **repairable** drift, clones it, runs `platform-sync`, and opens/updates an idempotent repair PR. |
| Repair tests | [`scripts/platform-repair.test.mjs`](../../scripts/platform-repair.test.mjs) | `node:test` suite exercising repairability classification, PR-body rendering, idempotency, and the full pipeline with injected `git`/`gh`/`sync` seams (offline). Wired into `npm test`. |
| Repair workflow | [`.github/workflows/platform-sync-repair.yml`](../../.github/workflows/platform-sync-repair.yml) | Runs the repair loop weekly (Mondays 08:00 UTC, one hour after detection) and on demand. |

## The repair loop — detect → repair (Story #113)

The dashboard *detects* drift; on its own it never *fixes* anything. The
**repair loop** closes that gap. It reuses the checker as its single source of
truth for drift classification, then for every consumer carrying **repairable**
drift it clones the consumer, runs
[`platform-sync`](../../scripts/platform-sync.mjs), and opens (or updates) one
**repair PR** against that consumer.

**Why repair PRs, not a hard gate (settled decision):** escalating pin-drift to
a hard gate would red-line a consumer's `main` for drift caused by a *fresh
platform release* — the consumer's Renovate hold simply hasn't fired yet, which
is not the consumer's fault. A repair PR is self-healing and keeps the signal
advisory. `pin-drift.yml` is therefore **unchanged and stays advisory** — the
repair loop is an additive, separate workflow.

**What is repairable vs. deferred:**

- **Repairable** → `❌ split pin`, `⚠️ lagging` (`uses:` or npm), `❌ npm/uses
  skew`. `platform-sync --ref <latest>` deterministically rewrites every
  first-party `uses:` pin to the single latest release SHA and reconciles the
  `extends` / runbook surfaces.
- **Deferred / skipped** → `⏳ holding` (inside the `minimumReleaseAge` window —
  repairing now races Renovate and would be reverted), `⚠️ error` (the detector
  could not read the repo), `✅ current` (nothing to do), and a floating-tag-only
  `❔ unknown` pin (no deterministic SHA target — flagged for manual handling,
  never auto-PR'd).

**Idempotency:** one repair PR per consumer, keyed off the stable head branch
`mandrel-platform/pin-repair`. A re-run finds the existing open repair PR by
head branch and **updates** its branch + body instead of opening a duplicate;
when the repaired tree matches the existing repair branch, nothing is pushed.

**PR body:** every repair PR explains exactly what drifted (split pin / release
lag / npm lag / surface skew) and links the pin-drift dashboard run that
detected it, so the consumer reviewer has the full provenance inline.

**Not auto-merged.** The repair loop *opens* the PR; it does not merge it. Each
repair PR still flows through the consumer's own `ci-required` checks and is
merged by the consumer's normal process.

### Running the repair loop locally

```bash
# Plan only — classify drift, render the repair report, mutate nothing:
node scripts/platform-repair.mjs --dry-run

# Live (requires PIN_REPAIR_TOKEN in the environment for the consumer writes):
PIN_REPAIR_TOKEN=<fine-grained-pat> node scripts/platform-repair.mjs

# Machine-readable envelope:
node scripts/platform-repair.mjs --json
```

Without `PIN_REPAIR_TOKEN` the loop runs **read-only**: it reports the repairs
it *would* open and exits 0. It never gates and never fails on a missing token.

## Adding a consumer

Append one object to the `consumers` array in
`scripts/pin-drift-consumers.json`:

```json
{ "name": "new-consumer", "repo": "owner/new-consumer" }
```

`branch` is optional (defaults to the repo's default branch). No code change is
required — the checker enumerates the new repo on the next run.

### pnpm-native supply-chain rollout tracking (Story #133)

The three fleet consumers (`domio`, `athportal`, `swarm-os` — same registry as
above) are the rollout targets for the canonical pnpm supply-chain block
(`config/pnpm-workspace.supply-chain.yaml` —
[README — pnpm supply-chain config](../../README.md#pnpm-supply-chain-config),
[reusable-workflows.md reconciliation](../reusable-workflows.md#pnpm-supply-chain-config-vs-renovate-minimumreleaseage)).
Story #133 ships and documents the canonical block on the platform side only;
per-consumer adoption (merging the fragment into each repo's
`pnpm-workspace.yaml`) is tracked per-consumer, not by this dashboard's
pin-drift check (the block has no `uses:`/npm-version pin shape this checker
understands). Each consumer's own repo-ops tracking doc
(`mandrel-platform-consumers.md`, where present) should gain a row noting
adoption status once that consumer's `pnpm-workspace.yaml` carries the block —
this repo has no equivalent file today since pin-drift tracking lives in
`scripts/pin-drift-consumers.json` above instead.

## Running it locally

```bash
# Human-readable dashboard (always exits 0 unless --strict):
node scripts/check-pin-drift.mjs

# Machine-readable envelope:
node scripts/check-pin-drift.mjs --json

# Fail (exit 1) when any consumer is split-pinned or lagging
# (consumers within the minimumReleaseAge hold window are `holding`, not drift):
node scripts/check-pin-drift.mjs --strict
```

The checker uses the `gh` CLI, so it inherits your local `gh auth` (or a
`GH_TOKEN`/`GITHUB_TOKEN` in the environment).

## Token provisioning (cross-repo auth)

Two cross-repo tokens are in play. Both are **least-privilege, consumer-scoped**
fine-grained PATs (or GitHub App installation tokens) — neither grants anything
on `dsj1984/mandrel-platform` itself, and the dashboard/repair workflows use
this repo's built-in `GITHUB_TOKEN` only for reading their own checkout.

### `PIN_DRIFT_TOKEN` — read (detection)

The scheduled dashboard's built-in `GITHUB_TOKEN` only grants read access to
**this** repo. Reading private consumer repos requires a fine-grained PAT stored
as the **`PIN_DRIFT_TOKEN`** repository secret, with **Contents: read** and
**Metadata: read** on each consumer repo. The same **Contents: read** scope
covers the `package.json` read added for the npm dimension — no new permission
is required. When the secret is absent the run still completes — consumers it
cannot read are reported as `⚠️ error` rows rather than failing the job. The
dashboard is **informational by default**: the scheduled run does not gate
`main`. Use the `workflow_dispatch` `strict` input to fail the run on drift for a
one-off enforcement check.

The repair loop reuses `PIN_DRIFT_TOKEN` (as `GH_TOKEN`) for its own
detection-phase reads — it does not need a second read token.

### `PIN_REPAIR_TOKEN` — write (repair PRs)

Opening a repair PR on a consumer requires **write** access to that consumer,
which neither this repo's `GITHUB_TOKEN` nor the read-only `PIN_DRIFT_TOKEN`
grants. The repair loop
([`platform-sync-repair.yml`](../../.github/workflows/platform-sync-repair.yml))
injects a separate fine-grained PAT / GitHub App installation token stored as
the **`PIN_REPAIR_TOKEN`** repository secret.

**Least-privilege scope** — grant on the consumer repos
(`dsj1984/domio`, `dsj1984/athportal`, `Beestera/swarm-os`) **only**, nothing on
`mandrel-platform`:

| Permission | Level | Why |
| ---------- | ----- | --- |
| Contents | **write** | Push the `mandrel-platform/pin-repair` branch with the synced pins. |
| Pull requests | **write** | Open / update the repair PR. |
| Metadata | read | Implicitly required by GitHub for any fine-grained PAT. |

Deliberately **not** granted: `Administration`, `Workflows`, `Actions`,
`Secrets`, or write on any other resource. The token cannot merge the PR
(consumer branch protection + `ci-required` own that), cannot touch
`mandrel-platform`, and cannot modify consumer CI. A GitHub App installation
token scoped to the same two permissions on the consumer installations is the
preferred production posture (auto-expiring, attributable to the app).

When `PIN_REPAIR_TOKEN` is **absent** the repair loop runs **read-only**: it
classifies drift and reports the repairs it *would* open, then exits 0. It never
fails the job and never gates `main` — consistent with the advisory posture of
the whole pin-drift surface.
