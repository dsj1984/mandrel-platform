# Architecture

## Overview

`mandrel-platform` is not an application — it is the **shared CI/CD and
security substrate** a fleet of downstream repositories (currently `domio`,
`athportal`, and `Beestera/swarm-os`) consume. It ships five kinds of reusable
artifact, and its own repo dog-foods every one of them:

- **Reusable GitHub Actions workflows** (`.github/workflows/`) — the
  `workflow_call`-callable pipelines consumers pin by SHA: `pr-quality.yml`
  (tiered PR CI), `deploy-cloudflare.yml` (defence-in-depth Cloudflare deploy),
  `secret-scan-push.yml`, `codeql.yml`, `release-automation.yml`,
  `uptime-apply.yml`, and the platform-internal `smoke-dispatch.yml`. The
  remaining workflows (`ci.yml`, `pin-drift.yml`, `platform-sync-repair.yml`,
  `release-please.yml`, `issue-body-conformance.yml`) are this repo's own
  standing checks and release automation. The public `workflow_call` input and
  secret contracts are documented in [`reusable-workflows.md`](reusable-workflows.md).
- **Shared config exports** (`config/`) — base configs re-exported through the
  `package.json` `exports` map so a consumer extends them by package specifier
  instead of vendoring a copy: `tsconfig.base.json`, `biome.base.json`,
  `knip.base.json`, `stryker.base.json`, `commitlint.base.mjs`,
  `dependency-cruiser.base.json`, `size-limit.base.json`, `lighthouse.base.json`
  / `lighthouse-thresholds.base.json`, and the
  `pnpm-workspace.supply-chain.yaml` overlay. The Renovate preset
  (`config/renovate.json`, published as `default.json`) and two JSON-Schema
  contracts (`main-protection.schema.json`, `repo-settings.schema.json`) also
  live here.
- **Edge-security runtime middleware** (`config/edge-security/`) — the one
  piece of runtime code the platform ships: composable Worker/edge middleware
  (`security-headers.mjs`, `rate-limit.mjs`, `cors-hono.mjs`, `cors-astro.mjs`,
  `allowlist.mjs`) surfaced through `index.mjs` and the `./edge-security`
  export subpath.
- **Guardrail scripts** (`scripts/`) — the fail-closed checks that enforce the
  platform's invariants (SHA-pinned actions, no phantom required contexts, CVE
  policy, cross-repo pin drift, workflow portability, Wrangler baseline,
  destructive-migration guard, repo-settings / ruleset baseline). Each ships
  with a `node:test` sibling (`*.test.mjs`). `platform-sync.mjs` /
  `platform-repair.mjs` drive the fleet convergence loop.
- **Operator runbook templates** (`templates/runbooks/`) plus starter workflows
  (`templates/workflows/`) — copy-in operator procedures (deploy promotion,
  post-deploy smoke, incident response, backup/restore, environment
  provisioning, branch-protection setup, observability, dependency update) that
  a consumer localizes into its own `docs/runbooks/`.
- **Docs** (`docs/`) — this mandatory-read set (architecture, data-dictionary,
  patterns, decisions), the reusable-workflow contract reference, and the
  filled-in operator runbooks for this repo (`docs/runbooks/`).

The platform's central loop is **drift control**: publish an SHA-pinned
release, let Renovate raise bump PRs into each consumer after a hold window,
and run standing checks (`check-pin-drift.mjs`, `platform-sync.mjs`) that
surface any consumer that has drifted off the current release or split its pin
across two SHAs.

## Tech Stack

| Area                | Choice                                                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| Runtime             | Node.js 24.16.0 (pinned in `.nvmrc`, `engines.node`)                          |
| Package manager     | pnpm 11.5.2 (`packageManager`, `engines.pnpm`)                                |
| Test runner         | `node:test` (`node --test "scripts/**/*.test.mjs"`)                           |
| CI/CD               | GitHub Actions — reusable `workflow_call` workflows, SHA-pinned               |
| Release             | release-please + `release-automation.yml` (conventional commits)              |
| Dependency updates  | Renovate (shared preset published as `default.json`)                          |
| Security scanning   | Semgrep (SAST), gitleaks (secret scan), OSV / `npm audit` (CVE gate), CodeQL  |
| Deploy target       | Cloudflare via Wrangler (`deploy-cloudflare.yml`, `check-wrangler-baseline.mjs`) |
| Runtime middleware  | Edge-security ESM modules (`config/edge-security/`)                           |
| Distribution        | Published npm package (`exports` map + `files` allowlist), provenance-signed  |

There is no application database, ORM, web framework, or auth provider — the
platform is a toolchain and workflow package, not a service.

## Module Map

| Path                     | Responsibility                                                              |
| ------------------------ | -------------------------------------------------------------------------- |
| `.github/workflows/`     | Reusable `workflow_call` pipelines + this repo's own standing checks.       |
| `config/`                | Shared base configs, JSON-Schema contracts, Renovate preset.                |
| `config/edge-security/`  | Runtime edge-security middleware (the only shipped runtime code).           |
| `scripts/`               | Fail-closed guardrail checks + fleet sync/repair, each with a `*.test.mjs`. |
| `templates/`             | Copy-in runbook + starter-workflow templates for consumers.                 |
| `docs/`                  | Mandatory-read context set, workflow contract, filled operator runbooks.    |

## Key Decisions

See [`decisions.md`](decisions.md) for the architectural decision log. Mandrel
supports two first-class layouts for it: a single-file dated-entry
`decisions.md` (default) or an index + `decisions/` ADR directory — see
[`.agents/skills/core/documentation-and-adrs/SKILL.md`](../.agents/skills/core/documentation-and-adrs/SKILL.md).
