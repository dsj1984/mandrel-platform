#!/usr/bin/env node
/**
 * check-osv-scan-mode.test.mjs — YAML-level regression guard for the
 * diff-aware OSV wiring (Story #325).
 *
 * The gate LOGIC has unit coverage in `osv-report-gate.test.mjs`, but the
 * logic is inert unless the workflow actually feeds it a baseline. The wiring
 * is where this design silently degrades, and every degradation looks like a
 * green build:
 *
 *   • a shallow checkout → `git merge-base` and the baseline worktree cannot
 *     reach the fork point → every run silently gates whole-tree, and the
 *     incident this Story fixes comes straight back;
 *   • a dropped `baseline-ref` input → the composite resolves 'auto' to full
 *     with no error, for the same silent outcome;
 *   • `advisory-scan.yml` inheriting the diff-aware default → NOTHING owns
 *     base-branch advisories, because the PR tier deliberately stopped
 *     blocking on them. That is the one true regression here: a real
 *     main-level advisory would go completely unreported.
 *
 * This suite pins all three, modelled on the sibling
 * `check-affected-mode.test.mjs` (read the real workflow, extract blocks by
 * indentation, assert — then execute the extracted `run:` bodies against real
 * bash so the fail-closed branches are proven, not just read).
 *
 * Run: node --test scripts/check-osv-scan-mode.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prQuality = readFileSync(join(repoRoot, ".github/workflows/pr-quality.yml"), "utf8");
const advisoryScan = readFileSync(join(repoRoot, ".github/workflows/advisory-scan.yml"), "utf8");
const composite = readFileSync(join(repoRoot, ".github/actions/osv-scan/action.yml"), "utf8");

// ---------------------------------------------------------------------------
// Minimal indentation-based extraction (dependency-free, mirrors
// check-affected-mode.test.mjs / check-ci-required-aggregator.test.mjs).
// ---------------------------------------------------------------------------

function stepByName(text, name) {
  const lines = text.split("\n");
  const nameIdx = lines.findIndex((l) => /^\s+(- )?name:\s/.test(l) && l.includes(name));
  assert.notEqual(nameIdx, -1, `step "${name}" not found`);
  let start = -1;
  for (let i = nameIdx; i >= 0; i--) {
    if (/^\s*-\s/.test(lines[i])) {
      start = i;
      break;
    }
  }
  assert.notEqual(start, -1, `opening bullet for step "${name}" not found`);
  const bulletIndent = lines[start].match(/^(\s*)/)[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (indent < bulletIndent) {
      end = i;
      break;
    }
    if (indent === bulletIndent && /^\s*-\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The dedented body of a step's `run: |` block scalar. */
function runScript(stepBlock) {
  const lines = stepBlock.split("\n");
  const start = lines.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l));
  assert.notEqual(start, -1, "`run: |` block not found");
  const runIndent = lines[start].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) {
      body.push("");
      continue;
    }
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (indent <= runIndent) break;
    body.push(lines[i].slice(runIndent + 2));
  }
  return body.join("\n");
}

/**
 * The body of a mapping key at a given indent, up to the next sibling key or
 * end of input. Terminating on end-of-input matters: the LAST declared input
 * has no following sibling, and a regex that requires one silently matches
 * nothing.
 */
function blockUnder(text, key, indent) {
  const pad = " ".repeat(indent);
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${pad}${key}:`);
  assert.notEqual(start, -1, `key "${key}" not found at indent ${indent}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (new RegExp(`^${pad}\\S`).test(lines[i])) {
      end = i;
      break;
    }
    if (lines[i].match(/^(\s*)/)[1].length < indent) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** The `osv-scan` job block, so step lookups cannot match a same-named step elsewhere. */
function osvScanJob() {
  const lines = prQuality.split("\n");
  const start = lines.findIndex((l) => /^ {2}osv-scan:\s*$/.test(l));
  assert.notEqual(start, -1, "osv-scan job not found");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const job = osvScanJob();

function bashAvailable() {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const exec = { skip: bashAvailable() ? false : "bash not available on this host" };

// ---------------------------------------------------------------------------
// 1. INPUT SURFACE — the reusable workflow exposes the knobs, defaulted so the
//    diff-aware behaviour is on and the grace window is off.
// ---------------------------------------------------------------------------

test("pr-quality declares osv-scan-mode defaulting to 'auto'", () => {
  const block = blockUnder(prQuality, "osv-scan-mode", 6);
  assert.match(block, /type:\s*string/, "osv-scan-mode must be a string input");
  assert.match(
    block,
    /default:\s*'auto'/,
    "osv-scan-mode must default to 'auto' (the diff-aware default)",
  );
});

test("pr-quality declares osv-grace-days defaulting to 0 (window off)", () => {
  const block = blockUnder(prQuality, "osv-grace-days", 6);
  assert.match(block, /type:\s*number/, "osv-grace-days must be a number input");
  assert.match(
    block,
    /default:\s*0\b/,
    "osv-grace-days must default to 0 — no consumer's gate may soften without opting in",
  );
});

test("the composite declares the diff-aware surface with matching defaults", () => {
  assert.match(
    blockUnder(composite, "scan-mode", 2),
    /default:\s*'auto'/,
    "composite scan-mode must default to 'auto'",
  );
  assert.match(
    blockUnder(composite, "grace-days", 2),
    /default:\s*'0'/,
    "composite grace-days must default to '0' — the window is opt-in",
  );
  assert.match(
    blockUnder(composite, "baseline-ref", 2),
    /default:\s*''/,
    "composite baseline-ref must default to empty (no baseline → whole-tree)",
  );

  for (const out of ["preexisting-count", "grace-count", "resolved-scan-mode", "baseline-scanned"]) {
    assert.match(
      composite,
      new RegExp(`^ {2}${out}:$`, "m"),
      `composite must expose the ${out} output`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. WIRING — the osv-scan job can actually reach the merge base, and forwards
//    every input. A shallow checkout here degrades to whole-tree silently.
// ---------------------------------------------------------------------------

test("the osv-scan job checks out full history unless scan-mode is 'full'", () => {
  const checkout = stepByName(job, "Checkout");
  const m = checkout.match(/fetch-depth:\s*(.+)/);
  assert.ok(m, "the osv-scan checkout must pin fetch-depth explicitly");
  const expr = m[1].trim();
  assert.match(
    expr,
    /inputs\.osv-scan-mode == 'full'/,
    "fetch-depth must key off osv-scan-mode — a shallow clone cannot reach the merge base",
  );
  // The strings are load-bearing: a bare numeric 0 is FALSY in a GitHub
  // expression, so `... && 0 || 1` collapses to 1 and silently re-shallows.
  assert.match(expr, /'1'/, "the full-mode arm must be the STRING '1'");
  assert.match(expr, /'0'/, "the diff-mode arm must be the STRING '0'");
  assert.match(checkout, /persist-credentials:\s*false/, "must not persist the token");
});

for (const step of [
  "Checkout diff-range resolver (mandrel-platform@resolved-sha)",
  "Resolve OSV diff baseline (merge base)",
]) {
  test(`"${step}" is skipped only under scan-mode: full`, () => {
    const block = stepByName(job, step);
    const m = block.match(/^\s+if:\s*(.+?)\s*$/m);
    assert.ok(m, `step "${step}" has no if: condition`);
    assert.match(
      m[1],
      /inputs\.osv-scan-mode != 'full'/,
      "the baseline steps must run for every mode except full",
    );
  });
}

test("the diff-range resolver is side-checked-out from the pinned platform SHA", () => {
  const block = stepByName(job, "Checkout diff-range resolver (mandrel-platform@resolved-sha)");
  assert.match(block, /repository:\s*dsj1984\/mandrel-platform/);
  assert.match(
    block,
    /job_workflow_sha/,
    "must resolve THIS repo at the SHA the caller pinned, not a floating ref",
  );
  assert.match(
    block,
    /scripts\/resolve-diff-range\.sh/,
    "must reuse the canonical derivation rather than re-deriving base/head",
  );
});

test("the composite step forwards scan-mode, baseline-ref and grace-days", () => {
  const step = stepByName(job, "OSV advisory scan (pinned binary)");
  assert.match(step, /scan-mode:\s*\$\{\{\s*inputs\.osv-scan-mode\s*\}\}/);
  assert.match(
    step,
    /baseline-ref:\s*\$\{\{\s*steps\.osv-baseline\.outputs\.baseline-ref\s*\}\}/,
    "the resolved merge base must reach the composite, or 'auto' silently degrades to full",
  );
  assert.match(step, /grace-days:\s*\$\{\{\s*inputs\.osv-grace-days\s*\}\}/);
  // The existing contract must survive.
  assert.match(step, /fail-on-severity:\s*\$\{\{\s*inputs\.osv-fail-on-severity\s*\}\}/);
  assert.match(step, /allowlist-path:\s*\$\{\{\s*inputs\.osv-allowlist-path\s*\}\}/);
});

// ---------------------------------------------------------------------------
// 3. THE SCHEDULED OWNER — advisory-scan.yml must stay whole-tree. This is the
//    regression that would make the whole design unsafe.
// ---------------------------------------------------------------------------

test("advisory-scan pins scan-mode: full and cannot inherit the diff-aware default", () => {
  const step = stepByName(advisoryScan, "OSV advisory scan (scheduled, non-blocking)");
  assert.match(
    step,
    /scan-mode:\s*'full'/,
    "the scheduled scan owns base-branch advisories — diff-aware there would leave them unowned",
  );
});

test("advisory-scan still reports findings and still upserts its tracking issue", () => {
  const step = stepByName(advisoryScan, "OSV advisory scan (scheduled, non-blocking)");
  assert.match(step, /non-blocking:\s*'true'/, "the tracking issue is the signal, not a red job");
  assert.match(step, /findings-out:/, "the upsert needs the machine-readable findings");
  assert.match(
    advisoryScan,
    /actions\/osv-track-issue@/,
    "the tracking-issue upsert step must still run",
  );
  assert.match(advisoryScan, /issues:\s*write/, "the upsert needs issues: write");
});

// ---------------------------------------------------------------------------
// 4. EXECUTE the composite's mode-resolution prologue. 'auto' with no baseline
//    and 'diff' with no baseline must BOTH land on full (blocking) — the
//    fail-closed direction.
// ---------------------------------------------------------------------------

const compositeRun = runScript(stepByName(composite, "OSV advisory scan (pinned binary)"));
// The prologue is everything before the binary download begins.
const MODE_PROLOGUE = compositeRun.split('\nos="$(uname -s)"')[0];

function resolveMode({ mode, baselineRef = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "osv-mode-"));
  try {
    const scriptFile = join(dir, "prologue.sh");
    writeFileSync(scriptFile, MODE_PROLOGUE);
    const outFile = join(dir, "github_output");
    writeFileSync(outFile, "");
    const r = spawnSync("bash", [scriptFile], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outFile,
        OSV_SCAN_MODE: mode,
        OSV_BASELINE_REF: baselineRef,
      },
    });
    return {
      status: r.status,
      stdout: r.stdout,
      outputs: readFileSync(outFile, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("scan-mode 'full' never resolves to diff, even with a baseline available", exec, () => {
  const r = resolveMode({ mode: "full", baselineRef: "deadbeef" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.outputs, /^resolved-scan-mode=full$/m);
});

test("scan-mode 'auto' resolves to diff when a baseline was supplied", exec, () => {
  const r = resolveMode({ mode: "auto", baselineRef: "deadbeef" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.outputs, /^resolved-scan-mode=diff$/m);
});

test("scan-mode 'auto' falls back to full when no baseline is resolvable", exec, () => {
  // push / schedule / a merge-queue-less event resolve no base — today's
  // whole-tree behaviour must survive untouched there.
  const r = resolveMode({ mode: "auto", baselineRef: "" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.outputs, /^resolved-scan-mode=full$/m);
});

test("scan-mode 'diff' with no baseline degrades to full and says so", exec, () => {
  const r = resolveMode({ mode: "diff", baselineRef: "" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(
    r.outputs,
    /^resolved-scan-mode=full$/m,
    "an unbaselined diff run must BLOCK whole-tree, never pass everything as pre-existing",
  );
  assert.match(r.stdout, /::warning::/, "the degradation must be visible, not silent");
});

test("an invalid scan-mode fails the step closed", exec, () => {
  const r = resolveMode({ mode: "sideways", baselineRef: "deadbeef" });
  assert.notEqual(r.status, 0, "an unrecognized mode must not fall through to a default");
  assert.doesNotMatch(r.outputs, /resolved-scan-mode=/, "no partial output on a rejected mode");
});

// ---------------------------------------------------------------------------
// 5. EXECUTE the baseline-resolution run script against real bash + real git,
//    so the merge-base shaping and the injection guard are proven.
// ---------------------------------------------------------------------------

const BASELINE_SCRIPT = runScript(stepByName(job, "Resolve OSV diff baseline (merge base)"));

/**
 * Run the extracted baseline step with a stubbed resolve-diff-range.sh (the
 * sourced derivation), inside a real throwaway git repo so `git merge-base`
 * resolves for the pull_request shaping.
 */
function runBaseline({ mode = "", base = "", head = "", realRepo = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "osv-baseline-"));
  try {
    const workspace = join(dir, "ws");
    mkdirSync(join(workspace, "_mandrel-platform-osv-range", "scripts"), { recursive: true });
    writeFileSync(
      join(workspace, "_mandrel-platform-osv-range", "scripts", "resolve-diff-range.sh"),
      [
        'RESOLVED_EVENT_MODE="${STUB_MODE-}"',
        'RESOLVED_BASE_SHA="${STUB_BASE-}"',
        'RESOLVED_HEAD_SHA="${STUB_HEAD-}"',
        "",
      ].join("\n"),
    );

    let baseSha = base;
    let headSha = head;
    if (realRepo) {
      const git = (...args) =>
        execFileSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
          { cwd: workspace, encoding: "utf8" },
        ).trim();
      git("init", "-q", "-b", "main");
      writeFileSync(join(workspace, "a.txt"), "a\n");
      git("add", "a.txt");
      git("commit", "-qm", "root");
      const fork = git("rev-parse", "HEAD");
      // Advance main past the fork point — this drift is exactly why the PR
      // shaping takes the merge base rather than base.sha.
      writeFileSync(join(workspace, "b.txt"), "b\n");
      git("add", "b.txt");
      git("commit", "-qm", "main advances");
      baseSha = git("rev-parse", "HEAD");
      git("checkout", "-q", "-b", "feature", fork);
      writeFileSync(join(workspace, "c.txt"), "c\n");
      git("add", "c.txt");
      git("commit", "-qm", "feature work");
      headSha = git("rev-parse", "HEAD");
      // The merge base of base..head is the fork point, NOT the advanced tip.
      return { ...spawnBaseline(), forkSha: fork };
    }
    return spawnBaseline();

    function spawnBaseline() {
      const scriptFile = join(dir, "baseline.sh");
      writeFileSync(scriptFile, BASELINE_SCRIPT);
      const outFile = join(dir, "github_output");
      writeFileSync(outFile, "");
      const r = spawnSync("bash", [scriptFile], {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          GITHUB_OUTPUT: outFile,
          STUB_MODE: mode,
          STUB_BASE: baseSha,
          STUB_HEAD: headSha,
        },
      });
      return {
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
        outputs: readFileSync(outFile, "utf8"),
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mode=none exports an EMPTY baseline-ref rather than skipping the output", exec, () => {
  const r = runBaseline({ mode: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.outputs,
    /^baseline-ref=$/m,
    "an unresolvable base must still emit the (empty) output — the composite reads that as 'gate whole-tree'",
  );
});

test("pull_request baselines on the MERGE BASE, not the drifted base tip", exec, () => {
  const r = runBaseline({ mode: "pull_request", realRepo: true });
  assert.equal(r.status, 0, r.stderr);
  const m = r.outputs.match(/^baseline-ref=(.+)$/m);
  assert.ok(m, "no baseline-ref emitted");
  assert.equal(
    m[1],
    r.forkSha,
    "must be the fork point — base.sha drifts forward once main advances, which would baseline against commits the PR never saw",
  );
});

for (const mode of ["merge_group", "push"]) {
  test(`${mode} baselines on the derived base directly (already the fork point)`, exec, () => {
    const r = runBaseline({ mode, base: "cafebabe", head: "deadbeef" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.outputs, /^baseline-ref=cafebabe$/m);
  });
}

test("a newline-bearing base is rejected before it reaches $GITHUB_OUTPUT", exec, () => {
  const r = runBaseline({ mode: "push", base: "cafebabe\nMALICIOUS=pwned", head: "deadbeef" });
  assert.notEqual(r.status, 0, "a multiline base must fail the step, not export");
  assert.doesNotMatch(r.outputs, /MALICIOUS/, "the injected line must never reach $GITHUB_OUTPUT");
  assert.doesNotMatch(r.outputs, /baseline-ref=/, "no partial export on a rejected base");
});

test("a carriage-return-bearing base is rejected too", exec, () => {
  const r = runBaseline({ mode: "push", base: "cafebabe\rMALICIOUS=pwned", head: "deadbeef" });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.outputs, /MALICIOUS/);
});
