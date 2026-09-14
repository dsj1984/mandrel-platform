#!/usr/bin/env node
/**
 * release-asset-download-flags.test.mjs — node:test guard over the retry flags
 * on every pinned release-asset download in a first-party composite action
 * (Story #523).
 *
 * WHY A SECOND GUARD
 * ------------------
 * `scripts/check-action-download-retries.mjs` already lints that every asset
 * download carries `--retry`, `--retry-connrefused` and `--max-time`. That
 * contract turned out to be insufficient for the failure the release CDN
 * actually produces: on 2026-09-14 a consumer's `ci / Security` job logged
 *
 *     Downloading pinned gitleaks: https://github.com/gitleaks/gitleaks/…
 *     curl: (56) The requested URL returned error: 504
 *
 * and the step took **196 ms** — three retries with curl's default backoff
 * take ≥ 7 s, so no retry fired. curl treats HTTP 408/429/5xx as transient
 * only when it can read them as a response; a 504 that arrives as a broken
 * transfer surfaces as `CURLE_RECV_ERROR` (exit 56), outside that set.
 * `--retry-all-errors` (curl ≥ 7.71) is what makes it retryable.
 *
 * So the flag this file pins is deliberately NOT folded into the existing
 * lint's `REQUIRED_FLAGS`: that lint governs *every* asset download in the
 * action surface, whereas the exit-56 case is specific to the GitHub release
 * CDN. This guard scopes itself to `releases/download` URLs and complements
 * the lint rather than restating it — it reuses the lint's exported shell
 * parsing (`collapseContinuations`, `shellWords`) so the two cannot disagree
 * about what a `curl` line even is.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   1. Each of the three action manifests that fetch a pinned release binary
 *      still fetches one, and every such line carries `--retry-all-errors`
 *      alongside `--retry` (a flag set that retries nothing is worse than no
 *      flags, because it reads as covered).
 *   2. No OTHER action manifest has quietly grown a release-asset download
 *      that this file's list would miss — a fourth site must join the
 *      contract, not escape it.
 *   3. Checksum verification is still fail-closed in each manifest: the retry
 *      widens what is attempted, never what is trusted (AC-3).
 *   4. The detector itself is exercised on synthetic fixtures, so a change
 *      that makes it match nothing fails here rather than passing vacuously.
 *
 * Run: node --test scripts/release-asset-download-flags.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collapseContinuations,
  findActionManifests,
  shellWords,
  stripShellComment,
} from "./check-action-download-retries.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

/**
 * The action manifests that fetch a pinned release binary, with how many such
 * fetches each one owns. The counts are part of the contract: a site that
 * disappears is as much a regression signal as one that ships uncovered.
 */
const RELEASE_ASSET_ACTIONS = Object.freeze([
  Object.freeze({ path: ".github/actions/gitleaks-scan/action.yml", downloads: 1 }),
  Object.freeze({ path: ".github/actions/workflow-lint/action.yml", downloads: 2 }),
  Object.freeze({ path: ".github/actions/osv-scan/action.yml", downloads: 1 }),
]);

/**
 * Flags every release-asset download must carry, with why each one matters.
 * `--retry` without `--retry-all-errors` is the state Story #523 found: the
 * flags read as resilient and covered nothing the CDN produces.
 */
const REQUIRED_RETRY_FLAGS = Object.freeze(["--retry", "--retry-all-errors"]);

/** A GitHub release-asset URL, in any of the spellings the actions use. */
const RELEASE_ASSET_URL = /releases\/download\//;
/** `curl` invoked as a command — after start-of-line, whitespace or an operator. */
const CURL_COMMAND = /(^|[\s;&|(])curl(\s|$)/;
/** A shell assignment: `name=value`, optionally exported. */
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;
/** Characters that continue a bare `$name` reference. */
const NAME_CHAR = /[A-Za-z0-9_]/;

/**
 * Pure: does `word` reference the shell variable `name`, as `${name}` or as a
 * bare `$name` that ends there? The bare form needs the boundary check or
 * `$url` would match `$urls`.
 *
 * @param {string} word
 * @param {string} name
 * @returns {boolean}
 */
function referencesVariable(word, name) {
  if (word.includes(`\${${name}}`)) return true;
  const bare = `$${name}`;
  let from = 0;
  for (;;) {
    const at = word.indexOf(bare, from);
    if (at === -1) return false;
    const next = word[at + bare.length];
    if (next === undefined || !NAME_CHAR.test(next)) return true;
    from = at + 1;
  }
}

/**
 * Pure: the names of shell variables assigned a GitHub release-asset URL.
 *
 * Every real download in these actions builds the URL one line above the
 * fetch (`url="https://github.com/…/releases/download/v${V}/${asset}"`) and
 * then curls `"$url"`, so a detector that only looks for the literal in the
 * curl line finds nothing at all — which is a guard that passes vacuously.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function releaseAssetUrlVariables(source) {
  const names = new Set();
  for (const { text } of collapseContinuations(source)) {
    const match = ASSIGNMENT.exec(stripShellComment(text).trim());
    if (match === null) continue;
    if (!RELEASE_ASSET_URL.test(match[2])) continue;
    names.add(match[1]);
  }
  return names;
}

/**
 * Pure: every logical line in `source` that fetches a GitHub release asset
 * with curl — whether the URL is written inline or carried in a variable
 * assigned one earlier in the same script. Line numbers are 1-based and name
 * the line the command started on, so a failure points at something a reader
 * can open.
 *
 * @param {string} source
 * @returns {Array<{ line: number, text: string, words: string[] }>}
 */
export function releaseAssetDownloads(source) {
  const urlVariables = releaseAssetUrlVariables(source);
  const found = [];
  for (const { line, text } of collapseContinuations(source)) {
    const command = stripShellComment(text);
    if (!CURL_COMMAND.test(command)) continue;
    const words = shellWords(text);
    const fetchesRelease = words.some(
      (word) =>
        RELEASE_ASSET_URL.test(word) ||
        [...urlVariables].some((name) => referencesVariable(word, name)),
    );
    if (!fetchesRelease) continue;
    found.push({ line, text, words });
  }
  return found;
}

/**
 * Pure: which of the required retry flags this download is missing, in
 * contract order. Matched as whole shell words (or `--flag=value`), never as
 * substrings — `--retry-all-errors` contains `--retry`, and the reverse
 * containment is exactly the bug this guard exists for.
 *
 * @param {string[]} words
 * @returns {string[]}
 */
export function missingRetryFlags(words) {
  return REQUIRED_RETRY_FLAGS.filter(
    (flag) => !words.some((word) => word === flag || word.startsWith(`${flag}=`)),
  );
}

/**
 * Read one repo-relative file.
 *
 * @param {string} relative
 * @returns {string}
 */
function readRepoFile(relative) {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

for (const { path, downloads } of RELEASE_ASSET_ACTIONS) {
  test(`${path} — every release-asset download retries an exit-56 failure`, () => {
    const found = releaseAssetDownloads(readRepoFile(path));

    assert.equal(
      found.length,
      downloads,
      `expected ${downloads} release-asset download(s) in ${path}, found ${found.length} — update RELEASE_ASSET_ACTIONS if a site was deliberately added or removed`,
    );

    for (const { line, words } of found) {
      const missing = missingRetryFlags(words);
      assert.deepEqual(
        missing,
        [],
        `${path}:${line} is missing ${missing.join(", ")}. A release-CDN 504 reaches curl as exit 56 (CURLE_RECV_ERROR), which --retry alone does not treat as transient; --retry-all-errors is what covers it.`,
      );
    }
  });

  test(`${path} — a checksum mismatch still fails the download closed`, () => {
    const source = readRepoFile(path);
    assert.match(
      source,
      /checksum mismatch/,
      `${path} no longer fails on a checksum mismatch — the retry may widen what is attempted, never what is trusted`,
    );
  });
}

test("no other action manifest fetches a release asset uncovered", () => {
  const known = new Set(RELEASE_ASSET_ACTIONS.map(({ path }) => path));
  const uncovered = [];

  for (const manifest of findActionManifests(join(REPO_ROOT, ".github", "actions"))) {
    const relative = manifest.slice(REPO_ROOT.length + 1);
    if (known.has(relative)) continue;
    if (releaseAssetDownloads(readFileSync(manifest, "utf8")).length > 0) {
      uncovered.push(relative);
    }
  }

  assert.deepEqual(
    uncovered,
    [],
    `these action manifests grew a release-asset download outside the retry contract: ${uncovered.join(", ")} — add them to RELEASE_ASSET_ACTIONS`,
  );
});

test("detects a release-asset download and reports its missing flags", () => {
  const source = [
    "        echo 'Downloading pinned thing'",
    '        curl -fsSL --retry 3 --retry-connrefused --max-time 300 "https://github.com/o/r/releases/download/v1/asset.tar.gz" -o "${tmp}/asset.tar.gz"',
  ].join("\n");

  const found = releaseAssetDownloads(source);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
  assert.deepEqual(missingRetryFlags(found[0].words), ["--retry-all-errors"]);
});

test("a shell-variable URL split across continuations is still one download", () => {
  const source = [
    '        curl -fsSL --retry 3 --retry-all-errors \\',
    '          --retry-connrefused --retry-delay 2 --max-time 300 \\',
    '          "https://github.com/o/r/releases/download/v1/a" -o "$out"',
  ].join("\n");

  const found = releaseAssetDownloads(source);
  assert.equal(found.length, 1, "line continuations must fold into one command");
  assert.equal(found[0].line, 1, "the reported line is where the command starts");
  assert.deepEqual(missingRetryFlags(found[0].words), []);
});

test("a URL carried in a shell variable is still a release-asset download", () => {
  const source = [
    '        asset="tool_${V}_linux_amd64.tar.gz"',
    '        url="https://github.com/o/r/releases/download/v${V}/${asset}"',
    '        echo "Downloading pinned tool: ${url}"',
    '        curl -fsSL --retry 3 --retry-connrefused --max-time 300 "$url" -o "${tmp}/${asset}"',
  ].join("\n");

  const found = releaseAssetDownloads(source);
  assert.equal(found.length, 1, "the fetch resolves through the url variable");
  assert.equal(found[0].line, 4);
  assert.deepEqual(missingRetryFlags(found[0].words), ["--retry-all-errors"]);
});

test("a variable holding a non-release URL does not pull its curl into scope", () => {
  const source = [
    '        api="https://api.github.com/repos/o/r/releases/latest"',
    '        curl -fsSL --max-time 30 "$api" -o meta.json',
  ].join("\n");

  assert.deepEqual(
    releaseAssetDownloads(source),
    [],
    "an API probe is not a pinned asset fetch and carries no retry contract here",
  );
});

test("a bare $name reference does not match a longer variable name", () => {
  const source = [
    '        url="https://github.com/o/r/releases/download/v1/a"',
    "        curl -fsSL $urls -o out",
  ].join("\n");

  assert.deepEqual(
    releaseAssetDownloads(source),
    [],
    "$urls is a different variable from $url",
  );
});

test("non-release fetches and commented-out lines are out of scope", () => {
  const notRelease = 'curl -fsSL --max-time 5 "https://api.github.com/repos/o/r" -o out.json';
  assert.deepEqual(releaseAssetDownloads(notRelease), []);

  const commented =
    '        # curl -fsSL "https://github.com/o/r/releases/download/v1/a" -o "$out"';
  assert.deepEqual(
    releaseAssetDownloads(commented),
    [],
    "a curl inside a shell comment is prose, not a download",
  );

  const trailingComment =
    '        echo hi  # see https://github.com/o/r/releases/download/v1/a for the asset';
  assert.deepEqual(releaseAssetDownloads(trailingComment), []);
});

test("--retry-all-errors alone does not satisfy --retry", () => {
  const words = shellWords('curl -fsSL --retry-all-errors "$url" -o out');
  assert.deepEqual(
    missingRetryFlags(words),
    ["--retry"],
    "substring matching would report this as covered; it retries zero times",
  );
});

test("the --flag=value spelling counts", () => {
  const words = shellWords(
    'curl --retry=3 --retry-all-errors "https://github.com/o/r/releases/download/v1/a" -o out',
  );
  assert.deepEqual(missingRetryFlags(words), []);
});
