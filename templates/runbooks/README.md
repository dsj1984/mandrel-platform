# Runbook Templates (copyable thin stubs)

These are **copyable thin-stub templates** for the eight most commonly-adopted
canonical mandrel-platform runbooks in
[`docs/runbooks/`](https://github.com/dsj1984/mandrel-platform/tree/main/docs/runbooks)
(listed in the table below). It is **not** a stub-per-canonical-runbook set —
several canonical runbooks (`rollback.md`, `slo.md`, `secret-rotation.md`,
`pin-drift-dashboard.md`) are platform-process docs a consumer reads directly
and ships no local stub for. They implement the MP-9 adoption model
(§7.7 / F1): *replace each duplicated process runbook with a thin local doc
that holds project-specific values plus a link to the canonical runbook.*

Each stub:

- **Links** to its canonical mandrel-platform runbook (the process source of
  truth — do not re-author the process here).
- Carries **placeholders** for project-specific values in `<ANGLE_BRACKET>`
  form (hosts, env names, dashboards, DB engine, worker names, …).

## How to adopt (downstream repo)

**Automated path (recommended).** The adoption CLI materializes every stub for
you (link-only, never clobbering a stub you've already filled in) as part of a
full sync — see [`scripts/platform-sync.mjs`](../../README.md#adoption-cli-platform-sync):

```bash
node node_modules/mandrel-platform/scripts/platform-sync.mjs --ref mandrel-platform-v0.10.0
```

**Manual path.**

1. Copy the stub(s) you need into your project's `docs/runbooks/`:
   ```bash
   cp node_modules/mandrel-platform/templates/runbooks/deploy-promotion.md \
      docs/runbooks/deploy-promotion.md
   ```
2. Replace every `<PLACEHOLDER>` with your project's real values.
3. Fill in the **Project-Specific Notes** section.
4. Leave the canonical link intact — when the upstream process changes, you only
   re-read the link, not rewrite the stub.

## Stubs

| Stub | Canonical runbook |
|------|-------------------|
| `deploy-promotion.md` | staging → production promotion |
| `incident-response.md` | severity, escalation, postmortem |
| `database-backup-restore.md` | backup, PITR, restore/rollback |
| `observability.md` | logs, Sentry, uptime, metrics |
| `post-deploy-smoke.md` | boot-smoke gate + diagnosis |
| `environments-provisioning.md` | env model + provisioning steps |
| `dependency-update.md` | Renovate, CVE gate, catalog |
| `branch-protection-setup.md` | aggregator required-check model |

> Placeholder convention: `<UPPER_SNAKE>` between angle brackets. Search for
> `<` after copying to find everything that still needs a value.
