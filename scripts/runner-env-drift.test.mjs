#!/usr/bin/env node
/**
 * runner-env-drift.test.mjs — node:test suite for the operator-run pool checker
 * shipped at `templates/runner/check-runner-env-drift.sh` (Story #353).
 *
 * WHY THIS CHECKER NEEDS A SUITE AT ALL
 *
 * A runner's `<RUNNER_DIR>/.env` is invisible to every other observer the fleet
 * has. `scripts/check-runner-health.mjs` reaches runners through
 * `GET /repos/{owner}/{repo}/actions/runners`, which reports name, labels and
 * online status — not local configuration. So a half-provisioned pool never
 * presents as a configuration fault; it presents as an unattributable
 * behavioural difference between two runs of the same job (issue #343: two
 * hooked runners sat 5m29s in `Set up runner` while the same job on an unhooked
 * runner finished in 54 seconds). This checker is the only thing that names the
 * odd runners out, so what the suite pins is that it NAMES them — not merely
 * that it noticed drift exists.
 *
 * The three properties worth stating up front, because each has a counterpart
 * failure that would make the tool actively misleading:
 *
 *   1. Drift is a key set on SOME runners but not all. A key absent from EVERY
 *      runner is a uniform gap — a fleet that deliberately has not adopted a
 *      key must not be a standing alarm, or the operator learns to ignore the
 *      exit code.
 *   2. One broken runner must not hide the pool. A directory with no readable
 *      `.env` is recorded as all keys unset and the walk continues; an early
 *      exit there would silently shrink the sample the drift verdict is
 *      computed over.
 *   3. The run is read-only. This is pointed at production runner roots by an
 *      operator; it must never be the reason a runner's configuration changed.
 *
 * The suite executes the real script against synthetic pool fixtures, following
 * the `scripts/job-cleanup-hook.test.mjs` precedent for shell-under-test.
 * Fixtures are a handful of directories: every assertion is on report content
 * and exit code, both count-independent, so planting volume would buy no signal
 * (and costs ~17ms/file on a dev Mac whose endpoint security scans every write).
 *
 * INTERPRETER COVERAGE — what each assertion actually proves
 *
 * The fleet is macOS, where `/bin/bash` is 3.2 (Apple cannot ship a GPL3 bash).
 * That version differs from bash 4.4+ in ways no source scan can see, so this
 * suite is explicit about which interpreter it ran under rather than inheriting
 * whatever `bash` PATH happens to resolve:
 *
 *   • `resolveBash()` prefers `/bin/bash`, falls back to PATH `bash`, and is
 *     overridable with `RUNNER_KIT_BASH`. Its resolved banner is asserted and
 *     printed, so a run can never claim 3.2 coverage it did not have.
 *   • The bash-4 construct denylist (AC-8) is a SOURCE scan and proves the same
 *     thing under any interpreter.
 *   • Every other test is a real execution and proves its property only for
 *     `BASH.banner`. On the macOS CI job and on a dev Mac that is genuinely
 *     3.2; on ubuntu it is bash 5.
 *
 * The divergence that motivated this (Story #354 audit follow-up): under
 * `set -u`, bash 3.2 aborts on `"${arr[@]}"` when the array is EMPTY, where
 * bash 4.4+ expands to nothing. The checker runs under `set -u` and builds
 * three accumulators, so an unguarded expansion would pass a bash-5-only CI and
 * then fail with `unbound variable` on the fleet at the operator's first real
 * invocation. `ci.yml`'s `runner-kit-bash32` job runs this suite on
 * `macos-latest` against the system 3.2 for exactly that reason; the canary
 * test below asserts the divergence is actually present before the
 * empty-accumulator test claims to have exercised it.
 *
 * Run: node --test scripts/runner-env-drift.test.mjs
 *      RUNNER_KIT_BASH=/bin/bash node --test scripts/runner-env-drift.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "templates", "runner", "check-runner-env-drift.sh");
const RUNBOOK = join(HERE, "..", "templates", "runbooks", "runner-provisioning.md");

/** The four keys `templates/runner/.env.example` mandates. */
const HOOK = "ACTIONS_RUNNER_HOOK_JOB_STARTED";
const MANDATED = [HOOK, "RUNNER_TOOL_CACHE", "AGENT_TOOLSDIRECTORY", "LANG"];

/** Representative values — the checker reports PRESENCE, never value. */
const VALUES = {
  ACTIONS_RUNNER_HOOK_JOB_STARTED: "/Users/ci/runners/a/job-cleanup.sh",
  RUNNER_TOOL_CACHE: "/Users/ci/runners/a/_work/_tool",
  AGENT_TOOLSDIRECTORY: "/Users/ci/runners/a/_work/_tool",
  LANG: "en_US.UTF-8",
};

/** Sandboxes created by the suite, torn down in `after`. */
const SANDBOXES = [];

after(() => {
  for (const dir of SANDBOXES) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Render an `.env` body setting exactly the named keys, with the comment
 * preamble a real runner `.env` carries.
 *
 * @param {string[]} keys
 * @returns {string}
 */
function envWith(keys) {
  const lines = ["# .env — per-runner environment (fixture)", ""];
  for (const key of keys) {
    lines.push(`${key}=${VALUES[key]}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Build a synthetic pool root.
 *
 * Each entry maps a child directory name to its spec:
 *   `keys`     — mandated keys to set in that runner's `.env` (default: all four)
 *   `env`      — raw `.env` body, overriding `keys`
 *   `noEnv`    — create no `.env` at all
 *   `isRunner` — false to omit `config.sh`, i.e. not a runner directory
 *
 * @param {Record<string, {keys?: string[], env?: string, noEnv?: boolean, isRunner?: boolean}>} spec
 * @returns {string} absolute pool root
 */
function makePool(spec) {
  const root = mkdtempSync(join(tmpdir(), "runner-env-drift-"));
  SANDBOXES.push(root);

  for (const [name, entry] of Object.entries(spec)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });

    // `config.sh` is the runner predicate — the runbook mandates one directory
    // per runner under a common root, and this is what keeps unrelated
    // siblings out of the report without inventing a naming convention.
    if (entry.isRunner !== false) {
      writeFileSync(join(dir, "config.sh"), "#!/bin/sh\nexit 0\n");
    }
    if (entry.noEnv) {
      continue;
    }
    writeFileSync(join(dir, ".env"), entry.env ?? envWith(entry.keys ?? MANDATED));
  }

  return root;
}

/**
 * Resolve the interpreter every execution test runs under, and record WHICH one
 * it is. Bare `bash` from PATH is deliberately not used: it silently varies by
 * host (3.2 on a stock Mac, 5.x on ubuntu), so a suite that inherits it cannot
 * say what its passes prove. `/bin/bash` is preferred because the fleet's shell
 * is the stricter one; `RUNNER_KIT_BASH` overrides for a deliberate cross-check.
 *
 * @returns {{ cmd: string, banner: string, major: number|null }}
 */
function resolveBash() {
  const candidates = process.env.RUNNER_KIT_BASH
    ? [process.env.RUNNER_KIT_BASH]
    : ["/bin/bash", "bash"];
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
  throw new Error(
    `no usable bash interpreter (tried ${candidates.join(", ")}) — this suite executes a shell script`,
  );
}

const BASH = resolveBash();

/** True when the resolved interpreter is the fleet's bash 3.x, not 4.4+. */
const IS_BASH_3X = BASH.major === 3;

/**
 * Run the checker under the RESOLVED interpreter, capturing both streams.
 *
 * stderr is returned, not discarded: a bash-3.2 `unbound variable` abort writes
 * there and exits non-zero, which would otherwise be indistinguishable from the
 * checker's own deliberate exit 1 (drift) or exit 2 (usage).
 *
 * @param {string[]} args
 * @param {string} [scriptPath] — defaults to the shipped script
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runChecker(args, scriptPath = SCRIPT) {
  const res = spawnSync(BASH.cmd, [scriptPath, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("AC-1: the shipped script is executable", () => {
  const mode = statSync(SCRIPT).mode;

  assert.equal(
    (mode & 0o100) !== 0,
    true,
    "the kit-copy step in the runbook chmods the hook but copies this verbatim — it must ship executable",
  );
});

test("AC-2: names every runner missing a key that others have, and exits non-zero", () => {
  // The 16-of-19 shape from issue #343, scaled down: the hook is configured on
  // one runner and absent from two.
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-b": { keys: MANDATED.filter((key) => key !== HOOK) },
    "runner-c": { keys: MANDATED.filter((key) => key !== HOOK) },
  });

  const { status, stdout } = runChecker(["--pool-root", root]);

  assert.notEqual(status, 0, "drift must be reported through the exit code — that is the alert channel");
  assert.match(stdout, /runner-b/, "the partially-provisioned runner must be named, not just counted");
  assert.match(stdout, /runner-c/, "the partially-provisioned runner must be named, not just counted");
  assert.match(stdout, new RegExp(HOOK), "the drifting key must be named");
});

test("AC-3: a fully provisioned pool exits 0", () => {
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-b": { keys: MANDATED },
    "runner-c": { keys: MANDATED },
  });

  const { status } = runChecker(["--pool-root", root]);

  assert.equal(status, 0);
});

test("AC-4: a key absent from every runner is a uniform gap, not an alarm", () => {
  // A fleet that has deliberately not adopted a key must not be a standing
  // non-zero exit, or the operator learns to ignore the alert channel.
  const withoutLang = MANDATED.filter((key) => key !== "LANG");
  const root = makePool({
    "runner-a": { keys: withoutLang },
    "runner-b": { keys: withoutLang },
    "runner-c": { keys: withoutLang },
  });

  const { status, stdout } = runChecker(["--pool-root", root]);

  assert.equal(status, 0, "a uniform gap is not drift");
  assert.match(
    stdout,
    /LANG: uniformly unset/,
    "the gap must still be visible in the report — silence would hide a fleet-wide miss",
  );
});

test("AC-5: a runner with no readable .env is recorded as all-unset and the walk continues", () => {
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-broken": { noEnv: true },
    "runner-c": { keys: MANDATED },
  });

  const { status, stdout } = runChecker(["--pool-root", root]);

  assert.notEqual(status, 0, "a runner missing every mandated key while others have them is drift");
  assert.match(stdout, /runner-a/, "an early exit on the broken runner would hide the rest of the pool");
  assert.match(stdout, /runner-c/, "an early exit on the broken runner would hide the rest of the pool");

  const brokenLine = stdout.split("\n").find((line) => line.includes("runner-broken"));
  assert.ok(brokenLine, "the unreadable runner must appear in the per-runner report");
  for (const key of MANDATED) {
    assert.match(
      brokenLine,
      new RegExp(key),
      `an unreadable .env must record ${key} as unset, not as unknown or absent from the report`,
    );
  }
});

test("AC-6: a child directory without config.sh is not a runner and never appears", () => {
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-b": { keys: MANDATED },
    // A plausible sibling on a real runner host: a shared scratch dir that
    // happens to carry an `.env`. Counting it would fabricate drift.
    "shared-scratch": { isRunner: false, keys: [] },
  });

  const { status, stdout } = runChecker(["--pool-root", root]);

  assert.equal(status, 0, "a non-runner sibling with no keys must not fabricate drift");
  assert.equal(
    stdout.includes("shared-scratch"),
    false,
    "only directories containing config.sh are runners",
  );
});

test("AC-7: the pool root defaults to the parent of the script's own directory", () => {
  // The kit installs the checker into <RUNNER_DIR>, so its own parent IS the
  // pool root — an operator can run it with no arguments from any runner root.
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-b": { keys: MANDATED.filter((key) => key !== HOOK) },
  });
  const installed = join(root, "runner-a", "check-runner-env-drift.sh");
  copyFileSync(SCRIPT, installed);

  const { status, stdout } = runChecker([], installed);

  assert.notEqual(status, 0);
  assert.match(stdout, /runner-a/);
  assert.match(stdout, /runner-b/, "the default pool root must reach sibling runners, not just its own");
});

test("AC-7: --pool-root overrides the default", () => {
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-b": { keys: MANDATED.filter((key) => key !== HOOK) },
  });

  const { status, stdout } = runChecker(["--pool-root", root]);

  assert.notEqual(status, 0);
  assert.match(stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the report names the pool it walked");
  assert.match(stdout, /runner-b/);
});

test("AC-8: the script uses no bash-4-only construct (source scan — interpreter-independent)", () => {
  // These are the bash-4 constructs a maintainer reaches for first when
  // accumulating per-runner state, and each fails with a SYNTAX error rather
  // than a wrong answer — i.e. the operator's first real invocation is where
  // they would find out. A source scan is the right shape for this class
  // precisely because it does not depend on which bash ran the suite.
  //
  // It is NOT sufficient on its own: the runtime divergences below are
  // invisible to any denylist. See the two tests that follow.
  const source = readFileSync(SCRIPT, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  assert.equal(/declare\s+-A/.test(code), false, "associative arrays are bash 4+");
  assert.equal(/\bmapfile\b/.test(code), false, "mapfile is bash 4+");
  assert.equal(/\breadarray\b/.test(code), false, "readarray is bash 4+");
  assert.equal(/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/.test(code), false, "case-conversion expansion is bash 4+");
});

test("the suite reports which interpreter its execution tests actually prove", () => {
  // A passing suite must never be readable as "bash 3.2 verified" when it ran
  // under bash 5. This test does not gate on the version — ubuntu CI legitimately
  // has only bash 5 — it gates on the resolution being KNOWN and reported.
  assert.match(BASH.banner, /GNU bash, version \d+\./, "could not identify the interpreter");
  assert.notEqual(BASH.major, null, "interpreter major version is unparseable");
  console.log(
    `    ℹ execution tests ran under: ${BASH.cmd} — ${BASH.banner}` +
      (IS_BASH_3X
        ? "  [fleet-equivalent bash 3.x]"
        : "  [NOT the fleet's 3.x — 3.2-only regressions cannot surface in this run]"),
  );
});

test("canary: the bash-3.2 empty-array divergence is real on a 3.x interpreter", (t) => {
  // The empty-accumulator test below is only meaningful if the interpreter it
  // runs under actually exhibits the hazard. Assert the divergence directly, so
  // the guard can never be "passing" against a bash that would accept an
  // unguarded expansion anyway.
  if (!IS_BASH_3X) {
    t.skip(`interpreter is bash ${BASH.major}.x — 4.4+ expands an empty "\${arr[@]}" to nothing by design`);
    return;
  }
  const res = spawnSync(BASH.cmd, ["-c", 'set -u; arr=(); for x in "${arr[@]}"; do :; done'], {
    encoding: "utf8",
  });
  assert.notEqual(res.status, 0, "expected bash 3.x to abort on an empty array under `set -u`");
  assert.match(res.stderr, /unbound variable/);
});

test("no reachable path expands a possibly-empty accumulator under `set -u`", () => {
  // The checker runs under `set -u` and builds three accumulators —
  // `runner_names`, `unset_keys`, `unset_names`. Each is expanded only behind a
  // non-empty guard today. This drives every scenario that empties one of them
  // and asserts the script never aborts on an unbound expansion, so a later
  // edit that drops a guard is caught rather than shipped.
  //
  // Under bash 3.x this is a real regression gate. Under 4.4+ it still checks
  // exit codes and output, but the divergence itself cannot fire — which is
  // what the macOS `runner-kit-bash32` CI job exists to cover.
  const scenarios = [
    {
      what: "unset_keys and unset_names both empty (every key set on every runner)",
      pool: makePool({ "runner-a": { keys: MANDATED }, "runner-b": { keys: MANDATED } }),
      expect: 0,
    },
    {
      what: "unset_names empty for the uniformly-set keys, non-empty for the drifting one",
      pool: makePool({
        "runner-a": { keys: MANDATED },
        "runner-b": { keys: MANDATED.filter((k) => k !== HOOK) },
      }),
      expect: 1,
    },
    {
      what: "every accumulator empty (a key set on no runner at all)",
      pool: makePool({ "runner-a": { keys: [] }, "runner-b": { keys: [] } }),
      expect: 0,
    },
    {
      what: "runner_names empty (pool root holds no runner directories)",
      pool: makePool({ "not-a-runner": { isRunner: false } }),
      expect: 2,
    },
  ];

  for (const { what, pool, expect } of scenarios) {
    const res = runChecker(["--pool-root", pool]);
    assert.doesNotMatch(
      res.stderr,
      /unbound variable/,
      `aborted on an unguarded empty-array expansion — ${what}`,
    );
    assert.equal(res.status, expect, `unexpected exit for: ${what}\nstderr: ${res.stderr}`);
  }
});

test("AC-9: the run is read-only against the pool", () => {
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-b": { keys: MANDATED.filter((key) => key !== HOOK) },
    "runner-broken": { noEnv: true },
  });

  const snapshot = () => {
    const state = {};
    for (const name of readdirSync(root).sort()) {
      state[name] = readdirSync(join(root, name)).sort();
      const envPath = join(root, name, ".env");
      state[`${name}/.env`] = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
    }
    return state;
  };

  const before = snapshot();
  runChecker(["--pool-root", root]);

  assert.deepEqual(
    snapshot(),
    before,
    "the checker wrote into a runner root — it is pointed at production runners and must only read",
  );
});

test("a commented-out assignment does not count as set", () => {
  // `.env.example` ships every key inside a block of explanatory comments, so a
  // half-applied copy where the operator never uncommented a line is the most
  // likely real drift shape. Matching a key name anywhere in the file would
  // report that runner as provisioned.
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-b": {
      env: `# ${HOOK}=/Users/ci/runners/b/job-cleanup.sh\nRUNNER_TOOL_CACHE=${VALUES.RUNNER_TOOL_CACHE}\nAGENT_TOOLSDIRECTORY=${VALUES.AGENT_TOOLSDIRECTORY}\nLANG=${VALUES.LANG}\n`,
    },
  });

  const { status, stdout } = runChecker(["--pool-root", root]);

  assert.notEqual(status, 0);
  assert.match(stdout, /runner-b/);
});

test("a leading-whitespace assignment counts as set", () => {
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-b": {
      env: `  ${HOOK}=/Users/ci/runners/b/job-cleanup.sh\n\tRUNNER_TOOL_CACHE=${VALUES.RUNNER_TOOL_CACHE}\nAGENT_TOOLSDIRECTORY=${VALUES.AGENT_TOOLSDIRECTORY}\nLANG=${VALUES.LANG}\n`,
    },
  });

  const { status } = runChecker(["--pool-root", root]);

  assert.equal(status, 0, "indentation is not a configuration difference");
});

test("a longer key that merely starts with a mandated key does not count as set", () => {
  // `LANGUAGE=` must not satisfy `LANG`. A prefix match here would report a
  // runner as provisioned on the strength of an unrelated variable.
  const root = makePool({
    "runner-a": { keys: MANDATED },
    "runner-b": {
      env: `${HOOK}=/Users/ci/runners/b/job-cleanup.sh\nRUNNER_TOOL_CACHE=${VALUES.RUNNER_TOOL_CACHE}\nAGENT_TOOLSDIRECTORY=${VALUES.AGENT_TOOLSDIRECTORY}\nLANGUAGE=en_US\n`,
    },
  });

  const { status, stdout } = runChecker(["--pool-root", root]);

  assert.notEqual(status, 0);
  assert.match(stdout, /runner-b/);
});

test("a pool root holding no runner directories is a usage error, not a clean pool", () => {
  // Reporting "no drift" over an empty walk is the worst possible answer: the
  // operator reads a green exit as evidence the fleet is uniform.
  const root = makePool({ "shared-scratch": { isRunner: false, noEnv: true } });

  const { status } = runChecker(["--pool-root", root]);

  assert.equal(status, 2, "a pool root with no runners must be distinguishable from a clean pool");
});

test("an unknown flag is rejected rather than silently ignored", () => {
  const root = makePool({ "runner-a": { keys: MANDATED } });

  const { status } = runChecker(["--pool-root", root, "--fix"]);

  assert.equal(status, 2, "this tool never repairs — a flag it does not implement must not appear to work");
});

test("AC-10: the runbook installs and invokes the checker alongside the hook", () => {
  // `assert.ok` rather than `assert.match`: a failing `match` prints the whole
  // runbook as the actual value, which buries the one line that is wrong.
  const runbook = readFileSync(RUNBOOK, "utf8");

  assert.ok(
    /cp .*templates\/runner\/check-runner-env-drift\.sh/.test(runbook),
    "an operator following the runbook must end up with the checker on the host",
  );
  assert.ok(
    /\.\/check-runner-env-drift\.sh/.test(runbook),
    "the runbook must show how to invoke it, not just how to copy it",
  );
});
