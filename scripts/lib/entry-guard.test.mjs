#!/usr/bin/env node
/**
 * entry-guard.test.mjs — node:test suite for the shared direct-invocation
 * guard (`scripts/lib/entry-guard.mjs`, Story #407).
 *
 * The load-bearing case is the symlinked one: pnpm installs packages as
 * symlinks, and the guard spelling this helper replaces compared a
 * realpath-resolved `import.meta.url` against an unresolved `process.argv[1]`.
 * Under pnpm those never matched, so the CLI never ran and the process exited
 * 0 having printed nothing — a silent pass. Every assertion below that builds
 * a symlink exists to keep that specific regression dead.
 *
 * Offline: the suite only creates files and symlinks under a temp dir and
 * swaps `process.argv[1]`, which it restores after each case.
 *
 * Run: node --test scripts/lib/entry-guard.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isDirectInvocation } from './entry-guard.mjs';

/**
 * Run `fn` with `process.argv[1]` swapped to `entry`, restoring it after.
 *
 * @param {string | undefined} entry Value to install at `process.argv[1]`.
 * @param {() => void} fn Body to run under the swapped argv.
 */
function withArgv(entry, fn) {
  const original = process.argv[1];
  if (entry === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = entry;
  }
  try {
    fn();
  } finally {
    process.argv[1] = original;
  }
}

/**
 * Build a temp dir holding `store/pkg/scripts/cli.mjs` plus a `link` symlink
 * pointing at `store/pkg` — the shape pnpm's `node_modules` produces.
 *
 * @returns {{ dir: string, realScript: string, linkedScript: string }}
 */
function makeSymlinkedPackage() {
  const dir = mkdtempSync(join(tmpdir(), 'entry-guard-test-'));
  const pkg = join(dir, 'store', 'pkg');
  mkdirSync(join(pkg, 'scripts'), { recursive: true });
  const realScript = join(pkg, 'scripts', 'cli.mjs');
  writeFileSync(realScript, '// fixture\n');
  const link = join(dir, 'link');
  symlinkSync(pkg, link, 'dir');
  return { dir, realScript, linkedScript: join(link, 'scripts', 'cli.mjs') };
}

// ---------------------------------------------------------------------------
// The regression this helper exists for
// ---------------------------------------------------------------------------

test('isDirectInvocation matches when the entry path traverses a symlink', () => {
  const { dir, realScript, linkedScript } = makeSymlinkedPackage();
  try {
    // The module was loaded through its realpath (what the ESM loader does),
    // while argv[1] kept the symlinked path (what the caller typed). This is
    // exactly the pnpm shape that used to answer false.
    withArgv(linkedScript, () => {
      assert.equal(
        isDirectInvocation(pathToFileURL(realScript).href),
        true,
        'a symlinked invocation must still count as direct',
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isDirectInvocation matches with the symlink on the module side too', () => {
  const { dir, realScript, linkedScript } = makeSymlinkedPackage();
  try {
    withArgv(realScript, () => {
      assert.equal(isDirectInvocation(pathToFileURL(linkedScript).href), true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Ordinary direct / imported cases
// ---------------------------------------------------------------------------

test('isDirectInvocation matches an unsymlinked direct invocation', () => {
  const { dir, realScript } = makeSymlinkedPackage();
  try {
    withArgv(realScript, () => {
      assert.equal(isDirectInvocation(pathToFileURL(realScript).href), true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isDirectInvocation resolves a relative entry path against cwd', () => {
  withArgv('scripts/lib/entry-guard.test.mjs', () => {
    const absolute = join(process.cwd(), 'scripts/lib/entry-guard.test.mjs');
    assert.equal(isDirectInvocation(pathToFileURL(absolute).href), true);
  });
});

test('isDirectInvocation answers false when another module is the entry', () => {
  const { dir, realScript } = makeSymlinkedPackage();
  try {
    const sibling = join(dir, 'store', 'pkg', 'scripts', 'other.mjs');
    writeFileSync(sibling, '// fixture\n');
    withArgv(sibling, () => {
      assert.equal(isDirectInvocation(pathToFileURL(realScript).href), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Totality — the guard must never throw on an import
// ---------------------------------------------------------------------------

test('isDirectInvocation answers false when argv[1] is absent', () => {
  withArgv(undefined, () => {
    assert.equal(isDirectInvocation(import.meta.url), false);
  });
});

test('isDirectInvocation answers false for an empty argv[1]', () => {
  withArgv('', () => {
    assert.equal(isDirectInvocation(import.meta.url), false);
  });
});

test('isDirectInvocation tolerates an entry path that does not exist', () => {
  const missing = join(tmpdir(), 'entry-guard-does-not-exist-407', 'cli.mjs');
  withArgv(missing, () => {
    assert.doesNotThrow(() => isDirectInvocation(import.meta.url));
    assert.equal(isDirectInvocation(import.meta.url), false);
    // A non-existent path still compares equal to itself rather than
    // collapsing to a blanket false.
    assert.equal(isDirectInvocation(pathToFileURL(missing).href), true);
  });
});

test('isDirectInvocation answers false for a non-file module URL', () => {
  withArgv('/tmp/whatever.mjs', () => {
    assert.equal(isDirectInvocation('https://example.com/cli.mjs'), false);
    assert.equal(isDirectInvocation('data:text/javascript,0'), false);
  });
});

test('isDirectInvocation answers false for a missing or malformed URL', () => {
  withArgv('/tmp/whatever.mjs', () => {
    assert.equal(isDirectInvocation(''), false);
    assert.equal(isDirectInvocation(/** @type {any} */ (undefined)), false);
    assert.equal(isDirectInvocation('not a url'), false);
  });
});
