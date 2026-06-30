# Reusable Workflows — Input & Secret Contract

This is the public reference for the **`workflow_call` contract** of the
shared reusable workflows mandrel-platform exposes. Consumer repos configure
their callers from this page rather than reading the workflow YAML.

Two workflows carry a stable public contract:

- [`pr-quality.yml`](#pr-qualityyml) — the tiered PR-quality CI pipeline.
- [`deploy-cloudflare.yml`](#deploy-cloudflareyml) — the defence-in-depth
  Cloudflare deploy.

Four more are consumable but have a much smaller surface, covered briefly at
the end:

- [`secret-scan-push.yml`](#secret-scan-pushyml) — full-history secret-scan
  signal on push to the default branch.
- [`release-automation.yml`](#release-automationyml) — conventional-commit
  release lifecycle (version bump + changelog + tag) on push to the default
  branch.
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
lint + format-check → typecheck → unit → contract → e2e/smoke → migration-guard → security
```

Every tier is independently enable-toggled, so a repo can opt out of tiers it
has not built yet (the [destructive-migration guard](#destructive-migration-guard-enable-migration-guard)
is **opt-in** — default off). A single aggregator job,
[`ci-required`](#the-ci-required-aggregator), is the only branch-protection
context a consumer needs to register.

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
| `enable-migration-guard` | boolean | `false`    | **Opt-in.** Set `true` to enable the destructive-migration label guard. See [Destructive-migration guard](#destructive-migration-guard-enable-migration-guard). |
| `migration-guard-label`  | string  | `'migration:destructive-ok'` | PR label that overrides a destructive-migration finding. Override only when you want a different acknowledgement-label name. |
| `migration-guard-globs`  | string  | `'**/migrations/**,**/drizzle/**'` | Comma-separated migration path globs the guard scans. A changed file matching one of these (or any `*.sql`) is inspected. |
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

### Destructive-migration guard (`enable-migration-guard`)

A **PR-time label guard** that blocks a pull request introducing a
**destructive database migration** unless a reviewer applies an explicit
acknowledgement label. It platformizes the guard `domio` and `athportal` each
hand-rolled and that `swarm-os` was missing — every consumer that opts in
inherits the same invariant.

It is **opt-in** (`enable-migration-guard: false` by default) because not
every consumer ships DB migrations. When enabled, the `migration-guard` job is
a [`needs:` of `ci-required`](#the-ci-required-aggregator), so it is
**branch-protection-load-bearing** through the single aggregator context — no
new required check to register.

**What it detects.** The guard inspects only the **changed migration files** of
a PR (`pull_request` events; it is a no-op on other events). A changed file is
treated as a migration when its path matches one of `migration-guard-globs`
(default `**/migrations/**,**/drizzle/**`) **or** ends in `.sql`. Within those
files it scans for a destructive signal — the best-of-breed **union** of the
two local guards it replaces:

| Signal                | Example                                        |
| --------------------- | ---------------------------------------------- |
| `DROP` statement      | `DROP TABLE users;` / `DROP COLUMN email`      |
| `ALTER TABLE … DROP`  | `ALTER TABLE users DROP COLUMN legacy_id;`     |
| `TRUNCATE`            | `TRUNCATE audit_log;`                          |
| drizzle destructive op| `.dropColumn(…)` / `.dropConstraint(…)`        |
| deleted migration file| a migration file removed by the PR             |

SQL/JS comments (`--`, `//`, inline `/* … */`) are stripped before matching, so
a `DROP` that appears only in a comment never trips the guard. A non-migration
source file mentioning `DROP` in a string is ignored — only the migration
globs / `.sql` files are scanned.

**The override label.** The override is an **explicit PR label**
(`migration-guard-label`, default **`migration:destructive-ok`**). With the
label present, the guard still reports the finding (job summary) but **does not
block**; absent, a finding **fails the job** and therefore `ci-required`. This
keeps a destructive change shippable — but only with a deliberate, on-the-record
acknowledgement.

**Scope.** This is the **static, PR-time** half of the migration story: it
inspects changed migration files, it does **not** introspect a live database,
and it does **not** touch the snapshot/rollback flow in
[`deploy-cloudflare.yml`](#deploy-cloudflareyml) (that ships separately). Static
signal on changed files is sufficient for the gate.

> **Minimal opt-in caller.**
>
> ```yaml
> jobs:
>   pr-quality:
>     uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<sha> # <tag>
>     with:
>       enable-migration-guard: true
>     secrets: inherit
> ```
>
> Register `migration:destructive-ok` as a PR label in the consumer repo so a
> reviewer can apply it. Override `migration-guard-label` /
> `migration-guard-globs` only when your repo uses a different label name or
> migration directory layout.

> **Reference detection contract.** The exact destructive-signal set is
> codified and unit-tested in
> `scripts/check-destructive-migration.mjs` /
> `scripts/check-destructive-migration.test.mjs` on the platform repo. The
> in-workflow job is the portable implementation of that same contract, so an
> opt-in consumer needs **no** consumer-side script copy to inherit the gate.

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

## `release-automation.yml`

The consumer **release-lifecycle** channel: a `workflow_call` wrapper around
[release-please](https://github.com/googleapis/release-please-action) that
maintains a release PR off the consumer's default branch and, when that PR
merges, cuts a conventional-commit-driven **version bump + `CHANGELOG.md` + git
tag + GitHub Release**. It is the fourth distribution channel alongside
`pr-quality.yml`, `deploy-cloudflare.yml`, and the npm config package, extending
the platform from CI/deploy into the full release lifecycle.

> **Why release-please, not changesets.** The platform already runs
> release-please for its own release train (the platform-internal
> [`release-please.yml`](#release-pleaseyml)) and codifies the conventional-commit
> contract in [`git-conventions.md`](../.agents/rules/git-conventions.md) plus
> `release-please-config.json`'s `changelog-sections`. A consumer adopting this
> workflow inherits the **same** conventional-commit → version-bump → changelog
> mapping the platform itself uses, with no new authoring model. changesets
> would add a second, divergent convention (per-change markdown intents) that
> conflicts with the commit-message-as-source-of-truth posture
> `git-conventions.md` mandates.

> **Scope — version/changelog/tag, not publish.** This unit produces the
> version bump, changelog, tag, and GitHub Release **only**. It does **not**
> publish to any registry: consumers deploy to Cloudflare (via
> [`deploy-cloudflare.yml`](#deploy-cloudflareyml)), not npm, so registry
> publish is out of scope. A consumer that *does* publish wires its own publish
> job keyed off the `release_created` / `tag_name` outputs (see below). This is
> the deliberate boundary with the platform-internal `release-please.yml`, which
> adds an npm-publish job for the `mandrel-platform` package itself.

### Minimal caller

```yaml
on:
  push:
    branches: [main]

# release-please needs write access to open the release PR, tag, and cut the
# release. Grant these at the caller (a reusable workflow cannot widen the
# caller's token scope).
permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  release:
    uses: dsj1984/mandrel-platform/.github/workflows/release-automation.yml@<sha> # <tag>
    secrets: inherit
```

`secrets: inherit` forwards the optional `release-token` (see Secrets). The
default single-package `node` caller above needs no further inputs — it reads
the version from `package.json` and writes `CHANGELOG.md`.

### Inputs

| Input           | Type   | Default  | When to override                                                                                                                                              |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `target-branch` | string | `'main'` | Branch release-please maintains the release PR against. Set to your release branch if you cut releases off a branch other than the default.                   |
| `release-type`  | string | `'node'` | release-please strategy. `'node'` reads/writes `package.json` + `CHANGELOG.md`. Use `'simple'` for a non-Node version file, etc. Ignored when `config-file` is set. |
| `config-file`   | string | `''`     | Path to a release-please config JSON. Omit for single-package mode; supply for a monorepo or to pin `changelog-sections` to the platform's `git-conventions.md` mapping. |
| `manifest-file` | string | `''`     | Path to the release-please manifest JSON. Required when `config-file` is set (config + manifest are a matched pair); ignored otherwise.                       |
| `package-name`  | string | `''`     | Package name used in the release PR title and tag. Defaults to empty (the `node` type reads it from `package.json`); set explicitly for non-Node types.       |

### Secrets

| Secret          | Required | When to set                                                                                                                                                  |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `release-token` | No       | A PAT or GitHub App installation token (`contents:write`, `pull-requests:write`) used **instead of** `GITHUB_TOKEN`. Falls back to `GITHUB_TOKEN` when unset. |

> **Strongly recommend a `release-token`.** The default `GITHUB_TOKEN` does
> **not** trigger downstream workflows on the release PR it opens (GitHub's
> anti-recursion safeguard), so that PR never runs your required CI and cannot
> auto-merge. A user-scoped PAT acts like a real user, so CI fires normally —
> the same posture the platform-internal `release-please.yml` documents for its
> `RELEASE_PLEASE_TOKEN`.

### Outputs

| Output            | Description                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `release_created` | `'true'` when this run cut a release (the release PR merged and a tag was created). Gate a publish/deploy job on it. |
| `tag_name`        | The created tag (e.g. `v1.4.0`) when `release_created` is `'true'`; empty otherwise.                              |

A consumer that publishes or deploys on release keys a downstream job off these
outputs:

```yaml
jobs:
  release:
    uses: dsj1984/mandrel-platform/.github/workflows/release-automation.yml@<sha> # <tag>
    secrets: inherit
    permissions:
      contents: write
      pull-requests: write
      issues: write
  publish:
    needs: release
    if: ${{ needs.release.outputs.release_created == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "Cut ${{ needs.release.outputs.tag_name }} — run deploy/publish here."
```

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

## `release-please.yml`

Platform-internal. On every push to `main` it runs
[release-please](https://github.com/googleapis/release-please-action) to
maintain the release PR and, once that PR merges and a release is cut,
publishes the `mandrel-platform` npm config package. It has **no
`workflow_call` contract** — it is triggered by `push` to `main` and
`workflow_dispatch` only.

### npm publish posture — provenance + OIDC trusted publishing

The `npm-publish` job publishes with **npm OIDC trusted publishing** and
**build provenance**, not a long-lived token:

- **No `NPM_TOKEN`.** The job sets no `NODE_AUTH_TOKEN` / `NPM_TOKEN`. Its
  `id-token: write` permission mints a short-lived GitHub OIDC token that the
  npm CLI exchanges for a per-run publish credential. Trusted publishing
  needs npm ≥ 11.5.1 and Node ≥ 22.14.0; the `.nvmrc` Node (24.16.0) clears
  the Node floor, and the publish step relies on Actions' npm being at or
  above the CLI floor (Setup Node's runner image ships a current npm). The
  standing `NPM_TOKEN` repo/org secret has been retired; nothing in the
  publish path reads it.
- **Provenance attestation.** `npm publish --provenance` (reinforced by
  `publishConfig.provenance: true` in `package.json`) emits a
  [provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
  tying each release back to its source commit and the workflow run that
  built it. The package's npm page shows a **Provenance** badge linking the
  published tarball to this repo + run.
- **One-time trusted-publisher setup.** OIDC publishing requires a **trusted
  publisher** to be registered once on the
  [`mandrel-platform` npm package settings](https://www.npmjs.com/package/mandrel-platform/access)
  page, naming this repo (`dsj1984/mandrel-platform`), the workflow filename
  (`release-please.yml`), and the job environment. Without that registration
  the OIDC token exchange 403s and the publish fails closed — it never falls
  back to a token. If the publisher is ever reconfigured (repo rename,
  workflow move), update it there; there is no secret to rotate.

This converts the previously-orphaned `id-token: write` permission into the
load-bearing root of the publish credential and removes the standing
long-lived secret that three downstream repos (`domio`, `athportal`,
`swarm-os`) depend on.

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
- **Two-surface drift coupling** — the platform also ships as an npm config
  package (`mandrel-platform` in `package.json`: `tsconfig.base.json`,
  `biome.base.json`, the Renovate preset). The standing
  [pin-drift dashboard](runbooks/pin-drift-dashboard.md) asserts a consumer's
  workflow `uses:` tag and its `mandrel-platform` npm minor do **not** diverge
  undetected — while treating the transient skew during the Renovate
  **`minimumReleaseAge`** hold (3 days post-release) as expected, not drift.

> **`v1.0` / `@v1` is deferred — not planned.** Cutting a `v1.0` release,
> publishing a moving `@v1` major tag, and `@v1`-style major-tag pinning are a
> *possible future* step but are **not planned now or anytime soon** (operator
> decision, 2026-06-29). There is also no formal SemVer deprecation policy
> today. Until that changes, **pin by release tag/SHA** (Renovate-bumped) as
> above — do not expect a floating `@v1` tag to exist.
