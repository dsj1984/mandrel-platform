// Unit coverage for the asset-download retry lint (Story #446, tightened in #490).
//
// The claim worth pinning is that this guard FAILS on the defect it exists to
// catch. A lint only ever asserted against a passing tree is indistinguishable
// from a lint that returns 0 unconditionally — and that is the failure mode
// this repo has been bitten by before, so every rejection case below feeds the
// checker a fixture it must refuse.
//
// Story #490 added the second half of that claim: a guard that can be SATISFIED
// without the invariant does not guard it either. `--retry-connrefused` used to
// satisfy `--retry` by substring, a flag inside a `#` comment counted, and four
// of the five ways to spell a download were outside the checker's scope.
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
  shellWords,
  stripShellComment,
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

/** Every required flag, in table order — the full-miss expectation. */
const ALL_REQUIRED = REQUIRED_FLAGS.map(({ flag }) => flag);

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
// Flags are whole words, not substrings (Story #490 / AC-1)
// ---------------------------------------------------------------------------

test("a sibling flag does not satisfy the flag it contains", () => {
  // `--retry-connrefused` contains `--retry`, which is exactly how a download
  // with no retry budget at all used to pass this lint.
  assert.deepEqual(
    missingFlags('curl -fsSL --retry-connrefused --max-time 300 "$u" -o x'),
    ["--retry"],
  );
  const [finding] = lintSource(
    "action.yml",
    BARE_DOWNLOAD.replace(
      "curl -fsSL ",
      "curl -fsSL --retry-connrefused --max-time 300 ",
    ),
  );
  assert.deepEqual(finding.missing, ["--retry"], "the lint reports it too");
});

test("a flag is present as its own word or as `flag=value`", () => {
  assert.deepEqual(
    missingFlags('curl --retry=3 --retry-connrefused --max-time=300 -o x "$u"'),
    [],
    "curl's `--flag=value` spelling counts",
  );
  assert.deepEqual(
    missingFlags('curl --retry-max-time 60 -o x "$u"'),
    ALL_REQUIRED,
    "a longer flag that merely starts with a required one satisfies nothing",
  );
});

// ---------------------------------------------------------------------------
// A `#` comment hides nothing, and shell `#` is not a comment (AC-2, AC-4)
// ---------------------------------------------------------------------------

test("a flag inside a trailing comment does not count", () => {
  assert.deepEqual(
    missingFlags('curl -fsSL -o x "$u"  # --retry 3 --retry-connrefused --max-time 300'),
    ALL_REQUIRED,
  );
  assert.deepEqual(
    missingFlags("# curl --retry 3 --retry-connrefused --max-time 300 -o x"),
    ALL_REQUIRED,
    "a whole-line comment carries no flags either",
  );
});

test("a `#` inside a quoted URL does not truncate the command", () => {
  assert.deepEqual(
    missingFlags(
      'curl -o x "https://host/p#frag" --retry 3 --retry-connrefused --max-time 300',
    ),
    [],
    "flags after the fragment are still matched",
  );
  assert.equal(
    isAssetDownload('curl -fsSL "https://host/p#frag" -o "$f"'),
    true,
    "the fragment does not hide the output flag either",
  );
});

test("shell `#` expansions are not comments", () => {
  assert.deepEqual(
    missingFlags(
      'curl "${#arr[@]}" --retry 3 --retry-connrefused --max-time 300 -o x "$u"',
    ),
    [],
    "`${#arr[@]}` before the flags leaves them visible",
  );
  assert.equal(stripShellComment('echo "$#" --retry'), 'echo "$#" --retry');
  assert.equal(stripShellComment("len=${#arr[@]} --retry"), "len=${#arr[@]} --retry");
  assert.equal(stripShellComment("curl -o x \\# --retry"), "curl -o x \\# --retry");
});

test("stripShellComment cuts at the first real comment", () => {
  assert.equal(stripShellComment("curl -o x # note"), "curl -o x ");
  assert.equal(stripShellComment("#note"), "");
  assert.equal(stripShellComment("curl -o x\t# note"), "curl -o x\t");
  assert.equal(stripShellComment("curl -o x"), "curl -o x");
  assert.equal(stripShellComment("echo 'a # b' # note"), "echo 'a # b' ");
});

test("shellWords splits on whitespace and unwraps quoting", () => {
  assert.deepEqual(shellWords('  curl -o "$f" "$u" # x'), ["curl", "-o", "$f", "$u"]);
  assert.deepEqual(shellWords('curl -o "-"'), ["curl", "-o", "-"]);
  assert.deepEqual(shellWords(""), []);
});

// ---------------------------------------------------------------------------
// Every download spelling is in scope (AC-3)
// ---------------------------------------------------------------------------

test("every spelling that writes a fetched artifact to a file is a download", () => {
  const downloads = [
    'curl -fsSL "$u" -o "${tmp}/${asset}"',
    'curl -sSLo "$f" "$u"',
    'curl --output "$f" "$u"',
    'curl --output="$f" "$u"',
    'curl -fsSL -O "$u"',
    'curl -fsSLO "$u"',
    'curl --remote-name "$u"',
    'wget -O x "$u"',
    'wget --output-document x "$u"',
    'wget --output-document=x "$u"',
  ];
  for (const line of downloads) {
    assert.equal(isAssetDownload(line), true, `${line} is a download`);
  }
});

test("a fetch that never lands in a file is not a download", () => {
  const notDownloads = [
    'curl -o - "$u"',
    'curl --output - "$u"',
    'curl -sSLo - "$u"',
    'wget -O - "$u"',
    'curl -fsSL "$u" | tar -xz',
    'curl -fsSL "https://example.test/health"',
    'curl -sS -o /dev/null -w "%{http_code}" -X POST "$api"',
  ];
  for (const line of notDownloads) {
    assert.equal(isAssetDownload(line), false, `${line} is not a download`);
  }
});

test("a wget download is held to the same contract", () => {
  const [finding] = lintSource("action.yml", '        wget -O "$f" "$u"');
  assert.ok(finding, "an unhardened wget fetch is caught, not silently skipped");
  assert.deepEqual(finding.missing, ALL_REQUIRED);
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
  assert.equal(isAssetDownload(probes.split("\n")[1]), false, "no -o is not a download");
  assert.equal(
    isAssetDownload('        curl -sS -o /dev/null -w "%{http_code}" -X POST "$api"'),
    false,
    "-o /dev/null is a probe",
  );
});

test("a line that merely mentions curl in prose is not a download", () => {
  assert.equal(isAssetDownload("        # predecessor used `curl --retry 3` -o x"), false);
  assert.equal(isAssetDownload("        echo curling the asset"), false);
  assert.equal(isAssetDownload("        echo wgetting the asset -O x"), false);
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
  assert.ok(
    manifests.some((p) => p.includes("gitleaks-scan")),
    "the action whose 504 motivated this lint is in scope",
  );
  const findings = manifests.flatMap((p) => lintSource(p, readFileSync(p, "utf8")));
  assert.deepEqual(findings, [], "no action ships an unhardened asset download");
});

test("the shipped downloads are still recognised as downloads", () => {
  // The tightening must not narrow the lint into vacuous success: the live
  // manifests must still present downloads for it to have judged.
  const seen = findActionManifests().flatMap((p) =>
    collapseContinuations(readFileSync(p, "utf8"))
      .map(({ text }) => text)
      .filter((text) => isAssetDownload(text)),
  );
  assert.ok(seen.length >= 4, `expected the tree's asset downloads, saw ${seen.length}`);
});
