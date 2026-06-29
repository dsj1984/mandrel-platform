# Dependency Update — <PROJECT_NAME>

> **Thin local stub.** The canonical Renovate model, CVE gate, catalog, and
> override conventions live in the mandrel-platform repo:
> [`docs/runbooks/dependency-update.md`](https://github.com/dsj1984/mandrel-platform/blob/main/docs/runbooks/dependency-update.md).
> This file only holds **<PROJECT_NAME>-specific configuration pointers**.

---

## Project Values

| Value | Setting |
|-------|---------|
| Package manager | `<PACKAGE_MANAGER>` (e.g. pnpm) |
| Renovate config | `<RENOVATE_CONFIG_PATH>` |
| CVE allowlist location | `<CVE_ALLOWLIST_PATH>` |
| Audit command | `<AUDIT_COMMAND>` (e.g. `pnpm run audit:check`) |
| Renovate Dependency Dashboard | `<DASHBOARD_ISSUE_URL>` |
| Node version pin | `<NODE_VERSION>` (`.nvmrc`) |

## Common Commands

```bash
# Run the CVE gate locally (what CI sees)
<AUDIT_COMMAND>

# Out-of-band update
<PACKAGE_MANAGER> update <package-name>
```

## Project-Specific Notes

<!-- Renovate preset overrides, grouped packages, manual-merge policies. -->

- _TODO: fill in._

---

See also the local stubs: `secret-rotation.md`, `incident-response.md`, and
the project's `docs/environments.md`.
