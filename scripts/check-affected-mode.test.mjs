#!/usr/bin/env node
/**
 * check-affected-mode.test.mjs — YAML-level regression guard for the
 * affected-mode wiring in `.github/workflows/pr-quality.yml` (Story #319,
 * follow-up to #314/#315).
 *
 * `scripts/resolve-diff-range.sh` has solid unit coverage
 * (`resolve-diff-range.test.mjs`), but the affected-mode *wiring* inside the
 * reusable workflow was only covered indirectly by anchor-expansion checks.
 * This suite pins the four invariants that keep the affected-mode design
 * correct, modelled on the sibling `check-ci-required-aggregator.test.mjs`
 * (read the real workflow, extract blocks by indentation, assert):
 *
 *   1. GATING — the coverage-gate steps (`Checkout gate scripts`, `Coverage
 *      threshold gate`) carry `inputs.coverage-threshold != 0 && !inputs.affected`,
 *      and the bypass `::notice::` step carries the *complementary*
 *      `inputs.coverage-threshold != 0 && inputs.affected`. A drift that drops
 *      `!inputs.affected` (which would false-fail the whole-repo floor on an
 *      affected subset) fails this suite.
 *   2. NO EXPORT ON mode=none — executing the resolve-affected `run:` script
 *      with an unresolved (`mode=none`) range leaves `TURBO_SCM_*` unset, so
 *      turbo falls back to its own default rather than a bogus range.
 *   3. INJECTION-SAFE EXPORT (Story #319 hardening) — a newline-bearing
 *      `affected-base` override is rejected before the `$GITHUB_ENV` write, so
 *      it can never inject a second env line; a single-line override exports
 *      exactly `TURBO_SCM_BASE` / `TURBO_SCM_HEAD` and nothing else.
 *   4. DOCUMENTED PRECONDITION (Story #413) — neither `.github/workflows/
 *      pr-quality.yml` nor `docs/reusable-workflows.md` claims affected mode
 *      can never miss a task (true only of an UNRESOLVABLE base), and both
 *      give the conditional consumer shape `turbo run <tier>
 *      ${TURBO_SCM_BASE:+--affected}` — the gate that stops a baked-in
 *      `--affected` from scheduling zero tasks on a push-to-`main` run.
 *
 * The `run:` script is executed against real bash with a stubbed
 * `resolve-diff-range.sh` (the sourced derivation), so no git repo is needed;
 * skipped when bash is unavailable locally (CI's ubuntu runner always has it).
 *
 * Run: node --test scripts/check-affected-mode.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { stepByName, runScript } from "./lib/yaml-step.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/pr-quality.yml";
const content = readFileSync(join(repoRoot, WORKFLOW), "utf8");

// ---------------------------------------------------------------------------
// Local extraction helper. Step-block and `run:` extraction are shared via
// scripts/lib/yaml-step.mjs; only the `if:` reader is specific to this suite,
// which is the only one asserting on step gating.
// ---------------------------------------------------------------------------

/** The (first) `if:` expression on a step block, trimmed. */
function ifCondition(stepBlock) {
  const m = stepBlock.match(/^\s+if:\s*(.+?)\s*$/m);
  assert.ok(m, "step has no `if:` condition");
  return m[1].trim();
}

// ---------------------------------------------------------------------------
// 1. GATING — coverage-gate steps gated OUT of affected mode; bypass step gated IN
// ---------------------------------------------------------------------------

test("resolve-affected step runs only in affected mode", () => {
  const cond = ifCondition(stepByName(content, "Resolve affected SCM base/head (turbo)"));
  assert.match(cond, /inputs\.affected/, "the resolve step must be gated on `inputs.affected`");
  assert.doesNotMatch(cond, /!\s*inputs\.affected/, "the resolve step must not be negated");
});

for (const step of ["Checkout gate scripts (mandrel-platform@resolved-sha)", "Coverage threshold gate"]) {
  test(`coverage-gate step "${step}" is gated OUT of affected mode`, () => {
    const cond = ifCondition(stepByName(content, step));
    assert.match(
      cond,
      /inputs\.coverage-threshold != 0/,
      "must still require a non-zero coverage-threshold"
    );
    assert.match(
      cond,
      /!\s*inputs\.affected/,
      "must carry `!inputs.affected` — dropping it false-fails the whole-repo floor on an affected subset"
    );
  });
}

test("bypass `::notice::` step carries the complementary affected-mode gating", () => {
  const step = stepByName(content, "Coverage floor bypassed (affected mode)");
  const cond = ifCondition(step);
  assert.match(cond, /inputs\.coverage-threshold != 0/, "must require a non-zero coverage-threshold");
  assert.match(cond, /&&\s*inputs\.affected/, "must fire only in affected mode");
  assert.doesNotMatch(
    cond,
    /!\s*inputs\.affected/,
    "the bypass notice must be the complement of the gate — never negated"
  );
  assert.match(step, /::notice title=/, "the bypass must emit a visible ::notice::, never a silent skip");
});

// ---------------------------------------------------------------------------
// 2 & 3. Execute the resolve-affected run script against real bash.
// ---------------------------------------------------------------------------

function bashAvailable() {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const RESOLVE_SCRIPT = runScript(stepByName(content, "Resolve affected SCM base/head (turbo)"));

/**
 * Run the extracted resolve-affected `run:` body with a stubbed
 * resolve-diff-range.sh that sets RESOLVED_* from STUB_* env, capturing the
 * lines the step wrote to $GITHUB_ENV.
 */
function runResolve({ mode = "", base = "", head = "", override } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "affected-mode-"));
  try {
    const workspace = join(dir, "ws");
    mkdirSync(join(workspace, "_mandrel-platform-range", "scripts"), { recursive: true });
    // Stub the sourced derivation: RESOLVED_* come from STUB_* env.
    writeFileSync(
      join(workspace, "_mandrel-platform-range", "scripts", "resolve-diff-range.sh"),
      ['RESOLVED_EVENT_MODE="${STUB_MODE-}"', 'RESOLVED_BASE_SHA="${STUB_BASE-}"', 'RESOLVED_HEAD_SHA="${STUB_HEAD-}"', ""].join("\n")
    );
    const scriptFile = join(dir, "resolve.sh");
    writeFileSync(scriptFile, RESOLVE_SCRIPT);
    const envFile = join(dir, "github_env");
    writeFileSync(envFile, "");

    const env = {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      GITHUB_ENV: envFile,
      STUB_MODE: mode,
      STUB_BASE: base,
      STUB_HEAD: head,
    };
    if (override !== undefined) env.AFFECTED_BASE_OVERRIDE = override;

    const r = spawnSync("bash", [scriptFile], { encoding: "utf8", env });
    return { status: r.status, stderr: r.stderr, envLines: readFileSync(envFile, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const exec = { skip: bashAvailable() ? false : "bash not available on this host" };

test("mode=none: no ranged base resolvable → TURBO_SCM_* left unset", exec, () => {
  const r = runResolve({ mode: "", base: "", head: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.envLines, /TURBO_SCM_BASE/, "mode=none must not export a base");
  assert.doesNotMatch(r.envLines, /TURBO_SCM_HEAD/, "mode=none must not export a head");
});

test("newline-bearing affected-base override is rejected before the export (injection guard)", exec, () => {
  const r = runResolve({ override: "deadbeef\nMALICIOUS=pwned", head: "cafebabe" });
  assert.notEqual(r.status, 0, "a multiline override must fail the step, not export");
  assert.doesNotMatch(r.envLines, /MALICIOUS/, "the injected env line must never reach $GITHUB_ENV");
  assert.doesNotMatch(r.envLines, /TURBO_SCM_BASE/, "no partial export on a rejected override");
});

test("carriage-return-bearing affected-base override is rejected too", exec, () => {
  const r = runResolve({ override: "deadbeef\rMALICIOUS=pwned", head: "cafebabe" });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.envLines, /MALICIOUS/);
});

test("single-line affected-base override exports exactly TURBO_SCM_BASE and TURBO_SCM_HEAD", exec, () => {
  const r = runResolve({ override: "origin/main", head: "cafebabe" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.envLines, /^TURBO_SCM_BASE=origin\/main$/m);
  assert.match(r.envLines, /^TURBO_SCM_HEAD=cafebabe$/m);
  const nonEmpty = r.envLines.split("\n").filter((l) => l.trim() !== "");
  assert.equal(nonEmpty.length, 2, `expected exactly two env lines, got: ${JSON.stringify(nonEmpty)}`);
});

// ---------------------------------------------------------------------------
// 4. DOCUMENTED PRECONDITION (Story #413) — the `affected` input's safety claim
//
// The old prose promised affected mode "can never miss a task", which is true
// only of the UNRESOLVABLE-base case. A `--affected` baked unconditionally into
// a consumer's package script hits the resolvable-but-EMPTY case instead: with
// `affected: false` the TURBO_SCM_* vars are never exported, turbo falls back
// to its own default base of `main`, and on a push to `main` that range is
// empty — zero tasks scheduled, exit 0, a silent no-op that reads as a pass.
// These assertions pin the correction in both consumer-facing surfaces so the
// absolute claim cannot return and the conditional shape cannot be dropped.
// ---------------------------------------------------------------------------

const DOCS = "docs/reusable-workflows.md";

/** The safe consumer shape: `--affected` only when a base was exported. */
const CONDITIONAL_FORM = "${TURBO_SCM_BASE:+--affected}";

/** Absolute claims that over-promise the fallback. Retired — must not return. */
const ABSOLUTE_CLAIMS = ["so this can never miss a task", "never a missed task"];

for (const [label, relPath] of [
  ["the reusable workflow", WORKFLOW],
  ["the consumer documentation", DOCS],
]) {
  test(`${label} states the affected-mode precondition conditionally, not absolutely`, () => {
    const text = readFileSync(join(repoRoot, relPath), "utf8");
    // Case-insensitive: the claim is retired as a claim, not as a casing.
    const haystack = text.toLowerCase();

    for (const claim of ABSOLUTE_CLAIMS) {
      assert.ok(
        !haystack.includes(claim),
        `${relPath} still claims "${claim}" — the full-run fallback covers an ` +
          "unresolvable base only, not a base that resolves to an empty range"
      );
    }

    assert.ok(
      text.includes(CONDITIONAL_FORM),
      `${relPath} must recommend \`turbo run <tier> ${CONDITIONAL_FORM}\` — gating ` +
        "the flag on the exported base is what keeps a push-to-`main` run from " +
        "silently scheduling zero tasks"
    );
  });
}
