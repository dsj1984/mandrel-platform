#!/usr/bin/env node
/**
 * check-action-pins.test.mjs — node:test suite for the action-pin ratchet that
 * backs mandrel-platform's `ci-required` third-party-action SHA-pin gate
 * (Story #112).
 *
 * This is the "equivalent self-test" the Story's acceptance criteria call for:
 * it exercises the ratchet's classification (third-party vs first-party vs
 * local vs docker), the 40-char-SHA assertion, the `# tag` comment strip, and
 * a full content scan with both a SHA-pinned (pass) and a tag-pinned (fail)
 * fixture. Pure helpers + a temp-dir fixture keep the whole pipeline offline.
 *
 * Run: node scripts/check-action-pins.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  parseArgs,
  stripUsesValue,
  classifyUses,
  isSha40,
  scanContent,
  listWorkflowFiles,
  listActionFiles,
  runLint,
  runCli,
} from "./check-action-pins.mjs";

const SHA = "11bd71901bbe5b1630ceea73d27597364c9af683"; // 40 hex
const SHORT = "11bd719"; // 7 hex

// ---------------------------------------------------------------------------
// isSha40
// ---------------------------------------------------------------------------

test("isSha40 accepts exactly 40 hex chars", () => {
  assert.equal(isSha40(SHA), true);
  assert.equal(isSha40(SHA.toUpperCase()), true);
});

test("isSha40 rejects tags, short SHAs, branches", () => {
  assert.equal(isSha40("v4"), false);
  assert.equal(isSha40("v4.2.2"), false);
  assert.equal(isSha40(SHORT), false);
  assert.equal(isSha40("main"), false);
  assert.equal(isSha40(SHA + "0"), false); // 41 chars
  assert.equal(isSha40("g".repeat(40)), false); // non-hex
});

// ---------------------------------------------------------------------------
// stripUsesValue
// ---------------------------------------------------------------------------

test("stripUsesValue drops the trailing # tag comment", () => {
  assert.equal(
    stripUsesValue(`actions/checkout@${SHA} # v4.2.2`),
    `actions/checkout@${SHA}`
  );
});

test("stripUsesValue handles no comment and surrounding quotes", () => {
  assert.equal(stripUsesValue(`actions/checkout@${SHA}`), `actions/checkout@${SHA}`);
  assert.equal(stripUsesValue(`"actions/checkout@${SHA}"`), `actions/checkout@${SHA}`);
  assert.equal(stripUsesValue(`'actions/checkout@${SHA}'`), `actions/checkout@${SHA}`);
});

// ---------------------------------------------------------------------------
// classifyUses
// ---------------------------------------------------------------------------

test("classifyUses flags external owner/repo as third-party", () => {
  const c = classifyUses(`actions/checkout@${SHA}`);
  assert.equal(c.kind, "third-party");
  assert.equal(c.owner, "actions/checkout");
  assert.equal(c.ref, SHA);
});

test("classifyUses treats the first-party owner as exempt", () => {
  const c = classifyUses(
    `dsj1984/mandrel-platform/.github/actions/setup-toolchain@${SHA}`
  );
  assert.equal(c.kind, "first-party");
  // The subpath after owner/repo is preserved out of `ref`; ref is the gitref.
  assert.equal(c.ref, SHA);
});

test("classifyUses honours a custom --first-party-owner", () => {
  const c = classifyUses(`my-org/my-repo/.github/workflows/x.yml@v1`, "my-org/my-repo");
  assert.equal(c.kind, "first-party");
});

test("classifyUses exempts local and docker refs", () => {
  assert.equal(classifyUses("./.github/actions/foo").kind, "local");
  assert.equal(classifyUses("../shared/action").kind, "local");
  assert.equal(classifyUses("docker://alpine:3.19").kind, "docker");
});

test("classifyUses isolates the git ref after the LAST @ (subpath-safe)", () => {
  const c = classifyUses(`github/codeql-action/analyze@${SHA}`);
  assert.equal(c.kind, "third-party");
  assert.equal(c.owner, "github/codeql-action");
  assert.equal(c.ref, SHA);
});

// ---------------------------------------------------------------------------
// scanContent
// ---------------------------------------------------------------------------

test("scanContent passes a fully SHA-pinned third-party uses", () => {
  const yaml = [
    "jobs:",
    "  build:",
    "    steps:",
    `      - uses: actions/checkout@${SHA} # v4.2.2`,
    `      - uses: step-security/harden-runner@${SHA} # v2.19.4`,
  ].join("\n");
  const { violations, scanned } = scanContent(yaml, "wf.yml");
  assert.equal(scanned, 2);
  assert.deepEqual(violations, []);
});

test("scanContent fails a tag-pinned third-party uses", () => {
  const yaml = [
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      - uses: pnpm/action-setup@${SHA}`,
  ].join("\n");
  const { violations, scanned } = scanContent(yaml, "wf.yml");
  assert.equal(scanned, 2);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].owner, "actions/checkout");
  assert.equal(violations[0].line, 2);
  assert.match(violations[0].reason, /not a full 40-char commit SHA/);
});

test("scanContent ignores first-party, local, docker, and comment lines", () => {
  const yaml = [
    "# uses: actions/checkout@v4  (this is a comment example, must be ignored)",
    "    steps:",
    `      - uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@${SHA}`,
    "      - uses: ./.github/actions/local-thing",
    "      - uses: docker://alpine:3.19",
  ].join("\n");
  const { violations, scanned } = scanContent(yaml, "wf.yml");
  assert.equal(scanned, 0); // none are third-party
  assert.deepEqual(violations, []);
});

test("scanContent flags a short-SHA third-party pin", () => {
  const yaml = `      - uses: actions/setup-node@${SHORT}`;
  const { violations } = scanContent(yaml, "wf.yml");
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /not a full 40-char commit SHA/);
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs applies defaults and overrides", () => {
  const d = parseArgs([]);
  assert.equal(d.workflowsDir, ".github/workflows");
  assert.equal(d.actionsDir, ".github/actions");
  assert.equal(d.firstPartyOwner, "dsj1984/mandrel-platform");

  const o = parseArgs(["--first-party-owner", "x/y", "--workflows-dir", "wf"]);
  assert.equal(o.firstPartyOwner, "x/y");
  assert.equal(o.workflowsDir, "wf");
});

test("parseArgs throws on unknown flag and missing value", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--first-party-owner"]), /missing value/);
});

// ---------------------------------------------------------------------------
// runLint + runCli over a temp fixture tree
// ---------------------------------------------------------------------------

function fixtureRepo({ workflow }) {
  const root = mkdtempSync(join(tmpdir(), "pin-ratchet-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), workflow);
  return root;
}

test("runLint is green when every third-party action is SHA-pinned", () => {
  const root = fixtureRepo({
    workflow: [
      "    steps:",
      `      - uses: actions/checkout@${SHA} # v4`,
      `      - uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@${SHA}`,
    ].join("\n"),
  });
  try {
    const res = runLint({
      cwd: root,
      workflowsDir: ".github/workflows",
      actionsDir: ".github/actions",
      firstPartyOwner: "dsj1984/mandrel-platform",
    });
    assert.equal(res.ok, true);
    assert.equal(res.scanned, 1); // only the third-party checkout counts
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLint / runCli are red on a tag-pinned third-party action", () => {
  const root = fixtureRepo({
    workflow: ["    steps:", "      - uses: actions/checkout@v4"].join("\n"),
  });
  try {
    const res = runLint({
      cwd: root,
      workflowsDir: ".github/workflows",
      actionsDir: ".github/actions",
      firstPartyOwner: "dsj1984/mandrel-platform",
    });
    assert.equal(res.ok, false);
    assert.equal(res.violations.length, 1);

    const errs = [];
    const code = runCli(["--cwd", root], { log: () => {}, err: (m) => errs.push(m) });
    assert.equal(code, 1);
    assert.ok(errs.some((m) => /unpinned third-party action/.test(m)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkflowFiles / listActionFiles return [] for a missing dir", () => {
  assert.deepEqual(listWorkflowFiles("/no/such/dir/workflows"), []);
  assert.deepEqual(listActionFiles("/no/such/dir/actions"), []);
});
