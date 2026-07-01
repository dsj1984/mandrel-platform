#!/usr/bin/env node
/**
 * platform-sync.mjs — mandrel-platform adoption / drift-repair CLI (MP-14).
 *
 * The operator-facing analogue of `mandrel sync`. Run it from the root of a
 * **consumer** repo to adopt mandrel-platform — or to repair the three drift
 * states the founding audit (§4.1) called out:
 *
 *   1. SPLIT PINS — consumer workflows reference
 *      `dsj1984/mandrel-platform/...@<sha>` at mixed/stale SHAs. This command
 *      resolves a chosen release ref (e.g. `mandrel-platform-v0.10.0`, or the
 *      `@v1` floating tag once MP-13 ships it) to its commit SHA and rewrites
 *      every first-party `uses:` pin to that single SHA — leaving the
 *      `# <ref>` trailing comment so the pin stays human-auditable and
 *      Renovate's `helpers:pinGitHubActionDigests`-style bump rule can track
 *      it (MP-11).
 *
 *   2. LOCAL-COPY RUNBOOKS — consumer holds full local copies of the shared
 *      process runbooks instead of thin reference stubs (§2.2 "reference,
 *      don't copy"). This command materializes the canonical reference stubs
 *      from `templates/runbooks/` into the consumer's `docs/runbooks/`,
 *      **link-only** — it never overwrites a stub the operator has already
 *      filled in (idempotent by content-marker detection).
 *
 *   3. UN-SIMPLIFIED CONFIG — consumer's `renovate.json` / `tsconfig.json`
 *      hand-reimplement what the shared preset / base config already provide.
 *      This command reconciles the `extends` chains so the consumer extends
 *      the SSOT (`github>dsj1984/mandrel-platform` for Renovate,
 *      `mandrel-platform/tsconfig.base.json` for TypeScript).
 *
 * It also runs a fourth, **advisory-only** check (Story #173): whether the
 * consumer's `.github/workflows/ci.yml` matches the canonical CI-caller
 * naming triplet (file `ci.yml`, display name `CI`, caller job id `ci` →
 * required context `ci / ci-required`; see
 * `docs/reusable-workflows.md` § "Canonical caller naming"). This never
 * renames or rewrites anything — renaming an existing caller must land
 * atomically with its own branch-protection ruleset context update, which is
 * a deliberate per-consumer Story, not an automatic sync side-effect.
 *
 * It also materializes canonical workflow **caller templates** from
 * `templates/workflows/` into the consumer's `.github/workflows/` (Story
 * #175) — e.g. `deploy-staging.yml`, the one-paved-road `workflow_run` caller
 * for the shared `deploy-cloudflare.yml`'s CI-green guard. Same link-don't-
 * copy semantics as the runbook stubs: never overwrites an existing file.
 *
 * Idempotent: re-running on an already-synced consumer makes no changes and
 * reports `unchanged`. `--dry-run` prints the planned diff without touching
 * disk or the network mutation.
 *
 * Usage (from the consumer repo root):
 *   node node_modules/mandrel-platform/scripts/platform-sync.mjs --ref mandrel-platform-v0.10.0
 *   node .../platform-sync.mjs --ref v1 --dry-run
 *   node .../platform-sync.mjs --ref <ref> --consumer /path/to/consumer --templates /path/to/mandrel-platform/templates
 *
 * Flags:
 *   --ref <ref>          (required) release tag / branch / floating tag to pin to.
 *   --dry-run            plan only; no disk writes, no SHA resolution network call
 *                        when --sha is also supplied.
 *   --sha <40-hex>       skip ref→SHA resolution and pin to this SHA directly
 *                        (offline / test mode).
 *   --consumer <dir>     consumer repo root (default: process.cwd()).
 *   --templates <dir>    mandrel-platform templates/ dir (default: resolved
 *                        relative to this script — works when run from
 *                        node_modules/mandrel-platform/scripts/).
 *   --repo <owner/repo>  first-party slug to pin (default: dsj1984/mandrel-platform).
 *   --json               emit the result envelope as JSON on stdout.
 *
 * Exit codes:
 *   0 — sync applied or already in sync (or dry-run printed cleanly).
 *   1 — a fatal error (unresolvable ref, missing templates, malformed config).
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const opts = {
  ref: null,
  sha: null,
  dryRun: false,
  consumer: process.cwd(),
  templates: null,
  repo: "dsj1984/mandrel-platform",
  json: false,
  // GitHub-side repo-settings check/apply mode (Story #171). This is a
  // distinct mode from the local-checkout file sync above — it operates over
  // the GitHub API against a `--consumer-repo owner/repo` slug rather than a
  // local `--consumer <dir>` checkout, so it short-circuits main() below
  // rather than composing with the pin/runbook/extends reconciliation.
  checkSettings: false,
  applySettings: false,
  consumerRepo: null,
  baseline: null,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--ref" && args[i + 1]) opts.ref = args[++i];
  else if (a === "--sha" && args[i + 1]) opts.sha = args[++i];
  else if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--consumer" && args[i + 1]) opts.consumer = resolve(args[++i]);
  else if (a === "--templates" && args[i + 1]) opts.templates = resolve(args[++i]);
  else if (a === "--repo" && args[i + 1]) opts.repo = args[++i];
  else if (a === "--json") opts.json = true;
  else if (a === "--check-settings") opts.checkSettings = true;
  else if (a === "--apply-settings") opts.applySettings = true;
  else if (a === "--consumer-repo" && args[i + 1]) opts.consumerRepo = args[++i];
  else if (a === "--baseline" && args[i + 1]) opts.baseline = resolve(args[++i]);
  else if (a === "--help" || a === "-h") {
    printHelp();
    process.exit(0);
  } else {
    fail(`Unknown argument: ${a}`);
  }
}

function printHelp() {
  // Echo the usage block from the file header so `--help` stays in sync.
  process.stdout.write(
    [
      "platform-sync — mandrel-platform adoption / drift-repair CLI (MP-14)",
      "",
      "Usage (from the consumer repo root):",
      "  node node_modules/mandrel-platform/scripts/platform-sync.mjs --ref <ref> [--dry-run]",
      "",
      "Flags:",
      "  --ref <ref>          (required unless --check-settings/--apply-settings) release",
      "                        tag / branch / floating tag to pin to.",
      "  --dry-run            plan only; no disk writes / no GitHub-side mutation.",
      "  --sha <40-hex>       skip ref->SHA resolution; pin to this SHA (offline mode).",
      "  --consumer <dir>     consumer repo root (default: cwd).",
      "  --templates <dir>    mandrel-platform templates/ dir (default: resolved from script).",
      "  --repo <owner/repo>  first-party slug to pin (default: dsj1984/mandrel-platform).",
      "  --json               emit the result envelope as JSON.",
      "",
      "GitHub-side repo-settings check/apply (Story #171):",
      "  --check-settings          read a consumer's LIVE repo settings via `gh api` and",
      "                            report drift against the baseline (never blocks; report only).",
      "  --apply-settings          same read, then PATCH the drifted fields to match the",
      "                            baseline (safe subset only — see README). Implies --check-settings.",
      "  --consumer-repo <owner/repo>  (required with --check-settings/--apply-settings) the",
      "                            consumer repo to read/patch over the GitHub API.",
      "  --baseline <path>         path to the repo-settings baseline JSON",
      "                            (default: docs/runbooks/repo-settings.json next to this script's package).",
      "",
    ].join("\n")
  );
}

function fail(msg) {
  process.stderr.write(`❌ platform-sync: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logging — quiet under --json (the envelope is the only stdout artifact).
// ---------------------------------------------------------------------------

function log(msg) {
  if (!opts.json) process.stdout.write(`${msg}\n`);
}

// ---------------------------------------------------------------------------
// Defaults requiring resolution
// ---------------------------------------------------------------------------

const settingsMode = opts.checkSettings || opts.applySettings;

if (settingsMode) {
  if (!opts.consumerRepo) {
    fail("--consumer-repo <owner/repo> is required with --check-settings/--apply-settings.");
  }
  if (!opts.baseline) {
    opts.baseline = resolve(__dirname, "..", "docs", "runbooks", "repo-settings.json");
  }
} else {
  if (!opts.ref) fail("--ref <release-tag|branch|floating-tag> is required.");
  if (opts.sha && !/^[0-9a-fA-F]{40}$/.test(opts.sha)) {
    fail(`--sha must be a 40-character hex commit SHA (got: ${opts.sha}).`);
  }
}

// templates/ defaults to the dir adjacent to this script's package root.
// When run from node_modules/mandrel-platform/scripts/, that is
// node_modules/mandrel-platform/templates/.
if (!opts.templates) {
  opts.templates = resolve(__dirname, "..", "templates");
}
const runbookTemplatesDir = join(opts.templates, "runbooks");
const workflowTemplatesDir = join(opts.templates, "workflows");

// ---------------------------------------------------------------------------
// 1. Resolve the chosen ref → commit SHA
// ---------------------------------------------------------------------------

/**
 * Resolve `ref` (tag/branch/floating tag) on the remote `repo` to its full
 * 40-char commit SHA. Uses `git ls-remote`, which needs no checkout and works
 * for tags, annotated tags (peeled `^{}`), and branches. In --dry-run with an
 * explicit --sha we skip the network entirely.
 */
function resolveSha() {
  if (opts.sha) return opts.sha;
  const remote = `https://github.com/${opts.repo}.git`;
  let out;
  try {
    out = execFileSync("git", ["ls-remote", remote, opts.ref, `${opts.ref}^{}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    fail(
      `could not resolve ref '${opts.ref}' on ${opts.repo}: ${
        (err && err.stderr) || err.message
      }`
    );
  }
  const lines = out.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    fail(`ref '${opts.ref}' not found on ${opts.repo}.`);
  }
  // Prefer the peeled (`^{}`) line for annotated tags — that is the commit the
  // tag ultimately points at, which is what a `uses: ...@<sha>` pin must use.
  const peeled = lines.find((l) => l.endsWith(`^{}`));
  const chosen = peeled || lines[0];
  const sha = chosen.split(/\s+/)[0];
  if (!/^[0-9a-fA-F]{40}$/.test(sha)) {
    fail(`resolved ref '${opts.ref}' to a non-SHA value: '${sha}'.`);
  }
  return sha;
}

// ---------------------------------------------------------------------------
// 2. Pin first-party `uses:` SHAs in consumer workflows
// ---------------------------------------------------------------------------

/** Recursively collect `.yml`/`.yaml` files under a directory. */
function collectYaml(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) found.push(...collectYaml(full));
    else if (/\.ya?ml$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * Rewrite every first-party `uses: <repo>/<path>@<oldSha>` to the target SHA.
 * The match mirrors check-workflow-portability.mjs's internal-pin regex but is
 * scoped to the configured `repo` slug (the consumer's workflows reference
 * mandrel-platform explicitly, so the slug is known). Preserves any trailing
 * `# <comment>` but rewrites it to `# <ref>` so the human-readable annotation
 * tracks the chosen release.
 */
function pinWorkflows(targetSha) {
  const workflowsDir = join(opts.consumer, ".github", "workflows");
  const actionsDir = join(opts.consumer, ".github", "actions");
  const files = [...collectYaml(workflowsDir), ...collectYaml(actionsDir)];
  const slug = opts.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // uses: dsj1984/mandrel-platform/<subpath>@<40hex>   [optional trailing comment]
  const pinRe = new RegExp(
    `(uses:\\s*['"]?${slug}/[^@\\s'"]+@)([0-9a-fA-F]{40})(['"]?)([^\\n]*)`,
    "g"
  );
  const changes = [];
  for (const file of files) {
    const before = readFileSync(file, "utf8");
    let touched = false;
    const after = before.replace(pinRe, (_m, head, oldSha, quote, trailing) => {
      // Drop any existing trailing comment; re-attach a fresh `# <ref>`.
      const newTrailing = ` # ${opts.ref}`;
      if (oldSha.toLowerCase() === targetSha.toLowerCase()) {
        // SHA already correct — but normalize the comment if it drifted.
        const normalized = `${head}${oldSha}${quote}${newTrailing}`;
        const current = `${head}${oldSha}${quote}${trailing}`;
        if (normalized !== current) touched = true;
        return normalized;
      }
      touched = true;
      changes.push({ file: rel(file), from: oldSha.slice(0, 7), to: targetSha.slice(0, 7) });
      return `${head}${targetSha}${quote}${newTrailing}`;
    });
    if (touched && after !== before) {
      if (!opts.dryRun) writeFileSync(file, after);
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// 2a. Canonical CI-caller-naming advisory (Story #173)
// ---------------------------------------------------------------------------

/**
 * Non-blocking advisory: does the consumer's `.github/workflows/` carry the
 * canonical `ci.yml` / `CI` / `ci` caller triplet documented in
 * docs/reusable-workflows.md § "Canonical caller naming"? This never mutates
 * anything — renaming an existing caller file/job id is a deliberate,
 * atomic per-consumer migration (rename + branch-protection ruleset context
 * update together), never an automatic sync side-effect. Mirrors the
 * warn-only posture of `check-required-contexts.mjs`'s naming lint.
 */
function checkCiCallerNaming() {
  const workflowsDir = join(opts.consumer, ".github", "workflows");
  const files = collectYaml(workflowsDir).map((f) => rel(f));
  const canonicalPath = files.find((f) => f === ".github/workflows/ci.yml");

  if (!canonicalPath) {
    return {
      status: "no-canonical-file",
      message:
        `no ".github/workflows/ci.yml" found — the canonical CI caller naming is ` +
        `file "ci.yml", display name "CI", caller job id "ci" (required context ` +
        `"ci / ci-required"). See docs/reusable-workflows.md § "Canonical caller naming".`,
    };
  }

  const content = readFileSync(join(opts.consumer, canonicalPath), "utf8");
  const nameMatch = content.match(/^name:\s*(.+?)\s*$/m);
  const displayName = nameMatch ? nameMatch[1].replace(/^["']|["']$/g, "") : null;
  const hasCiJob = /^\s{2}ci:\s*$/m.test(content);

  if (displayName === "CI" && hasCiJob) {
    return { status: "canonical", message: null };
  }

  const gaps = [];
  if (displayName !== "CI") gaps.push(`display name is "${displayName ?? "(none)"}" (canonical: "CI")`);
  if (!hasCiJob) gaps.push(`no "ci" job id found (canonical required context: "ci / ci-required")`);

  return {
    status: "non-canonical",
    message: `ci.yml found, but ${gaps.join(" and ")}. See docs/reusable-workflows.md § "Canonical caller naming".`,
  };
}

// ---------------------------------------------------------------------------
// 3. Materialize runbook reference stubs (link, don't copy)
// ---------------------------------------------------------------------------

// Content marker every materialized stub carries so re-runs are idempotent and
// operator-edited stubs are never clobbered.
const STUB_MARKER = "> **Thin local stub.**";

/**
 * Copy each `templates/runbooks/*.md` (except the index README) into the
 * consumer's `docs/runbooks/`, but only when the destination is ABSENT. An
 * existing destination is left untouched — whether it is an already-adopted
 * stub or a local copy the operator must reconcile by hand (we surface the
 * latter as a `localCopy` warning rather than silently overwriting their work).
 */
function materializeRunbooks() {
  const created = [];
  const skipped = [];
  const localCopies = [];
  if (!existsSync(runbookTemplatesDir)) {
    fail(`runbook templates not found at ${runbookTemplatesDir}.`);
  }
  const destDir = join(opts.consumer, "docs", "runbooks");
  for (const entry of readdirSync(runbookTemplatesDir)) {
    if (!entry.endsWith(".md")) continue;
    if (entry.toLowerCase() === "readme.md") continue; // index, not a stub
    const src = join(runbookTemplatesDir, entry);
    const dest = join(destDir, entry);
    if (existsSync(dest)) {
      const body = readFileSync(dest, "utf8");
      if (body.includes(STUB_MARKER)) {
        skipped.push(rel(dest)); // already a reference stub — idempotent no-op
      } else {
        localCopies.push(rel(dest)); // full local copy — operator must reconcile
      }
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(dest, readFileSync(src, "utf8"));
    }
    created.push(rel(dest));
  }
  return { created, skipped, localCopies };
}

// ---------------------------------------------------------------------------
// 3a. Materialize workflow caller templates (link, don't copy) — Story #175
// ---------------------------------------------------------------------------

// Every materialized workflow template names itself as a "canonical staging-
// deploy caller template" in its header comment — used the same way
// STUB_MARKER is used for runbooks: detect an already-materialized (or
// operator-filled-in) file so re-runs are idempotent and an operator's own
// customized caller is never clobbered.
const WORKFLOW_TEMPLATE_MARKER = "Canonical staging-deploy caller template";

/**
 * Copy each `templates/workflows/*.yml` into the consumer's
 * `.github/workflows/`, but only when the destination is ABSENT — mirrors
 * `materializeRunbooks`'s link-don't-copy / never-clobber semantics. An
 * existing destination is left untouched; if it doesn't carry the template
 * marker, it's surfaced as a `localCopy` warning so the operator can
 * reconcile a hand-authored caller against the canonical template by hand.
 */
function materializeWorkflowStubs() {
  const created = [];
  const skipped = [];
  const localCopies = [];
  if (!existsSync(workflowTemplatesDir)) {
    return { created, skipped, localCopies };
  }
  const destDir = join(opts.consumer, ".github", "workflows");
  for (const entry of readdirSync(workflowTemplatesDir)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const src = join(workflowTemplatesDir, entry);
    const dest = join(destDir, entry);
    if (existsSync(dest)) {
      const body = readFileSync(dest, "utf8");
      if (body.includes(WORKFLOW_TEMPLATE_MARKER)) {
        skipped.push(rel(dest)); // already materialized — idempotent no-op
      } else {
        localCopies.push(rel(dest)); // hand-authored caller — operator must reconcile
      }
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(dest, readFileSync(src, "utf8"));
    }
    created.push(rel(dest));
  }
  return { created, skipped, localCopies };
}

// ---------------------------------------------------------------------------
// 4. Reconcile renovate / tsconfig `extends`
// ---------------------------------------------------------------------------

const RENOVATE_PRESET = `github>${"dsj1984/mandrel-platform"}`;
const TSCONFIG_BASE = "mandrel-platform/tsconfig.base.json";

/** Parse JSON tolerating `//` and block comments (jsonc), preserving nothing
 * but the parsed value — we re-serialize with 2-space indent. */
function parseJsonc(text) {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(stripped);
}

function reconcileRenovate() {
  // Renovate config can live at a few canonical paths.
  const candidates = [
    "renovate.json",
    "renovate.json5",
    ".github/renovate.json",
    ".renovaterc.json",
  ].map((p) => join(opts.consumer, p));
  const path = candidates.find((p) => existsSync(p));
  if (!path) return { action: "absent", file: null };
  let cfg;
  try {
    cfg = parseJsonc(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`could not parse Renovate config at ${rel(path)}: ${err.message}`);
  }
  const extendsArr = Array.isArray(cfg.extends) ? [...cfg.extends] : [];
  if (extendsArr.includes(RENOVATE_PRESET)) {
    return { action: "unchanged", file: rel(path) };
  }
  // Prepend the SSOT preset so consumer overrides (later entries) still win.
  cfg.extends = [RENOVATE_PRESET, ...extendsArr];
  if (!opts.dryRun) writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return { action: "reconciled", file: rel(path), added: RENOVATE_PRESET };
}

function reconcileTsconfig() {
  const path = join(opts.consumer, "tsconfig.json");
  if (!existsSync(path)) return { action: "absent", file: null };
  let cfg;
  try {
    cfg = parseJsonc(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`could not parse tsconfig at ${rel(path)}: ${err.message}`);
  }
  // `extends` may be a string or (TS 5.0+) an array.
  const current = cfg.extends;
  const hasBase = Array.isArray(current)
    ? current.includes(TSCONFIG_BASE)
    : current === TSCONFIG_BASE;
  if (hasBase) return { action: "unchanged", file: rel(path) };
  if (current === undefined) {
    cfg.extends = TSCONFIG_BASE;
  } else if (Array.isArray(current)) {
    // Base first so the consumer's own extends override it.
    cfg.extends = [TSCONFIG_BASE, ...current];
  } else {
    cfg.extends = [TSCONFIG_BASE, current];
  }
  if (!opts.dryRun) writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return { action: "reconciled", file: rel(path), added: TSCONFIG_BASE };
}

// ---------------------------------------------------------------------------
// 5. GitHub-side repo-settings check/apply (Story #171)
// ---------------------------------------------------------------------------

/**
 * Fields safe to PATCH automatically. Deliberately excludes nothing today —
 * every dimension the baseline governs (merge methods, squash source,
 * auto-merge, delete-branch-on-merge, Actions default token permissions,
 * Actions PR-approval) is a same-repo settings toggle with no destructive
 * blast radius, unlike e.g. branch-protection rulesets (out of scope — see
 * the companion check-ruleset.mjs story) or anything that could strand
 * in-flight PRs. Kept as an explicit allow-list (not "patch every mismatch")
 * so a future baseline addition must be deliberately added here before
 * --apply-settings will touch it.
 */
const SETTINGS_PATCHABLE_FIELDS = new Set([
  "allowSquashMerge",
  "allowMergeCommit",
  "allowRebaseMerge",
  "squashMergeCommitTitle",
  "squashMergeCommitMessage",
  "deleteBranchOnMerge",
  "allowAutoMerge",
]);
const SETTINGS_ACTIONS_FIELDS = new Set([
  "actionsDefaultWorkflowPermissions",
  "actionsCanApprovePullRequestReviews",
]);

const REPO_FIELD_TO_API_KEY = {
  allowSquashMerge: "allow_squash_merge",
  allowMergeCommit: "allow_merge_commit",
  allowRebaseMerge: "allow_rebase_merge",
  squashMergeCommitTitle: "squash_merge_commit_title",
  squashMergeCommitMessage: "squash_merge_commit_message",
  deleteBranchOnMerge: "delete_branch_on_merge",
  allowAutoMerge: "allow_auto_merge",
};
const ACTIONS_FIELD_TO_API_KEY = {
  actionsDefaultWorkflowPermissions: "default_workflow_permissions",
  actionsCanApprovePullRequestReviews: "can_approve_pull_request_reviews",
};

function ghApiJson(apiPath) {
  const raw = execFileSync("gh", ["api", apiPath, "-H", "Accept: application/vnd.github+json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function ghApiPatch(apiPath, fields) {
  const args = ["api", "-X", "PATCH", apiPath, "-H", "Accept: application/vnd.github+json"];
  for (const [key, value] of Object.entries(fields)) {
    // -f serializes as a string field; -F lets gh infer type (bool/number)
    // from the literal, which is what PATCH /repos and the Actions
    // permissions endpoint both expect for boolean fields.
    args.push("-F", `${key}=${value}`);
  }
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** Read a consumer's live settings across both endpoints, mapped to the baseline's camelCase field shape. */
function fetchLiveSettings(repo) {
  const repoPayload = ghApiJson(`repos/${repo}`);
  const actionsPayload = ghApiJson(`repos/${repo}/actions/permissions/workflow`);
  const live = {};
  for (const field of SETTINGS_PATCHABLE_FIELDS) live[field] = repoPayload[REPO_FIELD_TO_API_KEY[field]];
  for (const field of SETTINGS_ACTIONS_FIELDS) live[field] = actionsPayload[ACTIONS_FIELD_TO_API_KEY[field]];
  return live;
}

/** Diff `live` against `baseline` for every baseline-declared field. Unknown/extra baseline keys are ignored. */
function diffSettings(live, baseline) {
  const mismatches = [];
  for (const field of [...SETTINGS_PATCHABLE_FIELDS, ...SETTINGS_ACTIONS_FIELDS]) {
    if (!(field in baseline)) continue;
    if (live[field] !== baseline[field]) {
      mismatches.push({ field, expected: baseline[field], actual: live[field] });
    }
  }
  return mismatches;
}

/**
 * Apply the drifted fields to the consumer repo via two PATCH calls (one per
 * endpoint — GitHub does not expose a combined settings write surface).
 * Never touches a field absent from `mismatches`.
 */
function applySettings(repo, mismatches) {
  const repoPatch = {};
  const actionsPatch = {};
  for (const { field, expected } of mismatches) {
    if (SETTINGS_PATCHABLE_FIELDS.has(field)) repoPatch[REPO_FIELD_TO_API_KEY[field]] = expected;
    else if (SETTINGS_ACTIONS_FIELDS.has(field)) actionsPatch[ACTIONS_FIELD_TO_API_KEY[field]] = expected;
  }
  if (Object.keys(repoPatch).length > 0) ghApiPatch(`repos/${repo}`, repoPatch);
  if (Object.keys(actionsPatch).length > 0) ghApiPatch(`repos/${repo}/actions/permissions/workflow`, actionsPatch);
}

function runSettingsMode() {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(opts.baseline, "utf8"));
  } catch (err) {
    fail(`could not read baseline at ${opts.baseline}: ${err.message}`);
  }

  log(`▶ platform-sync — repo-settings ${opts.applySettings ? "check+apply" : "check"} for ${opts.consumerRepo}`);
  log("  (non-blocking: drift is reported, never a hard gate — standing decision #10)");

  let live;
  let mismatches;
  let error = null;
  try {
    live = fetchLiveSettings(opts.consumerRepo);
    mismatches = diffSettings(live, baseline);
  } catch (err) {
    error = err.message;
    live = null;
    mismatches = [];
  }

  let applied = false;
  if (opts.applySettings && mismatches.length > 0 && !error) {
    if (opts.dryRun) {
      log(`  (dry-run: would PATCH ${mismatches.length} field(s) on ${opts.consumerRepo})`);
    } else {
      applySettings(opts.consumerRepo, mismatches);
      applied = true;
    }
  }

  log("");
  if (error) {
    log(`  ⚠️ error reading ${opts.consumerRepo}: ${error}`);
  } else if (mismatches.length === 0) {
    log(`  ✅ ${opts.consumerRepo} matches the repo-settings baseline — no drift.`);
  } else {
    log(`  ❌ drift on ${opts.consumerRepo}:`);
    for (const m of mismatches) {
      log(`     - ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`);
    }
    if (applied) log(`  ✅ applied: ${mismatches.length} field(s) patched to match the baseline.`);
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: opts.applySettings ? "apply-settings" : "check-settings",
          consumerRepo: opts.consumerRepo,
          baseline,
          live,
          drift: mismatches.length > 0,
          mismatches,
          applied,
          dryRun: opts.dryRun,
          error,
        },
        null,
        2
      )}\n`
    );
  }

  // Report-only by design (standing decision #10): drift never fails this
  // command's exit code. A hard error reading the consumer IS fatal.
  if (error) process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rel(p) {
  return relative(opts.consumer, p) || p;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (settingsMode) {
    runSettingsMode();
    return;
  }

  if (!existsSync(opts.consumer)) {
    fail(`consumer dir not found: ${opts.consumer}`);
  }

  const targetSha = resolveSha();
  log(`▶ platform-sync — ref '${opts.ref}' → ${targetSha.slice(0, 7)} (${opts.repo})`);
  if (opts.dryRun) log("  (dry-run: no files will be written)");

  const pins = pinWorkflows(targetSha);
  const ciNaming = checkCiCallerNaming();
  const runbooks = materializeRunbooks();
  const workflowStubs = materializeWorkflowStubs();
  const renovate = reconcileRenovate();
  const tsconfig = reconcileTsconfig();

  const changed =
    pins.length > 0 ||
    runbooks.created.length > 0 ||
    workflowStubs.created.length > 0 ||
    renovate.action === "reconciled" ||
    tsconfig.action === "reconciled";

  // Human-readable summary
  log("");
  log(`  pins:      ${pins.length} workflow pin(s) ${opts.dryRun ? "would be " : ""}updated`);
  for (const c of pins) log(`             - ${c.file}: ${c.from} → ${c.to}`);
  if (ciNaming.status !== "canonical") {
    log(`             ⚠ CI caller naming: ${ciNaming.message}`);
  }
  log(
    `  runbooks:  ${runbooks.created.length} stub(s) ${
      opts.dryRun ? "would be " : ""
    }materialized, ${runbooks.skipped.length} already present`
  );
  for (const f of runbooks.created) log(`             + ${f}`);
  for (const f of runbooks.localCopies) {
    log(`             ⚠ ${f}: full local copy detected — reconcile to a reference stub by hand (§2.2)`);
  }
  log(
    `  workflows: ${workflowStubs.created.length} caller template(s) ${
      opts.dryRun ? "would be " : ""
    }materialized, ${workflowStubs.skipped.length} already present`
  );
  for (const f of workflowStubs.created) log(`             + ${f}`);
  for (const f of workflowStubs.localCopies) {
    log(`             ⚠ ${f}: hand-authored caller detected — reconcile against the canonical template by hand`);
  }
  log(`  renovate:  ${renovate.action}${renovate.file ? ` (${renovate.file})` : ""}`);
  log(`  tsconfig:  ${tsconfig.action}${tsconfig.file ? ` (${tsconfig.file})` : ""}`);
  log("");
  log(
    changed
      ? opts.dryRun
        ? "✅ dry-run: changes planned (see above). Re-run without --dry-run to apply."
        : "✅ sync applied."
      : "✅ already in sync — no changes."
  );

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ref: opts.ref,
          sha: targetSha,
          repo: opts.repo,
          consumer: opts.consumer,
          dryRun: opts.dryRun,
          changed,
          pins,
          ciNaming,
          runbooks,
          workflowStubs,
          renovate,
          tsconfig,
        },
        null,
        2
      )}\n`
    );
  }
}

main();
