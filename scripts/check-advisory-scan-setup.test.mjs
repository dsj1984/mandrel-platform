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
 * The install-free assertion is JOB-wide (Story #494). It used to slice the
 * "Setup Node.js (install-free)" step alone, which proves nothing: the step
 * that provisions Node was never the one likely to grow an install. What the
 * path promises is that NOTHING in the job installs when `setup: node` is
 * selected, so the check enumerates every step of the job, keeps the ones
 * whose `if:` guard actually selects them under that input, and asserts the
 * absence across the set.
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

/** Strip a `${{ … }}` wrapper, leaving the bare Actions expression. */
function bareExpression(raw) {
  return raw.trim().replace(/^\$\{\{/, "").replace(/\}\}$/, "").trim();
}

/** The `${{ … }}`-free body of a step's `if:` condition. */
function ifExpression(step, name) {
  const m = step.match(/^\s*if:\s*(.+)$/m);
  assert.ok(m, `step "${name}" has no \`if:\` guard`);
  return bareExpression(m[1]);
}

/**
 * The line span of one top-level job — from its `  <id>:` header to the next
 * key at that indent, trailing blank lines excluded. A plain line comparison
 * rather than a regex built around `job`: a dynamically-constructed RegExp is
 * a SAST finding, and a job header is an exact line anyway.
 */
function jobRange(text, job) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === `  ${job}:`);
  assert.notEqual(start, -1, `${ADVISORY}: job '${job}' not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return { lines, start, end };
}

/**
 * Every step of a job, in order, as its own block of text. Steps are split on
 * the `- ` bullets under `steps:` at the bullet's own indent, so a nested
 * `with:` / `env:` mapping stays with the step that owns it.
 */
function jobSteps(text, job) {
  const { lines, start, end } = jobRange(text, job);
  const body = lines.slice(start + 1, end);
  const stepsIdx = body.findIndex((l) => l.trim() === "steps:");
  assert.notEqual(stepsIdx, -1, `${ADVISORY}: job '${job}' declares no \`steps:\``);
  const rest = body.slice(stepsIdx + 1);
  const first = rest.findIndex((l) => /^\s*-\s/.test(l));
  assert.notEqual(first, -1, `${ADVISORY}: job '${job}' declares no steps`);
  const indent = rest[first].match(/^(\s*)/)[1].length;
  const steps = [];
  for (const line of rest.slice(first)) {
    const bullet = /^\s*-\s/.test(line) && line.match(/^(\s*)/)[1].length === indent;
    if (bullet) steps.push([]);
    steps[steps.length - 1].push(line);
  }
  return steps.map((step) => step.join("\n"));
}

/** A step's `name:`, else its opening line — for a readable failure message. */
function stepLabel(step) {
  const m = step.match(/^\s*(?:-\s*)?name:\s*(.+)$/m);
  return m ? m[1].trim() : step.split("\n")[0].trim();
}

/** Whether a step is selected for the run under the given `inputs` context. */
function runsWhen(step, inputs) {
  const m = step.match(/^\s*if:\s*(.+)$/m);
  if (!m) return true;
  try {
    return evaluate(bareExpression(m[1]), inputs) === true;
  } catch {
    // A guard this evaluator cannot run counts as SELECTED. Fail closed: an
    // expression nobody can evaluate must never be the reason an install slips
    // past the check below — at worst it costs a loud failure a human reads.
    return true;
  }
}

// Install commands, matched against the step's YAML with comment-only lines
// removed: the job's comments discuss `pnpm install` at length, and prose is
// not a command. Literal patterns, never a built RegExp.
const INSTALL_COMMANDS = [
  { label: "pnpm install", pattern: /\bpnpm install\b/ },
  { label: "npm ci", pattern: /\bnpm ci\b/ },
  { label: "npm install", pattern: /\bnpm install\b/ },
  { label: "yarn install", pattern: /\byarn install\b/ },
];

/** Every step selected by `setup` that runs an install, with what it runs. */
function installingSteps(text, setup) {
  return jobSteps(text, JOB)
    .filter((step) => runsWhen(step, { setup }))
    .map((step) => ({
      step: stepLabel(step),
      commands: INSTALL_COMMANDS.filter(({ pattern }) =>
        pattern.test(
          step
            .split("\n")
            .filter((l) => !l.trim().startsWith("#"))
            .join("\n"),
        ),
      ).map(({ label }) => label),
    }))
    .filter(({ commands }) => commands.length > 0);
}

/** `text` with one extra step spliced in after the job's last existing step. */
function withStepAppended(text, job, step) {
  const { lines, end } = jobRange(text, job);
  return [...lines.slice(0, end), ...step.split("\n"), ...lines.slice(end)].join("\n");
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

const JOB = "advisory-scan";
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

// ---------------------------------------------------------------------------
// Story #494 — "install-free" is a property of the JOB, not of one step.
// ---------------------------------------------------------------------------

test("no dependency install runs ANYWHERE in the job on the install-free path", () => {
  // The whole point of the path: osv-scanner reads lockfiles off disk, and both
  // composites' gate scripts import only node builtins and relative siblings.
  // So nothing in the job needs a dependency tree — and the step that
  // provisions Node was never the step likely to grow an install anyway.
  assert.deepEqual(
    installingSteps(advisory, "node"),
    [],
    "a step selected by `setup: node` installs dependencies",
  );
});

test("the check is job-wide: an install appended after the last step is caught", () => {
  // The mutation the step-scoped version missed — it sliced the install-free
  // step alone, so this fixture passed while the path's one promise was broken.
  const mutated = withStepAppended(
    advisory,
    JOB,
    ["      - name: Restore dependencies", "        run: npm ci"].join("\n"),
  );
  assert.deepEqual(installingSteps(mutated, "node"), [
    { step: "Restore dependencies", commands: ["npm ci"] },
  ]);
});

test("an install guarded onto the toolchain path is not charged to the node path", () => {
  // The other half of the mutation, and the proof that the `if:` guards are
  // still EVALUATED here rather than grepped: the same appended step is
  // invisible under `setup: node` and visible under `setup: toolchain`. Drop
  // the evaluation and this check either flags every guarded install or, if it
  // ignored guards entirely, would have to ignore unguarded ones too.
  const mutated = withStepAppended(
    advisory,
    JOB,
    [
      "      - name: Restore pnpm dependencies",
      "        if: inputs.setup == 'toolchain'",
      "        run: pnpm install --frozen-lockfile",
    ].join("\n"),
  );
  assert.deepEqual(installingSteps(mutated, "node"), []);
  assert.deepEqual(installingSteps(mutated, "toolchain"), [
    { step: "Restore pnpm dependencies", commands: ["pnpm install"] },
  ]);
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
// Story #494 — the copy-paste path documents the input that decides the job.
// ---------------------------------------------------------------------------

test("the header's consumer snippet shows `setup:` and names both accepted values", () => {
  // The snippet is what a consumer copies; an input missing from it is one they
  // never learn they had. `setup` is the input whose wrong value kills the job
  // at setup-node before the scan runs — the seven silent weeks above — so the
  // copy path has to carry it, and has to name the other value it accepts.
  const header = advisory.split("\nname:")[0];
  const snippet = header.split("\n").filter((l) => l.startsWith("#"));
  const withIdx = snippet.findIndex((l) => /^#\s+with:\s*$/.test(l));
  assert.notEqual(withIdx, -1, `${ADVISORY}: the consumer snippet has no \`with:\` block`);
  const withBlock = snippet.slice(withIdx).join("\n");
  assert.match(
    withBlock,
    /^#\s+setup:\s*(toolchain|node)\s*$/m,
    "the consumer snippet must pass `setup:`",
  );
  for (const value of ["toolchain", "node"]) {
    assert.ok(
      withBlock.includes(value),
      `the consumer snippet must name the accepted value '${value}'`,
    );
  }
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
