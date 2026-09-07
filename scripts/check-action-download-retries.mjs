#!/usr/bin/env node
/**
 * check-action-download-retries.mjs — assert every release-asset download in a
 * first-party composite action retries.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three first-party actions fetch a pinned release binary over `curl`. Two of
 * them —`osv-scan` and `workflow-lint` — pass
 * `--retry 3 --retry-connrefused --max-time 300`. `gitleaks-scan` passed
 * nothing, and on 2026-09-07 a single transient 504 from GitHub's release CDN
 * killed the security job outright:
 *
 *     Downloading pinned gitleaks: https://github.com/gitleaks/gitleaks/…
 *     curl: (22) The requested URL returned error: 504
 *     ##[error]Process completed with exit code 22
 *
 * That job is a `needs:` of `ci-required`, and `pr-quality.yml` calls the same
 * action, so the blast radius was every consumer's CI as well as this repo's
 * own release. Nothing in the repo noticed that one of three sibling downloads
 * had quietly shipped without the resilience the other two had — which is the
 * gap this lint closes. Retries are mitigation, not a cure: the RETRYING
 * actionlint fetch also failed, four times, in the same outage window. What
 * this buys is the common single-blip case.
 *
 * WHAT COUNTS AS A DOWNLOAD
 * -------------------------
 * A `curl` invocation that writes a fetched artifact to a file — `-o <path>` or
 * `--output <path>`. Deliberately NOT a download, and so not flagged:
 *   • a `curl` with no output flag (a status probe, a POST);
 *   • `-o /dev/null`, which is a reachability/status check, not an asset fetch
 *     (`pr-quality.yml`'s fail-fast cancellation POST is exactly this shape).
 * Retrying a POST is a different decision with different safety, and this lint
 * deliberately does not make it.
 *
 * SCOPE: `.github/actions/**` action manifests. Exit 0 when clean, 1 when any
 * download is missing a required flag (prints file:line and the missing set).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { isDirectInvocation } from './lib/entry-guard.mjs';

/** Root of the first-party composite-action surface this lint governs. */
const ACTIONS_DIR = '.github/actions';

/**
 * Flags every asset download must carry, with why each one matters. Kept as a
 * literal table so a reader can see the contract without running the lint.
 */
export const REQUIRED_FLAGS = Object.freeze([
  Object.freeze({
    flag: '--retry',
    why: 'a transient 5xx from the release CDN must not fail the job on the first attempt',
  }),
  Object.freeze({
    flag: '--retry-connrefused',
    why: 'a refused connection is exactly the transient case worth retrying, and curl excludes it by default',
  }),
  Object.freeze({
    flag: '--max-time',
    why: 'an unbounded fetch hangs the job until the runner timeout instead of failing fast',
  }),
]);

/**
 * Pure: fold shell line-continuations so a `curl` split across several lines is
 * linted as the single command it is. The logical line keeps the 1-based number
 * of the line the command STARTED on, which is what a reader needs to find it.
 *
 * @param {string} source
 * @returns {Array<{ line: number, text: string }>}
 */
export function collapseContinuations(source) {
  const out = [];
  let pending = null;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const continues = /\\\s*$/.test(raw);
    const body = raw.replace(/\\\s*$/, '');
    if (pending === null) {
      pending = { line: i + 1, text: body };
    } else {
      pending.text = `${pending.text.trimEnd()} ${body.trim()}`;
    }
    if (!continues) {
      out.push(pending);
      pending = null;
    }
  }
  if (pending !== null) out.push(pending);
  return out;
}

/**
 * Pure: does this logical line invoke `curl` to write a fetched artifact to a
 * real file? See the header for what is deliberately excluded.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isAssetDownload(text) {
  if (!/(^|[\s;&|(])curl(\s|$)/.test(text)) return false;
  const output = text.match(/(?:^|\s)(?:-o|--output)\s+(\S+)/);
  if (!output) return false;
  // `-o /dev/null` is a status probe, not an asset fetch.
  return !/^["']?\/dev\/null["']?$/.test(output[1]);
}

/**
 * Pure: the required flags this download is missing, in table order.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function missingFlags(text) {
  return REQUIRED_FLAGS.filter(({ flag }) => !text.includes(flag)).map(
    ({ flag }) => flag,
  );
}

/**
 * Pure: lint one action manifest's source.
 *
 * @param {string} path
 * @param {string} source
 * @returns {Array<{ path: string, line: number, missing: string[] }>}
 */
export function lintSource(path, source) {
  const findings = [];
  for (const { line, text } of collapseContinuations(source)) {
    if (!isAssetDownload(text)) continue;
    const missing = missingFlags(text);
    if (missing.length > 0) findings.push({ path, line, missing });
  }
  return findings;
}

/**
 * Every `action.yml` / `action.yaml` under the first-party action surface.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function findActionManifests(root = ACTIONS_DIR) {
  if (!existsSync(root)) return [];
  const manifests = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of ['action.yml', 'action.yaml']) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) manifests.push(candidate);
    }
  }
  return manifests.sort();
}

export function main() {
  const manifests = findActionManifests();
  const findings = [];
  for (const path of manifests) {
    findings.push(...lintSource(path, readFileSync(path, 'utf8')));
  }

  if (findings.length === 0) {
    console.log(
      `[check-action-download-retries] ✓ ${manifests.length} action manifest(s) — every asset download retries.`,
    );
    return 0;
  }

  console.error(
    `[check-action-download-retries] ✗ ${findings.length} asset download(s) missing retry flags:\n`,
  );
  for (const { path, line, missing } of findings) {
    console.error(`  ${path}:${line} — missing ${missing.join(', ')}`);
  }
  console.error('\nRequired on every asset download:');
  for (const { flag, why } of REQUIRED_FLAGS) {
    console.error(`  ${flag} — ${why}`);
  }
  console.error(
    '\nA single transient 5xx otherwise fails the job, and for a published action that is every consumer.',
  );
  return 1;
}

// Direct-invocation guard — symlink-safe via the shared seam (Story #407).
if (isDirectInvocation(import.meta.url)) {
  process.exit(main());
}
