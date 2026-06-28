# Post-Deploy Smoke Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using the mandrel-platform deploy workflow. Describes the post-deploy boot-smoke step and how to diagnose smoke failures.
> **Project-specific values** (health endpoint URLs, retry parameters) live in each consumer's local runbook that links here.

---

## 1. Purpose

A post-deploy smoke test verifies that the newly deployed Worker **boots and responds** before traffic is considered stable. It is the mandatory gate between a successful `wrangler deploy` and considering the deploy done. A smoke failure triggers automatic rollback.

The smoke test is **not** a functional acceptance test — it only proves the Worker is reachable and returning a successful HTTP status on the health endpoint. Full functional verification belongs in the pre-deploy CI gate.

---

## 2. What the Smoke Step Does

The shared deploy workflow runs the following sequence after `wrangler deploy`:

```bash
# scripts/smoke-deploy.sh
HEALTH_URL="${1}"         # e.g. https://<worker>.workers.dev/health
MAX_ATTEMPTS="${2:-5}"    # retry count (default 5)
DELAY_SECONDS="${3:-10}"  # delay between retries (default 10s)

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL")
  if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
    echo "Smoke passed (attempt $attempt): $HTTP_STATUS"
    exit 0
  fi
  echo "Smoke attempt $attempt failed: $HTTP_STATUS — retrying in ${DELAY_SECONDS}s"
  sleep "$DELAY_SECONDS"
done

echo "Smoke FAILED after $MAX_ATTEMPTS attempts — triggering rollback"
exit 1
```

On exit code 1, the workflow triggers `wrangler rollback` and fails the run.

---

## 3. Health Endpoint Contract

Every Worker **must** expose a health endpoint that:

- Responds to `GET /health` (or a project-defined equivalent — record it in `docs/environments.md`).
- Returns HTTP 200 when the Worker has booted and is able to serve requests.
- Returns a non-2xx code (or times out) if the Worker is broken.
- Does **not** require authentication.
- Responds in under 5 seconds under normal conditions.

A minimal health handler:

```typescript
app.get('/health', (c) => c.json({ status: 'ok', version: c.env.GIT_COMMIT_SHA ?? 'unknown' }));
```

---

## 4. Running the Smoke Manually

```bash
# From the repo root — pass the health URL and optional retry params
./scripts/smoke-deploy.sh https://<WORKER_NAME>.<SUBDOMAIN>.workers.dev/health 5 10
```

Or, using curl directly for a one-shot check:

```bash
curl -sf https://<WORKER_NAME>.<SUBDOMAIN>.workers.dev/health && echo "OK" || echo "FAIL"
```

---

## 5. Diagnosing a Smoke Failure

### Worker returns non-200

1. **Check recent deploys:** Was there a code change that could break the health handler or the Worker boot sequence?
2. **`wrangler tail`:** Stream the Worker logs to see the error:
   ```bash
   wrangler tail --name <WORKER_NAME> --format pretty
   ```
3. **Check for startup errors:** A Worker that throws during module initialization will not respond to any route. Look for `Error: Cannot read properties of undefined` or import failures in the tail output.
4. **Check environment bindings:** A missing `env.SECRET` accessed at module scope causes an immediate crash. Compare the Worker bindings in `wrangler.toml` against the secrets set in the Cloudflare dashboard.

### Smoke times out (no response)

1. Check the Cloudflare dashboard for the Worker's CPU time / exception count on the recent deployment.
2. A brand-new deployment may cold-start slowly on the first request — increase `MAX_ATTEMPTS` or `DELAY_SECONDS` if this is expected.
3. Verify the health URL is correct (matches the deployed worker's route pattern).

### Auto-rollback fired — now what?

1. Confirm the rollback is live: `curl -sf <HEALTH_URL>`.
2. Open the failing workflow run in GitHub Actions; read the smoke step output for the HTTP status or timeout message.
3. Fix the root cause on a branch and re-run the full CI + deploy cycle.
4. Do not re-deploy the rolled-back commit directly.

---

## 6. Smoke Test Checklist

- [ ] Health endpoint is implemented and tested locally.
- [ ] Health URL is recorded in `docs/environments.md` for this environment.
- [ ] The deploy workflow is configured with the correct health URL and retry parameters.
- [ ] Post-deploy smoke passed (or auto-rollback confirmed if it failed).
- [ ] If smoke failed: root cause identified and fix is on a branch.

---

## See Also

- [Rollback Runbook](rollback.md)
- [Deploy Promotion Runbook](deploy-promotion.md)
- [Observability Runbook](observability.md)
- Project-local `docs/environments.md` — health endpoint URLs per environment.
