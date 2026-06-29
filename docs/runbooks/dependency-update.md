# Dependency Update Runbook

> **Type:** Common / Process-level
> **Scope:** Any project using the mandrel-platform dependency management model (pnpm workspaces, Renovate, pnpm catalog, CVE audit gate).
> **Project-specific values** (Renovate config overrides, CVE allowlist, runner setup) live in each consumer's local runbook that links here.

---

## 1. Automated Updates (Renovate)

All projects use Renovate for automated dependency updates. The shared preset (referenced from `mandrel-platform`) enforces:

- **Schedule:** Weekly, Monday before 09:00 America/New_York.
- **Release age:** Minimum 3 days before a PR is opened (avoids yanked/broken releases).
- **Auto-merge:** Patch and minor updates auto-merge when CI is green. Major updates require manual approval via the Dependency Dashboard.
- **Grouping:** Related packages (Cloudflare, Sentry, Clerk, ESLint, etc.) are grouped into single PRs.
- **GitHub Actions:** Action SHAs are updated with full SHA pinning on every bump.
- **mandrel-platform `uses:` pins:** A `github-actions` manager rule bumps SHA-pinned references to mandrel-platform's reusable workflows and composite actions (`uses: dsj1984/mandrel-platform/...@<sha>`), grouped into a single **"mandrel-platform workflows"** PR. This stops consumers from drifting onto split, stale pins (e.g. `pr-quality.yml` on an old release while `deploy-cloudflare.yml` is on another).

### Pinning mandrel-platform `uses:` so Renovate can bump it

Renovate only updates a **bare-SHA** action pin when a version comment follows it. Pin mandrel-platform workflow/action references with a trailing `# <tag>` comment:

```yaml
# ✅ bumped by the "mandrel-platform workflows" group
- uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@<sha> # v0.10.0

# ❌ bare SHA, no comment — Renovate leaves it pinned forever
- uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@<sha>
```

The grouped PR rides the same weekly schedule and 3-day `minimumReleaseAge` as every other update, and auto-merges on green CI like other patch/minor bumps.

### Reviewing Renovate PRs

1. The Renovate Dependency Dashboard issue lists all pending, open, and rate-limited PRs.
2. Patch/minor PRs that pass CI will auto-merge — no action needed unless CI fails.
3. For major version bumps (dashboard approval required): review the package changelog, check for breaking changes against usages in the codebase, approve via the Dashboard, and monitor CI.

### Re-running Renovate manually

```bash
# Trigger a Renovate run via the Dependency Dashboard issue — check the "Rebase all PRs" checkbox.
# Or via GitHub CLI (if you have Renovate wired as a workflow):
gh workflow run renovate.yml
```

---

## 2. Manual Dependency Updates

For out-of-band security patches or urgent updates that can't wait for Renovate:

```bash
# Update a specific package in the workspace
pnpm update <package-name> --recursive

# Update to a specific version
pnpm add <package-name>@<version> --recursive

# After updating, verify the lockfile
pnpm install --frozen-lockfile
```

Commit the lockfile change (`pnpm-lock.yaml`) alongside the version bump in `package.json` or `pnpm-workspace.yaml`.

---

## 3. CVE Audit Gate

Every CI run executes a CVE audit against the production dependency graph:

```bash
# Run locally to see what CI sees
pnpm run audit:check
# or
node scripts/audit-check.mjs
```

The gate **blocks** on any High or Critical severity vulnerability in the production dependency graph (`--prod`) that is not listed in the CVE allowlist.

### Resolving a CVE gate failure

1. **Update the package** to a version that resolves the CVE. This is always preferred.
2. If no fix is available, add a temporary allowlist entry:
   ```json
   // In the CVE allowlist (project-specific location — see docs/environments.md)
   {
     "id": "GHSA-xxxx-xxxx-xxxx",
     "expires": "2025-12-31",
     "reason": "No fix available; upstream tracking issue: <URL>"
   }
   ```
   Allowlist entries **must** include an expiry date and a reason. The gate will re-fail when the entry expires.
3. If the CVE is in a dev-only dependency (not in the `--prod` graph), the gate will not fire — but you should still update it.

### Checking which packages are affected

```bash
pnpm audit --prod --json | jq '.vulnerabilities | keys[]'
```

---

## 4. Pnpm Catalog (`pnpm-workspace.yaml`)

The project uses a pnpm catalog to single-source dependency versions. All workspace packages reference catalog entries rather than pinning versions independently:

```yaml
# pnpm-workspace.yaml
catalog:
  typescript: "^5.8.3"
  "@cloudflare/workers-types": "^4.20250620.0"
```

When updating a catalog entry, the change propagates to all workspace packages automatically on the next `pnpm install`.

```bash
# Update a catalog entry
pnpm update --catalog typescript@^5.9.0

# Verify all packages resolved correctly
pnpm install --frozen-lockfile && pnpm run typecheck
```

---

## 5. Pnpm Overrides (CVE Floors)

Security-critical overrides that force a minimum safe version for transitive dependencies live in `pnpm-workspace.yaml` under `overrides:`. These are not the same as catalog entries — they force every package in the tree to use at least the specified version.

```yaml
# pnpm-workspace.yaml
overrides:
  "minimatch@<3.0.8": ">=3.0.8"   # CVE-2022-3517 — expires 2026-06-01
```

Overrides require both a reason comment and an expiry date. Remove expired overrides once the upstream package has been updated.

---

## 6. Node / pnpm Version Updates

Node and pnpm versions are pinned in `.nvmrc` and `package.json#engines`. Renovate manages these via the `nvm` manager.

When a Node or pnpm update lands:

1. Update `.nvmrc` to the new patch version.
2. Update `engines.node` in `package.json` to match.
3. Run `pnpm install` to regenerate the lockfile with the new engine pin.
4. Run the full local CI gate to confirm nothing breaks.
5. Update the pinned SHA for `actions/setup-node` in any workflows not managed via Renovate.

---

## 7. Dependency Update Checklist

- [ ] Renovate Dependency Dashboard reviewed — no stale or failed PRs.
- [ ] CVE audit gate passes locally (`pnpm run audit:check`).
- [ ] Lockfile committed alongside any version bump.
- [ ] Catalog entries updated rather than workspace-level pins where applicable.
- [ ] Any new CVE allowlist entries include an expiry date and reason.
- [ ] Expired overrides removed or renewed.
- [ ] CI gate passes on the update branch before merging.

---

## See Also

- [Secret Rotation Runbook](secret-rotation.md) — for security-motivated updates.
- [Incident Response Runbook](incident-response.md) — for urgent CVE remediation.
- Project-local `docs/environments.md` — CVE allowlist location, Renovate config overrides.
