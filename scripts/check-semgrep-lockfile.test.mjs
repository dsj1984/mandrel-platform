#!/usr/bin/env node
/**
 * check-semgrep-lockfile.test.mjs — guards the SAST toolchain lockfile
 * (Story #477).
 *
 * What this pins, and why each part earned a test:
 *
 * 1. **The advisories stay gone.** The lockfile carried protobuf 4.25.9
 *    (CVE-2026-0994, CVSS 8.2) and setuptools 80.9.0 (GHSA-h35f-9h28-mq5c).
 *    Neither could be fixed in place: every protobuf 4.x is affected, and
 *    semgrep 1.97.0's `opentelemetry-*~=1.25.0` pin capped protobuf below
 *    every patched release. A future bump that lands back inside an affected
 *    range would reintroduce a high with no other signal until the next
 *    scheduled OSV scan.
 *
 * 2. **The pin sites cannot drift.** The semgrep version lives in THREE
 *    places — this lockfile, `SEMGREP_PIN` in pr-quality.yml, and
 *    `DEFAULT_SEMGREP_PIN` in update-semgrep-rules.mjs — plus the
 *    `SEMGREP_HASHES` map that must carry digests for whatever the default is.
 *    Nothing detected disagreement between them before this file.
 *
 * 3. **`--require-hashes` stays satisfiable.** Every entry must be `==`-pinned
 *    with a sha256, or the install fails at CI time rather than here.
 *
 * The end-to-end proof (a real `pip install --require-hashes` on linux/cp312)
 * cannot run in this suite — it needs that platform and a network. It is a
 * `verify[]` step on the Story instead; these are the invariants checkable
 * from the tree.
 *
 * Run: node --test scripts/check-semgrep-lockfile.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const LOCKFILE = "scripts/semgrep-requirements.txt";
const WORKFLOW = ".github/workflows/pr-quality.yml";
const UPDATER = "scripts/update-semgrep-rules.mjs";

const lockfile = readFileSync(LOCKFILE, "utf8");

/**
 * Parse `name==version` requirement lines, ignoring comments and hash
 * continuations. Keyed by lowercased name.
 */
function requirements(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("--hash")) {
      continue;
    }
    const m = trimmed.match(/^([A-Za-z0-9._-]+)==([^\s\\]+)/);
    if (m) {
      out.set(m[1].toLowerCase(), m[2]);
    }
  }
  return out;
}

const REQS = requirements(lockfile);

/** Compare dotted release segments numerically. Returns -1 / 0 / 1. */
function compareVersions(a, b) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isNaN(pa[i]) || pa[i] === undefined ? 0 : pa[i];
    const y = Number.isNaN(pb[i]) || pb[i] === undefined ? 0 : pb[i];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 1. The advisories that put this Story on the board
// ---------------------------------------------------------------------------

test("protobuf is outside every CVE-2026-0994 affected range", () => {
  // Affected: `< 5.29.6` and `>= 6.30.0rc1, <= 6.33.4`. Patched: 5.29.6, 6.33.5.
  // A DoS in google.protobuf.json_format.ParseDict — 8.2, and the finding that
  // opened tracking issue #472.
  const version = REQS.get("protobuf");
  assert.ok(version, `${LOCKFILE}: protobuf must be pinned`);
  assert.doesNotMatch(version, /[a-zA-Z]/, "expected a final release, not a pre-release");

  assert.ok(
    compareVersions(version, "5.29.6") >= 0,
    `protobuf ${version} is below the 5.29.6 patch — inside the "< 5.29.6" affected range`,
  );
  const inSixLine = compareVersions(version, "6.0.0") >= 0;
  if (inSixLine) {
    assert.ok(
      compareVersions(version, "6.33.5") >= 0,
      `protobuf ${version} is inside the ">= 6.30.0rc1, <= 6.33.4" affected range`,
    );
  }
});

test("setuptools is absent from the closure", () => {
  // It was pinned to 80.9.0 only because semgrep 1.97.0's transitive
  // opentelemetry-instrumentation imported pkg_resources at load. 0.58b0 does
  // not, so the package — and its own advisory — leaves the graph entirely.
  assert.equal(
    REQS.has("setuptools"),
    false,
    "setuptools carries its own advisories and is no longer needed; do not re-add it without a stated reason",
  );
});

// ---------------------------------------------------------------------------
// 2. Drift between the three pin sites
// ---------------------------------------------------------------------------

test("the lockfile, the workflow, and the rules updater pin the same semgrep", () => {
  const lockVersion = REQS.get("semgrep");
  assert.ok(lockVersion, `${LOCKFILE}: semgrep must be pinned`);

  const workflow = readFileSync(WORKFLOW, "utf8");
  const wf = workflow.match(/SEMGREP_PIN='semgrep==([^']+)'/);
  assert.ok(wf, `${WORKFLOW}: SEMGREP_PIN not found`);
  assert.equal(wf[1], lockVersion, "workflow SEMGREP_PIN disagrees with the lockfile");

  const updater = readFileSync(UPDATER, "utf8");
  const up = updater.match(/const DEFAULT_SEMGREP_PIN = "semgrep==([^"]+)";/);
  assert.ok(up, `${UPDATER}: DEFAULT_SEMGREP_PIN not found`);
  assert.equal(up[1], lockVersion, "updater DEFAULT_SEMGREP_PIN disagrees with the lockfile");
});

test("the rules updater carries artifact hashes for the version it defaults to", () => {
  // SEMGREP_HASHES is a fail-fast supply-chain guard: a version with no entry
  // is rejected rather than installed unverified. A bump that moved the default
  // without adding digests would turn that guard into a hard stop.
  const updater = readFileSync(UPDATER, "utf8");
  const version = REQS.get("semgrep");
  const map = updater.slice(updater.indexOf("const SEMGREP_HASHES = {"));
  const block = map.slice(0, map.indexOf("\n};"));
  assert.ok(
    block.includes(`"${version}": [`),
    `${UPDATER}: SEMGREP_HASHES has no entry for ${version}`,
  );
});

// ---------------------------------------------------------------------------
// 3. --require-hashes remains satisfiable
// ---------------------------------------------------------------------------

test("every requirement is == pinned and carries a sha256 hash", () => {
  const pins = lockfile
    .split("\n")
    .filter((l) => /^[A-Za-z0-9._-]+==/.test(l.trim())).length;
  const hashes = lockfile.split("\n").filter((l) => l.trim().startsWith("--hash=sha256:")).length;

  assert.ok(pins > 0, "expected at least one pinned requirement");
  assert.equal(REQS.size, pins, "every pinned line must parse to a requirement");
  assert.ok(
    hashes >= pins,
    `${hashes} hash line(s) for ${pins} requirement(s) — --require-hashes needs at least one each`,
  );
});

test("no requirement is pinned with a loose operator", () => {
  // `--require-hashes` rejects these at install time; catching it here names
  // the offending line instead of failing inside CI's pip.
  //
  // The operator is matched by string comparison, NOT by a regex alternating
  // `<` and `>`. CodeQL reads such a pattern as an attempted HTML-tag filter
  // and raises js/bad-tag-filter at HIGH — which blocks the merge, since
  // code-scanning gates on high. Comparing prefixes says the same thing with
  // nothing for that query to match on.
  const LOOSE_OPERATORS = [">=", "<=", "~=", "!=", ">", "<"];
  for (const line of lockfile.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("--hash")) continue;
    const name = trimmed.match(/^[A-Za-z0-9._-]+/);
    if (!name) continue;
    const operator = trimmed.slice(name[0].length).trimStart();
    for (const loose of LOOSE_OPERATORS) {
      assert.ok(
        !operator.startsWith(loose),
        `loose pin (${loose}) — --require-hashes needs an exact ==: ${trimmed}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. The regeneration trap
// ---------------------------------------------------------------------------

test("the header warns about the manylinux_2_34 wheel tag", () => {
  // semgrep moved its Linux wheel tag after 1.157.0. A `pip download` whose
  // --platform list omits the new tag resolves NOTHING newer and reports only
  // "No matching distribution found", never naming the tag as the cause.
  const header = lockfile.slice(0, lockfile.indexOf("\n\n\n") + 1 || 4000);
  assert.match(header, /manylinux_2_34_x86_64/, "the header must name the current wheel tag");
  assert.match(header, /1\.157\.0/, "the header must say which version the tag changed after");
  assert.match(
    lockfile,
    /pip download semgrep/,
    "the header must carry a regeneration command",
  );
});
