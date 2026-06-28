# Branch Protection Setup Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using the mandrel-platform CI model. Describes the canonical branch protection configuration and how to apply it.
> **Project-specific values** (required check names, reviewer groups) live in each consumer's local runbook and `docs/runbooks/main-protection.json`.

---

## 1. Branch Protection Model

All projects use a **single-aggregator required-check** pattern:

- One stable required status check (`ci-required` or the project's equivalent) is the only context listed in branch protection.
- The aggregator job runs last and passes only when all upstream jobs (lint, typecheck, tests, security, build) have passed.
- This model prevents the "phantom required check" failure mode where a renamed CI job blocks every PR indefinitely.

The canonical required-check name and the list of upstream jobs it aggregates are defined in `docs/runbooks/main-protection.json` (see below).

---

## 2. `main-protection.json` Contract

Each project's `docs/runbooks/main-protection.json` defines the branch protection configuration:

```json
{
  "branch": "main",
  "requiredStatusChecks": [
    "ci-required"
  ],
  "aggregatorJob": "ci-required",
  "upstreamJobs": [
    "static-analysis",
    "security",
    "tests-and-baselines",
    "build"
  ],
  "enforceAdmins": false,
  "requireLinearHistory": false,
  "allowForcePushes": false,
  "allowDeletions": false
}
```

**Do not add individual job names as required checks.** Any job rename breaks every open PR. The aggregator contract is the stable surface.

### Keeping `main-protection.json` in sync

A CI lint (`scripts/check-required-contexts.mjs`) asserts that every job named in `upstreamJobs` is actually emitted by the CI workflow. Run it locally when adding or renaming a CI job:

```bash
node scripts/check-required-contexts.mjs
```

---

## 3. Applying Branch Protection (GitHub API / CLI)

### 3a. Via GitHub CLI (recommended)

```bash
# Apply the ruleset from main-protection.json
node scripts/apply-branch-protection.mjs --dry-run   # preview changes
node scripts/apply-branch-protection.mjs --apply     # apply
```

### 3b. Manual via GitHub API

```bash
# Read the current protection
gh api repos/<OWNER>/<REPO>/branches/main/protection

# Apply protection — adjust required_status_checks.contexts to match main-protection.json
gh api repos/<OWNER>/<REPO>/branches/main/protection \
  --method PUT \
  --field required_status_checks[strict]=false \
  --field "required_status_checks[contexts][]=ci-required" \
  --field enforce_admins=false \
  --field required_pull_request_reviews=null \
  --field restrictions=null
```

> **Note:** `required_pull_request_reviews` and `restrictions` are only available on GitHub Pro/Team/Enterprise. On the free plan, set both to `null`.

### 3c. Via GitHub Ruleset (GitHub Pro+)

If the project uses GitHub Rulesets instead of legacy branch protection:

1. Go to **Settings → Rules → Rulesets → New ruleset**.
2. Target: `main` (branch pattern).
3. Add rule: **Require status checks to pass** → add `ci-required`.
4. Add rule: **Restrict deletions**.
5. Add rule: **Block force pushes**.
6. Save.

---

## 4. Verifying Branch Protection Is Applied

```bash
# Check the current protection settings
gh api repos/<OWNER>/<REPO>/branches/main/protection \
  --jq '.required_status_checks.contexts'

# Expected output:
# ["ci-required"]
```

If the output is empty or missing `ci-required`, branch protection is not applied or is using the wrong context name.

---

## 5. Diagnosing "PR Blocked by Required Check"

A PR stuck on a required check that never reports is the most common branch-protection failure:

1. **Check the check name:** The required check in branch protection must exactly match what CI reports. Even a trailing space or casing difference blocks forever.
   ```bash
   # List the checks reported on the PR
   gh pr checks <PR_NUMBER>
   ```
2. **Compare against `main-protection.json`:** Is the reported aggregator job name (`ci-required` or equivalent) listed as a required check?
3. **Check `upstreamJobs` in `main-protection.json`:** Is every upstream job actually being emitted by the workflow? Run `node scripts/check-required-contexts.mjs`.
4. **If a job was renamed:** Update the job name in `main-protection.json#upstreamJobs` and re-run the lint. Branch protection itself only cares about the aggregator name.

---

## 6. Branch Protection Checklist

- [ ] `docs/runbooks/main-protection.json` is up to date with the current CI job names.
- [ ] `scripts/check-required-contexts.mjs` passes locally.
- [ ] Branch protection is applied (`gh api` or Ruleset).
- [ ] A test PR confirms the `ci-required` check is reported and branch protection blocks merge until it passes.
- [ ] `enforceAdmins: false` is intentional — document the reason if set to `true`.

---

## See Also

- `docs/runbooks/main-protection.json` — the project's branch protection contract.
- [Dependency Update Runbook](dependency-update.md) — keep CI job names stable to avoid breaking the aggregator contract.
- Project-local runbook — reviewer groups, ruleset IDs, GitHub plan constraints.
