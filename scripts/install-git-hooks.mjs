#!/usr/bin/env node
/**
 * install-git-hooks.mjs — point git at this repository's tracked hooks.
 *
 * Wired into `prepare`, so a plain `npm install` leaves a fresh clone with its
 * hooks running. Before this existed nothing in the repository set
 * `core.hooksPath` at all — no husky dependency, no bootstrap step — so git
 * looked in `.git/hooks`, found nothing, and committed normally. The `.husky/`
 * gate was unreachable in every clone no matter what mode its files carried,
 * which is the second half of the defect Story #511 fixed the first half of.
 *
 * ## Why the value is relative
 *
 * `core.hooksPath` is resolved by git against **each working tree's own root**,
 * not against the common git dir. That cuts both ways:
 *
 *   - An **absolute** path works identically from every working tree, but it
 *     names one machine's checkout, so it can never be committed — which is
 *     exactly how this repository ended up depending on a `git config` someone
 *     ran by hand once.
 *   - A **relative** `.husky` is committable, and here it is also correct from
 *     a linked worktree, because `.husky/*` is **tracked**: every worktree
 *     checks the hooks out for itself. The hazard the framework's
 *     `.agents/scripts/lib/worktree/git-hooks.js` warns about — a hooks path
 *     resolving to a directory that is not there — comes from husky's
 *     *generated, self-ignored* `.husky/_` shim, which this repository does not
 *     use.
 *
 * So the relative form is the one that can live in git, and tracking the hooks
 * is what makes it safe.
 *
 * ## Interaction with the worktree hook provisioner
 *
 * Moving off an absolute value changes which branch
 * `.agents/scripts/lib/worktree/git-hooks.js` takes: it no longer short-circuits
 * on `hooks-path-absolute`, it copies the main checkout's `.husky` into the
 * linked worktree — deliberately "refreshing rather than preserving", so it
 * REPLACES whatever is there. At worktree creation that is a no-op, because the
 * worktree was just seeded from the same base. It bites only when that
 * provisioner is re-run by hand inside a worktree whose branch adds or edits a
 * hook the base branch does not carry yet: the working-tree copy is discarded
 * and is restored with `git checkout -- .husky/<hook>` (the commit is
 * untouched). The trade is deliberate — the payoff is that a worktree is gated
 * by the hooks ITS OWN branch tracks, which is what lets a change to a hook be
 * tested on the branch making it.
 *
 * ## Scope of the write
 *
 * The value is written at **local** scope (`.git/config`), which linked
 * worktrees share, so one install covers the whole checkout. A pre-existing
 * **worktree-scoped** override still wins over local scope by design; clear one
 * with `git config --worktree --unset core.hooksPath` if a worktree was pinned
 * to some other path.
 *
 * Idempotent, and deliberately total about doing nothing: an install that is
 * not inside a git work tree (an npm dependency unpacked from a tarball, a
 * source archive) reports a skip and exits 0 rather than failing someone's
 * install over a hook.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { isDirectInvocation } from "./lib/entry-guard.mjs";

/** The committed hooks directory, relative to the working-tree root. */
export const HOOKS_PATH = ".husky";

/**
 * Ensure `core.hooksPath` points at {@link HOOKS_PATH}.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]        Directory to run git in.
 * @param {typeof fs} [opts.fsImpl]  Filesystem seam.
 * @param {typeof defaultSpawnSync} [opts.spawnImpl] Child-process seam.
 * @returns {{ action: 'set'|'replaced'|'already-set'|'skipped',
 *   reason?: string, previous?: string|null, hooksPath: string|null }}
 * @throws {Error} when git refuses the write — a silent failure here would
 *   restore the exact "gate present, never runs" state this script exists to
 *   end.
 */
export function installGitHooks({
  cwd = process.cwd(),
  fsImpl = fs,
  spawnImpl = defaultSpawnSync,
} = {}) {
  const git = (...args) => spawnImpl("git", args, { cwd, encoding: "utf8" });

  const inside = git("rev-parse", "--is-inside-work-tree");
  if (inside.status !== 0 || (inside.stdout ?? "").trim() !== "true") {
    return { action: "skipped", reason: "not-a-git-work-tree", hooksPath: null };
  }

  if (!fsImpl.existsSync(path.resolve(cwd, HOOKS_PATH))) {
    return { action: "skipped", reason: "hooks-dir-absent", hooksPath: null };
  }

  const read = git("config", "--get", "core.hooksPath");
  // `--get` exits non-zero when the key is unset, which is the normal state of
  // a fresh clone rather than an error.
  const current = read.status === 0 ? (read.stdout ?? "").trim() : "";
  if (current === HOOKS_PATH) {
    return { action: "already-set", hooksPath: HOOKS_PATH };
  }

  const write = git("config", "core.hooksPath", HOOKS_PATH);
  if (write.status !== 0) {
    throw new Error(
      `install-git-hooks: could not set core.hooksPath: ${(write.stderr ?? "").trim() || `git exited ${write.status}`}`,
    );
  }

  return {
    action: current ? "replaced" : "set",
    previous: current || null,
    hooksPath: HOOKS_PATH,
  };
}

if (isDirectInvocation(import.meta.url)) {
  const result = installGitHooks();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
