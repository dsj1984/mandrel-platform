/**
 * scripts/lib/walk.mjs
 *
 * The single directory-discovery seam for the pin-tooling scripts. Both
 * `check-action-pins.mjs` and `check-workflow-portability.mjs` had grown their
 * own `listWorkflowFiles` / `listActionFiles` pair — same intent, subtly
 * different code (one sorted, one didn't; one guarded `statSync`, one didn't).
 * Story #203 consolidates them here.
 *
 * All discovery is best-effort: a missing directory or an unreadable entry
 * yields `[]` / is skipped rather than throwing, so a repo without a
 * `.github/actions/` tree lints cleanly. Results are sorted for deterministic
 * output.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * List `*.yml` / `*.yaml` files directly under a workflows dir
 * (non-recursive — GitHub only runs top-level workflow files).
 *
 * @param {string} dir
 * @returns {string[]} Sorted absolute/relative paths (as joined from `dir`).
 */
export function listWorkflowFiles(dir) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Recursively list composite `action.yml` / `action.yaml` files under a dir.
 *
 * @param {string} dir
 * @returns {string[]} Sorted paths.
 */
export function listActionFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (/^action\.ya?ml$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}
