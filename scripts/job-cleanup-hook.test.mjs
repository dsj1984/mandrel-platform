#!/usr/bin/env node
/**
 * job-cleanup-hook.test.mjs — node:test suite for the ACTIONS_RUNNER_HOOK_JOB_STARTED
 * hook shipped at `templates/runner/job-cleanup.sh` (Story #345).
 *
 * The hook runs INSIDE the job's clock on every job of every persistent
 * self-hosted runner, so its cost is charged to `Set up runner` and a slow
 * hook kills jobs against their own `timeout-minutes`. Issue #343 is exactly
 * that failure: the hook enumerated the shared OS temp root, which had reached
 * 841,690 entries on the swarm-os host, and `Set up runner` reached 5m29s.
 *
 * The load-bearing property this suite pins is therefore a NEGATIVE one — the
 * hook must never read the shared temp root — and it is asserted two ways,
 * because neither alone is sufficient:
 *
 *   1. Behaviourally: a decoy shared temp root is planted with entries that
 *      match the old sweep's patterns, and the hook must leave every one of
 *      them alone. This catches a sweep that still deletes there.
 *   2. Structurally: the script text must contain no enumeration rooted at the
 *      shared temp root. This catches a sweep that reads the directory but
 *      happens to delete nothing — the exact shape of the #343 stall, which
 *      was pure cost with no observable effect.
 *
 * A wall-clock assertion was deliberately NOT used for (2): the cost is a
 * function of host churn, so on a clean dev machine a full enumeration of a
 * small decoy root is fast and would pass. Timing here would be a test that
 * only fails on the machine that least needs it.
 *
 * The suite executes the real script with env fixtures, following the
 * `scripts/resolve-diff-range.test.mjs` precedent for shell-under-test.
 *
 * Run: node --test scripts/job-cleanup-hook.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, after } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "templates", "runner", "job-cleanup.sh");

/** Sandboxes created by the suite, torn down in `after`. */
const SANDBOXES = [];

after(() => {
  for (const dir of SANDBOXES) {
    // Restore any permissions the unwritable-temp case removed, or the
    // recursive delete cannot descend.
    try {
      chmodSync(join(dir, "runner", "_work", "_temp"), 0o755);
    } catch {
      /* not every sandbox has one */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a sandbox holding a synthetic runner root and a decoy shared temp root.
 *
 * @param {{ sharedEntries?: number }} [opts]
 * @returns {{ root: string, runnerDir: string, runnerTmp: string, sharedTmp: string }}
 */
function makeSandbox({ sharedEntries = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "job-cleanup-test-"));
  SANDBOXES.push(root);

  const runnerDir = join(root, "runner");
  const runnerTmp = join(runnerDir, "_work", "_temp");
  const sharedTmp = join(root, "shared-tmp");
  mkdirSync(runnerTmp, { recursive: true });
  mkdirSync(join(runnerDir, "_work", "_tool"), { recursive: true });
  mkdirSync(sharedTmp, { recursive: true });

  // The decoy shared root carries entries matching BOTH the retired sweep's
  // patterns and the current runner-scoped ones, so a sweep that kept the old
  // root or reused the new globs against it is caught either way.
  writeFileSync(join(sharedTmp, "gitleaks.tmp"), "decoy");
  mkdirSync(join(sharedTmp, "gitleaks-8.30.1"), { recursive: true });
  mkdirSync(join(sharedTmp, "gitleaks.AbCdEf"), { recursive: true });
  mkdirSync(join(sharedTmp, "osv-scanner.AbCdEf"), { recursive: true });
  for (let i = 0; i < sharedEntries; i += 1) {
    writeFileSync(join(sharedTmp, `unrelated-${i}.tmp`), "x");
  }

  return { root, runnerDir, runnerTmp, sharedTmp };
}

/**
 * Run the hook against a sandbox.
 *
 * @param {{ runnerDir: string, sharedTmp: string }} sandbox
 * @returns {{ status: number, stdout: string }}
 */
function runHook({ runnerDir, sharedTmp }) {
  try {
    const stdout = execFileSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_DIR: runnerDir, TMPDIR: sharedTmp },
      timeout: 60_000,
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "" };
  }
}

test("removes this runner's own stale tool-download and pnpm-shim leftovers", () => {
  const sandbox = makeSandbox();
  const { runnerTmp } = sandbox;

  // Every artifact the platform's actions now extract into runner.temp.
  const owned = [
    join(runnerTmp, "pnpm"),
    join(runnerTmp, "setup-pnpm"),
    join(runnerTmp, "gitleaks.AbCdEf"),
    join(runnerTmp, "osv-scanner.AbCdEf"),
    join(runnerTmp, "semgrep.AbCdEf"),
  ];
  for (const dir of owned) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "leftover"), "stale");
  }
  writeFileSync(join(runnerTmp, "gh-api-err.AbCdEf"), "stale");

  const { status } = runHook(sandbox);
  assert.equal(status, 0, "the hook must never fail a job");

  for (const dir of owned) {
    assert.equal(existsSync(dir), false, `runner-owned leftover not swept: ${dir}`);
  }
  assert.equal(existsSync(join(runnerTmp, "gh-api-err.AbCdEf")), false);
});

test("leaves the shared temp root untouched even when it is large", () => {
  // 5,000 entries stands in for the 841,690 observed on the swarm-os host —
  // enough that an accidental enumeration is real work, small enough to plant
  // quickly. The assertion is on effect, not duration.
  const sandbox = makeSandbox({ sharedEntries: 5000 });
  const { sharedTmp } = sandbox;

  const before = readdirSync(sharedTmp).sort();
  const { status } = runHook(sandbox);

  assert.equal(status, 0);
  assert.deepEqual(
    readdirSync(sharedTmp).sort(),
    before,
    "the hook deleted from the shared temp root — it must only sweep runner-owned paths",
  );
});

test("the script text contains no enumeration rooted at the shared temp root", () => {
  const source = readFileSync(SCRIPT, "utf8");

  // A `find` over the shared root is the #343 defect itself: unbounded cost,
  // charged to the job, hunting names the platform never creates.
  assert.equal(
    /find\s+"\$\{TMP[^R]/.test(source),
    false,
    "the hook enumerates the shared temp root — cost must scale with runner-owned state only",
  );

  // The age gate existed solely to make deleting from the SHARED root safe.
  // Runner-scoped paths are unreachable by a co-resident runner, so a
  // surviving knob would be dead configuration the runbook still promises.
  assert.equal(
    source.includes("JOB_CLEANUP_STALE_MINUTES"),
    false,
    "the retired age-gate knob is still referenced",
  );
});

test("exits 0 when the runner directory does not exist", () => {
  const sandbox = makeSandbox();
  const { status } = runHook({
    runnerDir: join(sandbox.root, "no-such-runner"),
    sharedTmp: sandbox.sharedTmp,
  });
  assert.equal(status, 0, "a missing runner root must degrade to a no-op, never fail the job");
});

test("exits 0 when the runner temp is unwritable", () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.runnerTmp, "gitleaks.AbCdEf"), { recursive: true });
  chmodSync(sandbox.runnerTmp, 0o500);

  const { status } = runHook(sandbox);
  assert.equal(status, 0, "an unwritable runner temp must not fail the job");
});
