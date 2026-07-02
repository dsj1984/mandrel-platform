# Data Dictionary

`mandrel-platform` ships no application database — it has no tables, columns,
or ORM entities. Its "data" is a small set of **declarative JSON contracts**
that the guardrail scripts read and enforce. This dictionary documents each
contract: its shape, its schema (when one exists), and the script that consumes
it.

## `config/main-protection.schema.json` + `docs/runbooks/main-protection.json`

The **branch-protection contract** for `main`. The schema
(`config/main-protection.schema.json`, JSON Schema draft-07) defines the
required status checks and protection settings; the instance
(`docs/runbooks/main-protection.json`) is this repo's concrete values, and
`scripts/check-required-contexts.mjs` validates the instance against the
workflow files to prevent **phantom-check drift** (a required context that no
workflow job actually produces).

| Field                    | Type       | Meaning                                                                                     |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------- |
| `branch`                 | string     | Protected branch name (default `main`). **Required.**                                       |
| `requiredStatusChecks`   | string[]   | Exact check-context names that must pass before merge. Keep to one aggregator. **Required.** |
| `aggregatorJob`          | string     | The workflow job whose result is the single required context; matches `requiredStatusChecks[0]`. |
| `upstreamJobs`           | string[]   | Job names the aggregator depends on; validated to exist in the workflow files.              |
| `enforceAdmins`          | boolean    | Whether protection applies to admins (default `false`).                                     |
| `requireLinearHistory`   | boolean    | Require linear history / no merge commits (default `false`).                                |
| `allowForcePushes`       | boolean    | Allow force pushes to the protected branch (default `false`).                               |
| `allowDeletions`         | boolean    | Allow deleting the protected branch (default `false`).                                       |
| `_note`                  | string     | Human-readable maintainer note.                                                             |

Consumers copy `main-protection.json` into their own `docs/runbooks/` and set
`upstreamJobs` to match their CI job names. Only the aggregator name goes in
`requiredStatusChecks`; upstream job names are never added directly.

## `config/repo-settings.schema.json` + `docs/runbooks/repo-settings.json`

The **repository-settings baseline** — merge methods, squash-commit source,
auto-merge, Actions default token permissions, and PR-approval-by-Actions the
fleet converges on. `scripts/check-repo-settings.mjs` validates each consumer's
live settings (`gh api repos/{owner}/{repo}`) against the instance;
`scripts/platform-sync.mjs --apply-settings` applies the safe subset. Non-blocking
by design (drift is reported, never a hard gate on a consumer's `main`).

Required fields: `allowSquashMerge`, `allowMergeCommit`, `allowRebaseMerge`,
`squashMergeCommitTitle`, `squashMergeCommitMessage`, `deleteBranchOnMerge`,
`allowAutoMerge`, `actionsDefaultWorkflowPermissions`,
`actionsCanApprovePullRequestReviews`. The fleet baseline is squash-only
(`allowSquashMerge: true`, the other two `false`).

## `scripts/pin-drift-consumers.json`

The **consumer registry** for `scripts/check-pin-drift.mjs`. Each entry is one
downstream repo that pins the platform's reusable workflows / composite actions
via `uses: dsj1984/mandrel-platform/...@<sha>`. The drift checker enumerates
each consumer's `.github/workflows/*` and reads its `package.json` over the
GitHub API, extracts every mandrel-platform `uses:` pin plus the
`mandrel-platform` npm dependency version, and asserts a single SHA per consumer
plus lag / surface skew versus the latest platform release.

| Field                    | Type       | Meaning                                                                        |
| ------------------------ | ---------- | ------------------------------------------------------------------------------ |
| `platformRepo`           | string     | The platform repo slug (`dsj1984/mandrel-platform`).                            |
| `minimumReleaseAge`      | string     | Renovate supply-chain hold window (currently `3 days`); lag inside it is `holding`, not drift. Kept in lockstep with the Renovate preset. |
| `consumers[]`            | object[]   | One entry per downstream repo.                                                  |
| `consumers[].name`       | string     | Short display name.                                                            |
| `consumers[].repo`       | string     | `owner/repo` slug.                                                             |
| `consumers[].branch`     | string?    | Optional; defaults to the repo's default branch.                              |

A **split pin** (more than one distinct platform SHA in one consumer) is a real
error and is never suppressed by the hold window.

## Audit CVE allowlist (`audit-allowlist.json`)

`scripts/audit-check.mjs` is the CVE gate: it blocks all unsuppressed High and
Critical vulnerabilities in the production dependency graph. A **self-expiring
allowlist** lets teams record known, accepted CVEs. The file path defaults to
`audit-allowlist.json` in the invocation directory (override with `--allowlist`).
It is a JSON array of entries:

| Field       | Type   | Meaning                                                                       |
| ----------- | ------ | ----------------------------------------------------------------------------- |
| `id`        | string | GitHub Advisory ID (`GHSA-…`) or CVE ID. **Required.**                         |
| `reason`    | string | Why the CVE is accepted (e.g. "no fix available; mitigated by X"). **Required.** |
| `expires`   | string | ISO-8601 date. **Required** — a passed expiry is treated as un-suppressed and fails the gate. |

The required-expiry rule is the fail-closed lever: an allowlist entry cannot
silence a CVE forever, so the gate re-opens automatically when the accepted risk
goes stale.

## Edge-security allowlist (`config/edge-security/allowlist.mjs`)

Not a JSON contract but the runtime analogue: an ESM module exporting the
origin/IP allowlist middleware consumed by `config/edge-security/index.mjs` and
the CORS helpers. It is code, not data, and is covered in
[`patterns.md`](patterns.md) under the shared-config-export pattern.
