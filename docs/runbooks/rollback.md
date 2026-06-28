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

## See Also

- [Incident Response Runbook](incident-response.md)
- [Deploy Promotion Runbook](deploy-promotion.md)
- [Post-Deploy Smoke Runbook](post-deploy-smoke.md)
- [Database Backup & Restore Runbook](database-backup-restore.md)
- Project-local `docs/environments.md` — worker names, DB URLs, health endpoints.
