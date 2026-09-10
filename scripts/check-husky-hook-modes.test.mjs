#!/usr/bin/env node
/**
 * check-husky-hook-modes.test.mjs — regression guard for the mode bit that
 * decides whether this repository's git hooks run at all.
 *
 * The bug this pins: `.husky/pre-commit` was tracked at mode 100644. Git
 * 2.36+ refuses to execute a hook that is not marked executable, and the way
 * it refuses is the problem — it prints
 *
 *     hint: The '.../.husky/pre-commit' hook was ignored because it's not
 *           set as executable.
 *
 * to stderr and then lets the commit SUCCEED with exit 0. So the quality gate
 * the hook exists to run (`quality-preview.js`, which blocks MI/CRAP drift at
 * commit time) never ran for anybody, in any clone, from the day it was
 * added — and nothing anywhere went red to say so. An inert gate and a
 * passing gate are indistinguishable from the outside.
 *
 * Why the mode is asserted against the INDEX and not the filesystem. `chmod`
 * on the working copy is not the fix and would not be caught here: git stores
 * only two file modes, 100644 and 100755, and it is the tracked one that
 * every fresh clone and every `git checkout` materializes. A working tree can
 * be executable while the committed mode is not (and vice versa), so a
 * `statSync` check would go green on the maintainer's machine and ship the
 * defect to everyone else. `git ls-files -s` reads the index, which is the
 * mode that actually propagates.
 *
 * Why this is not a one-line assertion on one path. The upstream cause is
 * still live: the hook is installed by the vendored bootstrap
 * (`.agents/scripts/lib/bootstrap/quality-bootstrap.js`) with a bare
 * `fs.writeFileSync` and no `chmod`, so a hook file CREATED by a fresh
 * bootstrap run is born 0644. (An existing file survives — `writeFileSync`
 * truncates in place and preserves the mode — which is why fixing the tracked
 * mode holds.) `.agents/**` is vendored payload re-materialized from the
 * mandrel package, so that cause cannot be fixed here; this guard is the
 * compensating control, and it therefore covers every hook the directory may
 * grow, not just the one that was broken.
 *
 * Run: node --test scripts/check-husky-hook-modes.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";

const HOOKS_DIR = ".husky";
const EXECUTABLE = "100755";

/**
 * Every client-side hook name git will invoke. A file in `.husky/` whose name
 * is not on this list is never run by git no matter what its mode is, so a
 * typo (`pre_commit`, `precommit`) is the same silent no-op as a missing
 * executable bit and is asserted against below.
 *
 * Source: `githooks(5)`, client-side hooks only — server-side hooks
 * (`pre-receive`, `update`, `post-receive`) cannot fire from a clone.
 */
const GIT_CLIENT_HOOKS = new Set([
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "post-index-change",
  "reference-transaction",
  "push-to-checkout",
]);

/**
 * Tracked entries directly under `.husky/`, as `{ mode, path, name }`.
 *
 * `git ls-files -s` emits `<mode> <object> <stage>\t<path>`. Husky's own
 * `_/` shim directory and dotfiles (`.gitignore`) are not hooks and are
 * excluded; everything else in the directory is one by convention.
 */
function trackedHooks() {
  const out = execFileSync("git", ["ls-files", "-s", "--", HOOKS_DIR], {
    encoding: "utf8",
  });

  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { mode: meta.split(" ")[0], path, name: path.slice(HOOKS_DIR.length + 1) };
    })
    .filter(({ name }) => !name.startsWith(".") && !name.startsWith("_/"));
}

test("the quality-gate pre-commit hook is still tracked", () => {
  // Without this the mode assertion below passes vacuously the moment the
  // hook is deleted — which is the same outcome (no gate) by another route.
  const names = trackedHooks().map((h) => h.name);
  assert.ok(
    names.includes("pre-commit"),
    `${HOOKS_DIR}/pre-commit is not tracked; the commit-time quality gate would not run. Tracked: ${names.join(", ") || "(none)"}`,
  );
});

test("every tracked hook under .husky/ is executable in the index", () => {
  const hooks = trackedHooks();
  assert.ok(hooks.length > 0, `no tracked hooks found under ${HOOKS_DIR}/`);

  const nonExecutable = hooks.filter((h) => h.mode !== EXECUTABLE);
  assert.deepEqual(
    nonExecutable.map((h) => `${h.path} (${h.mode})`),
    [],
    `git 2.36+ silently IGNORES a non-executable hook and lets the commit succeed with exit 0. ` +
      `Fix the tracked mode with: git update-index --chmod=+x <path>  (a bare chmod does not change it).`,
  );
});

test("every tracked hook under .husky/ has a name git will actually invoke", () => {
  const unknown = trackedHooks()
    .map((h) => h.name)
    .filter((name) => !GIT_CLIENT_HOOKS.has(name));

  assert.deepEqual(
    unknown,
    [],
    `git invokes hooks by exact filename; a name outside githooks(5) never runs, as silently as a non-executable one.`,
  );
});
