#!/usr/bin/env node
/**
 * check-advisory-scan-setup.test.mjs — regression guard for advisory-scan.yml's
 * `setup` input (Story #471).
 *
 * The bug this pins: `advisory-scan.yml` provisioned Node one way only — the
 * `setup-toolchain` composite, which is pnpm-only (`actions/setup-node` with
 * `cache: pnpm`, then `pnpm install --frozen-lockfile`). This repo is npm
 * (`package-lock.json`, `npm ci` in ci.yml, no `pnpm-lock.yaml`), so the
 * scheduled dogfood caller died at setup-node — "Dependencies lock file is not
 * found ... Supported file patterns: pnpm-lock.yaml" — on EVERY run from the
 * day it shipped. The job never reached the scan, so a workflow whose whole
 * job is to notice things silently noticed nothing for seven weeks.
 *
 * That failure mode is why the assertions below are behavioural rather than
 * textual wherever they can be: the `if:` expressions are EXTRACTED and RUN
 * under GitHub's own truthiness rules (`scripts/lib/actions-expression.mjs`),
 * because the defect class here is an expression that reads correctly and
 * evaluates wrong.
 *
 * Run: node --test scripts/check-advisory-scan-setup.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { evaluate } from "./lib/actions-expression.mjs";

const ADVISORY = ".github/workflows/advisory-scan.yml";
const SCHEDULE = ".github/workflows/advisory-scan-schedule.yml";
const DOCS = "docs/reusable-workflows.md";
const ARCHITECTURE = "docs/architecture.md";

const advisory = readFileSync(ADVISORY, "utf8");
const schedule = readFileSync(SCHEDULE, "utf8");

// ---------------------------------------------------------------------------
// Extraction — the same read-then-execute approach as
// check-toolchain-cache-default.test.mjs, so a guarded expression is never
// asserted by its spelling.
// ---------------------------------------------------------------------------

/**
 * The block of one `- name: <name>` step, up to the next step at the same
 * indent. Scans lines rather than building a `new RegExp` around `name`: a
 * dynamically-constructed regex is a SAST finding and buys nothing here.
 */
function stepByName(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `${ADVISORY}: step "${name}" not found`);
  const indent = lines[start].match(/^(\s*)/)[1].length;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("- ") && lines[i].match(/^(\s*)/)[1].length <= indent) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** The `${{ … }}`-free body of a step's `if:` condition. */
function ifExpression(step, name) {
  const m = step.match(/^\s*if:\s*(.+)$/m);
  assert.ok(m, `step "${name}" has no \`if:\` guard`);
  return m[1].trim().replace(/^\$\{\{/, "").replace(/\}\}$/, "").trim();
}

/** The literal `default:` of the named workflow_call input. */
function inputDefault(text, name) {
  const lines = text.split("\n");
  const start = lines.indexOf(`      ${name}:`);
  assert.notEqual(start, -1, `${ADVISORY}: workflow_call input \`${name}\` not found`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (lines[i].match(/^(\s*)/)[1].length <= 6) break;
    const d = lines[i].match(/^\s*default:\s*(.+)$/);
    if (d) return d[1].trim();
  }
  return assert.fail(`${ADVISORY}: input \`${name}\` has no default`);
}

const TOOLCHAIN_STEP = "Setup toolchain";
const NODE_STEP = "Setup Node.js (install-free)";
const GUARD_STEP = "Validate setup input";

// ---------------------------------------------------------------------------
// AC-1 — the default is a literal, so no consumer moves.
// ---------------------------------------------------------------------------

test("the `setup` default is a literal 'toolchain', not an expression", () => {
  // An expression here is what portability lint Rule 2 rejects and what GitHub
  // silently fails to evaluate at interface-validation time. The value itself
  // matters just as much: every consumer on today's pinned SHA passes no
  // `setup` at all, so the default IS their behaviour.
  const value = inputDefault(advisory, "setup");
  assert.equal(value, "'toolchain'");
  assert.doesNotMatch(value, /\$\{\{/, "a workflow_call default may not hold an expression");
});

// ---------------------------------------------------------------------------
// AC-3 — one cache site, and none on the install-free path.
// ---------------------------------------------------------------------------

test("exactly one cache expression exists, and it is the toolchain step's", () => {
  // check-toolchain-cache-default.test.mjs extracts the FIRST `cache: ${{ … }}`
  // in this file and asserts it against pr-quality.yml's. A second site would
  // silently pin the wrong expression while that whole suite stayed green — so
  // the count, not just the value, is the invariant.
  const sites = advisory.split("\n").filter((l) => /^\s*cache:\s*\$\{\{.+\}\}\s*$/.test(l));
  assert.equal(sites.length, 1, "expected exactly one cache: call site");
  assert.ok(
    stepByName(advisory, TOOLCHAIN_STEP).includes(sites[0]),
    "the surviving cache site must belong to the setup-toolchain step",
  );
});

test("the install-free step declares no cache key at all", () => {
  // Not even `cache: ''` — an empty value is still a second site for a reader,
  // and there is nothing to cache on a path that installs nothing.
  assert.doesNotMatch(stepByName(advisory, NODE_STEP), /^\s*cache:/m);
});

// ---------------------------------------------------------------------------
// AC-4 — the install-free path provisions a pinned Node and installs nothing.
// ---------------------------------------------------------------------------

test("the install-free step pins Node from .nvmrc via a SHA-pinned setup-node", () => {
  const step = stepByName(advisory, NODE_STEP);
  assert.match(step, /node-version-file:\s*\.nvmrc/, "Node must come from .nvmrc, not a literal");
  assert.match(
    step,
    /uses:\s*actions\/setup-node@[0-9a-f]{40}/,
    "setup-node must be SHA-pinned",
  );
});

test("no dependency install runs on the install-free path", () => {
  // The whole point of the path: osv-scanner reads lockfiles off disk, and both
  // composites' gate scripts import only node builtins and relative siblings.
  const step = stepByName(advisory, NODE_STEP);
  assert.doesNotMatch(step, /pnpm install/, "the install-free path must not install");
  assert.doesNotMatch(step, /npm ci|npm install/, "the install-free path must not install");
});

// ---------------------------------------------------------------------------
// AC-5 — exhaustive selection, and a loud failure on anything else.
// ---------------------------------------------------------------------------

test("each recognized `setup` value selects exactly one provisioning step", () => {
  // Evaluated, not grepped: `&&`/`||` in an Actions expression yield OPERANDS
  // and every non-empty string is truthy, so a guard can read right and select
  // both branches — or neither.
  const guards = [
    { name: TOOLCHAIN_STEP, expr: ifExpression(stepByName(advisory, TOOLCHAIN_STEP), TOOLCHAIN_STEP) },
    { name: NODE_STEP, expr: ifExpression(stepByName(advisory, NODE_STEP), NODE_STEP) },
  ];
  for (const setup of ["toolchain", "node"]) {
    const selected = guards.filter(({ expr }) => evaluate(expr, { setup }) === true);
    assert.equal(
      selected.length,
      1,
      `setup '${setup}' selected ${selected.length} step(s): ${selected.map((s) => s.name).join(", ")}`,
    );
  }
});

test("an unrecognized `setup` value selects NO provisioning step — so a guard must reject it first", () => {
  // This is the fail-closed half. With both branches skipped and no guard, the
  // job would run the composites' gate scripts against whatever ambient Node
  // the runner image carries: green, unpinned, and wrong.
  const guards = [TOOLCHAIN_STEP, NODE_STEP].map((name) =>
    ifExpression(stepByName(advisory, name), name),
  );
  for (const setup of ["", "nodejs", "Toolchain ", "true"]) {
    assert.equal(
      guards.filter((expr) => evaluate(expr, { setup }) === true).length,
      0,
      `setup '${setup}' must not select a provisioning step`,
    );
  }

  const guard = stepByName(advisory, GUARD_STEP);
  assert.match(guard, /toolchain\|node\)/, "the guard must accept exactly the two known values");
  assert.match(guard, /::error::/, "the guard must fail loudly, not warn");
  assert.match(guard, /exit 1/, "the guard must fail the job");
});

test("the guard runs before either provisioning step", () => {
  // A guard that ran after the branches would report the typo only once the
  // damage — a scan on ambient Node — had already been done.
  const order = [GUARD_STEP, TOOLCHAIN_STEP, NODE_STEP].map((name) =>
    advisory.indexOf(`- name: ${name}`),
  );
  assert.ok(order.every((i) => i !== -1), "every named step must exist");
  assert.ok(order[0] < order[1] && order[0] < order[2], "the guard must come first");
});

// ---------------------------------------------------------------------------
// AC-6 — the dogfood caller is on the new path.
// ---------------------------------------------------------------------------

test("the scheduled dogfood caller passes setup: node", () => {
  // This repo commits package-lock.json and has no pnpm-lock.yaml, so the
  // pnpm default cannot survive its own setup step here.
  assert.match(schedule, /^\s*setup:\s*node\s*$/m, `${SCHEDULE} must pass setup: node`);
});

test("this repo really is the npm case the caller claims", () => {
  // The assertion above is only correct while the premise holds. If this repo
  // ever adopts pnpm, this test fails and the caller gets revisited — rather
  // than silently keeping an install-free path it no longer needs.
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(pkg, "package.json must parse");
  assert.doesNotThrow(
    () => readFileSync("package-lock.json", "utf8"),
    "package-lock.json must exist for the npm premise to hold",
  );
  assert.throws(
    () => readFileSync("pnpm-lock.yaml", "utf8"),
    "a pnpm-lock.yaml would mean setup: node is no longer the right call here",
  );
});

// ---------------------------------------------------------------------------
// AC-8 / AC-9 — the documented contract.
// ---------------------------------------------------------------------------

test("the advisory-scan Inputs table documents the `setup` input", () => {
  // The table is the consumer-facing contract; an input absent from it is one
  // no consumer can be expected to find.
  const docs = readFileSync(DOCS, "utf8");
  const rows = docs.split("\n").filter((l) => /^\|\s*`setup`\s*\|\s*string\s*\|/.test(l));
  assert.equal(rows.length, 1, "expected exactly one documented `setup` row");
  assert.match(rows[0], /`'toolchain'`/, "row does not state the 'toolchain' default");
  assert.match(rows[0], /\.nvmrc/, "row does not state the node path's .nvmrc requirement");
});

test("the Tech Stack row names this repo's real package manager", () => {
  // The row claiming pnpm is what made the pnpm-only setup look correct when
  // advisory-scan.yml was pointed at this repo.
  const arch = readFileSync(ARCHITECTURE, "utf8");
  const rows = arch.split("\n").filter((l) => /^\|\s*Package manager\s*\|/.test(l));
  assert.equal(rows.length, 1, "expected exactly one Package manager row");
  assert.match(rows[0], /npm/, "row must name npm");
  assert.match(rows[0], /package-lock\.json/, "row must name the committed lockfile");
});
