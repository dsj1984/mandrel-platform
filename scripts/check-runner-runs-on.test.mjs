#!/usr/bin/env node
/**
 * check-runner-runs-on.test.mjs — regression guard for every shape the
 * `runner` input can arrive in (Stories #421, #493).
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
 * The same failure had a second door, closed by #493: `runner: ''`. A
 * workflow_call `default:` fires only when the key is ABSENT, so a caller
 * who passes the key with an empty value — threading an unset input or a
 * matrix value through — got the label `""` rather than `ubuntu-latest`, and
 * with it the identical never-scheduled job. The fallback therefore lives at
 * the `runs-on` site, and the byte-identical assertion below is what stops a
 * fix that reaches six of the seven workflows from shipping as if it reached
 * all seven.
 *
 * Story #493 also left a downstream door open, closed here: `runs-on` was not
 * the only site reading `inputs.runner`. `pr-quality.yml`'s harden-runner
 * egress-audit step gates on `startsWith(inputs.runner, 'ubuntu-')`, which was
 * unreachable-but-consistent while `runner: ''` never scheduled a job. Once the
 * empty value resolved to the hosted default, the job ran on ubuntu-latest
 * while the gate read the raw `''` and skipped — a SECURITY step opting itself
 * out with nothing red to show for it. So the gate is asserted the same way:
 * extracted and EVALUATED, and required to AGREE with what `runs-on` resolves
 * to for the same input.
 *
 * Run: node --test scripts/check-runner-runs-on.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { evaluate } from "./lib/actions-expression.mjs";
import { stepByName } from "./lib/yaml-step.mjs";

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

/**
 * The `default:` this workflow declares for its `runner` workflow_call input.
 *
 * Read from the YAML rather than hardcoded so the empty-input assertion below
 * pins the real contract: whatever label a caller gets by omitting `runner`
 * is the label an explicitly-empty `runner` must get too. Scanned line by
 * line — the block boundary is indentation, and a dynamically-constructed
 * regex is a SAST finding that buys nothing here.
 */
function declaredRunnerDefault(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("      runner:");
  assert.notEqual(start, -1, "no `runner:` workflow_call input found");
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== "" && !line.startsWith("        ")) break;
    const m = line.match(/^\s+default:\s*'([^']*)'\s*$/);
    if (m) return m[1];
  }
  return assert.fail("the `runner` input declares no `default:` to fall back to");
}

const WORKFLOWS = runnerWorkflows();

test("every workflow taking a `runner` input is covered by this guard", () => {
  // A new reusable workflow with a `runner` input must not slip past unseen.
  const names = WORKFLOWS.map(({ file }) => file.split("/").pop()).sort();
  assert.deepEqual(names, [
    "advisory-scan.yml",
    "deploy-cloudflare.yml",
    "env-drift.yml",
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

  test(`${file}: an empty runner resolves to this workflow's documented default`, () => {
    // The silent-queue shape #421 left behind. `runner: ''` is not exotic — a
    // caller threading `runner: ${{ inputs.runner }}` or a matrix value that
    // resolves to nothing passes it without meaning to, and `format('"{0}"',
    // '')` yielded the label `""`. An empty label matches no runner, so the
    // job sat `queued` with no logs and no red, exactly as the JSON-array
    // string did. The fallback belongs at the `runs-on` site because the
    // input `default:` only fires when the key is ABSENT, never when it is
    // present and empty.
    const fallback = declaredRunnerDefault(text);
    assert.notEqual(fallback, "", `${file}: the declared default is itself empty`);
    for (const { line, expr } of sites) {
      const resolved = evaluate(expr, { runner: "" });
      assert.equal(
        typeof resolved,
        "string",
        `${file}:${line}: an empty runner must resolve to a single label, not ${JSON.stringify(resolved)}`,
      );
      assert.notEqual(
        resolved,
        "",
        `${file}:${line}: an empty runner resolves to an empty label — no runner ` +
          `carries it, so the job queues until the 24-hour timeout with nothing to read`,
      );
      assert.equal(
        resolved,
        fallback,
        `${file}:${line}: an empty runner must land on the input's documented default`,
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


test("every runs-on expression across the seven workflows is byte-identical", () => {
  // The per-workflow tests above each score one file, so a fix applied to six
  // of the seven passes every one of them and ships the seventh still broken.
  // This is the assertion a partial edit cannot survive: one decision, spelled
  // one way, everywhere it is made.
  const distinct = new Map();
  for (const { file, text } of WORKFLOWS) {
    for (const { line, expr } of runsOnExpressions(text)) {
      if (!distinct.has(expr)) distinct.set(expr, []);
      distinct.get(expr).push(`${file}:${line}`);
    }
  }
  const report = [...distinct.entries()]
    .map(([expr, at]) => `${expr}  @ ${at.join(", ")}`)
    .join("\n  ");
  assert.equal(distinct.size, 1, `runs-on expressions have drifted apart:\n  ${report}`);
});

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

// ---------------------------------------------------------------------------
// The harden-runner egress-audit gate (`pr-quality.yml`)
//
// `runs-on` was not the only expression reading `inputs.runner`. Anything that
// branches on the runner class has to resolve the input the SAME way, or the
// job and the step disagree about which machine they are on. This section
// pins that agreement behaviourally — extract the real `if:` and run it.
// ---------------------------------------------------------------------------

/**
 * The `${{ … }}` body of the harden-runner step's `if:` gate.
 *
 * Keyed off the step, not off a line pattern that happens to contain
 * `startsWith` — the point is to score whatever expression actually guards
 * that step, including one a future edit spells differently.
 */
function hardenRunnerGate(text) {
  const block = stepByName(text, "Harden runner (egress audit)");
  assert.match(
    block,
    /uses: step-security\/harden-runner@/,
    "the extracted block is not the harden-runner step",
  );
  const m = block.match(/^\s*if:\s*\$\{\{(.+)\}\}\s*$/m);
  assert.ok(m, "the harden-runner step has no single-expression `if:` gate to score");
  return m[1].trim();
}

/**
 * What `runs-on` resolves to for `runner`, as a hosted-ubuntu predicate.
 *
 * A single string label starting with `ubuntu-` is a GitHub-hosted ubuntu
 * image — the one environment where harden-runner installs its own monitor.
 * An ARRAY (the documented self-hosted form) is not, regardless of the labels
 * inside it: harden-runner ships its agent in a self-hosted runner image, so
 * the step is correctly a no-op there.
 */
function resolvesToHostedUbuntu(runsOnExpr, runner) {
  const resolved = evaluate(runsOnExpr, { runner });
  return typeof resolved === "string" && resolved.startsWith("ubuntu-");
}

const QUALITY_FILE = `${WORKFLOW_DIR}/pr-quality.yml`;
const QUALITY_TEXT = readFileSync(QUALITY_FILE, "utf8");

test("pr-quality.yml: the harden-runner gate reaches every tier through one anchor", () => {
  // The gate is written once (`&harden-runner`) and aliased into the other
  // tiers. A second literal copy could carry a stale expression that every
  // behavioural assertion below would miss, because they score the anchor.
  assert.match(QUALITY_TEXT, /^ {6}- &harden-runner$/m, "the harden-runner anchor is missing");
  assert.ok(
    (QUALITY_TEXT.match(/^ {6}- \*harden-runner$/gm) ?? []).length > 0,
    "expected the harden-runner anchor to be aliased into the other tiers",
  );
  assert.equal(
    (QUALITY_TEXT.match(/uses: step-security\/harden-runner@/g) ?? []).length,
    1,
    "expected exactly one harden-runner step — a second one would bypass the anchor",
  );
});

test("pr-quality.yml: an empty runner keeps the egress audit ON", () => {
  // The regression. `runner: ''` resolves to the hosted ubuntu-latest default
  // at `runs-on` (#493), so the job DOES run on a GitHub-hosted machine — but
  // a gate reading the raw input saw `startsWith('', 'ubuntu-')` → false and
  // skipped. Nothing goes red when a step is skipped, so the egress baseline
  // silently disappears for exactly the callers who never asked to opt out.
  const gate = hardenRunnerGate(QUALITY_TEXT);
  assert.equal(
    evaluate(gate, { runner: "", "enable-harden-runner": true }),
    true,
    "an empty runner lands on hosted ubuntu-latest, so the egress audit must run there",
  );
});

test("pr-quality.yml: the gate agrees with what runs-on resolves to", () => {
  // The real contract, and the one that survives a respelling of either
  // expression: the step runs precisely when the job is on a hosted ubuntu
  // image. Scoring both sides against the same input is what makes a future
  // change to one of them fail here instead of shipping a silent divergence.
  const gate = hardenRunnerGate(QUALITY_TEXT);
  const [runsOn] = runsOnExpressions(QUALITY_TEXT);
  for (const runner of [
    "",
    "ubuntu-latest",
    "ubuntu-24.04",
    "ubuntu-22.04",
    "ubuntu-latest-8-cores",
    "macos-14",
    "windows-latest",
    '["self-hosted","beestera-runner"]',
    '["ubuntu-latest"]',
  ]) {
    assert.equal(
      evaluate(gate, { runner, "enable-harden-runner": true }),
      resolvesToHostedUbuntu(runsOn.expr, runner),
      `runner ${JSON.stringify(runner)}: the gate and the resolved runs-on disagree ` +
        `about whether this job is on a GitHub-hosted ubuntu image`,
    );
  }
});

test("pr-quality.yml: `enable-harden-runner: false` still opts out everywhere", () => {
  // The documented escape hatch. A fallback added to the runner half of the
  // gate must not make the boolean half unreachable — `false && …` yields
  // `false`, but only if the operands stayed in that order.
  const gate = hardenRunnerGate(QUALITY_TEXT);
  for (const runner of ["", "ubuntu-latest", "ubuntu-24.04", '["self-hosted","x"]']) {
    assert.equal(
      evaluate(gate, { runner, "enable-harden-runner": false }),
      false,
      `runner ${JSON.stringify(runner)}: opting out must win regardless of the runner`,
    );
  }
});

test("pr-quality.yml: the toolchain-cache derivation reads an empty runner as hosted", () => {
  // The sibling `inputs.runner` reader, checked rather than assumed. It is
  // correct as written for `runner: ''` — but only incidentally, because
  // `contains('', 'self-hosted')` is false and the derivation is
  // self-hosted-side. Pinning it here means a future inversion to a
  // hosted-side test (`contains(runner, 'ubuntu')`) trips instead of quietly
  // disabling the cache for every empty-runner caller.
  const cache = QUALITY_TEXT.match(/^\s*cache:\s*\$\{\{(.+)\}\}\s*$/m);
  assert.ok(cache, "no `cache: ${{ … }}` value found at the setup-toolchain call site");
  assert.equal(evaluate(cache[1].trim(), { runner: "", "toolchain-cache": "auto" }), "true");
});
