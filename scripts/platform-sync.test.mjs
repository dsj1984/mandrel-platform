#!/usr/bin/env node
/**
 * platform-sync.test.mjs — node:test suite for the MP-14 adoption CLI.
 *
 * Exercises the four acceptance behaviours against a synthetic consumer dir
 * built under a temp root, in offline mode (`--sha` skips the network):
 *
 *   1. workflow SHA pinning (first-party rewritten, external untouched, the
 *      `# <ref>` annotation refreshed),
 *   2. runbook reference-stub materialization (link-only, local-copy warning),
 *   3. renovate / tsconfig `extends` reconciliation (SSOT prepended, consumer
 *      overrides preserved),
 *   4. idempotency + `--dry-run` non-mutation.
 *
 * Run: node scripts/platform-sync.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "platform-sync.mjs");
const SHA = "a".repeat(40);
const REF = "mandrel-platform-v9.9.9";

let consumer;

function run(extraArgs) {
  return execFileSync(
    "node",
    [CLI, "--ref", REF, "--sha", SHA, "--consumer", consumer, "--json", ...extraArgs],
    { encoding: "utf8" }
  );
}

function seedConsumer() {
  mkdirSync(join(consumer, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(consumer, ".github", "workflows", "ci.yml"),
    [
      "name: CI",
      "jobs:",
      "  q:",
      "    steps:",
      `      - uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@${"1".repeat(40)} # stale`,
      `      - uses: actions/checkout@${"2".repeat(40)} # external`,
      "",
    ].join("\n")
  );
  writeFileSync(join(consumer, "renovate.json"), JSON.stringify({ extends: ["config:base"] }, null, 2));
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { outDir: "dist" } }, null, 2)
  );
}

beforeEach(() => {
  consumer = mkdtempSync(join(tmpdir(), "platform-sync-test-"));
  seedConsumer();
});

afterEach(() => {
  rmSync(consumer, { recursive: true, force: true });
});

test("--dry-run does not mutate any file", () => {
  const before = readFileSync(join(consumer, ".github", "workflows", "ci.yml"), "utf8");
  const out = JSON.parse(run(["--dry-run"]));
  assert.equal(out.dryRun, true);
  assert.equal(out.changed, true);
  const after = readFileSync(join(consumer, ".github", "workflows", "ci.yml"), "utf8");
  assert.equal(after, before, "ci.yml must be untouched in dry-run");
  assert.ok(!existsSync(join(consumer, "docs", "runbooks", "observability.md")));
});

test("apply pins first-party SHAs, leaves external actions untouched", () => {
  const out = JSON.parse(run([]));
  assert.equal(out.changed, true);
  assert.equal(out.pins.length, 1);
  const ci = readFileSync(join(consumer, ".github", "workflows", "ci.yml"), "utf8");
  assert.ok(ci.includes(`setup-toolchain@${SHA} # ${REF}`), "first-party pin rewritten + annotated");
  assert.ok(ci.includes(`actions/checkout@${"2".repeat(40)} # external`), "external action untouched");
});

test("apply materializes runbook reference stubs (link, don't copy)", () => {
  run([]);
  const stub = join(consumer, "docs", "runbooks", "deploy-promotion.md");
  assert.ok(existsSync(stub));
  const body = readFileSync(stub, "utf8");
  assert.ok(body.includes("Thin local stub"), "materialized stub is a reference, not a copy");
  assert.ok(
    body.includes("github.com/dsj1984/mandrel-platform"),
    "stub links back to the canonical runbook"
  );
});

test("apply reconciles renovate + tsconfig extends, preserving consumer entries", () => {
  run([]);
  const renovate = JSON.parse(readFileSync(join(consumer, "renovate.json"), "utf8"));
  assert.deepEqual(renovate.extends, ["github>dsj1984/mandrel-platform", "config:base"]);
  const tsconfig = JSON.parse(readFileSync(join(consumer, "tsconfig.json"), "utf8"));
  assert.equal(tsconfig.extends, "mandrel-platform/tsconfig.base.json");
  assert.equal(tsconfig.compilerOptions.outDir, "dist", "consumer overrides preserved");
});

test("re-running is idempotent (changed: false on the second pass)", () => {
  run([]);
  const second = JSON.parse(run([]));
  assert.equal(second.changed, false, "second sync reports no changes");
  assert.equal(second.pins.length, 0);
});

test("a full local-copy runbook is flagged, not overwritten", () => {
  const dest = join(consumer, "docs", "runbooks");
  mkdirSync(dest, { recursive: true });
  const localCopy = "# Local copy, no stub marker\n\nfull process re-authored here\n";
  writeFileSync(join(dest, "observability.md"), localCopy);
  const out = JSON.parse(run([]));
  assert.ok(
    out.runbooks.localCopies.some((f) => f.endsWith("observability.md")),
    "local copy surfaced as a warning"
  );
  assert.equal(
    readFileSync(join(dest, "observability.md"), "utf8"),
    localCopy,
    "operator's local copy is never clobbered"
  );
});

test("an existing reference stub is skipped idempotently", () => {
  run([]); // materialize stubs
  const out = JSON.parse(run([])); // second pass
  assert.ok(out.runbooks.skipped.length >= 8, "already-present stubs are skipped, not re-created");
  assert.equal(out.runbooks.created.length, 0);
});

// ---------------------------------------------------------------------------
// --check-settings / --apply-settings (Story #171)
//
// platform-sync.mjs shells out to the real `gh` CLI for the GitHub-side
// settings mode (no dependency-injection seam like check-pin-drift.mjs), so
// these tests stub `gh` as a fake executable on PATH and drive the CLI
// end-to-end. The pure diff/classification logic itself is unit-tested in
// check-repo-settings.test.mjs; this suite exercises platform-sync's own
// argument wiring, PATCH-call shape, and non-blocking exit-code contract.
// ---------------------------------------------------------------------------

let settingsDir;
let fakeGhDir;
let fakeGhLogPath;

/**
 * Write a fake `gh` shell script onto a scratch PATH dir that:
 *   - responds to `gh api repos/<repo>` and `gh api repos/<repo>/actions/permissions/workflow`
 *     with the JSON bodies given in `responses` (keyed by the API path),
 *   - logs every invocation's args (one JSON line per call) to `fakeGhLogPath`
 *     so PATCH calls can be asserted on,
 *   - exits 0 for any recognized `gh api ...` / `gh api -X PATCH ...` call.
 */
function writeFakeGh(responses) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(fakeGhLogPath)}, JSON.stringify(args) + "\\n");
const responses = ${JSON.stringify(responses)};
if (args[0] === "api") {
  const isPatch = args[1] === "-X" && args[2] === "PATCH";
  const path = isPatch ? args[3] : args[1];
  if (isPatch) {
    process.exit(0);
  }
  if (Object.prototype.hasOwnProperty.call(responses, path)) {
    process.stdout.write(JSON.stringify(responses[path]));
    process.exit(0);
  }
  process.stderr.write("no stub for " + path + "\\n");
  process.exit(1);
}
process.exit(1);
`;
  const ghPath = join(fakeGhDir, "gh");
  writeFileSync(ghPath, script, { mode: 0o755 });
}

function runSettings(extraArgs) {
  return execFileSync("node", [CLI, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeGhDir}:${process.env.PATH}` },
  });
}

const BASELINE_SETTINGS = {
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

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), "platform-sync-settings-test-"));
  fakeGhDir = mkdtempSync(join(tmpdir(), "platform-sync-fakegh-"));
  fakeGhLogPath = join(settingsDir, "gh-calls.log");
  writeFileSync(fakeGhLogPath, "");
  writeFileSync(join(settingsDir, "baseline.json"), JSON.stringify(BASELINE_SETTINGS));
});

afterEach(() => {
  rmSync(settingsDir, { recursive: true, force: true });
  rmSync(fakeGhDir, { recursive: true, force: true });
});

test("--check-settings reports no drift when live settings match the baseline", () => {
  writeFakeGh({
    "repos/dsj1984/swarm-os": {
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      delete_branch_on_merge: true,
      allow_auto_merge: true,
    },
    "repos/dsj1984/swarm-os/actions/permissions/workflow": {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
  });
  const out = JSON.parse(
    runSettings([
      "--check-settings",
      "--consumer-repo",
      "dsj1984/swarm-os",
      "--baseline",
      join(settingsDir, "baseline.json"),
      "--json",
    ])
  );
  assert.equal(out.mode, "check-settings");
  assert.equal(out.drift, false);
  assert.deepEqual(out.mismatches, []);
});

test("--check-settings reports drift (domio-shaped: write token perms) without mutating anything", () => {
  writeFakeGh({
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
  const out = JSON.parse(
    runSettings([
      "--check-settings",
      "--consumer-repo",
      "dsj1984/domio",
      "--baseline",
      join(settingsDir, "baseline.json"),
      "--json",
    ])
  );
  assert.equal(out.drift, true);
  assert.deepEqual(out.mismatches, [
    { field: "actionsDefaultWorkflowPermissions", expected: "read", actual: "write" },
  ]);
  assert.equal(out.applied, false, "--check-settings never applies");
  const calls = readFileSync(fakeGhLogPath, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(
    calls.every((line) => !JSON.parse(line).includes("PATCH")),
    "no PATCH call issued by --check-settings"
  );
});

test("--check-settings never fails the exit code on drift (non-blocking, standing decision #10)", () => {
  writeFakeGh({
    "repos/dsj1984/athportal": {
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "COMMIT_MESSAGES",
      delete_branch_on_merge: true,
      allow_auto_merge: true,
    },
    "repos/dsj1984/athportal/actions/permissions/workflow": {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: true,
    },
  });
  // execFileSync throws on non-zero exit; a clean return proves exit 0.
  assert.doesNotThrow(() => {
    runSettings([
      "--check-settings",
      "--consumer-repo",
      "dsj1984/athportal",
      "--baseline",
      join(settingsDir, "baseline.json"),
      "--json",
    ]);
  });
});

test("--apply-settings PATCHes only the drifted fields, across both endpoints", () => {
  writeFakeGh({
    "repos/dsj1984/athportal": {
      allow_squash_merge: true,
      allow_merge_commit: true, // drift
      allow_rebase_merge: true, // drift
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      delete_branch_on_merge: true,
      allow_auto_merge: true,
    },
    "repos/dsj1984/athportal/actions/permissions/workflow": {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: true, // drift
    },
  });
  const out = JSON.parse(
    runSettings([
      "--apply-settings",
      "--consumer-repo",
      "dsj1984/athportal",
      "--baseline",
      join(settingsDir, "baseline.json"),
      "--json",
    ])
  );
  assert.equal(out.applied, true);
  assert.equal(out.mismatches.length, 3);

  const calls = readFileSync(fakeGhLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const patchCalls = calls.filter((c) => c[1] === "-X" && c[2] === "PATCH");
  assert.equal(patchCalls.length, 2, "one PATCH for the repo endpoint, one for the Actions endpoint");
  const repoPatch = patchCalls.find((c) => c[3] === "repos/dsj1984/athportal");
  const actionsPatch = patchCalls.find((c) => c[3] === "repos/dsj1984/athportal/actions/permissions/workflow");
  assert.ok(repoPatch, "repo-settings PATCH issued");
  assert.ok(actionsPatch, "Actions-permissions PATCH issued");
});

test("--apply-settings --dry-run reports the plan without issuing any PATCH", () => {
  writeFakeGh({
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
      default_workflow_permissions: "write", // drift
      can_approve_pull_request_reviews: false,
    },
  });
  const out = JSON.parse(
    runSettings([
      "--apply-settings",
      "--dry-run",
      "--consumer-repo",
      "dsj1984/domio",
      "--baseline",
      join(settingsDir, "baseline.json"),
      "--json",
    ])
  );
  assert.equal(out.dryRun, true);
  assert.equal(out.applied, false, "dry-run never applies");
  const calls = readFileSync(fakeGhLogPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(
    calls.every((c) => !(c[1] === "-X" && c[2] === "PATCH")),
    "no PATCH issued under --dry-run"
  );
});

test("--check-settings requires --consumer-repo", () => {
  assert.throws(() => {
    execFileSync("node", [CLI, "--check-settings"], { encoding: "utf8" });
  }, /consumer-repo/);
});
