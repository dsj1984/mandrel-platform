# Post-Deploy Smoke — <PROJECT_NAME>

> **Thin local stub.** The canonical smoke contract, failure diagnosis, and
> auto-rollback behavior live in the mandrel-platform repo:
> [`docs/runbooks/post-deploy-smoke.md`](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/post-deploy-smoke.md).
> This file only holds **<PROJECT_NAME>-specific health URLs and parameters**.

---

## Project Values

| Value | Setting |
|-------|---------|
| Staging health URL | `<STAGING_HEALTH_URL>` |
| Production health URL | `<PRODUCTION_HEALTH_URL>` |
| Health route | `<HEALTH_ROUTE>` (e.g. `GET /health`) |
| Smoke script | `<SMOKE_SCRIPT>` (e.g. `./scripts/smoke-deploy.sh`) |
| Max attempts | `<SMOKE_MAX_ATTEMPTS>` (default 5) |
| Delay between retries | `<SMOKE_DELAY_SECONDS>` (default 10s) |

## Run the Smoke Manually

```bash
<SMOKE_SCRIPT> <PRODUCTION_HEALTH_URL> <SMOKE_MAX_ATTEMPTS> <SMOKE_DELAY_SECONDS>

# One-shot check
curl -sf <PRODUCTION_HEALTH_URL> && echo OK || echo FAIL
```

## Project-Specific Notes

<!-- Cold-start tuning, non-standard health checks, auth exceptions. -->

- _TODO: fill in._

---

See also the local stubs: `rollback.md`, `deploy-promotion.md`,
`observability.md`, and the project's `docs/environments.md`.
