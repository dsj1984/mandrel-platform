# Secret Rotation Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using the mandrel-platform secret management model (Infisical → GitHub Environment secrets → `wrangler secret put`).
> **Project-specific values** (secret names, Infisical project IDs, rotation schedules) live in each consumer's local runbook that links here.

---

## 1. Secret Inventory

Secrets live in **two canonical locations**:

| Location | Purpose | Source of truth |
|----------|---------|-----------------|
| Infisical (project) | Developer-accessible secret store; syncs to GitHub via Infisical → GitHub integration | Yes — Infisical is the SSOT |
| GitHub Environment secrets | Used by CI/CD workflows (staging / production environments) | Synced from Infisical; do not edit directly unless Infisical sync is broken |
| Cloudflare Worker runtime | Injected via `wrangler secret put` or the GitHub Deploy workflow | Synced from GitHub secrets during the deploy step |

**Never hardcode secrets** in source code, `wrangler.toml`, or workflow YAML. The deploy workflow reads secrets from GitHub Environment variables and injects them at deploy time.

---

## 2. Rotation Triggers

Rotate a secret immediately when:

- A secret is suspected to have leaked (committed to a repo, logged, exposed in an error message).
- A team member with access to the secret leaves the organization.
- An integrated third-party reports a breach on their side.
- The secret has reached its maximum age per the project's security policy.

Rotate on the scheduled cadence (see `docs/environments.md` for per-project schedules) for:

- Database credentials.
- API keys for external services.
- JWT signing secrets.

---

## 3. Rotation Procedure

### Step 1: Generate a new secret value

Generate a new value using the appropriate method for the secret type:

```bash
# Generic strong random secret (32 bytes, base64-encoded)
openssl rand -base64 32

# JWT signing key (256-bit)
openssl rand -hex 32
```

For third-party API keys (Clerk, Sentry, etc.), rotate via the provider's dashboard.

### Step 2: Update Infisical

1. Log in to the Infisical dashboard.
2. Navigate to the project and environment (staging / production).
3. Update the secret value.
4. If the Infisical → GitHub sync is active, it will propagate automatically (check the sync status in Infisical).

### Step 3: Update GitHub Environment secrets (if Infisical sync is not active)

```bash
# Update a GitHub Environment secret directly
gh secret set <SECRET_NAME> \
  --env <ENVIRONMENT_NAME> \
  --body "<NEW_VALUE>"
```

### Step 4: Update the Cloudflare Worker runtime secret

```bash
# For a Workers deployment
wrangler secret put <SECRET_NAME> --name <WORKER_NAME> --env <ENVIRONMENT>

# Paste the new value when prompted — do not pass it as a flag
```

> **Note:** `wrangler secret put` does not restart the Worker. Cloudflare propagates the new secret to all isolates within ~30 seconds. If zero-downtime rotation is required, deploy a new Worker version immediately after updating the secret.

### Step 5: Verify the rotation

1. Trigger the staging deploy workflow to confirm the new secret is picked up correctly.
2. Run the post-deploy smoke to confirm the Worker boots.
3. Check that the functionality backed by the rotated secret is working (e.g., login flow for a JWT secret, external API calls for an API key).

### Step 6: Revoke the old secret

- Revoke the old value at the provider (third-party dashboard, Cloudflare API token settings).
- Remove the old value from any local `.env` files or developer machines.

---

## 4. Emergency Rotation (Suspected Leak)

1. **Revoke immediately** — revoke the suspected secret at the provider before rotating. Do not wait to generate the replacement first.
2. Follow Steps 1–5 above as fast as possible.
3. Run a full-history secret scan to confirm the secret is not present in the git history:
   ```bash
   gitleaks detect --source . --no-git=false
   ```
4. If the secret is found in git history, it must be purged via `git filter-repo` or BFG — this is destructive. Escalate to the on-call lead before proceeding.
5. Open a security incident issue and document the rotation, scope, and timeline.

---

## 5. Rotation Checklist

- [ ] New secret value generated.
- [ ] Infisical updated (or GitHub Environment secret updated directly).
- [ ] Cloudflare Worker runtime secret updated via `wrangler secret put`.
- [ ] Staging deploy triggered and smoke passing with new secret.
- [ ] Old secret revoked at the provider.
- [ ] Local `.env` files updated on developer machines.
- [ ] Incident issue opened (for emergency rotations).
- [ ] Secret scan run to confirm no leaked value in git history.

---

## See Also

- [Incident Response Runbook](incident-response.md)
- [Observability Runbook](observability.md)
- Project-local `docs/environments.md` — secret inventory, Infisical project IDs, rotation schedules.
