// Unit coverage for the asset-download retry lint (Story #446).
//
// The claim worth pinning is that this guard FAILS on the defect it exists to
// catch. A lint only ever asserted against a passing tree is indistinguishable
// from a lint that returns 0 unconditionally — and that is the failure mode
// this repo has been bitten by before, so every rejection case below feeds the
// checker a fixture it must refuse.
//
// Run: node --test scripts/check-action-download-retries.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  REQUIRED_FLAGS,
  collapseContinuations,
  findActionManifests,
  isAssetDownload,
  lintSource,
  missingFlags,
} from "./check-action-download-retries.mjs";

/** The exact shape that failed run 34133838332. */
const BARE_DOWNLOAD = [
  "runs:",
  "  using: composite",
  "  steps:",
  "    - shell: bash",
  "      run: |",
  '        echo "Downloading pinned gitleaks: ${url}"',
  '        curl -fsSL "$url" -o "${tmp}/${asset}"',
].join("\n");

/** The hardened shape its two siblings already shipped. */
const HARDENED_DOWNLOAD = BARE_DOWNLOAD.replace(
  "curl -fsSL ",
  "curl -fsSL --retry 3 --retry-connrefused --max-time 300 ",
);

// ---------------------------------------------------------------------------
// The guard must REJECT — the case that makes it worth having
// ---------------------------------------------------------------------------

test("a bare `curl -fsSL … -o` download is rejected", () => {
  const findings = lintSource("action.yml", BARE_DOWNLOAD);
  assert.equal(findings.length, 1, "the unhardened download is a finding");
  assert.deepEqual(findings[0].missing, [
    "--retry",
    "--retry-connrefused",
    "--max-time",
  ]);
});

test("the finding names the file and the line, so a failure is actionable", () => {
  const [finding] = lintSource(".github/actions/gitleaks-scan/action.yml", BARE_DOWNLOAD);
  assert.equal(finding.path, ".github/actions/gitleaks-scan/action.yml");
  // The `curl` sits on the 7th line of the fixture.
  assert.equal(finding.line, 7);
  assert.ok(finding.missing.length > 0, "a finding always names what is missing");
});

test("a download carrying only SOME required flags is still rejected", () => {
  const partial = BARE_DOWNLOAD.replace("curl -fsSL ", "curl -fsSL --retry 3 ");
  const [finding] = lintSource("action.yml", partial);
  assert.deepEqual(finding.missing, ["--retry-connrefused", "--max-time"]);
});

// ---------------------------------------------------------------------------
// The guard must ACCEPT — no false positives on the shapes that are fine
// ---------------------------------------------------------------------------

test("the hardened sibling shape passes", () => {
  assert.deepEqual(lintSource("action.yml", HARDENED_DOWNLOAD), []);
});

test("a curl that is not an asset download is not a violation", () => {
  // pr-quality.yml's fail-fast cancellation POST: a status probe writing to
  // /dev/null, plus a plain curl with no output flag at all. Retrying a POST
  // is a different decision and this lint deliberately does not make it.
  const probes = [
    "        status=\"$(curl -sS -o /dev/null -w '%{http_code}' -X POST \"$api\")\"",
    '        curl -fsSL "https://example.test/health"',
  ].join("\n");
  assert.deepEqual(lintSource("workflow.yml", probes), []);
  assert.equal(isAssetDownload(probes.split("\n")[0]), false, "-o /dev/null is a probe");
  assert.equal(isAssetDownload(probes.split("\n")[1]), false, "no -o is not a download");
});

test("a line that merely mentions curl in prose is not a download", () => {
  assert.equal(isAssetDownload("        # predecessor used `curl --retry 3`"), false);
  assert.equal(isAssetDownload("        echo curling the asset"), false);
});

// ---------------------------------------------------------------------------
// Mechanics
// ---------------------------------------------------------------------------

test("a download split across continuation lines is linted as one command", () => {
  const wrapped = [
    "      run: |",
    '        curl -fsSL \\',
    '          --retry 3 --retry-connrefused --max-time 300 \\',
    '          "$url" -o "${tmp}/${asset}"',
  ].join("\n");
  assert.deepEqual(lintSource("action.yml", wrapped), [], "flags on later lines still count");

  const wrappedBare = wrapped.replace("--retry 3 --retry-connrefused --max-time 300 \\", "\\");
  const [finding] = lintSource("action.yml", wrappedBare);
  assert.ok(finding, "a wrapped download missing the flags is still caught");
  assert.equal(finding.line, 2, "the finding reports the line the command STARTS on");
});

test("collapseContinuations keeps the starting line number", () => {
  const folded = collapseContinuations("a\nb \\\nc\nd");
  assert.deepEqual(
    folded.map((f) => f.line),
    [1, 2, 4],
  );
  assert.match(folded[1].text, /b c/);
});

test("missingFlags reports in table order and REQUIRED_FLAGS each carry a why", () => {
  assert.deepEqual(missingFlags("curl -o x $u"), [
    "--retry",
    "--retry-connrefused",
    "--max-time",
  ]);
  assert.equal(missingFlags("curl --retry 3 --retry-connrefused --max-time 300 -o x $u").length, 0);
  for (const entry of REQUIRED_FLAGS) {
    assert.ok(entry.why.length > 0, `${entry.flag} explains why it is required`);
  }
});

// ---------------------------------------------------------------------------
// The live tree
// ---------------------------------------------------------------------------

test("every first-party action manifest in this repo passes", () => {
  const manifests = findActionManifests();
  assert.ok(manifests.length > 0, "the action surface is discoverable");
  const findings = manifests.flatMap((p) => lintSource(p, readFileSync(p, "utf8")));
  assert.deepEqual(findings, [], "no action ships an unhardened asset download");
});
