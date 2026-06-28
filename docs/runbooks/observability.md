# Observability Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using the mandrel-platform observability stack (Cloudflare Analytics Engine, Logpush, Workers Tail, Sentry, Better Stack uptime).
> **Project-specific values** (Sentry DSN, Better Stack API keys, worker names, dashboard URLs) live in each consumer's local runbook that links here.

---

## 1. Observability Stack

| Signal | Tool | Scope |
|--------|------|-------|
| Structured logs (request/error) | Cloudflare Analytics Engine (AE) | Per-request log rows, queryable via CF SQL API |
| Log retention + SIEM routing | Cloudflare Logpush | Pushes AE/request logs to R2, S3, or a SIEM |
| Real-time log stream | `wrangler tail` | Live tail during incidents |
| Error tracking + stack traces | Sentry (Workers SDK) | Error events with source maps and release tags |
| Uptime / synthetic monitoring | Better Stack | HTTP probes on production health endpoints |
| Performance (Web Vitals) | Cloudflare Browser Insights (if wired) | Apdex / LCP / CLS on the web surface |

---

## 2. Querying Logs

### 2a. Analytics Engine (structured logs)

Query using the Cloudflare GraphQL Analytics API or the CF dashboard:

```bash
# Pull the last 100 error-level log rows for a worker
curl -s "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  --data "SELECT timestamp, blob1 AS level, blob2 AS message, blob3 AS traceId
          FROM <AE_DATASET>
          WHERE blob1 = 'error'
          ORDER BY timestamp DESC
          LIMIT 100"
```

Replace `<AE_DATASET>` with the dataset name from the project's `wrangler.toml` (`analytics_engine_datasets[*].dataset`).

### 2b. Live tail (during incidents)

```bash
wrangler tail --name <WORKER_NAME> --format pretty
```

Filter to errors only:

```bash
wrangler tail --name <WORKER_NAME> --format json | \
  jq 'select(.outcome != "ok")'
```

### 2c. Logpush (historical / SIEM)

Logpush exports are configured per project (see `docs/environments.md`). Access the exported logs via the configured destination (R2 bucket, S3, or SIEM dashboard URL).

---

## 3. Sentry

### 3a. Triage an error

1. Open the project Sentry dashboard (URL in `docs/environments.md`).
2. Filter to the **production** environment and the relevant release (commit SHA tagged at deploy time).
3. Examine the stack trace — source maps are uploaded at deploy and should resolve to readable TypeScript.
4. Note the `traceId` in the Sentry event; cross-reference it in Analytics Engine to find the full request context.

### 3b. Verify Sentry is receiving events

```bash
# Trigger a test error (staging only — never production)
curl -X POST <STAGING_WORKER_URL>/debug/sentry-test \
  -H "Content-Type: application/json" \
  -d '{"message":"observability-test"}'
```

Check the Sentry staging project for the event within 30 seconds. If it doesn't appear, check:
- The `SENTRY_DSN` secret is set correctly in the environment.
- The Worker is using the `@sentry/cloudflare` (or equivalent Workers-compatible) SDK — **not** the Node SDK, which is a no-op on Workers.
- Source maps were uploaded during the deploy workflow.

---

## 4. Better Stack Uptime

### 4a. Check monitor status

```bash
# Via Better Stack API
curl -s "https://uptime.betterstack.com/api/v2/monitors" \
  -H "Authorization: Bearer <BETTER_STACK_API_KEY>" | \
  jq '.data[] | {name: .attributes.url, status: .attributes.status}'
```

### 4b. Acknowledge an alert

Log in to the Better Stack dashboard and acknowledge the incident. Leave a note with the suspected cause and link to the relevant workflow run.

### 4c. Apply the uptime IaC (if monitors are missing)

```bash
# Dry-run to preview changes
node scripts/apply-uptime-monitors.mjs --dry-run

# Apply
node scripts/apply-uptime-monitors.mjs --apply
```

---

## 5. Interpreting Key Metrics

| Metric | What it signals | Action threshold |
|--------|----------------|-----------------|
| 5xx rate | Boot failures, unhandled exceptions | > 1% sustained → consider rollback |
| P99 response time | Slow queries, cold start regression | > 2× baseline → investigate DB and cold-start |
| Worker CPU time | Tight loops, memory pressure | > 50ms P99 → profile |
| AE rows / minute | Volume of structured log events | Sudden spike → check for loop or fan-out bug |
| Uptime probe failing | Worker not responding | Any failure → page on-call |

---

## 6. Common Scenarios

### Worker returning 500s

1. `wrangler tail` to see the exception message in real time.
2. Cross-reference in Sentry for a stack trace with source maps.
3. If a recent deploy is correlated, follow [Rollback Runbook](rollback.md).

### Uptime monitor alerting but health endpoint manual check passes

- The probe may be timing out before the Worker cold-starts. Check CF Worker dashboard for CPU/duration metrics.
- If the probe uses a non-standard timeout, adjust it in the uptime IaC config.

### Sentry not receiving events

- Verify the `SENTRY_DSN` env var is set in the wrangler environment.
- Ensure the Worker SDK is the Cloudflare-compatible variant (not the Node SDK).
- Check Sentry project settings for inbound filters that may be dropping events.

---

## 7. On-Call Response Flow

1. Alert fires (Better Stack / Sentry).
2. Acknowledge in Better Stack; open the Sentry project for the production environment.
3. Check for a recent deploy — if yes, consider rollback immediately per [Rollback Runbook](rollback.md).
4. `wrangler tail` for live error stream.
5. If the cause is not a deploy regression, open an incident issue and follow [Incident Response Runbook](incident-response.md).

---

## See Also

- [Incident Response Runbook](incident-response.md)
- [Rollback Runbook](rollback.md)
- [SLO Runbook](slo.md)
- Project-local `docs/environments.md` — dashboard URLs, API keys references, dataset names.
