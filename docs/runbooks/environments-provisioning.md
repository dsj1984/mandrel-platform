# Environments Provisioning Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using the mandrel-platform environment model (Cloudflare Workers, GitHub Environments, Infisical, Turso/libSQL).
> **Project-specific values** (Cloudflare account IDs, GitHub Environment names, Infisical project IDs, DB names) live in each consumer's local runbook and `docs/environments.md`.

---

## 1. Environment Model

Each project maintains three environments:

| Environment | Branch | Deployed by | Access |
|-------------|--------|-------------|--------|
| `local` | Any branch | Developer (`wrangler dev`) | Developer only |
| `staging` | `main` (auto) | CI/CD on push after CI-green | Internal team |
| `production` | `main` (manual) | `workflow_dispatch` | Public |

The canonical description of each environment's URLs, secrets, and bindings lives in the project's own `docs/environments.md` (which is **not** centralized here — it is project-local by design).

---

## 2. Provisioning a New Project Environment

### Step 1: Cloudflare

```bash
# Create the Worker environment (the staging/production envs are defined in wrangler.toml)
# No explicit API call needed — wrangler creates the environment on first deploy.

# Verify the account and zone IDs are correct
wrangler whoami
wrangler zones list  # if using custom domains
```

Ensure `wrangler.toml` (or `wrangler.jsonc`) defines the environment under `[env.<name>]`:

```toml
[env.staging]
name = "<WORKER_NAME>-staging"
routes = [{ pattern = "<STAGING_DOMAIN>", zone_name = "<ZONE>" }]

[env.production]
name = "<WORKER_NAME>-production"
routes = [{ pattern = "<PRODUCTION_DOMAIN>", zone_name = "<ZONE>" }]
```

### Step 2: GitHub Environments

```bash
# Create GitHub Environments (staging and production)
gh api repos/<OWNER>/<REPO>/environments/staging --method PUT \
  --field wait_timer=0

gh api repos/<OWNER>/<REPO>/environments/production --method PUT \
  --field wait_timer=0
```

For production, optionally add required reviewers (GitHub Team/Pro required):

```bash
gh api repos/<OWNER>/<REPO>/environments/production --method PUT \
  --field "reviewers[][type]=User" \
  --field "reviewers[][id]=<USER_ID>"
```

### Step 3: Infisical

1. Create a new Infisical project (or environment folder within an existing project).
2. Add all secrets listed in the project's `docs/environments.md#Secret Inventory`.
3. Configure the Infisical → GitHub sync:
   - GitHub App connection: Infisical dashboard → Integrations → GitHub Actions.
   - Map each Infisical environment to the corresponding GitHub Environment (`staging` / `production`).
4. Verify secrets appear in GitHub → Settings → Environments → `staging` / `production`.

### Step 4: Turso / libSQL Database

```bash
# Create the database
turso db create <DB_NAME>-staging
turso db create <DB_NAME>-production

# Get the connection URL and token
turso db show <DB_NAME>-staging --url
turso db tokens create <DB_NAME>-staging

# Add to Infisical (or directly to GitHub Environment secrets)
gh secret set DATABASE_URL --env staging --body "$(turso db show <DB_NAME>-staging --url)"
gh secret set DATABASE_AUTH_TOKEN --env staging --body "$(turso db tokens create <DB_NAME>-staging)"
```

### Step 5: Run Migrations

```bash
# Apply the initial schema to each environment
DATABASE_URL="<STAGING_DB_URL>" DATABASE_AUTH_TOKEN="<TOKEN>" pnpm db:migrate
DATABASE_URL="<PRODUCTION_DB_URL>" DATABASE_AUTH_TOKEN="<TOKEN>" pnpm db:migrate
```

### Step 6: Deploy

```bash
# Staging (triggers automatically on push to main after CI — or manually):
gh workflow run deploy-staging.yml --ref main

# Verify
curl -sf <STAGING_HEALTH_URL> && echo "OK"
```

---

## 3. Decommissioning an Environment

```bash
# 1. Delete the Cloudflare Worker
wrangler delete --name <WORKER_NAME>-staging

# 2. Delete the GitHub Environment
gh api repos/<OWNER>/<REPO>/environments/staging --method DELETE

# 3. Archive or delete the Turso database
turso db destroy <DB_NAME>-staging --yes

# 4. Remove secrets from Infisical
# (via the Infisical dashboard — delete the environment or the project)

# 5. Update docs/environments.md to remove the decommissioned environment
```

---

## 4. Adding a New Secret to an Existing Environment

1. Add the secret to Infisical (in the appropriate environment).
2. Wait for the Infisical → GitHub sync to propagate (or set it manually via `gh secret set`).
3. Add the secret name to the `env:` block in the deploy workflow:
   ```yaml
   env:
     NEW_SECRET: ${{ secrets.NEW_SECRET }}
   ```
4. Add the binding to `wrangler.toml` if the secret needs to be a Worker binding:
   ```toml
   [env.staging.vars]
   # Non-secret vars (public) go here
   # Secrets are injected via `wrangler secret put` or the deploy workflow
   ```
5. Redeploy to staging and verify the Worker reads the new secret correctly.

---

## 5. Provisioning Checklist

- [ ] Cloudflare Worker environment defined in `wrangler.toml`.
- [ ] GitHub Environments (`staging`, `production`) created.
- [ ] Infisical project and environments configured with all secrets.
- [ ] Infisical → GitHub sync active and verified.
- [ ] Turso databases created and connection strings stored as secrets.
- [ ] Initial DB migrations applied to each environment.
- [ ] Staging deploy successful and smoke passing.
- [ ] Project's `docs/environments.md` updated with the new environment details.
- [ ] Branch protection applied (see [Branch Protection Setup](branch-protection-setup.md)).

---

## See Also

- [Secret Rotation Runbook](secret-rotation.md)
- [Branch Protection Setup Runbook](branch-protection-setup.md)
- [Deploy Promotion Runbook](deploy-promotion.md)
- Project-local `docs/environments.md` — the authoritative environment inventory (URLs, secret names, DB names, Infisical project IDs).
