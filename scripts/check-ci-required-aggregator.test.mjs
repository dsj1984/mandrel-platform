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
 *   2. PARITY — the two aggregators' `run:` scripts are byte-identical and both
 *      declare the same `env:` keys, so a fix to one cannot drift from the
 *      other. (Story #333 loosened this from "the whole `steps:` blocks are
 *      identical": ci.yml has no `workflow_call` inputs, so it must source
 *      `CANCELLED_POLICY` as a literal where pr-quality.yml sources it from
 *      `inputs.cancelled-policy`. The shared script reads it from the
 *      environment, which is what keeps the logic itself byte-identical.)
 *   3. SEMANTICS — the shared run script passes on `success`/`skipped` and
 *      fails on anything else, INCLUDING `cancelled` (load-bearing for #223's
 *      fail-fast design), while naming the failing jobs and their results.
 *      Executed against real bash+jq; skipped when jq is unavailable locally
 *      (CI's ubuntu runner always has it). `gh` is stubbed to fail so these
 *      tests stay hermetic — provenance classification (Story #333) has its
 *      own suite in scripts/check-cancelled-provenance.test.mjs.
 *
 * Run: node --test scripts/check-ci-required-aggregator.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
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

// Story #333 re-shaped this from "the whole `steps:` blocks are byte-identical"
// to "the `run:` scripts are byte-identical AND both declare the same `env:`
// keys". ci.yml has no `workflow_call` inputs, so it cannot source
// `CANCELLED_POLICY` from `inputs.cancelled-policy` the way pr-quality.yml
// does — but the LOGIC is what must not drift, and the script reads the policy
// from the environment precisely so the two can share it verbatim.

/** The `KEY:` names declared under a steps block's `env:` mapping. */
function extractEnvKeys(steps) {
  const stepLines = steps.split("\n");
  const start = stepLines.findIndex((l) => /^\s+env:\s*$/.test(l));
  assert.notEqual(start, -1, "`env:` block not found");
  const envIndent = stepLines[start].match(/^(\s*)/)[1].length;
  const keys = [];
  for (let i = start + 1; i < stepLines.length; i++) {
    if (/^\s*$/.test(stepLines[i])) continue;
    if (/^\s*#/.test(stepLines[i])) continue;
    const indent = stepLines[i].match(/^(\s*)/)[1].length;
    if (indent <= envIndent) break;
    const key = stepLines[i].match(/^\s+([A-Za-z_][A-Za-z0-9_]*):/);
    if (key) keys.push(key[1]);
  }
  assert.ok(keys.length > 0, "`env:` block declared no keys");
  return keys.sort();
}

test("pr-quality.yml and ci.yml aggregator run scripts are byte-identical", () => {
  assert.equal(
    extractRunScript(blocks[0].steps),
    extractRunScript(blocks[1].steps),
    "the two `ci-required` run scripts must not drift — apply every logic change to both"
  );
});

test("pr-quality.yml and ci.yml aggregators declare the same env keys", () => {
  assert.deepEqual(
    extractEnvKeys(blocks[0].steps),
    extractEnvKeys(blocks[1].steps),
    "the shared run script reads its inputs from the environment — a key present " +
      "in only one workflow would leave the other running the same script unconfigured"
  );
});

test("the shared aggregator script never references workflow_call inputs", () => {
  // ci.yml has none, so an `inputs.*` reference could not be mirrored and
  // would break the byte-identical run-script guarantee above.
  for (const { rel, steps } of blocks) {
    assert.doesNotMatch(
      extractRunScript(steps),
      /inputs\./,
      `${rel}: the run script must read configuration from \`env:\`, not \`inputs.*\``
    );
  }
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

function runAggregator(needsResults, { captureSummary = false } = {}) {
  const script = extractRunScript(blocks[0].steps);
  const dir = mkdtempSync(join(tmpdir(), "ci-required-"));
  try {
    const file = join(dir, "aggregate.sh");
    writeFileSync(file, script);
    const needsJson = Object.fromEntries(
      Object.entries(needsResults).map(([k, result]) => [k, { result, outputs: {} }])
    );
    // Neutralize the provenance lookup (Story #333): shadow `gh` with a stub
    // that always fails, so these tests stay hermetic and exercise the
    // `unknown`-provenance path. Provenance classification itself is covered
    // by scripts/check-cancelled-provenance.test.mjs.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const ghStub = join(bin, "gh");
    writeFileSync(ghStub, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(ghStub, 0o755);

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NEEDS_JSON: JSON.stringify(needsJson),
    };
    // The step-summary write must degrade when GITHUB_STEP_SUMMARY is unset
    // (this harness, and any `act`-style local runner), so only define it when
    // a test is actually asserting on the summary body.
    const summaryPath = join(dir, "summary.md");
    if (captureSummary) {
      writeFileSync(summaryPath, "");
      env.GITHUB_STEP_SUMMARY = summaryPath;
    } else {
      delete env.GITHUB_STEP_SUMMARY;
    }
    const r = spawnSync("bash", [file], { encoding: "utf8", env });
    return {
      ...r,
      summary: captureSummary ? readFileSync(summaryPath, "utf8") : "",
    };
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

// ---------------------------------------------------------------------------
// 4. TRIAGE PARTITION (Story #331) — a fail-fast run reds N jobs but only one
//    of them actually failed. The aggregate must say WHICH, so triage does not
//    land on a collateral cancel.
// ---------------------------------------------------------------------------

test("run script: partitions own-failures from collateral cancels", semantics, () => {
  const r = runAggregator({
    lint: "success",
    security: "failure",
    unit: "cancelled",
    e2e: "cancelled",
  });
  assert.equal(r.status, 1);

  const own = r.stderr
    .split("\n")
    .find((l) => l.includes("Failed on their own"));
  const collateral = r.stderr
    .split("\n")
    .find((l) => l.includes("do not triage"));

  assert.ok(own, `no own-failure line in stderr:\n${r.stderr}`);
  assert.ok(collateral, `no collateral line in stderr:\n${r.stderr}`);

  // The tier that actually failed is named ONLY on the triage line, and the
  // cancelled siblings ONLY on the collateral line — a partition, not two
  // copies of the same flat list.
  assert.match(own, /security\(failure\)/);
  assert.doesNotMatch(own, /unit|e2e/);
  assert.match(collateral, /unit\(cancelled\)/);
  assert.match(collateral, /e2e\(cancelled\)/);
  assert.doesNotMatch(collateral, /security/);
});

test("run script: an all-cancelled aggregate says no job failed on its own", semantics, () => {
  const r = runAggregator({ lint: "success", unit: "cancelled" }, { captureSummary: true });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /Failed on their own/);
  assert.match(r.summary, /No job reported its own failure/);
});

test("run script: writes the triage partition to the job summary", semantics, () => {
  const r = runAggregator(
    { security: "failure", unit: "cancelled" },
    { captureSummary: true }
  );
  assert.equal(r.status, 1);
  assert.match(r.summary, /ci-required failed/);
  assert.match(r.summary, /Failed on their own[^\n]*security\(failure\)/);
  assert.match(r.summary, /Cancelled[^\n]*do not triage:[^\n]*unit\(cancelled\)/);
});

test("run script: a green aggregate writes no summary", semantics, () => {
  const r = runAggregator({ lint: "success", unit: "success" }, { captureSummary: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.summary, "");
});

test("run script: survives an unset GITHUB_STEP_SUMMARY", semantics, () => {
  // The failure path writes a summary; with the variable unset (local runners,
  // `act`, this harness) the redirect must degrade rather than error out and
  // swallow the exit-1 verdict.
  const r = runAggregator({ unit: "failure" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unit\(failure\)/);
  assert.doesNotMatch(r.stderr, /ambiguous redirect|No such file or directory/);
});
