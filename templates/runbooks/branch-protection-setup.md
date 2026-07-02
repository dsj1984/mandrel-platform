# Branch Protection Setup — <PROJECT_NAME>

> **Thin local stub.** The canonical single-aggregator protection model and the
> `main-protection.json` contract live in the mandrel-platform repo:
> [`docs/runbooks/branch-protection-setup.md`](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/branch-protection-setup.md).
> This file only holds **<PROJECT_NAME>-specific check names and reviewers**.

---

## Project Values

| Value | Setting |
|-------|---------|
| Repo (`owner/repo`) | `<OWNER>/<REPO>` |
| Protected branch | `<PROTECTED_BRANCH>` (e.g. `main`) |
| Required aggregator check | `<AGGREGATOR_CHECK>` (e.g. `ci-required`) |
| Protection contract file | `<MAIN_PROTECTION_JSON>` (e.g. `docs/runbooks/main-protection.json`) |
| Reviewer group(s) | `<REVIEWER_GROUPS>` |
| GitHub plan | `<GITHUB_PLAN>` (free / pro / team) |

## Apply & Verify

```bash
# Apply — PUT the protection with the aggregator as the only required context.
# (There is no apply-branch-protection script; use gh api directly — see the
# canonical runbook § 3.)
gh api repos/<OWNER>/<REPO>/branches/<PROTECTED_BRANCH>/protection \
  --method PUT \
  --raw-field required_status_checks='{"strict":false,"contexts":["<AGGREGATOR_CHECK>"]}' \
  --field enforce_admins=false \
  --raw-field required_pull_request_reviews=null \
  --raw-field restrictions=null

# Verify
gh api repos/<OWNER>/<REPO>/branches/<PROTECTED_BRANCH>/protection \
  --jq '.required_status_checks.contexts'
# Expected: ["<AGGREGATOR_CHECK>"]
```

> **Do not add individual job names as required checks** — only the aggregator.

## Project-Specific Notes

<!-- Ruleset IDs, enforceAdmins rationale, plan-specific constraints. -->

- _TODO: fill in._

---

See also the project's `<MAIN_PROTECTION_JSON>` and the local stubs:
`dependency-update.md`, `environments-provisioning.md`.
