#!/usr/bin/env node
/**
 * run-lint.mjs — the `npm run lint` driver for mandrel-platform itself.
 *
 * ## Why this file exists rather than the vendored driver
 *
 * The vendored payload under `.agents/scripts/` ships a `run-lint.js` of its
 * own, and reaching for it is the obvious move. It is the wrong one here: it runs `biome ci .`
 * — a formatter check as well as a lint, over the whole tree including the
 * vendored `.agents/` payload — and then fans out to half a dozen gates that
 * only mean something inside the framework's own repo. Adopting it would
 * reformat this tree against a line width it never chose and lint 543 files
 * that `mandrel update` overwrites anyway.
 *
 * ## Why it enforces warnings
 *
 * `biome lint` exits 0 on warnings and infos. A driver that just shells out
 * and trusts the exit code therefore enforces only Biome's five error-level
 * findings while two dozen others stand behind a green check — which is the
 * exact shape of defect this repo's lint adoption exists to remove.
 * `--error-on-warnings` is what gives the gate teeth. Info-level findings
 * (`useTemplate`, `useIndexOf`) stay advisory by choice.
 *
 * ## The two rules biome.json turns off — recorded here because JSON carries
 * no comments
 *
 * `noTemplateCurlyInString`: 38 hits, 37 of them in `scripts/*.test.mjs`, and
 * every one is a GitHub Actions expression held in a string literal because
 * these scripts lint workflow files. The rule is right in general and wrong
 * about this repo.
 *
 * `useBiomeIgnoreFolder`: it flags the trailing-glob ignore form and advises
 * a bare folder name instead. Measured on Biome 2.5.0 against this tree, that
 * advice is wrong — the bare form for `.claude` excluded nothing (695 files
 * checked rather than 119), and all five bare patterns together excluded
 * everything (0 files). The trailing-glob form is the one that actually
 * scopes the run, so the rule is off rather than the working config broken to
 * satisfy it.
 *
 * ## Contract
 *
 * Both surfaces always run — the second is not short-circuited by the first —
 * so one invocation shows every failure instead of revealing them one bounce
 * at a time. Exit is 0 only when both are clean.
 *
 * Runners resolve from `node_modules/.bin`, never through `npx`, so this can
 * never silently registry-fetch an unpinned linter.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(repoRoot, 'node_modules', '.bin');

/** The surfaces this repo lints, in report order. */
const SURFACES = [
  {
    name: 'markdown',
    bin: 'markdownlint-cli2',
    // Globs and ignores live in `.markdownlint-cli2.jsonc` so a bare
    // invocation and this driver cannot disagree about scope.
    args: [],
  },
  {
    name: 'code',
    bin: 'biome',
    args: ['lint', '--error-on-warnings', '.'],
  },
];

let failed = false;

for (const surface of SURFACES) {
  const bin = path.join(binDir, surface.bin);
  if (!existsSync(bin)) {
    console.error(
      `[lint] ${surface.name}: runner \`${surface.bin}\` is not installed at ${bin}.`,
    );
    console.error('[lint] Run `npm ci` first — this driver never fetches a runner at run time.');
    failed = true;
    continue;
  }

  console.log(`[lint] ${surface.name} — ${surface.bin} ${surface.args.join(' ')}`);
  const result = spawnSync(bin, surface.args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`[lint] ${surface.name}: ${result.error.message}`);
    failed = true;
    continue;
  }
  if ((result.status ?? 1) !== 0) {
    console.error(`[lint] ${surface.name}: FAILED (exit ${result.status}).`);
    failed = true;
    continue;
  }
  console.log(`[lint] ${surface.name}: clean.`);
}

if (failed) {
  console.error('[lint] ❌ lint failed — see the surface output above.');
  process.exit(1);
}
console.log('[lint] ✅ all surfaces clean.');
