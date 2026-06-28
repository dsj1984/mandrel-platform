# mandrel-platform

Shared CI/deploy workflows, composite toolchain action, npm config package,
Renovate preset, and operator runbook templates for the Mandrel platform.

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

## Development

```bash
# Install dependencies
pnpm install

# Bootstrap agent scaffolding
pnpm run bootstrap
```

---

## Package exports

| Export                          | Path                         |
| ------------------------------- | ---------------------------- |
| `mandrel-platform/tsconfig.base.json` | `config/tsconfig.base.json`  |
| `mandrel-platform/biome.base.json`    | `config/biome.base.json`     |
| `mandrel-platform/scripts/*`          | `scripts/*`                  |
