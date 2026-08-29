/**
 * scripts/lib/entry-guard.mjs
 *
 * The single direct-invocation ("am I the process entry point?") seam shared
 * by the `scripts/*.mjs` CLIs. Each of those scripts had grown its own guard,
 * and they had drifted into three mutually incompatible spellings:
 *
 *   1. `resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)`
 *   2. `import.meta.url === \`file://${process.argv[1]}\``
 *   3. `resolve(process.argv[1]).endsWith('<name>.mjs')`
 *
 * Spellings 1 and 2 are both broken under pnpm, and broken in the most
 * dangerous possible way — silently. `import.meta.url` is **realpath-resolved**
 * by the ESM loader, while `process.argv[1]` is not: it keeps whatever path the
 * caller typed. pnpm installs every package as a symlink
 * (`node_modules/<pkg>` → `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>`),
 * so a consumer invoking
 *
 *     node node_modules/mandrel-platform/scripts/check-wrangler-baseline.mjs
 *
 * compares the symlinked path against the store realpath. They never match, the
 * guard is false, the CLI never runs, and the process exits 0 having printed
 * nothing. In a CI log that is indistinguishable from a clean pass — the gate
 * reports success precisely because it did not run (Story #407, superseding the
 * consumer report in #406).
 *
 * Spelling 2 fails a second way even without a symlink: it string-compares a
 * URL against an unencoded path, so a relative `argv[1]` (`node scripts/x.mjs`)
 * or any path needing percent-encoding (a space, a `#`) also misses.
 *
 * Spelling 3 is not broken — a path suffix survives realpath resolution — but
 * it is loose (any file with that basename matches) and it duplicates the
 * script's own name as a string literal that nothing keeps in sync with a
 * rename. It is left in place where it already exists; new entry points should
 * use this helper.
 *
 * `isDirectInvocation(importMetaUrl)` resolves BOTH sides through
 * `realpathSync` so the comparison is symlink-agnostic in either direction. It
 * is total: it never throws, and answers `false` for every shape that cannot be
 * a direct invocation (no `argv[1]`, a deleted or unreadable entry path), so
 * merely importing a module for its exports can never crash on the guard line
 * and can never be mistaken for running it.
 *
 * This module performs no I/O beyond the two realpath probes and reads no
 * environment, so the sibling `entry-guard.test.mjs` suite exercises it
 * entirely offline.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a filesystem path through `realpathSync`, falling back to a plain
 * absolute resolution when the path cannot be realpath'd.
 *
 * A path that does not exist has no realpath — `realpathSync` throws ENOENT.
 * That is a normal, non-exceptional case here (`process.argv[1]` can name a
 * file that was deleted mid-run, and is absent entirely under `node -e`), so
 * it degrades to `resolve()` rather than propagating. Two non-existent paths
 * then still compare equal to themselves, which keeps the guard meaningful
 * instead of collapsing to a blanket `false`.
 *
 * @param {string} candidate Path to canonicalize.
 * @returns {string} The realpath when resolvable, else the absolute path.
 */
function canonicalize(candidate) {
  const absolute = resolve(candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Report whether the module identified by `importMetaUrl` is the process entry
 * point — i.e. whether it was run as `node <this-file>` rather than imported.
 *
 * Symlink-safe in both directions: the entry path and the module URL are each
 * canonicalized through `realpathSync`, so a pnpm-style symlinked
 * `node_modules` invocation matches its own store realpath.
 *
 * Total by construction — never throws. A `file:` URL that cannot be converted
 * to a path (an `http:`/`data:` specifier, a malformed URL) answers `false`,
 * because such a module cannot be a filesystem entry point.
 *
 * @param {string} importMetaUrl The calling module's `import.meta.url`.
 * @returns {boolean} True when this module is the direct invocation target.
 *
 * @example
 *   if (isDirectInvocation(import.meta.url)) {
 *     process.exit(runCli());
 *   }
 */
export function isDirectInvocation(importMetaUrl) {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  if (typeof importMetaUrl !== 'string' || importMetaUrl === '') return false;

  let modulePath;
  try {
    modulePath = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }

  return canonicalize(entry) === canonicalize(modulePath);
}
