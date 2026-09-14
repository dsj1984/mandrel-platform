#!/usr/bin/env node
/**
 * job-completed-hook.test.mjs — node:test suite for the
 * ACTIONS_RUNNER_HOOK_JOB_COMPLETED hook shipped at
 * `templates/runner/job-completed.sh` (Story #524).
 *
 * WHAT THE HOOK IS FOR
 *
 * On a persistent self-hosted runner, a job's process tree can outlive the
 * job — most reliably when the job is CANCELLED, because the runner
 * terminates the step it is executing, not everything that step forked. The
 * job-started hook (`job-cleanup.sh`) reaps a previous job's orphans before
 * the next job begins, which cannot help a job that is already minutes in:
 * consumer run 34854313590 saw a `Unit` job die of an unexplained SIGTERM two
 * minutes into a 32-minute budget on a runner that had hosted a cancelled job
 * four minutes earlier. This hook closes that gap from the other end.
 *
 * WHAT THIS SUITE PINS, AND WHY EACH HALF IS NECESSARY
 *
 *   1. It reaps — including the leaves. A job's `sleep`/worker fork carries no
 *      runner path in its own argv, so a hook that matched only on the path
 *      would leave exactly the long-lived children that cause the incident.
 *      The in-tree fixture therefore spawns a grandchild whose command line
 *      names nothing runner-scoped.
 *   2. It reaps NOTHING ELSE. Three controls stand in for the three ways a
 *      too-broad reap takes down a co-resident runner: a sibling runner's job,
 *      a process outside any runner tree, and a `$HOME`-shared
 *      `setup-pnpm` process (the shape issue #343 warned about). A fourth
 *      control is a process named `Runner.Worker` sitting INSIDE this runner's
 *      own work tree — it matches the seed pattern and must still survive,
 *      because signalling it takes the runner offline.
 *   3. It cannot kill itself. The hook is executed from a copy INSIDE the
 *      runner's `_work` tree, so its own command line matches the seed
 *      pattern. Without the self/ancestor guard it would signal itself, and
 *      the job would see a hook that died rather than exited 0.
 *   4. Idle is free. The invariant is that the hook finishes in well under a
 *      second when there is nothing to reap. That is asserted as wall clock
 *      *because the regression it guards against is temporal*: a grace period
 *      slept unconditionally rather than polled would put the hook's full
 *      3-second budget on the job's clock on every job of every runner. The
 *      threshold sits far below that budget and far above the ~100ms a bash
 *      start plus two `ps` calls costs, so it separates the two without
 *      timing anything finer.
 *
 * The suite executes the real script, following the
 * `scripts/job-cleanup-hook.test.mjs` precedent for shell-under-test, and
 * resolves its interpreter the way `scripts/runner-env-drift.test.mjs` does:
 * the fleet is macOS, where `/bin/bash` is 3.2, and a suite that inherits a
 * PATH `bash` cannot say what its passes prove.
 *
 * Run: node --test scripts/job-completed-hook.test.mjs
 *      RUNNER_KIT_BASH=/bin/bash node --test scripts/job-completed-hook.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "templates", "runner", "job-completed.sh");
const ENV_EXAMPLE = join(HERE, "..", "templates", "runner", ".env.example");
const RUNBOOK = join(HERE, "..", "templates", "runbooks", "runner-provisioning.md");

/** Sandboxes created by the suite, torn down in `after`. */
const SANDBOXES = [];
/** Every process the suite started, so a failed assertion never leaks one. */
const SPAWNED = [];

after(() => {
  for (const pid of SPAWNED) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone — the point of most of these tests */
    }
  }
  for (const dir of SANDBOXES) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Resolve the interpreter the execution tests run under. `/bin/bash` is
 * preferred because the fleet's shell is the stricter 3.2; `RUNNER_KIT_BASH`
 * overrides for a deliberate cross-check (the `runner-kit-bash32` CI job).
 *
 * @returns {{ cmd: string, banner: string }}
 */
function resolveBash() {
  const candidates = process.env.RUNNER_KIT_BASH ? [process.env.RUNNER_KIT_BASH] : ["/bin/bash", "bash"];
  for (const cmd of candidates) {
    try {
      const banner = execFileSync(cmd, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
      return { cmd, banner };
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`no usable bash interpreter (tried ${candidates.join(", ")}) — this suite executes a shell script`);
}

const BASH = resolveBash();

/** A fixture that forks a child whose OWN argv names nothing runner-scoped. */
const TREE_FIXTURE = ['#!/usr/bin/env bash', 'sleep 300 &', 'printf "%s\\n" "$!" > "$1"', "wait", ""].join("\n");

/** A fixture that ignores SIGTERM, so only the SIGKILL escalation ends it. */
const STUBBORN_FIXTURE = [
  "process.on('SIGTERM', () => {});",
  "setTimeout(() => {}, 300_000);",
  "",
].join("\n");

/**
 * Build a sandbox holding this runner, a co-resident runner, an out-of-tree
 * directory and a `$HOME`-shared pnpm shim location.
 *
 * @returns {{ root: string, runnerDir: string, runnerWork: string }}
 */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "job-completed-test-"));
  SANDBOXES.push(root);

  const runnerDir = join(root, "runner-a");
  const runnerWork = join(runnerDir, "_work");
  for (const dir of [
    join(runnerWork, "repo"),
    join(runnerWork, "_temp"),
    join(root, "runner-b", "_work", "repo"),
    join(root, "outside"),
    join(root, "home", "setup-pnpm", "node_modules"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  return { root, runnerDir, runnerWork };
}

/**
 * Write a fixture script and start it, returning its pid plus a promise that
 * settles when the process actually exits.
 *
 * @param {string} scriptPath — where to write the fixture
 * @param {{ body?: string, node?: boolean, pidFile?: string }} [opts]
 * @returns {{ pid: number, exited: Promise<void> }}
 */
function startFixture(scriptPath, { body = TREE_FIXTURE, node = false, pidFile } = {}) {
  writeFileSync(scriptPath, body);
  const child = node
    ? spawn(process.execPath, [scriptPath], { stdio: "ignore" })
    : spawn(BASH.cmd, [scriptPath, pidFile ?? `${scriptPath}.pid`], { stdio: "ignore" });
  SPAWNED.push(child.pid);
  return {
    pid: child.pid,
    exited: new Promise((resolve) => child.once("exit", () => resolve())),
  };
}

/**
 * Poll until a predicate holds or the budget expires.
 *
 * @param {() => boolean} predicate
 * @param {number} [budgetMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/**
 * True while a pid exists. A zombie still answers signal 0, so this is only
 * ever used for processes the suite did not parent (grandchildren, reaped by
 * init) or alongside a child's own `exit` event.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the pid a tree fixture recorded for its forked grandchild. */
async function readGrandchildPid(pidFile) {
  await waitFor(() => existsSync(pidFile));
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `fixture never recorded its child pid at ${pidFile}`);
  SPAWNED.push(pid);
  return pid;
}

/**
 * Run the hook against a runner root.
 *
 * @param {{ runnerDir: string, scriptPath?: string }} opts
 * @returns {{ status: number|null, signal: string|null, stdout: string, stderr: string, elapsedMs: number }}
 */
function runHook({ runnerDir, scriptPath = SCRIPT }) {
  const started = Date.now();
  const res = spawnSync(BASH.cmd, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, RUNNER_DIR: runnerDir },
    timeout: 60_000,
  });
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    elapsedMs: Date.now() - started,
  };
}

test("AC-1: the shipped hook is executable", () => {
  // The runbook's kit-copy step chmods it, but a template that ships 100644 is
  // a live defect class in this repo (scripts/check-husky-hook-modes.test.mjs)
  // and an operator who copies with `cp -p` inherits the bad mode.
  assert.equal((statSync(SCRIPT).mode & 0o100) !== 0, true, "templates/runner/job-completed.sh must ship executable");
});

test("AC-1: reaps this job's surviving tree, including a child whose argv names no runner path", async () => {
  const { runnerWork, runnerDir } = makeSandbox();
  const fixture = join(runnerWork, "repo", "job-tree.sh");
  const pidFile = join(runnerWork, "repo", "child.pid");
  const parent = startFixture(fixture, { pidFile });
  const grandchild = await readGrandchildPid(pidFile);

  const { status, signal, stdout } = runHook({ runnerDir });

  assert.equal(status, 0, `the hook must exit 0 (signal=${signal}) — it must never fail a job`);
  await parent.exited;
  assert.equal(
    await waitFor(() => !isAlive(grandchild)),
    true,
    "the forked grandchild survived — matching only on the runner path leaves the leaves of the tree behind",
  );
  assert.match(stdout, /reaping processes that outlived this job/, "a reap must be attributable in the job log");
});

test("AC-4: leaves a co-resident runner, an out-of-tree process and a $HOME-shared process alone", async () => {
  const { root, runnerDir, runnerWork } = makeSandbox();

  // The victim: without one, an inert hook would pass this test vacuously.
  const victimPidFile = join(runnerWork, "repo", "victim.pid");
  const victim = startFixture(join(runnerWork, "repo", "victim.sh"), { pidFile: victimPidFile });
  const victimChild = await readGrandchildPid(victimPidFile);

  const controls = {
    "co-resident runner": startFixture(join(root, "runner-b", "_work", "repo", "sibling.sh")),
    "out of any runner tree": startFixture(join(root, "outside", "unrelated.sh")),
    // `~/setup-pnpm` is pnpm/action-setup's DEFAULT dest and is shared by every
    // runner on the host — the exact process a pattern kill would destroy
    // mid-install on a concurrent runner (issue #343).
    "$HOME-shared setup-pnpm": startFixture(join(root, "home", "setup-pnpm", "node_modules", "pnpm.sh")),
    // Inside THIS runner's work tree, so it matches the seed pattern — and
    // must still survive, because signalling the runner ends the job's own
    // bookkeeping.
    "the runner's own Runner.Worker": startFixture(join(runnerWork, "_temp", "Runner.Worker")),
  };

  const { status } = runHook({ runnerDir });
  assert.equal(status, 0);

  await victim.exited;
  assert.equal(await waitFor(() => !isAlive(victimChild)), true, "the in-tree victim was not reaped");

  for (const [what, control] of Object.entries(controls)) {
    assert.equal(isAlive(control.pid), true, `the hook killed a process it must never touch: ${what}`);
  }
});

test("AC-1: exits 0 and returns fast when nothing survived the job", () => {
  const { runnerDir } = makeSandbox();

  const { status, stdout, elapsedMs } = runHook({ runnerDir });

  assert.equal(status, 0);
  assert.match(stdout, /nothing to reap/, "the no-op case must still say so in the job log");
  assert.ok(
    elapsedMs < 1500,
    `an idle run took ${elapsedMs}ms — it runs on the job's clock, so the grace period must be polled, never slept unconditionally`,
  );
});

test("escalates to SIGKILL when the tree ignores SIGTERM", async () => {
  const { runnerWork, runnerDir } = makeSandbox();
  const stubborn = startFixture(join(runnerWork, "repo", "stubborn.mjs"), { body: STUBBORN_FIXTURE, node: true });
  // Let node install its SIGTERM handler before the hook fires, or the test
  // would pass through the SIGTERM path and prove nothing about escalation.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const { status, stdout } = runHook({ runnerDir });

  assert.equal(status, 0);
  await stubborn.exited;
  assert.match(stdout, /escalating to SIGKILL/, "a tree that ignores SIGTERM must be escalated, and the log must say so");
});

test("AC-4: cannot signal itself even when its own command line sits inside the work tree", async () => {
  const { runnerWork, runnerDir } = makeSandbox();
  const pidFile = join(runnerWork, "repo", "bystander.pid");
  const victim = startFixture(join(runnerWork, "repo", "bystander.sh"), { pidFile });
  await readGrandchildPid(pidFile);

  // Installed INSIDE the work tree, so the hook's own argv matches its seed
  // pattern. The self/ancestor guard is the only thing between that and a hook
  // that SIGKILLs itself mid-run — which the job sees as a hook that failed.
  const installed = join(runnerWork, "hook-copy-job-completed.sh");
  mkdirSync(dirname(installed), { recursive: true });
  copyFileSync(SCRIPT, installed);

  const { status, signal, stdout } = runHook({ runnerDir, scriptPath: installed });

  assert.equal(signal, null, "the hook signalled itself");
  assert.equal(status, 0, "the hook must exit 0 even when its own path matches the reap pattern");
  await victim.exited;
  assert.match(stdout, /reaping processes that outlived this job/, "self-protection must not disable the reap");
});

test("AC-4: the header states the concurrency-safety constraints it inherits", () => {
  // AC-4 requires the constraints to be STATED, not only honoured: the next
  // maintainer's reason not to reach for `pkill -f ~/setup-pnpm` lives here,
  // and the behavioural controls above cannot carry that rationale.
  const source = readFileSync(SCRIPT, "utf8");
  const header = source.split("\nset -u")[0];

  assert.match(header, /setup-pnpm/, "the header must name the $HOME-shared path it refuses to touch");
  assert.match(header, /TMPDIR/, "the header must name the shared temp scan it refuses to do");
  assert.match(header, /RUNNER_DIR/, "the header must state that every path derives from RUNNER_DIR");
  assert.match(header, /Runner\.(Worker|Listener)/, "the header must state that the runner's own processes are excluded");
  assert.match(header, /#343/, "the header must cite the incident the constraints came from");
  assert.match(header, /job-cleanup\.sh/, "the header must say why a second hook exists beside the job-started one");
});

test("AC-4: the code honours those constraints structurally", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  // Same property job-cleanup.sh pins: the hook has no legitimate use for the
  // shared temp root, and naming it is necessary to reach it.
  assert.equal(/TMPDIR/.test(code), false, "the hook references the shared temp root");
  assert.equal(/setup-pnpm/.test(code), false, "the hook targets a $HOME-shared pnpm path");
  assert.equal(/\bfind\b/.test(code), false, "the hook enumerates a directory — its only input must be one ps snapshot");
  // `pkill -f` cannot exclude this script, its ancestors, or a co-resident
  // runner's lookalike, and its matching differs across macOS and Linux.
  assert.equal(/\bpkill\b/.test(code), false, "the hook uses a pattern kill instead of explicit, filtered pids");
  // bash 3.2 is the fleet's interpreter; each of these fails as a SYNTAX error
  // at the operator's first real job, not as a wrong answer in CI.
  assert.equal(/declare\s+-A/.test(code), false, "associative arrays are bash 4+");
  assert.equal(/\bmapfile\b|\breadarray\b/.test(code), false, "mapfile/readarray are bash 4+");
  assert.equal(/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/.test(code), false, "case-conversion expansion is bash 4+");
});

test("AC-3: the kit and the runbook wire the completed hook beside the started one", () => {
  // `assert.ok` rather than `assert.match`: a failing `match` would print the
  // whole runbook and bury the one line that is wrong.
  const runbook = readFileSync(RUNBOOK, "utf8");
  const envExample = readFileSync(ENV_EXAMPLE, "utf8");

  assert.ok(
    /^\s*ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/m.test(envExample),
    "`.env.example` is the file the runbook copies onto a runner — the wiring has to be in it",
  );
  assert.ok(
    /cp .*templates\/runner\/job-completed\.sh/.test(runbook),
    "an operator following the runbook must end up with the hook on the host",
  );
  assert.ok(
    /chmod \+x .*job-completed\.sh/.test(runbook),
    "the runbook must chmod the hook — a non-executable hook is silently skipped by the runner",
  );
  assert.ok(
    /ACTIONS_RUNNER_HOOK_JOB_COMPLETED=<RUNNER_DIR>\/job-completed\.sh/.test(runbook),
    "the runbook must show the `.env` line, not just the copy",
  );
  assert.ok(
    /why both hooks/i.test(runbook),
    "the runbook must explain why a runner needs both hooks, or the next operator installs one of them",
  );
});
