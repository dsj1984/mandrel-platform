#!/usr/bin/env node
/**
 * check-checkout-clean-excludes.test.mjs — guard for the opt-in that lets a
 * caller keep chosen paths across `actions/checkout`'s clean (Story #525).
 *
 * WHAT THIS PINS
 * --------------
 * `actions/checkout` runs `git clean -ffdx && git reset --hard HEAD` before
 * fetching. On a persistent self-hosted fleet that deletes the `node_modules`
 * tree the install step immediately re-creates, once per tier job. The
 * `checkout-clean-excludes` input takes that clean off the action (`clean:
 * false`) and moves it onto a shared hygiene step that discards the same
 * content MINUS the caller's paths.
 *
 * Three ways that can be wrong, none of which a `grep` can see:
 *
 *   1. PARTIAL COVERAGE. `pr-quality.yml` checks the consumer repo out from
 *      one anchored step AND from three bespoke ones (migration-guard,
 *      security, osv-scan) that cannot alias the anchor because they need
 *      `fetch-depth: 0` and Actions has no merge keys. An opt-in wired into
 *      the anchor alone reads as done and still pays the full cost in three
 *      jobs. So this suite ENUMERATES every consumer-repo checkout in the file
 *      and requires each to carry the gate and the hygiene step — a new
 *      checkout added without them fails here rather than in a consumer's
 *      timing.
 *
 *   2. A GATE THAT DOES NOT MEAN WHAT IT READS. Asserting the spelling of a
 *      workflow expression pins the wording, not the behaviour. Every `clean:`
 *      gate below is EXTRACTED and EVALUATED under Actions semantics (the same
 *      read-then-execute approach as check-runner-runs-on.test.mjs), including
 *      the hygiene step's own `if:`, which must be the exact complement — if
 *      the two can disagree, a job either cleans twice or not at all.
 *
 *   3. A HYGIENE STEP THAT DOES NOT RESTORE THE GUARANTEE, or that lets the
 *      caller's string reach the shell as workflow text. The real `run:` body
 *      is extracted and EXECUTED here twice: once against a fixture git repo
 *      (does it preserve exactly what it was told to and nothing else?) and
 *      once against a stubbed `git` (does a pattern with a leading dash or a
 *      shell metacharacter arrive as one literal `-e` operand?).
 *
 * Run: node --test scripts/check-checkout-clean-excludes.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluate } from "./lib/actions-expression.mjs";
import { runScript } from "./lib/yaml-step.mjs";
import { parseWorkflow } from "./check-workflow-platform-checkout.mjs";

const WORKFLOW = ".github/workflows/pr-quality.yml";
const INPUT = "checkout-clean-excludes";
const HYGIENE_ANCHOR = "checkout-hygiene";
const PLATFORM_REPO = "dsj1984/mandrel-platform";

const SOURCE = readFileSync(WORKFLOW, "utf8");
const { anchors, jobs } = parseWorkflow(SOURCE);

/** Strip comment lines so prose can neither satisfy nor trip an assertion. */
function withoutComments(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** True for the shared hygiene step, whether aliased or at its anchor definition. */
function isHygieneStep(step) {
  if (!step) return false;
  if (step.aliasOf === HYGIENE_ANCHOR) return true;
  return /^\s*-\s+&checkout-hygiene\s*$/m.test(step.text);
}

/**
 * Every `actions/checkout` step in the file, split by what it checks out.
 * A platform side-checkout names `repository:`; everything else is the
 * consumer's own repo and is in scope for the opt-in.
 */
function checkoutSteps() {
  const consumer = [];
  const platform = [];
  for (const [jobKey, job] of jobs) {
    job.steps.forEach((step, idx) => {
      const body = withoutComments(step.text);
      if (!/uses:\s*actions\/checkout@/.test(body)) return;
      const site = { jobKey, job: jobKey.split("@")[0], line: step.line, body, next: job.steps[idx + 1] };
      if (body.includes(`repository: ${PLATFORM_REPO}`)) platform.push(site);
      else consumer.push(site);
    });
  }
  return { consumer, platform };
}

/** The `${{ … }}` body of a step's `clean:` value, or null. */
function cleanExpression(body) {
  const m = body.match(/^\s*clean:\s*\$\{\{(.+)\}\}\s*$/m);
  return m ? m[1].trim() : null;
}

const { consumer: CONSUMER_CHECKOUTS, platform: PLATFORM_CHECKOUTS } = checkoutSteps();
const HYGIENE_BLOCK = anchors.get(HYGIENE_ANCHOR) ?? "";
const HYGIENE_RUN = runScript(HYGIENE_BLOCK);

// ---------------------------------------------------------------------------
// AC-1 / AC-2 — the input, and the sites it reaches
// ---------------------------------------------------------------------------

test("the input is declared as an optional string defaulting to empty", () => {
  const lines = SOURCE.split("\n");
  const start = lines.indexOf(`      ${INPUT}:`);
  assert.notEqual(start, -1, `no \`${INPUT}:\` workflow_call input found`);
  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && !lines[i].startsWith("        ")) break;
    block.push(lines[i]);
  }
  const text = block.join("\n");
  assert.match(text, /^\s+type:\s*string\s*$/m, "must be declared `type: string`");
  assert.match(text, /^\s+required:\s*false\s*$/m, "must be optional — an existing caller passes nothing");
  assert.match(text, /^\s+default:\s*''\s*$/m, "default must be the empty string (today's behaviour)");
  // Rule 2 of check-workflow-portability: an expression in a workflow_call
  // description is evaluated during interface validation and fails the call.
  assert.ok(!text.includes("${{"), "description/default must be plain text");
});

test("every consumer-repo checkout in the workflow is covered by this guard", () => {
  // The coverage tripwire: a tier that grows its own consumer checkout has to
  // be seen here, because a missed job keeps paying the full clean silently.
  const sites = CONSUMER_CHECKOUTS.map((s) => s.job).sort();
  assert.deepEqual(sites, [
    "contract",
    "coverage-floor",
    "e2e",
    "lint",
    "migration-guard",
    "osv-scan",
    "security",
    "typecheck",
    "unit",
    "workflow-lint",
  ]);
});

test("a caller that sets nothing gets the full clean at every consumer checkout", () => {
  for (const site of CONSUMER_CHECKOUTS) {
    const expr = cleanExpression(site.body);
    assert.ok(
      expr,
      `${WORKFLOW}:${site.line} (${site.job}) — consumer checkout does not gate \`clean:\` on an expression`,
    );
    assert.ok(
      expr.includes(INPUT),
      `${WORKFLOW}:${site.line} (${site.job}) — \`clean:\` does not read \`${INPUT}\`: ${expr}`,
    );
    assert.equal(
      evaluate(expr, { [INPUT]: "" }),
      true,
      `${WORKFLOW}:${site.line} (${site.job}) — an empty input must still resolve to the full clean`,
    );
  }
});

test("a non-empty input hands the clean to the hygiene step at every consumer checkout", () => {
  for (const site of CONSUMER_CHECKOUTS) {
    const expr = cleanExpression(site.body);
    assert.equal(
      evaluate(expr, { [INPUT]: "node_modules" }),
      false,
      `${WORKFLOW}:${site.line} (${site.job}) — a non-empty input must take the clean off actions/checkout`,
    );
    assert.ok(
      isHygieneStep(site.next),
      `${WORKFLOW}:${site.line} (${site.job}) — consumer checkout is not immediately followed by ` +
        `\`*${HYGIENE_ANCHOR}\`, so with \`clean: false\` this job would keep the previous job's untracked tree`,
    );
  }
});

test("the platform side-checkouts are left alone", () => {
  assert.ok(PLATFORM_CHECKOUTS.length > 0, "expected at least one platform side-checkout to exist");
  for (const site of PLATFORM_CHECKOUTS) {
    assert.match(
      site.body,
      /^\s*path:\s*_mandrel-platform/m,
      `${WORKFLOW}:${site.line} — a platform checkout must stay path-scoped`,
    );
    assert.equal(
      cleanExpression(site.body),
      null,
      `${WORKFLOW}:${site.line} — the side-checkouts are out of scope for ${INPUT} (path-scoped and small)`,
    );
  }
});

test("the hygiene step runs exactly when the checkouts stop cleaning", () => {
  const guard = HYGIENE_BLOCK.match(/^\s*if:\s*\$\{\{(.+)\}\}\s*$/m);
  assert.ok(guard, "the hygiene step must be guarded by an `if:` expression");
  const expr = guard[1].trim();
  // The complement of the `clean:` gate, evaluated rather than eyeballed: a
  // gate and a guard that can disagree either clean twice or not at all.
  assert.equal(evaluate(expr, { [INPUT]: "" }), false, "empty input must skip the hygiene step");
  assert.equal(evaluate(expr, { [INPUT]: "node_modules" }), true, "a non-empty input must run the hygiene step");
});

// ---------------------------------------------------------------------------
// AC-4 — the caller's string never reaches the shell as workflow text
// ---------------------------------------------------------------------------

test("the caller value reaches the hygiene step through env, never interpolation", () => {
  assert.ok(
    !HYGIENE_RUN.includes("${{"),
    "the hygiene `run:` body must contain no `${{ }}` — an interpolated caller string is spliced into the " +
      "script before bash parses it (rules/security-baseline.md)",
  );
  assert.match(
    withoutComments(HYGIENE_BLOCK),
    /^\s*CHECKOUT_CLEAN_EXCLUDES:\s*\$\{\{\s*inputs\.checkout-clean-excludes\s*\}\}\s*$/m,
    "the value must arrive through `env:`",
  );
  assert.match(HYGIENE_RUN, /\$\{CHECKOUT_CLEAN_EXCLUDES\}/, "the body must read the environment variable");
});

test("each pattern is passed to git clean as one literal -e operand", () => {
  const dir = mkdtempSync(join(tmpdir(), "clean-excludes-argv-"));
  const log = join(dir, "argv.log");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // A stub `git` that records argv verbatim, one argument per line, so an
  // argument that was split by the shell is visible as two lines.
  const stub = join(bin, "git");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\nprintf -- '--\\n' >> "${log}"\nexit 0\n`);
  chmodSync(stub, 0o755);

  // Deliberately hostile: a leading dash (could be read as a git flag), a
  // command substitution and a semicolon (could be executed), an embedded
  // space (could be split into two operands), and a blank line.
  const patterns = ["-rf", "$(touch pwned)", "two words;echo hi", "", "node_modules"];
  execFileSync("bash", ["-c", HYGIENE_RUN], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CHECKOUT_CLEAN_EXCLUDES: patterns.join("\n") },
  });

  const invocations = readFileSync(log, "utf8")
    .split("--\n")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => chunk.split("\n").filter((line) => line !== ""));

  assert.deepEqual(invocations, [
    ["clean", "-ffdx", "-e", "-rf", "-e", "$(touch pwned)", "-e", "two words;echo hi", "-e", "node_modules"],
    ["reset", "--hard", "HEAD"],
  ]);
  assert.ok(!existsSync(join(dir, "pwned")), "a command substitution in a pattern must never be evaluated");
});

// ---------------------------------------------------------------------------
// AC-3 — the hygiene step preserves exactly what it is told to
// ---------------------------------------------------------------------------

test("the hygiene step preserves the named paths and discards everything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "clean-excludes-repo-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git("init", "-q", "-b", "main", ".");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\nbuild-cache/\nstray.log\n");
  writeFileSync(join(dir, "tracked.txt"), "committed\n");
  git("add", "-A");
  git("-c", "user.email=guard@example.test", "-c", "user.name=guard", "commit", "-qm", "fixture");

  // What a reused self-hosted workspace looks like at the start of the next job.
  mkdirSync(join(dir, "node_modules/.pnpm"), { recursive: true });
  writeFileSync(join(dir, "node_modules/.pnpm/lock.yaml"), "warm\n");
  mkdirSync(join(dir, "build-cache"), { recursive: true });
  writeFileSync(join(dir, "build-cache/out.bin"), "cold\n");
  writeFileSync(join(dir, "stray.log"), "ignored\n");
  writeFileSync(join(dir, "leftover.txt"), "untracked\n");
  writeFileSync(join(dir, "tracked.txt"), "committed\nlocally modified\n");

  execFileSync("bash", ["-c", HYGIENE_RUN], {
    cwd: dir,
    env: { ...process.env, CHECKOUT_CLEAN_EXCLUDES: "node_modules/\n" },
  });

  assert.ok(
    existsSync(join(dir, "node_modules/.pnpm/lock.yaml")),
    "the named path must survive, nested content included — that is the whole point of the input",
  );
  assert.ok(!existsSync(join(dir, "build-cache")), "an ignored directory that was NOT named must be removed");
  assert.ok(!existsSync(join(dir, "stray.log")), "an ignored file that was NOT named must be removed");
  assert.ok(!existsSync(join(dir, "leftover.txt")), "an untracked file must be removed");
  assert.equal(
    readFileSync(join(dir, "tracked.txt"), "utf8"),
    "committed\n",
    "a modified tracked file must be restored",
  );
  assert.equal(git("status", "--porcelain").trim(), "", "the tree must be clean afterwards");
});
