#!/usr/bin/env node
/**
 * pnpm-install-watchdog.test.mjs — the suite for the setup-toolchain install
 * watchdog (Story #530).
 *
 * WHY EACH LAYER IS HERE
 *
 *   1. THE DECISION IS PURE, so the incident can be replayed without waiting
 *      for one. The wedge that motivated this ran for 27 minutes; a suite that
 *      could only observe a real stall could not assert the thing that
 *      matters — that a tree at ~1.3% of a core trips, while a working install
 *      does not. `evaluateStall` is driven directly with the incident's
 *      measured shape.
 *
 *   2. THE PARSER IS TESTED ON BOTH `ps` DIALECTS, because a watchdog that
 *      misreads CPU on the platform its tests do not run on is worse than
 *      none: it would read every process as idle and kill healthy installs.
 *      A field it cannot parse must drop the row, never score it as zero —
 *      zero is precisely the claim it kills on.
 *
 *   3. THE FAIL-SAFE IS TESTED AS A BEHAVIOUR, not a code path. The rule the
 *      whole design rests on is that the watchdog may never be the reason a
 *      job fails, so a sampler that throws on every call must still leave the
 *      install running and exiting under its own status.
 *
 *   4. TWO TESTS USE REAL PROCESS TREES, because the central claim — progress
 *      is the TREE's CPU, not the parent's output — is unfalsifiable against a
 *      stubbed sampler. One tree is silent but burning CPU in a grandchild and
 *      must survive; one is genuinely asleep and must be killed with no member
 *      left behind.
 *
 *      Their windows are seconds, not milliseconds, and deliberately so:
 *      Linux `ps -o time` has ONE-SECOND resolution, so a sub-second window
 *      reads a fully-busy tree as having used no CPU at all. A suite tuned for
 *      macOS's centiseconds would invert on the very platform CI runs.
 *
 *   5. THE SHELL BRANCH IS EXECUTED, not grepped. What decides whether pnpm
 *      receives identical argv is a bash branch in the composite, so the real
 *      `run:` body is extracted and run against a stub `pnpm` that echoes its
 *      argv — the same read-then-execute approach as
 *      `check-setup-toolchain-store.test.mjs` next door.
 *
 * Run: node --test scripts/pnpm-install-watchdog.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { stepByName, runScript } from "./lib/yaml-step.mjs";
import {
  DEFAULTS,
  EXIT_STALLED,
  collectTree,
  evaluateStall,
  parseCpuTime,
  parsePsRows,
  psSampler,
  renderStallMessage,
  resolveConfig,
  sumTreeCpuSeconds,
  supervise,
} from "../.github/actions/setup-toolchain/pnpm-install-watchdog.mjs";

const ACTION = ".github/actions/setup-toolchain/action.yml";
const WORKFLOW = ".github/workflows/pr-quality.yml";
const DOCS = "docs/reusable-workflows.md";

const actionText = readFileSync(ACTION, "utf8");
const workflowText = readFileSync(WORKFLOW, "utf8");
const installScript = runScript(stepByName(actionText, "Install dependencies"));

/** An armed config in the shape `resolveConfig` produces, overridable per test. */
const config = (over = {}) => ({
  armed: true,
  reason: "armed",
  stallTimeoutMs: 600_000,
  graceMs: 120_000,
  minCpuRate: 0.05,
  sampleIntervalMs: 10_000,
  ...over,
});

/** Samples at a constant CPU rate, one every `stepMs`, starting at t=0. */
const rampSamples = ({ rate, untilMs, stepMs = 10_000, from = 0 }) => {
  const samples = [];
  for (let atMs = 0; atMs <= untilMs; atMs += stepMs) {
    samples.push({ atMs, cpuSeconds: from + (atMs / 1000) * rate });
  }
  return samples;
};

// ---------------------------------------------------------------------------
// AC-3 — the decision: the measured incident trips, a healthy install does not
// ---------------------------------------------------------------------------

test("the measured incident trips the stall decision", () => {
  // Beestera/swarm-os run 34876024126: 20.99s of CPU across 27 minutes, flat.
  const rate = 20.99 / (27 * 60); // ~0.013 — 1.3% of one core
  const samples = rampSamples({ rate, untilMs: 27 * 60 * 1000 });
  const verdict = evaluateStall(samples, config());
  assert.equal(verdict.stalled, true, "a tree at ~1.3% for 27 minutes must be a stall");
  assert.ok(verdict.rate < 0.05);
  assert.ok(verdict.windowSeconds >= 600 - 10, "the measured window must be the trailing one");
});

test("an absolute 'CPU has not advanced' test would have MISSED the incident", () => {
  // The reason the instrument is a rate. Over the same 600s window the wedged
  // tree still accrued ~7.8s of CPU, so any "has it moved at all" test — or any
  // fixed threshold below that — reads the wedge as progress.
  const rate = 20.99 / (27 * 60);
  const samples = rampSamples({ rate, untilMs: 27 * 60 * 1000 });
  const verdict = evaluateStall(samples, config());
  assert.ok(verdict.cpuSeconds > 5, `expected a nonzero CPU delta, got ${verdict.cpuSeconds}`);
});

test("a healthy install is never a stall, however long it runs", () => {
  const samples = rampSamples({ rate: 0.6, untilMs: 40 * 60 * 1000 });
  assert.equal(evaluateStall(samples, config()).stalled, false);
});

test("a rate exactly at the floor is progress, not a stall", () => {
  const samples = rampSamples({ rate: 0.05, untilMs: 30 * 60 * 1000 });
  assert.equal(evaluateStall(samples, config()).stalled, false);
});

test("nothing trips inside the grace window, however quiet", () => {
  const samples = rampSamples({ rate: 0, untilMs: 119_000, stepMs: 1000 });
  const verdict = evaluateStall(samples, config());
  assert.equal(verdict.stalled, false);
  assert.equal(verdict.reason, "within-grace");
});

test("a window that straddles the grace boundary is not yet decidable", () => {
  // Armed (past grace) but the trailing window would reach back into the cold
  // start the floor is explicitly exempt from.
  const samples = rampSamples({ rate: 0, untilMs: 300_000, stepMs: 10_000 });
  const verdict = evaluateStall(samples, config({ graceMs: 120_000, stallTimeoutMs: 600_000 }));
  assert.equal(verdict.stalled, false);
  assert.equal(verdict.reason, "window-not-full");
});

test("a run shorter than the window cannot be judged", () => {
  const samples = rampSamples({ rate: 0, untilMs: 400_000, stepMs: 10_000 });
  assert.equal(evaluateStall(samples, config()).reason, "window-not-full");
  assert.equal(evaluateStall([], config()).reason, "too-few-samples");
  assert.equal(evaluateStall([{ atMs: 0, cpuSeconds: 0 }], config()).reason, "too-few-samples");
});

test("a burst of work inside the window defers the kill", () => {
  // The conservative direction, and the reason the rate is a mean: the cost of
  // waiting is minutes, the cost of a wrong kill is a red required check on an
  // innocent diff.
  const samples = rampSamples({ rate: 0, untilMs: 1_800_000, stepMs: 10_000 });
  const last = samples[samples.length - 1];
  last.cpuSeconds += 60; // one minute of real work, right at the end
  assert.equal(evaluateStall(samples, config()).stalled, false);
});

// ---------------------------------------------------------------------------
// AC-2 — progress is the TREE's CPU, and an unreadable field is never zero
// ---------------------------------------------------------------------------

test("parseCpuTime reads both ps dialects", () => {
  assert.equal(parseCpuTime("0:00"), 0);
  assert.equal(parseCpuTime("20:59.02"), 20 * 60 + 59.02); // BSD/macOS MM:SS.cc
  assert.equal(parseCpuTime("01:02:03"), 3723); // Linux HH:MM:SS
  assert.equal(parseCpuTime("1-02:03:04"), 86400 + 7384); // Linux DD-HH:MM:SS
});

test("an unparseable time field is null, never zero", () => {
  // Zero is the exact claim the watchdog kills on, so an unreadable field must
  // never be able to impersonate an idle process.
  for (const field of ["", "   ", "?", "n/a", "1:2:3:4", "-", "x:yy"]) {
    assert.equal(parseCpuTime(field), null, `expected null for ${JSON.stringify(field)}`);
  }
});

test("parsePsRows drops rows it cannot read rather than scoring them idle", () => {
  const rows = parsePsRows(["  1  0  0:01.50", "  2  1  ?", "garbage", "  3  1  0:02"].join("\n"));
  assert.deepEqual(
    rows.map((r) => r.pid),
    [1, 3],
  );
});

test("collectTree reaches grandchildren and cannot spin on a cyclic table", () => {
  const rows = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 99, ppid: 1 },
  ];
  assert.deepEqual(collectTree(rows, 10).sort((a, b) => a - b), [10, 11, 12]);
  assert.deepEqual(collectTree([{ pid: 5, ppid: 6 }, { pid: 6, ppid: 5 }], 5).sort(), [5, 6]);
});

test("sumTreeCpuSeconds counts descendants and answers null for a missing root", () => {
  const rows = parsePsRows(["10 1 0:01.00", "11 10 0:02.00", "12 11 0:04.00", "99 1 9:00"].join("\n"));
  assert.equal(sumTreeCpuSeconds(rows, 10), 7);
  assert.equal(sumTreeCpuSeconds(rows, 4242), null);
});

// ---------------------------------------------------------------------------
// resolveConfig — the off switch, and every rejection disarming rather than
// inventing a threshold
// ---------------------------------------------------------------------------

test("an empty environment arms on the documented defaults", () => {
  const resolved = resolveConfig({});
  assert.equal(resolved.armed, true);
  assert.equal(resolved.stallTimeoutMs, DEFAULTS.stallTimeoutSeconds * 1000);
  assert.equal(resolved.graceMs, DEFAULTS.graceSeconds * 1000);
  assert.equal(resolved.minCpuRate, DEFAULTS.minCpuRate);
});

test("'0' is the off switch", () => {
  const resolved = resolveConfig({ PNPM_WATCHDOG_STALL_TIMEOUT: "0" });
  assert.equal(resolved.armed, false);
  assert.match(resolved.reason, /disabled/);
});

test("a value that is not a non-negative number disarms rather than falling back", () => {
  // An operator who typed a bad number asked for supervision and must be told
  // they are not getting it. Silently substituting a default is how a watchdog
  // ends up enforcing a threshold nobody chose.
  for (const env of [
    { PNPM_WATCHDOG_STALL_TIMEOUT: "soon" },
    { PNPM_WATCHDOG_GRACE: "-1" },
    { PNPM_WATCHDOG_MIN_CPU_RATE: "5%" },
    { PNPM_WATCHDOG_SAMPLE_INTERVAL: "NaN" },
  ]) {
    const resolved = resolveConfig(env);
    assert.equal(resolved.armed, false, JSON.stringify(env));
    assert.match(resolved.reason, /not a non-negative number|disabled/);
  }
});

// ---------------------------------------------------------------------------
// AC-4 / AC-5 — supervision behaviour under an injected sampler
// ---------------------------------------------------------------------------

/** Supervise `node -e <src>` with a scripted sampler, collecting the log. */
async function superviseNode(src, { sampler, ...over }) {
  const log = [];
  const code = await supervise({
    command: process.execPath,
    args: ["-e", src],
    config: config({ graceMs: 0, stallTimeoutMs: 200, sampleIntervalMs: 20, ...over }),
    sampler,
    log: (m) => log.push(m),
  });
  return { code, log: log.join("\n") };
}

test("a sampler that always throws disarms, and the install's own status stands", async () => {
  // The invariant the whole design rests on: the watchdog may never be the
  // reason a job fails.
  const { code, log } = await superviseNode("setTimeout(() => process.exit(3), 300)", {
    sampler: async () => {
      throw new Error("ps: command not found");
    },
  });
  assert.equal(code, 3, "the install's own exit status must survive a disarm");
  assert.match(log, /::warning::pnpm install watchdog disarmed/);
  assert.match(log, /ps: command not found/);
  assert.doesNotMatch(log, /::error::/);
});

test("the disarm warning is said once, not once per sample", async () => {
  const { log } = await superviseNode("setTimeout(() => process.exit(0), 400)", {
    sampler: async () => {
      throw new Error("unreadable");
    },
  });
  assert.equal(log.match(/watchdog disarmed/g).length, 1);
});

test("a sampler that cannot see the child never concludes a stall", async () => {
  // A child missing from the table has exited, or the table cannot answer for
  // it. Neither is evidence that it stopped working.
  const { code } = await superviseNode("setTimeout(() => process.exit(0), 400)", {
    sampler: async () => [{ pid: 999_999, ppid: 1, cpuSeconds: 0 }],
  });
  assert.equal(code, 0);
});

test("a stall kills the install and exits with the reserved code", async () => {
  const { code, log } = await superviseNode("setInterval(() => {}, 1000)", {
    // Report the real process table, but with every CPU counter frozen at
    // zero: a tree that is present, alive, and doing nothing.
    sampler: async () => (await psSampler()).map((r) => ({ ...r, cpuSeconds: 0 })),
  });
  assert.equal(code, EXIT_STALLED, "a stall must not be reported as a generic failure");
  assert.notEqual(EXIT_STALLED, 1, "the code must be distinguishable from an ordinary failure");
  assert.match(log, /::error::pnpm install stalled/);
});

test("the kill message names the measured rate, the window, and the way out", async () => {
  const message = renderStallMessage(
    { rate: 0.0129, windowSeconds: 600, cpuSeconds: 7.8 },
    { minCpuRate: 0.05 },
  );
  assert.match(message, /7\.80s of CPU over the last 600s/);
  assert.match(message, /1\.29% of one core/);
  assert.match(message, /below the 5\.00% floor/);
  assert.match(message, /stopped, not slow/);
  assert.match(message, /install-stall-timeout: '0'/);
});

test("an unarmed watchdog says so and runs the install through untouched", async () => {
  const log = [];
  const code = await supervise({
    command: process.execPath,
    args: ["-e", "process.exit(7)"],
    config: resolveConfig({ PNPM_WATCHDOG_STALL_TIMEOUT: "0" }),
    sampler: async () => assert.fail("a disabled watchdog must not sample"),
    log: (m) => log.push(m),
  });
  assert.equal(code, 7);
  assert.match(log.join("\n"), /not armed/);
});

// ---------------------------------------------------------------------------
// AC-2 / AC-5 — real process trees
// ---------------------------------------------------------------------------

// Seconds, not milliseconds: Linux `ps -o time` has one-second resolution, so a
// sub-second window reads a fully-busy tree as idle.
const REAL_TREE = { graceMs: 0, stallTimeoutMs: 2500, sampleIntervalMs: 200 };

/**
 * A parent that produces no output for its whole life and forks a child
 * running `childSrc`. When `pidFile` is given it records its own pid and its
 * child's, so a test can prove afterwards that neither survived.
 */
const silentParent = (childSrc, lifetimeMs, pidFile = null) =>
  `const { spawn } = require("node:child_process");` +
  `const kid = spawn(process.execPath, ["-e", ${JSON.stringify(childSrc)}], { stdio: "ignore" });` +
  (pidFile
    ? `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, process.pid + " " + kid.pid);`
    : "") +
  `setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} process.exit(0); }, ${lifetimeMs});`;

test("a silent parent whose GRANDCHILD burns CPU is not killed", { timeout: 30_000 }, async () => {
  // The central claim: progress is the tree's CPU, not the parent's output.
  // This parent writes nothing at all for its whole life — an output-based
  // watchdog would kill it — while a descendant pins a core.
  const burn = "const end = Date.now() + 8000; while (Date.now() < end) {}";
  const code = await supervise({
    command: process.execPath,
    args: ["-e", silentParent(burn, 4000)],
    config: config({ ...REAL_TREE, minCpuRate: 0.3 }),
    sampler: psSampler,
    log: () => {},
  });
  assert.equal(code, 0, "a tree burning a full core must survive a 30% floor");
});

test("a sleeping tree is killed, and no member of it survives", { timeout: 30_000 }, async () => {
  // Killing the ROOT is not the claim — a grandchild left spinning is exactly
  // the process that goes on holding a self-hosted runner. So the tree records
  // both its pids and the test checks the real process table for each.
  const dir = mkdtempSync(path.join(tmpdir(), "pnpm-watchdog-tree-"));
  const pidFile = path.join(dir, "pids");
  try {
    const sleep = "setTimeout(() => process.exit(0), 60000);";
    const code = await supervise({
      command: process.execPath,
      args: ["-e", silentParent(sleep, 60_000, pidFile)],
      config: config({ ...REAL_TREE, minCpuRate: 0.05 }),
      sampler: psSampler,
      log: () => {},
    });
    assert.equal(code, EXIT_STALLED);

    const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
    assert.equal(pids.length, 2, "expected the fixture to record a parent and a child pid");

    // Give the sweep a moment to land, then assert every member is gone.
    await new Promise((r) => setTimeout(r, 1000));
    const live = new Set((await psSampler()).map((r) => r.pid));
    for (const pid of pids) {
      assert.equal(live.has(pid), false, `pid ${pid} survived the stall kill`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-1 — pnpm receives identical argv, supervised or not
// ---------------------------------------------------------------------------

/**
 * Execute the composite's real `Install dependencies` body against a stub
 * `pnpm` that echoes its argv, and return what the stub saw.
 */
function runInstall(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "pnpm-watchdog-"));
  try {
    const stub = path.join(dir, "pnpm");
    writeFileSync(stub, '#!/bin/sh\necho "PNPM_ARGV: $*"\n');
    chmodSync(stub, 0o755);
    const script = path.join(dir, "install.sh");
    writeFileSync(script, installScript);
    return execFileSync("bash", [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        TRUST_LOCKFILE: "false",
        STORE_DIR_INPUT: "",
        CACHE_ENABLED: "false",
        TOOL_CACHE: "",
        ...env,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const argvOf = (out) => out.match(/PNPM_ARGV: (.*)/)?.[1] ?? null;

test("pnpm receives byte-identical argv armed and disabled, in every combination", () => {
  const actionPath = path.resolve(".github/actions/setup-toolchain");
  const combinations = [
    { CACHE_ENABLED: "false", TOOL_CACHE: "/opt/hostedtoolcache" },
    { CACHE_ENABLED: "true", TOOL_CACHE: "/opt/hostedtoolcache" },
    { CACHE_ENABLED: "false", STORE_DIR_INPUT: "/mnt/fast/store" },
    { CACHE_ENABLED: "false", TOOL_CACHE: "/opt/hostedtoolcache", TRUST_LOCKFILE: "true" },
    { CACHE_ENABLED: "false", STORE_DIR_INPUT: "/mnt/my store" },
  ];
  for (const base of combinations) {
    const disabled = argvOf(runInstall(base));
    const armed = argvOf(
      runInstall({
        ...base,
        ACTION_PATH: actionPath,
        PNPM_WATCHDOG_STALL_TIMEOUT: "600",
        PNPM_WATCHDOG_GRACE: "120",
        PNPM_WATCHDOG_MIN_CPU_RATE: "0.05",
        // Never sample in a unit test: the point here is argv, and a real
        // sampler would make this suite depend on host process state.
        PNPM_WATCHDOG_SAMPLE_INTERVAL: "3600",
      }),
    );
    assert.notEqual(disabled, null, `no argv captured for ${JSON.stringify(base)}`);
    assert.equal(armed, disabled, `argv drifted for ${JSON.stringify(base)}`);
  }
});

test("an empty ACTION_PATH falls back to the unsupervised install", () => {
  // A watchdog that cannot be located must not be able to fail the install it
  // was only meant to watch.
  const out = runInstall({
    ACTION_PATH: "",
    PNPM_WATCHDOG_STALL_TIMEOUT: "600",
    TOOL_CACHE: "/opt/hostedtoolcache",
  });
  assert.equal(argvOf(out), "install --frozen-lockfile --store-dir /opt/hostedtoolcache/pnpm-store");
});

// ---------------------------------------------------------------------------
// AC-6 — the knobs are reachable end-to-end, and never reach the shell as text
// ---------------------------------------------------------------------------

const KNOBS = ["install-stall-timeout", "install-stall-grace", "install-min-cpu-rate"];

/**
 * Whether `text` has a line that is exactly `line`.
 *
 * Deliberately not a constructed `RegExp`: a non-literal pattern is refused by
 * this repo's SAST rules — test files included — and an indentation-sensitive
 * YAML key is clearer as an exact line match anyway.
 */
const hasLine = (text, line) => text.split("\n").includes(line);

/** The value of the first `key: value` line at `indent`, or null. */
const inputDefaultAfter = (text, key, indent) => {
  const lines = text.split("\n");
  const start = lines.indexOf(`${" ".repeat(indent)}${key}:`);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("default:")) return trimmed.slice("default:".length).trim();
    // A sibling key at or above this indent ends the block.
    if (trimmed !== "" && lines[i].search(/\S/) <= indent) return null;
  }
  return null;
};

test("setup-toolchain declares every knob with the documented default", () => {
  for (const knob of KNOBS) {
    assert.ok(hasLine(actionText, `  ${knob}:`), `action input ${knob} is missing`);
  }
  assert.equal(inputDefaultAfter(actionText, "install-stall-timeout", 2), "'600'");
  assert.equal(inputDefaultAfter(actionText, "install-stall-grace", 2), "'120'");
  assert.equal(inputDefaultAfter(actionText, "install-min-cpu-rate", 2), "'0.05'");
});

test("pr-quality declares each knob as a workflow_call input with a LITERAL default", () => {
  for (const knob of KNOBS) {
    assert.ok(hasLine(workflowText, `      ${knob}:`), `workflow input ${knob} missing`);
  }
  for (const knob of KNOBS) {
    const value = inputDefaultAfter(workflowText, knob, 6);
    assert.notEqual(value, null, `${knob} has no default`);
    // An Actions expression in a workflow_call default is never evaluated — it
    // reaches the callee as the literal text `${{ ... }}`.
    assert.doesNotMatch(value, /\$\{\{/, `a workflow_call default must be a literal: ${value}`);
  }
  assert.equal(inputDefaultAfter(workflowText, "install-stall-timeout", 6), "'600'");
  assert.equal(inputDefaultAfter(workflowText, "install-stall-grace", 6), "'120'");
  assert.equal(inputDefaultAfter(workflowText, "install-min-cpu-rate", 6), "'0.05'");
});

test("every setup-toolchain call site forwards every knob", () => {
  // One anchor, aliased by the other tiers — so threading it once must reach
  // them all, and a NEW call site that forgets a knob must fail here.
  const lines = workflowText.split("\n");
  const sites = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes("actions/setup-toolchain@"));
  assert.equal(sites.length, 1, "expected exactly one setup-toolchain call site (the anchor)");

  // The call site's `with:` block: from the `uses:` line to the first line that
  // dedents OUT of the step. `with:` is a sibling of `uses:` at the same indent,
  // so the boundary is a strict dedent — the next step's bullet.
  const usesIndent = lines[sites[0].i].search(/\S/);
  const block = [];
  for (let i = sites[0].i + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && lines[i].search(/\S/) < usesIndent) break;
    block.push(lines[i]);
  }
  for (const knob of KNOBS) {
    assert.ok(
      block.some((line) => line.trim() === `${knob}: \${{ inputs.${knob} }}`),
      `the setup-toolchain call site does not forward ${knob}`,
    );
  }
  assert.ok(
    lines.filter((line) => line === "      - *setup-toolchain").length > 0,
    "expected the setup-toolchain anchor to be aliased by the other tiers",
  );
});

test("no caller value is interpolated into the install step's run body", () => {
  // rules/security-baseline.md: a caller-supplied value reaches the shell as an
  // environment variable and nothing else. An interpolated one is workflow TEXT
  // — it is substituted before bash ever sees it, so no amount of quoting in
  // the body can contain it.
  assert.doesNotMatch(installScript, /\$\{\{/, "the install run body must be expression-free");
  const stepBlock = stepByName(actionText, "Install dependencies");
  for (const knob of KNOBS) {
    assert.ok(stepBlock.includes(`inputs['${knob}']`), `${knob} does not reach the step via env:`);
  }
  assert.match(stepBlock, /ACTION_PATH: \$\{\{ github\.action_path \}\}/);
});

// ---------------------------------------------------------------------------
// AC-7 — the documentation a caller actually reads
// ---------------------------------------------------------------------------

test("reusable-workflows.md documents the knobs in the inputs table and in prose", () => {
  const docs = readFileSync(DOCS, "utf8");
  for (const knob of KNOBS) {
    assert.ok(docs.includes(`\`${knob}\``), `${knob} is undocumented`);
  }
  assert.ok(docs.includes("install-stall-timeout: '0'"), "the off switch is undocumented");
  assert.ok(docs.includes("34876024126"), "the measured incident is not cited");
  assert.ok(docs.includes("still fails"), "the docs must not imply a supervised stall turns green");
});
