#!/usr/bin/env node
/**
 * check-ci-required-aggregator.test.mjs — regression guard for the
 * self-maintaining `ci-required` aggregators (Story #234).
 *
 * Both `ci-required` aggregator jobs — `.github/workflows/pr-quality.yml`
 * (the fleet-wide reusable PR gate) and `.github/workflows/ci.yml` (this
 * repo's own gate) — previously required hand-maintained triple bookkeeping:
 * the `needs:` array, a per-job `env:` block, and a bash loop over hardcoded
 * job names. A job added to `needs:` but forgotten in the env/loop silently
 * passed on a red run — on the platform's sole required branch-protection
 * context.
 *
 * Story #234 replaced both with a `toJSON(needs)`-driven check. This suite
 * pins that design against regression:
 *
 *   1. STRUCTURE — each aggregator's `steps:` derive results from
 *      `toJSON(needs)` and contain NO hardcoded reference to any job named in
 *      its own `needs:` array (the "no hardcoded tier-name list" AC).
 *   2. PARITY — the two aggregators' `steps:` blocks are textually identical,
 *      so a fix to one cannot drift from the other.
 *   3. SEMANTICS — the shared run script passes on `success`/`skipped` and
 *      fails on anything else, INCLUDING `cancelled` (load-bearing for #223's
 *      fail-fast design), while naming the failing jobs and their results.
 *      Executed against real bash+jq; skipped when jq is unavailable locally
 *      (CI's ubuntu runner always has it).
 *
 * Run: node --test scripts/check-ci-required-aggregator.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const AGGREGATOR_FILES = [
  ".github/workflows/pr-quality.yml",
  ".github/workflows/ci.yml",
];

// ---------------------------------------------------------------------------
// Minimal indentation-based extraction (dependency-free, mirrors the
// line-oriented approach of check-workflow-portability.mjs). Both workflows
// declare jobs at 2-space indent, so the `ci-required` job block runs from
// its `  ci-required:` line to the next non-blank line at indent <= 2.
// ---------------------------------------------------------------------------

function extractJobBlock(content, jobId) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  assert.notEqual(start, -1, `job \`${jobId}\` not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (indent <= 2) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The `- <name>` entries under the job's `needs:` key. */
function extractNeeds(jobBlock) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((l) => l === "    needs:");
  assert.notEqual(start, -1, "`needs:` block not found");
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s+([A-Za-z0-9_-]+)\s*$/);
    if (!m) break;
    names.push(m[1]);
  }
  assert.ok(names.length > 0, "`needs:` list is empty");
  return names;
}

/** Everything from `    steps:` to the end of the job block. */
function extractSteps(jobBlock) {
  const idx = jobBlock.indexOf("    steps:");
  assert.notEqual(idx, -1, "`steps:` block not found");
  return jobBlock.slice(idx);
}

/** The dedented body of the (single) `run: |` block scalar in the steps. */
function extractRunScript(steps) {
  const lines = steps.split("\n");
  const start = lines.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l));
  assert.notEqual(start, -1, "`run: |` block not found");
  const runIndent = lines[start].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) {
      body.push("");
      continue;
    }
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (indent <= runIndent) break;
    body.push(lines[i].slice(runIndent + 2));
  }
  return body.join("\n");
}

const blocks = AGGREGATOR_FILES.map((rel) => {
  const content = readFileSync(join(repoRoot, rel), "utf8");
  const job = extractJobBlock(content, "ci-required");
  return { rel, job, needs: extractNeeds(job), steps: extractSteps(job) };
});

// ---------------------------------------------------------------------------
// 1. STRUCTURE — toJSON(needs)-driven, no hardcoded tier-name list
// ---------------------------------------------------------------------------

for (const { rel, needs, steps } of blocks) {
  test(`${rel}: aggregator derives results from toJSON(needs)`, () => {
    assert.match(
      steps,
      /\$\{\{\s*toJSON\(needs\)\s*\}\}/,
      "the aggregator steps must consume `${{ toJSON(needs) }}`"
    );
  });

  test(`${rel}: aggregator steps contain no hardcoded tier/job name`, () => {
    // Strip YAML comments — prose may legitimately mention a job; only the
    // executable env/run surface must stay name-free.
    const executable = steps
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    for (const name of needs) {
      const re = new RegExp(
        `(?<![A-Za-z0-9_-])${name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?![A-Za-z0-9_-])`
      );
      assert.doesNotMatch(
        executable,
        re,
        `steps hardcode \`${name}\` — adding a job to \`needs:\` must be the only edit; ` +
          `never reintroduce the per-job env/loop bookkeeping`
      );
    }
    assert.ok(
      !/needs\.[A-Za-z0-9_-]+\.result/.test(executable),
      "steps must not read per-job `needs.<id>.result` expressions"
    );
  });
}

// ---------------------------------------------------------------------------
// 2. PARITY — the two implementations are textually identical
// ---------------------------------------------------------------------------

test("pr-quality.yml and ci.yml aggregator steps are textually identical", () => {
  assert.equal(
    blocks[0].steps,
    blocks[1].steps,
    "the two `ci-required` steps blocks must not drift — apply every change to both"
  );
});

// ---------------------------------------------------------------------------
// 3. SEMANTICS — pass on success/skipped, fail (naming jobs) on anything else
// ---------------------------------------------------------------------------

function jqAvailable() {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runAggregator(needsResults) {
  const script = extractRunScript(blocks[0].steps);
  const dir = mkdtempSync(join(tmpdir(), "ci-required-"));
  try {
    const file = join(dir, "aggregate.sh");
    writeFileSync(file, script);
    const needsJson = Object.fromEntries(
      Object.entries(needsResults).map(([k, result]) => [k, { result, outputs: {} }])
    );
    return spawnSync("bash", [file], {
      encoding: "utf8",
      env: { ...process.env, NEEDS_JSON: JSON.stringify(needsJson) },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const semantics = { skip: jqAvailable() ? false : "jq not available on this host" };

test("run script: all success → exit 0", semantics, () => {
  const r = runAggregator({ lint: "success", unit: "success" });
  assert.equal(r.status, 0, r.stderr);
});

test("run script: skipped counts as a pass", semantics, () => {
  const r = runAggregator({ lint: "success", e2e: "skipped" });
  assert.equal(r.status, 0, r.stderr);
});

test("run script: failure fails and names the job(result)", semantics, () => {
  const r = runAggregator({ lint: "success", unit: "failure" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unit\(failure\)/);
});

test("run script: cancelled fails (load-bearing for fail-fast, #223)", semantics, () => {
  const r = runAggregator({ lint: "success", e2e: "cancelled" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /e2e\(cancelled\)/);
});

test("run script: every non-passing job is named", semantics, () => {
  const r = runAggregator({ lint: "failure", unit: "cancelled", e2e: "success" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lint\(failure\)/);
  assert.match(r.stderr, /unit\(cancelled\)/);
  assert.doesNotMatch(r.stderr, /e2e/);
});
