#!/usr/bin/env node
/**
 * check-required-contexts.mjs
 *
 * Branch-protection context lint for mandrel-platform consumers.
 *
 * Reads `docs/runbooks/main-protection.json` and asserts that every context
 * listed in `requiredStatusChecks` — and every job listed in `upstreamJobs` —
 * is actually emitted by a job in the `.github/workflows/` directory.
 *
 * This prevents the "phantom required check" failure mode where a check is
 * registered in branch protection but no CI job ever reports it, leaving
 * every PR blocked indefinitely on a `pending` status that never resolves.
 *
 * Usage:
 *   node scripts/check-required-contexts.mjs
 *   node scripts/check-required-contexts.mjs --contract path/to/main-protection.json
 *   node scripts/check-required-contexts.mjs --workflows-dir .github/workflows
 *
 * Also warns (never blocks) when the caller-naming triplet — the CI workflow
 * file name, its display `name:`, and the caller job id that wraps the
 * `pr-quality.yml` call — diverges from the canonical shape documented in
 * `docs/reusable-workflows.md` (`ci.yml` / `CI` / caller job id `ci`, giving
 * the required context `ci / ci-required`). Three fleet consumers converged
 * on three different spellings for the same shared workflow (validated
 * 2026-07-01: domio `ci-pr.yml` / `CI (PR)`; athportal `quality.yml` /
 * `quality`; swarm-os `ci.yml` / `CI` with job id `quality`) — this is a
 * lint nudge toward convergence, not a gate, so existing non-canonical
 * consumers are never blocked by adopting this script.
 *
 * Exit codes:
 *   0 — all required contexts are emitted by at least one workflow job
 *       (regardless of caller-naming warnings — those never affect the exit code)
 *   1 — one or more phantom contexts detected (named in stderr)
 *
 * Consumer adoption:
 *   Copy this script into your project's `scripts/` directory, then wire it
 *   into your PR-quality workflow:
 *
 *   - name: Lint branch-protection contract
 *     run: node scripts/check-required-contexts.mjs
 *
 *   Keep `docs/runbooks/main-protection.json` up to date whenever you add,
 *   rename, or remove workflow jobs so the lint stays accurate.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Repo-root resolution (used by both the CLI entrypoint below and the
// exported naming-lint helper, which reports paths relative to it)
// ---------------------------------------------------------------------------

const repoRoot = process.cwd();

// ---------------------------------------------------------------------------
// Collect job names from all workflow files
// ---------------------------------------------------------------------------

/**
 * Extract all job IDs from a YAML workflow file using a simple line-by-line
 * parser. We intentionally avoid a full YAML parser to keep this script
 * dependency-free — the job ID pattern is stable enough to parse with a regex.
 *
 * GitHub Actions job IDs appear as top-level keys under the `jobs:` map:
 *
 *   jobs:
 *     lint:         ← job ID = "lint"
 *       name: Lint & format
 *       ...
 *     ci-required:  ← job ID = "ci-required"
 *       ...
 *
 * The job ID line is indented by exactly 2 spaces and ends with a colon.
 */
export function extractJobIds(yamlContent) {
  const ids = new Set();
  let inJobsBlock = false;

  for (const line of yamlContent.split("\n")) {
    // Detect the `jobs:` top-level key (zero indentation).
    if (/^jobs:\s*$/.test(line)) {
      inJobsBlock = true;
      continue;
    }

    if (!inJobsBlock) continue;

    // A top-level key at zero indentation that is NOT `jobs:` ends the block.
    if (/^[a-zA-Z0-9_-]/.test(line) && !/^jobs:\s*$/.test(line)) {
      inJobsBlock = false;
      continue;
    }

    // Job ID lines: exactly 2-space indent, identifier, colon, optional spaces.
    const jobMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (jobMatch) {
      ids.add(jobMatch[1]);
    }
  }

  return ids;
}

/**
 * Extract the workflow's top-level display `name:` (the value GitHub Actions
 * shows in the UI and uses as the first segment of a workflow_call caller's
 * status context, e.g. "CI / ci-required"). Returns null when no top-level
 * `name:` key is present (GitHub then falls back to the file path).
 *
 * Only the zero-indentation `name:` key qualifies — job-level `name:` keys
 * are indented and must not be mistaken for the workflow's own display name.
 */
export function extractWorkflowName(yamlContent) {
  for (const line of yamlContent.split("\n")) {
    const match = line.match(/^name:\s*(.+?)\s*$/);
    if (match) {
      return match[1].replace(/^["']|["']$/g, "");
    }
    // Stop scanning once we reach `on:` or `jobs:` — `name:` is always a
    // top-of-file key in a well-formed workflow, so nothing past those
    // markers should be mistaken for it.
    if (/^(on|jobs):\s*$/.test(line)) break;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canonical caller-naming lint (warn-only — see docs/reusable-workflows.md
// "Canonical caller naming" for the full rationale and target shape).
// ---------------------------------------------------------------------------

export const CANONICAL_CALLER = {
  file: "ci.yml",
  displayName: "CI",
  jobId: "ci",
};

/**
 * Non-blocking nudge toward the canonical `ci.yml` / `CI` / `ci` caller
 * naming triplet (operator decision 2026-07-01, D2). Never affects the exit
 * code — this is drift *signal*, not a gate, so existing consumers already on
 * a non-canonical spelling (domio's `ci-pr.yml`, athportal's `quality.yml`,
 * swarm-os's `quality` job id) are never blocked by adopting this script.
 */
export function warnOnNonCanonicalCallerNaming(workflowFiles, workflowJobMap, resolvedWorkflowsDir) {
  const warnings = [];

  if (!workflowFiles.includes(CANONICAL_CALLER.file)) {
    warnings.push(
      `no "${CANONICAL_CALLER.file}" file found in ${relative(repoRoot, resolvedWorkflowsDir)}/ — ` +
      `the canonical caller file name is "${CANONICAL_CALLER.file}" (found: ${workflowFiles.join(", ")})`
    );
    return warnings;
  }

  const filePath = join(resolvedWorkflowsDir, CANONICAL_CALLER.file);
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return warnings;
  }

  const displayName = extractWorkflowName(content);
  if (displayName !== CANONICAL_CALLER.displayName) {
    warnings.push(
      `${CANONICAL_CALLER.file} display name is "${displayName ?? "(none)"}" — ` +
      `canonical is "${CANONICAL_CALLER.displayName}"`
    );
  }

  const jobIds = workflowJobMap.get(CANONICAL_CALLER.file) ?? new Set();
  if (!jobIds.has(CANONICAL_CALLER.jobId)) {
    warnings.push(
      `${CANONICAL_CALLER.file} has no "${CANONICAL_CALLER.jobId}" job id — ` +
      `canonical required context is "${CANONICAL_CALLER.jobId} / ci-required" ` +
      `(found job ids: ${[...jobIds].sort().join(", ") || "(none)"})`
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// CLI entrypoint (skipped under `node --test` import — see the guard below)
// ---------------------------------------------------------------------------

export function runCli(argv) {
  // ── Arg parsing ────────────────────────────────────────────────────────
  let contractPath = null;
  let workflowsDir = null;

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--contract" || argv[i] === "-c") && argv[i + 1]) {
      contractPath = argv[++i];
    } else if ((argv[i] === "--workflows-dir" || argv[i] === "-w") && argv[i + 1]) {
      workflowsDir = argv[++i];
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write(
        "Usage: node scripts/check-required-contexts.mjs [--contract <path>] [--workflows-dir <dir>]\n"
      );
      return 0;
    }
  }

  // Resolve paths relative to the repo root (cwd when invoked from CI or locally).
  const resolvedContract = contractPath
    ? resolve(contractPath)
    : resolve(repoRoot, "docs/runbooks/main-protection.json");
  const resolvedWorkflowsDir = workflowsDir
    ? resolve(workflowsDir)
    : resolve(repoRoot, ".github/workflows");

  // ── Load contract ──────────────────────────────────────────────────────
  let contract;
  try {
    const raw = readFileSync(resolvedContract, "utf8");
    contract = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[check-required-contexts] ERROR: Cannot read contract at ${relative(repoRoot, resolvedContract)}: ${err.message}\n`
    );
    return 1;
  }

  const requiredContexts = Array.isArray(contract.requiredStatusChecks)
    ? contract.requiredStatusChecks
    : [];
  const upstreamJobs = Array.isArray(contract.upstreamJobs) ? contract.upstreamJobs : [];

  if (requiredContexts.length === 0) {
    process.stderr.write(
      "[check-required-contexts] ERROR: contract.requiredStatusChecks is empty — at least one context is required.\n"
    );
    return 1;
  }

  // ── Collect job names from all workflow files ─────────────────────────
  let workflowFiles;
  try {
    workflowFiles = readdirSync(resolvedWorkflowsDir).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml")
    );
  } catch (err) {
    process.stderr.write(
      `[check-required-contexts] ERROR: Cannot read workflows directory at ${relative(repoRoot, resolvedWorkflowsDir)}: ${err.message}\n`
    );
    return 1;
  }

  if (workflowFiles.length === 0) {
    process.stderr.write(
      `[check-required-contexts] ERROR: No workflow files found in ${relative(repoRoot, resolvedWorkflowsDir)}\n`
    );
    return 1;
  }

  /** Map from workflow filename → Set<jobId> */
  const workflowJobMap = new Map();
  /** Flat set of all job IDs across all workflows */
  const allJobIds = new Set();

  for (const file of workflowFiles) {
    const filePath = join(resolvedWorkflowsDir, file);
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) {
      process.stderr.write(
        `[check-required-contexts] WARN: Cannot read ${file}: ${err.message} — skipping.\n`
      );
      continue;
    }
    const ids = extractJobIds(content);
    workflowJobMap.set(file, ids);
    for (const id of ids) {
      allJobIds.add(id);
    }
  }

  // ── Validate required contexts ─────────────────────────────────────────
  const phantomContexts = requiredContexts.filter((ctx) => !allJobIds.has(ctx));
  const phantomUpstream = upstreamJobs.filter((job) => !allJobIds.has(job));

  // ── Report ──────────────────────────────────────────────────────────────
  const contractRel = relative(repoRoot, resolvedContract);
  const workflowsRel = relative(repoRoot, resolvedWorkflowsDir);

  process.stdout.write(
    `[check-required-contexts] Contract : ${contractRel}\n` +
    `[check-required-contexts] Workflows: ${workflowsRel}/ (${workflowFiles.length} file${workflowFiles.length === 1 ? "" : "s"})\n` +
    `[check-required-contexts] Emitted job IDs: ${[...allJobIds].sort().join(", ")}\n`
  );

  if (phantomContexts.length > 0) {
    process.stderr.write(
      `\n[check-required-contexts] ❌ PHANTOM required contexts detected!\n` +
      `   These contexts are listed in requiredStatusChecks but no workflow job emits them:\n`
    );
    for (const ctx of phantomContexts) {
      process.stderr.write(`     • "${ctx}"\n`);
    }
    process.stderr.write(
      `\n   A phantom context will block every PR indefinitely on a "pending" status\n` +
      `   that never resolves. Fix: either add a workflow job with this exact ID,\n` +
      `   or remove the context from requiredStatusChecks in ${contractRel}.\n\n`
    );
  }

  if (phantomUpstream.length > 0) {
    process.stderr.write(
      `\n[check-required-contexts] ❌ PHANTOM upstream jobs detected!\n` +
      `   These jobs are listed in upstreamJobs but no workflow defines them:\n`
    );
    for (const job of phantomUpstream) {
      process.stderr.write(`     • "${job}"\n`);
    }
    process.stderr.write(
      `\n   Fix: either add the missing job to a workflow, or remove it from\n` +
      `   upstreamJobs in ${contractRel}.\n\n`
    );
  }

  const namingWarnings = warnOnNonCanonicalCallerNaming(
    workflowFiles,
    workflowJobMap,
    resolvedWorkflowsDir
  );

  if (namingWarnings.length > 0) {
    process.stdout.write(
      `\n[check-required-contexts] ⚠️  Non-canonical CI caller naming (warn-only, does not fail this check):\n`
    );
    for (const warning of namingWarnings) {
      process.stdout.write(`     • ${warning}\n`);
    }
    process.stdout.write(
      `\n   See docs/reusable-workflows.md § "Canonical caller naming" for the\n` +
      `   target shape (file "${CANONICAL_CALLER.file}", display name "${CANONICAL_CALLER.displayName}",\n` +
      `   caller job id "${CANONICAL_CALLER.jobId}" → required context "${CANONICAL_CALLER.jobId} / ci-required").\n` +
      `   Renaming an existing caller is a per-consumer migration, not required by this lint.\n\n`
    );
  }

  const hasError = phantomContexts.length > 0 || phantomUpstream.length > 0;

  if (!hasError) {
    process.stdout.write(
      `[check-required-contexts] ✅ All required contexts and upstream jobs are emitted by CI.\n` +
      `   requiredStatusChecks : ${requiredContexts.join(", ")}\n` +
      `   upstreamJobs         : ${upstreamJobs.length > 0 ? upstreamJobs.join(", ") : "(none listed)"}\n`
    );
  }

  return hasError ? 1 : 0;
}

// Only run when executed directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("check-required-contexts.mjs");
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
