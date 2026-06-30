# mandrel-platform

Shared CI/deploy workflows, composite toolchain action, npm config package,
Renovate preset, and operator runbook templates for the Mandrel platform.

**Docs:** [reusable-workflows.md](docs/reusable-workflows.md) (the `workflow_call`
contract) · [decisions.md](docs/decisions.md) (decision log). Status, the
consumer convergence matrix, and the forward roadmap are tracked privately.

---

## Reusable workflows

The shared `workflow_call` workflows — `pr-quality.yml` and
`deploy-cloudflare.yml` (plus `codeql.yml` and `smoke-dispatch.yml`) — and
their public input/secret contract are documented in
**[docs/reusable-workflows.md](docs/reusable-workflows.md)**. Consumers should
configure their callers from that reference (input types, defaults,
when-to-override, the frozen `{CLOUDFLARE_*, TURSO_*}` deploy secret allowlist,
the single `ci-required` aggregator context, and the pin-by-tag/SHA versioning
model).

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

#### `lighthouse.base.json`

Lighthouse's `lighthouserc.json` has no whole-file `extends`, so the
base ships the shared `ci` block — collect settings plus the four
category assertions on the `lighthouse:recommended` preset. Deep-merge
it and add your repo-specific `ci.collect.url` /
`ci.collect.staticDistDir`:

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
2. **Materializes runbook reference stubs** (§2.2 *link, don't copy*). Copies
   the thin stubs from `templates/runbooks/` into the consumer's
   `docs/runbooks/` **only when absent** — an already-adopted stub is skipped,
   and a full local copy (no stub marker) is surfaced as a warning to
   reconcile by hand, never silently overwritten.
3. **Reconciles `extends`.** Prepends `github>dsj1984/mandrel-platform` to the
   consumer's Renovate `extends` and `mandrel-platform/tsconfig.base.json` to
   its `tsconfig.json` `extends`. The SSOT goes first so the consumer's own
   later entries continue to override it.

**Flags:** `--ref <ref>` (required), `--dry-run`, `--sha <40-hex>` (skip
network ref resolution — offline/test mode), `--consumer <dir>` (default:
cwd), `--templates <dir>`, `--repo <owner/repo>`, `--json` (machine-readable
result envelope on stdout).

---

## Development

```bash
# Install dependencies
pnpm install

# Bootstrap agent scaffolding
pnpm run bootstrap
```

---

## Package exports

| Export                                          | Path                                  |
| ----------------------------------------------- | ------------------------------------- |
| `mandrel-platform/tsconfig.base.json`           | `config/tsconfig.base.json`           |
| `mandrel-platform/biome.base.json`              | `config/biome.base.json`              |
| `mandrel-platform/knip.base.json`               | `config/knip.base.json`               |
| `mandrel-platform/stryker.base.json`            | `config/stryker.base.json`            |
| `mandrel-platform/dependency-cruiser.base.json` | `config/dependency-cruiser.base.json` |
| `mandrel-platform/size-limit.base.json`         | `config/size-limit.base.json`         |
| `mandrel-platform/lighthouse.base.json`         | `config/lighthouse.base.json`         |
| `mandrel-platform/edge-security`                | `config/edge-security/index.mjs`      |
| `mandrel-platform/edge-security/*`              | `config/edge-security/*`              |
| `mandrel-platform/scripts/*`                    | `scripts/*`                           |
