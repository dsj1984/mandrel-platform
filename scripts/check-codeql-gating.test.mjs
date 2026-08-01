#!/usr/bin/env node
/**
 * check-codeql-gating.test.mjs — regression guard for the repository-local
 * CodeQL merge gate (Story #366).
 *
 * CodeQL ran on this repo's pull requests for a long time without gating
 * anything: it was not among the required status contexts, and the delivery
 * path arms GitHub native auto-merge, which waits only on required contexts.
 * A pull request that introduced a new high-severity alert merged green, and
 * the delivery envelope reported the Story landed. Two ReDoS regressions
 * reached `main` that way — "landed" was not the same as "scanned".
 *
 * The gate routes through the AGGREGATOR rather than through repository
 * settings: ci.yml calls codeql.yml as a job, and the required `ci-required`
 * aggregator lists that job in `needs:`. The required-context set is
 * unchanged, so no branch protection is edited and no phantom context can
 * appear.
 *
 * That design is enforceable only statically, and it has to be, because the
 * aggregator's own `run:` block is byte-identical-mirrored with pr-quality.yml
 * (see check-ci-required-aggregator.test.mjs, PARITY) and so can never carry a
 * job-specific special case. This suite pins the four properties the gate
 * actually rests on:
 *
 *   1. WIRING — ci.yml has a `code-scanning` job that calls codeql.yml, and
 *      `ci-required` lists it in `needs:`.
 *   2. FAIL TOWARD BLOCKING — that job declares neither `if:` nor `needs:`.
 *      The aggregator passes a job whose result is `success` or `skipped`; a
 *      GitHub job can only reach `skipped` through an `if:` condition or a
 *      skipped/failed dependency, so a job with neither cannot be skipped.
 *      Every other conclusion, `cancelled` included, reds the aggregator. A
 *      scan that does not conclude therefore cannot leave the gate green.
 *   3. ONE SCAN PATH — codeql.yml no longer triggers itself on push/PR. Both
 *      paths would analyze the same commit under the same `category`, so
 *      keeping them would burn two 30-minute analyses per event and let the
 *      later SARIF upload overwrite the earlier one.
 *   4. CONSUMER BLAST RADIUS ZERO — codeql.yml keeps its `workflow_call`
 *      contract, and no reusable workflow a consumer calls gained a CodeQL
 *      job. The fleet's private repos have code scanning disabled, where a
 *      CodeQL job fails closed on a 403; the vendored Semgrep tier stays
 *      their blocking SAST.
 *
 * Run: node --test scripts/check-codeql-gating.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CI = ".github/workflows/ci.yml";
const CODEQL = ".github/workflows/codeql.yml";
const PR_QUALITY = ".github/workflows/pr-quality.yml";
const CONTRACT = "docs/runbooks/main-protection.json";

const SCAN_JOB = "code-scanning";
const AGGREGATOR = "ci-required";

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

// ---------------------------------------------------------------------------
// Minimal indentation-based extraction. Dependency-free by house style (the
// repo's `npm test` is Node's built-in runner with no package install), and
// deliberately the same shape as check-ci-required-aggregator.test.mjs: jobs
// are declared at 2-space indent, so a job block runs from its `  <id>:` line
// to the next non-blank line at indent <= 2.
// ---------------------------------------------------------------------------

function extractJobBlock(content, jobId) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  assert.notEqual(start, -1, `job \`${jobId}\` not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (lines[i].match(/^(\s*)/)[1].length <= 2) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Keys declared directly on the job (4-space indent), comments excluded. */
function jobKeys(jobBlock) {
  const keys = new Set();
  for (const line of jobBlock.split("\n").slice(1)) {
    const m = line.match(/^ {4}([A-Za-z0-9_-]+):/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** The `- <name>` entries under the job's `needs:` key. */
function extractNeeds(jobBlock) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((l) => l === "    needs:");
  assert.notEqual(start, -1, "`needs:` block not found");
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s+([A-Za-z0-9_-]+)\s*$/);
    if (m) {
      names.push(m[1]);
      continue;
    }
    // Interleaved comment lines are part of the list; anything else ends it.
    if (/^\s+#/.test(lines[i])) continue;
    break;
  }
  return names;
}

/** The top-level `on:` trigger keys of a workflow. */
function extractTriggers(content) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.notEqual(start, -1, "top-level `on:` block not found");
  const triggers = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (/^[A-Za-z0-9_-]/.test(lines[i])) break; // next top-level key
    const m = lines[i].match(/^ {2}([A-Za-z0-9_-]+):/);
    if (m) triggers.add(m[1]);
  }
  return triggers;
}

// ---------------------------------------------------------------------------
// 1. WIRING
// ---------------------------------------------------------------------------

test("ci.yml calls codeql.yml as a job", () => {
  const block = extractJobBlock(read(CI), SCAN_JOB);
  assert.match(
    block,
    /^ {4}uses:\s*\.\/\.github\/workflows\/codeql\.yml\s*$/m,
    `\`${SCAN_JOB}\` must call ./.github/workflows/codeql.yml — the dogfood ` +
      "self-call is what puts the scan inside this repo's own run"
  );
});

test("the required aggregator depends on the code-scanning job", () => {
  const needs = extractNeeds(extractJobBlock(read(CI), AGGREGATOR));
  assert.ok(
    needs.includes(SCAN_JOB),
    `\`${AGGREGATOR}\` must list \`${SCAN_JOB}\` in \`needs:\` — that single ` +
      `line is the whole gate. Found: ${needs.join(", ") || "(none)"}`
  );
});

test("the code-scanning job grants the scopes codeql.yml declares", () => {
  const block = extractJobBlock(read(CI), SCAN_JOB);
  // GitHub validates a called workflow's declared permissions against the
  // caller's grant at DISPATCH time. A missing scope fails the entire call
  // with startup_failure before any job runs (the Story #292 lesson).
  for (const scope of ["contents: read", "security-events: write", "actions: read"]) {
    assert.ok(
      block.includes(scope),
      `\`${SCAN_JOB}\` must grant \`${scope}\` — codeql.yml declares it, and a ` +
        "caller grant narrower than the called workflow's declaration is a " +
        "startup_failure, not a skipped step"
    );
  }
});

// ---------------------------------------------------------------------------
// 2. FAIL TOWARD BLOCKING
// ---------------------------------------------------------------------------

test("the code-scanning job cannot reach the `skipped` conclusion", () => {
  const keys = jobKeys(extractJobBlock(read(CI), SCAN_JOB));
  // The aggregator passes `success` OR `skipped`, and its run script is
  // byte-identical-mirrored with pr-quality.yml — it cannot special-case one
  // job. So the guarantee has to be structural: `skipped` is reachable only
  // via an `if:` condition or a skipped/failed dependency.
  assert.ok(
    !keys.has("if"),
    `\`${SCAN_JOB}\` must not declare \`if:\` — a conditional job can resolve ` +
      "`skipped`, which the aggregator treats as a pass, making the gate " +
      "silently advisory again"
  );
  assert.ok(
    !keys.has("needs"),
    `\`${SCAN_JOB}\` must not declare \`needs:\` — a job whose dependency is ` +
      "skipped or failed is itself skipped, which the aggregator passes"
  );
});

// ---------------------------------------------------------------------------
// 3. ONE SCAN PATH
// ---------------------------------------------------------------------------

test("codeql.yml does not also trigger itself on push or pull_request", () => {
  const triggers = extractTriggers(read(CODEQL));
  for (const trigger of ["push", "pull_request"]) {
    assert.ok(
      !triggers.has(trigger),
      `codeql.yml must not declare \`${trigger}:\` — ci.yml's gating call ` +
        "already analyzes that commit, and a second run under the same " +
        "`category` overwrites the first SARIF upload for a check that gates " +
        "nothing"
    );
  }
});

test("ci.yml's own triggers cover the commits CodeQL must analyze", () => {
  const triggers = extractTriggers(read(CI));
  // pull_request is the gate itself; push to main is the default-branch
  // baseline CodeQL diffs PR alerts against. Losing either would make the
  // gate green on a repo it never scanned.
  assert.ok(triggers.has("pull_request"), "ci.yml must trigger on pull_request");
  assert.ok(triggers.has("push"), "ci.yml must trigger on push to main");
});

test("the weekly schedule sweep survives on codeql.yml", () => {
  // ci.yml has no `schedule:` trigger, so removing it here would drop the
  // periodic re-scan that catches alerts from newly published queries.
  assert.ok(
    extractTriggers(read(CODEQL)).has("schedule"),
    "codeql.yml must keep its `schedule:` sweep — ci.yml does not run on cron"
  );
});

// ---------------------------------------------------------------------------
// 4. CONSUMER BLAST RADIUS ZERO
// ---------------------------------------------------------------------------

test("codeql.yml keeps its workflow_call contract", () => {
  assert.ok(
    extractTriggers(read(CODEQL)).has("workflow_call"),
    "codeql.yml must stay `workflow_call`-consumable — a GHAS consumer pins it"
  );
});

test("no reusable workflow a consumer calls gained a CodeQL job", () => {
  // The fleet's private repos (athportal, domio, swarm-os) have code scanning
  // disabled; a CodeQL job there fails closed on a 403. The vendored Semgrep
  // tier remains their blocking SAST.
  const prQuality = read(PR_QUALITY);
  assert.ok(
    !/uses:.*codeql\.yml/.test(prQuality),
    "pr-quality.yml must not call codeql.yml — this gate is repository-local"
  );
  assert.ok(
    !/github\/codeql-action\/(init|autobuild|analyze)/.test(prQuality),
    "pr-quality.yml must not run CodeQL analysis steps — a consumer without " +
      "Advanced Security would gain a newly-failing job"
  );
});

test("the required status-context set is unchanged", () => {
  const contract = JSON.parse(read(CONTRACT));
  assert.deepEqual(
    contract.requiredStatusChecks,
    [AGGREGATOR],
    "gating through the aggregator exists precisely so the required-context " +
      "set stays a single entry — adding CodeQL's check name here would fail " +
      "check-required-contexts.mjs, which matches declared entries against " +
      "job identifiers"
  );
});
