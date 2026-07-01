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
- [ ] Deployment branch policy applied to every environment (see [§6](#6-deployment-branch-policy) below).

---

## 6. Deployment Branch Policy

GitHub Environments and **deployment branch policies** are two separate
controls that are easy to conflate:

- **GitHub Environments** (`staging` / `production`) gate *which secrets* a
  job can read and *whether reviewers must approve* before a deployment job
  runs. Every mandrel-platform consumer provisions the same two environments
  uniformly (0 required reviewers is the deliberate, solo-maintained default
  — see [Out of Scope](#out-of-scope) below).
- **Deployment branch policies** gate *which git ref* is allowed to trigger a
  deployment to that environment at all, independent of secrets or
  reviewers. This is the control this section covers, and it is where
  consumers have historically diverged: some projects configure it on every
  environment, some on only one, some not at all.

### Canonical posture

**Only `main` may deploy, on both `staging` and `production`.** Concretely,
each environment must have:

- `deployment_branch_policy.custom_branch_policies: true` (NOT
  `protected_branches: true` — "protected branches only" silently admits
  *any* branch that later gains a protection rule, which is a wider surface
  than intended and drifts without a workflow change).
- Exactly **one** named branch policy, and that policy's `name` is the
  literal branch name `main` — never a wildcard (`*`, `release/*`, etc.) and
  never a second policy for a hotfix/staging branch. A single exact name is
  the whole point: it is the one lever that can't silently widen.

This mirrors the platform's `baseBranch` convention (`.agentrc.json` →
`project.baseBranch`, default `main`) — the same branch every Story/Epic PR
merges into is the only branch permitted to deploy.

### Why this matters

A deploy job authorized by a compromised feature branch, an accidentally
un-deleted long-lived branch, or a fork PR is a direct production-secrets
exposure path — the deployment branch policy is the last gate between "code
on a branch" and "code with `CLOUDFLARE_API_TOKEN` in scope." Without a
custom policy, GitHub's default is **no restriction**: any branch can
trigger a deployment to the environment as long as it can reach the
`workflow_call` in the first place.

### Applying the policy

```bash
# Enable custom branch policies on the environment (idempotent).
gh api repos/<OWNER>/<REPO>/environments/staging --method PUT \
  --field "deployment_branch_policy[protected_branches]=false" \
  --field "deployment_branch_policy[custom_branch_policies]=true"

# Add the single allowed branch policy.
gh api repos/<OWNER>/<REPO>/environments/staging/deployment-branch-policies \
  --method POST \
  --field name=main

# Repeat for production.
gh api repos/<OWNER>/<REPO>/environments/production --method PUT \
  --field "deployment_branch_policy[protected_branches]=false" \
  --field "deployment_branch_policy[custom_branch_policies]=true"
gh api repos/<OWNER>/<REPO>/environments/production/deployment-branch-policies \
  --method POST \
  --field name=main
```

If a stale policy already exists (e.g. a wildcard or a second branch from an
earlier experiment), list and delete it first:

```bash
gh api repos/<OWNER>/<REPO>/environments/staging/deployment-branch-policies
gh api repos/<OWNER>/<REPO>/environments/staging/deployment-branch-policies/<policy-id> --method DELETE
```

### Verifying with the shared isolation-audit unit

Rather than eyeballing `gh api` output, adopt the shared **Environments
isolation-audit** composite action
(`.github/actions/environments-isolation-audit`), which encodes exactly the
posture above and fails loudly on any drift (missing policy, wildcard,
protected-branches-only, wrong branch, or a mismatched count). It ships as
an opt-in job in [`deploy-cloudflare.yml`](../reusable-workflows.md#environments-isolation-audit) —
see [Adopting the isolation audit](#adopting-the-isolation-audit) below for
the wiring, or invoke the composite action directly from any other
workflow:

```yaml
- name: Environments isolation audit
  uses: dsj1984/mandrel-platform/.github/actions/environments-isolation-audit@<sha>
  with:
    environments: 'staging,production'
    allowed-branch: 'main'
  env:
    GH_TOKEN: ${{ github.token }}
```

### Adopting the isolation audit

`deploy-cloudflare.yml` ships the audit as an **opt-in** job
(`enable-environments-isolation-audit`, default `false`) so existing
consumers that have not yet applied the canonical posture above are not
broken by picking up a workflow update. Adoption is two steps:

1. Apply the canonical posture (previous section) to every environment you
   intend to audit.
2. Flip the flag on in your `deploy-cloudflare.yml` caller:

   ```yaml
   jobs:
     deploy:
       uses: dsj1984/mandrel-platform/.github/workflows/deploy-cloudflare.yml@<sha>
       with:
         environment: production
         gh-environment: production
         workers: "api,worker-cron"
         enable-environments-isolation-audit: true
         # Optional: audit additional environments beyond gh-environment.
         environments-to-audit: 'staging'
       secrets: inherit
   ```

   When `gh-environment` is empty (repo-scoped / D1 consumers with no
   GitHub Environment attached to the deploy), set `environments-to-audit`
   explicitly to the environment name(s) you want audited — the job has
   nothing to resolve from `gh-environment` alone in that case.

Existing per-consumer adoption status (validated 2026-07-01): swarm-os has
the canonical policy on both environments already; athportal has it on
`staging` only (needs `production`); domio has neither (needs both).
Consumer adoption itself is out of scope for this runbook change — see
[Out of Scope](#out-of-scope) — but each consumer can flip the flag
immediately once its own branch policies are in place.

### Consumers-matrix follow-up (action required, tracked outside this repo)

This platform repo has no in-repo "consumers matrix" file — cross-consumer
rollout tracking for shared units lives in each consumer's own repo-ops
tracking doc (`mandrel-platform-consumers.md`, where present), the same
convention documented for the pnpm supply-chain block rollout (see
[pin-drift-dashboard.md](pin-drift-dashboard.md#pnpm-native-supply-chain-rollout-tracking-story-133)).
**Action required:** whichever repo/document hosts the "repo-ops consumers
matrix" referenced in Story #172 (§3/§3a Environments rows) needs its ◐ → ●
cells flipped for the Environments isolation-audit now that the shared unit
has shipped here — that edit is out of this repo's reach (the file is not
present in mandrel-platform) and must be applied directly in the
matrix's home document/repo once this Story merges.

### Out of Scope

- **Required reviewers on environments.** 0 reviewers is the deliberate,
  solo-maintained default across all consumers — this section governs
  *branch* policy only, not the *reviewer* protection rule.
- **Per-consumer rollout.** Applying the policy and flipping the flag in
  domio/athportal/swarm-os is tracked as separate, per-consumer work.

---

## See Also

- [Secret Rotation Runbook](secret-rotation.md)
- [Branch Protection Setup Runbook](branch-protection-setup.md)
- [Deploy Promotion Runbook](deploy-promotion.md)
- Project-local `docs/environments.md` — the authoritative environment inventory (URLs, secret names, DB names, Infisical project IDs).
