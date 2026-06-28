# Cross-Project DevOps Audit — domio · athportal · swarm-os

> **Scope:** Foundational platform / DevOps layer only (environment, build, CI/CD, deploy, IaC, security tooling, DevOps docs). Application/business logic excluded per audit brief.
> **Targets:** `domio` · `athportal` · `swarm-os` (all `/Users/dsj/Development/`)
> **Date:** 2026-06-28
> **Method:** 15 evidence-bound readers (3 repos × 5 DevOps dimensions: CI · deploy/IaC · runtime/deps · security/secrets · docs/observability) → cross-project synthesis. All claims cite `file:line`.

---

## 1. Executive Summary

Overall posture is **mature and strikingly uniform in intent but inconsistently realized**. All three repos descend from the same Mandrel framework and share the same shape — pnpm + Turborepo monorepos deploying to Cloudflare Workers — and each independently lands sophisticated controls (catalog-pinned dependencies, baseline ratchets for coverage/CRAP/maintainability/bundle-size, self-expiring CVE allowlists, SHA-pinned actions, secret-residence SSOTs, and rich runbook sets). The weaknesses are not capability gaps so much as **drift and unrealized enforcement**: the same artifact is hand-reimplemented three times and slowly diverges, and several controls that look present are no-ops in practice. Because the divergence is drift rather than deliberate variation, nearly every finding is fixable once and inherited by all three.

**The single highest-risk gap is that the security gates marked "required" do not actually run on these private repos.** No repo has working SAST — domio and swarm-os have no CodeQL at all, and athportal's CodeQL plus its PR secret-scan are gated on `repository.visibility == 'public'`, so on the private repo a *required* `gitleaks-pr` check passes green without ever scanning the diff (`quality.yml:1500-1534`, `codeql.yml:38`). Combined with branch protection being unenforced on the free private plan (swarm-os) or admin-bypassable, the net effect is that a secret or code-level vulnerability can reach `main` through the exact gate meant to stop it. This is a 3-of-3 exposure with the illusion of coverage, which is worse than a known-absent control.

**Top findings**

- **No effective SAST or private-repo PR secret scanning (3/3).** Code-level vuln classes are uncovered everywhere; the one required secret gate is a green no-op on private. *So-what: the merge-blocking security gate provides false assurance, not protection.*
- **Broken deploys ship green — no post-deploy health gate or auto-rollback (3/3).** swarm-os has no smoke at all, domio gates prod smoke off by default, athportal smokes staging-only after traffic is live. *So-what: a non-booting Worker serves production until a human notices.*
- **Forward-only DB migrations applied pre-deploy with no snapshot/PITR (3/3), and staging auto-deploys with no CI-green gate (3/3).** *So-what: a bad migration mutates the live schema irreversibly, and an un-tested commit can reach staging before checks finish.*
- **Platform security headers (CSP/HSTS/X-Frame-Options) and a CORS allowlist are missing on athportal and swarm-os (2/3)** — a direct violation of their own `security-baseline.md`, with domio already shipping the reference implementation. *So-what: two production APIs/sites lack baseline transport hardening the org has already built once.*
- **Massive reimplementation overhead.** athportal's CI alone is a 1,635-line `quality.yml`; the PR gate, composite setup action, deploy sequence, `wrangler` config, `renovate.json`, `tsconfig.base.json`, and CVE-gate script are duplicated 3× and drifting. *So-what: every fix below must be made three times today.*

**Most impactful unification opportunities** (all inherit-once via a new shared **`mandrel-platform`** distribution — reusable `workflow_call` workflows + composite actions + an npm config package, deliberately kept *separate* from the `mandrel` AI-harness framework so each stays single-purpose; see §6 for the setup): (1) a **shared reusable PR-quality workflow** parameterized by runner/shard/tier — kills ~1,600 lines in athportal and makes required-check-name drift structurally impossible; (2) a **shared Cloudflare deploy workflow** that bakes in athportal's `isolation-audit` job and `smoke-deploy.sh` boot-smoke plus a pre-migration snapshot, fixing the post-deploy and migration High gaps everywhere at once; (3) a **shared platform-security baseline** (port domio's `_headers` + CSP-nonce middleware to the other two, add an unconditional CodeQL + private-repo-capable secret scan); (4) a **shared Renovate preset + base-config package** (`tsconfig.base.json`, CVE-gate script, override conventions); and (5) a **single `main-protection.json` contract with a CI lint** asserting every required context is actually emitted by a job.

**Headline version drifts:**

- **Node: domio is a full major behind (exact `22.19.0` vs `24` on the other two), and only domio's CI floats `node-version:"22"` instead of reading `.nvmrc`.** *So-what: three runtime surfaces, and domio's CI/prod deploy can run any 22.x patch despite an exact pin.*
- **pnpm: `10.26.2` (domio) vs `11.5.2` (athportal, swarm-os)** — which forces domio's dependency overrides into `package.json#pnpm` instead of the house-style `pnpm-workspace.yaml`. *So-what: the override-placement split is a downstream symptom that resolves itself once domio upgrades.*
- **`compatibility_date`: athportal is stale by over a year (`2025-01-01` against wrangler `^4.105.0`; domio `2026-04-21`, swarm-os `2026-06-18`).** *So-what: workerd runtime semantics are frozen far behind tooling, risking local-vs-deployed divergence.*
- **No repo enforces `engine-strict` (0/3) and Turbo floors range from `^2.3.3` to `^2.9.17`.** *So-what: the version pins are advisory, so the carefully-chosen baselines aren't actually load-bearing.*

---

## 2. Cross-Project Matrix

All three repos share the Mandrel framework heritage, so most divergences read as drift rather than deliberate variation. ✅ = present/wired, ❌ = absent, with exact values where they carry signal.

| Attribute | domio | athportal | swarm-os |
|---|---|---|---|
| Node engine pin | exact `22.19.0` (package.json:8) + `.nvmrc` 22.19.0 | range `>=24 <25` (package.json:7-9), `.nvmrc` "24" | range `>=24 <25` (package.json:6-8), `.nvmrc` "24" |
| CI honors Node pin | ❌ floating `node-version:"22"` (ci-pr.yml:210) | ✅ `node-version-file:.nvmrc` (setup-toolchain:44-47) | ✅ `node-version-file:.nvmrc` (setup/action.yml:14-18) |
| engine-strict enforced | ❌ no `.npmrc` (package.json:7-10) | ❌ no `.npmrc` | ❌ no `.npmrc` |
| pnpm version | `10.26.2` (package.json:6) | `11.5.2` (package.json:6) | `11.5.2` (package.json:5) |
| lockfileVersion | `9.0` (pnpm-lock.yaml:1-5) | `9.0` (pnpm-lock.yaml:1-5) | `9.0` (pnpm-lock.yaml:1) |
| Turbo version | `^2.9.17`→2.9.17 (pnpm-lock.yaml:7367) | `^2.9.16`→2.9.18 (package.json:103) | `^2.3.3`→2.9.18 (package.json:78) |
| Catalog single-sourcing | ✅ ~65 entries (pnpm-workspace.yaml:21-86) | ✅ 18 entries (pnpm-workspace.yaml:12-35) | ✅ Astro/React/Clerk/Drizzle sets (pnpm-workspace.yaml:9-55) |
| Dep overrides (CVE floors) | 26 entries in package.json#pnpm (package.json:116-144) | 8 entries w/ CVE refs (pnpm-workspace.yaml:40-80) | 1 (`minimatch@^10`, pnpm-workspace.yaml:101-102) |
| Patched deps | ❌ none (package.json:116-144) | `oxc-parser@0.130.0` (pnpm-workspace.yaml:102-103) | ❌ none |
| Scripts surface | build/lint/test/validate + ratchets (package.json:11-61) | 63 scripts, no `validate` (package.json:10-74) | dev/build/lint/test + ratchets, no `validate` (package.json:9-56) |
| CI workflow file(s) | ci-pr.yml + 5 (migration-guard, mutation-test, lighthouse-weekly, deploy-{staging,production}) | quality.yml (1635L) + 6 (codeql, nightly, secret-scan-push, migration-label-guard, deploy-{staging,production}) | ci.yml + 3 (nightly, deploy-{staging,production}) |
| Single-required-check pattern | ✅ `ci-required` aggregator (ci-pr.yml:33-39,493-517) | ✅ personas roll-up + per-job (quality.yml:1064-1098) | ❌ 5 separate required contexts (main-protection.json:1-17) |
| Runner type | self-hosted `domio-runner` (PR); ubuntu deploy (ci-pr.yml:67) | self-hosted `athportal-runner` (most); ubuntu (some) (quality.yml:144) | ubuntu-latest only (ci.yml:59) |
| Build/test/lint gates | typecheck/eslint/dep-cruiser/audit/ratchets (ci-pr.yml:220-318) | biome+eslint+knip+typecheck+ratchets+RBAC drift (quality.yml:155-274) | biome+eslint+knip+dep-cruiser+gherkin+ratchets (ci.yml:67-144) |
| Caching strategy | ❌ none on self-hosted; no turbo remote (ci-pr.yml:210-212) | ✅ Turbo remote cache (TURBO_TOKEN/TEAM) + Playwright (quality.yml:23-25) | setup-node pnpm cache only; no turbo remote (setup/action.yml:14-18) |
| Mutation testing | dispatch-only, docs claim absent nightly (mutation-test.yml:3-22) | ✅ nightly Stryker (nightly.yml) | ✅ nightly Stryker, floor 100 (nightly.yml:91-135) |
| Lighthouse/perf | ✅ weekly cron (lighthouse-weekly.yml:3-6) | ✅ nightly baseline (nightly.yml:446-485) | ❌ none |
| Deploy target | Worker (web only, godomio.com/*) (wrangler.jsonc:10-16,106-119) | 2 Workers: api + web (Story #1982) (deploy-staging.yml:153-208) | Worker (api) + Pages direct-upload (web) (deploy-staging.yml:64-82) |
| staging→prod model | staging auto-on-main; prod manual dispatch, decoupled (deploy-production.yml:17-42,87-91) | staging auto-on-main; prod manual + isolation-audit + reviewer (deploy-production.yml:27-72) | staging auto-on-main; prod manual dispatch (sole gate) (deploy-production.yml:1-13,23) |
| staging gated on CI-green | not stated | strict branch-protection relied on (quality.yml:93-100) | ❌ no `needs:`/`workflow_run` gate (deploy-staging.yml:11-14) |
| Secret injection at deploy | Infisical→GitHub Env secrets + `wrangler secret put` (environments.md:12-17) | Infisical→GitHub Env secrets + `wrangler secret put` (deploy-staging.yml:79-84) | GitHub Env secrets (no Infisical) + manual `secret put` (deploy-staging.yml:28-41) |
| Runtime secrets via `wrangler secret put` in CI | ❌ out-of-band | ❌ out-of-band (wrangler.toml:113-251) | ❌ out-of-band, no step at all (app.ts:10-29) |
| Post-deploy smoke/health | prod gated off `PROD_SMOKE_ENABLED` (deploy-production.yml:140-148) | ✅ `smoke-deploy.sh` boot-smoke (staging) (deploy-staging.yml:224-234) | ❌ none in workflows (deploy-*.yml) |
| Rollback mechanism | manual `wrangler rollback`, surfaced in summary (deploy-production.yml:152-172) | manual: re-dispatch / `wrangler rollback` (rollback.md:49-60) | manual `wrangler rollback`/pages (deploy.md:116-156) |
| DB migrations at deploy | staging auto (host-guard); prod opt-in `skip_migrations` (deploy-staging.yml:421-443) | both run before deploy, forward-only, no rollback (deploy-production.yml:177-189) | both run before deploy, forward-only, no backup (deploy-production.yml:55-56) |
| Migration destructive-guard | ✅ path-correct (migration-guard.yml:1-42) | ⚠️ scans wrong path `apps/api/**` (migration-label-guard.mjs:18-19) | ❌ none |
| Secret scanning (local) | secretlint via lint-staged (pre-commit) (.lintstagedrc:11) | secretlint via lint-staged (pre-commit) (lint-staged.config.js:22) | secretlint via lint-staged (pre-commit) (lint-staged.config.js:28-37) |
| Secret scanning (CI) | gitleaks (PR-only, blocking) (ci-pr.yml:144-166) | gitleaks-pr (✅ but no-op on private) + push-history + nightly TruffleHog (quality.yml:1467-1534) | secretlint + TruffleHog `--only-verified` (ci.yml:90-115) |
| SAST/CodeQL | ❌ none | CodeQL present but public-gated no-op (codeql.yml:38) | ❌ none |
| Dependency vuln scan (pnpm audit) | ✅ fixable-only gate (audit-fixable-gate.mjs) | ✅ High/Crit prod-graph blocking (audit-check.mjs) | ✅ High/Crit prod-graph + self-expiring allowlist (audit-check.mjs) |
| Renovate config | ✅ Mon, 3d release-age, automerge (renovate.json:1-27) | ✅ Mon, 3d release-age, automerge (renovate.json:1-77) | ✅ Mon, 3d release-age, automerge (renovate.json:1-60) |
| Lint/format tool | eslint + prettier (no CI `--check`) (ci-pr.yml static job) | biome + eslint (+ md/RBAC) (quality.yml:155-164) | biome + eslint + markdownlint (ci.yml:67-88) |
| Commit hooks | commit-msg/pre-commit/pre-push (.husky/*) | husky not a dep; pre-commit no `set -e` (package.json:65) | pre-commit no `set -e`; pre-push has it (.husky/*) |
| Action SHA-pinning | ✅ all third-party pinned (ci-pr.yml:157-208) | ✅ all third-party pinned (setup-toolchain:25-47) | partial: high-blast pinned, first-party on `@v4` (ci.yml:33-41) |
| Job timeouts | ✅ per-job everywhere (ci-pr.yml:68-500) | ✅ per-job everywhere (quality.yml:69-1552) | ❌ none (6h default) (grep across .github) |
| Observability bindings | observability+Sentry, no Logpush/AE (wrangler.jsonc:17-22) | ✅ AE + Logpush + Sentry releases (wrangler.toml:280-282,41) | ❌ none declared; docs claim AE (wrangler.toml:1-48) |
| Server Sentry actually reaches | ❌ no-op on Workers (sentry.server.config.ts:1-16) | ✅ Sentry releases per deploy | ❌ inert, no account (#21) (deploy.md:182-183) |
| Uptime monitoring | 5-min synthetic cron (wrangler.jsonc:192-197) | Better Stack IaC but never applied + placeholder URLs (betterstack.yml:24-49) | Better Stack decided (ADR-0007) but not wired (patterns.md:192-193) |
| Environments doc | ✅ environments.md SSOT (environments.md:28-52) | ✅ environments.md SSOT (environments.md:36-57) | ✅ environment.md SSOT (environment.md:9-17) |
| Rollback runbook | ✅ rollback.md (rollback.md:1-155) | ✅ rollback.md, but Pages-stale steps (rollback.md:154-164) | ✅ within deploy.md (deploy.md:116-156) |
| Incident-response runbook | ❌ only stale `.github/RUNBOOKS/` copy (.github/RUNBOOKS/incident-response.md:1-36) | ❌ embedded only, no dedicated doc (rollback.md:245-289) | ❌ none (deploy.md rollback only) |
| Branch protection applied | ✅ ruleset (admin-bypassable) | ⚠️ docs drift vs live job names; `secretlint` required but no job (main-protection.json:4-22) | ❌ codified not applied (free private plan) (branch-protection-setup.md:10-44) |

---

## 3. Key Overlaps & Unification Opportunities

Three sibling repos, same Mandrel framework, same Cloudflare-Workers-via-pnpm-Turborepo shape — most of the divergence in the corpus is drift, and the same handful of artifacts are reimplemented three times. The opportunities below are ordered by payoff.

### 1. Shared reusable CI workflow for the PR quality gate

- **Duplicated today:** each repo carries a near-identical fan-out PR gate — domio `.github/workflows/ci-pr.yml` (7 jobs, single `ci-required` aggregator), athportal `.github/workflows/quality.yml` (1635 lines, ~16 jobs), swarm-os `.github/workflows/ci.yml` (5 jobs: Static analysis / Security / Tests & baselines / Build / E2E & smoke). All three run the same logical tiers: lint+format+typecheck, secret scan, unit+contract coverage with baseline ratchets, build+bundle-size, and a smoke/acceptance subset.
- **Approach:** publish a `workflow_call` reusable workflow (in the new `mandrel-platform` repo — see §6) that accepts inputs for runner label (`self-hosted, domio-runner` / `athportal-runner` / `ubuntu-latest`), shard count, and which optional tiers to enable. Each repo's `ci-pr.yml`/`quality.yml`/`ci.yml` shrinks to a thin caller. The aggregator-as-single-required-check pattern (domio `ci-pr.yml:493-517`, swarm-os `main-protection.json:1-17`) becomes a built-in output.
- **Payoff:** kills ~1600 lines of bespoke YAML in athportal alone, makes the required-check-name drift (see §7) structurally impossible because the job names are defined once, and lets a fix (e.g. adding timeouts, see §5) land in all three repos via one `mandrel-platform` version bump (Renovate-driven, see §6.5).

### 2. Shared composite toolchain-setup action

- **Duplicated today:** domio `.github/actions/setup-pnpm-node/action.yml`, athportal `.github/actions/setup-toolchain/action.yml`, swarm-os `.github/actions/setup/action.yml`. All three do the same three steps: `pnpm/action-setup` (version from `package.json#packageManager`), `actions/setup-node` with `node-version-file: .nvmrc`, then `pnpm install --frozen-lockfile`. domio and athportal additionally encode the same "no `cache: pnpm` on the warm self-hosted store" decision.
- **Approach:** ship one published composite action consumed by reference (e.g. `dsj1984/mandrel-platform/.github/actions/setup-toolchain@<sha>`) with a `cache` boolean input so the self-hosted repos pass `cache: false` and swarm-os (ubuntu-latest) passes `cache: true`. This also closes the duplication where the *deploy* and *nightly* workflows re-declare the setup steps inline instead of reusing the local composite (swarm-os `deploy-staging.yml:46-56`, `deploy-production.yml:43-53`, `nightly.yml:59-69`; athportal deploy workflows use the composite, so this aligns swarm-os to athportal's pattern).
- **Payoff:** single place to bump the `pnpm/action-setup`/`setup-node` SHAs and the install flags; removes the inline-vs-composite inconsistency flagged in swarm-os.

### 3. Shared deploy action / reusable deploy workflow for Cloudflare Workers

- **Duplicated today:** the deploy sequence is the same everywhere — install → `db:migrate` against the env's Turso/libSQL DB → build → `wrangler deploy` (+ Pages/Worker for web) → conditional Sentry source-map upload. See domio `deploy-staging.yml`/`deploy-production.yml`, athportal `deploy-staging.yml:136-234`/`deploy-production.yml:143-311`, swarm-os `deploy-staging.yml:11-91`/`deploy-production.yml:12-86`. All three use the same promotion model (staging auto-on-push-to-main, production `workflow_dispatch`-only) and the same per-env GitHub Environment secret-sourcing.
- **Approach:** a `workflow_call` deploy workflow parameterized by env name, worker/project names, and a `migrate` toggle. Bake in the strongest patterns each repo already has so all three inherit them: athportal's `isolation-audit` job (`deploy-production.yml:53-72`), athportal's `smoke-deploy.sh` post-deploy boot-smoke (`deploy-staging.yml:224-234`) — which domio gates off by default and swarm-os lacks entirely — and athportal's `check-env.mjs` pre-deploy gate. The forward-only migration risk (no rollback/snapshot) is identical across all three and is the right place to add a shared pre-migration snapshot step once.
- **Payoff:** every repo gets defence-in-depth it is currently missing (post-deploy health gate in domio/swarm-os, isolation audit in domio/swarm-os, pre-deploy env validation everywhere), and the "deploy doesn't re-validate / no rollback on smoke failure" High risk is fixed in one place.

### 4. Shared `wrangler.*` base config + compatibility-date drift fix

- **Duplicated today:** all three commit hand-maintained per-env wrangler configs that redeclare bindings, vars, and `compatibility_flags: [nodejs_compat]` per named env (domio `apps/web/wrangler.jsonc:105-462`, athportal `apps/api/wrangler.toml` + `apps/web/wrangler.toml`, swarm-os `apps/api/wrangler.toml` + `apps/web/wrangler.jsonc`). `compatibility_date` is independently drifting: domio `2026-04-21`, athportal a stale `2025-01-01` (against wrangler `^4.105.0`), swarm-os `2026-06-18`.
- **Approach:** standardize a `compatibility_date` (and a Renovate rule, see §6, to advance it with wrangler bumps) across all three, and codify the per-env-non-inheritance discipline as a shared documented convention. This is config-level rather than a code package, but the convention and the `compatibility_date`/flags values should be uniform.
- **Payoff:** removes the silent local-dev-vs-deployed divergence risk (most acute in athportal's 18-month-stale date) and makes the per-env redeclaration footgun a known, documented pattern rather than three independent discoveries.

### 5. Uniform job-timeout and caching policy

- **Duplicated today (by its absence):** swarm-os has NO `timeout-minutes` on any job in any workflow (default 6h), while domio and athportal set explicit per-job timeouts (domio `ci-pr.yml:68,149,176,...`; athportal `quality.yml:69,145,219,...`). Caching also diverges: domio and athportal use Turbo remote cache only on some paths / not at all (domio has none — `turbo.json:1-60`), swarm-os has none and reinstalls Playwright chromium every run.
- **Approach:** because §1/§2 centralize the workflow and setup, the timeout values and the cache strategy (Turbo remote cache via `TURBO_TOKEN`/`TURBO_TEAM`, Playwright browser cache keyed on the `@playwright/test` version) become shared inputs/defaults rather than per-repo choices.
- **Payoff:** swarm-os stops risking 6h hung runs; all three get a consistent, reviewable CI-cost posture; the "no remote cache, correctness depends on warm self-hosted store" risk in domio/athportal is addressed once.

### 6. Single required-status-check contract (`main-protection.json`)

- **Duplicated today:** each repo codifies branch protection in `docs/runbooks/main-protection.json` (athportal lines 1-29 + a conflicting ADR-0020 list; swarm-os `main-protection.json:1-17` matching its 5 job names; domio relies on a `ci-required` aggregator name). Both athportal and swarm-os have documented-vs-reality drift: athportal lists a required `secretlint` check that no job emits and job display names that no longer match; swarm-os's `branch-protection-setup.md` still references a never-built `quality.yml`.
- **Approach:** once §1 fixes the job names in one place, ship a single canonical `main-protection.json` shape (the aggregator-check pattern is cleanest: one stable required context). Add a CI check that asserts every context named in `main-protection.json` is actually emitted by the workflow — a lint that all three inherit.
- **Payoff:** eliminates the "required check that never reports blocks every PR forever" failure mode (called out as High in athportal and Low in swarm-os) and removes three independent sources of doc drift.

### 7. Shared Renovate preset

- **Duplicated today:** the three `renovate.json` files are nearly identical — `config:recommended` + `:dependencyDashboard`, Monday-before-9am `America/New_York` schedule, `minimumReleaseAge` 3 days (domio uses 3-day too), `platformAutomerge`, patch/minor auto-merge, majors gated behind `dependencyDashboardApproval`, weekly `lockFileMaintenance`, and the same grouping (Astro/Sentry/ESLint/Vitest/Playwright/Cloudflare/Clerk). See domio `renovate.json:1-114`, athportal `renovate.json:1-77`, swarm-os `renovate.json:1-77`.
- **Approach:** publish a shared preset from `mandrel-platform` and reduce each repo's `renovate.json` to `{"extends": ["github>dsj1984/mandrel-platform"]}` plus repo-specific overrides (e.g. the per-repo Clerk/Expo pins). Fold in the `compatibility_date`-advances-with-wrangler rule from §4 and a `node` nvm-manager rule so `.nvmrc` and `engines` stay in lockstep.
- **Payoff:** one place to maintain grouping/schedule; also a natural home to fix domio's stale `vite <8.0.0` constraint drift (`renovate.json:33-37`) so it can't recur in the siblings.

### 8. Shared base config package (`@repo/config`-style) for TS / Turbo / lint floors

- **Duplicated today:** all three carry the same `tsconfig.base.json` strictness SSOT (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: Bundler`, `target ES2022`) — domio `tsconfig.base.json:1-30`, athportal `tsconfig.base.json:3-16`, swarm-os `tsconfig.base.json:1-19`. The pnpm `overrides` CVE-floor blocks (domio `package.json:116-144`, athportal `pnpm-workspace.yaml:40-80`, swarm-os `pnpm-workspace.yaml:101-102`), the `audit-check.mjs`/`audit-fixable-gate.mjs` CVE gate, and the baseline-ratchet config also recur. athportal and swarm-os already have a `packages/config` workspace; domio does not.
- **Approach:** promote the shared TS base, the CVE-gate script, and the catalog/override conventions into the `mandrel-platform` npm package (a package distinct from the `mandrel` AI-harness package — see §6). Repos extend it: `"extends": "mandrel-platform/tsconfig.base.json"`.
- **Payoff:** the security-floor overrides and the CVE-gate logic stop being three hand-synced copies (domio's `audit-fixable-gate.mjs` is fixable-only while athportal/swarm-os block all unsuppressed high/critical — unifying surfaces that policy divergence for a deliberate decision), and a strictness change propagates uniformly.

### 9. Shared platform-security baseline: SAST + security headers + private-repo secret scanning

- **Duplicated today (by shared absence):** **no repo has CodeQL/SAST** wired as an effective gate (domio has none; athportal `codeql.yml` and swarm-os both gate on `repository.visibility == 'public'`, so all three are no-ops on private repos). **athportal and swarm-os both lack platform security headers** (CSP/HSTS/X-Frame-Options/X-Content-Type-Options) and CORS allowlist middleware, despite the shared `security-baseline.md` requiring them — domio *does* have them (`apps/web/public/_headers`, `cspMiddleware.ts`), making it the reference implementation. The private-repo `gitleaks`/CodeQL no-op also affects athportal and swarm-os identically.
- **Approach:** (a) add one shared CodeQL reusable workflow that runs unconditionally (or a private-repo-capable secret scan — run the pinned `gitleaks`/`trufflehog` binary cross-platform, or wire `pnpm run lint:secrets` over the PR diff) so the required secret gate actually scans on private repos; (b) port domio's Hono/Astro security-header + CSP-nonce middleware into the shared base so athportal's Hono API and swarm-os's Hono API both get `secureHeaders()` + an Astro `_headers`/middleware pass.
- **Payoff:** closes the two High-severity security gaps that recur across athportal and swarm-os (no-op PR secret scan, missing security headers) with domio's already-built patterns, and gives all three real SAST coverage instead of three independent green no-ops.

### 10. Shared runbook templates + observability/incident-response baseline

- **Duplicated today:** `docs/runbooks/` and `docs/environments.md` (Infisical-SSOT secret-residence matrix, deploy-promotion, rollback) are structurally the same across domio and athportal and partially in swarm-os, and all three suffer the **same drift class**: Pages-vs-Worker stale references after the web migration (athportal `rollback.md`/`tech-stack.md`/`architecture.md`; swarm-os `deploy.md`/`branch-protection-setup.md`), and missing incident-response/SLO docs (swarm-os has none; athportal has none; domio has a stale duplicate `.github/RUNBOOKS/`).
- **Approach:** ship runbook *templates* (deploy-promotion, rollback, incident-response, observability, environments) via the `mandrel-platform` package (a `platform sync`-style scaffold step, the operator-facing analogue of `mandrel sync`) so the skeleton and the cross-link structure are uniform, leaving only repo-specific values to fill. Pair with a docs-staleness lint (the audit already found Pages-vs-Worker drift in two repos) that flags retired-product references.
- **Payoff:** the recurring "runbook tells the operator to use a dashboard the product no longer deploys to" incident-time hazard is fixed once at the template level, and swarm-os/athportal both gain the incident-response/SLO skeletons they currently lack.

---

## 4. Critical Divergences & Version Drifts

### 4.1 Runtime & Tool Version Drift

This is the most clear-cut drift class: all three repos are the same stack but pin different baseline runtimes and toolchain versions.

| Dimension | domio | athportal | swarm-os |
|---|---|---|---|
| Node engine | exact `22.19.0` (`package.json:6-10`) + `.nvmrc` `22.19.0` (`.nvmrc:1`) | range `>=24 <25` (`package.json:7-9`) + `.nvmrc` `24` | range `>=24 <25` (`package.json:6-8`) + `.nvmrc` `24` (`.nvmrc:1`) |
| pnpm | `10.26.2` (`package.json:6`) | `11.5.2` (`package.json:6`) | `11.5.2` (`package.json:5`) |
| Turbo | `^2.9.17` → resolved `2.9.17` (`pnpm-lock.yaml:7367`) | `^2.9.16` → resolved `2.9.18` (`package.json:103`) | `^2.3.3` → resolved `2.9.18` (`package.json:78`) |
| lockfileVersion | `9.0` (`pnpm-lock.yaml:1-5`) | `9.0` (`pnpm-lock.yaml:1-5`) | `9.0` (`pnpm-lock.yaml:1`) |
| CI Node resolution | `node-version: "22"` floating major, 8× (`ci-pr.yml:210`) | `node-version-file: .nvmrc` (`setup-toolchain/action.yml:44-47`) | `node-version-file: .nvmrc` (`setup/action.yml:14-18`) |
| `@types/node` | n/a captured | `^25` vs Node 24 runtime (`packages/baselines/package.json:25`) | n/a captured |
| `engine-strict` (`.npmrc`) | absent (`package.json:7-10`) | absent (no `.npmrc`) | absent (no `.npmrc`) |

**Unjustified variances:**

- **Node major: domio is one major behind (22 vs 24).** No corpus evidence ties domio to a Node-22-only dependency; this is drift, not a deliberate constraint. It forces three different `compatibility`/runtime surfaces and means a shared CI/composite-action template cannot assume one Node line.
- **pnpm: domio on 10.26.2 vs the other two on 11.5.2.** Three-way override-placement divergence follows from this (see 4.5).
- **Turbo specifier skew (`^2.9.17` / `^2.9.16` / `^2.3.3`).** All resolve to ~2.9.x, but swarm-os's `^2.3.3` floor is far looser and is pure neglect — it permits a much older Turbo than is actually installed.
- **CI Node resolution: domio floats `node-version:"22"` while the other two read `.nvmrc`.** domio's own audit flags this: CI/the production Cloudflare deploy can run any 22.x patch, "undermining the value of the exact pin" (`ci-pr.yml:210`).
- **No repo enforces `engine-strict`** — the engines field is advisory in all three.

**Convergence target:** **athportal's runtime baseline wins** — Node `24`, pnpm `11.5.2`, lockfileVersion `9.0` — with two corrections applied uniformly:
1. **Pin Node to an exact patch** (domio's exact-pin discipline at `.nvmrc:1` is the better pattern; athportal/swarm-os only pin bare major). Set `.nvmrc` and `engines.node` to the same `24.x.y` in all three and resolve CI via `node-version-file: .nvmrc` everywhere — this fixes domio's floating-`"22"` gap in the same stroke.
2. **Add `.npmrc` with `engine-strict=true`** to all three so the pins become load-bearing locally, not just in CI.
domio should migrate Node 22→24 and pnpm 10.26.2→11.5.2; swarm-os should tighten the Turbo floor to match athportal's `^2.9.16`.

### 4.2 Lint / Format / Test-Standard Drift

| Dimension | domio | athportal | swarm-os |
|---|---|---|---|
| Lint stack | ESLint `--max-warnings=0` + dependency-cruiser; **Prettier separate** (`ci-pr.yml:220-248`; pre-commit only) | Biome + ESLint + markdownlint + route-href (`quality.yml:155-164`) | Biome `check` + Biome `format:check` + ESLint + markdownlint (`ci.yml:67-88`) |
| Format enforcement | Prettier `--check` **pre-commit hook only, not in CI** (`.husky/pre-commit:14-30`) | Biome (folded into lint job) | Biome `format:check` **as a CI step** (`ci.yml:67-88`) |
| Coverage gate | ratchet vs `baselines/coverage.json` (`ci-pr.yml:301-318`) | ratchet `coverage:check` ADR-015 (`quality.yml:264-274`) | ratchet `baselines:check`, **no hard vitest thresholds** (`vitest.config.ts:40-41`, `.c8rc.cjs:13-25`) |
| Mutation testing | Stryker, `workflow_dispatch` only — **docs claim a nightly that doesn't exist** (`mutation-test.yml:3-4`) | Stryker in `nightly.yml` (`nightly.yml`) | Stryker in `nightly.yml`, floor score 100 (`nightly.yml:91-135`) |
| TS strict base | strict + `noUncheckedIndexedAccess` (`tsconfig.base.json:1-30`); **apps/web disables it** (211 suppressed, Story #1472) | strict + `noUncheckedIndexedAccess` (`tsconfig.base.json:3-16`) | strict + `noUncheckedIndexedAccess` (`tsconfig.base.json:1-19`) |

**Unjustified variances:**

- **domio still runs ESLint+Prettier; athportal/swarm-os are Biome-first.** The Prettier formatter is the sharpest drift: domio enforces formatting **only** in a bypassable pre-commit hook with **no CI backstop**, and domio's own audit calls this a "known fragility" that can "taint epic close-validation" (`.husky/pre-commit:14-30`). swarm-os, by contrast, runs `format:check` as a CI step (`ci.yml:67-88`).
- **Mutation cadence is three different shapes:** domio dispatch-only (with a phantom "nightly" referenced in `ci-pr.yml:52-53` that no workflow implements), athportal nightly, swarm-os nightly. domio's documented-but-absent nightly is a correctness bug, not a preference.
- **Coverage thresholding differs:** swarm-os has *no* hard vitest/c8 thresholds and leans purely on the baseline ratchet (`vitest.config.ts:40-41`), where domio and athportal both run explicit `coverage:check` gates. swarm-os's is the weakest of the three.
- **domio's `apps/web` disables `noUncheckedIndexedAccess`** (211 suppressed errors, "TEMPORARY" per Story #1472) — a strictness regression the other two do not carry.

**Convergence target:** **Biome-first wins** — adopt athportal/swarm-os's Biome stack and retire domio's standalone Prettier. swarm-os contributes the format-as-CI-step pattern (`ci.yml:67-88`), which must be uniform so formatting is enforced server-side in all three. **Mutation testing should be nightly in all three** (athportal/swarm-os pattern); domio must either add the cron to `mutation-test.yml` or stop claiming one. Coverage should keep a real `coverage:check` gate (domio/athportal pattern) in addition to the ratchet — swarm-os should adopt it. domio must complete Story #1472 so all three honor `noUncheckedIndexedAccess` uniformly.

### 4.3 CI Structure Drift

| Dimension | domio | athportal | swarm-os |
|---|---|---|---|
| Topology | split: `ci-pr.yml` (7 tiers) + 5 ancillary workflows (`ci-pr.yml:56-138`) | monolithic `quality.yml` (1635 lines, ~16 jobs) + 6 workflows (`quality.yml:36-1634`) | lean `ci.yml` (5 parallel jobs) + 3 workflows (`ci.yml:56-180`) |
| Single-required-check pattern | `ci-required` aggregator (`ci-pr.yml:493-517`) | per-job + sharded roll-up (`quality.yml:1064-1098`) | 5 direct required contexts (`main-protection.json:1-17`) |
| Runner | self-hosted `domio-runner` for PR; ubuntu for deploy (`ci-pr.yml:67`) | self-hosted `athportal-runner` (single pool) (`quality.yml:144`) | **all ubuntu-latest** (`ci.yml:59`) |
| Caching | **no remote/portable cache** — warm self-hosted store only (`turbo.json:1-60`) | **Turbo remote cache** `TURBO_TOKEN`/`TURBO_TEAM` (`quality.yml:23-25`) | **no remote cache**, setup-node pnpm cache only (`turbo.json:1-31`) |
| Per-job timeouts | explicit everywhere (`ci-pr.yml:68,149,...`) | explicit everywhere (`quality.yml:69,145,...`) | **NONE anywhere** — 6h default (`grep timeout-minutes → none`) |
| Composite-action reuse | composite `setup-pnpm-node` | composite `setup-toolchain` | composite `setup` exists but **deploy/nightly inline-duplicate it** (`deploy-staging.yml:46-56`) |

**Unjustified variances:**

- **Three different CI topologies** (split / monolithic / lean) for what the brief says should be uniform repos. The monolith (athportal, 1635 lines) and the fully-split set (domio) are opposite extremes; swarm-os's lean 5-job fan-out is the most legible.
- **Caching is incoherent across all three:** only athportal has Turbo remote cache. domio's own audit flags that disabling all caching makes CI "depend entirely on the persistent runner's warm store staying healthy" (`turbo.json:1-60`); swarm-os has no remote cache and reinstalls Playwright chromium every run (`ci.yml:170`).
- **swarm-os has zero `timeout-minutes`** — a real reliability defect (a hung `pnpm dev` boot inherits the 6h default), where both other repos set per-job timeouts uniformly.
- **swarm-os duplicates its own composite setup** in deploy/nightly instead of reusing `./.github/actions/setup`.

**Convergence target:** **swarm-os's lean 5-job fan-out is the structural target** (Static / Security / Tests+baselines / Build / E2E) — it maps 1:1 to required checks and is the most maintainable. athportal's 1635-line monolith should be decomposed toward it; domio's over-split set should be consolidated. Uniformly adopt:
- **athportal's Turbo remote cache** (`TURBO_TOKEN`/`TURBO_TEAM`, `quality.yml:23-25`) in all three so CI throughput stops depending on a single warm runner.
- **Per-job `timeout-minutes` on every job** (domio/athportal pattern) — swarm-os's outright gap.
- **Single composite setup action, reused everywhere** including deploy/nightly (fix swarm-os's inline duplication).
Runner choice (self-hosted vs ubuntu) is the one *justified* divergence — athportal/domio deliberately keep Playwright self-hosted to avoid GitHub-minute billing; do not converge that.

### 4.4 Security-Tooling Presence Drift

| Tool | domio | athportal | swarm-os |
|---|---|---|---|
| SAST / CodeQL | **absent** (`grep codeql → none`) | present but **gated to public repo → no-op on private** (`codeql.yml:38`) | **absent** (`grep codeql → none`) |
| PR secret scan | gitleaks, **active** every PR (`ci-pr.yml:144-166`) | gitleaks-pr **gated to public → green no-op on private** (`quality.yml:1500-1534`) | secretlint (CI) + TruffleHog (`ci.yml:90-121`) |
| Push/scheduled secret scan | **none** (PR-only) | full-history `secret-scan-push.yml` + nightly TruffleHog | nightly TruffleHog only |
| Secret-scanner choice | gitleaks + secretlint | gitleaks + secretlint + TruffleHog | secretlint + TruffleHog (**no gitleaks**, `no .gitleaks.toml`) |
| CVE gate | `pnpm audit` **fixable-only** (`audit-fixable-gate.mjs`) | `pnpm audit --prod` blocks High/Crit + allowlist (`audit-check.mjs`) | `pnpm audit --prod` blocks High/Crit + self-expiring allowlist (`audit-check.mjs`) |
| Dep automation | **none** (no dependabot/renovate, `ci-pr.yml`) | Renovate (`renovate.json`) | Renovate (`renovate.json`) |
| Security HTTP headers | strong: `_headers` + SSR CSP nonce (`public/_headers`, `cspMiddleware.ts:75-100`) | **none** (no CSP/HSTS/headers, `index.ts:134-385`) | **none** (no CSP/HSTS/headers, `app.ts:65-178`) |

**Unjustified variances:**

- **No repo has working SAST.** domio/swarm-os have none; athportal has a `codeql.yml` that is a no-op on the private repo. This is a uniform High gap, but the *shape* differs needlessly.
- **PR secret-scanning effectiveness is three-way inconsistent:** domio's gitleaks actually runs on every PR; athportal's gitleaks-pr is a **required check that passes green without scanning** on the private repo; swarm-os uses secretlint+TruffleHog with no gitleaks at all. Same threat, three coverage levels.
- **CVE-gate severity differs:** domio blocks only *fixable* High/Critical (unfixable = log-only); athportal/swarm-os block *all* unsuppressed High/Critical in the prod graph. domio's is materially weaker.
- **domio has no dependency-update automation** while the other two run Renovate — pure drift, and domio's audit flags it as a High risk (pinned SHAs and the tree drift with no update PRs).
- **Security headers are inverted:** domio ships strong platform headers (CSP nonce, HSTS, X-Frame-Options); athportal and swarm-os ship **none**, violating their own `security-baseline.md` (`§ Transport & Headers`).

**Convergence target:** Cherry-pick the strongest per control — no single repo is the winner here:
- **Secret scanning:** domio's *unconditional* PR gitleaks (`ci-pr.yml:144-166`) is the model; athportal/swarm-os must add a **private-repo-capable PR secret gate** (athportal's gitleaks-pr is a green no-op today). Add full-history push scan (athportal's `secret-scan-push.yml`) in all three.
- **CVE gate:** athportal/swarm-os's "block all unsuppressed High/Critical in prod graph + dated allowlist" (`audit-check.mjs`) is stricter and should replace domio's fixable-only gate.
- **Dependency automation:** athportal/swarm-os's Renovate (`renovate.json`, 3-day `minimumReleaseAge`) — domio must adopt it.
- **Security headers:** **domio's `_headers` + SSR CSP middleware is the target**; athportal and swarm-os must add CSP/HSTS/X-Frame-Options/X-Content-Type-Options to satisfy the shared `security-baseline.md`.
- **SAST:** add a real (non-visibility-gated) CodeQL run uniformly, or document a deliberate skip in all three.

### 4.5 Dependency-Override Placement Drift

| Dimension | domio | athportal | swarm-os |
|---|---|---|---|
| Override location | `package.json#pnpm.overrides` (26 entries) (`package.json:116-144`) | `pnpm-workspace.yaml` (8 entries) (`pnpm-workspace.yaml:40-80`) | `pnpm-workspace.yaml` (1 entry) (`pnpm-workspace.yaml:101-102`) |
| Rationale | "stay in package.json on pnpm 10.x" (`pnpm-workspace.yaml:5-11`) | pnpm 11 native | pnpm 11 native |
| Patches | none | `patches/oxc-parser` (`pnpm-workspace.yaml:102-103`) | none |

This divergence is a **direct consequence of the pnpm version drift in 4.1** — domio is on pnpm 10 (where `package.json#pnpm` shadows workspace overrides) and explicitly documents the intent to move on pnpm 11. The MEMORY note confirms the house style: pnpm 11 ignores `package.json` `pnpm.overrides`; overrides/`allowBuilds`/`patchedDeps` belong in `pnpm-workspace.yaml`.

**Convergence target:** **`pnpm-workspace.yaml` (athportal/swarm-os pattern) wins.** Once domio upgrades to pnpm 11.5.2 (per 4.1), migrate its 26-entry override block out of `package.json#pnpm.overrides` into `pnpm-workspace.yaml`, matching the documented house style. This is one of the few divergences with an explicit, dated migration intent already in domio's own config.

### 4.6 Deploy-Strategy & Web-Adapter Drift

| Dimension | domio | athportal | swarm-os |
|---|---|---|---|
| Web deploy target | Worker (Astro SSR, `wrangler deploy`) (`wrangler.jsonc:10-16`) | **Worker** (migrated off Pages, #1982) (`deploy-staging.yml:197-206`) | **Pages** (`wrangler pages deploy`) (`apps/web/wrangler.jsonc:1-15`) |
| Config format | single `wrangler.jsonc`, named envs | `wrangler.toml` per app, named envs | `wrangler.toml` (api) + `wrangler.jsonc` (web) |
| Promotion | staging auto / prod manual | staging auto / prod manual | staging auto / prod manual |
| Prod gate | typed `confirm` + ref-guard; **reviewer unenforceable** (Free) (`deploy-production.yml:41-42`) | `production` env reviewer + **isolation-audit job** (`deploy-production.yml:53-72`) | manual dispatch only; **no reviewer** (Free) (`deploy-production.yml:1-13`) |
| Post-deploy smoke | gated off by default (`PROD_SMOKE_ENABLED`) (`deploy-production.yml:140-148`) | **boot-smoke present** (`smoke-deploy.sh`, `deploy-staging.yml:224-234`) | **none** (manual curl in runbook only) (`deploy.md:102-114`) |
| `compatibility_date` | `2026-04-21` (`wrangler.jsonc:11-12`) | **stale `2025-01-01`** vs wrangler `^4.105.0` (`wrangler.toml:20`) | `2026-06-18` (`wrangler.toml:15-23`) |
| Secret source | Infisical → GH/CF (`environments.md`) | Infisical → GH (`deploy-staging.yml:79-84`) | **GH Environments only, no Infisical** (`grep infisical → none`) |
| Migrate→deploy | staging migrate w/ host-guard (`deploy-staging.yml:421-443`) | migrate w/ wrong-workspace guard (`deploy-production.yml:186`) | migrate, **no guard, no backup** (`deploy-production.yml:55-56`) |

**Unjustified variances:**

- **swarm-os is the only repo still on Cloudflare Pages for web** — domio and athportal both deploy web as Workers (athportal explicitly migrated, #1982). This is the single biggest deploy-architecture divergence and drives downstream rollback-doc drift.
- **Post-deploy verification is three-way inconsistent:** athportal has a real boot-smoke that fails the run on non-200; domio gates its smoke off by default; swarm-os has none. All three audits flag the resulting "broken deploy ships green" as High.
- **Prod human-gate strength differs** because of plan limits, but athportal's **secret-isolation-audit job** (`deploy-production.yml:53-72`) is a uniquely strong, plan-independent guard the other two lack entirely.
- **`compatibility_date` skew (2026-04-21 / 2025-01-01 / 2026-06-18)** — athportal's is stale by over a year against wrangler `^4.105.0`, a real runtime-semantics divergence.
- **Secret injection: only swarm-os lacks Infisical** (GH Environments only) — drift from the shared two-repo pattern.

**Convergence target:** **Worker web deploy (domio/athportal) wins** — swarm-os should migrate off Pages to match (this also un-drifts its rollback runbook). Uniformly adopt:
- **athportal's boot-smoke** (`smoke-deploy.sh`) **and secret-isolation-audit job** as the deploy template across all three.
- **A single wrangler config convention** — pick one of `.toml`/`.jsonc` and apply it to both apps in all three (athportal itself mixes formats).
- **Advance every `compatibility_date`** to a recent shared value and add a Renovate rule to keep it in step with wrangler.
- **Migrate-step guard + pre-migration snapshot** uniformly (athportal/domio have guards of varying correctness; swarm-os has none).

### 4.7 Docs-Naming & Runbook Drift

| Dimension | domio | athportal | swarm-os |
|---|---|---|---|
| Env doc filename | `docs/environments.md` (plural) | `docs/environments.md` (plural) | **`docs/environment.md` (singular)** (`environment.md:9-17`) |
| Stale runbook set | duplicate `.github/RUNBOOKS/` contradicts canonical `docs/runbooks/` (`.github/RUNBOOKS/rollback.md:5-37`) | rollback.md targets vestigial Pages dashboard (`rollback.md:154-164`) | branch-protection prose cites never-built `quality.yml` + gitleaks (`branch-protection-setup.md:32-35`) |
| Branch-protection runbook | n/a captured | refs stale job names + `secretlint` required-but-absent (`main-protection.json:4-22`) | prose cites `quality.yml` (never built); JSON correct (`branch-protection-setup.md:38-44`) |
| Incident-response runbook | only stale generic `.github/RUNBOOKS/` copy | **none dedicated** (`rollback.md:245-289`) | **none dedicated** (`deploy.md:116-156`) |
| SLO / error-budget doc | none | none | none |

**Unjustified variances:**

- **swarm-os uses singular `environment.md`** where domio and athportal both use plural `environments.md`. Trivial but real naming drift across what should be a uniform doc set.
- **All three carry CI-vs-docs drift, but of different shapes:** domio has a contradictory duplicate `.github/RUNBOOKS/` tree (wrong rollback model); athportal's `main-protection.json` lists job names that no longer match the workflow plus a `secretlint` required-check with no CI job (blocks every PR `pending` forever); swarm-os's branch-protection prose references a `quality.yml` that was never built (it shipped as `ci.yml`). These are independent drifts that a uniform "reconcile required-checks against live job names" pass would fix in all three.
- **None of the three has a dedicated incident-response runbook or any SLO/error-budget doc** — a uniform gap.

**Convergence target:** **Plural `docs/environments.md` wins** (domio/athportal) — rename swarm-os's. Apply one uniform remediation across all three: **reconcile each repo's `main-protection.json` / branch-protection prose against its live workflow job names in a single PR** (fixing athportal's phantom `secretlint` required-check, swarm-os's phantom `quality.yml`, and removing domio's contradictory `.github/RUNBOOKS/` duplicate). Add a thin shared **incident-response runbook template** and a minimal **SLO doc** (uptime targets on the health endpoints) to all three, since the absence is uniform.

---

## 5. Gap Analysis & Security Vulnerabilities (Grouped by Severity: High/Medium/Low)

The three repos are meant to be uniform Mandrel-framework siblings, so most findings below are shared drift. Blast radius is judged by how many of the three are affected and how exposed the gap is.

### High

**SAST (CodeQL) is absent from all three repos.** No CodeQL or any static application security testing exists anywhere — secret scanning and dependency CVE audits are the only automated security gates, leaving code-level vulnerability classes (injection, taint flows, unsafe deserialization, path traversal) entirely uncovered on every PR and on main.
- **Affected:** domio, athportal, swarm-os (all three).
- **Evidence:** domio `.github/workflows/` (no codeql.yml; grep returns nothing), `docs/path-to-prod.md:54,308`; athportal `.github/workflows/codeql.yml:38` (gated on `repository.visibility == 'public'` → no-op on private repo), `docs/decisions/0020-...md:7,23`; swarm-os `.github/workflows/` (no codeql.yml), `docs/roadmap.md:61`.
- **Remediation:** Add an identical SHA-pinned `github/codeql-action` workflow (`javascript-typescript`) to all three, triggered on `pull_request` + push to main + a weekly schedule. athportal already has the workflow file but is gated to public repos — remove the visibility gate or run CodeQL via Actions (available on private repos through GitHub-hosted runners) so the scan actually executes; for the others, copy the same workflow. Wire it into branch protection once green.

**PR-time secret scanning and SAST are no-ops on the private repos, yet a secret gate is marked required.** The PR-blocking secret scan only runs when the repo is public, so on the current private repos the required check passes green without ever scanning the diff. A secret committed in a PR is caught only post-merge (signal-only / continue-on-error) or nightly — never at the gate that can block the merge.
- **Affected:** athportal (most acute — `gitleaks-pr` is a *required* check that no-ops), swarm-os (CI security gates codified but branch protection not applied, so unenforced), domio (gitleaks runs but only on `pull_request` — no push/scheduled/full-history scan, so an admin-bypass push to main is never CI-scanned).
- **Evidence:** athportal `.github/workflows/quality.yml:1500-1534` (visibility gate + TODO at 1506-1508), `codeql.yml:38`; swarm-os `docs/runbooks/branch-protection-setup.md` (codified, not applied; free private plan returns 403), `.husky/pre-push:3-5`; domio `.github/workflows/ci-pr.yml:3-5` (pull_request only), `deploy-production.yml`/`deploy-staging.yml` (no secret-scan step).
- **Remediation:** Add a private-repo-capable PR secret scan to all three that *actually runs* regardless of visibility: invoke the pinned gitleaks binary with a cross-platform (darwin/linux) asset selector, or wire the in-repo `pnpm run lint:secrets` / secretlint over the PR diff as a required check. Independently, enable GitHub native secret scanning + push protection as a trigger-independent backstop, and add a `push`-to-main full-history gitleaks run so admin-bypass pushes are still scanned.

**No post-deploy health gate or automated rollback on a bad production deploy.** A successful `wrangler deploy` proves upload, not boot — and across the repos a broken production deploy goes green and serves live traffic with no automatic abort or revert. Recovery is entirely manual via `wrangler rollback`.
- **Affected:** swarm-os (no post-deploy smoke in either deploy workflow at all), domio (prod smoke gated off by default via `PROD_SMOKE_ENABLED`, and even when on it does not trigger rollback), athportal (boot-smoke exists on staging only, after the deploy is already live, with no auto-rollback).
- **Evidence:** swarm-os `.github/workflows/deploy-staging.yml`/`deploy-production.yml` (no curl/health/smoke step), `docs/runbooks/deploy.md:102-114`; domio `.github/workflows/deploy-production.yml:140-148,152-172`; athportal `.github/workflows/deploy-staging.yml:209-234`, `scripts/smoke-deploy.sh:61-73`.
- **Remediation:** Uniformly add a post-deploy health-check step to both deploy workflows in all three repos that curls the deployed front door (web `/` or `/status` → 200, api `/health` or `/api/v1/health` → 200) with retry/backoff and fails the run on non-2xx; on failure, auto-invoke `wrangler rollback` (and `wrangler pages deployment rollback` where Pages is still used). athportal already has `scripts/smoke-deploy.sh` — extend it to run post-prod-deploy and gate rollback on it; domio should flip `PROD_SMOKE_ENABLED` on and make the smoke step blocking + rollback-triggering.

**Production DB migrations are forward-only and applied before deploy with no snapshot/PITR or rollback path.** A bad migration mutates the live schema before any code rollback could help, and there is no tested down-migration or restore procedure — a Worker/Pages rollback reverts code, not schema.
- **Affected:** swarm-os (prod migrate before deploy, no backup), athportal (staging migrates before deploy, no migration rollback path; prod migrate opt-in), domio (staging auto-migrates every deploy; forward-only).
- **Evidence:** swarm-os `.github/workflows/deploy-production.yml:55-56`, `packages/shared/src/db/migrate.ts:1-15`, `docs/runbooks/deploy.md:141-148`; athportal `.github/workflows/deploy-staging.yml:136-150`, `docs/runbooks/rollback.md:125-133`; domio `docs/runbooks/rollback.md:85-125`, `.github/workflows/deploy-staging.yml:421-443`.
- **Remediation:** Uniformly add a pre-migration Turso snapshot/branch step (Turso supports branching + PITR) gating the migrate in both deploy workflows, and adopt an expand-contract/additive-only migration policy so a forward-only apply is always rollback-safe. Document a tested restore runbook in each repo with the same rigor as the existing production code-rollback runbooks (which currently lack the DB story).

**Staging auto-deploys on push to main with no dependency on CI passing.** There is no `needs:` / `workflow_run` gate between the CI workflow and the staging deploy, so a push that races or bypasses CI (easy because branch protection is unenforced on the private repos) can ship straight to staging — including the forward-only migration path above.
- **Affected:** swarm-os (explicitly no gate; branch protection not applied), athportal and domio (staging deploy triggers on push to main; protection is admin-bypassable).
- **Evidence:** swarm-os `.github/workflows/deploy-staging.yml:11-14` (push trigger, no gate), `docs/runbooks/main-protection.json` (codified, not applied); athportal `.github/workflows/deploy-staging.yml:25-33`; domio `.github/workflows/deploy-staging.yml:22-26`.
- **Remediation:** Convert all three staging deploys to trigger on `workflow_run` (CI completed + success on main) instead of raw push, and apply the codified branch protection (upgrade plan or make repos public) so failing CI blocks merge. This is the single cross-repo guard that makes "required checks" actually load-bearing.

### Medium

**No platform-level security HTTP headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy).** This is a direct gap against each repo's own `security-baseline.md` § Transport & Headers. Notably, domio is the *positive* counter-example — it has them — which proves the uniform target and exposes the other two as drift.
- **Affected:** athportal (none on Hono API or Astro web; no `_headers` file), swarm-os (none on Hono API or Astro web; no `_headers` file). domio already satisfies this (static `_headers` + SSR CSP middleware with per-request nonce).
- **Evidence:** athportal `apps/api/src/index.ts:134-385` (no `secureHeaders`), `apps/web/src/middleware.ts` (no header sets), `.agents/rules/security-baseline.md`; swarm-os `apps/api/src/app.ts:65-178`, `apps/web/src/middleware.ts:71`; domio (reference) `apps/web/public/_headers`, `apps/web/src/lib/csp/cspMiddleware.ts:75-100`.
- **Remediation:** Port domio's pattern to athportal and swarm-os: add Hono `secureHeaders()` on the API and an Astro response-header middleware (or a Cloudflare `_headers`/Worker header rule) emitting CSP, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy` across all responses. Standardize on domio's nonce-based CSP builder so all three share one implementation.

**No explicit CORS allowlist middleware on the Hono API.** CORS origin handling is left to framework defaults or scattered per-route, risking an inconsistent or overly-permissive posture; `security-baseline.md` forbids wildcard credentialed CORS and requires an origin allowlist.
- **Affected:** athportal (no `hono/cors`; only per-route Mux corsOrigin), swarm-os (no `hono/cors`; only session + rate-limit middleware). domio's only wildcard is on the CSP-report OPTIONS endpoint (non-credentialed) — acceptable.
- **Evidence:** athportal `apps/api/src/index.ts` (no `hono/cors` import), `apps/api/src/lib/mux.ts:85,246`; swarm-os `apps/api/src/app.ts:80-101`; domio (reference) `apps/web/src/pages/api/csp-report.ts:119-128`.
- **Remediation:** Register `hono/cors` on both API apps with an explicit per-environment origin allowlist (`PUBLIC_SITE_URL`), no wildcard with credentials, and add a contract test asserting disallowed origins are rejected. If same-origin only, document that decision so the absence is intentional.

**No automated dependency-update mechanism in domio; the others rely on Renovate alone with no `dependency-review` / SBOM.** domio has neither Dependabot nor Renovate, so pinned action SHAs and the dependency tree drift and CVEs persist until a manual bump (compounded by the audit gate being fixable-only). athportal and swarm-os have Renovate but no GitHub `dependency-review-action` to flag newly-introduced vulnerable/incompatible deps at diff time, and none of the three generate an SBOM.
- **Affected:** domio (no Renovate/Dependabot at all), athportal + swarm-os (Renovate present, no dependency-review/SBOM).
- **Evidence:** domio `ls .github/dependabot.yml renovate.json` (absent), `ci-pr.yml:239-248` (fixable-only); athportal `renovate.json`, `.github/workflows/quality.yml:1425-1465`; swarm-os `renovate.json`, `.github/workflows/ci.yml:90-121`.
- **Remediation:** Add the shared `renovate.json` (matching athportal/swarm-os: 3-day `minimumReleaseAge`, grouped weekly, majors gated behind dashboard approval, github-actions manager enabled) to domio. Add `actions/dependency-review-action` to all three PR pipelines and a CycloneDX SBOM generation step for the deployed Worker artifact, so SHA pins and the dep tree get routine update PRs and provenance.

**CI does not honor the exact/declared toolchain pins.** Workflows resolve Node from a floating major rather than the exact pin, undermining reproducibility; engines are advisory because no repo sets `engine-strict`.
- **Affected:** domio (most acute — `engines.node` and `.nvmrc` pin exact `22.19.0` but every workflow uses `node-version: "22"`), athportal + swarm-os (`.nvmrc` is bare major `24`, so CI floats to latest 24.x; no `.npmrc engine-strict`).
- **Evidence:** domio `.github/workflows/ci-pr.yml:210`, `.nvmrc:1`, `package.json:8`; athportal `package.json:7-9`, `.nvmrc`, no `.npmrc`; swarm-os `package.json:6-8`, `.nvmrc:1`, no `.npmrc`.
- **Remediation:** Standardize all three on `node-version-file: .nvmrc`, pin `.nvmrc` to a full patch (e.g. `24.x.y` / `22.19.0`) kept in lockstep with `engines` via Renovate's nvm manager, and add an `.npmrc` with `engine-strict=true` so a wrong Node/pnpm fails fast locally and in CI. domio specifically must replace `node-version: "22"` across all six workflows.

**No turbo remote cache anywhere; caching strategy is fragile or absent.** Build/test/lint artifacts are not shared across parallel tiers or runs, so CI throughput depends on a warm host or pays full cold cost every run, and the deployed bundle is rebuilt rather than promoted from the CI-verified artifact.
- **Affected:** domio (no remote cache + deliberately no actions/cache on the dominant self-hosted runner; prod re-builds), swarm-os (no remote cache, no Playwright browser cache — chromium reinstalled `--with-deps` every run, no `env`/`globalEnv` in turbo.json so env changes don't invalidate the local cache). athportal is the positive case (Turbo remote cache via `TURBO_TOKEN`/`TURBO_TEAM`).
- **Evidence:** domio `turbo.json:1-57` (no remoteCache), `ci-pr.yml:211-212`, `deploy-production.yml:91`; swarm-os `turbo.json:1-31` (no remoteCache/env), `.github/workflows/ci.yml:170`, `nightly.yml:75`; athportal (reference) `.github/workflows/quality.yml:23-25`.
- **Remediation:** Adopt athportal's Turbo remote cache (`TURBO_TOKEN` secret + `TURBO_TEAM` var, or a self-hosted cache) uniformly so artifacts survive runner resets and are shared across tiers, and have the deploy step reuse the CI-built Worker bundle rather than rebuilding (deploy-what-CI-tested). Add a Playwright browser cache keyed on the `@playwright/test` version to swarm-os/domio, and declare build-affecting env vars in each `turbo.json` (`globalEnv`/`env`/`passThroughEnv`) so cache keys account for env changes.

**No job-level `timeout-minutes` in swarm-os; uneven elsewhere.** A hung dev-server boot, wedged Playwright run, or stuck deploy inherits GitHub's 6-hour default, burning runner minutes and delaying feedback.
- **Affected:** swarm-os (no `timeout-minutes` on any job in any workflow). domio and athportal already set per-job timeouts (positive cases worth mirroring).
- **Evidence:** swarm-os grep `timeout-minutes .github/` → none; webServer 120000ms only (`apps/web/playwright.config.ts:69`); domio (reference) `.github/workflows/ci-pr.yml:68,149,176,...`; athportal `.github/workflows/quality.yml:69,145,219,...`.
- **Remediation:** Add `timeout-minutes` to every job in all three workflow sets using the domio/athportal bands (~10-15 static/security/tests/build, ~20-45 e2e/acceptance, tight bounds on mutation and both deploy jobs).

**Migration-label-guard scans the wrong path / is a substring match.** The destructive-migration policy is effectively unenforced or weakly enforced.
- **Affected:** athportal (guard scans `apps/api/**/migrations/**` but migrations live in `packages/shared/src/db/migrations/` — a destructive DROP/RENAME passes unflagged), domio (guard works but the staging host assertion is a substring match on the URL, not a true env assertion). swarm-os has no migration guard at all.
- **Evidence:** athportal `scripts/migration-label-guard.mjs:18-19`, `packages/shared/src/db/migrations/0000_auth_and_rbac.sql`; domio `.github/workflows/migration-guard.yml:1-42`, `deploy-staging.yml:421-435`; swarm-os grep migration-guard → none.
- **Remediation:** Fix athportal's path predicate to `packages/shared/src/db/migrations/` and add a unit test that a destructive change there is flagged; add the same migration-label-guard workflow to swarm-os; strengthen domio's staging/prod host guards to an exact-host allowlist (and a symmetric prod guard asserting the host is not staging/dev) rather than a substring check. Standardize one guard implementation across all three.

**Observability is decided but not wired, and documented signal overstates reality.** Production incidents have weak or no automated detection, and runbooks claim signal paths that are inert.
- **Affected:** swarm-os (Sentry inert/no account, no AE/Logpush/Tail bindings despite docs claiming AE is bound — effectively zero production telemetry), athportal (Better Stack uptime IaC never applied by any workflow and its monitor URLs are non-resolvable placeholders), domio (server-side Sentry SDK is a no-op on Workers so `logger.error`→Sentry captures never reach Sentry, yet runbooks present it as the primary triage source; no Logpush/AE/Tail bindings).
- **Evidence:** swarm-os `apps/api/wrangler.toml:1-48` (no bindings), `docs/environment.md:72-78`, `docs/runbooks/deploy.md:182-183`; athportal `infra/uptime/betterstack.yml:24-49`, `infra/uptime/README.md:6-8`; domio `apps/web/sentry.server.config.ts:1-16`, `apps/web/src/utils/logger.ts:29-62`, `apps/web/wrangler.jsonc:17-19`.
- **Remediation:** Uniformly (1) add a CI/manual apply workflow for the Better Stack uptime IaC with real `*.dsj1984.workers.dev` (or custom-domain) URLs and a `--dry-run` drift check on PRs — fixing athportal's placeholder hosts; (2) add an `analytics_engine_datasets` binding + `logpush: true` (and/or a tail consumer) to every Worker wrangler config for durable, queryable log retention; (3) wire a Workers-compatible server capture (`@sentry/cloudflare`/Toucan) so server-side captures actually reach Sentry, and correct the runbooks/ADRs that overstate the current signal. swarm-os must additionally reconcile `environment.md`'s false "AE is bound" claim.

**`GIT_COMMIT_SHA` is never injected at deploy time in domio despite docs claiming it is.** Synthetic alerts and Sentry events cannot be correlated to the deployed commit, and the documentation is inaccurate.
- **Affected:** domio.
- **Evidence:** `.github/workflows/deploy-production.yml:134-138`, `deploy-staging.yml:445-446`, `apps/web/wrangler.jsonc:296-299,450-451`, `docs/environments.md:205`.
- **Remediation:** Add `--var GIT_COMMIT_SHA=${{ github.sha }}` to both `wrangler deploy` steps (and adopt the same release-tagging discipline athportal uses), or correct the docs. Confirm the synthetic monitor/Sentry actually reads the value.

### Low

**Husky hooks are non-reproducible and/or not fail-fast, and all hooks are bypassable with `--no-verify`.** Local secret/quality gates are the only enforcement on the private repos (CI gates being unenforced per the High findings), so degraded hooks widen the real gap.
- **Affected:** athportal (most acute — husky is not a declared dependency, `prepare` doesn't install it, so a fresh clone runs *no* pre-commit gate; `.husky/pre-commit` also lacks `set -e`), swarm-os (`.husky/pre-commit` and `commit-msg` lack `set -e`, unlike pre-push), domio (hooks present and reasoned, but bypassable like all three).
- **Evidence:** athportal `package.json:65`, `node_modules/.bin/husky` absent, `.husky/pre-commit:27`; swarm-os `.husky/pre-commit:1-11`, `.husky/commit-msg:1`; domio `.husky/pre-commit:1-32`, `.husky/pre-push:1-39`.
- **Remediation:** Uniformly add `husky` as a devDependency and run it in `prepare` (athportal), and add `set -e` to `pre-commit` and `commit-msg` to match `pre-push` in all three. Accept that hooks are bypassable by design — the real fix is closing the CI-side enforcement gap (High findings), with hooks as the fast local mirror.

**Full-repo secretlint is never invoked in CI; format/contract gates are local-only.** Several ratchets enforced in pre-push/pre-commit have no CI backstop, so a `--no-verify` push (or non-reproducible hook) can regress them.
- **Affected:** athportal + swarm-os (`lint:secrets`/secretlint script exists but no workflow runs it), domio (prettier `--check` and `contract-coverage` + `lint-baseline` ratchets run only in husky, not CI).
- **Evidence:** athportal `package.json:20`, no `lint:secrets` match in `.github/workflows/*.yml`; swarm-os `package.json:26` (runs in CI — positive), used as the pattern; domio `.husky/pre-commit:14-30`, `.husky/pre-push:35-37`, `ci-pr.yml` static job (no prettier/contract step).
- **Remediation:** Add a `pnpm run lint:secrets` step to athportal's quality.yml (swarm-os already does this — mirror it), and add `prettier --check .` + `contract:check` + the lint-baseline ratchet to domio's CI static/unit tier so the full locally-enforced ratchet set is also server-side enforced across all three.

**`.gitignore` lacks generic credential-file patterns.** Increases the chance a key file is accidentally staged, with only the (degraded) local secretlint hook as a catch.
- **Affected:** athportal (covers `.env*` but not `*.pem`/`*.key`/`*.p12`/`id_rsa`/`*credential*`); recommend applying uniformly to all three.
- **Evidence:** athportal `.gitignore:25-34`.
- **Remediation:** Add defensive patterns (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `*credentials*`) to `.gitignore` in all three repos as a low-cost backstop.

**`compatibility_date` is stale relative to the wrangler version in athportal.** A stale date freezes workerd runtime semantics behind the tooling and risks subtle local-vs-deployed divergence.
- **Affected:** athportal (`2025-01-01` vs wrangler `^4.105.0`). domio (`2026-04-21`) and swarm-os (`2026-06-18`) are current — the uniform target.
- **Evidence:** athportal `apps/api/wrangler.toml:20`, `apps/web/wrangler.toml:43`, `pnpm-workspace.yaml:34`.
- **Remediation:** Advance athportal's `compatibility_date` to a recent date (re-validate via the existing `check:worker-bundle:startup` workerd boot probe), and add a Renovate rule / recurring task across all three to keep `compatibility_date` roughly in step with wrangler upgrades.

**No artifact upload on the PR path in swarm-os.** Debugging an e2e failure requires local re-run because trace/report output is discarded.
- **Affected:** swarm-os (ci.yml uploads no artifacts; nightly does). domio and athportal retain reports — mirror them.
- **Evidence:** swarm-os `.github/workflows/ci.yml:159-179` (no upload-artifact), contrast `nightly.yml:82-89`.
- **Remediation:** Add an `if: failure()` `upload-artifact` step to the e2e job for `apps/web/playwright-report` and the trace dir (short retention) in swarm-os, matching the nightly/sibling-repo pattern.

**Cron trigger may not be attached to athportal's deployed Workers.** Per wrangler's non-inheritance rule (which the file relies on for `[define]`/`[vars]`), the `*/5` cron declared only at top level may not apply to `athportal-api-staging`/`-production`, so the video-pipeline reconciler `scheduled` handler could never fire.
- **Affected:** athportal.
- **Evidence:** `apps/api/wrangler.toml:110-111`, `apps/api/wrangler.toml:54-58`.
- **Remediation:** Verify against a deployed Worker; if absent, re-declare `[env.staging.triggers]` / `[env.production.triggers]` crons explicitly (mirroring the per-env define/vars/analytics pattern already used).

**Documentation drift contradicts deploy/rollback reality across all three.** Operators following stale runbooks under incident pressure would execute wrong, slower procedures.
- **Affected:** all three. domio (deploy-promotion.md promises a "required reviewer" gate that is unenforceable on Free+private; stale duplicate `.github/RUNBOOKS/` teaches git-revert rollback vs the real `wrangler rollback`; architecture.md describes the retired auto-deploy job; post-deploy-smoke.md uses dead `domio.com/sign-in` URLs), athportal (tech-stack.md/architecture.md still call web "Cloudflare Pages" post-#1982; rollback.md Path A still points at the vestigial Pages dashboard), swarm-os (branch-protection-setup.md references a never-built `quality.yml` and a gitleaks scanner the pipeline doesn't use; main-protection.json is correct).
- **Evidence:** domio `docs/runbooks/deploy-promotion.md:11,49` vs `docs/environments.md:47-52`, `.github/RUNBOOKS/rollback.md:5-37`, `docs/architecture.md:1250-1266`, `docs/runbooks/post-deploy-smoke.md:15-19`; athportal `docs/tech-stack.md:18`, `docs/architecture.md:37,123`, `docs/runbooks/rollback.md:154-164`; swarm-os `docs/runbooks/branch-protection-setup.md:32-44`.
- **Remediation:** Reconcile each repo's deploy/rollback/architecture docs to the live Worker-based, manual-dispatch reality in one pass: correct the unenforceable reviewer-gate language, delete or repoint the stale `.github/RUNBOOKS/` set (domio), update Pages→Workers references (athportal), and align branch-protection prose to the real `ci.yml`/`quality.yml` job names so no doc instructs marking a non-existent required check (which would block every PR forever).

**No availability SLO / error-budget and no dedicated incident-response/postmortem runbook.** Rollback "when observability says the build is bad" has no quantitative trigger, and a first-time on-call has no single incident entry point (severity rubric, escalation, postmortem template).
- **Affected:** athportal and swarm-os (no SLO doc, no incident-response runbook — handling is scattered across rollback/observability docs). domio has on-call/error-budget basics documented but no standalone incident runbook either.
- **Evidence:** athportal `docs/runbooks/rollback.md:20-31` (qualitative only), no SLO doc; swarm-os `docs/runbooks/deploy.md:130,150`, `docs/roadmap.md:44`; domio `docs/runbooks/observability-runbook.md:89-104`, `.github/RUNBOOKS/incident-response.md:1-36` (stale, unreferenced).
- **Remediation:** Add a shared thin `incident-response.md` runbook to all three (severity rubric, the single email-distribution-list escalation path, rollback decision order linking the existing rollback runbook, and a blameless postmortem stub) plus a short SLO section defining an availability target for the health-probed surfaces, tied to the rollback "when to roll back" triggers. Defer paging-tier work uniformly per the MVP posture.

---

## 6. Standing Up `mandrel-platform`

Every "shared / centralize / publish" recommendation above lands in **one new repository + npm package, `mandrel-platform`** — deliberately *separate* from the `mandrel` AI-harness framework. The two have different audiences (agents vs. operators), different release cadences, and different blast radius on a bad release; a non-AI repo could adopt `mandrel-platform` without ever touching `mandrel`. This section is the concrete setup. It is the home for the cutover waves (§7) and the delivery vehicle for unification opportunities §3.1–§3.10.

### 6.1 Ownership boundary

| Concern | Owner | Why |
|---|---|---|
| Personas, skills, orchestration, ticket lifecycle, `.agents/` protocol | **`mandrel`** (existing) | Governs *agent behavior*; coupled to how you run the harness. |
| Reusable CI workflows, composite setup action, Cloudflare deploy workflow, CodeQL workflow | **`mandrel-platform`** | Governs *delivery*; consumed by any repo that ships, AI-driven or not. |
| Shared `tsconfig.base.json` / biome base, CVE-gate + audit scripts, `main-protection.json` contract + its lint, catalog/override conventions | **`mandrel-platform`** | Platform config, not agent protocol. |
| Renovate preset | **`mandrel-platform`** | Consumed cross-repo via `github>`. |
| **Common, process-level runbooks** (incident-response, rollback *process*, deploy-promotion *process*, secret-rotation, dependency-update, branch-protection setup, backup/restore *process*, observability) | **`mandrel-platform`** `docs/runbooks/` | They describe *operating the delivery system*, are substantially identical across repos, and are **referenced** (linked) by each project rather than copied. |
| Per-project `docs/environments.md`, and any runbook carrying project-specific values (worker/DB names, URLs) or feature/integration steps | **each project** | Environment values and feature steps are project-specific; a thin local doc may hold the values and **link** to the common process runbook. |

**Documentation split (the rule).** Each project keeps its **own** `docs/environments.md` and all project-specific documentation (feature runbooks, integration setup, persona/seed SOPs). Only *common, process-level* runbooks move to `mandrel-platform/docs/runbooks/` as the single source, and projects **reference** them. Where a common process needs project-specific values, the project keeps a short local doc with those values that links to the canonical runbook — never a full duplicate.

Concrete classification from the current repos:

- **Centralize (common → `mandrel-platform/docs/runbooks/`, referenced):** `rollback`, `deploy-promotion`/`deploy-staging`/`deploy`, `observability-runbook`, `post-deploy-smoke`, `secret-rotation`, `dependency-update-runbook`, `database-backup-restore`, `branch-protection-setup` + `main-protection.json`, `environments-provisioning`, and a new `incident-response` + `slo` (no repo has these yet).
- **Keep local (project-specific):** every `docs/environments.md`; and feature/integration runbooks — domio `advisor-calendar-disconnected`, `appraisal-eval`, `email-deliverability`, `google-cloud-setup`; athportal `clerk-persona-bootstrap`, `csam-provisioning`, `data-rights-sop`, `local-webhook-testing`, `seed-dev-admin`, `observability-redaction`; swarm-os `clerk-setup`, `design-system`, `pii-erasure`, `rate-limiting`.

Agent-facing protocol docs stay in `mandrel`. The physical migration + per-project reference-rewrite is tracked by **MP-9** (§7.3) and adopted per consumer in **F1** (§7.7).

### 6.2 Repository layout

One repo, three distribution channels (see §6.3). Suggested shape:

```text
mandrel-platform/
├─ .github/
│  ├─ workflows/
│  │  ├─ pr-quality.yml          # reusable: workflow_call (lint/typecheck/unit/contract/e2e tiers)
│  │  ├─ deploy-cloudflare.yml   # reusable: workflow_call (build → migrate → deploy → boot-smoke → rollback)
│  │  ├─ codeql.yml              # reusable: SAST, NOT visibility-gated
│  │  └─ release.yml             # SemVer tag + npm publish for this repo
│  └─ actions/
│     └─ setup-toolchain/action.yml   # composite: pnpm + node-from-.nvmrc + frozen install, `cache` input
├─ config/
│  ├─ tsconfig.base.json
│  ├─ biome.base.json
│  └─ renovate.json              # the shared preset (consumed as github> ref)
├─ scripts/
│  ├─ audit-check.mjs            # block all unsuppressed High/Crit in prod graph + dated allowlist
│  ├─ check-required-contexts.mjs# lint: every name in main-protection.json is emitted by a job
│  └─ smoke-deploy.sh            # post-deploy boot-smoke
├─ templates/runbooks/
│  ├─ deploy-promotion.md
│  ├─ rollback.md
│  ├─ incident-response.md
│  ├─ observability.md
│  └─ environments.md
├─ main-protection.json          # canonical branch-protection contract (single required aggregator)
├─ package.json                  # "name": "mandrel-platform"  (or scoped "@mandrel/platform")
└─ CHANGELOG.md
```

The `package.json` `exports` map exposes the config + scripts to npm consumers (`mandrel-platform/tsconfig.base.json`, `mandrel-platform/scripts/audit-check.mjs`); the `.github/` tree is consumed by Git reference, not npm.

### 6.3 Three distribution channels (one repo)

1. **Reusable workflows + composite actions** — consumed via `uses:`, SHA-pinned and Renovate-updatable:
   `uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<sha>`
2. **npm config package** — `mandrel-platform` published to npm (same model as `mandrel` itself); consumers get `tsconfig.base.json`, biome base, and the CVE-gate/lint scripts.
3. **Renovate preset** — `"extends": ["github>dsj1984/mandrel-platform"]` (reads `renovate.json` / a named `:base` preset from the repo; no publish step needed).

### 6.4 What a consumer repo looks like after adoption

A consumer's entire PR-quality CI collapses to a thin caller (athportal's 1,635-line `quality.yml` → ~12 lines):

```yaml
# .github/workflows/ci.yml  (consumer)
name: CI
on:
  pull_request: {}
  push: { branches: [main] }
jobs:
  quality:
    uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<sha>
    with:
      runner: athportal-runner        # or "ubuntu-latest" for swarm-os
      shards: 3
      tiers: lint,typecheck,unit,contract,e2e
    secrets: inherit                  # TURBO_TOKEN/TURBO_TEAM, etc.
```

```yaml
# .github/workflows/deploy-production.yml  (consumer)
jobs:
  deploy:
    uses: dsj1984/mandrel-platform/.github/workflows/deploy-cloudflare.yml@<sha>
    with:
      environment: production
      workers: "api,web"
      migrate: true                   # runs pre-migration snapshot + boot-smoke + auto-rollback
    secrets: inherit
```

```jsonc
// tsconfig.json (consumer)            // renovate.json (consumer)
{ "extends": "mandrel-platform/tsconfig.base.json" }
{ "extends": ["github>dsj1984/mandrel-platform"] }
```

The runner label stays a per-repo input — self-hosted vs `ubuntu-latest` is the one *justified* divergence (§4.3) and must not be flattened.

### 6.5 Versioning & rollout

- **SemVer the package; tag every release.** Consumers pin workflows by `@<sha>` (or `@v1`) and the npm config by exact version; Renovate opens the bump PRs (3-day `minimumReleaseAge`, the same gate the consumers already use). A fix to a timeout band or a new tier lands in all three via one merged Renovate PR per repo — no hand-copy.
- **Best-of-breed seeding.** Port the strongest existing implementation as the canonical version of each unit: domio's `_headers` + CSP middleware and unconditional gitleaks; athportal's `isolation-audit` job, `smoke-deploy.sh`, Turbo remote cache, and per-job timeouts; swarm-os's lean 5-job fan-out shape and self-expiring CVE allowlist. The shared unit should be the *union of the best*, not a lowest common denominator.
- **Prove on the simplest consumer first.** Cut **swarm-os** over first (smallest CI surface, `ubuntu-latest`, no self-hosted nuance), shake out the `workflow_call` input contract, then migrate **athportal** (deletes the most duplication) and **domio** last. Delete each repo's local copies only after its caller is green.

### 6.6 Bootstrap sequence (first PRs)

1. **Create `dsj1984/mandrel-platform`** with the §6.2 skeleton; add `release.yml` (tag → npm publish) and SHA-pinned third-party actions.
2. **Land the composite `setup-toolchain` action first** — it is the dependency of every reusable workflow (§7).
3. **Port `pr-quality.yml`** as a `workflow_call` workflow with the union-of-best tiers; validate against a throwaway branch in swarm-os.
4. **Port `deploy-cloudflare.yml`** with boot-smoke + pre-migration snapshot + auto-rollback baked in (closes the High deploy gaps from §5 for every consumer at once).
5. **Publish `config/` + `scripts/`** to npm; add `check-required-contexts.mjs` as a self-test so a phantom required check (§4.7) can never ship.
6. **Cut consumers over** per §6.5 ordering; each cutover PR is a thin caller + deletion of the local original.

> **Prerequisite:** §6.3 channel 1/2 assume one runtime baseline. Do **not** start the cutover until §7 (Wave B — Node 24 exact, pnpm 11.5.2, overrides in `pnpm-workspace.yaml`) has landed in all three — otherwise the divergence just moves into the shared workflow's inputs.

> **Naming note:** `mandrel-platform` chosen over `mandrel-devops` because the unit owns shared *config* (tsconfig, Renovate, base scripts) as well as pipelines — "platform" is the accurate umbrella and leaves room to grow without a rename. The `mandrel-` prefix preserves the brand lineage while the suffix marks the audience split.

---

## 7. Unified Remediation Roadmap & Execution Plan

This is the execution-ordered remediation plan — the phased roadmap and the cross-repo Story register merged and sequenced by **dependency order**. **All 27 Stories exist, and every dependency below is set as a native GitHub `blocked_by` link (verified 2026-06-28).** GitHub issue dependencies span repositories *and* organizations, so the consumer→`mandrel-platform` edges and the cross-org `swarm-os` edges are real links surfaced in the GitHub UI, not just prose. Each item shows its ticket, the concrete change (with `file:line`), effort (S/M/L), and the finding it closes; **§7.9 maps every §3/§4/§5 finding to its owning Story.**

Severity tags trace to §5; convergence targets to §4; shared-unit design to §3 and §6.

### 7.1 Projects & ticket register

| Repo | Owner | Project | Role |
|---|---|---|---|
| `mandrel-platform` | `dsj1984` | [#8](https://github.com/users/dsj1984/projects/8) | **Producer** — shared substrate |
| `domio` | `dsj1984` | #4 | Consumer |
| `athportal` | `dsj1984` | #6 | Consumer |
| `swarm-os` | `Beestera` | #1 | Consumer (different org) |

**Producer — `mandrel-platform` (Project #8):**

| Story | Ticket | Native `blocked_by` |
|---|---|---|
| MP-1 — repo skeleton + release pipeline | [#2](https://github.com/dsj1984/mandrel-platform/issues/2) | — |
| MP-2 — setup-toolchain composite action | [#3](https://github.com/dsj1984/mandrel-platform/issues/3) | #2 |
| MP-3 — reusable `pr-quality` workflow | [#4](https://github.com/dsj1984/mandrel-platform/issues/4) | #3 |
| MP-4 — reusable `deploy-cloudflare` workflow | [#5](https://github.com/dsj1984/mandrel-platform/issues/5) | #3 |
| MP-5 — unconditional CodeQL workflow | [#6](https://github.com/dsj1984/mandrel-platform/issues/6) | #2 |
| MP-6 — config pkg (tsconfig/biome + CVE-gate) | [#7](https://github.com/dsj1984/mandrel-platform/issues/7) | #2 |
| MP-7 — shared Renovate preset | [#8](https://github.com/dsj1984/mandrel-platform/issues/8) | #2 |
| MP-8 — main-protection contract + lint | [#9](https://github.com/dsj1984/mandrel-platform/issues/9) | #4 |
| MP-9 — centralize common runbooks + docs-staleness lint | [#10](https://github.com/dsj1984/mandrel-platform/issues/10) | #2 |

**Consumers — same six-Story set per repo (native `blocked_by` shown):**

| Story | domio (#4) | athportal (#6) | swarm-os (#1) | Native `blocked_by` |
|---|---|---|---|---|
| H1 — deploy safety net | [#1532](https://github.com/dsj1984/domio/issues/1532) | [#2003](https://github.com/dsj1984/athportal/issues/2003) | [#109](https://github.com/Beestera/swarm-os/issues/109) | — |
| H2 — security gates actually run | [#1533](https://github.com/dsj1984/domio/issues/1533) | [#2004](https://github.com/dsj1984/athportal/issues/2004) | [#110](https://github.com/Beestera/swarm-os/issues/110) | — |
| C1 — runtime/tooling convergence | [#1534](https://github.com/dsj1984/domio/issues/1534) | [#2005](https://github.com/dsj1984/athportal/issues/2005) | [#111](https://github.com/Beestera/swarm-os/issues/111) | H1, H2 (same repo) |
| X1 — adopt setup + pr-quality | [#1535](https://github.com/dsj1984/domio/issues/1535) | [#2006](https://github.com/dsj1984/athportal/issues/2006) | [#112](https://github.com/Beestera/swarm-os/issues/112) | C1 + mp **#3** (MP-2), **#4** (MP-3) |
| X2 — adopt deploy + config + renovate | [#1536](https://github.com/dsj1984/domio/issues/1536) | [#2007](https://github.com/dsj1984/athportal/issues/2007) | [#113](https://github.com/Beestera/swarm-os/issues/113) | X1 + mp **#5,#7,#8,#9,#10** |
| F1 — platform hardening + obs + docs | [#1537](https://github.com/dsj1984/domio/issues/1537) | [#2008](https://github.com/dsj1984/athportal/issues/2008) | [#114](https://github.com/Beestera/swarm-os/issues/114) | X2 + mp **#10** (MP-9) |

> Dependencies are enforced natively (GitHub `blocked_by`): each blocked Story lists its blockers in the GitHub UI, so the wave order below is machine-visible, not only documented.

### 7.2 Order of operations (waves)

```text
WAVE A  (start now, two parallel tracks)
  ├─ PRODUCER mandrel-platform: MP-1(#2) → MP-2(#3) → {MP-3(#4) → MP-8(#9)}, MP-2 → MP-4(#5),
  │                              MP-1 → {MP-5(#6), MP-6(#7), MP-7(#8), MP-9(#10)}
  └─ CONSUMERS (each repo):      H1 + H2          ← independent of mandrel-platform (High severity)

WAVE B  (after a repo's H1+H2)            → C1   (runtime/tooling convergence)
WAVE C  (after MP-2+MP-3 released AND C1) → X1   (adopt shared setup action + pr-quality workflow)
WAVE D  (after MP-4/6/7/8/9 released AND X1) → X2 (adopt shared deploy workflow + config pkg + renovate preset)
WAVE E  (after X2)                        → F1   (security headers/CORS, observability, docs)
```

**Critical path:** `MP-1 → MP-2 → MP-3 → (consumer) X1 → X2 → F1`. Wave A's consumer hardening (H1/H2) and the whole `mandrel-platform` build run concurrently. No consumer cutover (Wave C+) may start until the `mandrel-platform` units it calls are released with a pinnable SHA (§6.5).

### 7.3 Wave A — Stop the bleeding + producer foundation (start now)

Two independent tracks. The consumer track (H1/H2) is every repo's High-severity fixes and does **not** depend on `mandrel-platform`; the producer track builds the shared substrate everything later calls.

**Producer track — `mandrel-platform` foundation** (detailed setup in §6):

- [ ] **MP-1 — repo skeleton + release pipeline** · [#2](https://github.com/dsj1984/mandrel-platform/issues/2) · no deps · **M**. `config/`, `scripts/`, `templates/runbooks/`, `.github/{workflows,actions}` trees; `package.json` exports map; `release.yml` (tag → npm publish); SHA-pinned actions; `.nvmrc` 24.x + pnpm 11.5.x canonical baseline.
- [ ] **MP-2 — setup-toolchain composite action** · [#3](https://github.com/dsj1984/mandrel-platform/issues/3) · `blocked_by` #2 · **M**. pnpm-from-`packageManager` + Node-from-`.nvmrc` + `--frozen-lockfile`, `cache` boolean input. Replaces the three drifting per-repo composites. (§3 #2, §4.3)
- [ ] **MP-3 — reusable `pr-quality` workflow** · [#4](https://github.com/dsj1984/mandrel-platform/issues/4) · `blocked_by` #3 · **L**. `workflow_call`; tiers + runner/shard inputs; single aggregator required-check; per-job `timeout-minutes`; Turbo remote cache; Playwright browser cache. (§3 #1/#5, §4.3, §5 Medium caching)
- [ ] **MP-4 — reusable `deploy-cloudflare` workflow** · [#5](https://github.com/dsj1984/mandrel-platform/issues/5) · `blocked_by` #3 · **L**. `workflow_call` with `isolation-audit`, `check-env`, pre-migration snapshot, boot-smoke, auto-rollback. (§3 #3, §5 High deploy/migration)
- [ ] **MP-5 — unconditional CodeQL workflow** · [#6](https://github.com/dsj1984/mandrel-platform/issues/6) · `blocked_by` #2 · **S**. `javascript-typescript`, not visibility-gated → runs on private repos. (§3 #9, §5 High no-SAST)
- [ ] **MP-6 — config package (tsconfig/biome + CVE-gate)** · [#7](https://github.com/dsj1984/mandrel-platform/issues/7) · `blocked_by` #2 · **M**. npm-published base config + stricter `audit-check.mjs`. (§3 #8, §4.4)
- [ ] **MP-7 — shared Renovate preset** · [#8](https://github.com/dsj1984/mandrel-platform/issues/8) · `blocked_by` #2 · **S**. `github>dsj1984/mandrel-platform`; nvm-lockstep + wrangler `compatibility_date` rules. (§3 #7, §4.1)
- [ ] **MP-8 — main-protection contract + required-context lint** · [#9](https://github.com/dsj1984/mandrel-platform/issues/9) · `blocked_by` #4 · **M**. Single required aggregator + `check-required-contexts.mjs`. (§3 #6, §4.7)
- [ ] **MP-9 — centralize common runbooks + docs-staleness lint** · [#10](https://github.com/dsj1984/mandrel-platform/issues/10) · `blocked_by` #2 · **M**. Canonical common runbooks in `docs/runbooks/` (rollback/deploy-promotion/observability/secret-rotation/dependency-update/backup-restore/branch-protection + new incident-response/SLO), **referenced** by projects; per-project `docs/environments.md` and project-specific docs stay local (classification in §6.1); + docs-staleness lint. (§3 #10, §4.7)

**Consumer track — High-severity hardening** (each bullet = one Story instantiated in all three repos):

- [ ] **H1 — Deploy safety net** · domio [#1532](https://github.com/dsj1984/domio/issues/1532), athportal [#2003](https://github.com/dsj1984/athportal/issues/2003), swarm-os [#109](https://github.com/Beestera/swarm-os/issues/109) · no deps · **M–L**.
  - Make staging deploy depend on CI-green: raw `push` → `on: workflow_run` (CI `completed` + `conclusion==success` on `main`). Files: domio `deploy-staging.yml:22-26`, athportal `deploy-staging.yml:25-33`, swarm-os `deploy-staging.yml:11-14`.
  - Post-deploy health gate + auto-rollback: blocking curl (web `/`→200, api `/health`→200) → `wrangler rollback` on non-2xx. athportal promote `scripts/smoke-deploy.sh` into prod (`deploy-staging.yml:224-234`); domio flip `PROD_SMOKE_ENABLED` + make blocking (`deploy-production.yml:140-172`); swarm-os author + wire the script into both workflows.
  - Pre-migration Turso snapshot/branch before `db:migrate`; document restore in the rollback runbook. swarm-os `deploy-production.yml:55-56`, athportal `deploy-*.yml:136-189`, domio `deploy-staging.yml:421-443`.
  - **Closes:** §5 High (broken-deploy-ships-green; forward-only migration no snapshot; staging-no-CI-gate); §4.6.
- [ ] **H2 — Close the no-op security gates** · domio [#1533](https://github.com/dsj1984/domio/issues/1533), athportal [#2004](https://github.com/dsj1984/athportal/issues/2004), swarm-os [#110](https://github.com/Beestera/swarm-os/issues/110) · no deps · **S–M**.
  - Private-repo-capable PR secret scan as a real required check (drop the `repository.visibility=='public'` gate). athportal `quality.yml:1500-1534` (+ fix linux-only/sudo TODO `:1506-1508`); domio add push/full-history gitleaks alongside the PR-only scan (`ci-pr.yml:144-166`); swarm-os already scans (`ci.yml:90-115`) → needs branch protection applied.
  - Add a real CodeQL run (adopt MP-5's shared workflow when released; interim local file). athportal drop `codeql.yml:38` gate; domio/swarm-os new file.
  - Reconcile `main-protection.json`/prose vs live job names (remove phantom required checks) then apply branch protection. athportal `main-protection.json:4-22`; swarm-os `branch-protection-setup.md:32-44` + apply; domio remove the contradictory duplicate `.github/RUNBOOKS/`.
  - **Closes:** §5 High (no-op SAST + private-repo secret gate); §4.4, §4.7.

### 7.4 Wave B — Converge runtime, tooling & dependency placement

- [ ] **C1 — Converge onto the shared baseline** · domio [#1534](https://github.com/dsj1984/domio/issues/1534), athportal [#2005](https://github.com/dsj1984/athportal/issues/2005), swarm-os [#111](https://github.com/Beestera/swarm-os/issues/111) · `blocked_by` H1+H2 (same repo) · **M** (domio), **S** (others).
  - Pin Node to one exact 24.x in `.nvmrc`+`engines`; add `.npmrc engine-strict=true`; resolve CI Node via `node-version-file:.nvmrc`. domio migrate 22→24 + replace 6× `node-version:"22"` (`ci-pr.yml:210`).
  - domio → pnpm 11.5.2; move 26-entry overrides `package.json#pnpm`→`pnpm-workspace.yaml`; swarm-os tighten Turbo floor `^2.3.3`→`^2.9.16`.
  - Adopt the stricter CVE gate (block all unsuppressed High/Crit + dated allowlist); domio port `audit-check.mjs` off `audit-fixable-gate.mjs`.
  - Add Renovate to domio (+ `dependency-review-action` + SBOM all three); retire domio Prettier → Biome with `format --check` as a CI step everywhere.
  - Make mutation testing nightly in domio (`mutation-test.yml:3-22`, fix the false `ci-pr.yml:52-53` claim); swarm-os add explicit `coverage:check` thresholds; rename swarm-os `docs/environment.md`→`environments.md`.
  - Add CI backstops for local-only ratchets (athportal `lint:secrets`; domio `format --check`/`contract:check`/lint-baseline).
  - **Closes:** §4.1, §4.2, §4.5; §3 #7/#8 (consumer side); §5 Medium (no-timeouts/coverage interim for swarm-os).

### 7.5 Wave C — Adopt shared setup + PR-quality

- [ ] **X1 — Adopt setup-toolchain + pr-quality** · domio [#1535](https://github.com/dsj1984/domio/issues/1535), athportal [#2006](https://github.com/dsj1984/athportal/issues/2006), swarm-os [#112](https://github.com/Beestera/swarm-os/issues/112) · `blocked_by` mp **#3 (MP-2)**, **#4 (MP-3)**, C1 · **M–L**.
  - Replace the local setup composite with `dsj1984/mandrel-platform/.github/actions/setup-toolchain@<sha>`; reduce the PR-quality CI to a caller of `.../pr-quality.yml@<sha>` (runner label + shards); delete local originals once green; rename the required check to the shared aggregator.
  - **Closes:** §3 #1/#2/#5, §4.3 (consumer side); §5 Medium (caching). **Release-gate:** MP-2/MP-3 released with a pinnable SHA (§6.5).

### 7.6 Wave D — Adopt shared deploy + config + Renovate

- [ ] **X2 — Adopt deploy-cloudflare + config pkg + renovate preset** · domio [#1536](https://github.com/dsj1984/domio/issues/1536), athportal [#2007](https://github.com/dsj1984/athportal/issues/2007), swarm-os [#113](https://github.com/Beestera/swarm-os/issues/113) · `blocked_by` mp **#5,#7,#8,#9,#10**, X1 · **L**.
  - deploy-staging/production → callers of `.../deploy-cloudflare.yml@<sha>`; `tsconfig` extends `mandrel-platform/tsconfig.base.json` + shared `audit-check`; `renovate.json`→`{extends:[github>dsj1984/mandrel-platform]}`; adopt `main-protection.json` + required-context lint + runbook templates.
  - Standardize the migration-label-guard via the shared deploy workflow (fix athportal wrong path `scripts/migration-label-guard.mjs:18-19`; swarm-os has none; domio exact-host allowlist). One wrangler config format across both apps; one advanced `compatibility_date` (un-stick athportal `2025-01-01`).
  - **Closes:** §3 #3/#6/#7/#8, §4.4/#4.6/§4.7 (consumer side). **Release-gate:** MP-4/6/7/8/9 released.

### 7.7 Wave E — Platform hardening, observability & docs

- [ ] **F1 — Hardening + observability + docs** · domio [#1537](https://github.com/dsj1984/domio/issues/1537), athportal [#2008](https://github.com/dsj1984/athportal/issues/2008), swarm-os [#114](https://github.com/Beestera/swarm-os/issues/114) · `blocked_by` X2, mp **#10 (MP-9)** · **M**.
  - Security headers (athportal + swarm-os): Hono `secureHeaders()` + Astro CSP/HSTS/`X-Frame-Options`/`X-Content-Type-Options`/`Referrer-Policy` (port domio reference `apps/web/public/_headers`, `apps/web/src/lib/csp/cspMiddleware.ts`); `hono/cors` per-env origin allowlist. domio already ships these — it is the porting source.
  - Observability: `analytics_engine_datasets` + `logpush:true` per Worker; Sentry that actually captures (domio `logger.error` no-op today); domio inject `--var GIT_COMMIT_SHA=${{ github.sha }}`; athportal apply the Better Stack uptime IaC (`infra/uptime/betterstack.yml`); swarm-os correct the false "AE bound" doc + wire Sentry; swarm-os migrate web Pages→Worker (aligns to the shared deploy workflow, un-drifts the rollback runbook).
  - Husky fail-fast (`set -e` + `husky` devDep where missing); harden `.gitignore` (`*.pem`,`*.key`,`*.p12`,`*.pfx`,`id_rsa*`,`*credentials*`); reconcile Pages→Worker docs; **reference** the common `mandrel-platform` runbooks (replace each duplicated process runbook with a thin local doc holding project values + a link), keeping `docs/environments.md` and project-specific runbooks local (§6.1).
  - **Closes:** §5 Medium/Low (observability, CORS, husky, `.gitignore`, `GIT_COMMIT_SHA`); §3 #9/#10, §4.6/§4.7 (consumer side). Security-header sub-items may start before X2.

### 7.8 Delivery sequence & gates

All 27 Stories exist (§7.1) and carry native `blocked_by` edges. Tick each as it is **delivered**; brackets are sequential, items within a bracket parallelize.

1. [ ] **`mandrel-platform` (#8):** MP-1 (#2) → MP-2 (#3) → {MP-3 #4, MP-4 #5, MP-5 #6, MP-6 #7, MP-7 #8, MP-9 #10} → MP-8 (#9). **Cut a release (SHA tag) before any consumer Wave C/D.**
2. [ ] **domio (#4):** H1 (#1532) + H2 (#1533) → C1 (#1534).
3. [ ] **athportal (#6):** H1 (#2003) + H2 (#2004) → C1 (#2005).
4. [ ] **swarm-os (#1):** H1 (#109) + H2 (#110) → C1 (#111).
5. [ ] After `mandrel-platform` #3/#4 released **and** a repo's C1 delivered → X1 (domio #1535, athportal #2006, swarm-os #112).
6. [ ] After `mandrel-platform` #5/#7/#8/#9/#10 released **and** a repo's X1 delivered → X2 (domio #1536, athportal #2007, swarm-os #113).
7. [ ] After a repo's X2 delivered → F1 (domio #1537, athportal #2008, swarm-os #114).

**Protocol & gates**

- **One repo per session.** Deliver each repo's Stories from a session rooted in that repo's directory (§7.1) — delivery tooling operates on the repo it runs in.
- **Steps 2–4 run now, concurrently with step 1.** Consumer hardening + convergence are the highest-severity fixes (§5 High) and do not wait on `mandrel-platform`.
- **Release-gate the cutover.** Do not start Wave C/D (`X1`/`X2`) until the `mandrel-platform` units they call are merged **and** released with a pinnable SHA/tag (§6.5); back-fill the `@<sha>` placeholders in each X1/X2 body at that point.
- **`swarm-os` is cross-org (`Beestera`).** Its native `blocked_by` links to `dsj1984/mandrel-platform` are set and verified; delivery still happens from the swarm-os session.

**Sequencing rationale.** Wave A leads because every consumer item is a High finding whose failure mode is live exposure (an unscanned secret, a green-but-broken prod deploy, an irreversible migration, a phantom required check), each fixable in isolation today; and the producer foundation must exist before any cutover. Within H2, reconciling required-check names **precedes** applying branch protection so no phantom context wedges every PR. Wave B establishes one runtime/tooling baseline because the shared workflows (Waves C/D) cannot assume uniformity that doesn't yet exist — centralizing onto three divergent baselines just pushes drift into the shared layer's inputs. Waves C/D collapse the triplicated CI/deploy/config artifacts into versioned shared units, safe only once the per-repo defence-in-depth from Wave A exists to become those units' bodies. Wave E lands last: security headers, CORS, observability, and doc reconciliation are real but non-bleeding, cheapest to apply uniformly once the substrate exists, and docs must trail the code/workflow changes that made them stale.

### 7.9 Coverage map — does the roadmap cover §3, §4, §5?

**Yes — every finding maps to at least one Story.**

**§3 — Overlaps / unification opportunities → Stories**

| §3 opportunity | Owning Story(ies) |
|---|---|
| #1 Shared PR-quality workflow | MP-3 → X1 |
| #2 Shared setup-toolchain action | MP-2 → X1 |
| #3 Shared deploy workflow | MP-4 → X2 |
| #4 Shared wrangler base + `compatibility_date` | C1 (compat-date) + X2 (wrangler convention) + MP-7 (Renovate rule) |
| #5 Uniform job-timeout + caching | MP-3 → X1 |
| #6 Single required-status-check contract | MP-8 → X2; H2 (interim reconcile) |
| #7 Shared Renovate preset | MP-7 → X2; C1 (domio interim adopt) |
| #8 Shared base-config package | MP-6 → X2; C1 (CVE-gate interim) |
| #9 Platform-security baseline (SAST + headers + secret scan) | MP-5 + H2 + F1 |
| #10 Runbook templates + observability/incident baseline | MP-9 → X2/F1; F1 (observability) |

**§4 — Critical divergences → Stories**

| §4 divergence | Owning Story(ies) |
|---|---|
| 4.1 Runtime/tool version drift | C1 (+ MP-1 baseline, MP-7 nvm rule) |
| 4.2 Lint/format/test-standard drift | C1 |
| 4.3 CI structure drift | MP-3 → X1 |
| 4.4 Security-tooling presence drift | MP-5, H2, MP-6, F1 |
| 4.5 Dependency-override placement | C1 (domio) |
| 4.6 Deploy-strategy / web-adapter drift | H1, MP-4 → X2, F1 (swarm-os Pages→Worker) |
| 4.7 Docs-naming / runbook drift | H2 (branch-protection), MP-9, F1 (docs), C1 (`environment.md` rename) |

**§5 — Gaps & security vulnerabilities → Stories**

| §5 finding | Severity | Owning Story(ies) |
|---|---|---|
| No effective SAST (CodeQL) | High | MP-5 + H2 |
| No-op private-repo PR secret scan | High | H2 |
| Broken deploy ships green / no rollback | High | H1 + MP-4 |
| Forward-only migrations, no snapshot/PITR | High | H1 + MP-4 |
| Staging auto-deploy with no CI gate | High | H1 |
| Missing security headers / CORS allowlist | High | F1 |
| Caching gaps (no remote cache / Playwright reinstall) | Medium | MP-3 → X1 |
| CI error-handling / required-checks / no timeouts | Medium | MP-3, MP-8, H2; C1 (swarm-os timeouts interim) |
| Logging & observability (AE/Logpush/Sentry) | Medium | F1 |
| Husky fail-fast, `.gitignore`, `GIT_COMMIT_SHA`, `compatibility_date` | Low | F1 (+ C1 compat-date) |

Two findings are split across waves by design: SAST and the secret gate are made real per-repo **now** (H2) and then converge onto the shared workflow (MP-5); security headers land in F1 because they ride the shared substrate but their sub-items may start earlier.
