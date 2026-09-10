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
 * Any fetch that lands in a file, in every spelling a shell author reaches for
 * — narrowing the scope to one spelling is how a real download escapes the
 * guard. In scope:
 *   • `curl -o <path>` / `curl --output <path>` / `curl --output=<path>`;
 *   • a combined curl short group whose value-taking tail is the output flag,
 *     e.g. `curl -sSLo <path>` — the same command, written shorter;
 *   • `curl -O` / `curl --remote-name`, which name the file from the URL
 *     instead of taking a path (and so may sit anywhere in a short group,
 *     `-fsSLO` included, because they take no value);
 *   • `wget -O <path>` / `wget --output-document <path>` — reported against
 *     curl's flag spelling below, deliberately: the first-party fetches are
 *     all curl, and a new wget one should join them rather than invent a
 *     second resilience contract.
 * Deliberately NOT a download, and so not flagged:
 *   • a `curl` with no output flag at all (a status probe, a POST, a fetch
 *     piped straight into another command);
 *   • a write to stdout — `-o -`, `--output -`, and wget's `-O -`. `-O` is the
 *     two commands' false friend: curl's takes no argument (so `curl -O -`
 *     fetches the URL `-`), while wget's is the output path;
 *   • `-o /dev/null`, which is a reachability/status check, not an asset fetch
 *     (`pr-quality.yml`'s fail-fast cancellation POST is exactly this shape).
 * Retrying a POST is a different decision with different safety, and this lint
 * deliberately does not make it.
 *
 * HOW FLAGS ARE MATCHED
 * ---------------------
 * As whole shell words, never as substrings: `--retry-connrefused` does not
 * satisfy `--retry`, and a flag sitting inside a trailing `#` comment does not
 * count. A `#` opens a comment only at start of line or after whitespace and
 * outside quotes, so `$#`, `${#arr[@]}` and a fragment `#` inside a quoted URL
 * are left alone. Every pattern here is a literal regex.
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

/** `curl` invoked as a command — after whitespace or a shell operator. */
const CURL_COMMAND = /(^|[\s;&|(])curl(\s|$)/;
/** `wget` invoked as a command — same boundary rule. */
const WGET_COMMAND = /(^|[\s;&|(])wget(\s|$)/;
/** A combined short-option group: one `-` followed by letters only. */
const SHORT_GROUP = /^-[A-Za-z]+$/;
/** Quote characters wrapping a word, stripped so a path compares as itself. */
const LEADING_QUOTES = /^['"]+/;
const TRAILING_QUOTES = /['"]+$/;
/** Output targets that are not a fetched asset on disk. */
const STDOUT_TARGETS = new Set(['-', '/dev/null']);
/** Long output flags in their `--flag=value` spelling. */
const CURL_OUTPUT_EQ = '--output=';
const WGET_OUTPUT_EQ = '--output-document=';

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
 * Pure: drop a shell comment and everything after it.
 *
 * `#` only opens a comment at the start of the line or after whitespace, and
 * only outside quotes — which is what keeps `$#`, `${#arr[@]}` and the fragment
 * in `"https://host/p#frag"` from truncating the command that carries them.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripShellComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\' && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const opensComment =
      char === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t');
    if (opensComment) return text.slice(0, i);
  }
  return text;
}

/**
 * Pure: the shell words of a logical line — comment dropped, split on
 * whitespace, wrapping quotes removed so `"-"` compares equal to `-`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function shellWords(text) {
  return stripShellComment(text)
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.replace(LEADING_QUOTES, '').replace(TRAILING_QUOTES, ''));
}

/**
 * Pure: does this curl invocation write its body to a real file? See the
 * header for the spellings in scope and the ones deliberately excluded.
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function curlWritesFile(words) {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const shortGroup = SHORT_GROUP.test(word);
    // `-O` takes no value, so it may sit anywhere in a group (`-fsSLO`).
    if (word === '--remote-name' || (shortGroup && word.includes('O'))) return true;
    if (word.startsWith(CURL_OUTPUT_EQ)) {
      return !STDOUT_TARGETS.has(word.slice(CURL_OUTPUT_EQ.length));
    }
    // `-o` takes a value, so in a group it must be the tail: `-sSLo <path>`.
    if (word === '--output' || (shortGroup && word.endsWith('o'))) {
      return !STDOUT_TARGETS.has(words[i + 1] ?? '-');
    }
  }
  return false;
}

/**
 * Pure: does this wget invocation write its body to a real file? Unlike curl,
 * wget's `-O` IS the output path — `wget -O - "$url"` is a stdout pipe.
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function wgetWritesFile(words) {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word.startsWith(WGET_OUTPUT_EQ)) {
      return !STDOUT_TARGETS.has(word.slice(WGET_OUTPUT_EQ.length));
    }
    if (word === '-O' || word === '--output-document') {
      return !STDOUT_TARGETS.has(words[i + 1] ?? '-');
    }
  }
  return false;
}

/**
 * Pure: does this logical line fetch an artifact into a file? See the header
 * for every spelling in scope and for what is deliberately excluded.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isAssetDownload(text) {
  const command = stripShellComment(text);
  const words = shellWords(command);
  if (CURL_COMMAND.test(command)) return curlWritesFile(words);
  if (WGET_COMMAND.test(command)) return wgetWritesFile(words);
  return false;
}

/**
 * Pure: is `flag` present as its own argument — on its own or as `flag=value`?
 * Substring matching is what let `--retry-connrefused` satisfy `--retry`.
 *
 * @param {string[]} words
 * @param {string} flag
 * @returns {boolean}
 */
function hasFlag(words, flag) {
  const assigned = `${flag}=`;
  return words.some((word) => word === flag || word.startsWith(assigned));
}

/**
 * Pure: the required flags this download is missing, in table order.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function missingFlags(text) {
  const words = shellWords(text);
  return REQUIRED_FLAGS.filter(({ flag }) => !hasFlag(words, flag)).map(
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
