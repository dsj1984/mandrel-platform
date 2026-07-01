# mandrel-platform

The **single source of truth (SSOT)** for CI/CD, security, and configuration
across the Mandrel fleet. A consumer repo adopts this platform once and inherits
a converged, hardened baseline — reusable GitHub Actions workflows, a composite
toolchain action, importable config bases, guardrail scripts, edge-security
middleware, a Renovate preset, and operator runbook templates — instead of
hand-maintaining its own copies and drifting apart over time.

## What's in scope

| Pillar | What it provides |
| ------ | ---------------- |
| **Reusable workflows** | `workflow_call` CI, deploy, secret-scan, release, and CodeQL pipelines, consumed by tag/SHA pin. |
| **Composite action** | `setup-toolchain` — pnpm + Node + frozen install in one step. |
| **Config bases (npm)** | `extends`-able baselines: TypeScript, Biome, Knip, Stryker, commitlint, dependency-cruiser, size-limit, Lighthouse. |
| **Edge-security middleware (npm)** | Per-env closed-allowlist CORS, security headers, and app-layer rate limiting for Astro + Hono. |
| **Guardrail scripts (npm)** | Dependency-free policy checks: CVE gate, action-pin ratchet, coverage floor, destructive-migration guard, workflow-portability, required-contexts, docs-staleness. |
| **Renovate preset** | Shared dependency-update policy, including auto-bumping this repo's own `uses:` pins. |
| **Supply-chain config** | pnpm-native hardening fragment (`blockExoticSubdeps`, `trustPolicy`, 7-day `minimumReleaseAge`). |
| **Adoption & drift control** | `platform-sync` (adopt/repair) plus a scheduled cross-consumer pin-drift dashboard and auto-repair-PR loop. |
| **Runbook templates** | Copyable thin-stub operator runbooks that link back to the canonical process docs. |

**Out of scope.** mandrel-platform is not an application and ships no runtime
service — it deploys nothing of its own beyond its release train. Consumers keep
every project-specific knob (entrypoints, budgets, score floors, deploy targets)
local: the platform sets the floor, the consumer sets the ceiling. The `.agents/`
tree in this repo is the Mandrel agent framework used to *develop* the platform
(sourced from the separate `mandrel` CLI) — it is dev-time only and is **not**
part of the published npm package, whose `files` allowlist ships only `config/`,
`default.json`, `scripts/`, and `templates/`.

**Docs:** [reusable-workflows.md](docs/reusable-workflows.md) (the `workflow_call`
contract) · [decisions.md](docs/decisions.md) (decision log). Status, the
consumer convergence matrix, and the forward roadmap are tracked privately.

---

## Reusable workflows

Five workflows expose a stable `workflow_call` contract and are consumed by
tag/SHA pin. Configure your callers from
**[docs/reusable-workflows.md](docs/reusable-workflows.md)** — the authoritative
reference for input types, defaults, when-to-override, the frozen
`{CLOUDFLARE_*, TURSO_*}` deploy-secret allowlist, the single `ci-required`
aggregator context, and the pin-by-tag/SHA versioning model.

| Workflow | Purpose |
| -------- | ------- |
| [`pr-quality.yml`](docs/reusable-workflows.md#pr-qualityyml) | Tiered PR gate — lint/format → typecheck → unit → contract → e2e/smoke → migration-guard → security → osv-scan, each tier independently toggled, behind one `ci-required` aggregator. |
| [`deploy-cloudflare.yml`](docs/reusable-workflows.md#deploy-cloudflareyml) | Defence-in-depth Cloudflare deploy with a frozen deploy-secret allowlist. |
| [`secret-scan-push.yml`](docs/reusable-workflows.md#secret-scan-pushyml) | Full-history gitleaks secret scan on push to the default branch. |
| [`release-automation.yml`](docs/reusable-workflows.md#release-automationyml) | Conventional-commit release lifecycle (version bump + `CHANGELOG.md` + tag) via release-please. |
| [`codeql.yml`](docs/reusable-workflows.md#codeqlyml) | CodeQL SAST analysis — dual-mode: runs on this repo's push/PR/schedule **and** is `workflow_call`-consumable. |

> `smoke-dispatch.yml` is a **platform-internal** cross-repo smoke trigger
> (`push` / `workflow_dispatch`, not `workflow_call`). It appears in the
> reference for completeness but is not part of the consumer caller surface.

`release-automation.yml` extends the platform from CI/deploy into the **full
release lifecycle**: a thin caller gets conventional-commit-driven version
bumps, a `CHANGELOG.md`, and tags via release-please — the same convention the
platform's own release train uses. It does not publish to a registry (consumers
deploy to Cloudflare, not npm); see its section in the reference for the
out-of-scope boundary and the `release_created` / `tag_name` outputs a
publish/deploy job keys off.

---

## Shared Composite Actions

### `setup-toolchain`

Installs pnpm (version sourced from the consuming repo's `packageManager` field), Node.js (version sourced from `.nvmrc`), and project dependencies via `pnpm install --frozen-lockfile`.

**Reference by SHA** to pin an exact version:

```yaml
- name: Setup toolchain
  uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@<sha>
  with:
    cache: 'true'   # omit or pass 'false' on self-hosted runners with a warm pnpm store
```

**Inputs:**

| Input   | Required | Default | Description                                                                                  |
| ------- | -------- | ------- | -------------------------------------------------------------------------------------------- |
| `cache` | No       | `true`  | Enable pnpm store caching via `actions/setup-node`. Pass `false` on self-hosted runners. |

**When to pass `cache: 'false'`:** Self-hosted runners that maintain their own warm pnpm store do not need the `actions/setup-node` pnpm cache layer. Ubuntu runners on `ubuntu-latest` benefit from the default `cache: 'true'`.

---

## Published npm package

The `mandrel-platform` npm package exports shared configuration baselines and
utility scripts so all consumer repos extend the same SSOT instead of
hand-syncing copies.

### `tsconfig.base.json`

A strict TypeScript base config — `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`,
`moduleResolution: Bundler`, `target: ES2022` — intended to be extended by
every consumer.

**Consumer usage (`tsconfig.json`):**

```jsonc
{
  "extends": "mandrel-platform/tsconfig.base.json",
  "compilerOptions": {
    // repo-specific overrides only
    "outDir": "dist"
  },
  "include": ["src"]
}
```

### `biome.base.json`

A Biome base config with the recommended linter rule set, import organizer,
and standard formatter defaults (2-space indent, 100-char line width).

**Minimum Biome version: 2.0.** The base targets the **Biome v2 schema**
(`$schema: https://biomejs.dev/schemas/2.5.0/schema.json`, `assist.actions.
source.organizeImports`, `linter.rules.preset`). Biome v1 consumers cannot
`extends` this base — the v2 config shape is a hard configuration error on
Biome 1.x. There is no dual v1/v2 export; consumers on Biome 1.x must
upgrade to 2.x before adopting this base (refs #153).

**Consumer usage (`biome.json`):**

```jsonc
{
  "extends": ["mandrel-platform/biome.base.json"],
  "files": {
    "ignore": ["dist/", ".wrangler/"]
  }
}
```

### Code-quality tooling base configs

The package also ships shared base configs for the five code-quality /
hygiene tools every consumer runs — **Knip**, **Stryker**,
**dependency-cruiser**, **size-limit**, and **Lighthouse**. Each is the
best-of-breed union of the consumers' previously hand-maintained configs.
Adoption is opt-in via `extends` (or a spread / deep-merge where the tool
has no native `extends`), and every project-specific knob — entrypoints,
mutate globs, bundle paths, score floors, and budgets — stays
**consumer-tunable** locally.

#### `knip.base.json`

Shared Knip defaults (`ignoreExportsUsedInFile`, the `mandrel` binary +
`mandrel-platform` dependency ignores). Knip supports a native `extends`,
so consumers point at the base and add their own `entry` / `project`
globs (`knip.json`):

```jsonc
{
  "extends": ["mandrel-platform/knip.base.json"],
  "entry": ["src/index.ts", "scripts/*.ts"],
  "project": ["src/**", "scripts/**"]
}
```

#### `stryker.base.json`

Shared Stryker mutation-testing defaults (pnpm package manager,
`perTest` coverage analysis, HTML + clear-text + progress reporters,
`ignoreStatic`, a 60 s timeout, and high/low/break thresholds). Stryker
supports a native `extends`; the consumer pins its test runner and
mutate set (`stryker.config.json`):

```jsonc
{
  "extends": ["mandrel-platform/stryker.base.json"],
  "testRunner": "vitest",
  "mutate": ["src/**/*.ts", "!src/**/*.test.ts"]
}
```

#### `commitlint.base.mjs`

Single-sources the conventional-commit **type-enum** — the eleven types
(`feat`, `fix`, `perf`, `refactor`, `revert`, `docs`, `style`, `chore`,
`test`, `build`, `ci`) documented in
[`.agents/rules/git-conventions.md`](.agents/rules/git-conventions.md) — so
consumers stop hand-copying the list into their own
`commitlint.config.js`. Extends `@commitlint/config-conventional` for
everything else (header casing/length, body/footer blank-line rules) and
narrows `type-enum` to the fleet list. commitlint supports a native
`extends`, so a consumer's local config reduces to the extend plus any
repo-specific scope enforcement (`commitlint.config.js`):

```js
export default {
  extends: ["mandrel-platform/commitlint.base.mjs"],
  // repo-specific scope-enum, etc. — optional
};
```

Keep this base's `type-enum`, the git-conventions.md prose list, and
`release-please-config.json`'s `changelog-sections` in sync when adding a
type — all three must agree.

#### `dependency-cruiser.base.json`

Shared dependency-cruiser rule set (no-circular, no-orphans,
not-to-unresolvable, no-non-package-json, not-to-dev-dep,
no-deprecated-core, and the dep-type hygiene rules) plus resolver
options. dependency-cruiser supports a native `extends` to a JSON path —
resolve the package export and add repo-specific rules
(`.dependency-cruiser.json`):

```jsonc
{
  "extends": "mandrel-platform/dependency-cruiser.base.json",
  "forbidden": [
    // repo-specific layering rules only
  ]
}
```

#### `size-limit.base.json`

size-limit's own config is a per-entry **array** whose paths and limits
are inherently repo-specific, so the base ships the shared *check
options* (gzip sizing, `running: false`). Spread it into each entry of
your `.size-limit.json`:

```jsonc
// .size-limit.js — spread the base into each entry
import base from "mandrel-platform/size-limit.base.json" with { type: "json" };

export default [
  { ...base, path: "dist/index.js", limit: "10 kB" },
  { ...base, path: "dist/cli.js", limit: "25 kB" }
];
```

#### `lighthouse.base.json` / `lighthouse-thresholds.base.json`

Lighthouse has **two runner mechanisms** in the fleet — `@lhci/cli`
(`lighthouserc`) and a bespoke puppeteer + baseline-drift script (collect a
Lighthouse result programmatically, diff category scores against a checked-in
baseline JSON). Neither can consume the other's config shape natively, so the
package ships **two bases**:

- **`lighthouse-thresholds.base.json`** — the **mechanism-neutral** score
  floors (`categories.performance` / `.accessibility` / `.best-practices` /
  `.seo`, each a bare `0.0`–`1.0` number). This is the shared source of
  truth both mechanisms read. Runner-agnostic on purpose: it has no LHCI
  `ci.assert` wrapper and no puppeteer-script wiring, just the floors.
- **`lighthouse.base.json`** — the **LHCI wrapper**. Ships the shared `ci`
  block (collect settings + the four category assertions on the
  `lighthouse:recommended` preset) for `@lhci/cli` consumers. Its
  `categories:*` `minScore` values are sourced from
  `lighthouse-thresholds.base.json` — keep the two in sync when a floor
  changes.

**LHCI consumers** (`@lhci/cli`) deep-merge `lighthouse.base.json` and add
repo-specific `ci.collect.url` / `ci.collect.staticDistDir`:

```jsonc
// lighthouserc.js — deep-merge the base, add repo-specific collect targets
import base from "mandrel-platform/lighthouse.base.json" with { type: "json" };

export default {
  ci: {
    ...base.ci,
    collect: {
      ...base.ci.collect,
      staticDistDir: "./dist"
    }
  }
};
```

**Puppeteer / baseline-drift consumers** (no `@lhci/cli`, no `lighthouserc`)
extend `lighthouse-thresholds.base.json` directly — read the bare category
floors and gate the collected result against them, independent of any LHCI
config shape:

```jsonc
// scripts/lighthouse-baseline.mjs — read the shared floors, gate the collected result
import thresholds from "mandrel-platform/lighthouse-thresholds.base.json" with { type: "json" };

for (const [category, minScore] of Object.entries(thresholds.categories)) {
  const score = lighthouseResult.categories[category].score;
  if (score < minScore) {
    throw new Error(`${category} score ${score} below floor ${minScore}`);
  }
}
```

> **Budgets stay consumer-tunable.** These bases standardize *which*
> tools run and their shared defaults — not *what each tool gates on*
> per consumer. Override any threshold, score floor, or budget locally;
> the base provides the floor, the consumer sets the ceiling.

### Edge-security middleware units

The package ships reusable **per-env edge-security middleware** so the next
consumer inherits the closed-allowlist CORS, security-header, and app-layer
rate-limit invariants instead of re-deriving them. They are distributed through
the **npm package-export channel** (the same channel as the base configs and
`scripts/*`), under `mandrel-platform/edge-security`:

| Sub-path                                              | Unit                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `mandrel-platform/edge-security`                      | Barrel — re-exports every unit below.                                |
| `mandrel-platform/edge-security/cors-astro.mjs`       | `createAstroCors()` — closed-allowlist CORS as Astro middleware.     |
| `mandrel-platform/edge-security/cors-hono.mjs`        | `createHonoCorsOptions()` — closed-allowlist options for `hono/cors`.|
| `mandrel-platform/edge-security/security-headers.mjs` | `buildSecurityHeaders()` / `applySecurityHeaders()` — CSP/HSTS/XFO/XCTO/Referrer-Policy. |
| `mandrel-platform/edge-security/rate-limit.mjs`       | `createRateLimiter()` + Astro/hono adapters — fixed-window app-layer limiter. |
| `mandrel-platform/edge-security/allowlist.mjs`        | `createAllowlist()` — the shared closed-allowlist origin resolver.   |

**Two CORS variants, by design.** CORS code legitimately differs by
architecture: domio drives an Astro `(context, next)` middleware, while
athportal / swarm-os use `hono/cors`. Both variants ship — the divergence is
preserved, not flattened into one form. Both inherit the same closed allowlist
and the **no-wildcard-with-credentials invariant, enforced by construction**:
building either unit with `['*']` + `credentials: true` throws at construction
time (before a request is ever served), so a consumer cannot mis-configure the
forbidden `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Credentials: true`
shape.

**Per-env allowlist.** Each unit takes the allowed-origin set for the current
deployment environment, so the same code path applies in production and preview:

```ts
// Astro — src/middleware.ts
import { defineMiddleware, sequence } from "astro:middleware";
import { createAstroCors } from "mandrel-platform/edge-security/cors-astro.mjs";
import { applySecurityHeaders } from "mandrel-platform/edge-security/security-headers.mjs";
import { createAstroRateLimit } from "mandrel-platform/edge-security/rate-limit.mjs";

const cors = createAstroCors({
  allowedOrigins: import.meta.env.PROD ? ["https://godomio.com"] : ["http://localhost:4321"],
  credentials: true,
});
const rateLimit = createAstroRateLimit({ limit: 100, windowMs: 60_000 });

export const onRequest = sequence(
  defineMiddleware(cors),
  defineMiddleware(rateLimit),
  defineMiddleware(async (_ctx, next) => {
    const res = await next();
    applySecurityHeaders(res.headers);
    return res;
  }),
);
```

```ts
// hono — app entry
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHonoCorsOptions } from "mandrel-platform/edge-security/cors-hono.mjs";
import { createHonoRateLimit } from "mandrel-platform/edge-security/rate-limit.mjs";

const app = new Hono();
app.use("*", cors(createHonoCorsOptions({ allowedOrigins: ["https://athportal.com"], credentials: true })));
app.use("*", createHonoRateLimit({ limit: 100, windowMs: 60_000 }));
```

> **Headers / rate-limit are framework-agnostic.** `buildSecurityHeaders()`
> returns a plain `Record<string,string>` you can spread onto any response, and
> `createRateLimiter()` exposes a `check(request)` decision function with a
> pluggable store (swap the default in-memory store for a Cloudflare KV /
> Durable Object store in production). The Astro/hono adapters are thin wrappers
> over those cores.

---

### `scripts/audit-check.mjs`

CVE gate script. Runs `pnpm audit --prod` and blocks on any **unsuppressed**
High or Critical vulnerability in the production dependency graph. This is the
stricter athportal/swarm-os policy: all unsuppressed High/Critical are
blocking, not just fixable ones.

Known/accepted CVEs are suppressed via a **dated, self-expiring allowlist**
(`audit-allowlist.json` in the project root). Expired entries are treated as
un-suppressed and cause the script to exit non-zero — forcing teams to
periodically re-evaluate accepted risk.

**Consumer usage (`package.json`):**

```jsonc
{
  "scripts": {
    "audit:check": "node node_modules/mandrel-platform/scripts/audit-check.mjs"
  }
}
```

Or copy the script into your repo's `scripts/` directory when you need
local customization (and pin a semver range on `mandrel-platform` so drift
is detected by Renovate).

**Allowlist format (`audit-allowlist.json`):**

```jsonc
[
  {
    "id": "GHSA-xxxx-xxxx-xxxx",
    "reason": "No fix available; mitigated by X",
    "expires": "2026-12-31"
  }
]
```

- `id` — GitHub Security Advisory ID (`GHSA-*`) or CVE ID (`CVE-*`).
- `reason` — Human-readable explanation of why this CVE is accepted.
- `expires` — ISO 8601 date (`YYYY-MM-DD`). **Required.** Entries whose
  expiry date is in the past cause the script to exit non-zero.

---

### Guardrail & policy-check scripts

Beyond the CVE gate, the package ships a set of **dependency-free guardrail
lints** (`node`-only, nothing to install) that enforce cross-repo CI and
security invariants. Several are already wired into the reusable workflows, so a
consumer that adopts those inherits the check for free; each is also runnable
standalone (`node node_modules/mandrel-platform/scripts/<name>.mjs`) or copyable
into a repo's own `scripts/`.

| Script | Enforces | Wired into |
| ------ | -------- | ---------- |
| `check-coverage-threshold.mjs` | Coverage floor (lines/statements/functions/branches) read from `coverage-summary.json`; threshold `0` disables the gate. | `pr-quality.yml` (unit tier) |
| `check-destructive-migration.mjs` | Blocks `DROP` / `TRUNCATE` / `ALTER … DROP` (and Drizzle `.dropTable()`) in migration files unless a reviewer applies the override label. | `pr-quality.yml` (migration-guard tier, opt-in) |
| `check-workflow-portability.mjs` | Catches cross-repo footguns in reusable workflows / composite actions: relative `uses:` paths, `${{ }}` in `workflow_call` input metadata, and lagging first-party pins. | `pr-quality.yml` + `ci.yml` |
| `check-action-pins.mjs` | Ratchet requiring every third-party Action to be pinned to a full 40-char commit SHA (tag-swap defence); local and first-party refs are exempt. | `ci.yml` |
| `check-required-contexts.mjs` | Validates that every branch-protection required check in `main-protection.json` maps to a real CI job — no phantom required checks. Also **warns** (never blocks) when the caller file / display `name:` / caller job id diverge from the canonical `ci.yml` / `CI` / `ci` triplet ([details](docs/reusable-workflows.md#canonical-caller-naming-the-ciyml--ci--ci-triplet)). | `ci.yml` |
| `check-docs-staleness.mjs` | Lints markdown/JSON docs for known staleness patterns (stale URLs, expired dates, dead runbook paths); suppressible per-rule. | standalone |
| `check-repo-settings.mjs` | Cross-consumer dashboard for the GitHub-side repo-settings baseline (merge methods, squash source, auto-merge, Actions default token permissions, PR-approval-by-Actions) — see below. | standalone / `platform-sync --check-settings` |

> **`config/main-protection.schema.json`** is the JSON Schema for the
> branch-protection contract (`docs/runbooks/main-protection.json`) — required
> status checks, the aggregator job, upstream jobs, and enforcement flags.
> `check-required-contexts.mjs` validates the contract against the actual
> workflow job graph; see the
> [branch-protection runbook](docs/runbooks/branch-protection-setup.md).

> **`config/repo-settings.schema.json`** is the JSON Schema for the
> repo-settings baseline contract (`docs/runbooks/repo-settings.json`),
> sibling to `main-protection.schema.json` — merge methods, squash-commit
> source, auto-merge/delete-branch-on-merge, Actions default workflow token
> permissions, and whether Actions can approve pull requests. Fleet baseline
> decided 2026-07-01 (see `docs/decisions.md`): squash-only merges, squash
> source `PR_TITLE`/`PR_BODY`, auto-merge + delete-branch-on-merge on, Actions
> default token permissions `read`, `can_approve_pull_request_reviews` off.
>
> **Because `squashMergeCommitMessage` is `PR_BODY`, PR templates must stay
> commit-body-safe.** The PR description becomes the literal squash-commit
> body on `main`, which `release-please` and `commitlint` then parse — a
> template that injects checklist boilerplate, HTML comments, or
> non-conventional-commit prose into that body will land in commit history and
> can break changelog generation or commitlint's body rules. Keep PR templates
> to short, commit-message-safe prose, or put checklists in sections authors
> delete before merge.
>
> **Check + apply.** `scripts/check-repo-settings.mjs` is the GitHub-side
> drift dashboard (mirrors `check-pin-drift.mjs`'s shape: data-driven consumer
> registry — reuses `scripts/pin-drift-consumers.json` — injectable `gh`
> runner, `--json`/`--strict`). `scripts/platform-sync.mjs` gained a
> settings mode for the per-consumer check/apply flow:
>
> ```bash
> # Report drift for one consumer against the baseline — never mutates, never
> # fails the exit code unless the read itself errors (standing decision #10).
> node scripts/platform-sync.mjs --check-settings --consumer-repo dsj1984/domio
>
> # Same read, then PATCH the drifted fields to match the baseline.
> node scripts/platform-sync.mjs --apply-settings --consumer-repo dsj1984/domio
>
> # Preview what --apply-settings would PATCH without mutating anything.
> node scripts/platform-sync.mjs --apply-settings --dry-run --consumer-repo dsj1984/domio
> ```
>
> Both commands accept `--baseline <path>` (default:
> `docs/runbooks/repo-settings.json`) and `--json` for a machine-readable
> envelope. **Non-blocking by design** (standing decision #10, same posture as
> the pin-drift dashboard and `check-ruleset.mjs`): drift is reported, not a
> hard gate — it never fails CI on a consumer's `main`. Branch-protection
> ruleset drift is out of scope here (see the companion `check-ruleset.mjs`
> story); this contract covers repo-settings only.

---

## Renovate preset

The shared Renovate preset (`default.json`, also exposed at
`config/renovate.json`) is consumed by extending it from a consumer's
`renovate.json`:

```jsonc
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>dsj1984/mandrel-platform"]
}
```

It sets a weekly Monday schedule, a 3-day `minimumReleaseAge`, patch/minor
auto-merge with major updates gated behind the Dependency Dashboard, and
grouping rules for the common dependency families (Cloudflare, Sentry, Clerk,
ESLint, Vitest, Playwright, Astro).

### Auto-bumping `mandrel-platform` `uses:` pins

The preset ships a `github-actions` manager rule that bumps SHA-pinned
references to this repo's reusable workflows and composite actions —
`uses: dsj1984/mandrel-platform/...@<sha>` — so consumers stop drifting on
stale pins (e.g. `pr-quality.yml@v0.3.1` while `deploy-cloudflare.yml@v0.9.0`).
The bumps are grouped into a single **"mandrel-platform workflows"** PR and
ride the preset's weekly window + 3-day `minimumReleaseAge`.

**Required:** Renovate only updates a **bare-SHA** pin when the consumer adds a
version comment after it. Pin with a trailing `# <tag>` comment so Renovate can
resolve the current release and open the bump PR:

```yaml
# ✅ Renovate will bump this pin
- uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@869bbbf21faa2cdf6045d64a9c3347b928e196fe # v0.10.0

# ❌ Bare SHA without a version comment — Renovate leaves it alone
- uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@869bbbf21faa2cdf6045d64a9c3347b928e196fe
```

See the [Dependency Update runbook](docs/runbooks/dependency-update.md) for the
operator-facing review flow.

---

## pnpm supply-chain config

`config/pnpm-workspace.supply-chain.yaml` is the canonical pnpm-native
supply-chain hardening block: `blockExoticSubdeps`, `trustPolicy`, and
`minimumReleaseAge`. Unlike the JSON config bases above, `pnpm-workspace.yaml`
has no whole-file `extends`, so this ships as a copy-merge fragment rather
than an importable module — merge its three keys into your consumer's
`pnpm-workspace.yaml` alongside any existing `packages:`/catalog entries:

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"

# Merged from mandrel-platform/pnpm-workspace.supply-chain.yaml
blockExoticSubdeps: true
trustPolicy: no-downgrade
minimumReleaseAge: 10080
```

`minimumReleaseAge` here is **7 days (10080 minutes)** — intentionally
stricter than the platform's 3-day Renovate `minimumReleaseAge` gate (see
[Renovate preset](#renovate-preset) above). Renovate's value governs when a
bump *PR* is raised; pnpm's value governs when `pnpm install` will *resolve*
a version at all, and 7 days is also the floor the Semgrep `p/default`
ruleset enforces. See
[`docs/reusable-workflows.md`](docs/reusable-workflows.md#pnpm-supply-chain-config-vs-renovate-minimumreleaseage)
for the full reconciliation rationale.

---

## Adoption CLI (`platform-sync`)

`scripts/platform-sync.mjs` is the operator-facing analogue of `mandrel sync`:
a single idempotent command a **consumer** repo runs to adopt mandrel-platform
or to repair the three drift states the founding audit flagged (split pins,
local-copy runbooks, un-simplified config). Run it from the consumer repo root:

```bash
# Pin every first-party `uses:` to a release and reconcile config + runbooks
node node_modules/mandrel-platform/scripts/platform-sync.mjs --ref mandrel-platform-v0.10.0

# Preview the plan without touching disk
node node_modules/mandrel-platform/scripts/platform-sync.mjs --ref mandrel-platform-v0.10.0 --dry-run
```

What it does (each step is idempotent — a re-run on an already-synced repo
reports `already in sync`):

1. **Pins workflow SHAs.** Resolves `--ref` (a release tag or branch) to its
   commit SHA via
   `git ls-remote`, then rewrites every
   `uses: dsj1984/mandrel-platform/...@<sha>` reference in the consumer's
   `.github/workflows/` and `.github/actions/` to that single SHA. External
   actions (`actions/checkout`, …) are left untouched. The trailing
   `# <ref>` comment is refreshed so the pin stays human-auditable and the
   Renovate auto-bump rule above can track it.
2. **Checks CI-caller naming** (advisory only, Story #173). Reports whether
   `.github/workflows/ci.yml` matches the canonical caller triplet — file
   `ci.yml`, display name `CI`, caller job id `ci` (required context
   `ci / ci-required`; see
   [reusable-workflows.md § "Canonical caller naming"](docs/reusable-workflows.md#canonical-caller-naming-the-ciyml--ci--ci-triplet)).
   Never renames or rewrites anything — a caller rename must land atomically
   with its own branch-protection ruleset context update, which is a
   deliberate per-consumer Story, not an automatic sync side-effect.
3. **Materializes runbook reference stubs** (§2.2 *link, don't copy*). Copies
   the thin stubs from `templates/runbooks/` into the consumer's
   `docs/runbooks/` **only when absent** — an already-adopted stub is skipped,
   and a full local copy (no stub marker) is surfaced as a warning to
   reconcile by hand, never silently overwritten.
4. **Materializes workflow caller templates.** Copies canonical callers from
   `templates/workflows/` (e.g. `deploy-staging.yml`, the one-paved-road
   `workflow_run` caller for `deploy-cloudflare.yml`'s CI-green guard — see
   [`docs/reusable-workflows.md`](docs/reusable-workflows.md#deploy-cloudflareyml))
   into the consumer's `.github/workflows/` — same link-don't-copy semantics:
   only when absent, and a hand-authored file without the template marker is
   surfaced as a warning rather than overwritten.
5. **Reconciles `extends`.** Prepends `github>dsj1984/mandrel-platform` to the
   consumer's Renovate `extends` and `mandrel-platform/tsconfig.base.json` to
   its `tsconfig.json` `extends`. The SSOT goes first so the consumer's own
   later entries continue to override it.

**Flags:** `--ref <ref>` (required), `--dry-run`, `--sha <40-hex>` (skip
network ref resolution — offline/test mode), `--consumer <dir>` (default:
cwd), `--templates <dir>`, `--repo <owner/repo>`, `--json` (machine-readable
result envelope on stdout).

---

## Drift control & auto-repair

The platform actively keeps consumers converged rather than trusting them to
stay in sync by hand. Two scheduled workflows run this loop against the consumer
registry in
[`scripts/pin-drift-consumers.json`](scripts/pin-drift-consumers.json):

- **Detect** — [`pin-drift.yml`](.github/workflows/pin-drift.yml) (weekly +
  `workflow_dispatch`) runs `check-pin-drift.mjs`, a cross-consumer dashboard
  that flags split pins (multiple mandrel-platform SHAs in one repo), release
  lag, npm lag, and npm-vs-workflow surface skew. Advisory by default; `--strict`
  turns drift into a failure. See the
  [pin-drift dashboard runbook](docs/runbooks/pin-drift-dashboard.md).
- **Repair** — [`platform-sync-repair.yml`](.github/workflows/platform-sync-repair.yml)
  runs `platform-repair.mjs`, which clones each drifting consumer, runs
  `platform-sync`, and opens (or updates) an **idempotent** repair PR on a stable
  head branch. Requires a fine-grained `PIN_REPAIR_TOKEN` scoped to the consumer
  repos' contents + pull-requests.

`update-semgrep-rules.mjs` is a related maintenance script that vendors Semgrep's
`p/default` ruleset — filtered to the languages actually in-repo — into
`.semgrep/rules.json` against a pinned Semgrep version, so the SAST step in
`pr-quality.yml` scans deterministically. Run it deliberately when bumping the
ruleset, not on every CI run.

---

## Runbook templates

`templates/runbooks/` ships **copyable thin-stub** operator runbooks — one per
canonical runbook in [`docs/runbooks/`](docs/runbooks). The adoption model is
*link, don't copy*: each stub links to the canonical process doc (the source of
truth) and carries only `<PLACEHOLDER>` slots for project-specific values, so an
upstream process change is picked up by re-reading the link rather than
re-authoring the stub. `platform-sync` materializes them for you — link-only, and
never clobbering a stub you have already filled in.

| Stub | Canonical runbook |
| ---- | ----------------- |
| `deploy-promotion.md` | staging → production promotion |
| `incident-response.md` | severity, escalation, postmortem |
| `database-backup-restore.md` | backup, PITR, restore/rollback |
| `observability.md` | logs, Sentry, uptime, metrics |
| `post-deploy-smoke.md` | boot-smoke gate + diagnosis |
| `environments-provisioning.md` | env model + provisioning steps |
| `dependency-update.md` | Renovate, CVE gate, catalog |
| `branch-protection-setup.md` | aggregator required-check model |

---

## Development

```bash
# Install dependencies (packageManager: pnpm@11.5.2)
pnpm install

# Bootstrap agent scaffolding
pnpm run bootstrap

# Run the guardrail-script test suite (node:test)
pnpm test
```

Every script under `scripts/` (the guardrail lints, `platform-sync`,
`platform-repair`, `update-semgrep-rules`) carries a colocated `*.test.mjs`
suite run by `pnpm test`. The `.agents/` tree is the Mandrel agent framework this
repo is developed with — dev-time only, and not shipped in the npm package.

---

## Package exports

| Export                                          | Path                                  |
| ----------------------------------------------- | ------------------------------------- |
| `mandrel-platform/tsconfig.base.json`           | `config/tsconfig.base.json`           |
| `mandrel-platform/biome.base.json`              | `config/biome.base.json`              |
| `mandrel-platform/knip.base.json`               | `config/knip.base.json`               |
| `mandrel-platform/stryker.base.json`            | `config/stryker.base.json`            |
| `mandrel-platform/commitlint.base.mjs`          | `config/commitlint.base.mjs`          |
| `mandrel-platform/dependency-cruiser.base.json` | `config/dependency-cruiser.base.json` |
| `mandrel-platform/size-limit.base.json`         | `config/size-limit.base.json`         |
| `mandrel-platform/lighthouse.base.json`         | `config/lighthouse.base.json`         |
| `mandrel-platform/lighthouse-thresholds.base.json` | `config/lighthouse-thresholds.base.json` |
| `mandrel-platform/pnpm-workspace.supply-chain.yaml` | `config/pnpm-workspace.supply-chain.yaml` |
| `mandrel-platform/edge-security`                | `config/edge-security/index.mjs`      |
| `mandrel-platform/edge-security/*`              | `config/edge-security/*`              |
| `mandrel-platform/scripts/*`                    | `scripts/*`                           |
