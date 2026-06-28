# Runbooks — `mandrel-platform`

This directory holds the **canonical common runbooks** for the mandrel-platform model. These are process-level, generic runbooks that apply to any project deploying Cloudflare Workers via the mandrel-platform CI/CD model.

**Consumer projects reference these runbooks, they do not duplicate them.**

---

## Classification: Common (here) vs. Project-Local

### Common runbooks (this directory)

Process-level runbooks that are substantially identical across all projects. They contain no project-specific values (worker names, URLs, database names).

| Runbook | Purpose |
|---------|---------|
| [`rollback.md`](rollback.md) | Code and database rollback decision tree and procedure |
| [`deploy-promotion.md`](deploy-promotion.md) | Staging → production promotion model and checklist |
| [`observability.md`](observability.md) | Querying Analytics Engine, Sentry, Logpush, and Better Stack |
| [`post-deploy-smoke.md`](post-deploy-smoke.md) | Post-deploy boot-smoke: what it does, diagnosing failures |
| [`secret-rotation.md`](secret-rotation.md) | Secret lifecycle: rotation triggers, procedure, emergency rotation |
| [`dependency-update.md`](dependency-update.md) | Renovate, manual updates, CVE gate, pnpm catalog |
| [`database-backup-restore.md`](database-backup-restore.md) | Turso backup strategy, pre-deploy snapshot, PITR, restore procedure |
| [`branch-protection-setup.md`](branch-protection-setup.md) | Applying branch protection, `main-protection.json` contract |
| [`main-protection.json`](main-protection.json) | Canonical branch protection contract (copy to your project and adjust) |
| [`environments-provisioning.md`](environments-provisioning.md) | Standing up Cloudflare, GitHub Environments, Infisical, Turso from scratch |
| [`incident-response.md`](incident-response.md) | Severity classification, escalation path, response steps, postmortem template |
| [`slo.md`](slo.md) | SLO framework, canonical targets, error-budget policy, rollback triggers |

### Project-local runbooks (stay in each consumer repo)

Runbooks that contain project-specific values or are specific to a project's features or integrations. **Do not centralize these.**

| Category | Examples |
|----------|---------|
| Environment inventory | `docs/environments.md` (each project keeps its own; never centralized) |
| Feature runbooks | `advisor-calendar-disconnected.md`, `appraisal-eval.md` (domio) |
| Integration runbooks | `clerk-persona-bootstrap.md`, `csam-provisioning.md`, `pii-erasure.md` |
| Design system | `design-system.md` (swarm-os) |
| Local dev setup | `local-webhook-testing.md` (athportal) |
| Seed / admin scripts | `seed-dev-admin.md` (athportal) |
| Project-specific SLO values | Project-local SLO supplement that links to [`slo.md`](slo.md) |

---

## How a Consumer References a Common Runbook

Consumer projects reference these runbooks by URL (relative link from their own `docs/runbooks/`) rather than duplicating the content.

### Option A: Link directly in the local runbook

In your project's `docs/runbooks/rollback.md` (a thin local file):

```markdown
# Rollback Runbook — <Project Name>

> This project follows the canonical rollback process at
> [mandrel-platform/docs/runbooks/rollback.md](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/rollback.md).
> Project-specific values are below.

## Project-Specific Values

| Item | Value |
|------|-------|
| Worker name (staging) | `<worker-name>-staging` |
| Worker name (production) | `<worker-name>-production` |
| Health endpoint | `https://<domain>/health` |
| Database name | `<db-name>` |

## Rollback Commands for This Project

\`\`\`bash
# Staging rollback
wrangler rollback --name <worker-name>-staging

# Production rollback
wrangler rollback --name <worker-name>-production
\`\`\`

See the canonical runbook for the full decision tree, DB restore procedure, and post-rollback checklist.
```

### Option B: Link from `docs/environments.md`

Add a **See Also** section to your project's `docs/environments.md`:

```markdown
## Runbook References

- [Rollback](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/rollback.md) — follow the common runbook; worker names and health URLs are in this file.
- [Incident Response](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/incident-response.md) — project-specific escalation contacts in §2 of this file.
```

### Copying `main-protection.json`

`main-protection.json` is a configuration file that should be **copied** (not linked) to each project's `docs/runbooks/` and adjusted to match that project's CI job names:

```bash
# From the mandrel-platform repo root:
cp docs/runbooks/main-protection.json <consumer-repo>/docs/runbooks/main-protection.json
# Then edit upstreamJobs to match the consumer's CI workflow job names.
```

---

## Docs-Staleness Lint

The `scripts/check-docs-staleness.mjs` script flags retired-product references in your docs — for example, references to Cloudflare Pages in docs that should describe a Worker after the web→Worker migration.

### Running the lint

```bash
# From the mandrel-platform repo root:
node scripts/check-docs-staleness.mjs

# Check a specific directory:
node scripts/check-docs-staleness.mjs --dir <path/to/docs>

# Exit 0 even when issues are found (for CI reporting without blocking):
node scripts/check-docs-staleness.mjs --warn-only
```

### Consumer adoption

Copy the script to your project or reference it via `npx`:

```bash
# Reference from a CI step (consumer project):
node node_modules/mandrel-platform/scripts/check-docs-staleness.mjs --dir docs/
```

Add it to your CI quality workflow:

```yaml
- name: Docs staleness lint
  run: node node_modules/mandrel-platform/scripts/check-docs-staleness.mjs --dir docs/
```

### What it checks

The lint flags:
- References to Cloudflare Pages deploy commands or `pages.dev` URLs in projects that have migrated to Workers.
- References to job names in `main-protection.json` that don't match any job in the CI workflow files.
- Any configurable pattern list (see `scripts/check-docs-staleness.mjs --help`).

---

## Maintenance

When a common process changes (e.g., the rollback command changes after a wrangler major update, or the deploy model changes):

1. Update the relevant runbook in this directory.
2. Tag the release or bump the `mandrel-platform` package version.
3. Consumer projects that reference these runbooks by URL automatically get the updated content.
4. Consumer projects that copied `main-protection.json` must update their copy manually — the `check-docs-staleness.mjs` lint will flag drift if the check is wired in CI.
