# Database Backup & Restore — <PROJECT_NAME>

> **Thin local stub.** The canonical backup strategy, PITR procedure, and
> restore steps live in the mandrel-platform repo:
> [`docs/runbooks/database-backup-restore.md`](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/database-backup-restore.md).
> This file only holds **<PROJECT_NAME>-specific database values**.

---

## Project Values

| Value | Setting |
|-------|---------|
| DB engine | `<DB_ENGINE>` (e.g. Turso/libSQL) |
| Staging DB name | `<STAGING_DB_NAME>` |
| Production DB name | `<PRODUCTION_DB_NAME>` |
| Org / account | `<DB_ORG>` |
| PITR retention window | `<PITR_WINDOW>` (e.g. 7 days) |
| Critical tables (integrity check) | `<CRITICAL_TABLE>` |
| Worker secret for DB URL | `<DATABASE_URL_SECRET>` |
| Backup verification log | `<BACKUP_VERIFY_LOG_LOCATION>` |

## Restore from Pre-Deploy Snapshot (primary path)

```bash
SNAPSHOT_BRANCH="<SNAPSHOT_BRANCH>"   # from the deploy workflow run output
turso db create <PRODUCTION_DB_NAME>-restored \
  --from-db <PRODUCTION_DB_NAME> --from-branch "$SNAPSHOT_BRANCH"
turso db shell <PRODUCTION_DB_NAME>-restored "SELECT COUNT(*) FROM <CRITICAL_TABLE>;"
# Repoint the worker secret and redeploy — see canonical Section 5.
```

## Manual Backup

```bash
turso db branch create <PRODUCTION_DB_NAME> backup-$(date +%Y%m%d)
turso db shell <PRODUCTION_DB_NAME> ".dump" > backup-$(date +%Y%m%d).sql  # store securely
```

## Project-Specific Notes

<!-- Snapshot cadence, who owns restores, where dumps are archived. -->

- _TODO: fill in._

---

See also the local stubs: `rollback.md`, `deploy-promotion.md`,
`incident-response.md`, and the project's `docs/environments.md`.
