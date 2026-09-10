#!/usr/bin/env node
/**
 * select-semgrep-python.test.mjs — node:test suite for the SAST interpreter
 * floor (Story #482).
 *
 * The pr-quality SAST step `source`s `select-semgrep-python.sh` before it
 * creates the Semgrep venv, so this script's decision IS which interpreter
 * the fleet's blocking SAST tier installs against. The suite executes the
 * script directly (it echoes `SEMGREP_PYTHON=…` lines and exits with the
 * selection's status when run rather than sourced) against fixture PATHs
 * built from stub interpreters, so every branch is assertable without a
 * macOS runner or a real Python matrix.
 *
 * Why stubs rather than the host's real interpreters: the failure this closes
 * only reproduces on a runner whose `python3` is BELOW the floor, which no CI
 * tier here provides. A stub that answers `-c` with a chosen `major minor` is
 * the whole interface the script depends on.
 *
 * Run: node --test scripts/select-semgrep-python.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "select-semgrep-python.sh");

const PIN = "semgrep==1.176.1";
const FLOOR = "3.10";

/**
 * Build a directory of stub interpreters and return its path. `versions` maps
 * an interpreter name to the `major.minor` it should report; a stub ignores
 * its arguments and echoes `"<major> <minor>"`, which is the only thing the
 * script asks of it.
 */
function stubPath(versions) {
  const dir = mkdtempSync(join(tmpdir(), "semgrep-python-stubs-"));
  for (const [name, version] of Object.entries(versions)) {
    const [major, minor] = version.split(".");
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${major} ${minor}"\n`, { mode: 0o755 });
  }
  return dir;
}

/**
 * Execute the selector with the given PATH and env. Returns the exit status
 * and stdout — the script writes its `::error::` annotation to stdout, which
 * is where GitHub reads workflow commands from.
 */
function select({ path, floor = FLOOR, pin = PIN }) {
  const env = { PATH: path };
  if (floor !== null) env.SEMGREP_PYTHON_FLOOR = floor;
  if (pin !== null) env.SEMGREP_PIN = pin;
  try {
    const stdout = execFileSync("/bin/bash", [SCRIPT], { encoding: "utf8", env });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "" };
  }
}

/** Parse the `KEY=value` lines the script emits when it succeeds. */
function parse(stdout) {
  const out = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The script is a usable, sourceable artifact
// ---------------------------------------------------------------------------

test("the selector is executable", () => {
  // The workflow sources it, but the suite executes it, and a non-executable
  // file would pass `source` while failing every assertion below in a way
  // that reads as a logic bug rather than a mode bug.
  const mode = statSync(SCRIPT).mode;
  assert.ok(mode & 0o111, "scripts/select-semgrep-python.sh must be executable");
});

// ---------------------------------------------------------------------------
// 2. Selection order — a compliant runner is unchanged
// ---------------------------------------------------------------------------

test("a python3 at the floor is selected as-is", () => {
  const r = select({ path: stubPath({ python3: "3.10" }) });
  assert.equal(r.status, 0);
  const out = parse(r.stdout);
  assert.equal(out.SEMGREP_PYTHON, "python3");
  assert.equal(out.SEMGREP_PYTHON_VERSION, "3.10");
});

test("python3 wins even when newer versioned interpreters are also present", () => {
  // A runner that already works must not silently change interpreter — that
  // would be a behaviour change shipped to the whole fleet as a side effect.
  const r = select({ path: stubPath({ python3: "3.12", "python3.13": "3.13" }) });
  assert.equal(r.status, 0);
  assert.equal(parse(r.stdout).SEMGREP_PYTHON, "python3");
});

// ---------------------------------------------------------------------------
// 3. Discovery — the reported consumer-side remedy, performed by the workflow
// ---------------------------------------------------------------------------

test("a below-floor python3 falls through to a qualifying python3.N", () => {
  // The exact shape of issue #480: macOS /usr/bin/python3 is 3.9.6 while a
  // brew-installed 3.12 sits on PATH under its versioned name.
  const r = select({ path: stubPath({ python3: "3.9", "python3.12": "3.12" }) });
  assert.equal(r.status, 0);
  const out = parse(r.stdout);
  assert.equal(out.SEMGREP_PYTHON, "python3.12");
  assert.equal(out.SEMGREP_PYTHON_VERSION, "3.12");
});

test("versioned candidates are probed newest-first", () => {
  const r = select({
    path: stubPath({ python3: "3.9", "python3.11": "3.11", "python3.13": "3.13" }),
  });
  assert.equal(r.status, 0);
  assert.equal(parse(r.stdout).SEMGREP_PYTHON, "python3.13");
});

test("3.9 is rejected and 3.10 accepted — the floor compares minor numerically", () => {
  // Guards the tens-boundary trap: as strings "39" sorts ABOVE "310", so a
  // concatenated comparison would accept 3.9 and reject the floor itself.
  const rejected = select({ path: stubPath({ python3: "3.9" }) });
  assert.equal(rejected.status, 1);
  const accepted = select({ path: stubPath({ python3: "3.10" }) });
  assert.equal(accepted.status, 0);
});

test("a future major version satisfies the floor", () => {
  const r = select({ path: stubPath({ python3: "4.0" }) });
  assert.equal(r.status, 0);
  assert.equal(parse(r.stdout).SEMGREP_PYTHON_VERSION, "4.0");
});

// ---------------------------------------------------------------------------
// 4. Fail closed, with an actionable message
// ---------------------------------------------------------------------------

test("no qualifying interpreter fails with an ::error:: naming floor, pin and version found", () => {
  const r = select({ path: stubPath({ python3: "3.9" }) });
  assert.equal(r.status, 1, "the step must fail rather than install something older");

  const error = r.stdout.split("\n").find((l) => l.startsWith("::error::"));
  assert.ok(error, "the failure must be a GitHub ::error:: annotation, not bare output");
  assert.ok(error.includes(FLOOR), `the annotation must name the floor (${FLOOR}): ${error}`);
  assert.ok(error.includes(PIN), `the annotation must name the pin (${PIN}): ${error}`);
  assert.ok(
    error.includes("3.9"),
    `the annotation must name the interpreter version actually found: ${error}`,
  );
});

test("the failure names the PATH remedy and the enable-sast escape hatch", () => {
  const r = select({ path: stubPath({ python3: "3.9" }) });
  assert.ok(r.stdout.includes("PATH"), "the remedy must name PATH");
  assert.ok(
    r.stdout.includes("enable-sast"),
    "the remedy must name the enable-sast escape hatch, since no semgrep-pin input exists",
  );
});

test("the failure records why semgrep is not downgraded instead", () => {
  // The rationale belongs in the runner output: the next person to hit this
  // reads the log, not the Story, and "just pin an older semgrep" is the
  // wrong fix for a documented reason.
  const r = select({ path: stubPath({ python3: "3.9" }) });
  assert.ok(r.stdout.includes("CVE-2026-0994"), "must name the advisory a downgrade re-admits");
  assert.ok(r.stdout.includes("1.136.0"), "must name the last py3.9-compatible release");
});

test("an absent python3 is reported as absent, not as a version", () => {
  const r = select({ path: stubPath({}) });
  assert.equal(r.status, 1);
  const error = r.stdout.split("\n").find((l) => l.startsWith("::error::"));
  assert.ok(error.includes("absent"), `expected 'absent' in: ${error}`);
});

test("a non-interpreter on PATH under an interpreter name is skipped, not trusted", () => {
  // `command -v` finding the name is not proof it answers `-c`. A stub that
  // exits non-zero must be passed over rather than selected with an empty
  // version.
  const dir = mkdtempSync(join(tmpdir(), "semgrep-python-stubs-"));
  writeFileSync(join(dir, "python3"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  writeFileSync(join(dir, "python3.12"), '#!/bin/sh\necho "3 12"\n', { mode: 0o755 });
  const r = select({ path: dir });
  assert.equal(r.status, 0);
  assert.equal(parse(r.stdout).SEMGREP_PYTHON, "python3.12");
});

// ---------------------------------------------------------------------------
// 5. The floor itself cannot go missing quietly
// ---------------------------------------------------------------------------

test("an unset floor fails closed rather than accepting any interpreter", () => {
  const r = select({ path: stubPath({ python3: "3.9" }), floor: null });
  assert.equal(r.status, 1);
  const error = r.stdout.split("\n").find((l) => l.startsWith("::error::"));
  assert.ok(error.includes("SEMGREP_PYTHON_FLOOR"), `expected the floor named in: ${error}`);
});

test("a malformed floor fails closed", () => {
  const r = select({ path: stubPath({ python3: "3.12" }), floor: "latest" });
  assert.equal(r.status, 1, "a malformed floor must not be treated as satisfied");
});
