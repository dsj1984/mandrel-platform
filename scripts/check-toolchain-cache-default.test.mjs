#!/usr/bin/env node
/**
 * check-toolchain-cache-default.test.mjs — regression guard for the derived
 * `toolchain-cache` default (Story #364).
 *
 * The bug this pins: `toolchain-cache` defaulted to `'true'`, which is only
 * correct for a GitHub-hosted caller. On a self-hosted runner with a warm pnpm
 * store the cache adds a POST-JOB save — a step that runs after every work step
 * has already reported success, billed against the same `timeout-minutes` those
 * steps spent. A slow save exhausts the ceiling, GitHub kills the job, and the
 * kill is recorded as `cancelled` rather than `failure`, which `ci-required`
 * maps to a red gate with every step green.
 *
 * The fix cannot live in the input's `default:` — a `workflow_call` default may
 * not hold a `${{ }}` expression (check-workflow-portability.mjs Rule 2), and
 * GitHub resolves defaults during interface validation, before `inputs.runner`
 * exists. So the default is the LITERAL `'auto'` and the derivation happens at
 * the use site.
 *
 * Asserting that by string-matching the expression would pin the spelling, not
 * the behaviour: the failure mode here is a subtly wrong ternary that still
 * looks right (Actions `&&`/`||` return OPERANDS, not booleans, and every
 * non-empty string — including `'false'` — is truthy). So this extracts the real
 * expression from each workflow and EVALUATES it under GitHub's own truthiness
 * rules, the same read-then-execute approach as
 * check-setup-toolchain-store.test.mjs.
 *
 * Run: node --test scripts/check-toolchain-cache-default.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const QUALITY = ".github/workflows/pr-quality.yml";
const ADVISORY = ".github/workflows/advisory-scan.yml";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** The `${{ … }}` body of the `cache:` value passed to setup-toolchain. */
function cacheExpression(text, file) {
  const m = text.match(/^\s*cache:\s*\$\{\{(.+)\}\}\s*$/m);
  assert.ok(m, `${file}: no \`cache: \${{ … }}\` value found at the setup-toolchain call site`);
  return m[1].trim();
}

/** The literal `default:` of the named workflow_call input. */
function inputDefault(text, name, file) {
  const re = new RegExp(`^ {6}${name}:\\n([\\s\\S]*?)(?=^ {6}\\S|^ {4}\\S|^\\S)`, "m");
  const block = text.match(re);
  assert.ok(block, `${file}: workflow_call input \`${name}\` not found`);
  const d = block[1].match(/^\s*default:\s*(.+)$/m);
  assert.ok(d, `${file}: input \`${name}\` has no default`);
  return d[1].trim();
}

// ---------------------------------------------------------------------------
// A minimal GitHub Actions expression evaluator
//
// Only the surface this expression uses: string literals, `inputs.<name>` /
// `inputs['<name>']` context reads, `==`/`!=`, `&&`/`||`, parentheses, and
// `contains()`. The semantics that matter and that a hand-read gets wrong:
//
//   - `a && b` yields `b` when `a` is truthy, else `a`.
//   - `a || b` yields `a` when `a` is truthy, else `b`.
//   - EVERY non-empty string is truthy — including the string `'false'`.
//   - String comparison is case-insensitive.
// ---------------------------------------------------------------------------

function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  return v !== null && v !== undefined;
}

function looseEqual(a, b) {
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function evaluate(expr, inputs) {
  let i = 0;

  const ws = () => {
    while (i < expr.length && /\s/.test(expr[i])) i++;
  };
  const eat = (token) => {
    ws();
    if (expr.startsWith(token, i)) {
      i += token.length;
      return true;
    }
    return false;
  };

  function parseOr() {
    let left = parseAnd();
    for (;;) {
      ws();
      if (!eat("||")) return left;
      const right = parseAnd();
      left = truthy(left) ? left : right;
    }
  }

  function parseAnd() {
    let left = parseCompare();
    for (;;) {
      ws();
      if (!eat("&&")) return left;
      const right = parseCompare();
      left = truthy(left) ? right : left;
    }
  }

  function parseCompare() {
    const left = parsePrimary();
    ws();
    if (eat("!=")) return !looseEqual(left, parsePrimary());
    if (eat("==")) return looseEqual(left, parsePrimary());
    return left;
  }

  function parsePrimary() {
    ws();
    if (eat("(")) {
      const v = parseOr();
      ws();
      assert.ok(eat(")"), `unbalanced parenthesis at ${i} in: ${expr}`);
      return v;
    }
    if (expr[i] === "'") {
      i++;
      let out = "";
      while (i < expr.length) {
        if (expr[i] === "'" && expr[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        if (expr[i] === "'") {
          i++;
          return out;
        }
        out += expr[i++];
      }
      assert.fail(`unterminated string literal in: ${expr}`);
    }
    if (expr.startsWith("contains(", i)) {
      i += "contains(".length;
      const hay = parseOr();
      ws();
      assert.ok(eat(","), `contains() expects two arguments in: ${expr}`);
      const needle = parseOr();
      ws();
      assert.ok(eat(")"), `unclosed contains() in: ${expr}`);
      return String(hay).toLowerCase().includes(String(needle).toLowerCase());
    }
    const ident = expr.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.\-]*(\['[^']*'\])?/);
    assert.ok(ident, `unparseable token at ${i} in: ${expr}`);
    i += ident[0].length;
    const raw = ident[0];
    if (raw === "true") return true;
    if (raw === "false") return false;
    const bracket = raw.match(/^inputs\['([^']*)'\]$/);
    const dotted = raw.match(/^inputs\.(.+)$/);
    const key = bracket ? bracket[1] : dotted ? dotted[1] : null;
    assert.ok(key !== null, `unsupported context read \`${raw}\` in: ${expr}`);
    assert.ok(key in inputs, `expression reads \`inputs.${key}\`, not provided by the test case`);
    return inputs[key];
  }

  const value = parseOr();
  ws();
  assert.equal(i, expr.length, `trailing tokens at ${i} in: ${expr}`);
  return value;
}

// ---------------------------------------------------------------------------
// The evaluator itself must be trustworthy before it can judge the workflow.
// ---------------------------------------------------------------------------

test("the expression evaluator models Actions truthiness, not JavaScript's", () => {
  // The trap the real expression depends on: the STRING 'false' is truthy, so
  // an explicitly-pinned 'false' survives the first arm of the ternary.
  assert.equal(evaluate("'false' && 'yes' || 'no'", {}), "yes");
  // `&&`/`||` yield operands, not booleans.
  assert.equal(evaluate("true && 'kept'", {}), "kept");
  assert.equal(evaluate("'' || 'fallback'", {}), "fallback");
  // Comparison is case-insensitive.
  assert.equal(evaluate("'AUTO' == 'auto'", {}), true);
  assert.equal(evaluate("contains('[\"self-hosted\",\"x\"]', 'self-hosted')", {}), true);
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

const workflows = [
  { file: QUALITY, text: readFileSync(QUALITY, "utf8") },
  { file: ADVISORY, text: readFileSync(ADVISORY, "utf8") },
];

for (const { file, text } of workflows) {
  test(`${file}: the toolchain-cache default is a literal 'auto', not an expression`, () => {
    // AC-1. An expression here is what the portability lint (Rule 2) rejects
    // and what GitHub silently fails to evaluate at interface-validation time.
    const value = inputDefault(text, "toolchain-cache", file);
    assert.equal(value, "'auto'");
    assert.doesNotMatch(value, /\$\{\{/, "a workflow_call default may not hold an expression");
  });

  test(`${file}: an unset toolchain-cache disables caching on a self-hosted runner`, () => {
    // AC-2 — the whole point: no post-job store save, so no teardown eating the
    // job's timeout and reporting as `cancelled` with every step green.
    const expr = cacheExpression(text, file);
    for (const runner of ["self-hosted", '["self-hosted","domio-runner"]', '["self-hosted"]']) {
      assert.equal(
        evaluate(expr, { "toolchain-cache": "auto", runner }),
        "false",
        `runner ${runner}`,
      );
    }
  });

  test(`${file}: an unset toolchain-cache keeps caching on for a hosted runner`, () => {
    // AC-3 — hosted behaviour must not move. Detection is self-hosted-side
    // precisely so a larger-runner custom label is not mistaken for one.
    const expr = cacheExpression(text, file);
    for (const runner of [
      "ubuntu-latest",
      "ubuntu-24.04",
      "macos-14",
      "windows-latest",
      "ubuntu-latest-8-cores",
      '["ubuntu-latest"]',
    ]) {
      assert.equal(evaluate(expr, { "toolchain-cache": "auto", runner }), "true", `runner ${runner}`);
    }
  });

  test(`${file}: an explicit toolchain-cache is passed through on either runner class`, () => {
    // AC-4. 'false' is the one that breaks under a naive ternary — it is a
    // non-empty string and therefore truthy, which is what makes it survive.
    const expr = cacheExpression(text, file);
    for (const runner of ["ubuntu-latest", '["self-hosted","domio-runner"]']) {
      for (const pinned of ["true", "false"]) {
        assert.equal(
          evaluate(expr, { "toolchain-cache": pinned, runner }),
          pinned,
          `${pinned} on ${runner}`,
        );
      }
    }
  });
}

test("both workflows derive the default identically", () => {
  // AC-5. Two documented rows describing one behaviour must not drift apart —
  // the reason this Story moves both workflows rather than only the quality one.
  const [quality, advisory] = workflows.map(({ file, text }) => cacheExpression(text, file));
  assert.equal(advisory, quality);
});

test("pr-quality resolves the default at the shared setup-toolchain anchor", () => {
  // One anchor, aliased by every other tier: deriving it once must reach them
  // all, or a tier silently keeps the old always-on default.
  const text = readFileSync(QUALITY, "utf8");
  assert.match(text, /^ {6}- &setup-toolchain$/m, "the setup-toolchain anchor is missing");
  const aliases = text.match(/^ {6}- \*setup-toolchain$/gm) ?? [];
  assert.ok(aliases.length > 0, "expected the setup-toolchain anchor to be aliased");
  assert.equal(
    (text.match(/^\s*cache:\s*\$\{\{/gm) ?? []).length,
    1,
    "expected exactly one cache: call site — a second one would bypass the anchor",
  );
});

test("both documented input rows state the derived default and the self-hosted reason", () => {
  // AC-6. The rows are the consumer-facing contract; a fix documented in only
  // one of the two tables leaves them contradicting each other.
  const docs = readFileSync("docs/reusable-workflows.md", "utf8");
  // Scoped to the two `Inputs` tables (`| name | type | default | …`) so the
  // explainer section's own table is not counted as a third row.
  const rows = docs.split("\n").filter((l) => /^\|\s*`toolchain-cache`\s*\|\s*string\s*\|/.test(l));
  assert.equal(rows.length, 2, "expected one documented row per workflow");
  for (const row of rows) {
    assert.match(row, /`'auto'`/, "row does not state the 'auto' default");
    assert.match(row, /self-hosted/i, "row does not explain the self-hosted derivation");
    assert.doesNotMatch(row, /\|\s*`'true'`\s*\|/, "row still documents the old 'true' default");
  }
});
