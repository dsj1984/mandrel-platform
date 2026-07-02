#!/usr/bin/env node
/**
 * uses-pins.test.mjs — node:test suite for the shared `uses:`-line / SHA-pin
 * primitives (`scripts/lib/uses-pins.mjs`, Story #203).
 *
 * Covers value stripping, line parsing, reference classification (incl. the
 * new `subpath` field), the 40-char-SHA predicate, and the intra-repo
 * single-pin invariant that `check-action-pins.mjs` now enforces. Pure — no
 * temp dirs, no git, fully offline.
 *
 * Run: node --test scripts/lib/uses-pins.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_FIRST_PARTY_OWNER,
  stripUsesValue,
  parseUsesLine,
  classifyUses,
  isSha40,
  collectFirstPartyPins,
  findSinglePinViolations,
} from "./uses-pins.mjs";

const SHA = "11bd71901bbe5b1630ceea73d27597364c9af683"; // 40 hex
const SHA2 = "0000000000000000000000000000000000000000"; // 40 hex, distinct
const SHORT = "11bd719"; // 7 hex

// ---------------------------------------------------------------------------
// isSha40
// ---------------------------------------------------------------------------

test("isSha40 accepts exactly 40 hex chars (any case)", () => {
  assert.equal(isSha40(SHA), true);
  assert.equal(isSha40(SHA.toUpperCase()), true);
});

test("isSha40 rejects tags, short SHAs, branches, and off-by-one", () => {
  assert.equal(isSha40("v4"), false);
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

test("stripUsesValue unwraps surrounding quotes and no-comment inputs", () => {
  assert.equal(stripUsesValue(`actions/checkout@${SHA}`), `actions/checkout@${SHA}`);
  assert.equal(stripUsesValue(`"actions/checkout@${SHA}"`), `actions/checkout@${SHA}`);
  assert.equal(stripUsesValue(`'actions/checkout@${SHA}'`), `actions/checkout@${SHA}`);
});

// ---------------------------------------------------------------------------
// parseUsesLine
// ---------------------------------------------------------------------------

test("parseUsesLine returns the bare ref for a mapping-key uses line", () => {
  assert.equal(parseUsesLine(`      - uses: actions/checkout@${SHA} # v4`), `actions/checkout@${SHA}`);
  assert.equal(parseUsesLine(`  uses: actions/checkout@${SHA}`), `actions/checkout@${SHA}`);
});

test("parseUsesLine returns null for comments and non-uses lines", () => {
  assert.equal(parseUsesLine("# uses: actions/checkout@v4"), null);
  assert.equal(parseUsesLine("    steps:"), null);
  assert.equal(parseUsesLine("      run: echo uses: not-a-key"), null);
});

// ---------------------------------------------------------------------------
// classifyUses (incl. subpath)
// ---------------------------------------------------------------------------

test("classifyUses flags external owner/repo as third-party with subpath", () => {
  const c = classifyUses(`github/codeql-action/analyze@${SHA}`);
  assert.equal(c.kind, "third-party");
  assert.equal(c.owner, "github/codeql-action");
  assert.equal(c.subpath, "analyze");
  assert.equal(c.ref, SHA);
});

test("classifyUses treats the default first-party owner as exempt and exposes subpath", () => {
  const c = classifyUses(
    `dsj1984/mandrel-platform/.github/actions/setup-toolchain@${SHA}`
  );
  assert.equal(c.kind, "first-party");
  assert.equal(c.owner, DEFAULT_FIRST_PARTY_OWNER);
  assert.equal(c.subpath, ".github/actions/setup-toolchain");
  assert.equal(c.ref, SHA);
});

test("classifyUses honours a custom first-party owner", () => {
  const c = classifyUses(`my-org/my-repo/.github/workflows/x.yml@v1`, "my-org/my-repo");
  assert.equal(c.kind, "first-party");
  assert.equal(c.subpath, ".github/workflows/x.yml");
});

test("classifyUses exempts local and docker refs", () => {
  assert.equal(classifyUses("./.github/actions/foo").kind, "local");
  assert.equal(classifyUses("../shared/action").kind, "local");
  assert.equal(classifyUses("docker://alpine:3.19").kind, "docker");
});

test("classifyUses reports empty subpath for a bare owner/repo self-ref", () => {
  const c = classifyUses(`dsj1984/mandrel-platform@${SHA}`);
  assert.equal(c.kind, "first-party");
  assert.equal(c.subpath, "");
});

test("classifyUses returns unparseable for a ref with no @ or too few segments", () => {
  assert.equal(classifyUses("").kind, "unparseable");
  assert.equal(classifyUses("actions/checkout").kind, "unparseable");
  assert.equal(classifyUses(`justowner@${SHA}`).kind, "unparseable");
});

// ---------------------------------------------------------------------------
// collectFirstPartyPins
// ---------------------------------------------------------------------------

test("collectFirstPartyPins keys first-party subpath refs by target", () => {
  const content = [
    "    steps:",
    `      - uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@${SHA}`,
    `      - uses: actions/checkout@${SHA}`, // third-party → ignored
    `      - uses: dsj1984/mandrel-platform@${SHA}`, // bare self-ref, no subpath → ignored
  ].join("\n");
  const byTarget = collectFirstPartyPins(content, "wf.yml");
  assert.equal(byTarget.size, 1);
  const occs = byTarget.get("dsj1984/mandrel-platform/.github/actions/setup-toolchain");
  assert.equal(occs.length, 1);
  assert.equal(occs[0].ref, SHA);
  assert.equal(occs[0].line, 2);
  assert.equal(occs[0].file, "wf.yml");
});

// ---------------------------------------------------------------------------
// findSinglePinViolations (the single-pin invariant)
// ---------------------------------------------------------------------------

test("findSinglePinViolations is clean when a target is pinned consistently", () => {
  const files = [
    {
      file: "a.yml",
      content: `      - uses: dsj1984/mandrel-platform/.github/actions/foo@${SHA}`,
    },
    {
      file: "b.yml",
      content: `      - uses: dsj1984/mandrel-platform/.github/actions/foo@${SHA}`,
    },
  ];
  assert.deepEqual(findSinglePinViolations(files), []);
});

test("findSinglePinViolations flags a target pinned to two different SHAs", () => {
  const files = [
    {
      file: "a.yml",
      content: `      - uses: dsj1984/mandrel-platform/.github/actions/foo@${SHA}`,
    },
    {
      file: "b.yml",
      content: `      - uses: dsj1984/mandrel-platform/.github/actions/foo@${SHA2}`,
    },
  ];
  const v = findSinglePinViolations(files);
  assert.equal(v.length, 1);
  assert.equal(v[0].target, "dsj1984/mandrel-platform/.github/actions/foo");
  assert.equal(v[0].shas.length, 2);
  assert.ok(v[0].shas.includes(SHA));
  assert.ok(v[0].shas.includes(SHA2));
  assert.equal(v[0].occurrences.length, 2);
  assert.deepEqual(
    v[0].occurrences.map((o) => o.file).sort(),
    ["a.yml", "b.yml"]
  );
});

test("findSinglePinViolations catches drift within a single file too", () => {
  const files = [
    {
      file: "a.yml",
      content: [
        `      - uses: dsj1984/mandrel-platform/.github/actions/foo@${SHA}`,
        `      - uses: dsj1984/mandrel-platform/.github/actions/foo@${SHA2}`,
      ].join("\n"),
    },
  ];
  const v = findSinglePinViolations(files);
  assert.equal(v.length, 1);
  assert.equal(v[0].shas.length, 2);
});

test("findSinglePinViolations ignores third-party targets (cross-repo dashboard owns those)", () => {
  const files = [
    { file: "a.yml", content: `      - uses: github/codeql-action/analyze@${SHA}` },
    { file: "b.yml", content: `      - uses: github/codeql-action/analyze@${SHA2}` },
  ];
  assert.deepEqual(findSinglePinViolations(files), []);
});

test("findSinglePinViolations honours a custom first-party owner", () => {
  const files = [
    { file: "a.yml", content: `      - uses: my-org/my-repo/actions/x@${SHA}` },
    { file: "b.yml", content: `      - uses: my-org/my-repo/actions/x@${SHA2}` },
  ];
  const v = findSinglePinViolations(files, "my-org/my-repo");
  assert.equal(v.length, 1);
  assert.equal(v[0].target, "my-org/my-repo/actions/x");
});
