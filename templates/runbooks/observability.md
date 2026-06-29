# Observability — <PROJECT_NAME>

> **Thin local stub.** The canonical observability stack, query patterns, and
> on-call response flow live in the mandrel-platform repo:
> [`docs/runbooks/observability.md`](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/observability.md).
> This file only holds **<PROJECT_NAME>-specific endpoints and dataset names**.

---

## Project Values

| Value | Setting |
|-------|---------|
| Worker name(s) | `<WORKER_NAME>` |
| Cloudflare account ID | `<CF_ACCOUNT_ID>` |
| Analytics Engine dataset | `<AE_DATASET>` |
| Sentry dashboard | `<SENTRY_PROJECT_URL>` |
| Sentry DSN secret | `<SENTRY_DSN_SECRET>` |
| Better Stack dashboard | `<BETTERSTACK_URL>` |
| Logpush destination | `<LOGPUSH_DESTINATION>` |

## Quick Commands

```bash
# Live tail
wrangler tail --name <WORKER_NAME> --format pretty

# Errors only
wrangler tail --name <WORKER_NAME> --format json | jq 'select(.outcome != "ok")'
```

## Alert Thresholds (from canonical — confirm or override)

| Metric | Action threshold |
|--------|------------------|
| 5xx rate | > 1% sustained → consider rollback |
| P99 response time | > 2× baseline → investigate |
| Uptime probe failing | any failure → page on-call |

## Project-Specific Notes

<!-- Custom dashboards, known noisy alerts, dataset schema notes. -->

- _TODO: fill in._

---

See also the local stubs: `incident-response.md`, `rollback.md`, `slo.md`,
and the project's `docs/environments.md`.
