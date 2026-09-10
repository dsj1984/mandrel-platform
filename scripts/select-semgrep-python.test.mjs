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
import { spawnSync } from "node:child_process";
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
 *
 * `os`, when given, additionally plants a `uname` stub that reports it. The
 * fixture PATH is the process's WHOLE PATH, so a stub `uname` is the only
 * `uname` the script can resolve — which is what makes the Linux-only
 * ABI-first branch assertable from a macOS laptop and a Linux runner alike.
 * Omit it to model a runner where the OS cannot be read at all; the script
 * must still choose an interpreter rather than dying in a command
 * substitution.
 */
function stubPath(versions, { os = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "semgrep-python-stubs-"));
  for (const [name, version] of Object.entries(versions)) {
    const [major, minor] = version.split(".");
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${major} ${minor}"\n`, { mode: 0o755 });
  }
  if (os !== null) {
    // `uname -s` and `uname -m` are both answered; the selector only asks for
    // `-s`, and a stub that ignores its flags cannot drift from that.
    writeFileSync(join(dir, "uname"), `#!/bin/sh\necho "${os}"\n`, { mode: 0o755 });
  }
  return dir;
}

/**
 * Execute the selector with the given PATH and env. Returns the exit status,
 * stdout and stderr — the script writes its `::error::` annotation to stdout,
 * which is where GitHub reads workflow commands from, and mirrors the reason
 * (without the prefix) to stderr for callers that capture only that stream.
 */
function select({ path, floor = FLOOR, pin = PIN, lockfileAbi = null }) {
  const env = { PATH: path };
  if (floor !== null) env.SEMGREP_PYTHON_FLOOR = floor;
  if (pin !== null) env.SEMGREP_PIN = pin;
  if (lockfileAbi !== null) env.SEMGREP_LOCKFILE_ABI = lockfileAbi;
  const r = spawnSync("/bin/bash", [SCRIPT], { encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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

test("a malformed floor is named as malformed, not as bash's integer error", () => {
  // `3.1O` is the letter O, and it is the exact shape a shape-only check
  // misses: `[0-9]*.[0-9]*` pins the first character of each field, so the
  // typo reached `[ ... -ge "1O" ]` and produced bash's own
  // "integer expression expected" on stderr — a message that names the shell,
  // never the input, and leaves the step to blame the runner's interpreters
  // for a typo in its own configuration.
  const r = select({ path: stubPath({ python3: "3.12" }), floor: "3.1O" });
  assert.equal(r.status, 1, "a malformed floor must not be treated as satisfied");
  assert.match(r.stderr, /malformed/, `the reason must reach stderr: ${r.stderr}`);
  assert.ok(
    r.stderr.includes("3.1O"),
    `stderr must quote the offending value back: ${r.stderr}`,
  );
  const combined = `${r.stdout}${r.stderr}`;
  assert.ok(
    !combined.includes("integer expression expected"),
    `the input must be rejected before it reaches an arithmetic test: ${combined}`,
  );
});

test("a floor with no minor field is malformed rather than half-read", () => {
  // `310` splits to major "310" and a minor equal to the whole string, which
  // an unvalidated read would silently treat as 310.310.
  const r = select({ path: stubPath({ python3: "3.12" }), floor: "310" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /malformed/);
});

// ---------------------------------------------------------------------------
// 6. Lockfile-ABI-first probe order on Linux (Story #495)
// ---------------------------------------------------------------------------

test("on Linux the lockfile's ABI interpreter is probed before bare python3", () => {
  // The failure this closes: the hash-pinned install is valid only on a cp312
  // interpreter, so the day a CI image rolls bare `python3` to 3.13 the old
  // order routed the WHOLE fleet onto the un-hash-pinned fallback while an
  // eligible python3.12 sat unused on the same PATH.
  const r = select({
    path: stubPath({ python3: "3.13", "python3.12": "3.12" }, { os: "Linux" }),
    lockfileAbi: "3.12",
  });
  assert.equal(r.status, 0);
  const out = parse(r.stdout);
  assert.equal(out.SEMGREP_PYTHON, "python3.12", "the lockfile ABI must win the probe order");
  assert.equal(out.SEMGREP_PYTHON_VERSION, "3.12");
});

test("on Darwin the same fixture still selects bare python3", () => {
  // The mirror case, and the reason the OS is read rather than assumed: no
  // darwin hashes are generated, so there is no ABI worth steering toward and
  // the historical order must stand untouched.
  const r = select({
    path: stubPath({ python3: "3.13", "python3.12": "3.12" }, { os: "Darwin" }),
    lockfileAbi: "3.12",
  });
  assert.equal(r.status, 0);
  assert.equal(parse(r.stdout).SEMGREP_PYTHON, "python3");
});

test("with no lockfile ABI declared, Linux keeps the historical order", () => {
  const r = select({
    path: stubPath({ python3: "3.13", "python3.12": "3.12" }, { os: "Linux" }),
  });
  assert.equal(r.status, 0);
  assert.equal(parse(r.stdout).SEMGREP_PYTHON, "python3");
});

test("a malformed lockfile ABI is ignored, not fatal", () => {
  // The ABI only reorders probing; the floor is the check that fails closed.
  // Turning a bad optimisation hint into a hard stop would take the security
  // tier down for every consumer over a cosmetic input.
  const r = select({
    path: stubPath({ python3: "3.13", "python3.12": "3.12" }, { os: "Linux" }),
    lockfileAbi: "cp312",
  });
  assert.equal(r.status, 0);
  assert.equal(parse(r.stdout).SEMGREP_PYTHON, "python3");
});

test("the ABI candidate still has to clear the floor", () => {
  // Probing it first is an ordering preference, not an exemption: a
  // below-floor python3.12 must fall through exactly as any other candidate
  // does, because the install would fail on it either way.
  const r = select({
    path: stubPath({ python3: "3.13", "python3.12": "3.9" }, { os: "Linux" }),
    lockfileAbi: "3.12",
  });
  assert.equal(r.status, 0);
  assert.equal(parse(r.stdout).SEMGREP_PYTHON, "python3");
});

test("an absent uname does not break selection", () => {
  // The selector runs under the caller's `set -e`, where an unguarded command
  // substitution on a missing binary would abort the step before any
  // interpreter was chosen.
  const r = select({ path: stubPath({ python3: "3.12" }), lockfileAbi: "3.12" });
  assert.equal(r.status, 0);
  assert.equal(parse(r.stdout).SEMGREP_PYTHON, "python3");
});

test("the fail-closed message reports the order actually probed", () => {
  // A hard-coded list in the message would go stale the moment the ABI
  // reorders it, and the log line is the only place a consumer can see which
  // names were tried.
  const r = select({
    path: stubPath({ python3: "3.9" }, { os: "Linux" }),
    lockfileAbi: "3.12",
  });
  assert.equal(r.status, 1);
  assert.ok(
    r.stdout.includes("Probed, in order: python3.12 python3 "),
    `the probe order must be reported as it ran: ${r.stdout}`,
  );
});
