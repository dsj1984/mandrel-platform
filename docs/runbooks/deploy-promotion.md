# Deploy Promotion Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using the mandrel-platform staging → production promotion model (Cloudflare Workers via `wrangler deploy`, `workflow_dispatch`-gated production).
> **Project-specific values** (worker names, environment names, reviewer handles) live in each consumer's local runbook that links here.

---

## 1. Promotion Model Overview

```
feature branch
    │  PR + CI gate (required checks)
    ▼
  main ──► staging auto-deploy (on push to main, after CI green)
             │  Smoke test passes
             ▼
         production ◄── manual workflow_dispatch (operator-initiated)
```

- **Staging** deploys automatically when a commit lands on `main` and CI is green. It is **not** a human-gated step.
- **Production** is gated by a manual `workflow_dispatch` trigger. The operator must explicitly initiate the promotion.
- Both deploys run the same sequence: pre-deploy env validation → DB migration (if applicable) → `wrangler deploy` → post-deploy smoke test.

---

## 2. Pre-Promotion Checklist (Production Only)

Before triggering the production promotion:

- [ ] Staging deploy is healthy (smoke test passing, error rate nominal for ≥ 30 min).
- [ ] No open incidents on staging.
- [ ] DB migration (if any) completed cleanly on staging and a pre-production snapshot has been captured.
- [ ] The commit SHA on staging matches the one you intend to promote.
- [ ] Relevant stakeholders are aware of the deploy window.
- [ ] Rollback plan is confirmed (see [Rollback Runbook](rollback.md)).

---

## 3. Triggering a Staging Deploy

Staging deploys automatically on push to `main` after CI passes. You should not need to trigger staging manually. If you must re-deploy the current `main` to staging:

```bash
# Via GitHub CLI — trigger the staging deploy workflow
gh workflow run deploy-staging.yml --ref main
```

---

## 4. Triggering a Production Promotion

```bash
# Via GitHub CLI
gh workflow run deploy-production.yml \
  --ref main \
  --field confirm=true

# Or use the GitHub Actions UI:
# Actions → deploy-production → Run workflow → confirm: true → Run
```

> The `confirm` input is a safeguard against accidental triggers. The workflow validates it before proceeding.

### 4a. What the production workflow does

1. **Pre-deploy env validation** — checks required secrets and environment variables are present.
2. **Isolation audit** (if wired) — asserts no production secrets are referenced from staging env contexts.
3. **DB migration** — runs forward-only migrations against the production DB. A snapshot is captured before this step.
4. **`wrangler deploy`** — deploys the Worker bundle to the production environment.
5. **Post-deploy smoke** — curls the production health endpoint. If it returns non-2xx after retries, triggers automatic rollback.
6. **Sentry release** (if wired) — uploads source maps and tags the release with the commit SHA.

---

## 5. Verifying the Promotion

```bash
# Check the production health endpoint
curl -sf <PRODUCTION_HEALTH_URL> && echo "OK" || echo "FAIL"

# Confirm the expected version is deployed
wrangler deployments list --name <PRODUCTION_WORKER_NAME> | head -3

# Tail the Worker logs for 2 minutes to watch for errors
wrangler tail --name <PRODUCTION_WORKER_NAME> --format pretty
```

Monitor the error rate for at least 15 minutes after a production promotion before considering the deploy stable.

---

## 6. Rolling Back a Production Deploy

If the post-deploy smoke fails or you detect a regression:

1. Check whether the CI/CD pipeline auto-rolled back (review the workflow run).
2. If not, follow the [Rollback Runbook](rollback.md).

---

## 7. Promotion Checklist

- [ ] Staging healthy for ≥ 30 min.
- [ ] Pre-promotion checklist completed (Section 2).
- [ ] Production `workflow_dispatch` triggered with `confirm: true`.
- [ ] Post-deploy smoke returned 2xx.
- [ ] Deployment ID recorded for potential rollback.
- [ ] Error rate monitored for ≥ 15 min.
- [ ] Stakeholders notified.

---

## See Also

- [Rollback Runbook](rollback.md)
- [Post-Deploy Smoke Runbook](post-deploy-smoke.md)
- [Incident Response Runbook](incident-response.md)
- Project-local `docs/environments.md` — environment slugs, worker names, health URLs.
