# mandrel-platform

Shared CI/deploy workflows, composite toolchain action, npm config package,
Renovate preset, and operator runbook templates for the Mandrel platform.

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

## Development

```bash
# Install dependencies
pnpm install

# Bootstrap agent scaffolding
pnpm run bootstrap
```

---

## Package exports

| Export                                | Path                        |
| ------------------------------------- | --------------------------- |
| `mandrel-platform/tsconfig.base.json` | `config/tsconfig.base.json` |
| `mandrel-platform/biome.base.json`    | `config/biome.base.json`    |
| `mandrel-platform/scripts/*`          | `scripts/*`                 |
