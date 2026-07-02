#!/usr/bin/env node
/**
 * check-ruleset.test.mjs — node:test suite for the Story #178 branch-ruleset
 * drift dashboard.
 *
 * Exercises the pure classifiers (findBranchRuleset, mapRulesetToContract,
 * diffRuleset) directly, and the full buildReport/runCli pipeline with an
 * injected `runGh` seam (offline — no real GitHub calls).
 *
 * Run: node scripts/check-ruleset.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  findBranchRuleset,
  mapRulesetToContract,
  diffRuleset,
  buildReport,
  hasDrift,
  renderReport,
  runCli,
  parseArgv,
} from "./check-ruleset.mjs";

const CONTRACT = {
  branch: "main",
  requiredStatusChecks: ["ci-required"],
  aggregatorJob: "ci-required",
  upstreamJobs: ["lint", "typecheck", "unit"],
  enforceAdmins: false,
  requireLinearHistory: false,
  allowForcePushes: false,
  allowDeletions: false,
};

function compliantRuleset(overrides = {}) {
  return {
    id: 1,
    name: "main-protection",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "pull_request" },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "ci-required" }],
          strict_required_status_checks_policy: true,
        },
      },
      { type: "non_fast_forward" },
      { type: "deletion" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findBranchRuleset
// ---------------------------------------------------------------------------

test("findBranchRuleset picks the active ruleset targeting refs/heads/<branch>", () => {
  const rulesets = [
    { id: 1, enforcement: "active", conditions: { ref_name: { include: ["refs/heads/dev"] } } },
    { id: 2, enforcement: "active", conditions: { ref_name: { include: ["refs/heads/main"] } } },
  ];
  const found = findBranchRuleset(rulesets, "main");
  assert.equal(found.id, 2);
});

test("findBranchRuleset matches ~DEFAULT_BRANCH as a stand-in for the target branch", () => {
  const rulesets = [{ id: 5, enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } }];
  const found = findBranchRuleset(rulesets, "main");
  assert.equal(found.id, 5);
});

test("findBranchRuleset ignores disabled ('evaluate') rulesets", () => {
  const rulesets = [{ id: 9, enforcement: "evaluate", conditions: { ref_name: { include: ["refs/heads/main"] } } }];
  assert.equal(findBranchRuleset(rulesets, "main"), null);
});

test("findBranchRuleset returns null when nothing targets the branch", () => {
  const rulesets = [{ id: 1, enforcement: "active", conditions: { ref_name: { include: ["refs/heads/dev"] } } }];
  assert.equal(findBranchRuleset(rulesets, "main"), null);
});

// ---------------------------------------------------------------------------
// mapRulesetToContract
// ---------------------------------------------------------------------------

test("mapRulesetToContract maps a fully compliant ruleset", () => {
  const mapped = mapRulesetToContract(compliantRuleset());
  assert.deepEqual(mapped, {
    pullRequestRequired: true,
    bypassActorsEmpty: true,
    requiredStatusChecks: ["ci-required"],
    strictRequiredStatusChecksPolicy: true,
    allowForcePushes: false,
    allowDeletions: false,
    requireLinearHistory: false,
  });
});

test("mapRulesetToContract reports bypass_actors present as bypassActorsEmpty=false", () => {
  const ruleset = compliantRuleset({ bypass_actors: [{ actor_id: 1, actor_type: "Team" }] });
  const mapped = mapRulesetToContract(ruleset);
  assert.equal(mapped.bypassActorsEmpty, false);
});

test("mapRulesetToContract reports missing non_fast_forward rule as allowForcePushes=true", () => {
  const ruleset = compliantRuleset({ rules: compliantRuleset().rules.filter((r) => r.type !== "non_fast_forward") });
  const mapped = mapRulesetToContract(ruleset);
  assert.equal(mapped.allowForcePushes, true);
});

test("mapRulesetToContract reports missing deletion rule as allowDeletions=true", () => {
  const ruleset = compliantRuleset({ rules: compliantRuleset().rules.filter((r) => r.type !== "deletion") });
  const mapped = mapRulesetToContract(ruleset);
  assert.equal(mapped.allowDeletions, true);
});

test("mapRulesetToContract detects required_linear_history when present", () => {
  const ruleset = compliantRuleset({ rules: [...compliantRuleset().rules, { type: "required_linear_history" }] });
  const mapped = mapRulesetToContract(ruleset);
  assert.equal(mapped.requireLinearHistory, true);
});

test("mapRulesetToContract handles a ruleset with no rules array", () => {
  const mapped = mapRulesetToContract({ id: 1, bypass_actors: [] });
  assert.equal(mapped.pullRequestRequired, false);
  assert.deepEqual(mapped.requiredStatusChecks, []);
});

// ---------------------------------------------------------------------------
// diffRuleset
// ---------------------------------------------------------------------------

test("diffRuleset reports no mismatches for a fully compliant live ruleset", () => {
  const live = mapRulesetToContract(compliantRuleset());
  const { drifted, mismatches } = diffRuleset(live, CONTRACT);
  assert.equal(drifted, false);
  assert.deepEqual(mismatches, []);
});

test("diffRuleset flags a bypass actor added to the ruleset", () => {
  const live = mapRulesetToContract(compliantRuleset({ bypass_actors: [{ actor_id: 42 }] }));
  const { drifted, mismatches } = diffRuleset(live, CONTRACT);
  assert.equal(drifted, true);
  assert.deepEqual(mismatches, [{ field: "bypassActorsEmpty", expected: true, actual: false }]);
});

test("diffRuleset flags force-push re-enabled (non_fast_forward rule removed)", () => {
  const ruleset = compliantRuleset({ rules: compliantRuleset().rules.filter((r) => r.type !== "non_fast_forward") });
  const live = mapRulesetToContract(ruleset);
  const { mismatches } = diffRuleset(live, CONTRACT);
  assert.deepEqual(mismatches, [{ field: "allowForcePushes", expected: false, actual: true }]);
});

test("diffRuleset flags strict-status-checks-policy turned off", () => {
  const ruleset = compliantRuleset();
  ruleset.rules[1].parameters.strict_required_status_checks_policy = false;
  const live = mapRulesetToContract(ruleset);
  const { mismatches } = diffRuleset(live, CONTRACT);
  assert.deepEqual(mismatches, [
    { field: "strictRequiredStatusChecksPolicy", expected: true, actual: false },
  ]);
});

test("diffRuleset flags required-status-checks context drift (order-independent set compare)", () => {
  const ruleset = compliantRuleset();
  ruleset.rules[1].parameters.required_status_checks = [{ context: "some-other-check" }];
  const live = mapRulesetToContract(ruleset);
  const { mismatches } = diffRuleset(live, CONTRACT);
  const field = mismatches.find((m) => m.field === "requiredStatusChecks");
  assert.ok(field);
  assert.deepEqual(field.actual, ["some-other-check"]);
});

test("diffRuleset does not flag required-status-checks when the set matches regardless of order", () => {
  const contract = { ...CONTRACT, requiredStatusChecks: ["a", "b"] };
  const ruleset = compliantRuleset();
  ruleset.rules[1].parameters.required_status_checks = [{ context: "b" }, { context: "a" }];
  const live = mapRulesetToContract(ruleset);
  const { mismatches } = diffRuleset(live, contract);
  assert.equal(mismatches.some((m) => m.field === "requiredStatusChecks"), false);
});

test("diffRuleset flags PR-not-required", () => {
  const ruleset = compliantRuleset({ rules: compliantRuleset().rules.filter((r) => r.type !== "pull_request") });
  const live = mapRulesetToContract(ruleset);
  const { mismatches } = diffRuleset(live, CONTRACT);
  assert.deepEqual(mismatches, [{ field: "pullRequestRequired", expected: true, actual: false }]);
});

test("diffRuleset ignores contract keys the ruleset cannot encode ($schema, aggregatorJob, upstreamJobs, enforceAdmins, _note)", () => {
  const contractWithExtras = { ...CONTRACT, $schema: "../../config/main-protection.schema.json", _note: "..." };
  const live = mapRulesetToContract(compliantRuleset());
  const { drifted } = diffRuleset(live, contractWithExtras);
  assert.equal(drifted, false);
});

// ---------------------------------------------------------------------------
// buildReport / hasDrift / renderReport
// ---------------------------------------------------------------------------

function fakeRunGh(responses) {
  return (args) => {
    const path = args[1]; // ["api", "<path>", ...]
    if (!(path in responses)) {
      throw new Error(`fakeRunGh: no stub for ${path}`);
    }
    return JSON.stringify(responses[path]);
  };
}

test("buildReport: consumer matching the contract reports 'current'", () => {
  const config = { consumers: [{ name: "swarm-os", repo: "Beestera/swarm-os" }] };
  const runGh = fakeRunGh({
    "repos/Beestera/swarm-os/rulesets": [{ id: 1 }],
    "repos/Beestera/swarm-os/rulesets/1": compliantRuleset(),
  });
  const report = buildReport(config, CONTRACT, runGh);
  assert.equal(report.consumers[0].status, "current");
  assert.equal(hasDrift(report), false);
});

test("buildReport: consumer with a bypass actor reports 'drift'", () => {
  const config = { consumers: [{ name: "domio", repo: "dsj1984/domio" }] };
  const runGh = fakeRunGh({
    "repos/dsj1984/domio/rulesets": [{ id: 7 }],
    "repos/dsj1984/domio/rulesets/7": compliantRuleset({ bypass_actors: [{ actor_id: 1 }] }),
  });
  const report = buildReport(config, CONTRACT, runGh);
  assert.equal(report.consumers[0].status, "drift");
  assert.deepEqual(report.consumers[0].mismatches, [
    { field: "bypassActorsEmpty", expected: true, actual: false },
  ]);
  assert.equal(hasDrift(report), true);
});

test("buildReport: no ruleset targeting the branch reports 'missing' and counts as drift", () => {
  const config = { consumers: [{ name: "athportal", repo: "dsj1984/athportal" }] };
  const runGh = fakeRunGh({
    "repos/dsj1984/athportal/rulesets": [{ id: 1 }],
    "repos/dsj1984/athportal/rulesets/1": {
      id: 1,
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/dev"] } },
    },
  });
  const report = buildReport(config, CONTRACT, runGh);
  assert.equal(report.consumers[0].status, "missing");
  assert.equal(hasDrift(report), true);
});

test("buildReport: empty rulesets list reports 'missing'", () => {
  const config = { consumers: [{ name: "empty", repo: "owner/empty" }] };
  const runGh = fakeRunGh({ "repos/owner/empty/rulesets": [] });
  const report = buildReport(config, CONTRACT, runGh);
  assert.equal(report.consumers[0].status, "missing");
});

test("buildReport: a gh failure for one consumer surfaces as 'error', not a thrown exception", () => {
  const config = { consumers: [{ name: "broken", repo: "owner/broken" }] };
  const runGh = () => {
    throw new Error("gh: repository not found");
  };
  const report = buildReport(config, CONTRACT, runGh);
  assert.equal(report.consumers[0].status, "error");
  assert.match(report.consumers[0].error, /not found/);
});

test("buildReport respects a per-consumer branch override", () => {
  const config = { consumers: [{ name: "custom", repo: "owner/custom", branch: "trunk" }] };
  const runGh = fakeRunGh({
    "repos/owner/custom/rulesets": [{ id: 1 }],
    "repos/owner/custom/rulesets/1": {
      ...compliantRuleset(),
      conditions: { ref_name: { include: ["refs/heads/trunk"] } },
    },
  });
  const report = buildReport(config, CONTRACT, runGh);
  assert.equal(report.consumers[0].status, "current");
});

test("renderReport renders the non-blocking framing and per-consumer rows", () => {
  const report = {
    contract: CONTRACT,
    consumers: [
      { name: "domio", repo: "dsj1984/domio", status: "current" },
      {
        name: "athportal",
        repo: "dsj1984/athportal",
        status: "drift",
        mismatches: [{ field: "bypassActorsEmpty", expected: true, actual: false }],
      },
      { name: "swarm-os", repo: "Beestera/swarm-os", status: "missing", error: "no active ruleset" },
      { name: "broken", repo: "owner/broken", status: "error", error: "boom" },
    ],
  };
  const text = renderReport(report);
  assert.match(text, /never a hard gate/);
  assert.match(text, /domio.*✅ current/);
  assert.match(text, /athportal.*❌ drift/);
  assert.match(text, /bypassActorsEmpty/);
  assert.match(text, /swarm-os.*⚠️ missing/);
  assert.match(text, /broken.*⚠️ error/);
});

test("parseArgv reads --config/--contract/--json/--strict", () => {
  const parsed = parseArgv(["--config", "foo.json", "--contract", "bar.json", "--json", "--strict"]);
  assert.deepEqual(parsed, { config: "foo.json", contract: "bar.json", json: true, strict: true });
});

test("parseArgv defaults to the shared pin-drift consumer registry and the main-protection runbook", () => {
  const parsed = parseArgv([]);
  assert.equal(parsed.config, "scripts/pin-drift-consumers.json");
  assert.equal(parsed.contract, "docs/runbooks/main-protection.json");
});

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "check-ruleset-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("runCli --strict exits 1 when drift is present; exits 0 without --strict (non-blocking default)", () => {
  const config = { consumers: [{ name: "domio", repo: "dsj1984/domio" }] };
  const runGh = fakeRunGh({
    "repos/dsj1984/domio/rulesets": [{ id: 1 }],
    "repos/dsj1984/domio/rulesets/1": compliantRuleset({ bypass_actors: [{ actor_id: 1 }] }),
  });

  const stdout = { write: () => {} };
  const stderr = { write: () => {} };

  const configPath = join(tmpDir, "consumers.json");
  const contractPath = join(tmpDir, "contract.json");
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(contractPath, JSON.stringify(CONTRACT));

  const exitNonStrict = runCli({
    argv: ["--config", configPath, "--contract", contractPath],
    cwd: tmpDir,
    stdout,
    stderr,
    runGh,
    summaryPath: undefined,
  });
  assert.equal(exitNonStrict, 0, "non-strict never fails on drift");

  const exitStrict = runCli({
    argv: ["--config", configPath, "--contract", contractPath, "--strict"],
    cwd: tmpDir,
    stdout,
    stderr,
    runGh,
    summaryPath: undefined,
  });
  assert.equal(exitStrict, 1, "--strict fails on drift");
});

test("runCli --json emits a machine-readable envelope with the drift verdict", () => {
  const config = { consumers: [{ name: "swarm-os", repo: "Beestera/swarm-os" }] };
  const runGh = fakeRunGh({
    "repos/Beestera/swarm-os/rulesets": [{ id: 1 }],
    "repos/Beestera/swarm-os/rulesets/1": compliantRuleset(),
  });

  let out = "";
  const stdout = { write: (s) => (out += s) };
  const stderr = { write: () => {} };

  const configPath = join(tmpDir, "consumers.json");
  const contractPath = join(tmpDir, "contract.json");
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(contractPath, JSON.stringify(CONTRACT));

  const exit = runCli({
    argv: ["--config", configPath, "--contract", contractPath, "--json"],
    cwd: tmpDir,
    stdout,
    stderr,
    runGh,
    summaryPath: undefined,
  });
  assert.equal(exit, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.kind, "ruleset-report");
  assert.equal(parsed.drift, false);
  assert.equal(parsed.consumers[0].status, "current");
});

test("runCli exits 1 on a fatal config-read error (missing file)", () => {
  let errOut = "";
  const exit = runCli({
    argv: ["--config", join(tmpDir, "does-not-exist.json")],
    cwd: tmpDir,
    stdout: { write: () => {} },
    stderr: { write: (s) => (errOut += s) },
    runGh: () => {
      throw new Error("should not be called");
    },
    summaryPath: undefined,
  });
  assert.equal(exit, 1);
  assert.match(errOut, /failed to read config/);
});

test("runCli exits 1 on a fatal contract-read error (missing file)", () => {
  const configPath = join(tmpDir, "consumers.json");
  writeFileSync(configPath, JSON.stringify({ consumers: [] }));
  let errOut = "";
  const exit = runCli({
    argv: ["--config", configPath, "--contract", join(tmpDir, "does-not-exist.json")],
    cwd: tmpDir,
    stdout: { write: () => {} },
    stderr: { write: (s) => (errOut += s) },
    runGh: () => {
      throw new Error("should not be called");
    },
    summaryPath: undefined,
  });
  assert.equal(exit, 1);
  assert.match(errOut, /failed to read contract/);
});
