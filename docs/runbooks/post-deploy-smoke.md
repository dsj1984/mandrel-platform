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

The smoke test is a **built-in job of the shared `deploy-cloudflare.yml`
workflow** — the `boot-smoke` job that runs after the `deploy` job succeeds.
There is no `smoke-deploy.sh` script to invoke; the probe is driven by the
workflow's `smoke*` inputs. The default probe HTTP-GETs each `smoke_paths`
entry (default `/health`) against each deployed worker's derived
`workers.dev` host and treats any 2xx as a pass; a non-2xx (or timeout) fails
the run and triggers `wrangler rollback`.

Consumer-facing inputs (see
[`reusable-workflows.md` — deploy-cloudflare.yml](../reusable-workflows.md#deploy-cloudflareyml)):

| Input | Purpose |
|-------|---------|
| `smoke` | Run the built-in boot-smoke + auto-rollback job. Default `true`; set `false` to run your own post-deploy verification instead (auto-rollback is skipped too). |
| `smoke_paths` | Comma-separated paths probed against each target (e.g. `/,/portal,/api/health`). Default `/health`; each path needs a leading slash. |
| `smoke_base_url` | Base URL to prepend to each path instead of the derived `workers.dev` host (e.g. `https://godomio.com`). No trailing slash. |
| `smoke-command` | A consumer-supplied smoke command that **replaces** the built-in probe entirely (multi-route / custom-host consumers). Runs with `WORKERS` and `SMOKE_BASE_URL` exported; a non-zero exit fails the run and triggers the same rollback. |
| `workers_dev_subdomain` | `workers.dev` account slug used to build the probe URL. Derived from `wrangler whoami` when empty. |
| `verify-commit-sha` | Opt-in: additionally assert each worker's health `version` field matches `github.sha` (see § 3). |

On a smoke failure, the workflow triggers `wrangler rollback` for the
affected worker(s) and fails the run.

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

### Commit-SHA verification (opt-in, Story #176)

The `version` field above is not just informational — `deploy-cloudflare.yml`
can verify it. Passing `verify-commit-sha: true` to the reusable workflow
makes the built-in boot-smoke probe additionally assert that the deployed
worker's `version` matches the commit SHA (`github.sha`) this run is
deploying. A mismatch, or a missing/unparsable `version` field, fails the
smoke check and triggers the same auto-rollback as an HTTP-status failure.

This requires `GIT_COMMIT_SHA` to actually be injected as a build-time /
runtime binding pointing at the deployed commit — each consumer owns that
injection in its own build step (the build-split model). `verify-commit-sha`
is opt-in and defaults to `false` so consumers that have not yet wired
`GIT_COMMIT_SHA` through are unaffected. See
[`reusable-workflows.md` — Commit-SHA verification](../reusable-workflows.md#commit-sha-verification-opt-in)
for the full input contract.

---

## 4. Running the Smoke Manually

The smoke gate lives in the workflow, not a standalone script, so reproduce it
manually with `curl` against the same health URL the built-in probe targets:

```bash
# One-shot check — the same 2xx/non-2xx decision the built-in probe makes
curl -sf https://<WORKER_NAME>.<SUBDOMAIN>.workers.dev/health && echo "OK" || echo "FAIL"
```

To mirror the workflow's retry behaviour (it retries a slow cold-start before
declaring failure), loop the same check:

```bash
HEALTH_URL="https://<WORKER_NAME>.<SUBDOMAIN>.workers.dev/health"
for attempt in $(seq 1 5); do
  if curl -sf -o /dev/null "$HEALTH_URL"; then echo "Smoke passed (attempt $attempt)"; break; fi
  echo "Smoke attempt $attempt failed — retrying in 10s"; sleep 10
done
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
