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
   while its workflows tracked `v0.11.6`.

The dashboard reads each consumer's `.github/workflows/` **and** its
`package.json` over the GitHub API, extracts every platform `uses:` ref across
all chains plus the `mandrel-platform` npm version, and reports a per-consumer
verdict: `✅ current`, `⚠️ lagging`, `❌ split pin`, `❌ npm/uses skew`, or
`❔ unknown` (floating tags / unresolved SHA). A consumer that adopts the
workflows but not the npm config package reports its npm column as `absent` —
informational, not drift.

## Components

| Component | Path | Role |
| --------- | ---- | ---- |
| Consumer registry | [`scripts/pin-drift-consumers.json`](../../scripts/pin-drift-consumers.json) | Data-driven list of consumers. **Adding a consumer is one object here.** |
| Checker | [`scripts/check-pin-drift.mjs`](../../scripts/check-pin-drift.mjs) | Resolves the latest release, fetches each consumer's workflows **and `package.json`**, classifies `uses:` + npm drift, renders the report. |
| Tests | [`scripts/check-pin-drift.test.mjs`](../../scripts/check-pin-drift.test.mjs) | `node:test` suite exercising the pure classifiers and the full pipeline with an injected `gh` runner (offline). Wired into `npm test`. |
| Scheduled workflow | [`.github/workflows/pin-drift.yml`](../../.github/workflows/pin-drift.yml) | Runs the checker weekly (Mondays 07:00 UTC) and on demand; renders the report to the job summary. |

## Adding a consumer

Append one object to the `consumers` array in
`scripts/pin-drift-consumers.json`:

```json
{ "name": "new-consumer", "repo": "owner/new-consumer" }
```

`branch` is optional (defaults to the repo's default branch). No code change is
required — the checker enumerates the new repo on the next run.

## Running it locally

```bash
# Human-readable dashboard (always exits 0 unless --strict):
node scripts/check-pin-drift.mjs

# Machine-readable envelope:
node scripts/check-pin-drift.mjs --json

# Fail (exit 1) when any consumer is split-pinned or lagging:
node scripts/check-pin-drift.mjs --strict
```

The checker uses the `gh` CLI, so it inherits your local `gh auth` (or a
`GH_TOKEN`/`GITHUB_TOKEN` in the environment).

## Token provisioning (cross-repo reads)

The scheduled workflow's built-in `GITHUB_TOKEN` only grants read access to
**this** repo. Reading private consumer repos requires a fine-grained PAT
stored as the **`PIN_DRIFT_TOKEN`** repository secret, with **Contents: read**
and **Metadata: read** on each consumer repo. The same **Contents: read** scope
covers the `package.json` read added for the npm dimension — no new permission
is required. When the secret is absent the run
still completes — consumers it cannot read are reported as `⚠️ error` rows
rather than failing the job. The dashboard is **informational by default**: the
scheduled run does not gate `main`. Use the `workflow_dispatch` `strict` input
to fail the run on drift for a one-off enforcement check.
