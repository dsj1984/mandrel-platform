# Rollback Runbook

> **Type:** Common / Process-level
> **Scope:** Any Cloudflare Workers (or Workers + Pages) deployment using the mandrel-platform CI/CD model.
> **Project-specific values** (worker names, URLs, environment slugs) live in each consumer's local runbook that links here.

---

## 1. When to Roll Back

Roll back when **any** of the following is true within 30 minutes of a deploy:

- Post-deploy health check returns non-2xx after retries.
- Error rate (5xx) exceeds the SLO threshold defined in the project's SLO doc.
- A critical user-facing regression is confirmed.
- The deploy succeeded but the smoke test failed (auto-rollback may already have fired — verify first).

Do **not** roll back for cosmetic issues or non-critical degradation — use a forward fix instead. Reserve rollback for clear boot failures or catastrophic regressions.

---

## 2. Rollback Decision Tree

```
Did the CI/CD pipeline already auto-rollback?
├─ YES → Verify the rollback landed (Step 3), then proceed to post-rollback steps (Step 5).
└─ NO  → Was a DB migration part of this deploy?
         ├─ YES → Follow Step 4 (DB restore) BEFORE code rollback.
         └─ NO  → Proceed directly to Step 3 (code rollback).
```

---

## 3. Code Rollback

### 3a. Cloudflare Workers

```bash
# List recent deployments to find the version to restore
wrangler deployments list --name <WORKER_NAME>

# Roll back to the previous stable version
wrangler rollback --name <WORKER_NAME>

# Verify the rollback deployed
wrangler deployments list --name <WORKER_NAME> | head -5
curl -sf <HEALTH_ENDPOINT> && echo "OK" || echo "FAIL"
```

`wrangler rollback` targets the **immediately prior** deployment by default. To target a specific version:

```bash
wrangler rollback <VERSION_ID> --name <WORKER_NAME>
```

### 3b. Cloudflare Pages (if still applicable)

If this project has not yet migrated its web surface from Cloudflare Pages to a Worker, see the project-local rollback runbook for the Pages-specific rollback commands. The canonical path for new mandrel-platform projects is the Workers rollback above.

### 3c. Re-enable auto-deploy guard (if you disabled it)

If you paused the staging auto-deploy workflow to prevent a bad commit from re-deploying, re-enable it once the rollback is confirmed stable.

---

## 4. Database Rollback

> **Warning:** Cloudflare D1 / Turso / libSQL migrations are forward-only by default. There is no automatic down-migration. This step restores from a pre-migration snapshot — confirm a snapshot was captured before the deploy (the shared deploy workflow does this; see the deploy runbook).

### 4a. Restore from pre-migration snapshot (Turso/libSQL branch)

```bash
# List available branches/snapshots
turso db branch list <DB_NAME>

# Restore by branching from the pre-deploy snapshot and promoting
turso db branch create <DB_NAME>-restore --from <SNAPSHOT_BRANCH>

# After verifying data integrity, swap the restored branch to production
# (consult the project's environments.md for the exact DB URL swap procedure)
```

### 4b. Point-in-Time Recovery (PITR) — if the project uses Turso PITR

```bash
turso db restore <DB_NAME> --timestamp <ISO8601_TIMESTAMP_BEFORE_MIGRATION>
```

### 4c. If no snapshot is available

- Assess whether the migration is additive-only (adding nullable columns, indices) — if so, the old code can usually run against the new schema safely.
- If the migration was destructive (DROP, RENAME, data transform), escalate to the on-call lead immediately. This is a data-loss scenario.

---

## 5. Post-Rollback Steps

1. **Verify the rollback is live:**
   ```bash
   curl -sf <HEALTH_ENDPOINT> && echo "OK"
   ```
2. **Monitor error rate** for at least 10 minutes post-rollback to confirm stabilization.
3. **Open a post-incident issue** tagging the commit SHA that caused the regression and the rollback PR/deployment ID.
4. **Update the incident log** in the project's incident-response doc.
5. **Run the forward fix** on a branch. Do not re-deploy the rolled-back commit directly.
6. **Re-run the full CI gate** on the fix branch before promoting to staging/production.

---

## 6. Rollback Checklist

- [ ] Identified the cause of rollback (boot failure / error-rate spike / smoke fail).
- [ ] Checked whether auto-rollback already fired.
- [ ] Assessed DB migration impact before rolling back code.
- [ ] Executed `wrangler rollback` (or Pages equivalent).
- [ ] Confirmed health endpoint returns 2xx after rollback.
- [ ] Monitored error rate for 10+ minutes.
- [ ] Opened post-incident issue with SHA + deployment ID.
- [ ] Notified stakeholders (per project's incident-response escalation path).

---

## 7. Rolling Back the CodeQL Alert Gate

> **Scope:** mandrel-platform only. This gate is repository-local — no reusable
> workflow a consumer calls runs CodeQL, so nothing here applies to consumer
> repos.

### 7.1 What is actually wired

Establish this before touching anything, because the two CodeQL signals are
easy to confuse and only one of them blocks:

| Signal | Blocking? |
| --- | --- |
| GitHub's own **"Code scanning results / CodeQL"** check run | **No.** It is not a required status context, and native auto-merge waits only on required contexts. |
| ci.yml's **`code-scanning`** job (the codeql.yml self-call) | **Yes.** It is listed in `ci-required`'s `needs:`, and `ci-required` is the single required context in the `main protection` ruleset. |

So the gate is one `needs:` entry plus one `fail-on-alert-severity: high` input
in `.github/workflows/ci.yml`. Nothing in branch protection mentions CodeQL,
and there is no legacy branch-protection object on `main` at all — the ruleset
is the only enforcement surface:

```bash
# The one required context, and the (empty) bypass list.
gh api repos/dsj1984/mandrel-platform/rulesets \
  --jq '.[] | select(.name == "main protection") | .id'
gh api repos/dsj1984/mandrel-platform/rulesets/<RULESET_ID> \
  --jq '{bypass: .bypass_actors, checks: [.rules[] | select(.type == "required_status_checks")
         | .parameters.required_status_checks[].context]}'
```

`bypass_actors` is `[]`. **No role — repository admin included — bypasses this
ruleset implicitly.** `docs/runbooks/main-protection.json` carries
`"enforceAdmins": false`, which is the legacy-branch-protection spelling of an
admin bypass and is **not** in force here; do not plan a break-glass around it.

### 7.2 The three recovery moves, in order

Work down this list. Stop at the first one that fits — each later move widens
the blast radius, and (c) removes the gate for every pull request at once.

#### (a) Dismiss the individual alert — one alert, one pull request

The narrowest move, and the right one for a confirmed false positive or an
accepted risk on a specific finding. Reversible without a redeploy: re-opening
the alert restores the block immediately, and the next `code-scanning` run
picks the change up with no workflow edit and no merge.

```bash
# Find the alert number the gate printed in its step summary.
gh api "repos/dsj1984/mandrel-platform/code-scanning/alerts?state=open&per_page=100" \
  --paginate --jq '.[] | {number, rule: .rule.id, severity: .rule.security_severity_level}'

# Dismiss it. reason ∈ false positive | won't fix | used in tests
gh api "repos/dsj1984/mandrel-platform/code-scanning/alerts/<ALERT_NUMBER>" \
  --method PATCH \
  --field state=dismissed \
  --field dismissed_reason="false positive" \
  --field dismissed_comment="<WHY — 280 characters maximum>"

# Re-open (the rollback of the rollback):
gh api "repos/dsj1984/mandrel-platform/code-scanning/alerts/<ALERT_NUMBER>" \
  --method PATCH --field state=open
```

> **`dismissed_comment` is capped at 280 characters.** A longer body is
> rejected by the API, so link the issue rather than pasting the analysis.

Requires `security-events: write` (the `security_events` scope on a PAT).

#### (b) Lower or unset the threshold — scan-wide false positive

When a whole rule or query pack is misfiring, editing the gate's sensitivity in
`.github/workflows/ci.yml` beats dismissing alerts one at a time:

```yaml
  code-scanning:
    uses: ./.github/workflows/codeql.yml
    with:
      fail-on-alert-severity: critical   # was: high
      # or delete the `with:` block entirely — the input defaults to '',
      # which restores upload-and-report and gates nothing.
```

Reversible without a redeploy in the sense that matters here — there is no
deployed artifact, so reverting the line and merging restores the gate — but
unlike (a) it **requires a merged pull request**, and that pull request is
itself gated by `code-scanning`. It therefore only works while the gate is
still *able to conclude*: a scan that runs and reports a false positive is
fine, a systemic Advanced Security or alerts-API outage is not (see 7.3).
`scripts/check-codeql-gating.test.mjs` pins the threshold to `high` or
`critical`, so unsetting it reds `node-scripts` — expected, and the signal that
this is a deliberate temporary state, not a silent drift.

#### (c) Break-glass — remove the gate from the aggregator

**Last resort. Removes code-scanning enforcement from every pull request.** Use
only for a systemic outage that reds the gate independently of the code (7.3).

The move is to drop one line from `ci-required`'s `needs:` in
`.github/workflows/ci.yml`:

```yaml
  ci-required:
    needs:
      - node-scripts
      - actionlint
      - runner-kit-bash32
      - security
      # - code-scanning        # BREAK-GLASS <date> — restore with <issue>
```

**Who may perform it:** a repository administrator — in practice the operator
`@dsj1984`, who owns `dsj1984/mandrel-platform`. Because `bypass_actors` is
empty, being an admin is **not** sufficient on its own: the ruleset must be
relaxed first, then restored.

1. Open the pull request that comments out the `needs:` entry.
2. Relax the ruleset for the duration — either set its enforcement to
   `evaluate` (reports, does not block), or add the admin to `bypass_actors`:

   ```bash
   gh api repos/dsj1984/mandrel-platform/rulesets/<RULESET_ID> \
     --method PUT --field enforcement=evaluate
   ```

3. Merge the pull request.
4. **Restore the ruleset in the same session** — this is the step that gets
   forgotten, and an un-restored ruleset removes *every* required check, not
   just CodeQL:

   ```bash
   gh api repos/dsj1984/mandrel-platform/rulesets/<RULESET_ID> \
     --method PUT --field enforcement=active
   gh api repos/dsj1984/mandrel-platform/rulesets/<RULESET_ID> \
     --jq '{enforcement, bypass: .bypass_actors}'   # expect active / []
   ```

5. Open a tracking issue to re-instate the `needs:` entry, and re-instate it as
   soon as the outage clears. While it is out, **`ci-required` green does not
   mean the tree was scanned** — the exact condition Story #366 removed.

### 7.3 Why the gate needs a break-glass at all

`code-scanning` is a `needs:` of the only required context, and it **fails
closed**: an unreadable alerts API, Advanced Security switched off, a revoked
`security-events` scope, or an unparseable response all fail the job rather
than passing on an inconclusive read. That is the correct direction for a
security gate, and it has one consequence worth stating plainly — a systemic
alerts-API or GHAS outage reds **every** pull request, *including the one that
would remove the gate*. Move (b) cannot land during such an outage, which is
why move (c) pairs the workflow edit with a temporary ruleset relaxation rather
than relying on the gate to let its own removal through.

---

## See Also

- [Incident Response Runbook](incident-response.md)
- [Branch Protection Setup Runbook](branch-protection-setup.md)
- [Deploy Promotion Runbook](deploy-promotion.md)
- [Post-Deploy Smoke Runbook](post-deploy-smoke.md)
- [Database Backup & Restore Runbook](database-backup-restore.md)
- Project-local `docs/environments.md` — worker names, DB URLs, health endpoints.
