# Reusable Workflows — Input & Secret Contract

This is the public reference for the **`workflow_call` contract** of the
shared reusable workflows mandrel-platform exposes. Consumer repos configure
their callers from this page rather than reading the workflow YAML.

Two workflows carry a stable public contract:

- [`pr-quality.yml`](#pr-qualityyml) — the tiered PR-quality CI pipeline.
- [`deploy-cloudflare.yml`](#deploy-cloudflareyml) — the defence-in-depth
  Cloudflare deploy.

Three more are consumable but have a much smaller surface, covered briefly at
the end:

- [`secret-scan-push.yml`](#secret-scan-pushyml) — full-history secret-scan
  signal on push to the default branch.
- [`codeql.yml`](#codeqlyml) — CodeQL SAST analysis.
- [`smoke-dispatch.yml`](#smoke-dispatchyml) — cross-repo smoke trigger
  (platform-internal).

Each input below is documented against the **current** workflow source. Types,
defaults, and "when to override" are authoritative; the workflow YAML is the
implementation of this contract, not a competing source of truth.

> **Scope of this page.** This documents the *contract* — the inputs and
> secrets that cross the `workflow_call` boundary — not the volatile install
> internals of any individual step (e.g. how the SAST step bootstraps
> Semgrep). Those internals can change between releases without changing the
> contract.

---

## `pr-quality.yml`

A tiered PR-quality pipeline, consumable as a `workflow_call` target by any
consumer repo. Tiers run in this order:

```text
lint + format-check → typecheck → unit → contract → e2e/smoke → security
```

Every tier is independently enable-toggled, so a repo can opt out of tiers it
has not built yet. A single aggregator job, [`ci-required`](#the-ci-required-aggregator),
is the only branch-protection context a consumer needs to register.

### Minimal caller

```yaml
jobs:
  pr-quality:
    uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<sha> # <tag>
    secrets: inherit
```

With no inputs, every tier runs on `ubuntu-latest` with a single shard.

### Inputs

| Input              | Type    | Default          | When to override                                                                                                                              |
| ------------------ | ------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner`           | string  | `'ubuntu-latest'`| Runs-on label for all jobs. Pass a JSON-encoded array string (e.g. `'["self-hosted","domio-runner"]'`) to target a self-hosted runner.        |
| `shards`           | number  | `1`              | Number of parallel shards for the test tiers (unit, contract, e2e). Raise for large suites; **must agree with `shard-matrix`**.               |
| `shard-matrix`     | string  | `'[1]'`          | JSON-encoded array of shard indices driving the test matrix. Must match `shards` (e.g. `shards: 3` → `shard-matrix: '[1,2,3]'`).               |
| `enable-lint`      | boolean | `true`           | Set `false` to skip the lint + format-check tier.                                                                                              |
| `enable-typecheck` | boolean | `true`           | Set `false` to skip the typecheck tier.                                                                                                        |
| `enable-unit`      | boolean | `true`           | Set `false` to skip the unit-test tier.                                                                                                        |
| `enable-contract`  | boolean | `true`           | Set `false` to skip the contract-test tier.                                                                                                    |
| `enable-e2e`       | boolean | `true`           | Set `false` to skip the e2e / smoke (Playwright) tier.                                                                                          |
| `coverage-threshold` | number | `0`            | Minimum coverage percentage the **unit** job must meet. `0` (default) disables the gate — current behaviour for non-adopters. When `> 0`, the unit job **fails** if measured coverage is below the floor. See [Coverage threshold gate](#coverage-threshold-gate-coverage-threshold). |
| `coverage-metric`  | string  | `'lines'`        | Which coverage metric the floor asserts: `lines`, `statements`, `functions`, or `branches` (read from `total.<metric>.pct`). Ignored when `coverage-threshold` is `0`. |
| `enable-security`  | boolean | `true`           | Set `false` to skip the whole security tier (secret scan + SAST). See [Security tier](#security-tier-enable-security--enable-sast).             |
| `enable-sast`      | boolean | `true`           | Set `false` to keep the PR-diff secret scan but skip the Semgrep SAST sub-step — use when SAST runs via a dedicated CodeQL/GHAS workflow.       |
| `semgrep-config`   | string  | `'p/default'`    | Semgrep ruleset for the SAST sub-step. Override with another registry ref (e.g. `'p/security-audit'`) or a path. **`'auto'` is unsupported.**   |
| `sast-exclude`     | string  | `''`             | Extra Semgrep `--exclude` globs, space- or comma-separated (e.g. `'dist coverage tests/fixtures'`), **appended** to the built-in `.agents` exclude. Set to drop generated code / fixtures from the SAST target set. |
| `gitleaks-version` | string  | `'8.30.1'`       | Pinned gitleaks release version (no leading `v`) for the secret scan. Bump deliberately; the per-platform asset checksum is pinned to match.    |
| `toolchain-cache`  | string  | `'true'`         | Passed through to `setup-toolchain`'s `cache` input. Set `'false'` on self-hosted runners with a warm pnpm store.                              |
| `pnpm-dest`        | string  | `''`             | Passed through to `setup-toolchain`'s `pnpm-dest`. Self-hosted callers should set this (e.g. the `runner.temp/pnpm` path) to avoid `$HOME` races. |

> **Sharding contract.** `shards` and `shard-matrix` must agree. `shards` sets
> the denominator passed to the test runner (`--shard=<n>/<shards>`);
> `shard-matrix` is the JSON array of indices the job matrix iterates. A
> mismatch silently under- or over-runs the suite. For `shards: 3`, pass
> `shard-matrix: '[1,2,3]'`.

> **`runner` array syntax.** Single labels are plain strings
> (`'ubuntu-latest'`). Multi-label / self-hosted targets must be a
> **JSON-encoded string** (`'["self-hosted","domio-runner"]'`), not a YAML
> sequence.

### Security tier (`enable-security` / `enable-sast`)

The security tier is **private-repo-capable**. Both sub-steps run a pinned
binary directly and **block the job on a finding via a non-zero exit code** —
no SARIF / Code Scanning upload is required, so the gate is load-bearing on a
**private repo with no GitHub Advanced Security (GHAS)**.

- **Secret scan** — a pinned `gitleaks` binary over the PR diff (blocking). On
  `pull_request` events the scan is scoped to the commits the PR introduces
  (merge-base..head); on push / other events it falls back to a full-tree
  scan. The binary asset is selected per platform (darwin/linux × amd64/arm64)
  and verified against a pinned SHA-256 before execution.
- **SAST** — pinned Semgrep. On `pull_request` events it is scoped to the PR
  diff via a baseline commit, so only findings **introduced** by the PR block;
  on push / schedule it scans the full tree.

Toggle matrix:

| Goal                                                    | `enable-security` | `enable-sast` |
| ------------------------------------------------------- | ----------------- | ------------- |
| Full security tier (default)                            | `true`            | `true`        |
| Secret scan only — SAST runs elsewhere (CodeQL / GHAS)  | `true`            | `false`       |
| No security tier at all                                 | `false`           | (ignored)     |

> **`semgrep-config` constraints.** The default `'p/default'` is a broad OSS
> ruleset that needs no Semgrep AppSec Platform login. You may override with
> another concrete registry ref or a path. Do **not** pass `'auto'`: it
> requires Semgrep metrics to be on (it contacts `semgrep.dev` to tailor the
> ruleset), which is incompatible with the step's `--metrics=off` privacy
> posture.

> **GHAS alternative.** Repos that *do* have GitHub Advanced Security can run
> CodeQL (see [`codeql.yml`](#codeqlyml)) for blocking Code Scanning instead of
> the Semgrep sub-step — set `enable-sast: false` here and surface CodeQL as a
> required check. The Semgrep path is the no-GHAS-required default so every
> consumer inherits an effective gate regardless of plan.

> **Excluding paths from SAST (`sast-exclude`).** The SAST sub-step always
> excludes the vendored `.agents` framework tree (a consumer cannot edit it).
> Use `sast-exclude` to **append** further `--exclude` globs — space- or
> comma-separated — for generated code, build output, or test fixtures you
> don't want Semgrep to scan (e.g. `'dist coverage tests/fixtures'`). Empty
> (the default) leaves only the built-in `.agents` exclude in effect.

### Coverage threshold gate (`coverage-threshold`)

By default `pr-quality.yml` uploads `**/coverage/` as an artifact but asserts
**no floor** — a PR can drop coverage and `ci-required` stays green. The
`coverage-threshold` input is an **opt-in** floor at the workflow layer
(distinct from the `.agents/` harness's CRAP/MI/coverage ratchet, which is
unchanged).

- **Off by default.** `coverage-threshold: 0` (the default) is a no-op: the
  gate step is skipped entirely and behaviour is identical to today. Existing
  callers need no change.
- **Load-bearing when set.** With `coverage-threshold > 0`, the **unit** job
  runs a coverage check after the tests. If measured coverage is below the
  floor, the unit job **fails** — and the unit job is a `needs:` of
  [`ci-required`](#the-ci-required-aggregator), so the floor blocks the merge.
- **No new tooling.** The gate reads the **existing** `**/coverage/`
  output — specifically `coverage-summary.json` (the standard Istanbul / c8 /
  vitest `json-summary` reporter). Your test step must already emit that file
  (the same one uploaded as the unit artifact); no extra dependency or
  consumer-side script is required.
- **Fails closed on missing data.** If the floor is set but **no**
  `coverage-summary.json` is found under any `**/coverage/` directory, the gate
  **fails** rather than passing silently — a set floor must never be a no-op
  because coverage wasn't produced.
- **Metric selectable.** `coverage-metric` (default `lines`) picks which of
  `lines` / `statements` / `functions` / `branches` the floor asserts, read
  from `total.<metric>.pct`. The comparison is inclusive — a floor of `80`
  admits exactly `80%`.

> **Emitting the summary.** Ensure your unit test command writes
> `coverage/coverage-summary.json`. For vitest: enable
> `coverage.reporter: ['json-summary', ...]`. For nyc / c8: add
> `--reporter=json-summary`. The file is what both the artifact upload and this
> gate consume — no separate run.

#### Example — adopt an 80% lines floor

```yaml
jobs:
  pr-quality:
    uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<sha> # <tag>
    with:
      coverage-threshold: 80
      # coverage-metric: lines   # default; set to statements/functions/branches to assert another metric
    secrets: inherit
```

Leaving `coverage-threshold` unset (or `0`) keeps the current no-floor
behaviour:

```yaml
jobs:
  pr-quality:
    uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<sha> # <tag>
    secrets: inherit   # coverage gate is off — artifact still uploaded, no floor asserted
```

### Secrets

| Secret        | Required | Purpose                                              |
| ------------- | -------- | ---------------------------------------------------- |
| `TURBO_TOKEN` | No       | Turbo remote-cache read/write token.                 |
| `TURBO_TEAM`  | No       | Turbo team slug for remote-cache scoping.            |

Both are optional. The simplest caller passes `secrets: inherit`; the tiers
run without remote caching when the secrets are absent.

### The `ci-required` aggregator

`ci-required` is the **only** context a consumer should register in its
branch-protection ruleset. It passes when every **enabled** tier succeeds (a
tier disabled via its `enable-*` toggle counts as skipped, which the
aggregator treats as a pass). This eliminates required-check-name drift — the
required check's name is defined exactly once, here, regardless of which tiers
a given consumer enables or how many shards it runs.

```text
Branch protection → required status checks → add: ci-required
```

Do **not** register the individual tier jobs (`Lint & format`, `Typecheck`,
`Unit (1/3)`, …) as required — their names change with shard count and toggle
state, which is exactly the drift `ci-required` exists to absorb.

---

## `deploy-cloudflare.yml`

A reusable Cloudflare deploy with defence-in-depth, consumable as a
`workflow_call` target. The jobs run in this order:

```text
secret-isolation-audit → check-env → pre-migration-snapshot → migrate → deploy → boot-smoke
```

`pre-migration-snapshot` and `migrate` only run when `migrate: true`;
`boot-smoke` only runs when `smoke: true` (the default).

### Minimal caller

```yaml
jobs:
  deploy:
    uses: dsj1984/mandrel-platform/.github/workflows/deploy-cloudflare.yml@<sha> # <tag>
    with:
      environment: production
      workers: "api,worker-cron"
      migrate: true
    secrets: inherit
```

### Inputs

| Input                        | Type    | Default     | When to override                                                                                                                                          |
| ---------------------------- | ------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`                | string  | *(required)*| Target Cloudflare environment label (e.g. `staging`, `production`). Maps to `wrangler --env`.                                                              |
| `workers`                    | string  | *(required)*| Comma-separated Worker names to deploy (e.g. `"api,worker-cron"`). Each name must match a `wrangler.toml` `[env.<environment>]` section.                   |
| `gh-environment`             | string  | `''`        | GitHub **Deployment Environment** name attached to every secret-touching job, for secret scoping and protection rules. See [gh-environment model](#the-gh-environment-model). |
| `migrate`                    | boolean | `false`     | Run migrations. When `true`, a pre-migration snapshot runs first. Defaults to D1 tooling; override the command seams for non-D1.                           |
| `db-engine`                  | string  | `'d1'`      | Engine label for default migrate/snapshot tooling. Any non-`d1` value **requires** `migrate-command` **and** `snapshot-command` (no built-in non-D1 tooling). |
| `snapshot-command`           | string  | `''`        | Consumer pre-migration snapshot command. Replaces the built-in `wrangler d1 export` for non-D1 engines. `*.sql` it writes under `temp/` is uploaded as the snapshot artifact. |
| `migrate-command`            | string  | `''`        | Consumer migrate command. Replaces `wrangler d1 migrations apply` for non-D1 engines. Runs after the snapshot and after `pre-migrate-assert-command`.       |
| `pre-migrate-assert-command` | string  | `''`        | Optional host-guard hook run **before** migrate. A non-zero exit aborts the migrate job — use it to refuse migrating unless the resolved DB host matches an expected pattern. |
| `build-command`              | string  | `''`        | Optional build run in the deploy job **before** `wrangler deploy` (e.g. `"pnpm build"`). **Secretless** — only `build-env` plaintext + the frozen secret set are in scope. |
| `build-env`                  | string  | `''`        | Build-time env passthrough, one `KEY=VALUE` per line, exported before `build-command`. For plaintext build-time values only — **never** secrets.            |
| `build-artifact`             | string  | `''`        | Name of an artifact uploaded by the consumer's own build job earlier in the run. When set, it is downloaded into the deploy job and `build-command` is **skipped**. This is the consumer-side-build handoff. |
| `build-artifact-path`        | string  | `''`        | Extraction path for the downloaded `build-artifact`. Empty extracts into the checkout root. Only consulted when `build-artifact` is set.                     |
| `deploy-command`             | string  | `''`        | Replaces the built-in per-worker `wrangler deploy` loop. Use for pnpm-workspace monorepos with no root wrangler config (deploy each worker from its package dir). |
| `smoke`                      | boolean | `true`      | Run the built-in boot-smoke + auto-rollback job. Set `false` to run your own post-deploy verification (auto-rollback is also skipped).                       |
| `smoke-command`              | string  | `''`        | Replaces the built-in workers.dev probe (multi-route / custom-host consumers). A non-zero exit fails the run and triggers the same `wrangler rollback`.       |
| `smoke_base_url`             | string  | `''`        | Base URL for the built-in probe (e.g. `https://godomio.com`). Each smoke path is appended to this base instead of the derived workers.dev host. No trailing slash. |
| `smoke_paths`                | string  | `'/health'` | Comma-separated paths the built-in probe requests against each target (e.g. `"/,/portal,/api/health"`). Each must start with a leading slash.                |
| `workers_dev_subdomain`      | string  | `''`        | workers.dev account **subdomain slug** (e.g. `"dsj1984"`) used to build the probe URL. Empty derives it from `wrangler whoami`. **Never** pass the account ID. |

> **Command seams.** `snapshot-command`, `migrate-command`, `build-command`,
> `deploy-command`, and `smoke-command` are override seams: with **none** set,
> behaviour is identical to the legacy D1 path (export/apply, root-level
> deploy loop, workers.dev smoke). Set the relevant seam to adopt the workflow
> for non-D1 engines, monorepo deploys, or custom smoke targets without losing
> the snapshot, migrate, build-env, or rollback safety nets.

> **`db-engine` guard.** When `migrate: true` and `db-engine` is not `d1`, the
> `check-env` job fails fast unless both `migrate-command` and
> `snapshot-command` are supplied — a passing `migrate: true` never silently
> skips a real migration.

### The frozen secret allowlist

The deploy secret surface is **frozen** at `{CLOUDFLARE_*, TURSO_*}` (the
build-split capstone). Only these secrets cross the `workflow_call` boundary,
and the workflow maps only this set into its step `env:` blocks:

| Secret                 | Required | Purpose                                                                 |
| ---------------------- | -------- | ----------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | **Yes**  | Cloudflare API token with Worker and D1 write permissions.              |
| `CLOUDFLARE_ACCOUNT_ID`| **Yes**  | Cloudflare Account ID.                                                  |
| `TURSO_DATABASE_URL`   | No       | Turso database URL for non-D1 snapshot/migrate seam commands.           |
| `TURSO_AUTH_TOKEN`     | No       | Turso auth token for non-D1 snapshot/migrate seam commands.            |

The CLOUDFLARE secrets deploy; the optional TURSO secrets feed the non-D1
snapshot/migrate seam commands. The former optional build-secret allowlist
(`SENTRY_*`, `CLERK_*`, `SITE_URL`) is **gone**: every consumer now builds
**consumer-side** and hands the deploy-ready output over via the
`build-artifact` input, so **no build secret reaches this workflow**.
`build-command` remains, but it is now secretless — `build-env` carries only
plaintext public build-time values.

> Callers may still forward further secrets via `secrets: inherit` and
> reference them from their own seam commands, but the workflow itself only
> maps the frozen `{CLOUDFLARE_*, TURSO_*}` set into its seam-step `env:`
> blocks (never via `with:`).

### The `gh-environment` model

`gh-environment` and `environment` are **distinct**:

- **`environment`** is the **Cloudflare** `--env` label (it becomes
  `DEPLOY_ENV` → `wrangler --env`).
- **`gh-environment`** is a **GitHub Deployment Environment** name, attached to
  every secret-touching job purely for **secret scoping and protection rules**.

Leave `gh-environment` empty (the default) for repo-scoped / D1 consumers — an
empty value attaches no GitHub Environment and behaviour is unchanged. Set it
(e.g. `staging`, `production`) **only when** your `CLOUDFLARE_*` / `TURSO_*`
secrets live in a GitHub Environment of that name (the recommended isolation
pattern). When set, `check-env`, `pre-migration-snapshot`, `migrate`,
`deploy`, and `boot-smoke` all run under that GitHub Environment, picking up
its environment-scoped secrets and any required reviewers / wait timers.

---

## `secret-scan-push.yml`

A full-history secret-scan **signal** on push to the default branch. The
`pr-quality.yml` security tier blocks on the **PR diff** (merge-base..head);
this workflow scans the **full git history** (`fetch-depth: 0`) so secrets that
predate the gate, or that land via a path bypassing a PR (force-push,
fork-merge), still surface. It is a **signal, not a gate** — it is
`continue-on-error` and never fails the push (an already-merged commit cannot be
retro-blocked).

### Minimal caller

```yaml
on:
  push:
    branches: [main]
jobs:
  secret-scan:
    uses: dsj1984/mandrel-platform/.github/workflows/secret-scan-push.yml@<sha> # <tag>
    secrets: inherit
```

### Inputs

| Input              | Type   | Default          | When to override                                                                 |
| ------------------ | ------ | ---------------- | ------------------------------------------------------------------------------- |
| `runner`           | string | `'ubuntu-latest'`| Runs-on label. The post-merge scan does not need the consumer's PR runner — `ubuntu-latest` is recommended even for self-hosted consumers. |
| `gitleaks-version` | string | `'8.30.1'`       | Pinned gitleaks release (no leading `v`). Must have a matching SHA-256 in the workflow's checksum map. |

### Where findings surface

The same pinned, checksum-verified gitleaks binary as the `pr-quality` security
tier scans the whole history. Findings surface three ways, in order of
applicability:

1. **`gitleaks-history-sarif` build artifact** — uploaded on every run, so
   findings are retrievable on a **private repo with no GHAS**.
2. **Job summary** — a finding count with remediation guidance.
3. **Code Scanning upload** — only on **public / GHAS** repos
   (`repository.visibility == 'public'`); skipped on private so the signal
   workflow stays green.

It carries **no secrets contract** (`secrets: inherit` is harmless; the scan
needs none) and does **not** replace the blocking PR-time scan — keep
`enable-security: true` on `pr-quality.yml`. This is defence-in-depth on top of
it.

---

## `codeql.yml`

CodeQL SAST analysis. It runs unconditionally on `push` to `main`,
`pull_request` against `main`, and a weekly schedule, and is **also**
consumable as a `workflow_call` target (or as a documented copy-target for
consumer repos).

| Input      | Type   | Default                     | When to override                          |
| ---------- | ------ | --------------------------- | ----------------------------------------- |
| `language` | string | `'javascript-typescript'`   | Set to analyze a different CodeQL language. |

CodeQL is the **GHAS alternative** to `pr-quality.yml`'s Semgrep SAST sub-step:
a consumer with GitHub Advanced Security can run this for blocking Code
Scanning and set `enable-sast: false` on `pr-quality.yml`. It requires
`security-events: write` permission and surfaces findings as Code Scanning
alerts.

---

## `smoke-dispatch.yml`

Platform-internal. On every push to `main`, it fires a cross-repo smoke at the
external consumer repo (`dsj1984/mandrel-platform-smoke`), which calls
`pr-quality.yml@main` and `deploy-cloudflare.yml@main` as a *real* cross-repo
consumer and posts a `smoke/cross-repo` commit status back. The
release-please `await-smoke` gate blocks npm-publish until that status is
green.

It has **no `workflow_call` contract** — it is triggered by `push` to `main`
and `workflow_dispatch` only. It is documented here for completeness; consumer
repos do not call it. It depends on a `SMOKE_DISPATCH_TOKEN` secret (a
fine-grained PAT with Actions: write on the smoke repo and Commit statuses:
write on this repo).

---

## Versioning & compatibility

**Pin by release tag or SHA.** Consumers reference these workflows by a
SHA-pinned `uses:` with a trailing version comment:

```yaml
uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<40-hex-sha> # <tag>
```

The platform stays on `0.x`. The contract guarantees today are:

- **SHA-pinning** — every first-party `uses:` resolves to an exact commit, so
  a consumer's CI is reproducible and never silently picks up a new revision.
- **Renovate auto-bump** — the shared Renovate preset bumps these pins for
  consumers automatically, grouped into a single *"mandrel-platform
  workflows"* PR, provided the pin carries a trailing `# <tag>` version
  comment (a bare SHA with no comment is left alone). See the
  [README — Auto-bumping `uses:` pins](../README.md#auto-bumping-mandrel-platform-uses-pins).
- **Portability lint** — `scripts/check-workflow-portability.mjs` guards the
  cross-repo references so a pin can never land on a commit whose manifest
  carries a `${{ }}` expression footgun.

> **`v1.0` / `@v1` is deferred — not planned.** Cutting a `v1.0` release,
> publishing a moving `@v1` major tag, and `@v1`-style major-tag pinning are a
> *possible future* step but are **not planned now or anytime soon** (operator
> decision, 2026-06-29). There is also no formal SemVer deprecation policy
> today. Until that changes, **pin by release tag/SHA** (Renovate-bumped) as
> above — do not expect a floating `@v1` tag to exist.
