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
lint + format-check → typecheck → unit → contract → e2e/smoke → migration-guard → security → osv-scan
```

Every tier is independently enable-toggled, so a repo can opt out of tiers it
has not built yet (the [destructive-migration guard](#destructive-migration-guard-enable-migration-guard)
is **opt-in** — default off). A single aggregator job,
[`ci-required`](#the-ci-required-aggregator), is the only branch-protection
context a consumer needs to register.

Independently of the tiers, every job starts with a non-blocking
[**egress audit**](#egress-audit-enable-harden-runner) step
(`step-security/harden-runner`, audit mode) on GitHub-hosted runners, so each
consumer inherits a network-egress baseline for free.

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
| `coverage-threshold` | number | `0`            | Minimum coverage percentage the **unit** job must meet. `0` (default) disables the gate — current behaviour for non-adopters. When `> 0`, the unit job **fails** if measured coverage is below the floor. See [Coverage threshold gate](#coverage-threshold-gate-coverage-threshold). |
| `coverage-metric`  | string  | `'lines'`        | Which coverage metric the floor asserts: `lines`, `statements`, `functions`, or `branches` (read from `total.<metric>.pct`). Ignored when `coverage-threshold` is `0`. |
| `enable-security`  | boolean | `true`           | Set `false` to skip the whole security tier (secret scan + SAST). See [Security tier](#security-tier-enable-security--enable-sast).             |
| `enable-sast`      | boolean | `true`           | Set `false` to keep the PR-diff secret scan but skip the Semgrep SAST sub-step — use when SAST runs via a dedicated CodeQL/GHAS workflow.       |
| `semgrep-config`   | string  | `'vendored'`     | Semgrep ruleset for the SAST sub-step. Default `'vendored'` resolves to this reusable workflow's own checked-out, platform-controlled snapshot at `.semgrep/rules.json` (see [SAST ruleset provenance](#sast-ruleset-provenance-and-update-process)) — NOT the live registry. Override with a registry ref (e.g. `'p/security-audit'`) or a path. **`'auto'` is unsupported.** |
| `sast-exclude`     | string  | `''`             | Extra Semgrep `--exclude` globs, space- or comma-separated (e.g. `'dist coverage tests/fixtures'`), **appended** to the built-in `.agents` exclude. Set to drop generated code / fixtures from the SAST target set. |
| `gitleaks-version` | string  | `'8.30.1'`       | Pinned gitleaks release version (no leading `v`) for the secret scan. Bump deliberately; the per-platform asset checksum is pinned to match.    |
| `toolchain-cache`  | string  | `'true'`         | Passed through to `setup-toolchain`'s `cache` input. Set `'false'` on self-hosted runners with a warm pnpm store.                              |
| `pnpm-dest`        | string  | `''`             | Passed through to `setup-toolchain`'s `pnpm-dest`. Self-hosted callers should set this (e.g. the `runner.temp/pnpm` path) to avoid `$HOME` races. |
| `trust-lockfile`   | string  | `'false'`        | Passed through to `setup-toolchain`'s `trust-lockfile` input on **all five** `setup-toolchain` call sites (`Lint & format`, `Typecheck`, `Unit`, `Contract`, `E2E / Smoke`). Appends `--trust-lockfile` to the install step when `'true'`. Default `'false'` is byte-for-byte identical to today's behaviour. See [`trust-lockfile` — transitional lockfile-policy exception](#trust-lockfile--transitional-lockfile-policy-exception). |
| `enable-harden-runner` | boolean | `true`       | Adds `step-security/harden-runner` (egress **audit** mode, non-blocking) as the first step of every tier job. Effective on GitHub-hosted `ubuntu-latest`; a no-op on self-hosted runners. Set `false` to opt out entirely. See [Egress audit](#egress-audit-enable-harden-runner). |
| `enable-osv-scan`  | boolean | `true`           | Enable the OSV-scanner advisory tier (scans the lockfile/manifest tree for known dependency advisories via a pinned, checksum-verified binary; no SARIF/GHAS). Set `false` to skip. See [OSV advisory tier](#osv-advisory-tier-enable-osv-scan).                                  |
| `osv-fail-on-severity` | string | `'high'`     | Lowest CVSS severity band that **fails** the OSV-scan tier (and therefore `ci-required`): `critical` (≥9.0), `high` (≥7.0), `medium` (≥4.0), `low` (>0), or `none` (any advisory, including unscored). Advisories below the band are reported as warnings without blocking. |
| `osv-scanner-version` | string | `'2.4.0'`     | Pinned OSV-scanner release version (no leading `v`) for the advisory tier. Bump deliberately; the per-platform asset checksum is pinned to match.                                                                                                                              |
| `osv-allowlist-path` | string | `'.osv-allowlist.json'` | Path (relative to the consumer repo root) to an optional OSV per-finding suppression/allow-list file. A missing file is a no-op — identical gating behaviour to having no allow-list at all. See [Per-finding suppression / allow-list](#per-finding-suppression--allow-list-osv-allowlist-path). |

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

> **`semgrep-config` constraints.** The default `'vendored'` resolves to this
> reusable workflow's own checked-out, platform-controlled ruleset snapshot
> (see [SAST ruleset provenance](#sast-ruleset-provenance-and-update-process)
> below) — no Semgrep AppSec Platform login required, and no live registry
> call at scan time. You may override with a concrete registry ref (e.g.
> `'p/security-audit'`) or your own path, which **opts back into** registry
> drift for that input — a deliberate per-caller choice, not the platform
> default. Do **not** pass `'auto'`: it requires Semgrep metrics to be on (it
> contacts `semgrep.dev` to tailor the ruleset), which is incompatible with
> the step's `--metrics=off` privacy posture.

> **GHAS alternative.** Repos that *do* have GitHub Advanced Security can run
> CodeQL (see [`codeql.yml`](#codeqlyml)) for blocking Code Scanning instead of
> the Semgrep sub-step — set `enable-sast: false` here and surface CodeQL as a
> required check. The Semgrep path is the no-GHAS-required default so every
> consumer inherits an effective gate regardless of plan.

> **Excluding paths from SAST (`sast-exclude`).** The SAST sub-step always
> excludes the vendored `.agents` framework tree (a consumer cannot edit it)
> and, when `semgrep-config` is `'vendored'`, the `_mandrel-platform-sast`
> side-checkout directory that carries the ruleset snapshot (mandrel-platform's
> own source tree — never the caller's code, so it must never enter the
> caller's finding set). Use `sast-exclude` to **append** further `--exclude`
> globs — space- or comma-separated — for generated code, build output, or
> test fixtures you don't want Semgrep to scan (e.g.
> `'dist coverage tests/fixtures'`). Empty (the default) leaves only the
> built-in excludes in effect.

#### SAST ruleset provenance and update process

**The incident.** The 0.14.0 release was blocked when the live registry alias
`'p/default'` silently grew a family of pnpm supply-chain rules
(`pnpm-block-exotic-sub-dependencies`, `pnpm-trust-policy`,
`pnpm-minimum-release-age`) plus `secrets-inherit`. The security tier already
pinned the Semgrep **binary** (`1.97.0`), but `--config p/default` still
pulled **live, unpinned rules** from the registry — so a full-tree (non-PR)
scan turned red with **zero code change** on our side. The Semgrep binary pin
alone was not the deterministic-input guarantee it looked like.

**The fix.** `semgrep-config` defaults to `'vendored'` (Story #132), which
resolves to a **committed snapshot** of the registry ruleset at
[`.semgrep/rules.json`](../.semgrep/rules.json) — not the live alias. The
snapshot is the FULL `p/default` rule set resolved once against the pinned
Semgrep `1.97.0` binary, then **filtered to the languages this platform's
reusable workflows and consumer trees actually scan**: `js`, `ts`,
`typescript`, `yaml`, `json`, `bash`, `dockerfile`, `generic`, and `regex`.
Full `p/default` ships 1074 rules across every language Semgrep supports
(Python, Java, Go, Ruby, HCL, PHP, Solidity, Scala, C#, …); none of those
non-JS/TS language packs can ever fire in a TypeScript/JavaScript platform
tree, so keeping them would only bloat the committed file and scan time for
no signal. The filtered snapshot keeps 313 of the 1074 rules — including, by
design, **every** `yaml`-language rule (where `secrets-inherit` and the pnpm
supply-chain rules live) and every `js`/`ts`/`generic` rule (eval, command
injection, taint flows — the vuln classes that made `p/default` the chosen
default over the narrower `p/ci`).

> **One rule dropped for a reason other than language scope.**
> `generic.secrets.security.detected-slack-webhook` is excluded from the
> snapshot, not because its language is out of scope, but because its own
> rule body embeds a credential-shaped placeholder literal (an inert
> `pattern-not` example, not a live secret) that GitHub push protection's
> secret scanner flags on every `git push` regardless of context. We did
> **not** rewrite or obfuscate that literal to evade the scanner — weakening
> one security control to satisfy another is out of bounds. Dropping the
> single rule (named, with rationale, in `update-semgrep-rules.mjs`'s
> `EXCLUDED_RULE_IDS`) is the transparent fix: it costs one detection rule
> out of 313, and the gitleaks sub-step in the same security tier already
> covers Slack-webhook-shaped credential findings via a dedicated,
> purpose-built secret scanner.

A consumer's `pr-quality.yml@<ref>` call gets the ruleset snapshot that
shipped with the **exact resolved commit** its pin points to: the SAST job
checks out `dsj1984/mandrel-platform` a second time (sparse, `.semgrep/`
only) at `github.job_workflow_sha` — the same resolved-ref
single-source-of-truth primitive already used by `deploy-cloudflare.yml`'s
`deploy-summary` job (Story #110) — so "which workflow ran" and "which
ruleset it scanned with" can never drift apart.

**Bumping the ruleset is a reviewable PR**, mirroring the
[action-pin ratchet](#the-action-pin-ratchet)'s "bump is a PR" discipline and
the [OSV-scanner version pin](#osv-advisory-tier-enable-osv-scan):

```bash
node scripts/update-semgrep-rules.mjs
git diff .semgrep/rules.json
```

The script re-resolves `p/default` against the pinned Semgrep version
(`--semgrep-pin` to override; keep it in lockstep with the SAST step's own
`SEMGREP_PIN` literal), re-applies the language filter, and rewrites
`.semgrep/rules.json` deterministically (rules sorted by `id`, so a re-run
with no upstream changes produces a byte-identical file and a re-run with
upstream changes produces a reviewable, rule-level diff). Commit the result
as a deliberate `chore(security):` ruleset bump — a new rule lands because a
human reviewed and merged it, never because the registry changed underneath
a running gate.

**`secrets-inherit` disposition (AC).** The `secrets-inherit` rule
(`yaml.github-actions.security.secrets-inherit.secrets-inherit`) is **kept in
the curated set**, not excluded. `secrets: inherit` is this platform's
**documented consumer deploy-caller pattern** — every "minimal caller"
snippet in this doc (`pr-quality.yml`, `deploy-cloudflare.yml`,
`release-automation.yml`) shows a consumer's own workflow forwarding its
secrets to the reusable call with `secrets: inherit`, scoped to the frozen
`{CLOUDFLARE_*, TURSO_*}` surface those reusable workflows actually consume
(see [Secrets](#secrets)). mandrel-platform's **own** workflows never use a
live `secrets: inherit` line — every occurrence in this repo's `.yml` files
is inside a documentation comment showing the caller-side pattern — so the
rule is a structural no-op against this repo's own tree and exists purely to
flag the pattern for **consumer** repos that copy it verbatim without
realizing the scope it forwards. A consumer that intentionally adopts the
documented pattern suppresses the finding with an inline
`# nosemgrep: yaml.github-actions.security.secrets-inherit.secrets-inherit`
comment on the `secrets: inherit` line, with a comment citing this section as
the rationale — not a blanket per-repo exemption. We deliberately did **not**
migrate every caller to an explicit secret map: the frozen,
documented-surface model in [Secrets](#secrets) already gives a reviewer the
same auditability an explicit map would, without the per-input duplication
tax across three consumer repos.

### pnpm supply-chain config vs. Renovate `minimumReleaseAge`

Semgrep's `p/default` registry ruleset (consumed by the SAST sub-step above)
flags pnpm workspaces that don't set the pnpm-native supply-chain guards —
`blockExoticSubdeps`, `trustPolicy`, and `minimumReleaseAge` — with a rule
floor of **10080 minutes (7 days)** for the latter. These are legitimate
hardening: the [egress audit](#egress-audit-enable-harden-runner) blocklist
below literally names the `shai-hulud` npm worm as a threat class this class
of rule defends against.

The platform ships a canonical block at
[`config/pnpm-workspace.supply-chain.yaml`](../config/pnpm-workspace.supply-chain.yaml),
exported as `mandrel-platform/pnpm-workspace.supply-chain.yaml` (see
[README — Package exports](../README.md#package-exports) and
[README — pnpm supply-chain config](../README.md#pnpm-supply-chain-config)
for the copy-merge usage, mirroring how `tsconfig.base.json` / `biome.base.json`
are distributed):

```yaml
blockExoticSubdeps: true
trustPolicy: no-downgrade
minimumReleaseAge: 10080
```

**Policy reconciliation.** The platform's pre-existing supply-chain gate is
the Renovate preset's `minimumReleaseAge: "3 days"` (4320 minutes, see
`default.json` and [Renovate preset](../README.md#renovate-preset) above).
The pnpm-native rule's floor is 7 days (10080 minutes). These two settings
are **not duplicates** and are **not reconciled to a single number** — they
govern different lifecycle moments:

| Setting                              | Governs                                                  | Value             |
| ------------------------------------- | --------------------------------------------------------- | ----------------- |
| Renovate `minimumReleaseAge`          | When a dependency-bump **PR** is raised                   | 3 days (4320 min) |
| pnpm `minimumReleaseAge`              | When `pnpm install` will **resolve** a version at all     | 7 days (10080 min)|

The canonical fleet value for the pnpm-side setting is the **7-day floor**
(adopt, don't lower it) — a `pnpm install` resolving a version sooner than
Renovate would even propose bumping to it is not a meaningful protection gap,
but lowering pnpm's gate below the Semgrep rule's floor leaves the SAST
finding perpetually red. If a future change wants the two values converged
to one number, that is a Renovate preset cadence change tracked separately
(see `config/renovate.json` / `default.json`), not a pnpm-config change.

**Enforcement.** The pnpm supply-chain rules stay active in the Semgrep
ruleset consumed by the SAST sub-step above — see the SAST ruleset
pinning/vendoring work tracked in Story #132, which keeps these rules
enforced deliberately rather than relying on registry drift.

### `trust-lockfile` — transitional lockfile-policy exception

`setup-toolchain` (the composite action every `pr-quality.yml` tier delegates
its install step to) runs `pnpm install --frozen-lockfile` with no way for a
consumer to pass additional install flags. That collided with the [pnpm
supply-chain config](#pnpm-supply-chain-config-vs-renovate-minimumreleaseage)
above (Story #133): a consumer lockfile carrying a `TRUST_DOWNGRADE` or
`MINIMUM_RELEASE_AGE_VIOLATION` finding hard-fails
`ERR_PNPM_LOCKFILE_RESOLUTION_VERIFICATION` on **every** tier that delegates
to `setup-toolchain` for its install, with no remediation available from the
consumer side — `TRUST_DOWNGRADE` findings in particular are not age-based and
never clear on their own by waiting out `minimumReleaseAge`.

**What it does.** `trust-lockfile` (string, default `'false'`) is threaded
through `pr-quality.yml`'s `workflow_call` inputs and passed to **all five**
`setup-toolchain` invocations (`Lint & format`, `Typecheck`, `Unit`,
`Contract`, `E2E / Smoke`). When `'true'`, `setup-toolchain`'s install step
appends `--trust-lockfile` to the `pnpm install --frozen-lockfile` command it
already runs.

**Backwards compatible by default.** A consumer that does not set the input
sees **byte-for-byte identical** behaviour to today on every one of the five
jobs: the default `'false'` means the install step remains plain
`pnpm install --frozen-lockfile`, with no `--trust-lockfile` appended anywhere.

> **Minimal opt-in caller.**
>
> ```yaml
> jobs:
>   pr-quality:
>     uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<sha> # <tag>
>     with:
>       trust-lockfile: 'true'
>     secrets: inherit
> ```

**Transitional, not a permanent bypass.** `trust-lockfile: 'true'` is a
**documented exception**, not a standing configuration. It exists to unblock a
consumer whose lockfile carries findings it has consciously accepted — the
same review-and-document posture `security-baseline.md` requires of any
deferred security finding — while the underlying entries either get bumped
past the pnpm supply-chain policy's checks or a maintainer risk-accepts them
permanently through some other mechanism. Consumers should treat it as
temporary: drop `trust-lockfile` (or revert to the default `'false'`) once the
flagged lockfile entries clear the policy naturally (age out past
`minimumReleaseAge`, or the flagged package is bumped past the
`trustPolicy: no-downgrade` trigger). Leaving it permanently `'true'` defeats
the purpose of the pnpm supply-chain gate it is working around — it should be
reviewed the same way any other standing security exception is, not treated as
a one-time toggle-and-forget.

**Scope.** This is a targeted `--trust-lockfile` passthrough, not a general
arbitrary pnpm-install-flags mechanism, and it does not change the canonical
pnpm supply-chain config values from #133 — it only lets a consumer opt a
specific install invocation out of the lockfile-resolution verification those
values enforce.

### Egress audit (`enable-harden-runner`)

`pr-quality.yml` runs [`step-security/harden-runner`](https://github.com/step-security/harden-runner)
in **`egress-policy: audit`** mode as the **first step of every tier job**, so
every consumer inherits a network-**egress baseline** on each PR run with zero
configuration. It is on by default (`enable-harden-runner: true`).

**Audit mode only reports — it never blocks.** harden-runner records the
outbound network connections each job makes and surfaces them in the run's
job summary (and the StepSecurity dashboard). It does **not** deny any
traffic, so adopting it **cannot break a build**. The value is the baseline:
once you have reviewed what each job legitimately talks to, you can tighten to
`block` mode with an explicit allowlist (see
[Tightening from audit to block](#tightening-from-audit-to-block) below).

> **Why audit, not lint-only.** Manually SHA-pinning third-party actions
> (enforced by the [action-pin ratchet](#the-action-pin-ratchet)) closes the
> *tag-mutation* hole, but it leaves the *runtime-egress* blind spot open: a
> pinned-but-compromised action (or a compromised transitive dependency it
> pulls at run time) can still exfiltrate to an unexpected host. Audit mode is
> the zero-risk first half of closing that blind spot — it gives every
> consumer a free egress baseline without changing any build outcome.

**Runner-aware (self-hosted no-op).** The harden-runner step is gated to the
GitHub-hosted `ubuntu-latest` runner — the only environment where the action
itself installs the monitor. On **self-hosted runners** (when `runner` is a
JSON-array label string such as `'["self-hosted","domio-runner"]'`) the step is
**skipped entirely**: harden-runner supports self-hosted runners by shipping
its agent **in the runner image**, with **no workflow step required**, so
running the action there would be redundant. This keeps the
`domio-runner` / `athportal-runner` self-hosted callers fully supported with no
change to their YAML. To get egress monitoring on a self-hosted runner, install
the agent on the runner host per the
[harden-runner self-hosted docs](https://docs.stepsecurity.io/harden-runner) —
it is independent of this input.

The action is itself **SHA-pinned** (`step-security/harden-runner@9af89fc…`
`# v2.19.4`), so it is subject to the same pin discipline the
[action-pin ratchet](#the-action-pin-ratchet) enforces on every other
third-party action.

#### Tightening from audit to block

Audit mode is the safe default; **block mode** is a later, deliberate step
taken **per consumer** once its baselines have been reviewed. The migration is
intentionally NOT automatic — flipping the shared workflow to `block` would
break every consumer whose baseline you have not yet vetted. The path:

1. **Collect a baseline.** Let `pr-quality.yml` run in audit mode for a few
   PRs. Open each run's **harden-runner job summary** (or the StepSecurity
   dashboard) and note every outbound host each job legitimately contacts
   (npm registry, Turbo remote cache, GitHub API, your deploy target, …).
2. **Build the allowlist** from those hosts.
3. **Flip to block at the *caller*,** not by editing the shared workflow. A
   consumer pins its own caller to a harden-runner block step ahead of the
   reusable call, or — once this input grows a block toggle in a future
   release — sets it at the call site. The reference block-mode shape is:

   ```yaml
   - uses: step-security/harden-runner@<sha> # <tag>
     with:
       egress-policy: block
       allowed-endpoints: >
         registry.npmjs.org:443
         api.github.com:443
         # …one host:port per line, from your reviewed baseline
   ```

4. **Roll out one consumer at a time.** Because each repo's legitimate egress
   set differs, block mode is a **per-consumer** decision (mirroring the
   `enable-migration-guard` opt-in model), never a single platform-wide flip.

> **Out of scope for this release.** Flipping harden-runner to `block` in the
> shared workflow and shipping per-consumer egress allowlists are deliberately
> deferred — this release establishes the audit baseline only. See Story #112.

#### The action-pin ratchet

The egress audit closes the *runtime* half of the supply-chain threat; a
**static action-pin ratchet** closes the *tag-mutation* half. It is not a
`pr-quality.yml` input — it is a gate in **mandrel-platform's own** CI
(`ci.yml`, a `needs:` of that repo's `ci-required`): on every PR it walks every
workflow and composite `action.yml` and **fails if any third-party `uses:` is
pinned to anything other than a full 40-character commit SHA**. A mutable tag
(`@v4`) can be force-moved to a malicious commit after review; the ratchet
makes that un-mergeable. First-party `dsj1984/mandrel-platform/*` self-refs are
exempt (they are governed by the portability lint's pin-lag guard). Because the
shared workflows ship from this repo, **consumers inherit fully SHA-pinned
workflows automatically** — no per-repo ticket. A consumer that wants the same
guard on *its own* workflows copies `scripts/check-action-pins.mjs` into its
`scripts/` and runs it in CI:

```yaml
- name: Lint third-party action pins
  run: node scripts/check-action-pins.mjs --first-party-owner <owner/repo>
```

The exact classification (third-party vs first-party vs local vs `docker://`)
and the 40-char-SHA assertion are unit-tested in
`scripts/check-action-pins.{mjs,test.mjs}` on the platform repo.

### OSV advisory tier (`enable-osv-scan`)

A **dependency-advisory tier** that scans the lockfile/manifest tree for known
advisories and gates the PR on findings at or above a configurable severity.

**Why it exists.** Renovate *bumps* dependency versions but never alerts on
advisories for versions sitting **un-bumped** — inside its `minimumReleaseAge`
hold or behind a major-version gate — leaving a window with **no live CVE
signal**. This tier closes that window. It is the **third security signal**
alongside the [secret scan and SAST](#security-tier-enable-security--enable-sast)
sub-steps of the security tier.

**Private-repo-capable, no GHAS.** Like the secret/SAST tiers, the OSV-scan job
runs a **pinned, checksum-verified binary** directly (`osv-scanner scan source
-r .`) and surfaces findings in the **run log + job summary** — **no SARIF /
Code Scanning upload**, so the gate is load-bearing on a **private repo with no
GitHub Advanced Security**. (This is the same constraint that made gitleaks and
Semgrep the chosen gates over CodeQL.) The per-platform asset (darwin/linux ×
amd64/arm64) is verified against a **pinned SHA-256** before execution.

It is **on by default** (`enable-osv-scan: true`). When enabled, the `osv-scan`
job is a [`needs:` of `ci-required`](#the-ci-required-aggregator), so it is
**branch-protection-load-bearing** through the single aggregator context — no
new required check to register.

#### Severity-to-gate behaviour (`osv-fail-on-severity`)

OSV-scanner's own exit code is non-zero on **any** advisory regardless of
severity. This tier does **not** gate on that coarse exit code — instead it
emits JSON, buckets each advisory's **CVSS base score** (the OSV group's
`max_severity`) into a severity band, and decides the gate from
`osv-fail-on-severity` (default **`high`**):

| Band       | CVSS base score | Fails the tier when `osv-fail-on-severity` is… |
| ---------- | --------------- | ---------------------------------------------- |
| `critical` | ≥ 9.0           | `critical`, `high`, `medium`, `low`, `none`    |
| `high`     | ≥ 7.0           | `high`, `medium`, `low`, `none`                |
| `medium`   | ≥ 4.0           | `medium`, `low`, `none`                        |
| `low`      | > 0             | `low`, `none`                                  |
| `none`     | unscored        | `none` only                                    |

- A finding **at or above** the configured band **fails the `osv-scan` job**
  (and therefore `ci-required`, blocking the merge).
- A finding **below** the band is reported as a **warning** in the job summary
  — it never blocks.
- Set `osv-fail-on-severity: critical` to gate on criticals only; set `none` to
  fail on **any** advisory including unscored ones (strictest).
- A repo with **no recognized lockfile/manifest** is a **no-op pass** (nothing
  to advise on).

Every run writes a markdown advisory table (severity, CVSS score, advisory id,
package, version, source) to the **job summary** and the run log, so findings
are visible with no GHAS dependency.

> **Out of scope.** This tier does **not** auto-remediate advisories — Renovate
> already owns version bumping. It is the *signal*; the *fix* is a Renovate (or
> manual) bump. A `dependabot.yml` template is **not** shipped (OSV is
> vendor-neutral and works on private-no-GHAS repos, the deciding constraint).

> **Minimal opt-out / tuning caller.**
>
> ```yaml
> jobs:
>   pr-quality:
>     uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@<sha> # <tag>
>     with:
>       # osv-fail-on-severity: critical   # gate on criticals only (default: high)
>       # enable-osv-scan: false           # opt out of the advisory tier entirely
>       # osv-allowlist-path: '.osv-allowlist.json'  # per-finding suppression file
>     secrets: inherit
> ```

#### Per-finding suppression / allow-list (`osv-allowlist-path`)

The OSV tier is otherwise a **blunt CVSS-band gate**: every finding at or
above `osv-fail-on-severity` blocks `ci-required`, with no way to honor a
finding a consumer has already triaged and risk-accepted (e.g. a transitive
dependency reachable only through build tooling, never shipped in the
deployed artifact). `osv-allowlist-path` (default `.osv-allowlist.json`, the
consumer repo root) closes that gap with a checked-in JSON suppression file —
mirroring the PR-diff baseline scoping the gitleaks/Semgrep tiers already use
to narrow what blocks a given PR, but keyed by advisory id instead of diff
scope.

**Backwards compatible by default.** A consumer with **no file** at
`osv-allowlist-path` sees **byte-for-byte identical** gating behaviour to the
tier with no suppression mechanism at all — the allow-list load is a no-op
when the file is absent. Adopting the mechanism is opt-in: a consumer only
sees a behaviour change once it checks in a file at that path.

**File shape.** Either a bare JSON array of entries, or an object with a
`suppressions` array (both are accepted so the file can carry top-level
comments-as-keys if a consumer wants metadata alongside the array):

```json
[
  {
    "id": "GHSA-xxxx-yyyy-zzzz",
    "reason": "Transitive via @astrojs/cloudflare's bundled wrangler/miniflare build tooling; never shipped in the deployed Worker bundle.",
    "revisitBy": "2026-09-30",
    "package": "undici",
    "ecosystem": "npm"
  }
]
```

| Field       | Required | Meaning                                                                                          |
| ----------- | -------- | -------------------------------------------------------------------------------------------------- |
| `id`        | yes      | The OSV/GHSA id as it appears in OSV-scanner's report (matches against the finding's aliased ids). |
| `reason`    | yes      | Free-text risk-acceptance rationale. Mirrors the `security-baseline.md` requirement that deferred findings be documented with a review date. |
| `revisitBy` | yes      | `YYYY-MM-DD`. Once today is past this date, the suppression **re-gates** the finding as if unsuppressed (see below) — a suppression cannot silently shield a finding forever. |
| `package`   | no       | Scopes the match to a specific package name in addition to the id.                                 |
| `ecosystem` | no       | Scopes the match to a specific ecosystem (e.g. `npm`) in addition to the id.                        |

**Validation is strict, not best-effort.** An entry missing `id`, `reason`,
or a valid `revisitBy` date fails the job with a clear `::error::` pointing at
the offending entry's index — it never silently falls through to "matches
everything" or "matches nothing." A present-but-unparsable allow-list file
(invalid JSON, wrong top-level shape) fails the same way.

**Matching.** A finding is suppressed when its OSV/GHSA id (or one of its
aliased ids in the OSV-scanner group) matches an entry's `id`, and — when the
entry specifies `package` and/or `ecosystem` — those also match the finding's
package/ecosystem. Findings with **no** corresponding allow-list entry
continue to gate exactly as before; the allow-list only ever narrows what
blocks, never widens it.

**Expiry re-gating.** A finding matched by an entry whose `revisitBy` is in
the past is treated as **unsuppressed** for the pass/fail decision (it moves
back into the blocking bucket) and is additionally called out in its own
"past `revisitBy`" section of the job summary, so a stale suppression turns
back into a hard failure rather than aging into permanent silence.

**Job summary sections.** The `$GITHUB_STEP_SUMMARY` table is split into
clearly labeled, independent sections so a reviewer can tell suppressed,
warning, and blocking findings apart at a glance:

- An optional **"past `revisitBy`"** callout (only present when at least one
  suppression has expired), naming the finding, its original `revisitBy`,
  and the original `reason`.
- **Blocking** — findings at or above `osv-fail-on-severity` with no
  suppression (or an expired one). Fails the job.
- **Warning — below gate** — findings under `osv-fail-on-severity`, exactly
  as in the un-suppressed tier. Never blocks.
- **Suppressed via allow-list** — findings that matched a live (non-expired)
  allow-list entry, along with the entry's `revisitBy` and `reason` for
  traceability. Reported, never blocking.

> **Out of scope.** This mechanism is the platform tier's own suppression
> surface; it does not reconcile with consumer-local CVE gates (e.g. a
> hand-rolled `scripts/audit-check.mjs`) — those keep their own allow-lists
> unchanged. It also does not change the default `osv-fail-on-severity` or
> `enable-osv-scan` values; suppression narrows what blocks within whatever
> band a consumer has already configured.

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

#### Consumer rollout

The platform ships the gate **off by default**, so adopting a floor is a
per-consumer decision (each repo picks its own floor value — merged vs.
per-project coverage policy is left to the consumer). Adoption is tracked in
these consumer tickets:

| Consumer | Adoption ticket |
| -------- | --------------- |
| domio    | [dsj1984/domio#1563](https://github.com/dsj1984/domio/issues/1563) |
| athportal | [dsj1984/athportal#2029](https://github.com/dsj1984/athportal/issues/2029) |
| swarm-os | [Beestera/swarm-os#158](https://github.com/Beestera/swarm-os/issues/158) |

Each consumer sets `coverage-threshold` (and optionally `coverage-metric`) on
its `pr-quality.yml` caller and emits a `coverage-summary.json` from its unit
step. Until a consumer opts in, its CI behaviour is unchanged.

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
require-ci-green → secret-isolation-audit → check-env → pre-migration-snapshot → migrate → deploy → boot-smoke → deploy-summary
```

`pre-migration-snapshot` and `migrate` only run when `migrate: true`;
`boot-smoke` only runs when `smoke: true` (the default).

### CI-green guard (`require-ci-green`)

> Story #175 (operator decision 2026-07-01, D4: one paved road — every
> consumer converges on `workflow_run` for staging).

`github.event` inside a reusable workflow is the **caller's** event, so this
workflow can own the CI-green guard even though it cannot own the caller's
`on:` block. The first job, `require-ci-green`, evaluates that event:

- **`workflow_run` events** — skip-with-notice (every downstream job reports
  `skipped`) unless `github.event.workflow_run.conclusion == 'success'`.
  `workflow_run` fires on **both** a successful and a failed upstream run, so
  this guard is load-bearing: without it, a red CI run on `main` would still
  trigger a deploy.
- **Every other event** (`workflow_dispatch`, `push`, `pull_request`, …) —
  passes through unconditionally. These triggers are operator- or
  branch-protection-intentional and carry no upstream conclusion to gate on.

Before this guard existed, every consumer gating staging on CI hand-copied the
same caller-side `preflight` job to re-implement this exact check (see
athportal's / swarm-os's `deploy-staging.yml` history). A `workflow_run`
caller now needs **no caller-side preflight guard at all** — see the
canonical [`templates/workflows/deploy-staging.yml`](https://github.com/dsj1984/mandrel-platform/blob/main/templates/workflows/deploy-staging.yml)
caller template, which `platform-sync` materializes into a consumer's
`.github/workflows/` (link-don't-copy, same semantics as the runbook stubs —
see [`scripts/platform-sync.mjs`](../README.md#adoption-cli-platform-sync)).

### Resolved-ref deploy summary (single source of truth)

> Story #110. The final `deploy-summary` job (`if: always()`) emits the
> **runtime-resolved** ref of this reusable workflow into
> `GITHUB_STEP_SUMMARY`: `github.job_workflow_sha` (the exact 40-hex commit the
> caller's `uses: …/deploy-cloudflare.yml@<ref>` pin resolved to) and
> `github.workflow_ref` (the full ref path). This is the **single source of
> truth** for the executed pin.
>
> Consumers should **read the resolved SHA off this job summary** rather than
> hand-maintaining a `deploy-cloudflare.yml@<sha>` literal echoed in their own
> deploy-summary string. A hand-maintained literal drifts independently of the
> real `uses:` pin and is exactly what the [pin-drift
> dashboard](runbooks/pin-drift-dashboard.md)'s **stale pin literal** lint now
> flags (`❌ stale pin literal`) — the resolved-ref summary makes the literal
> unnecessary, so the lint finding is resolved by adoption, not by re-editing
> the stale SHA by hand.

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
- **Stale pin-literal lint** (Story #110) — the same dashboard also flags a
  platform-ref SHA/tag echoed in a **comment** or a **`run:`/echo string** that
  drifts from the canonical `uses:` pin (`❌ stale pin literal`), catching the
  class the `uses:`-only scan missed. Adopt the resolved-ref deploy summary
  (above) instead of hand-maintaining such a literal.

> **`v1.0` / `@v1` is deferred — not planned.** Cutting a `v1.0` release,
> publishing a moving `@v1` major tag, and `@v1`-style major-tag pinning are a
> *possible future* step but are **not planned now or anytime soon** (operator
> decision, 2026-06-29). There is also no formal SemVer deprecation policy
> today. Until that changes, **pin by release tag/SHA** (Renovate-bumped) as
> above — do not expect a floating `@v1` tag to exist.
