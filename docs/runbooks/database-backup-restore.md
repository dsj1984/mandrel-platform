# Database Backup & Restore Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using Turso/libSQL as the primary database, deployed on Cloudflare Workers via the mandrel-platform model.
> **Project-specific values** (database names, Turso org, PITR window, backup schedule) live in each consumer's local runbook that links here.

---

## 1. Backup Strategy

| Backup type | Mechanism | Triggered by | Retention |
|-------------|-----------|-------------|----------|
| Pre-deploy snapshot (branch) | `turso db branch create` | Deploy workflow (automatic) | Until manually deleted |
| Scheduled backup | Turso PITR (Point-in-Time Recovery) | Turso platform (continuous) | Per plan (typically 7–30 days) |
| Manual export | `turso db shell <DB> .dump > backup.sql` | Operator | Stored in secure external location |

The shared deploy workflow automatically captures a pre-migration branch snapshot before running DB migrations. This is the primary rollback mechanism for a bad migration.

---

## 2. Pre-Deploy Snapshot (Automatic)

The deploy workflow creates a branch snapshot before every migration:

```bash
# What the deploy workflow does automatically:
SNAPSHOT_NAME="pre-deploy-$(date +%Y%m%d-%H%M%S)"
turso db branch create <DB_NAME> "$SNAPSHOT_NAME"
echo "Snapshot branch: $SNAPSHOT_NAME"

# Then runs migrations:
pnpm db:migrate
```

The snapshot branch name is recorded in the deploy workflow run output. Retrieve it from the GitHub Actions run summary if you need to restore.

---

## 3. Taking a Manual Backup

### 3a. Branch snapshot (recommended — instant, no data movement)

```bash
# Create a named branch from the current state
turso db branch create <DB_NAME> backup-$(date +%Y%m%d)

# List branches to confirm
turso db branch list <DB_NAME>
```

### 3b. SQL dump (portable — for archiving or migration to another engine)

```bash
# Dump to a local file
turso db shell <DB_NAME> ".dump" > backup-$(date +%Y%m%d).sql

# Store the dump in a secure external location (never commit to git)
# e.g., upload to an encrypted S3/R2 bucket
```

---

## 4. Point-in-Time Recovery (PITR)

Turso supports PITR on qualifying plans. PITR lets you restore the database to any point within the retention window.

```bash
# Restore to a specific timestamp (ISO 8601)
turso db restore <DB_NAME> --timestamp 2026-06-28T12:00:00Z

# This creates a new database from the PITR snapshot.
# Rename or swap the restored DB into production use.
```

> **Warning:** PITR restore creates a **new** database, not an in-place restore. You must update the database URL in the Worker configuration (Cloudflare secret / environment variable) to point to the restored DB.

---

## 5. Restore from a Branch Snapshot

This is the primary path for recovering from a bad migration.

```bash
# 1. Identify the pre-deploy snapshot branch name (from the deploy workflow run output)
SNAPSHOT_BRANCH="pre-deploy-20260628-143000"

# 2. Create a new database from the snapshot branch
turso db create <DB_NAME>-restored --from-db <DB_NAME> --from-branch "$SNAPSHOT_BRANCH"

# 3. Verify data integrity on the restored database
turso db shell <DB_NAME>-restored "SELECT COUNT(*) FROM <CRITICAL_TABLE>;"

# 4. Update the Worker to point to the restored database
wrangler secret put DATABASE_URL --name <WORKER_NAME> --env <ENVIRONMENT>
# (paste the new turso DB URL when prompted)

# 5. Redeploy the Worker so the secret change takes effect
gh workflow run deploy-<environment>.yml --ref main

# 6. Run the post-deploy smoke to confirm
./scripts/smoke-deploy.sh <HEALTH_URL>

# 7. Once confirmed, clean up the bad migration state from the original DB
# (or promote the restored DB to be the new primary — see docs/environments.md)
```

---

## 6. Restore from SQL Dump

Use this when you have a `.sql` dump and no branch snapshot is available.

```bash
# 1. Create a new database
turso db create <DB_NAME>-restored

# 2. Import the dump
turso db shell <DB_NAME>-restored < backup-20260628.sql

# 3. Verify row counts
turso db shell <DB_NAME>-restored "SELECT name, COUNT(*) FROM sqlite_master WHERE type='table' GROUP BY name;"

# 4. Update the Worker secret and redeploy (same as Steps 4–6 above)
```

---

## 7. Backup Verification

Run a monthly backup verification:

```bash
# 1. Create a test restore from the most recent snapshot branch
turso db create <DB_NAME>-verify --from-db <DB_NAME> --from-branch <LATEST_SNAPSHOT>

# 2. Run basic integrity checks
turso db shell <DB_NAME>-verify "PRAGMA integrity_check;"

# 3. Verify row counts on critical tables match the primary
turso db shell <DB_NAME>-verify "SELECT COUNT(*) FROM users;"
turso db shell <DB_NAME> "SELECT COUNT(*) FROM users;"

# 4. Clean up the verification DB
turso db destroy <DB_NAME>-verify --yes
```

Record the result in the project's backup verification log (see `docs/environments.md`).

---

## 8. Backup & Restore Checklist

### Before a migration-bearing deploy

- [ ] Confirm the deploy workflow will create a pre-deploy snapshot.
- [ ] Record the snapshot branch name from the workflow run.
- [ ] Have the restore procedure (Section 5) open in a second tab during the deploy.

### After a restore

- [ ] Restored database integrity check passed.
- [ ] Worker is pointing to the restored database URL.
- [ ] Post-deploy smoke is passing.
- [ ] Root cause of the bad migration is identified and documented.
- [ ] Forward-only migration strategy reviewed — is the migration additive-only?
- [ ] Old (corrupted) database renamed or destroyed after the restore is stable.

---

## See Also

- [Rollback Runbook](rollback.md)
- [Deploy Promotion Runbook](deploy-promotion.md)
- [Incident Response Runbook](incident-response.md)
- Project-local `docs/environments.md` — database names, Turso org, PITR retention window, backup schedule, verified backup log location.
