#!/usr/bin/env node
/**
 * resolve-diff-range.test.mjs — node:test suite for the single, event-agnostic
 * base/head SHA derivation shared by every diff-scoped tier of pr-quality.yml
 * (Story #314).
 *
 * The workflow's gitleaks and SAST resolvers both `source` this shell script,
 * so its truth table IS the derived range each tier scans. This suite executes
 * the script directly (it echoes `RESOLVED_*=…` lines when run rather than
 * sourced) with per-event env fixtures and asserts the derived base/head for
 * each of the three events plus the full-tree fallbacks — the "self-test
 * showing the derived range for each event" half of the Story's Verify.
 *
 * Run: node scripts/resolve-diff-range.test.mjs  (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "resolve-diff-range.sh");
// The repo root is a git repo, so the push-mode reachability guard
// (`git cat-file -e <before>`) can resolve a real ancestor commit.
const REPO_ROOT = join(HERE, "..");

// A real, reachable commit for exercising the push reachability guard, and its
// parent (also reachable) to stand in as the "before" SHA.
const HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
const PARENT_SHA = execFileSync("git", ["rev-parse", "HEAD~1"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();

const ZERO_SHA = "0000000000000000000000000000000000000000";
// A syntactically-valid 40-hex SHA that is not an object in this repo.
const UNREACHABLE_SHA = "dead0000dead0000dead0000dead0000dead0000";

// Run the derivation with the given env and parse its `KEY=value` output.
function resolve(env) {
  const out = execFileSync("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // Start from a clean slate so the ambient CI env (which may itself set
    // GITHUB_* / EVENT_NAME) cannot leak into the fixture.
    env: { PATH: process.env.PATH, ...env },
  });
  const parsed = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
}

test("pull_request: derives base.sha/head.sha directly", () => {
  const r = resolve({
    PR_BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    PR_HEAD_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    EVENT_NAME: "pull_request",
  });
  assert.equal(r.RESOLVED_EVENT_MODE, "pull_request");
  assert.equal(r.RESOLVED_BASE_SHA, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(r.RESOLVED_HEAD_SHA, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});

test("merge_group: derives merge_group.base_sha/head_sha", () => {
  const r = resolve({
    MERGE_GROUP_BASE_SHA: "cccccccccccccccccccccccccccccccccccccccc",
    MERGE_GROUP_HEAD_SHA: "dddddddddddddddddddddddddddddddddddddddd",
    EVENT_NAME: "merge_group",
  });
  assert.equal(r.RESOLVED_EVENT_MODE, "merge_group");
  assert.equal(r.RESOLVED_BASE_SHA, "cccccccccccccccccccccccccccccccccccccccc");
  assert.equal(r.RESOLVED_HEAD_SHA, "dddddddddddddddddddddddddddddddddddddddd");
});

test("pull_request takes precedence over a co-present merge_group context", () => {
  const r = resolve({
    PR_BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    PR_HEAD_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    MERGE_GROUP_BASE_SHA: "cccccccccccccccccccccccccccccccccccccccc",
    MERGE_GROUP_HEAD_SHA: "dddddddddddddddddddddddddddddddddddddddd",
  });
  assert.equal(r.RESOLVED_EVENT_MODE, "pull_request");
  assert.equal(r.RESOLVED_BASE_SHA, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("merge_group takes precedence over a co-present push context", () => {
  const r = resolve({
    MERGE_GROUP_BASE_SHA: "cccccccccccccccccccccccccccccccccccccccc",
    MERGE_GROUP_HEAD_SHA: "dddddddddddddddddddddddddddddddddddddddd",
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: PARENT_SHA,
    PUSH_HEAD_SHA: HEAD_SHA,
  });
  assert.equal(r.RESOLVED_EVENT_MODE, "merge_group");
  assert.equal(r.RESOLVED_BASE_SHA, "cccccccccccccccccccccccccccccccccccccccc");
});

test("push: derives event.before/sha when before is a reachable commit", () => {
  const r = resolve({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: PARENT_SHA,
    PUSH_HEAD_SHA: HEAD_SHA,
  });
  assert.equal(r.RESOLVED_EVENT_MODE, "push");
  assert.equal(r.RESOLVED_BASE_SHA, PARENT_SHA);
  assert.equal(r.RESOLVED_HEAD_SHA, HEAD_SHA);
});

test("push with zero before (branch creation) → none/full-tree", () => {
  const r = resolve({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: ZERO_SHA,
    PUSH_HEAD_SHA: HEAD_SHA,
  });
  assert.equal(r.RESOLVED_EVENT_MODE, "none");
  assert.equal(r.RESOLVED_BASE_SHA, "");
  assert.equal(r.RESOLVED_HEAD_SHA, "");
});

test("push with an unreachable before (force-push/shallow) → none/full-tree", () => {
  const r = resolve({
    EVENT_NAME: "push",
    PUSH_BEFORE_SHA: UNREACHABLE_SHA,
    PUSH_HEAD_SHA: HEAD_SHA,
  });
  assert.equal(r.RESOLVED_EVENT_MODE, "none");
});

test("no event context at all → none/full-tree (never a startup_failure)", () => {
  const r = resolve({});
  assert.equal(r.RESOLVED_EVENT_MODE, "none");
  assert.equal(r.RESOLVED_BASE_SHA, "");
  assert.equal(r.RESOLVED_HEAD_SHA, "");
});

test("merge_group with only base_sha (partial context) → none", () => {
  const r = resolve({
    MERGE_GROUP_BASE_SHA: "cccccccccccccccccccccccccccccccccccccccc",
    EVENT_NAME: "merge_group",
  });
  assert.equal(r.RESOLVED_EVENT_MODE, "none");
});
