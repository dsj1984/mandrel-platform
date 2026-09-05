#!/usr/bin/env node
/**
 * actions-expression.test.mjs — the evaluator must be trustworthy before it
 * can judge a workflow (Story #421).
 *
 * These assertions are the reason the evaluator exists: every one of them is a
 * place where Actions semantics diverge from JavaScript's, and where a
 * hand-read of an expression gets the wrong answer.
 *
 * Run: node --test scripts/lib/actions-expression.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, truthy } from "./actions-expression.mjs";

test("`&&` and `||` yield OPERANDS, not booleans", () => {
  assert.equal(evaluate("true && 'kept'", {}), "kept");
  assert.equal(evaluate("'' || 'fallback'", {}), "fallback");
  assert.equal(evaluate("'a' || 'b'", {}), "a");
});

test("every non-empty string is truthy — including the string 'false'", () => {
  // The trap the toolchain-cache expression depends on: an explicitly-pinned
  // 'false' must survive the first arm of the ternary rather than falling
  // through to the derivation.
  assert.equal(evaluate("'false' && 'yes' || 'no'", {}), "yes");
  assert.equal(truthy("false"), true);
  assert.equal(truthy(""), false);
});

test("arrays are truthy — the property the runs-on normalization rests on", () => {
  // GitHub documents the falsy set as exactly false, 0, -0, '', null. An array
  // is not in it, so a parsed label array carries through `&&` / `||`.
  assert.equal(truthy([]), true);
  assert.equal(truthy(["self-hosted"]), true);
});

test("comparison is case-insensitive", () => {
  assert.equal(evaluate("'AUTO' == 'auto'", {}), true);
  assert.equal(evaluate("'AUTO' != 'auto'", {}), false);
});

test("contains() is substring on a string and exact-item on an array", () => {
  assert.equal(evaluate("contains('[\"self-hosted\",\"x\"]', 'self-hosted')", {}), true);
  assert.equal(evaluate("contains(inputs.r, 'self-hosted')", { r: ["self-hosted", "x"] }), true);
  // Exact-item, NOT substring, once the haystack is an array.
  assert.equal(evaluate("contains(inputs.r, 'self')", { r: ["self-hosted"] }), false);
});

test("startsWith() casts to string and is case-insensitive", () => {
  assert.equal(evaluate("startsWith('[\"a\"]', '[')", {}), true);
  assert.equal(evaluate("startsWith('ubuntu-latest', '[')", {}), false);
  assert.equal(evaluate("startsWith('UBUNTU', 'ub')", {}), true);
});

test("format() substitutes positionally and unescapes doubled braces", () => {
  assert.equal(evaluate("format('\"{0}\"', inputs.r)", { r: "my-runner" }), '"my-runner"');
  assert.equal(evaluate("format('{{{0}}}', inputs.r)", { r: "x" }), "{x}");
});

test("fromJSON() parses arrays and scalars", () => {
  assert.deepEqual(evaluate("fromJSON('[\"self-hosted\",\"x\"]')", {}), ["self-hosted", "x"]);
  assert.equal(evaluate("fromJSON('\"bare-label\"')", {}), "bare-label");
});

test("fromJSON() on malformed input THROWS — it does not yield null", () => {
  // Load-bearing: in Actions a fromJSON parse failure fails the run. If it
  // degraded to null here, a malformed `runner` would look like a clean
  // fallback in the guard while hanging forever in production.
  assert.throws(() => evaluate("fromJSON('[\"unterminated')", {}), /could not parse/);
});

test("`&&` / `||` short-circuit, so an unreached branch is never evaluated", () => {
  // The evaluator is lazy. Guarded workflow expressions must NOT rely on that
  // (GitHub does not document its own behaviour here) — but modelling it
  // faithfully keeps the guard honest about what it is asserting.
  assert.equal(evaluate("false && fromJSON('nonsense') || 'safe'", {}), "safe");
});

test("an unknown input read is an error, not a silent undefined", () => {
  assert.throws(() => evaluate("inputs.missing", {}), /not provided by the caller/);
});
