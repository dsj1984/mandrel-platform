# Environments Provisioning — <PROJECT_NAME>

> **Thin local stub.** The canonical environment model and step-by-step
> provisioning procedure live in the mandrel-platform repo:
> [`docs/runbooks/environments-provisioning.md`](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/environments-provisioning.md).
> This file only holds **<PROJECT_NAME>-specific IDs and names**.

---

## Project Values

| Value | Setting |
|-------|---------|
| Repo (`owner/repo`) | `<OWNER>/<REPO>` |
| Cloudflare account ID | `<CF_ACCOUNT_ID>` |
| Zone / domain | `<ZONE>` |
| Worker base name | `<WORKER_NAME>` |
| Staging domain | `<STAGING_DOMAIN>` |
| Production domain | `<PRODUCTION_DOMAIN>` |
| Secrets manager project | `<SECRETS_PROJECT_ID>` (e.g. Infisical) |
| Staging DB name | `<STAGING_DB_NAME>` |
| Production DB name | `<PRODUCTION_DB_NAME>` |

## Environment Map

| Environment | Branch | Deployed by |
|-------------|--------|-------------|
| `local` | any | developer (`wrangler dev`) |
| `staging` | `main` (auto) | CI/CD after CI-green |
| `production` | `main` (manual) | `workflow_dispatch` |

## Project-Specific Notes

<!-- Custom domains, reviewer requirements, secret-sync specifics. -->

- _TODO: fill in._

---

The authoritative environment inventory (URLs, secret names, DB names) is the
project's own `docs/environments.md`. See also the local stubs:
`branch-protection-setup.md`, `secret-rotation.md`, `deploy-promotion.md`.
