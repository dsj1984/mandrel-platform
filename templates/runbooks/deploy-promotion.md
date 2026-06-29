# Deploy Promotion — <PROJECT_NAME>

> **Thin local stub.** The canonical, process-level procedure lives in the
> mandrel-platform repo:
> [`docs/runbooks/deploy-promotion.md`](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/deploy-promotion.md).
> This file only holds **<PROJECT_NAME>-specific values**. When the process
> changes, update the canonical runbook upstream — not this stub.

---

## Project Values

| Value | Setting |
|-------|---------|
| Staging worker name | `<STAGING_WORKER_NAME>` |
| Production worker name | `<PRODUCTION_WORKER_NAME>` |
| Staging deploy workflow | `<STAGING_DEPLOY_WORKFLOW>` (e.g. `deploy-staging.yml`) |
| Production deploy workflow | `<PRODUCTION_DEPLOY_WORKFLOW>` (e.g. `deploy-production.yml`) |
| Production health URL | `<PRODUCTION_HEALTH_URL>` |
| Staging health URL | `<STAGING_HEALTH_URL>` |
| Promotion approvers | `<APPROVER_HANDLES>` |
| Deploy-window channel | `<DEPLOY_CHANNEL>` |

## Trigger a Production Promotion

```bash
gh workflow run <PRODUCTION_DEPLOY_WORKFLOW> --ref main --field confirm=true
```

## Verify

```bash
curl -sf <PRODUCTION_HEALTH_URL> && echo OK || echo FAIL
wrangler deployments list --name <PRODUCTION_WORKER_NAME> | head -3
```

## Project-Specific Notes

<!-- Record any promotion quirks for this project: extra pre-checks, manual
     migration steps, stakeholder sign-off requirements, etc. -->

- _TODO: fill in._

---

See also the local stubs: `rollback.md`, `post-deploy-smoke.md`,
`incident-response.md`, and the project's `docs/environments.md`.
