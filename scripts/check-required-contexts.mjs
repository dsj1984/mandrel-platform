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
 * Exit codes:
 *   0 — all required contexts are emitted by at least one workflow job
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
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let contractPath = null;
let workflowsDir = null;

for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--contract" || args[i] === "-c") && args[i + 1]) {
    contractPath = args[++i];
  } else if ((args[i] === "--workflows-dir" || args[i] === "-w") && args[i + 1]) {
    workflowsDir = args[++i];
  } else if (args[i] === "--help" || args[i] === "-h") {
    process.stdout.write(
      "Usage: node scripts/check-required-contexts.mjs [--contract <path>] [--workflows-dir <dir>]\n"
    );
    process.exit(0);
  }
}

// Resolve paths relative to the repo root (cwd when invoked from CI or locally).
const repoRoot = process.cwd();
const resolvedContract = contractPath
  ? resolve(contractPath)
  : resolve(repoRoot, "docs/runbooks/main-protection.json");
const resolvedWorkflowsDir = workflowsDir
  ? resolve(workflowsDir)
  : resolve(repoRoot, ".github/workflows");

// ---------------------------------------------------------------------------
// Load contract
// ---------------------------------------------------------------------------

let contract;
try {
  const raw = readFileSync(resolvedContract, "utf8");
  contract = JSON.parse(raw);
} catch (err) {
  process.stderr.write(
    `[check-required-contexts] ERROR: Cannot read contract at ${relative(repoRoot, resolvedContract)}: ${err.message}\n`
  );
  process.exit(1);
}

const requiredContexts = Array.isArray(contract.requiredStatusChecks)
  ? contract.requiredStatusChecks
  : [];
const upstreamJobs = Array.isArray(contract.upstreamJobs)
  ? contract.upstreamJobs
  : [];

if (requiredContexts.length === 0) {
  process.stderr.write(
    "[check-required-contexts] ERROR: contract.requiredStatusChecks is empty — at least one context is required.\n"
  );
  process.exit(1);
}

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
function extractJobIds(yamlContent) {
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

let workflowFiles;
try {
  workflowFiles = readdirSync(resolvedWorkflowsDir).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml")
  );
} catch (err) {
  process.stderr.write(
    `[check-required-contexts] ERROR: Cannot read workflows directory at ${relative(repoRoot, resolvedWorkflowsDir)}: ${err.message}\n`
  );
  process.exit(1);
}

if (workflowFiles.length === 0) {
  process.stderr.write(
    `[check-required-contexts] ERROR: No workflow files found in ${relative(repoRoot, resolvedWorkflowsDir)}\n`
  );
  process.exit(1);
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

// ---------------------------------------------------------------------------
// Validate required contexts
// ---------------------------------------------------------------------------

const phantomContexts = requiredContexts.filter((ctx) => !allJobIds.has(ctx));
const phantomUpstream = upstreamJobs.filter((job) => !allJobIds.has(job));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

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

const hasError = phantomContexts.length > 0 || phantomUpstream.length > 0;

if (!hasError) {
  process.stdout.write(
    `[check-required-contexts] ✅ All required contexts and upstream jobs are emitted by CI.\n` +
    `   requiredStatusChecks : ${requiredContexts.join(", ")}\n` +
    `   upstreamJobs         : ${upstreamJobs.length > 0 ? upstreamJobs.join(", ") : "(none listed)"}\n`
  );
}

process.exit(hasError ? 1 : 0);
