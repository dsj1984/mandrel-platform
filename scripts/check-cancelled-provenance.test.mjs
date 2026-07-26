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
 * TIMED-OUT + TIMEOUT HEADROOM (Story #342)
 * -----------------------------------------
 * A fifth cause was missing: GitHub killing a job that exceeded its own
 * `timeout-minutes`. It reported as `stopped-mid-step`, or as `never-started`
 * when the kill landed before a step completed — both of which point triage at
 * the runner fleet when the fix is a number in the workflow. swarm-os run
 * 30179418666 cost a full forensic misdiagnosis to exactly that.
 *
 * The ceilings themselves were also unreachable by callers, which is what made
 * the class necessary: GitHub charges the pre-job `Set up runner` wait against
 * the same clock, so on a saturated self-hosted pool a hardcoded 5-minute
 * aggregator budget passes by luck. This suite therefore pins BOTH halves —
 * the `timeout-headroom-minutes` input surface and the `timed-out` inference —
 * plus the negative that makes them shippable: pr-quality.yml declares no new
 * permission scope, because a reusable workflow's permissions are validated
 * against the caller's grant at compile time and a new scope breaks every
 * consumer (Story #292's `pull-requests: read` is the precedent).
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

// The distinct ceilings pr-quality.yml's tiers run under at headroom 0 — what
// the workflow itself passes as TIER_TIMEOUT_MINUTES.
const CEILINGS = "[5, 10, 15, 20, 45]";

/**
 * A job with a wall duration, in seconds. Duration is the ONLY signal that
 * separates a timeout from any other cancel, so every timed-out fixture is
 * built by stating it explicitly rather than by hand-writing timestamps.
 */
function timedJob(name, conclusion, steps, durationSeconds) {
  const startedAt = "2026-07-25T10:00:00Z";
  // Whole-second ISO-8601 with no fractional part — the exact shape
  // `gh run view --json jobs` emits for startedAt/completedAt. jq's
  // `fromdateiso8601` rejects a `.000` fraction, so a fixture carrying one
  // would exercise the degradation path instead of the classifier.
  const completedAt = new Date(Date.parse(startedAt) + durationSeconds * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  return { name, conclusion, steps, startedAt, completedAt };
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
  {
    policy = "strict",
    runJson = null,
    runList = null,
    ghFails = false,
    ceilings = CEILINGS,
  } = {}
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
        TIER_TIMEOUT_MINUTES: ceilings,
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

test(
  "classifies a job killed at its ceiling as timed-out, not stopped-mid-step",
  semantics,
  () => {
    // It ran steps, so the old classifier called this `stopped-mid-step` —
    // "something external stopped a running job", which is not what happened.
    const r = runAggregator(ONE_CANCELLED, {
      runJson: runFixture([
        timedJob("Unit (1/2)", "success", ranSteps, 90),
        timedJob("E2E / Smoke (1/1)", "cancelled", ranSteps, 45 * 60),
      ]),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cancelled provenance: timed-out/);
    // The ceiling is named, so the operator knows WHICH number to raise.
    assert.match(r.stderr, /E2E \/ Smoke \(1\/1\): timed-out \(hit its 45m ceiling\)/);
  }
);

test(
  "classifies a job killed at its ceiling before any step as timed-out, not never-started",
  semantics,
  () => {
    // The swarm-os run 30179418666 shape: `Set up runner` ate the whole budget,
    // so the job was killed with every step still SKIPPED. Reporting that as
    // `never-started` asserts an infra provisioning hang and is what sent the
    // consumer to file a runner investigation for a config fault.
    const r = runAggregator(ONE_CANCELLED, {
      runJson: runFixture([
        timedJob("Unit (1/2)", "success", ranSteps, 90),
        timedJob("Typecheck", "cancelled", neverStartedSteps, 15 * 60),
      ]),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cancelled provenance: timed-out/);
    assert.match(r.stderr, /Typecheck: timed-out \(hit its 15m ceiling\)/);
    assert.doesNotMatch(r.stderr, /provenance: never-started/);
  }
);

test("a failed sibling outranks a timed-out job", semantics, () => {
  // A fail-fast cancel can race a ceiling. The failing sibling is still the
  // thing to triage, so `fail-fast` stays first in the precedence order.
  const r = runAggregator(ONE_CANCELLED, {
    runJson: runFixture([
      timedJob("Accessibility (2/3)", "failure", ranSteps, 120),
      timedJob("E2E / Smoke (1/1)", "cancelled", ranSteps, 45 * 60),
    ]),
  });
  assert.match(r.stderr, /Cancelled provenance: fail-fast/);
  assert.doesNotMatch(r.stderr, /provenance: timed-out/);
});

test(
  "a cancel far from every ceiling keeps its existing classification",
  semantics,
  () => {
    // Positive evidence only: a duration that matches no ceiling must not be
    // relabelled. 30 minutes sits between the 20m and 45m tiers.
    const r = runAggregator(ONE_CANCELLED, {
      runJson: runFixture([
        timedJob("Unit (1/2)", "success", ranSteps, 90),
        timedJob("E2E / Smoke (1/1)", "cancelled", ranSteps, 30 * 60),
      ]),
      runList: NO_NEWER_RUNS,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /E2E \/ Smoke \(1\/1\): stopped-mid-step/);
    assert.doesNotMatch(r.stderr, /provenance: timed-out/);
  }
);

test(
  "a ceiling the set omits under-detects rather than mis-detects",
  semantics,
  () => {
    // The set is per-WORKFLOW, so a run can contain a job governed by a
    // ceiling the set does not list — most concretely ci.yml, whose `[5, 10]`
    // omits the nested pr-quality tiers' 15/20/45m budgets. The direction of
    // that gap is the load-bearing part: a job killed at an unlisted ceiling
    // keeps its previous label (a lost `timed-out`, still red), never a
    // confident wrong one. Both halves are asserted here, since only the pair
    // rules out the mirror-image bug where a narrow set relabels everything.
    const jobs = [
      timedJob("Node-script checks", "success", ranSteps, 90),
      timedJob("security / E2E / Smoke (1/1)", "cancelled", ranSteps, 45 * 60),
    ];
    const narrow = runAggregator(ONE_CANCELLED, {
      ceilings: "[5, 10]",
      runJson: runFixture(jobs),
      runList: NO_NEWER_RUNS,
    });
    assert.equal(narrow.status, 1);
    assert.match(narrow.stderr, /security \/ E2E \/ Smoke \(1\/1\): stopped-mid-step/);
    assert.doesNotMatch(narrow.stderr, /provenance: timed-out/);

    // Same job, same duration, against a set that DOES list 45 — proving the
    // assertion above turns on the omission and not on the fixture.
    const wide = runAggregator(ONE_CANCELLED, {
      runJson: runFixture(jobs),
      runList: NO_NEWER_RUNS,
    });
    assert.equal(wide.status, 1);
    assert.match(wide.stderr, /Cancelled provenance: timed-out/);
  }
);

test(
  "an unusable ceiling set degrades to the pre-existing classification",
  semantics,
  () => {
    // An absent or malformed TIER_TIMEOUT_MINUTES costs the label and nothing
    // else — never a misclassification, and never a pass.
    for (const ceilings of ["", "not json", '{"Unit": 20}']) {
      const r = runAggregator(ONE_CANCELLED, {
        ceilings,
        runJson: runFixture([
          timedJob("Unit (1/2)", "success", ranSteps, 90),
          timedJob("Typecheck", "cancelled", neverStartedSteps, 15 * 60),
        ]),
      });
      assert.equal(r.status, 1, `ceilings=${JSON.stringify(ceilings)}`);
      assert.match(
        r.stderr,
        /Cancelled provenance: never-started/,
        `ceilings=${JSON.stringify(ceilings)} should fall back, not throw`
      );
    }
  }
);

test("classification is reported on the job summary too", semantics, () => {
  const r = runAggregator(ONE_CANCELLED, { runJson: FIXTURES.neverStarted });
  assert.match(r.summary, /Provenance: `never-started`/);
  assert.match(r.summary, /INFRA fault/);
});

test(
  "a timed-out summary names the tier, its ceiling, and the remediation input",
  semantics,
  () => {
    // The whole value of the class is legibility: the operator must be able to
    // read the summary and know to edit a number, not to open a runner ticket.
    const r = runAggregator(ONE_CANCELLED, {
      runJson: runFixture([
        timedJob("Unit (1/2)", "success", ranSteps, 90),
        timedJob("Typecheck", "cancelled", neverStartedSteps, 15 * 60),
      ]),
    });
    assert.match(r.summary, /Provenance: `timed-out`/);
    assert.match(r.summary, /Typecheck: timed-out \(hit its 15m ceiling\)/);
    assert.match(r.summary, /CONFIG fault/);
    assert.match(r.summary, /timeout-headroom-minutes/);
    // It must not send the reader at the runner fleet — the misdiagnosis this
    // class exists to prevent.
    assert.match(r.summary, /do NOT escalate/);
  }
);

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

test(
  "provenance-aware keeps a timed-out cancel red even when a newer run exists",
  semantics,
  () => {
    // `timed-out` carries the same verdict semantics as `never-started`: the
    // tier produced no complete signal. A newer sibling run is present here
    // precisely so the test proves the timeout is what holds the gate red —
    // the superseded probe never gets to run.
    const r = runAggregator(ONE_CANCELLED, {
      policy: "provenance-aware",
      runJson: runFixture([
        timedJob("Unit (1/2)", "success", ranSteps, 90),
        timedJob("E2E / Smoke (1/1)", "cancelled", ranSteps, 45 * 60),
      ]),
      runList: NEWER_RUNS,
    });
    assert.equal(r.status, 1);
    assert.match(r.summary, /Provenance: `timed-out`/);
    assert.doesNotMatch(r.summary, /neutral \(superseded run\)/);
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

test("timeout-headroom-minutes is declared with a zero default", () => {
  // Same indentation walk as the sibling above, and the same reason for the
  // default: zero headroom is byte-for-byte the behaviour every existing
  // caller already gets, so adopting the input is opt-in.
  const lines = readFileSync(join(repoRoot, WORKFLOW), "utf8").split("\n");
  const start = lines.findIndex((l) => l === "      timeout-headroom-minutes:");
  assert.notEqual(start, -1, "`timeout-headroom-minutes:` input not declared");

  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (lines[i].match(/^(\s*)/)[1].length <= 6) break;
    block.push(lines[i].trim());
  }

  assert.ok(
    block.includes("type: number"),
    `\`timeout-headroom-minutes\` must be a number input; declared: ${JSON.stringify(block)}`
  );
  assert.ok(
    block.includes("default: 0"),
    "`timeout-headroom-minutes` must default to 0 so existing consumers are unaffected; " +
      `declared instead: ${JSON.stringify(block)}`
  );
});

// ---------------------------------------------------------------------------
// 5. TIMEOUT SURFACE — every tier's ceiling is caller-tunable (Story #342).
//
// GitHub charges the pre-job `Set up runner` wait against the job's own
// `timeout-minutes`, so on a self-hosted pool a tier's real budget is
// `work + queue wait` and only the caller knows its own queue distribution. A
// literal ceiling left behind here is a tier the caller cannot reach — which is
// exactly the gap #340 filed, so it is asserted rather than trusted to review.
// ---------------------------------------------------------------------------

/** Every `timeout-minutes:` declaration, tagged with its nesting depth. */
function timeoutDeclarations(rel) {
  const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
  const found = [];
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^(\s*)timeout-minutes:\s*(.+?)\s*$/);
    if (m) found.push({ line: i + 1, indent: m[1].length, value: m[2] });
  }
  return found;
}

test("every job-level ceiling in pr-quality.yml adds the caller's headroom", () => {
  // Job-level keys sit at 4 spaces (`jobs:` → `<job>:` → key); anything deeper
  // is a step-level budget, covered by the next test.
  const jobLevel = timeoutDeclarations(WORKFLOW).filter((d) => d.indent === 4);
  assert.ok(
    jobLevel.length >= 8,
    `expected every tier plus the aggregator to declare a ceiling; found ${jobLevel.length}`
  );
  for (const d of jobLevel) {
    assert.match(
      d.value,
      /^\$\{\{\s*\d+\s*\+\s*inputs\.timeout-headroom-minutes\s*\}\}$/,
      `${WORKFLOW}:${d.line} declares a literal job-level ceiling (${d.value}) — ` +
        "a self-hosted caller cannot reach it, so its budget is work + queue wait " +
        "with no way to raise the clock"
    );
  }
});

test("the fail-fast cancel step's own budget carries no headroom", () => {
  // `timeout-minutes: 1` on that step bounds a single API call inside an
  // ALREADY-RUNNING job, so no queue wait is charged against it. Adding
  // headroom there would slow a cancelled run down for no reason.
  const stepLevel = timeoutDeclarations(WORKFLOW).filter((d) => d.indent > 4);
  assert.ok(stepLevel.length > 0, "expected the fail-fast cancel step budget");
  for (const d of stepLevel) {
    assert.match(
      d.value,
      /^\d+$/,
      `${WORKFLOW}:${d.line} is a step-level budget and must stay a literal; got ${d.value}`
    );
  }
});

test("the aggregator's ceiling set mirrors the tiers' own budgets", () => {
  // TIER_TIMEOUT_MINUTES is what makes `timed-out` detectable. If a tier's base
  // budget changes and the set does not, that tier's timeouts silently fall
  // back to `stopped-mid-step` — the misdiagnosis this Story removed.
  const lines = readFileSync(join(repoRoot, WORKFLOW), "utf8");
  const bases = new Set(
    [...lines.matchAll(/^ {4}timeout-minutes: \$\{\{ (\d+) \+ /gm)].map((m) => m[1])
  );
  const declared = new Set(
    [
      ...lines.matchAll(
        /^\s*\$?\{?\{?\s*(\d+) \+ inputs\.timeout-headroom-minutes \}\},?\]?$/gm
      ),
    ].map((m) => m[1])
  );
  const setBlock = lines.slice(lines.indexOf("TIER_TIMEOUT_MINUTES:"));
  for (const base of bases) {
    assert.ok(
      declared.has(base) ||
        setBlock.includes(`${base} + inputs.timeout-headroom-minutes`),
      `a tier runs under a ${base}m base budget but TIER_TIMEOUT_MINUTES does not ` +
        "list it — timeouts on that tier would be misreported as stopped-mid-step"
    );
  }
});

// ---------------------------------------------------------------------------
// 6. PERMISSION RATCHET — the negative that makes this shippable (Story #342).
//
// #341 proposed reading GitHub's own timeout annotation via
// `GET /repos/{owner}/{repo}/check-runs/{id}/annotations`, which needs
// `checks: read`. GitHub validates a called reusable workflow's declared
// permissions against the CALLER's grant at compile time, ignoring every job's
// `if:` gate — so a new scope fails the entire call with `startup_failure` for
// any consumer that has not granted it. Story #292 added `pull-requests: read`
// to one job and broke ci.yml, the cross-repo smoke consumer, and a release.
// This is why the classifier infers from duration instead, and the allowlist
// below is what keeps a future change from quietly reintroducing the break.
// ---------------------------------------------------------------------------

test("pr-quality.yml declares no permission grant outside the allowlist", () => {
  // Scope AND level, not scope alone: escalating an existing `contents: read`
  // to `contents: write` is the same class of compile-time consumer break as
  // adding a brand-new scope, and a name-only allowlist would wave it through.
  const ALLOWED = new Set([
    "contents:read",
    "actions:write",
    "pull-requests:read",
  ]);
  const lines = readFileSync(join(repoRoot, WORKFLOW), "utf8").split("\n");
  const grants = new Set();

  for (const [i, line] of lines.entries()) {
    if (!/^\s*permissions:\s*$/.test(line)) continue;
    const blockIndent = line.match(/^(\s*)/)[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*$/.test(lines[j]) || /^\s*#/.test(lines[j])) continue;
      if (lines[j].match(/^(\s*)/)[1].length <= blockIndent) break;
      const m = lines[j].match(/^\s*([a-z-]+):\s*(read|write|none)\s*$/);
      if (m) grants.add(`${m[1]}:${m[2]}`);
    }
  }

  assert.ok(grants.size > 0, "no `permissions:` block found to check");
  for (const grant of grants) {
    assert.ok(
      ALLOWED.has(grant),
      `pr-quality.yml declares \`${grant.replace(":", ": ")}\` — a reusable workflow's ` +
        "permissions are validated against the caller's grant at COMPILE time regardless " +
        "of any `if:` gate, so a new or escalated scope breaks every consumer that has " +
        "not granted it (startup_failure, zero jobs). Widen this allowlist only alongside " +
        "a lockstep update to ci.yml, the smoke consumer, and docs/reusable-workflows.md."
    );
  }
});
