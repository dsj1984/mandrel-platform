#!/usr/bin/env node
/**
 * check-cancelled-provenance.test.mjs — regression guard for provenance-aware
 * handling of a cancelled tier in the `ci-required` aggregator (Story #333).
 *
 * WHY THIS EXISTS
 * ---------------
 * The aggregator failed the required gate on ANY `needs.*.result == 'cancelled'`
 * with no statement of cause, so three very different situations were
 * indistinguishable at the gate:
 *
 *   - a sibling tier genuinely failed and fail-fast cancelled the rest;
 *   - a self-hosted runner's provisioning hook hung and the job was cancelled
 *     having never executed a step (Beestera/swarm-os#928: a job sat ~6min with
 *     its `Checkout` step SKIPPED, then died — no test signal at all);
 *   - a newer push superseded the run via the concurrency groups.
 *
 * There is no cancellation-reason field to read back — verified 2026-07-25,
 * `gh run view --json` exposes only attempt/conclusion/createdAt/databaseId/
 * displayTitle/event/headBranch/headSha/jobs/name/number/startedAt/status/
 * updatedAt/url/workflowDatabaseId/workflowName, and
 * `GET /repos/{owner}/{repo}/actions/runs/{id}` carries none either. Provenance
 * is therefore INFERRED from observable run state, and this suite pins both the
 * inference and the gate policy it feeds.
 *
 * The load-bearing negative: classification can never turn a red gate green.
 * Every lookup failure yields `unknown`, and `unknown` neutralizes nothing —
 * so the worst case is exactly today's behaviour. A `never-started` (infra)
 * cancel is likewise never neutralized under any policy: that tier produced no
 * signal, and passing on a tier that never ran is a vacuous pass.
 *
 * Run: node --test scripts/check-cancelled-provenance.test.mjs
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
const WORKFLOW = ".github/workflows/pr-quality.yml";
const RUN_ID = "30179418666";

// ---------------------------------------------------------------------------
// Extract the aggregator's run script (same approach as the sibling suite).
// ---------------------------------------------------------------------------

function extractRunScript() {
  const lines = readFileSync(join(repoRoot, WORKFLOW), "utf8").split("\n");
  const start = lines.findIndex((l) => l === "  ci-required:");
  assert.notEqual(start, -1, "`ci-required` job not found");
  const runIdx = lines.findIndex(
    (l, i) => i > start && /^\s+run:\s*\|\s*$/.test(l)
  );
  assert.notEqual(runIdx, -1, "`run: |` block not found");
  const runIndent = lines[runIdx].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) {
      body.push("");
      continue;
    }
    if (lines[i].match(/^(\s*)/)[1].length <= runIndent) break;
    body.push(lines[i].slice(runIndent + 2));
  }
  return body.join("\n");
}

const script = extractRunScript();

// ---------------------------------------------------------------------------
// Actions-API fixtures. `steps[].conclusion` is what separates a job that ran
// from one that never started.
// ---------------------------------------------------------------------------

const ranSteps = [
  { name: "Set up job", conclusion: "success" },
  { name: "Checkout", conclusion: "success" },
  { name: "Typecheck", conclusion: "success" },
];

/** The swarm-os#928 shape: queued, then cancelled, having run nothing. */
const neverStartedSteps = [
  { name: "Set up job", conclusion: "skipped" },
  { name: "Checkout", conclusion: "skipped" },
];

function runFixture(jobs, { createdAt = "2026-07-25T10:00:00Z" } = {}) {
  return {
    jobs,
    workflowDatabaseId: 4242,
    headBranch: "story-333",
    createdAt,
  };
}

const FIXTURES = {
  // A sibling genuinely failed; the rest are fail-fast collateral.
  failFast: runFixture([
    { name: "Accessibility (2/3)", conclusion: "failure", steps: ranSteps },
    { name: "Typecheck", conclusion: "cancelled", steps: ranSteps },
    { name: "Lint & format", conclusion: "cancelled", steps: ranSteps },
  ]),
  // Nothing failed; one job never executed a step. Infra hang.
  neverStarted: runFixture([
    { name: "Unit (1/2)", conclusion: "success", steps: ranSteps },
    { name: "Detect web-*", conclusion: "cancelled", steps: neverStartedSteps },
  ]),
  // Nothing failed, every cancelled job had started — a concurrency cancel.
  superseded: runFixture([
    { name: "Unit (1/2)", conclusion: "success", steps: ranSteps },
    { name: "E2E / Smoke (1/1)", conclusion: "cancelled", steps: ranSteps },
  ]),
  // Same shape, but the cancelled job is the ONLY non-skipped one — nothing
  // actually passed, so neutralizing would be a vacuous pass.
  supersededNoPass: runFixture([
    { name: "E2E / Smoke (1/1)", conclusion: "cancelled", steps: ranSteps },
  ]),
};

const NEWER_RUNS = [
  { databaseId: 30179418666, createdAt: "2026-07-25T10:00:00Z" },
  { databaseId: 30179999999, createdAt: "2026-07-25T10:31:00Z" },
];
const NO_NEWER_RUNS = [
  { databaseId: 30179418666, createdAt: "2026-07-25T10:00:00Z" },
];

// ---------------------------------------------------------------------------
// Harness: run the extracted script with a stubbed `gh` that answers
// `run view` and `run list` from the fixtures above.
// ---------------------------------------------------------------------------

function jqAvailable() {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const semantics = {
  skip: jqAvailable() ? false : "jq not available on this host",
};

function runAggregator(
  needsResults,
  { policy = "strict", runJson = null, runList = null, ghFails = false } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), "cancelled-provenance-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);

    // The stub dispatches on `gh run view` vs `gh run list`, so a test can
    // pin the classification inputs without any network access.
    const viewFile = join(dir, "view.json");
    const listFile = join(dir, "list.json");
    writeFileSync(viewFile, runJson ? JSON.stringify(runJson) : "");
    writeFileSync(listFile, runList ? JSON.stringify(runList) : "");
    writeFileSync(
      join(bin, "gh"),
      ghFails
        ? "#!/usr/bin/env bash\nexit 1\n"
        : [
            "#!/usr/bin/env bash",
            'if [ "$1" = "run" ] && [ "$2" = "view" ]; then',
            `  cat ${JSON.stringify(viewFile)}`,
            '  exit 0',
            'fi',
            'if [ "$1" = "run" ] && [ "$2" = "list" ]; then',
            `  cat ${JSON.stringify(listFile)}`,
            '  exit 0',
            'fi',
            "exit 1",
            "",
          ].join("\n")
    );
    chmodSync(join(bin, "gh"), 0o755);

    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const file = join(dir, "aggregate.sh");
    writeFileSync(file, script);

    const needsJson = Object.fromEntries(
      Object.entries(needsResults).map(([k, result]) => [
        k,
        { result, outputs: {} },
      ])
    );

    const r = spawnSync("bash", [file], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NEEDS_JSON: JSON.stringify(needsJson),
        CANCELLED_POLICY: policy,
        GH_TOKEN: "stub-token",
        RUN_ID,
        REPO: "Beestera/swarm-os",
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    return { ...r, summary: readFileSync(summary, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A cancelled tier alongside a passing one — the shape every test below uses
// unless it needs something different.
const ONE_CANCELLED = { unit: "success", e2e: "cancelled" };

// ---------------------------------------------------------------------------
// 1. CLASSIFICATION — each provenance class is inferred from run state.
// ---------------------------------------------------------------------------

test("classifies a run with a failed sibling as fail-fast", semantics, () => {
  const r = runAggregator(ONE_CANCELLED, { runJson: FIXTURES.failFast });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cancelled provenance: fail-fast/);
});

test(
  "classifies a job that executed no step as never-started (infra)",
  semantics,
  () => {
    const r = runAggregator(ONE_CANCELLED, { runJson: FIXTURES.neverStarted });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cancelled provenance: never-started/);
    // The swarm-os#928 job is named, so a triager sees WHICH job hung.
    assert.match(r.stderr, /Detect web-\*: never-started/);
  }
);

test("classifies a run with a newer sibling run as superseded", semantics, () => {
  const r = runAggregator(ONE_CANCELLED, {
    runJson: FIXTURES.superseded,
    runList: NEWER_RUNS,
  });
  assert.match(r.stderr, /Cancelled provenance: superseded/);
});

test("stays unknown when no newer run exists", semantics, () => {
  const r = runAggregator(ONE_CANCELLED, {
    runJson: FIXTURES.superseded,
    runList: NO_NEWER_RUNS,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cancelled provenance: unknown/);
});

test("a failed sibling outranks a never-started job", semantics, () => {
  // Precedence matters: a job cancelled while still queued has executed no
  // step either, so checking `never-started` first would report an infra hang
  // for every fail-fast run.
  const r = runAggregator(ONE_CANCELLED, {
    runJson: runFixture([
      { name: "Accessibility (2/3)", conclusion: "failure", steps: ranSteps },
      { name: "E2E / Smoke (1/1)", conclusion: "cancelled", steps: neverStartedSteps },
    ]),
  });
  assert.match(r.stderr, /Cancelled provenance: fail-fast/);
  assert.doesNotMatch(r.stderr, /provenance: never-started/);
});

test("classification is reported on the job summary too", semantics, () => {
  const r = runAggregator(ONE_CANCELLED, { runJson: FIXTURES.neverStarted });
  assert.match(r.summary, /Provenance: `never-started`/);
  assert.match(r.summary, /INFRA fault/);
});

test("a green run performs no provenance lookup at all", semantics, () => {
  const r = runAggregator({ unit: "success", e2e: "success" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /provenance/);
});

// ---------------------------------------------------------------------------
// 2. POLICY — strict is unchanged; provenance-aware neutralizes ONE class.
// ---------------------------------------------------------------------------

test("strict is the default and still fails every cancel", semantics, () => {
  for (const [name, runJson] of Object.entries(FIXTURES)) {
    const r = runAggregator(ONE_CANCELLED, {
      policy: "strict",
      runJson,
      runList: NEWER_RUNS,
    });
    assert.equal(r.status, 1, `${name} should stay red under strict`);
  }
});

test("an absent policy env var defaults to strict", semantics, () => {
  const r = runAggregator(ONE_CANCELLED, {
    policy: "",
    runJson: FIXTURES.superseded,
    runList: NEWER_RUNS,
  });
  assert.equal(r.status, 1);
});

test(
  "provenance-aware neutralizes a superseded run's cancels",
  semantics,
  () => {
    const r = runAggregator(ONE_CANCELLED, {
      policy: "provenance-aware",
      runJson: FIXTURES.superseded,
      runList: NEWER_RUNS,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Superseded run/);
    assert.match(r.summary, /neutral \(superseded run\)/);
  }
);

test(
  "provenance-aware keeps a never-started (infra) cancel red",
  semantics,
  () => {
    // The painful case from swarm-os#928 — and deliberately NOT cleared. The
    // tier produced no test signal, so a green here is a vacuous pass.
    const r = runAggregator(ONE_CANCELLED, {
      policy: "provenance-aware",
      runJson: FIXTURES.neverStarted,
      runList: NEWER_RUNS,
    });
    assert.equal(r.status, 1);
    assert.match(r.summary, /never-started/);
  }
);

test("provenance-aware keeps a fail-fast collateral cancel red", semantics, () => {
  const r = runAggregator(ONE_CANCELLED, {
    policy: "provenance-aware",
    runJson: FIXTURES.failFast,
    runList: NEWER_RUNS,
  });
  assert.equal(r.status, 1);
});

test("provenance-aware never clears a run where a job failed", semantics, () => {
  const r = runAggregator(
    { unit: "failure", e2e: "cancelled" },
    {
      policy: "provenance-aware",
      runJson: FIXTURES.superseded,
      runList: NEWER_RUNS,
    }
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unit\(failure\)/);
});

test(
  "provenance-aware refuses to neutralize when nothing passed",
  semantics,
  () => {
    // Neutralizing here would pass the required gate on a run with zero
    // successful tiers — the vacuous pass the all-skipped guard also refuses.
    const r = runAggregator(
      { e2e: "cancelled" },
      {
        policy: "provenance-aware",
        runJson: FIXTURES.supersededNoPass,
        runList: NEWER_RUNS,
      }
    );
    assert.equal(r.status, 1);
  }
);

// ---------------------------------------------------------------------------
// 3. DEGRADATION — no lookup failure can turn a red gate green, or fail the
//    aggregator step itself.
// ---------------------------------------------------------------------------

test("a failing gh lookup degrades to unknown and stays red", semantics, () => {
  for (const policy of ["strict", "provenance-aware"]) {
    const r = runAggregator(ONE_CANCELLED, { policy, ghFails: true });
    assert.equal(r.status, 1, `${policy} must stay red when gh fails`);
    assert.match(r.stderr, /Cancelled provenance: unknown/);
  }
});

test("an absent gh degrades to unknown and stays red", semantics, () => {
  const dir = mkdtempSync(join(tmpdir(), "cancelled-provenance-nogh-"));
  try {
    const empty = join(dir, "bin");
    mkdirSync(empty);
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const file = join(dir, "aggregate.sh");
    writeFileSync(file, script);
    // PATH keeps the real jq (the script needs it) but no gh.
    const jqDir = dirname(execFileSync("which", ["jq"], { encoding: "utf8" }).trim());
    const r = spawnSync("/bin/bash", [file], {
      encoding: "utf8",
      env: {
        PATH: `${empty}:${jqDir}`,
        NEEDS_JSON: JSON.stringify({
          unit: { result: "success" },
          e2e: { result: "cancelled" },
        }),
        CANCELLED_POLICY: "provenance-aware",
        RUN_ID,
        REPO: "Beestera/swarm-os",
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Cancelled provenance: unknown/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed API output degrades to unknown and stays red", semantics, () => {
  const dir = mkdtempSync(join(tmpdir(), "cancelled-provenance-bad-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      "#!/usr/bin/env bash\nprintf 'not json at all'\nexit 0\n"
    );
    chmodSync(join(bin, "gh"), 0o755);
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const file = join(dir, "aggregate.sh");
    writeFileSync(file, script);
    const r = spawnSync("bash", [file], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NEEDS_JSON: JSON.stringify({
          unit: { result: "success" },
          e2e: { result: "cancelled" },
        }),
        CANCELLED_POLICY: "provenance-aware",
        RUN_ID,
        REPO: "Beestera/swarm-os",
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Cancelled provenance: unknown/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. INPUT SURFACE — the policy is a declared, defaulted workflow_call input.
// ---------------------------------------------------------------------------

test("cancelled-policy is declared with a strict default", () => {
  // Scan the input's own block by indentation rather than matching it with a
  // multi-line regex: the obvious `(?: {8}.*\n|\s*\n)*?` formulation has
  // overlapping alternatives and backtracks exponentially on a file with many
  // newlines (CodeQL js/redos, high). A line walk has no such failure mode and
  // reads more like the other extractors in this suite.
  const lines = readFileSync(join(repoRoot, WORKFLOW), "utf8").split("\n");
  const start = lines.findIndex((l) => l === "      cancelled-policy:");
  assert.notEqual(start, -1, "`cancelled-policy:` input not declared");

  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (lines[i].match(/^(\s*)/)[1].length <= 6) break;
    block.push(lines[i].trim());
  }

  assert.ok(
    block.includes("default: strict"),
    "`cancelled-policy` must default to `strict` so existing consumers are unaffected; " +
      `declared instead: ${JSON.stringify(block)}`
  );
});
