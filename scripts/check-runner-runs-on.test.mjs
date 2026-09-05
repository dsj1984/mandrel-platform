#!/usr/bin/env node
/**
 * check-runner-runs-on.test.mjs — regression guard for the `runner` input's
 * two documented shapes (Story #421).
 *
 * The bug this pins: every `runs-on:` site consumed the input raw as
 * `${{ inputs.runner }}`. GitHub does not parse a JSON-array *string* in that
 * position — it takes the entire text as ONE label name. A caller passing the
 * documented `'["self-hosted","my-runner"]'` therefore targeted a label no
 * runner carries, and every tier sat `queued` until the 24-hour timeout.
 *
 * It was silent. Nothing went red, no job started, so there were no logs, and
 * `gh pr checks` reported `pending 0` — indistinguishable from a busy fleet.
 * The tell was that caller-owned jobs went green while every reusable-workflow
 * tier reported `pending 0`.
 *
 * Why this is not a grep. A `grep` cannot tell a resolvable `runs-on`
 * expression from an unresolvable one — that is precisely how this shipped,
 * past static checks that all passed. Asserting the expression's spelling
 * would pin the wording and not the behaviour. So this EXTRACTS each real
 * expression from the workflow and EVALUATES it under Actions semantics, the
 * same read-then-execute approach as check-toolchain-cache-default.test.mjs.
 *
 * Run: node --test scripts/check-runner-runs-on.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { evaluate } from "./lib/actions-expression.mjs";

const WORKFLOW_DIR = ".github/workflows";

/** Every workflow that declares a `runner` workflow_call input. */
function runnerWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ file: `${WORKFLOW_DIR}/${f}`, text: readFileSync(`${WORKFLOW_DIR}/${f}`, "utf8") }))
    .filter(({ text }) => /^\s{6}runner:$/m.test(text));
}

/**
 * The `${{ … }}` bodies of every `runs-on:` value that reads `inputs.runner`.
 * Scans lines rather than building a regex around the file — the block
 * boundary is a single line, and a dynamically-constructed regex is a SAST
 * finding that buys nothing here.
 */
function runsOnExpressions(text) {
  const out = [];
  for (const [idx, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("runs-on:")) continue;
    if (!trimmed.includes("inputs.runner")) continue;
    const m = trimmed.match(/^runs-on:\s*\$\{\{(.+)\}\}\s*$/);
    assert.ok(m, `line ${idx + 1}: runs-on reads inputs.runner but is not a single expression: ${trimmed}`);
    out.push({ line: idx + 1, expr: m[1].trim() });
  }
  return out;
}

const WORKFLOWS = runnerWorkflows();

test("every workflow taking a `runner` input is covered by this guard", () => {
  // A new reusable workflow with a `runner` input must not slip past unseen.
  const names = WORKFLOWS.map(({ file }) => file.split("/").pop()).sort();
  assert.deepEqual(names, [
    "advisory-scan.yml",
    "deploy-cloudflare.yml",
    "pr-quality.yml",
    "release-automation.yml",
    "secret-scan-push.yml",
    "uptime-apply.yml",
  ]);
});

test("no `runs-on:` consumes `inputs.runner` raw", () => {
  // The exact shape that shipped the bug. Kept as a cheap, legible tripwire
  // alongside the behavioural assertions below.
  for (const { file, text } of WORKFLOWS) {
    for (const { line, expr } of runsOnExpressions(text)) {
      assert.notEqual(
        expr,
        "inputs.runner",
        `${file}:${line}: \`runs-on\` consumes the input raw — a JSON-array ` +
          `string resolves to one unmatchable label name and the job queues forever`,
      );
    }
  }
});

for (const { file, text } of WORKFLOWS) {
  const sites = runsOnExpressions(text);

  test(`${file}: has at least one runner-driven runs-on site`, () => {
    assert.ok(sites.length > 0, "expected this workflow to drive runs-on from inputs.runner");
  });

  test(`${file}: a bare label resolves to that same string`, () => {
    for (const { line, expr } of sites) {
      assert.equal(evaluate(expr, { runner: "ubuntu-latest" }), "ubuntu-latest", `${file}:${line}`);
      assert.equal(evaluate(expr, { runner: "beestera-runner" }), "beestera-runner", `${file}:${line}`);
    }
  });

  test(`${file}: the documented JSON-array string resolves to a label ARRAY`, () => {
    for (const { line, expr } of sites) {
      assert.deepEqual(
        evaluate(expr, { runner: '["self-hosted","beestera-runner"]' }),
        ["self-hosted", "beestera-runner"],
        `${file}:${line}: the documented array form must yield real labels, ` +
          `not one label named after the whole JSON text`,
      );
    }
  });

  test(`${file}: a malformed array-shaped value fails loudly, not into the label branch`, () => {
    // A silent fallback to the raw string would rebuild the original failure
    // mode — an unmatchable label, queued until the 24-hour timeout — behind a
    // fix that claims to have removed it.
    for (const { line, expr } of sites) {
      assert.throws(
        () => evaluate(expr, { runner: '["unterminated' }),
        /could not parse/,
        `${file}:${line}: a '['-leading value that is not valid JSON must be a hard error`,
      );
    }
  });

  test(`${file}: every runs-on site resolves identically`, () => {
    // One workflow must not drift into two dialects of the same decision.
    const rendered = sites.map(({ expr }) =>
      JSON.stringify(evaluate(expr, { runner: '["self-hosted","x"]' })),
    );
    assert.equal(new Set(rendered).size, 1, `${file}: runs-on sites disagree: ${rendered.join(" | ")}`);
  });
}

test("the documented array form resolves AND derives toolchain-cache 'false'", () => {
  // The coupling the gap report found: before this fix the only `runner` value
  // that derived the correct cache posture was the one that never reached a
  // runner, and the only value that reached a runner derived the wrong posture.
  // A self-hosted caller could not get both right from the documented
  // interface. Assert the pairing is now reachable in a single value.
  const quality = readFileSync(`${WORKFLOW_DIR}/pr-quality.yml`, "utf8");
  const runner = '["self-hosted","beestera-runner"]';

  const [runsOn] = runsOnExpressions(quality);
  assert.deepEqual(evaluate(runsOn.expr, { runner }), ["self-hosted", "beestera-runner"]);

  const cache = quality.match(/^\s*cache:\s*\$\{\{(.+)\}\}\s*$/m);
  assert.ok(cache, "no `cache: ${{ … }}` value found at the setup-toolchain call site");
  assert.equal(evaluate(cache[1].trim(), { runner, "toolchain-cache": "auto" }), "false");
});
