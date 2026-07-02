# Patterns

The recurring engineering patterns that define how `mandrel-platform` is built
and how consumers integrate with it. Follow these when adding a guardrail,
extending a reusable workflow, or shipping a new shared config.

## 1. SHA-pinned actions + "a bump is a PR" ratchet

Every **third-party** GitHub Action referenced by `uses:` in this repo's
workflows and composite actions MUST be pinned to a full 40-character commit
SHA — never a mutable tag (`@v4`), branch, or short SHA. A tag can be
force-moved to a malicious commit after review, and because `pr-quality.yml` is
inherited by every consumer, a tag-pinned regression has 3× blast radius across
the fleet.

- `scripts/check-action-pins.mjs` is the **ratchet**: it walks every workflow
  and composite `action.yml`, extracts each `uses:` ref (stripping the
  conventional `# v4.2.2` tag comment), and fails if any third-party ref is not
  a 40-hex SHA. It runs in `ci-required`, so a non-SHA pin can never reach
  `main`.
- **Exemptions**: first-party self-references (`dsj1984/mandrel-platform/...`)
  carry a release-tag shape and are governed by the portability lint's pin-lag
  guard instead; local `./path` and `docker://` refs have no upstream tag to
  move.
- **"A bump is a PR"**: because pins are immutable SHAs, upgrading an action is
  never an in-place tag edit — it is a Renovate PR that changes the SHA, runs
  the full gate, and is reviewed. The pinned SHA carries a `# <version>` comment
  purely as a human annotation.

## 2. Fail-closed guardrail scripts

Each `scripts/check-*.mjs` guard is a standalone Node CLI that **exits non-zero
on any violation** and is wired into `ci-required`, so the failure mode is a
blocked merge rather than a silent pass. The design invariants:

- **Exit-code contract**: `0` = clean, `1` = at least one violation. No warning
  tier that a caller can ignore.
- **Self-expiring escape hatches only**: where an exception is legitimate (the
  `audit-check.mjs` CVE allowlist), the exception carries a **required expiry
  date** so it re-fails automatically once stale — you cannot permanently
  silence a guard.
- **Tested**: every guard ships a `node:test` sibling (`check-*.test.mjs`) run
  by `npm test` (`node --test "scripts/**/*.test.mjs"`).
- **Data-driven where the fleet varies**: consumer-specific inputs live in JSON
  (`pin-drift-consumers.json`, the `*-protection`/`*-settings` instances), so
  onboarding a repo is a data edit, not a code change.

Guards in this family include `check-action-pins`, `check-required-contexts`,
`check-ruleset`, `check-repo-settings`, `check-pin-drift`,
`check-workflow-portability`, `check-wrangler-baseline`,
`check-destructive-migration`, `check-coverage-threshold`,
`check-docs-staleness`, and `audit-check`.

## 3. Reusable-workflow seam + command contract

The public surface consumers depend on is the `workflow_call` **input/secret
contract**, not the workflow YAML internals. Two rules keep the seam stable:

- **Contract over implementation**: [`reusable-workflows.md`](reusable-workflows.md)
  is the authoritative reference for the inputs and secrets that cross the
  `workflow_call` boundary. Step internals (e.g. how the SAST step bootstraps
  Semgrep) may change between releases without changing the contract.
- **Portability lint**: `check-workflow-portability.mjs` guards that a reusable
  workflow stays consumer-agnostic — no hardcoded repo-local assumptions leak
  across the seam — and enforces the first-party pin-lag guard on
  `dsj1984/mandrel-platform/...` self-references.

Consumers configure their callers from the contract page rather than reading
(or vendoring) the workflow source.

## 4. Shared config exports via the `package.json` `exports` map

The platform is a published npm package. Every shared config is exposed through
an explicit `exports` subpath so a consumer extends it **by specifier** instead
of copying a file that then drifts:

```jsonc
// consumer tsconfig.json
{ "extends": "mandrel-platform/tsconfig.base.json" }
```

- Config subpaths (`./tsconfig.base.json`, `./biome.base.json`,
  `./knip.base.json`, `./stryker.base.json`, `./commitlint.base.mjs`,
  `./dependency-cruiser.base.json`, `./size-limit.base.json`,
  `./lighthouse.base.json`, …) map one-to-one to files under `config/`.
- The runtime middleware ships behind `./edge-security` (barrel `index.mjs`) and
  the `./edge-security/*` wildcard for individual modules
  (`security-headers.mjs`, `rate-limit.mjs`, `cors-hono.mjs`, `cors-astro.mjs`,
  `allowlist.mjs`).
- The `./scripts/*` wildcard lets a consumer invoke a guardrail script straight
  from the installed package.
- The `files` allowlist (`config/`, `default.json`, `scripts/`, `templates/`)
  bounds what is published, and `publishConfig.provenance` signs the release.

Extending by specifier means a platform release propagates the new baseline to
every consumer through a single Renovate version bump — closing the loop with
the drift-control pattern above.

## 5. Drift control as the platform's control loop

Patterns 1–4 compose into one operating loop: pin immutably (1), enforce with
fail-closed guards (2) across a stable contract (3), distribute via versioned
exports (4), then **detect residual drift**. `check-pin-drift.mjs` reads
`pin-drift-consumers.json`, asserts each consumer pins a single current platform
SHA, and surfaces lag / split pins — suppressing only the lag that the Renovate
`minimumReleaseAge` hold legitimately explains. `platform-sync.mjs` /
`platform-repair.mjs` converge fleet settings toward the schema baselines. The
result is a fleet that upgrades by PR, never by silent tag movement.
