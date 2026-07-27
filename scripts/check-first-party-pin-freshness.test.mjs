#!/usr/bin/env node
/**
 * check-first-party-pin-freshness.test.mjs — node:test suite for the
 * first-party self-pin freshness guard (Story #354).
 *
 * The two failure classes this checker exists to separate can only be
 * exercised against real git history, so the suite builds three throwaway
 * fixture repositories under the OS temp dir:
 *
 *   • STALE       — the workflow pins the commit BEFORE the action manifest
 *                   was fixed, so the pinned manifest lags the working tree.
 *                   This is issue #352 in miniature.
 *   • UNREACHABLE — the workflow pins a commit made on a side branch that was
 *                   never merged. Its manifest is byte-identical to the
 *                   working tree, so a content-only check would call it clean;
 *                   it is one `gc` away from breaking every consumer.
 *   • CLEAN       — every pin resolves to a reachable, identical manifest.
 *
 * Each fixture is a handful of tiny files and 2–3 commits, so the suite stays
 * fast; the pure-text and fatal-path cases below use the injectable git seam
 * and touch no filesystem at all.
 *
 * Run: node --test scripts/check-first-party-pin-freshness.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseArgs,
  collectPinnedRefs,
  resolveManifest,
  manifestsMatch,
  runCheck,
  runCli,
} from "./check-first-party-pin-freshness.mjs";

const OWNER = "test-owner/test-repo";
const SUBPATH = ".github/actions/demo";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Run git in `cwd`, returning trimmed stdout. */
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Write a file, creating parent directories as needed. */
function put(root, relPath, body) {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
}

/** An action manifest body, parameterised by the line that matters. */
function manifest(tmpLine) {
  return [
    "name: demo",
    "description: fixture composite action",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - shell: bash",
    `      run: ${tmpLine}`,
    "",
  ].join("\n");
}

const STALE_BODY = manifest('tmp="$(mktemp -d)"');
const FIXED_BODY = manifest('tmp="$(mktemp -d "${RUNNER_TEMP}/demo.XXXXXX")"');

/** A workflow whose single first-party step pins `sha`. */
function workflow(sha, extraUses = []) {
  return [
    "name: fixture",
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  demo:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...extraUses.map((u) => `      - uses: ${u}`),
    `      - uses: ${OWNER}/${SUBPATH}@${sha}`,
    "",
  ].join("\n");
}

/**
 * Create a git repo with an initial `demo` action whose manifest is
 * `STALE_BODY`, then a second commit fixing it to `FIXED_BODY`. Returns the
 * repo root and both commit SHAs. The caller writes the workflow file
 * afterwards (the checker reads workflows from the working tree, so they need
 * not be committed).
 */
function makeRepo(label) {
  const root = mkdtempSync(join(tmpdir(), `pinfresh-${label}-`));
  git(root, "init", "-b", "main");
  // Repo-local identity + neutered hooks so the fixture never depends on the
  // developer's global git config or a global hooksPath.
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Pin Freshness Fixture");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", join(root, ".no-hooks"));

  put(root, `${SUBPATH}/action.yml`, STALE_BODY);
  git(root, "add", "-A");
  git(root, "commit", "-m", "initial action");
  const before = git(root, "rev-parse", "HEAD");

  put(root, `${SUBPATH}/action.yml`, FIXED_BODY);
  git(root, "add", "-A");
  git(root, "commit", "-m", "scope extraction to RUNNER_TEMP");
  const after = git(root, "rev-parse", "HEAD");

  return { root, before, after };
}

/** Capture a runCli invocation's streams alongside its exit code. */
function capture(argv) {
  const out = [];
  const errs = [];
  const code = runCli(argv, {
    log: (s) => out.push(String(s)),
    err: (s) => errs.push(String(s)),
  });
  return { code, stdout: out.join("\n"), stderr: errs.join("\n") };
}

const cleanups = [];
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});
function track(root) {
  cleanups.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// AC-4 — behavioural lag is detected, and the report names file/line/subpath/SHA
// ---------------------------------------------------------------------------

test("stale: a pin whose manifest lags the working tree exits non-zero", () => {
  const { root, before } = makeRepo("stale");
  track(root);
  put(root, ".github/workflows/fixture.yml", workflow(before));

  const result = runCheck({ cwd: root, firstPartyOwner: OWNER });

  assert.equal(result.ok, false);
  assert.equal(result.stale.length, 1);
  assert.equal(result.unreachable.length, 0);
  assert.equal(result.stale[0].subpath, SUBPATH);
  assert.equal(result.stale[0].sha, before);
});

test("stale: the CLI names the referencing file, line, subpath and pinned SHA", () => {
  const { root, before } = makeRepo("stale-cli");
  track(root);
  const body = workflow(before);
  put(root, ".github/workflows/fixture.yml", body);
  // Derive the expected line from the fixture rather than hard-coding it, so
  // the assertion pins the REPORTED line to the REAL one.
  const pinLine = body.split("\n").findIndex((l) => l.includes(`${OWNER}/${SUBPATH}@`)) + 1;

  const { code, stderr } = capture([
    "--cwd",
    root,
    "--first-party-owner",
    OWNER,
  ]);

  assert.equal(code, 1);
  // The four facts an operator needs to act without re-deriving anything.
  assert.ok(
    stderr.includes(`.github/workflows/fixture.yml:${pinLine}`),
    `report names the referencing file and line ${pinLine}`
  );
  assert.ok(stderr.includes(SUBPATH), "report names the subpath");
  assert.ok(stderr.includes(before), "report names the full pinned SHA");
  assert.match(stderr, /\[stale\]/);
});

// ---------------------------------------------------------------------------
// AC-5 — an off-branch pin is a DISTINCT class, even when content-identical
// ---------------------------------------------------------------------------

test("unreachable: an off-branch pin is classified separately from stale", () => {
  const { root, after } = makeRepo("unreachable");
  track(root);

  // A side-branch commit whose action manifest is byte-identical to main's —
  // exactly the pre-squash `setup-toolchain@1ace1d82` shape. A content-only
  // check would call this clean.
  git(root, "checkout", "-b", "side");
  put(root, "unrelated.txt", "side-branch only\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "side branch commit");
  const offBranch = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "main");

  assert.notEqual(offBranch, after);
  put(root, ".github/workflows/fixture.yml", workflow(offBranch));

  const result = runCheck({ cwd: root, firstPartyOwner: OWNER });

  assert.equal(result.ok, false);
  assert.equal(result.unreachable.length, 1);
  assert.equal(result.stale.length, 0, "an unreachable pin is not double-reported as stale");
  assert.equal(result.unreachable[0].sha, offBranch);

  const { code, stderr } = capture(["--cwd", root, "--first-party-owner", OWNER]);
  assert.equal(code, 1);
  assert.match(stderr, /\[unreachable\]/);
  assert.ok(!/\[stale\]/.test(stderr), "the unreachable finding is not also labelled stale");
});

// ---------------------------------------------------------------------------
// AC-6 — a fresh, reachable tree exits 0
// ---------------------------------------------------------------------------

test("clean: reachable pins matching the working tree exit 0", () => {
  const { root, after } = makeRepo("clean");
  track(root);
  put(root, ".github/workflows/fixture.yml", workflow(after));

  const result = runCheck({ cwd: root, firstPartyOwner: OWNER });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 1);

  const { code, stdout } = capture(["--cwd", root, "--first-party-owner", OWNER]);
  assert.equal(code, 0);
  assert.match(stdout, /✅/);
});

test("clean: two call sites pinning the same fresh SHA both pass", () => {
  const { root, after } = makeRepo("clean-multi");
  track(root);
  put(root, ".github/workflows/one.yml", workflow(after));
  put(root, ".github/workflows/two.yml", workflow(after));

  const result = runCheck({ cwd: root, firstPartyOwner: OWNER });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 2);
});

// ---------------------------------------------------------------------------
// AC-7 — third-party / local / docker references are never classified
// ---------------------------------------------------------------------------

test("non-first-party references are excluded from the scan entirely", () => {
  const { root, after } = makeRepo("exclusions");
  track(root);
  put(
    root,
    ".github/workflows/fixture.yml",
    workflow(after, [
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
      "./.github/actions/local-thing",
      "docker://alpine:3.20",
    ])
  );

  const result = runCheck({ cwd: root, firstPartyOwner: OWNER });

  assert.equal(result.ok, true);
  assert.equal(result.scanned, 1, "only the first-party pin is classified");
  assert.equal(result.unpinnedRefs.length, 0);
});

test("collectPinnedRefs: third-party, local and docker refs yield no records", () => {
  const content = [
    "      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
    "      - uses: ./.github/actions/local-thing",
    "      - uses: docker://alpine:3.20",
    "      - uses: other-org/other-repo/.github/actions/x@0000000000000000000000000000000000000000",
  ].join("\n");

  const { pins, unpinnedRefs } = collectPinnedRefs(content, "w.yml", OWNER);
  assert.deepEqual(pins, []);
  assert.deepEqual(unpinnedRefs, []);
});

test("collectPinnedRefs: a commented-out example `uses:` is not a pin", () => {
  const content = [
    `#     uses: ${OWNER}/${SUBPATH}@1111111111111111111111111111111111111111`,
    `      - uses: ${OWNER}/${SUBPATH}@2222222222222222222222222222222222222222`,
  ].join("\n");

  const { pins } = collectPinnedRefs(content, "w.yml", OWNER);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].line, 2);
  assert.equal(pins[0].sha, "2222222222222222222222222222222222222222");
});

test("collectPinnedRefs: a first-party non-SHA ref is noted, not classified as a pin", () => {
  const content = `      - uses: ${OWNER}/${SUBPATH}@main`;
  const { pins, unpinnedRefs } = collectPinnedRefs(content, "w.yml", OWNER);
  assert.deepEqual(pins, []);
  assert.equal(unpinnedRefs.length, 1);
  assert.equal(unpinnedRefs[0].ref, "main");
});

test("collectPinnedRefs: a bare owner/repo self-ref has no subpath and is skipped", () => {
  const content = `      - uses: ${OWNER}@1111111111111111111111111111111111111111`;
  const { pins, unpinnedRefs } = collectPinnedRefs(content, "w.yml", OWNER);
  assert.deepEqual(pins, []);
  assert.deepEqual(unpinnedRefs, []);
});

// ---------------------------------------------------------------------------
// Manifest resolution + comparison
// ---------------------------------------------------------------------------

test("resolveManifest: a directory subpath resolves to its action.yml", () => {
  const { root } = makeRepo("resolve-dir");
  track(root);
  assert.deepEqual(resolveManifest(root, SUBPATH), {
    path: `${SUBPATH}/action.yml`,
    kind: "action",
  });
});

test("resolveManifest: a workflow-file subpath resolves to itself", () => {
  const { root } = makeRepo("resolve-file");
  track(root);
  put(root, ".github/workflows/reusable.yml", "on: workflow_call\njobs: {}\n");
  assert.deepEqual(resolveManifest(root, ".github/workflows/reusable.yml"), {
    path: ".github/workflows/reusable.yml",
    kind: "workflow",
  });
});

test("resolveManifest: a missing subpath resolves to null", () => {
  const { root } = makeRepo("resolve-missing");
  track(root);
  assert.equal(resolveManifest(root, ".github/actions/nope"), null);
});

test("manifestsMatch: identical bodies match across CRLF/LF line endings", () => {
  assert.equal(manifestsMatch("a\nb\n", "a\r\nb\r\n"), true);
  assert.equal(manifestsMatch("a\nb\n", "a\nc\n"), false);
});

// ---------------------------------------------------------------------------
// Fatal paths — the check refuses to guess when history is unavailable
// ---------------------------------------------------------------------------

const OK_GIT = {
  isRepo: () => true,
  isShallow: () => false,
  resolveRef: () => "0".repeat(40),
  isAncestor: () => true,
  show: () => "",
};

test("runCheck: a non-git directory is a fatal refusal, not a silent pass", () => {
  const result = runCheck({ cwd: process.cwd() }, { ...OK_GIT, isRepo: () => false });
  assert.equal(result.ok, false);
  assert.match(result.fatal, /not a git repository/);
});

test("runCheck: a shallow clone is refused with the fetch-depth remedy", () => {
  const result = runCheck({ cwd: process.cwd() }, { ...OK_GIT, isShallow: () => true });
  assert.equal(result.ok, false);
  assert.match(result.fatal, /fetch-depth: 0/);
});

test("runCheck: an unresolvable --ref is fatal", () => {
  const result = runCheck({ cwd: process.cwd(), ref: "nope" }, { ...OK_GIT, resolveRef: () => null });
  assert.equal(result.ok, false);
  assert.match(result.fatal, /does not resolve/);
});

test("runCli: a fatal condition exits 1", () => {
  const { root } = makeRepo("fatal-cli");
  track(root);
  const { code, stderr } = capture(["--cwd", root, "--ref", "no-such-ref"]);
  assert.equal(code, 1);
  assert.match(stderr, /does not resolve/);
});

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

test("parseArgs: defaults target the conventional trees and HEAD", () => {
  const opts = parseArgs([]);
  assert.equal(opts.workflowsDir, ".github/workflows");
  assert.equal(opts.actionsDir, ".github/actions");
  assert.equal(opts.ref, "HEAD");
  assert.equal(opts.firstPartyOwner, "dsj1984/mandrel-platform");
  assert.equal(opts.help, false);
});

test("parseArgs: flags override the defaults", () => {
  const opts = parseArgs(["--ref", "origin/main", "--first-party-owner", "my-org/my-repo"]);
  assert.equal(opts.ref, "origin/main");
  assert.equal(opts.firstPartyOwner, "my-org/my-repo");
});

test("parseArgs: an unknown flag throws rather than silently disabling the check", () => {
  assert.throws(() => parseArgs(["--no-such-flag"]), /unknown argument/);
});

test("runCli: an unknown flag exits 1 with usage", () => {
  const { code, stderr } = capture(["--no-such-flag"]);
  assert.equal(code, 1);
  assert.match(stderr, /unknown argument/);
});

test("runCli: --help prints usage and exits 0", () => {
  const { code, stdout } = capture(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: node scripts\/check-first-party-pin-freshness\.mjs/);
});
