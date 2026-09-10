#!/usr/bin/env node
/**
 * runner-toggle.test.mjs — node:test suite for the operator scale tool shipped
 * at `docs/runbooks/runner-toggle.sh` (Story #492).
 *
 * WHAT THIS SUITE IS FOR
 *
 * The tool's one destructive action is `svc.sh stop`, a bare `launchctl unload`
 * that CANCELS whatever job the runner is running. The only thing standing
 * between a scale-down and a cancelled job is `is_busy`, so `is_busy` being
 * right is the whole safety story — and until this suite existed, nothing in
 * CI executed a line of this script.
 *
 * The bug it was written against: `is_busy` was `pgrep -qf "$1/bin/Runner.Worker"`,
 * and `pgrep -f`'s pattern is an extended REGEX over the process table, not a
 * path. A fleet path holding `+`, `(` or `[` therefore matched the wrong set of
 * processes in BOTH directions, and the suite pins both because only one of
 * them is loud:
 *
 *   • The literal path `…/rnr+x(1)/bin/Runner.Worker` does NOT match the regex
 *     built from that same path (`r+` is "one or more r", `(1)` is a group), so
 *     a genuinely busy runner read as idle — and a scale-down cancelled a
 *     running job with no prompt at all. This is the silent, dangerous one.
 *   • That regex DOES match `…/rnrx1/bin/Runner.Worker`, a different runner, so
 *     an idle runner read as busy and the operator was asked to wait for a job
 *     that did not exist.
 *
 * `canary: the old regex form really did confuse these two paths` asserts that
 * property directly against bash's own ERE engine, so the fixture pair below
 * can never quietly stop being a regex-vs-literal discriminator.
 *
 * A `ps … | grep -F "$needle"` pipeline is the obvious-looking fix and is worse
 * than the bug: grep's own command line contains the needle, so it matches
 * itself and reports EVERY runner as busy — and a stubbed `ps` fixture would
 * not catch it, because the stub's table has no grep line in it. That is why
 * the implementation is a pure-bash `case` and why `no grep/pgrep survives in
 * the busy path` is a source scan rather than an execution test.
 *
 * HOW THE REAL FUNCTION IS EXERCISED
 *
 * The script SOURCES cleanly — everything below its `BASH_SOURCE[0] == $0`
 * guard is the interactive body — so these tests call the shipped `is_busy`
 * itself rather than a copy: no prompt, no launchd, no fleet on disk. `ps` is
 * resolved from PATH, so a stub script earlier on PATH supplies the process
 * table. Nothing here mutates the machine, and no test needs a real runner.
 *
 * INTERPRETER COVERAGE
 *
 * The fleet is macOS, where `/bin/bash` is 3.2 (Apple cannot ship a GPL3 bash),
 * so `resolveBash()` follows `runner-env-drift.test.mjs`: prefer `/bin/bash`,
 * fall back to PATH `bash`, override with `RUNNER_KIT_BASH`, and report which
 * one actually ran. `ci.yml`'s `runner-kit-bash32` job pins `/bin/bash` and
 * also runs `bash -n` over the script, so a 3.2-only syntax regression surfaces
 * in CI rather than at an operator's prompt.
 *
 * Run: node --test scripts/runner-toggle.test.mjs
 *      RUNNER_KIT_BASH=/bin/bash node --test scripts/runner-toggle.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "docs", "runbooks", "runner-toggle.sh");
const RUNBOOK = join(HERE, "..", "docs", "runbooks", "runner-fleet.md");
const CI_WORKFLOW = join(HERE, "..", ".github", "workflows", "ci.yml");

/**
 * The fixture pair the regex bug turned on. `METACHAR_ROOT` is a real fleet
 * path shape (a folder name with `+` and parentheses in it); `DECOY_ROOT` is
 * the DIFFERENT path that the regex built from `METACHAR_ROOT` happens to
 * match. They differ only in those metacharacters.
 */
const FLEET = "/Users/ci/github-runners/beestera-runners";
const METACHAR_ROOT = `${FLEET}/rnr+x(1)`;
const DECOY_ROOT = `${FLEET}/rnrx1`;

/** A worker command line as the runner really spawns it: full path, then args. */
const worker = (root) => `${root}/bin/Runner.Worker spawnclient 110 113`;
/** The always-on listener — present for every loaded runner, busy or not. */
const listener = (root) => `${root}/bin/Runner.Listener run --startuptype service`;

/** Sandboxes created by the suite, torn down in `after`. */
const SANDBOXES = [];

after(() => {
  for (const dir of SANDBOXES) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Resolve the interpreter every execution test runs under, and record WHICH
 * one. Bare `bash` from PATH silently varies by host (3.2 on a stock Mac, 5.x
 * on ubuntu), so a suite that inherits it cannot say what its passes prove.
 *
 * @returns {{ cmd: string, banner: string, major: number|null }}
 */
function resolveBash() {
  const candidates = process.env.RUNNER_KIT_BASH ? [process.env.RUNNER_KIT_BASH] : ["/bin/bash", "bash"];
  for (const cmd of candidates) {
    let banner;
    try {
      banner = execFileSync(cmd, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
    } catch {
      continue;
    }
    const m = /version (\d+)\./.exec(banner);
    return { cmd, banner, major: m ? Number(m[1]) : null };
  }
  throw new Error(`no usable bash interpreter (tried ${candidates.join(", ")}) — this suite executes a shell script`);
}

const BASH = resolveBash();

/**
 * Build a directory holding a stub `ps`, to be prepended to PATH.
 *
 * The stub ignores its arguments and prints `lines` — that is the whole process
 * table as far as the script is concerned. `fail: true` makes it exit non-zero
 * instead, which is how the "unreadable process table" path is driven.
 *
 * @param {string[]} lines
 * @param {{ fail?: boolean }} [opts]
 * @returns {string} absolute bin directory
 */
function stubPs(lines, opts = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "runner-toggle-"));
  SANDBOXES.push(sandbox);
  const binDir = join(sandbox, "bin");
  mkdirSync(binDir, { recursive: true });

  // A quoted heredoc: the table is emitted verbatim, metacharacters and all.
  const body = opts.fail
    ? '#!/bin/sh\necho "ps: fixture failure" >&2\nexit 1\n'
    : `#!/bin/sh\ncat <<'PS_TABLE_EOF'\n${lines.join("\n")}\nPS_TABLE_EOF\n`;
  const stub = join(binDir, "ps");
  writeFileSync(stub, body);
  chmodSync(stub, 0o755);
  return binDir;
}

/**
 * Source the shipped script and call the real `is_busy` for `root`, with the
 * process table supplied by a stub `ps` on PATH.
 *
 * `$0` is the probe name rather than the script, so `BASH_SOURCE[0] == $0` is
 * false and the interactive body stays asleep.
 *
 * @param {string} root — the runner directory to ask about
 * @param {string[]} table — stub `ps` output
 * @param {{ fail?: boolean }} [opts]
 * @returns {{ verdict: string, status: number, stdout: string, stderr: string }}
 */
function probeIsBusy(root, table, opts = {}) {
  const binDir = stubPs(table, opts);
  const res = spawnSync(
    BASH.cmd,
    [
      "-c",
      '. "$1"; if is_busy "$2"; then echo BUSY; else echo IDLE; fi',
      "runner-toggle-probe",
      SCRIPT,
      root,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      input: "",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    },
  );
  const stdout = res.stdout ?? "";
  return {
    verdict: stdout.trim().split("\n").pop() ?? "",
    status: res.status ?? 1,
    stdout,
    stderr: res.stderr ?? "",
  };
}

/** The script source with whole-line comments stripped — for source scans. */
function sourceWithoutComments() {
  return readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** The body of the `is_busy` function, comments included. */
function isBusyBody() {
  const source = readFileSync(SCRIPT, "utf8");
  const start = source.indexOf("is_busy() {");
  assert.notEqual(start, -1, "is_busy must still be a named function — the test sources and calls it");
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "could not find the end of is_busy");
  return source.slice(start, end);
}

test("AC-1: a busy runner whose path holds regex metacharacters reports BUSY", () => {
  // The dangerous direction. Under the old `pgrep -f` form this answered IDLE,
  // and a scale-down then cancelled a running job without ever prompting.
  const { verdict, stderr } = probeIsBusy(METACHAR_ROOT, [
    "/sbin/launchd",
    listener(METACHAR_ROOT),
    worker(METACHAR_ROOT),
    listener(DECOY_ROOT),
  ]);

  assert.equal(verdict, "BUSY", `a runner with its own Runner.Worker in the table is busy\nstderr: ${stderr}`);
});

test("AC-1: a different runner matching only as a regex reports IDLE", () => {
  // The loud direction: the table holds a worker for DECOY_ROOT alone, which
  // the regex built from METACHAR_ROOT matches and a literal comparison does
  // not. Answering BUSY here would block a legitimate scale-down and make the
  // operator wait for a job that is not theirs.
  const { verdict, stderr } = probeIsBusy(METACHAR_ROOT, [
    "/sbin/launchd",
    listener(METACHAR_ROOT),
    worker(DECOY_ROOT),
  ]);

  assert.equal(verdict, "IDLE", `only the exact worker path counts as busy\nstderr: ${stderr}`);
});

test("canary: the old regex form really did confuse these two paths", () => {
  // Guards the fixture pair itself. If a later edit made METACHAR_ROOT and
  // DECOY_ROOT stop being a regex-vs-literal discriminator, the two tests above
  // would keep passing while proving nothing. Asserted against bash's own ERE
  // engine — the same one `pgrep -f` uses — rather than a JS approximation.
  const res = spawnSync(
    BASH.cmd,
    [
      "-c",
      'if [[ "$1" =~ $2 ]]; then echo DECOY_MATCHES; else echo decoy-no; fi\n' +
        'if [[ "$3" =~ $2 ]]; then echo real-yes; else echo REAL_MISSES; fi',
      "regex-canary",
      worker(DECOY_ROOT),
      `${METACHAR_ROOT}/bin/Runner.Worker`,
      worker(METACHAR_ROOT),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );

  assert.equal(res.status, 0, `canary failed to run: ${res.stderr}`);
  assert.match(
    res.stdout,
    /DECOY_MATCHES/,
    "the decoy path must still match the regex form, or the IDLE test proves nothing",
  );
  assert.match(
    res.stdout,
    /REAL_MISSES/,
    "the real path must still be MISSED by the regex form, or the BUSY test proves nothing",
  );
});

test("AC-1: a longer path that merely starts with the worker path is not this runner", () => {
  // `Runner.WorkerX` and `<root>-2/bin/Runner.Worker` are both substrings-adjacent
  // to the needle. A whole-token comparison is what keeps them out.
  const { verdict } = probeIsBusy(`${FLEET}/rnr1`, [
    `${FLEET}/rnr1/bin/Runner.WorkerX serve`,
    worker(`${FLEET}/rnr1-2`),
  ]);

  assert.equal(verdict, "IDLE", "a different executable and a different runner are both not this runner's job");
});

test("AC-1: a loaded but idle runner (listener only, no worker) reports IDLE", () => {
  const { verdict } = probeIsBusy(METACHAR_ROOT, ["/sbin/launchd", listener(METACHAR_ROOT)]);

  assert.equal(verdict, "IDLE", "the listener is always running — only Runner.Worker means mid-job");
});

test("AC-1: a fleet path containing a space is matched literally too", () => {
  // The needle is compared as a quoted token, so an argv-splitting bug here
  // would show up as a wrong answer rather than a syntax error.
  const spaced = "/Users/ci/github runners/fleet a/rnr 1";
  const busy = probeIsBusy(spaced, [listener(spaced), worker(spaced)]);
  const idle = probeIsBusy(spaced, [listener(spaced), worker("/Users/ci/github runners/fleet a/rnr 2")]);

  assert.equal(busy.verdict, "BUSY", `a path with spaces must still match itself\nstderr: ${busy.stderr}`);
  assert.equal(idle.verdict, "IDLE", "a sibling runner's worker must not mark this one busy");
});

test("an unreadable process table reports BUSY, never idle", () => {
  // Fail-safe direction: the only decision this answer gates is a stop that
  // cancels a job, so "I could not tell" must never be spelled "idle".
  const { verdict, stderr } = probeIsBusy(METACHAR_ROOT, [], { fail: true });

  assert.equal(verdict, "BUSY", "a ps failure must not be readable as an idle runner");
  assert.match(stderr, /could not read the process table/, "the operator must be told why every runner looks busy");
});

test("no grep/pgrep survives in the busy path", () => {
  // `ps … | grep -F "$needle"` matches grep's OWN command line and reads every
  // runner as busy — and a stubbed-`ps` fixture cannot catch that, because the
  // stub's table contains no grep line. Hence a source scan.
  const body = isBusyBody();

  assert.equal(/\bgrep\b/.test(body.replace(/^\s*#.*$/gm, "")), false, "a grep in the pipeline matches itself");
  assert.equal(/\bpgrep\b/.test(sourceWithoutComments()), false, "pgrep -f takes a regex, not a path");
});

test("AC-2: sourcing the script is side-effect free — no output, no prompt", () => {
  // stdin is closed. Were the interactive body still running at source time,
  // its `read -r -p` prompt would land on stderr and the tty guard's refusal on
  // stderr too, so an empty pair of streams is a real assertion here.
  const binDir = stubPs(["/sbin/launchd"]);
  const res = spawnSync(BASH.cmd, ["-c", '. "$1"', "runner-toggle-probe", SCRIPT], {
    encoding: "utf8",
    timeout: 60_000,
    input: "",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });

  assert.equal(res.status, 0, `sourcing must succeed: ${res.stderr}`);
  assert.equal(res.stdout, "", "sourcing printed to stdout — the helpers must be definitions only");
  assert.equal(res.stderr, "", "sourcing printed to stderr — a prompt, a tty refusal or a launchd read leaked");
});

test("AC-2: the guard does not disable the tool — running it without a terminal still refuses", () => {
  // The other half of the guard: a source-only script would be a regression of
  // its own. Executed (not sourced) with no tty, the interactive body must run
  // far enough to refuse.
  const res = spawnSync(BASH.cmd, [SCRIPT], { encoding: "utf8", timeout: 60_000, input: "" });

  assert.equal(res.status, 1, "executing without a terminal must still exit 1");
  assert.match(res.stderr, /needs a terminal on stdin/, "the interactive body must still run when the file is RUN");
});

test("AC-4: the script is syntactically valid under the resolved bash and keeps its strict mode", () => {
  const res = spawnSync(BASH.cmd, ["-n", SCRIPT], { encoding: "utf8", timeout: 60_000 });

  assert.equal(res.status, 0, `bash -n failed:\n${res.stderr}`);
  assert.match(
    sourceWithoutComments(),
    /^set -euo pipefail$/m,
    "strict mode is what makes an unset variable or a failed svc.sh call visible",
  );
});

test("AC-4: the script still ships executable", () => {
  assert.equal(
    (statSync(SCRIPT).mode & 0o100) !== 0,
    true,
    "the runbook installs this with a plain cp — it must carry its own execute bit",
  );
});

test("the script uses no bash-4-only construct (source scan — interpreter-independent)", () => {
  // The fleet runs macOS /bin/bash 3.2. Each of these fails with a SYNTAX error
  // rather than a wrong answer, i.e. at the operator's next invocation.
  const code = sourceWithoutComments();

  assert.equal(/declare\s+-A/.test(code), false, "associative arrays are bash 4+");
  assert.equal(/\bmapfile\b/.test(code), false, "mapfile is bash 4+");
  assert.equal(/\breadarray\b/.test(code), false, "readarray is bash 4+");
  assert.equal(/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?\}/.test(code), false, "case-conversion expansion is bash 4+");
  assert.equal(/\$\{[A-Za-z_][A-Za-z0-9_]*,,?\}/.test(code), false, "case-conversion expansion is bash 4+");
});

test("AC-3: the runner-kit CI job covers this script under the system bash", () => {
  // `assert.ok` rather than `assert.match`: a failing `match` would print the
  // whole workflow as the actual value and bury the line that is wrong.
  const workflow = readFileSync(CI_WORKFLOW, "utf8");

  assert.ok(workflow.includes("runner-kit-bash32:"), "the macOS bash 3.2 job must still exist");
  assert.ok(
    workflow.includes("node --test scripts/runner-toggle.test.mjs"),
    "this suite must run in CI — it is the only thing that executes the toggle script",
  );
  assert.ok(
    workflow.includes("bash -n docs/runbooks/runner-toggle.sh"),
    "a 3.2 syntax regression must surface in CI, not at an operator's prompt",
  );
});

test("AC-4: the runbook describes the busy check as a literal path match", () => {
  const runbook = readFileSync(RUNBOOK, "utf8");

  assert.ok(/literal/i.test(runbook), "the runbook must say the busy check matches the worker path literally");
  assert.ok(
    /Runner\.Worker/.test(runbook),
    "an operator reading the runbook should know which process decides the busy verdict",
  );
});

test("the suite reports which interpreter its execution tests actually prove", () => {
  // A passing suite must never be readable as "bash 3.2 verified" when it ran
  // under bash 5. This gates on the resolution being KNOWN and reported, not on
  // the version — ubuntu CI legitimately has only bash 5.
  assert.match(BASH.banner, /GNU bash, version \d+\./, "could not identify the interpreter");
  assert.notEqual(BASH.major, null, "interpreter major version is unparseable");
  console.log(
    `    ℹ execution tests ran under: ${BASH.cmd} — ${BASH.banner}` +
      (BASH.major === 3
        ? "  [fleet-equivalent bash 3.x]"
        : "  [NOT the fleet's 3.x — 3.2-only regressions cannot surface in this run]"),
  );
});
