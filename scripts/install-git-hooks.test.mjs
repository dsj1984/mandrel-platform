#!/usr/bin/env node
/**
 * install-git-hooks.test.mjs — the `core.hooksPath` wiring, and the two places
 * that wiring can silently fall out of the repository again (Story #513).
 *
 * The bug this pins: nothing set `core.hooksPath`. There was no husky
 * dependency, no `prepare` step, and no bootstrap hook — the value on a
 * maintainer's machine was a `git config` run by hand at some forgotten point.
 * Git therefore looked in `.git/hooks` in every fresh clone, found nothing, and
 * committed normally. Story #511 had just made `.husky/pre-commit` executable;
 * this is the other half, and without it that mode bit buys nothing.
 *
 * Like the mode bug, the failure is silent: no hook runs, no warning is
 * printed, `git commit` exits 0. So the assertions below cover both the
 * function's decisions AND the repository wiring that invokes it — a correct
 * installer that `prepare` no longer calls is the same silent no-gate outcome
 * by a different route.
 *
 * Seams rather than a real repo: the function takes `fsImpl` / `spawnImpl`, so
 * every branch is exercised without spawning git or writing to a real config.
 * Stubs are plain objects passed through the parameter, per
 * `.agents/rules/test-seams.md`.
 *
 * Run: node --test scripts/install-git-hooks.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { installGitHooks, HOOKS_PATH } from "./install-git-hooks.mjs";

/**
 * A `spawnSync` stub that records calls and answers each git subcommand from
 * `replies`, keyed by the subcommand words joined with a space.
 */
function gitStub(replies) {
  const calls = [];
  const spawnImpl = (_bin, args) => {
    calls.push(args);
    for (const [key, reply] of Object.entries(replies)) {
      if (args.join(" ").startsWith(key)) return reply;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawnImpl, calls };
}

const OK_WORKTREE = { "rev-parse": { status: 0, stdout: "true\n", stderr: "" } };
const HOOKS_DIR_PRESENT = { existsSync: () => true };

/** Did the stub attempt to WRITE the config (as opposed to reading it)? */
function wroteConfig(calls) {
  return calls.some(
    (a) => a[0] === "config" && !a.includes("--get") && a[1] === "core.hooksPath",
  );
}

test("outside a git work tree it skips instead of failing the install", () => {
  // An npm dependency unpacked from a tarball is not a repo. Failing here would
  // break someone's `npm install` over a hook they never asked for.
  const { spawnImpl, calls } = gitStub({
    "rev-parse": { status: 128, stdout: "", stderr: "not a git repository" },
  });
  const res = installGitHooks({ spawnImpl, fsImpl: HOOKS_DIR_PRESENT });

  assert.equal(res.action, "skipped");
  assert.equal(res.reason, "not-a-git-work-tree");
  assert.equal(wroteConfig(calls), false);
});

test("with no .husky directory it skips rather than pointing git at nothing", () => {
  const { spawnImpl, calls } = gitStub(OK_WORKTREE);
  const res = installGitHooks({ spawnImpl, fsImpl: { existsSync: () => false } });

  assert.equal(res.action, "skipped");
  assert.equal(res.reason, "hooks-dir-absent");
  assert.equal(wroteConfig(calls), false);
});

test("an unset core.hooksPath is set to the tracked hooks directory", () => {
  // `git config --get` exits non-zero when the key is unset — the normal state
  // of a fresh clone, and the exact case that left the gate unreachable.
  const { spawnImpl, calls } = gitStub({
    ...OK_WORKTREE,
    "config --get": { status: 1, stdout: "", stderr: "" },
  });
  const res = installGitHooks({ spawnImpl, fsImpl: HOOKS_DIR_PRESENT });

  assert.equal(res.action, "set");
  assert.equal(res.previous, null);
  assert.equal(res.hooksPath, HOOKS_PATH);
  assert.deepEqual(
    calls.find((a) => a[0] === "config" && !a.includes("--get")),
    ["config", "core.hooksPath", HOOKS_PATH],
  );
});

test("a machine-specific absolute value is replaced, and reported", () => {
  // This is what the repository actually carried: an absolute path naming one
  // developer's checkout, which no other clone could ever have.
  const { spawnImpl } = gitStub({
    ...OK_WORKTREE,
    "config --get": { status: 0, stdout: "/Users/someone/repo/.husky\n", stderr: "" },
  });
  const res = installGitHooks({ spawnImpl, fsImpl: HOOKS_DIR_PRESENT });

  assert.equal(res.action, "replaced");
  assert.equal(res.previous, "/Users/someone/repo/.husky");
  assert.equal(res.hooksPath, HOOKS_PATH);
});

test("an already-correct value is left alone (idempotent re-install)", () => {
  const { spawnImpl, calls } = gitStub({
    ...OK_WORKTREE,
    "config --get": { status: 0, stdout: `${HOOKS_PATH}\n`, stderr: "" },
  });
  const res = installGitHooks({ spawnImpl, fsImpl: HOOKS_DIR_PRESENT });

  assert.equal(res.action, "already-set");
  assert.equal(wroteConfig(calls), false);
});

test("a refused config write throws instead of reporting success", () => {
  // Swallowing this would restore the precise failure mode being fixed: the
  // gate present, believed wired, and never running.
  const { spawnImpl } = gitStub({
    ...OK_WORKTREE,
    "config --get": { status: 1, stdout: "", stderr: "" },
    "config core.hooksPath": { status: 4, stdout: "", stderr: "could not lock config file" },
  });

  assert.throws(
    () => installGitHooks({ spawnImpl, fsImpl: HOOKS_DIR_PRESENT }),
    /could not lock config file/,
  );
});

test("`prepare` actually invokes the installer", () => {
  // The installer only runs because npm runs it. If this call is dropped from
  // `prepare`, every assertion above still passes and no clone is wired.
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(
    pkg.scripts?.prepare ?? "",
    /install-git-hooks\.mjs/,
    "package.json `prepare` must run scripts/install-git-hooks.mjs, or a fresh clone gets no hooks",
  );
});

test("the commit-msg hook exists and runs commitlint", () => {
  // `rules/git-conventions.md` promises this gate. Its mode is asserted by
  // check-husky-hook-modes.test.mjs; what it RUNS is asserted here.
  const hook = readFileSync(".husky/commit-msg", "utf8");
  assert.match(hook, /commitlint/, ".husky/commit-msg must invoke commitlint");

  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(
    pkg.devDependencies?.["@commitlint/cli"],
    "@commitlint/cli must be a devDependency — the hook runs it with --no-install",
  );
});
