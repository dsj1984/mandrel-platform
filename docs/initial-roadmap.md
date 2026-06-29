# mandrel-platform — Platform Convergence Record & Roadmap

> **What this is.** This document began life as a 2026-06-28 cross-project DevOps
> audit of three sibling repos (`domio` · `athportal` · `swarm-os`). That audit
> found a uniform-in-intent but drift-in-practice platform layer and proposed
> standing up a shared distribution to fix every gap once and inherit it
> everywhere. That distribution — **`mandrel-platform`** — now exists, is at
> **v0.10.0**, and all three consumers have converged onto it.
>
> The audit's structural goal is therefore **achieved**. This file is now a
> living record: §1 is the verified current state, §2 condenses what the audit
> found and how it was resolved (the design rationale that's still load-bearing),
> §3 is the delivery ledger, and §4 is the forward roadmap for the work that
> genuinely remains — chiefly one reopened HIGH security finding the original
> "Track complete" claim had wrongly closed.
>
> **Scope:** foundational platform / DevOps layer only (environment, build,
> CI/CD, deploy, IaC, security tooling, DevOps docs). Application/business logic
> excluded.
> **State verified:** 2026-06-29 by direct read of all four repos + the
> `mandrel-platform-smoke` release gate.

---

## 1. Where things stand (2026-06-29)

`mandrel-platform` v0.10.0 is live and is the single shared substrate for the
delivery layer of all three consumers. Each consumer's PR-quality CI and
Cloudflare deploy are now thin callers of reusable workflows; runtime, config,
and Renovate are converged; and a **live cross-repo smoke test gates every
platform release**. The triplicated, drifting CI/deploy/config artifacts that
motivated the audit are gone — a fix now lands in one place and is inherited.

### 1.1 What `mandrel-platform` ships

The §6.2-era target layout is fully realized. Three distribution channels out of
one repo:

- **Reusable workflows** (`workflow_call`, SHA-pinned, Renovate-updatable):
  - `pr-quality.yml` — lint / typecheck / unit / contract / e2e tiers, single
    `ci-required` aggregator, per-job timeouts, Turbo + Playwright caching.
    *(Note: carries no secret-scan/SAST tier — see §4.1.)*
  - `deploy-cloudflare.yml` — isolation-audit, consumer-side build-artifact
    handoff, pre-migration Turso snapshot, boot-smoke, auto-rollback.
  - `codeql.yml` — unconditional SAST (not visibility-gated).
  - `smoke-dispatch.yml` — fires the cross-repo smoke on push to `main`.
- **Composite action:** `setup-toolchain` (pnpm + Node-from-`.nvmrc` +
  `--frozen-lockfile`, `cache` boolean input).
- **npm config package** (`mandrel-platform`): `tsconfig.base.json`,
  `biome.base.json`, `main-protection.json`, and the gate scripts
  `audit-check.mjs`, `check-required-contexts.mjs`, `check-docs-staleness.mjs`,
  `check-workflow-portability.mjs`.
- **Renovate preset:** `github>dsj1984/mandrel-platform` (nvm-lockstep + wrangler
  `compatibility_date` rules, package grouping, 3-day `minimumReleaseAge`).
- **8 runbook templates** (`templates/runbooks/`): branch-protection-setup,
  database-backup-restore, dependency-update, deploy-promotion,
  environments-provisioning, incident-response, observability, post-deploy-smoke.
- **Release gate:** `mandrel-platform-smoke` calls both reusable workflows as a
  real consumer; `release-please` blocks every npm publish on its green
  `smoke/cross-repo` status. Five consecutive smoke-gated releases shipped
  (v0.6.0 → v0.10.0).

### 1.2 Consumer convergence matrix (verified)

✅ done · ⚠️ partial / needs attention · ❌ not done. All three pin the same two
shared releases: **`pr-quality.yml@v0.3.1` (`185f28b`)** and
**`deploy-cloudflare.yml@v0.9.0` (`a606ad7`)**.

| Dimension | domio | athportal | swarm-os |
|---|---|---|---|
| Adopts shared `pr-quality` + `setup-toolchain` | ✅ | ✅ | ✅ |
| Adopts shared `deploy-cloudflare` + build-split | ✅ | ✅ | ✅ |
| Workflow-portability + required-context lints wired | ✅ | ✅ | ✅ |
| Runtime: Node `24.16.0` exact, pnpm `11.5.2`, `engine-strict`, overrides in `pnpm-workspace.yaml` | ✅ | ✅ | ✅ |
| `tsconfig` extends platform base + shared `audit-check` | ✅ | ✅ | ✅ |
| `renovate.json` reduced to platform preset | ❌ (116-line local) | ✅ | ✅ |
| Lint stack (Biome-first target) | ⚠️ Prettier+ESLint | ✅ Biome | ✅ Biome |
| Web deploy target = Worker | ✅ | ✅ | ✅ (migrated off Pages) |
| Staging gated on CI-green (`workflow_run`) | ✅ | ✅ | ✅ |
| Boot-smoke + auto-rollback (+ pre-migration snapshot) | ✅ | ✅ | ✅¹ |
| Security headers (CSP/HSTS/XFO/XCTO/Referrer-Policy) | ✅ | ✅ | ✅ |
| `hono/cors` per-env origin allowlist | ❌ | ✅ | ✅ |
| Observability: AE + Logpush + Sentry | ✅ | ⚠️ Sentry only (AE/Logpush unwired) | ✅ |
| `GIT_COMMIT_SHA` injected at deploy | ✅ | ✅ | ✅ |
| husky `set -e` + credential `.gitignore` patterns | ✅ | ✅ | ✅ |
| `environments.md` (plural) | ✅ | ✅ | ✅ (renamed) |
| References shared runbooks (not local copies) | ✅ | ❌ local copies | ❌ local copies |
| **Effective PR secret scan in CI** | ✅ gitleaks (blocking) | ⚠️ no-op on private | ❌ none in CI |
| **Effective SAST gate** | ✅ Semgrep `sast.yml` | ⚠️ CodeQL no-op on private | ⚠️ CodeQL `upload:never` (log-only) |
| Branch protection enforced | ✅ ruleset, no admin bypass | ⚠️ admin-bypassable | ⚠️ free private plan |

¹ swarm-os runs `migrate: false` by design (Turso/libSQL, no D1 migrations), so
the pre-migration snapshot step is intentionally inert there.

The bottom three rows are the live exposure carried into §4.1. Everything above
them matches — and in several places exceeds — what the roadmap promised.

---

## 2. What the founding audit found, and how it was resolved

The 2026-06-28 audit (15 evidence-bound readers across 3 repos × 5 DevOps
dimensions) found a platform layer that was **mature and uniform in intent but
inconsistently realized**: the same artifact (PR gate, deploy sequence, wrangler
config, `renovate.json`, `tsconfig.base.json`, CVE-gate) was hand-reimplemented
three times and slowly diverging, and several "required" controls were no-ops in
practice. Because the divergence was drift rather than deliberate variation,
nearly every finding was fixable once and inherited by all three — which is
exactly what `mandrel-platform` did.

### 2.1 Found → fixed

| What the audit found | Resolution | Owner |
|---|---|---|
| ~1,600-line bespoke PR gate hand-reimplemented 3× and drifting | Shared `pr-quality.yml`; consumers collapse to thin callers | MP-3 → X1 |
| 3 drifting toolchain-setup composites | Shared `setup-toolchain` action | MP-2 → X1 |
| Deploy sequence + wrangler config triplicated; no post-deploy health gate; forward-only migrations with no snapshot | Shared `deploy-cloudflare.yml` (boot-smoke, auto-rollback, pre-migration snapshot, build-split) | MP-4 → X2/H1 |
| Runtime drift (domio Node 22 / pnpm 10; loose Turbo floors; no `engine-strict`; advisory pins) | Converged: Node `24.16.0` exact, pnpm `11.5.2`, `engine-strict`, overrides in `pnpm-workspace.yaml` | C1 |
| `tsconfig`/CVE-gate/Renovate config copied 3× | npm config package + Renovate preset | MP-6/MP-7 → X2 |
| `main-protection.json` drift; phantom required checks that wedge PRs | Canonical contract + `check-required-contexts.mjs` self-test | MP-8 → X2; H2 (interim) |
| No SAST anywhere; private-repo secret scan a green no-op; staging auto-deploys with no CI gate | CodeQL workflow + per-repo secret scan + `workflow_run` staging gate | MP-5, H1, H2 — **see §4.1, partially reopened** |
| Security headers / CORS missing on 2 of 3 (own `security-baseline.md` violation) | Ported domio's CSP/headers; `hono/cors` allowlists | F1 |
| Observability decided but not wired; runbooks overstate signal | AE + Logpush + working Sentry per Worker | F1 |
| Docs drift (Pages↔Worker, singular `environment.md`, stale runbooks) | Reconciled; plural `environments.md`; shared runbook templates | F1, MP-9 |
| Cross-repo `workflow_call` footguns (relative `uses:`, `${{}}` in input defaults) | `check-workflow-portability.mjs` lint | X3 |

### 2.2 Design rationale that remains load-bearing

These decisions still govern the platform and should not be re-litigated:

- **Ownership boundary.** `mandrel-platform` is deliberately **separate** from
  the `mandrel` AI-harness framework. `mandrel` governs *agent behavior*;
  `mandrel-platform` governs *delivery* and is consumable by any repo, AI-driven
  or not. Different audiences, cadences, and blast radius.
- **Three distribution channels, one repo.** Reusable workflows/actions
  (consumed via `uses:` + SHA), npm config package, and a Renovate preset
  (`github>` ref).
- **Best-of-breed seeding, not lowest common denominator.** Each shared unit was
  the *union of the best* existing implementation — domio's `_headers` + CSP
  middleware and blocking gitleaks; athportal's `isolation-audit`,
  `smoke-deploy.sh`, Turbo remote cache, per-job timeouts; swarm-os's lean job
  fan-out and self-expiring CVE allowlist.
- **Documentation split (reference, don't copy).** Common *process* runbooks live
  once in `mandrel-platform` and are linked; each project keeps its own
  `docs/environments.md` and project-specific runbooks with local values. *(Two
  consumers still hold local copies instead of references — §4.1.)*
- **Runner choice is the one justified divergence.** Self-hosted (domio/athportal)
  vs `ubuntu-latest` (swarm-os) stays a per-repo input and must not be flattened.

> The full pre-remediation matrix, the per-dimension divergence tables, and the
> per-finding severity analysis were the working detail behind this summary.
> They described the **state at audit time (2026-06-28)**, which no longer
> exists, and have been retired from this document now that the work is
> delivered; the resolution column above and the git history are the durable
> record.

---

## 3. Delivery ledger

All 27 original Stories + 3 follow-on (X3) Stories are delivered and closed, plus
a post-adoption deploy-hardening track on the platform. Native GitHub
`blocked_by` edges enforced the wave order (cross-repo and cross-org).

### 3.1 Projects

| Repo | Owner | Project | Role |
|---|---|---|---|
| `mandrel-platform` | `dsj1984` | [#8](https://github.com/users/dsj1984/projects/8) | Producer — shared substrate |
| `domio` | `dsj1984` | #4 | Consumer |
| `athportal` | `dsj1984` | #6 | Consumer |
| `swarm-os` | `Beestera` | #1 | Consumer (cross-org) |

### 3.2 Producer — `mandrel-platform` (Project #8) ✅

`MP-1` skeleton + release pipeline → `MP-2` setup-toolchain → {`MP-3` pr-quality,
`MP-4` deploy-cloudflare, `MP-5` CodeQL, `MP-6` config pkg, `MP-7` Renovate
preset, `MP-9` runbooks} → `MP-8` main-protection contract. Issues
[#2](https://github.com/dsj1984/mandrel-platform/issues/2)–[#10](https://github.com/dsj1984/mandrel-platform/issues/10),
all closed. The 10 unification opportunities from the audit map 1:1 to MP-1…MP-9
and are all shipped.

### 3.3 Consumers — same Story set per repo ✅

| Story | Scope | domio | athportal | swarm-os |
|---|---|---|---|---|
| H1 | Deploy safety net (CI-gate, boot-smoke, rollback, snapshot) | [#1532](https://github.com/dsj1984/domio/issues/1532) | [#2003](https://github.com/dsj1984/athportal/issues/2003) | [#109](https://github.com/Beestera/swarm-os/issues/109) |
| H2 | Close no-op security gates | [#1533](https://github.com/dsj1984/domio/issues/1533) | [#2004](https://github.com/dsj1984/athportal/issues/2004) | [#110](https://github.com/Beestera/swarm-os/issues/110) |
| C1 | Runtime / tooling / dep-placement convergence | [#1534](https://github.com/dsj1984/domio/issues/1534) | [#2005](https://github.com/dsj1984/athportal/issues/2005) | [#111](https://github.com/Beestera/swarm-os/issues/111) |
| X1 | Adopt setup + pr-quality | [#1535](https://github.com/dsj1984/domio/issues/1535) | [#2006](https://github.com/dsj1984/athportal/issues/2006) | [#112](https://github.com/Beestera/swarm-os/issues/112) |
| X2 | Adopt deploy + config + Renovate | [#1536](https://github.com/dsj1984/domio/issues/1536) | [#2007](https://github.com/dsj1984/athportal/issues/2007) | [#113](https://github.com/Beestera/swarm-os/issues/113) |
| X3 | Workflow-portability lint | [#1544](https://github.com/dsj1984/domio/issues/1544) | [#2013](https://github.com/dsj1984/athportal/issues/2013) | [#121](https://github.com/Beestera/swarm-os/issues/121) |
| F1 | Hardening + observability + docs | [#1537](https://github.com/dsj1984/domio/issues/1537) | [#2008](https://github.com/dsj1984/athportal/issues/2008) | [#114](https://github.com/Beestera/swarm-os/issues/114) |

Wave order delivered: **A** (producer foundation ‖ consumer H1+H2) → **B** (C1) →
**C** (X1, gated on `mandrel-platform-v0.3.1`) → **D** (X2 + X3, gated on
`mandrel-platform-v0.9.0`) → **E** (F1). Consumer build-split migrations:
domio [#1545](https://github.com/dsj1984/domio/issues/1545), athportal
[#2014](https://github.com/dsj1984/athportal/issues/2014), swarm-os
[#123](https://github.com/Beestera/swarm-os/issues/123) — all delivered.

### 3.4 Post-adoption deploy-cloudflare hardening track ✅

X2 deploy adoption surfaced a chain of shared-workflow gaps, fixed iteratively in
`mandrel-platform` (**v0.4.0 → v0.10.0**): boot-smoke URL (#41), Turso/build/secret
command seams (#45/#46), invalid gitleaks-action pin (#49), `gh-environment` for
Environment-scoped secrets (#51), Sentry secret passthrough (#55), the
**build-split** (#56) that moves the build consumer-side so build secrets never
cross the reusable-workflow boundary, and the **allowlist-freeze capstone** (#61,
v0.10.0) that froze the shared deploy workflow's secret surface at
`{CLOUDFLARE_*, TURSO_*}`. The live cross-repo smoke (#38) gated every release
from v0.6.0 onward.

> **Honest status.** The structural goal — one shared platform, three converged
> consumers, a live release gate — is genuinely met, and the convergence is
> deeper than the original plan in places (e.g. swarm-os shipped `hono/cors` and
> full AE+Logpush observability). But "nothing outstanding" was **not** accurate:
> direct verification surfaced one reopened HIGH security finding and a handful
> of medium/low residuals, tracked in §4.

---

## 4. Forward roadmap (post-v0.10.0)

Verification on 2026-06-29 confirmed the bulk of the work but surfaced genuinely
outstanding items. These are real, not invented — each carries the evidence that
established it.

### 4.1 Outstanding — residual gaps from delivered work

**🔴 HIGH — Private-repo SAST and PR secret-scanning gates are not load-bearing
(reopens the original §5 HIGH finding).** The audit's single highest-risk
finding — "security gates marked required are green no-ops on private repos" —
was marked closed (H2/F1) but is only partially resolved, and the closure claim
never acknowledged the underlying GitHub-Advanced-Security limitation.

- **swarm-os:** `codeql.yml` runs analysis but sets `upload: never` ("the upload
  API returns 403 on the free private plan; flip to `upload: always` once GHAS is
  on") — findings live only in the workflow log, not as a blocking Code Scanning
  check. Worse, after `ci.yml` became a thin caller of `pr-quality.yml` (which has
  **no** secret-scan/SAST tier), swarm-os's previous `secretlint`/TruffleHog CI
  steps disappeared — its `lint:secrets` script still exists but is wired into no
  workflow. **Net: swarm-os has no effective PR-time secret-scan gate in CI** — a
  regression introduced by the convergence itself.
- **athportal:** CodeQL + `gitleaks-pr` fail silently without GHAS — the required
  check passes green without scanning.
- **domio** is the positive case: Semgrep (`sast.yml`) + blocking gitleaks +
  enforced branch protection (ruleset, no admin bypass).
- **Root cause:** the shared `pr-quality.yml` has no security tier, so nothing is
  inherited and each consumer's coverage is whatever it wired locally.
- **Fix (preferred, solves once for all):** add a **private-repo-capable security
  tier** to the shared workflow (or a dedicated reusable `security.yml`) — run the
  pinned gitleaks/TruffleHog binary over the PR diff as a blocking job, and assert
  CodeQL findings via a job-failure check on the analysis output rather than SARIF
  upload. Alternatively, enable GHAS on the private repos and flip
  `upload: never` → `always`. Either way, re-verify the gate actually blocks, then
  wire it into branch protection.

**🟠 MEDIUM — Consumers lag the latest platform release and split pins across
chains.** Every consumer pins `pr-quality.yml@v0.3.1` (`185f28b`) and
`deploy-cloudflare.yml@v0.9.0` (`a606ad7`) — two different release SHAs per repo,
neither on the current v0.10.0, with no automated bump or drift detection. This is
universal (not athportal-specific) and silent.
- **Fix:** add a Renovate rule (github-actions manager) to bump the `uses:` SHAs,
  and a scheduled cross-consumer drift check (see §4.2) that flags lag and split
  pins. A v1.0 contract freeze with `@v1` pinning (§4.2) would largely dissolve
  this class.

**🟠 MEDIUM — domio lacks a `hono/cors` per-env origin allowlist.** It relies on
security headers alone; athportal (`apiCors()`) and swarm-os (`cors({…})`) both
ship per-env allowlists. The §5 Medium CORS finding was mapped to F1 and marked
done, but domio's API has no explicit origin allowlist middleware.
- **Fix:** register `hono/cors` on domio's API with a per-environment allowlist
  (`PUBLIC_SITE_URL`), no wildcard-with-credentials, + a contract test rejecting
  disallowed origins.

**🟡 LOW — domio `renovate.json` not reduced to the platform preset.** Still 116
lines of local `config:recommended` + groupings + package rules; athportal and
swarm-os both collapsed to `{"extends":["github>dsj1984/mandrel-platform"]}` +
repo-specific overrides.

**🟡 LOW — domio still Prettier+ESLint, not Biome.** The C1 Biome-first
convergence target is incomplete in domio only (athportal and swarm-os are
Biome-first). Decide whether to finish the migration or document the divergence as
deliberate.

**🟡 LOW — athportal observability is partial.** Sentry releases are wired, but the
Analytics Engine binding is empty and Logpush is unwired, despite the F1 claim of
"AE + Logpush per Worker." (domio and swarm-os have both.)

**🟡 LOW — athportal & swarm-os runbooks are local copies, not references.** The
§6.1 "reference, don't copy" rule and the F1 doc claim call for linking the shared
`mandrel-platform` runbooks; both repos hold local re-implementations instead.
(domio cross-references the shared set.)

### 4.2 Opportunities — now that the platform is proven

- **(M) Private-repo security tier in the shared workflow.** The same change that
  closes the §4.1 HIGH, framed as a platform feature: a reusable security tier all
  consumers inherit, ending per-repo ad-hoc coverage for good. *Highest-value
  next investment.*
- **(S) Cross-consumer drift dashboard.** A scheduled job asserting every consumer
  pins a single mandrel-platform SHA across all chains and flags lag behind the
  latest release. Would have caught the split-pin state automatically.
- **(L) `platform sync` scaffold CLI.** The operator-facing analogue of
  `mandrel sync` (deferred from the original §3.10/§6.1): pin consumer workflow
  SHAs, materialize runbook reference-stubs, and reconcile `renovate`/`tsconfig`
  extends. Would have prevented the SHA split, domio's un-simplified Renovate, and
  the local-copy runbooks — turning one-time manual cutovers into a repeatable
  command.
- **(M) v1.0 stabilization milestone.** Document the public `workflow_call`
  input/secret contract and a deprecation policy, then let consumers pin `@v1`
  instead of raw SHAs — directly reducing the drift in §4.1.
- **(M) Onboard additional repos.** The ownership boundary was designed so any
  repo (AI-driven or not) can adopt the platform without touching `mandrel`. With
  three real consumers and a live smoke gate, the marginal cost of a fourth is low
  and validates the distribution model.

### 4.3 Suggested sequencing

1. **Close the HIGH first.** Build the shared security tier (§4.2 first bullet);
   it resolves the §4.1 HIGH across all consumers and is the only live-exposure
   item. Re-verify gates block, then enforce in branch protection.
2. **Stop the drift.** Land the Renovate `uses:` bump rule + drift dashboard
   (§4.2), then sweep the consumers to the latest release; bundle domio's CORS,
   Renovate-preset, and Biome cleanups into its sweep.
3. **Finish the long tail.** athportal AE/Logpush; athportal & swarm-os runbook
   references.
4. **Then stabilize.** Cut v1.0 with a frozen input contract and move consumers to
   `@v1`; consider onboarding a fourth repo and the `platform sync` CLI as the
   distribution model matures.
