#!/usr/bin/env node
/**
 * check-repo-settings.test.mjs — node:test suite for the Story #171
 * repo-settings drift dashboard.
 *
 * Exercises the pure classifiers (mapRepoSettings/mapActionsSettings,
 * diffSettings) directly, and the full buildReport/runCli pipeline with an
 * injected `runGh` seam (offline — no real GitHub calls).
 *
 * Run: node scripts/check-repo-settings.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  mapRepoSettings,
  mapActionsSettings,
  diffSettings,
  buildReport,
  hasDrift,
  renderReport,
  runCli,
  parseArgv,
} from "./check-repo-settings.mjs";

const BASELINE = {
  allowSquashMerge: true,
  allowMergeCommit: false,
  allowRebaseMerge: false,
  squashMergeCommitTitle: "PR_TITLE",
  squashMergeCommitMessage: "PR_BODY",
  deleteBranchOnMerge: true,
  allowAutoMerge: true,
  actionsDefaultWorkflowPermissions: "read",
  actionsCanApprovePullRequestReviews: false,
};

test("mapRepoSettings maps GitHub's snake_case repo payload to camelCase baseline fields", () => {
  const payload = {
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "PR_BODY",
    delete_branch_on_merge: true,
    allow_auto_merge: true,
    // extra fields the repo payload carries that the schema does not govern
    full_name: "owner/repo",
  };
  const mapped = mapRepoSettings(payload);
  assert.deepEqual(mapped, {
    allowSquashMerge: true,
    allowMergeCommit: false,
    allowRebaseMerge: false,
    squashMergeCommitTitle: "PR_TITLE",
    squashMergeCommitMessage: "PR_BODY",
    deleteBranchOnMerge: true,
    allowAutoMerge: true,
  });
});

test("mapActionsSettings maps the Actions workflow-permissions payload", () => {
  const payload = { default_workflow_permissions: "write", can_approve_pull_request_reviews: true };
  assert.deepEqual(mapActionsSettings(payload), {
    actionsDefaultWorkflowPermissions: "write",
    actionsCanApprovePullRequestReviews: true,
  });
});

test("diffSettings reports no mismatches when live matches baseline", () => {
  const { drifted, mismatches } = diffSettings({ ...BASELINE }, BASELINE);
  assert.equal(drifted, false);
  assert.deepEqual(mismatches, []);
});

test("diffSettings flags every drifted field (domio-shaped: write token perms)", () => {
  const live = { ...BASELINE, actionsDefaultWorkflowPermissions: "write" };
  const { drifted, mismatches } = diffSettings(live, BASELINE);
  assert.equal(drifted, true);
  assert.deepEqual(mismatches, [
    { field: "actionsDefaultWorkflowPermissions", expected: "read", actual: "write" },
  ]);
});

test("diffSettings flags multiple mismatches (athportal-shaped: merge methods + squash source)", () => {
  const live = {
    ...BASELINE,
    allowMergeCommit: true,
    allowRebaseMerge: true,
    squashMergeCommitMessage: "COMMIT_MESSAGES",
  };
  const { mismatches } = diffSettings(live, BASELINE);
  const fields = mismatches.map((m) => m.field).sort();
  assert.deepEqual(fields, ["allowMergeCommit", "allowRebaseMerge", "squashMergeCommitMessage"]);
});

test("diffSettings ignores baseline keys that are not in the field list (schema _note, $schema)", () => {
  const baselineWithExtras = { ...BASELINE, $schema: "../../config/repo-settings.schema.json", _note: "..." };
  const { drifted } = diffSettings({ ...BASELINE }, baselineWithExtras);
  assert.equal(drifted, false);
});

function fakeRunGh(responses) {
  return (args) => {
    const path = args[1]; // ["api", "<path>", ...]
    if (!(path in responses)) {
      throw new Error(`fakeRunGh: no stub for ${path}`);
    }
    return JSON.stringify(responses[path]);
  };
}

test("buildReport: consumer matching the baseline reports 'current'", () => {
  const config = { consumers: [{ name: "domio", repo: "dsj1984/domio" }] };
  const runGh = fakeRunGh({
    "repos/dsj1984/domio": {
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      delete_branch_on_merge: true,
      allow_auto_merge: true,
    },
    "repos/dsj1984/domio/actions/permissions/workflow": {
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: false,
    },
  });
  const report = buildReport(config, BASELINE, runGh);
  assert.equal(report.consumers[0].status, "drift");
  assert.deepEqual(report.consumers[0].mismatches, [
    { field: "actionsDefaultWorkflowPermissions", expected: "read", actual: "write" },
  ]);
  assert.equal(hasDrift(report), true);
});

test("buildReport: consumer fully matching baseline reports 'current' and no drift", () => {
  const config = { consumers: [{ name: "swarm-os", repo: "Beestera/swarm-os" }] };
  const runGh = fakeRunGh({
    "repos/Beestera/swarm-os": {
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      delete_branch_on_merge: true,
      allow_auto_merge: true,
    },
    "repos/Beestera/swarm-os/actions/permissions/workflow": {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
  });
  const report = buildReport(config, BASELINE, runGh);
  assert.equal(report.consumers[0].status, "current");
  assert.equal(hasDrift(report), false);
});

test("buildReport: a gh failure for one consumer surfaces as 'error', not a thrown exception", () => {
  const config = { consumers: [{ name: "broken", repo: "owner/broken" }] };
  const runGh = () => {
    throw new Error("gh: repository not found");
  };
  const report = buildReport(config, BASELINE, runGh);
  assert.equal(report.consumers[0].status, "error");
  assert.match(report.consumers[0].error, /not found/);
  assert.equal(hasDrift(report), false, "an error is not itself drift");
});

test("renderReport renders the non-blocking framing and per-consumer rows", () => {
  const report = {
    baseline: BASELINE,
    consumers: [
      { name: "domio", repo: "dsj1984/domio", status: "current" },
      {
        name: "athportal",
        repo: "dsj1984/athportal",
        status: "drift",
        mismatches: [{ field: "allowMergeCommit", expected: false, actual: true }],
      },
      { name: "broken", repo: "owner/broken", status: "error", error: "boom" },
    ],
  };
  const text = renderReport(report);
  assert.match(text, /never a hard gate/);
  assert.match(text, /domio.*✅ current/);
  assert.match(text, /athportal.*❌ drift/);
  assert.match(text, /allowMergeCommit/);
  assert.match(text, /broken.*⚠️ error/);
});

test("parseArgv reads --config/--baseline/--json/--strict", () => {
  const parsed = parseArgv(["--config", "foo.json", "--baseline", "bar.json", "--json", "--strict"]);
  assert.deepEqual(parsed, { config: "foo.json", baseline: "bar.json", json: true, strict: true });
});

test("parseArgv defaults to the shared pin-drift consumer registry and the runbook baseline", () => {
  const parsed = parseArgv([]);
  assert.equal(parsed.config, "scripts/pin-drift-consumers.json");
  assert.equal(parsed.baseline, "docs/runbooks/repo-settings.json");
});

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "repo-settings-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("runCli --strict exits 1 when drift is present; exits 0 without --strict (non-blocking default)", () => {
  const config = { consumers: [{ name: "domio", repo: "dsj1984/domio" }] };
  const runGh = fakeRunGh({
    "repos/dsj1984/domio": {
      allow_squash_merge: true,
      allow_merge_commit: true, // drift
      allow_rebase_merge: false,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      delete_branch_on_merge: true,
      allow_auto_merge: true,
    },
    "repos/dsj1984/domio/actions/permissions/workflow": {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
  });

  const stdout = { write: () => {} };
  const stderr = { write: () => {} };

  const configPath = join(tmpDir, "consumers.json");
  const baselinePath = join(tmpDir, "baseline.json");
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(baselinePath, JSON.stringify(BASELINE));

  const exitNonStrict = runCli({
    argv: ["--config", configPath, "--baseline", baselinePath],
    cwd: tmpDir,
    stdout,
    stderr,
    runGh,
    summaryPath: undefined,
  });
  assert.equal(exitNonStrict, 0, "non-strict never fails on drift");

  const exitStrict = runCli({
    argv: ["--config", configPath, "--baseline", baselinePath, "--strict"],
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
    "repos/Beestera/swarm-os": {
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      delete_branch_on_merge: true,
      allow_auto_merge: true,
    },
    "repos/Beestera/swarm-os/actions/permissions/workflow": {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
  });

  let out = "";
  const stdout = { write: (s) => (out += s) };
  const stderr = { write: () => {} };

  const configPath = join(tmpDir, "consumers.json");
  const baselinePath = join(tmpDir, "baseline.json");
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(baselinePath, JSON.stringify(BASELINE));

  const exit = runCli({
    argv: ["--config", configPath, "--baseline", baselinePath, "--json"],
    cwd: tmpDir,
    stdout,
    stderr,
    runGh,
    summaryPath: undefined,
  });
  assert.equal(exit, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.kind, "repo-settings-report");
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
