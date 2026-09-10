#!/usr/bin/env node
/**
 * audit-check.test.mjs — node:test suite for the CVE-gate core in
 * audit-check.mjs (Story #195).
 *
 * Covers the fail-closed contract and the pure decision core:
 *   - an uninterpretable report + non-zero pnpm exit fails closed (exit 1)
 *   - a validly-suppressed high advisory (by GHSA id and by CVE id) passes
 *   - an expired allowlist entry fails closed (exit 1)
 *   - an unsuppressed critical fails closed (exit 1)
 *   - a MALFORMED `expires` fails closed rather than suppressing forever
 *
 * That last one was a fail-OPEN. `expires` was compared as an opaque string
 * (`entry.expires < today`), so any non-date value sorted lexicographically
 * above a real `20xx-..-..` date and read as "not yet expired" — making a
 * typo'd or placeholder expiry a permanent, silent CVE suppression. The
 * `<YYYY-MM-DD>` placeholder the dependency-update runbook shows as its example
 * value is the realistic way in. `parseIsoDateUtc` now validates the field, and
 * the tests below assert the invariant (nothing unreadable is ever suppressed)
 * across every malformed shape rather than the one spelling that motivated it.
 *
 * The suppression/expiry/interpretation logic is exercised through the pure
 * functions (`partitionAllowlist`, `isInterpretableReport`,
 * `extractBlockingAdvisories`, `evaluateReport`) — no pnpm spawn, no
 * filesystem — plus the CLI-level allowlist paths (`runCli` with a fixture
 * allowlist) that decide the exit code before pnpm ever runs.
 *
 * Run: node --test scripts/audit-check.test.mjs  (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  partitionAllowlist,
  parseIsoDateUtc,
  isInterpretableReport,
  extractBlockingAdvisories,
  evaluateReport,
  parseArgs,
  loadAllowlist,
  runCli,
  isBoundedOverride,
  findUnboundedOverrides,
  lintOverrides,
  detectPackageManager,
  ghsaIdFromUrl,
  recognizeReport,
  normalizeAdvisoryId,
} from "./audit-check.mjs";

const TODAY = "2026-07-02";

// A far-future expiry so "valid" fixtures never age out as the clock moves.
const FUTURE = "2999-12-31";
// A date safely in the past.
const PAST = "2000-01-01";

/** Build a pnpm-audit-shaped report from a list of advisories. */
function reportWith(advisories) {
  const map = {};
  for (const [key, adv] of Object.entries(advisories)) {
    map[key] = adv;
  }
  return { advisories: map, metadata: {} };
}

const HIGH_GHSA = {
  ghsa_id: "GHSA-aaaa-bbbb-cccc",
  cve: ["CVE-2026-1111"],
  severity: "high",
  title: "High severity in transitive dep",
  url: "https://example.test/GHSA-aaaa-bbbb-cccc",
};

const CRITICAL_ADV = {
  ghsa_id: "GHSA-dddd-eeee-ffff",
  cve: ["CVE-2026-2222"],
  severity: "critical",
  title: "Critical RCE",
  url: "https://example.test/GHSA-dddd-eeee-ffff",
};

// ── partitionAllowlist ──────────────────────────────────────────────────────

test("partitionAllowlist: active entry lands in suppressed set", () => {
  const { suppressed, expired, invalid } = partitionAllowlist(
    [{ id: "GHSA-aaaa-bbbb-cccc", reason: "accepted", expires: FUTURE }],
    TODAY,
  );
  assert.ok(suppressed.has("GHSA-aaaa-bbbb-cccc"));
  assert.equal(expired.length, 0);
  assert.equal(invalid.length, 0);
});

test("partitionAllowlist: expired entry lands in expired, not suppressed", () => {
  const { suppressed, expired } = partitionAllowlist(
    [{ id: "GHSA-aaaa-bbbb-cccc", reason: "accepted", expires: PAST }],
    TODAY,
  );
  assert.equal(suppressed.size, 0);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, "GHSA-aaaa-bbbb-cccc");
});

test("partitionAllowlist: entry missing id or expires is invalid", () => {
  const { invalid } = partitionAllowlist(
    [
      { reason: "no id", expires: FUTURE },
      { id: "GHSA-x", reason: "no expires" },
    ],
    TODAY,
  );
  assert.equal(invalid.length, 2);
});

test("partitionAllowlist: an expiry equal to today is still active, not expired", () => {
  const { suppressed, expired } = partitionAllowlist(
    [{ id: "GHSA-today", expires: TODAY }],
    TODAY,
  );
  assert.ok(suppressed.has("GHSA-today"));
  assert.equal(expired.length, 0);
});

// ── partitionAllowlist: the malformed-expiry fail-open ──────────────────────
//
// `expires` used to be compared as an opaque string (`entry.expires < today`),
// so any non-date value sorted lexicographically ABOVE a real `20xx-..-..`
// date and read as "not yet expired". A malformed field therefore became a
// PERMANENT, SILENT CVE suppression — the exact inverse of what an expiry is
// for. The realistic path in: `docs/runbooks/dependency-update.md` shows
// `"expires": "<YYYY-MM-DD>"` as the example value, and `<` (0x3C) sorts above
// `2` (0x32).
//
// The assertion below is on the invariant — nothing unreadable is EVER
// suppressed — rather than on the handful of spellings that motivated it.

const MALFORMED_EXPIRIES = [
  ["<YYYY-MM-DD>", "runbook placeholder, copy-pasted verbatim"],
  ["YYYY-MM-DD", "placeholder without brackets"],
  ["not-a-date", "free text"],
  ["expres 2026", "typo'd key/value smashed together"],
  ["12/31/2026", "US-style separators"],
  ["31-12-2026", "day-first ordering"],
  ["2026-1-1", "unpadded month/day"],
  ["2026-01-01T00:00:00Z", "full ISO 8601 timestamp, not a bare date"],
  [" 2026-01-01 ", "surrounding whitespace"],
  ["2026-01-01extra", "trailing junk"],
  ["2026-13-01", "impossible month"],
  ["2026-02-30", "impossible day for the month"],
  ["", "empty string"],
  [0, "number"],
  [20261231, "date-ish number"],
  [null, "null"],
  [undefined, "undefined"],
  [{ year: 2026 }, "object"],
  [["2026-01-01"], "array"],
  [true, "boolean"],
];

test("partitionAllowlist: no malformed expiry is ever suppressed (fail closed)", () => {
  for (const [expires, label] of MALFORMED_EXPIRIES) {
    const { suppressed, expired, invalid } = partitionAllowlist(
      [{ id: "GHSA-aaaa-bbbb-cccc", reason: "why", expires }],
      TODAY,
    );
    assert.equal(
      suppressed.size,
      0,
      `${label} (${JSON.stringify(expires)}) must not suppress`,
    );
    assert.equal(
      expired.length,
      0,
      `${label} (${JSON.stringify(expires)}) is unreadable, not expired`,
    );
    assert.equal(
      invalid.length,
      1,
      `${label} (${JSON.stringify(expires)}) must be reported invalid`,
    );
  }
});

test("partitionAllowlist: an invalid entry names the offending id and problem", () => {
  const { invalid } = partitionAllowlist(
    [{ id: "GHSA-aaaa-bbbb-cccc", expires: "<YYYY-MM-DD>" }],
    TODAY,
  );
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].entry.id, "GHSA-aaaa-bbbb-cccc");
  assert.match(invalid[0].problem, /expires/);
  assert.match(invalid[0].problem, /YYYY-MM-DD/);
});

test("partitionAllowlist: a valid entry alongside a malformed one still fails closed", () => {
  // The malformed entry must not be quietly skipped while the good one passes:
  // the CLI gates on `invalid.length`, so the run has to stop.
  const { suppressed, invalid } = partitionAllowlist(
    [
      { id: "GHSA-good", expires: FUTURE },
      { id: "GHSA-bad", expires: "<YYYY-MM-DD>" },
    ],
    TODAY,
  );
  assert.ok(suppressed.has("GHSA-good"));
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].entry.id, "GHSA-bad");
});

test("partitionAllowlist: a non-string id is invalid, never a suppression key", () => {
  for (const id of [42, null, undefined, "", "   ", {}, ["GHSA-x"]]) {
    const { suppressed, invalid } = partitionAllowlist(
      [{ id, expires: FUTURE }],
      TODAY,
    );
    assert.equal(suppressed.size, 0, `id ${JSON.stringify(id)} must not suppress`);
    assert.equal(invalid.length, 1);
  }
});

test("partitionAllowlist: throws when `today` is not a YYYY-MM-DD date", () => {
  assert.throws(
    () => partitionAllowlist([{ id: "GHSA-x", expires: FUTURE }], "not-a-date"),
    /must be a YYYY-MM-DD date/,
  );
});

// ── parseIsoDateUtc ─────────────────────────────────────────────────────────

test("parseIsoDateUtc: accepts a real calendar date and returns UTC midnight", () => {
  assert.equal(parseIsoDateUtc("2026-07-02"), Date.UTC(2026, 6, 2));
  assert.equal(parseIsoDateUtc("2024-02-29"), Date.UTC(2024, 1, 29)); // leap year
  assert.equal(parseIsoDateUtc("2999-12-31"), Date.UTC(2999, 11, 31));
});

test("parseIsoDateUtc: rejects overflow dates that Date.UTC would roll over", () => {
  // Date.UTC(2026, 12, 45) is 2027-01-14, not NaN — only a round-trip catches it.
  assert.equal(parseIsoDateUtc("2026-13-45"), null);
  assert.equal(parseIsoDateUtc("2026-02-30"), null);
  assert.equal(parseIsoDateUtc("2025-02-29"), null); // 2025 is not a leap year
  assert.equal(parseIsoDateUtc("2026-00-10"), null);
  assert.equal(parseIsoDateUtc("2026-01-00"), null);
});

test("parseIsoDateUtc: rejects every malformed shape", () => {
  for (const [value, label] of MALFORMED_EXPIRIES) {
    assert.equal(
      parseIsoDateUtc(value),
      null,
      `${label} (${JSON.stringify(value)}) must not parse`,
    );
  }
});

test("parseIsoDateUtc: ordering is chronological, not lexicographic", () => {
  // The bug in one line: as strings, "<YYYY-MM-DD>" > "2026-07-02".
  assert.ok("<YYYY-MM-DD>" > "2026-07-02");
  // Parsed, it has no ordering at all — it is simply not a date.
  assert.equal(parseIsoDateUtc("<YYYY-MM-DD>"), null);
  assert.ok(parseIsoDateUtc("2026-01-01") < parseIsoDateUtc("2026-07-02"));
});

// ── isInterpretableReport ───────────────────────────────────────────────────

test("isInterpretableReport: true for a report with an advisories object", () => {
  assert.equal(isInterpretableReport(reportWith({})), true);
});

test("isInterpretableReport: false for an error envelope without advisories", () => {
  assert.equal(
    isInterpretableReport({ error: { code: "ERR", summary: "boom" } }),
    false,
  );
  assert.equal(isInterpretableReport(null), false);
  assert.equal(isInterpretableReport("not-json-object"), false);
  assert.equal(isInterpretableReport({ advisories: null }), false);
});

// ── extractBlockingAdvisories: suppression matching ─────────────────────────

test("extractBlockingAdvisories: high advisory suppressed by GHSA id → no blocking", () => {
  const report = reportWith({ 1: HIGH_GHSA });
  const suppressed = new Set(["GHSA-aaaa-bbbb-cccc"]);
  assert.deepEqual(extractBlockingAdvisories(report, suppressed), []);
});

test("extractBlockingAdvisories: high advisory suppressed by CVE id → no blocking", () => {
  const report = reportWith({ 1: HIGH_GHSA });
  const suppressed = new Set(["CVE-2026-1111"]);
  assert.deepEqual(extractBlockingAdvisories(report, suppressed), []);
});

test("extractBlockingAdvisories: unsuppressed critical is blocking", () => {
  const report = reportWith({ 1: CRITICAL_ADV });
  const blocking = extractBlockingAdvisories(report, new Set());
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].severity, "critical");
  assert.equal(blocking[0].id, "GHSA-dddd-eeee-ffff");
});

test("extractBlockingAdvisories: moderate/low severities are ignored", () => {
  const report = reportWith({
    1: { ghsa_id: "GHSA-mod", severity: "moderate", title: "meh" },
    2: { ghsa_id: "GHSA-low", severity: "low", title: "meh" },
  });
  assert.deepEqual(extractBlockingAdvisories(report, new Set()), []);
});

test("extractBlockingAdvisories: uninterpretable report yields empty (guarded by caller)", () => {
  assert.deepEqual(extractBlockingAdvisories({ error: "boom" }, new Set()), []);
});

// ── evaluateReport: the fail-closed decision core ───────────────────────────

test("evaluateReport: uninterpretable report + non-zero pnpm exit → exit 1 (fail closed)", () => {
  const result = evaluateReport({ error: "boom" }, 1, new Set());
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "uninterpretable-failclosed");
});

test("evaluateReport: unrecognized report + ZERO exit → exit 1 (fail closed)", () => {
  // This assertion is the inverse of the one it replaces (Story #475), and the
  // inversion is the point. The old contract read "no advisories key" as "no
  // advisories" and passed on a zero exit. That is safe only while every report
  // this gate can meet is the legacy shape — and it is not: `npm audit --json`
  // reports v7+ advisories under `vulnerabilities` and exits 0 when clean, so
  // the old branch would have reported an npm graph clean without reading one
  // advisory, and would have kept doing so as highs landed.
  //
  // A report is clean only when a schema was RECOGNIZED and found nothing.
  const result = evaluateReport({ metadata: {} }, 0, new Set());
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "uninterpretable-failclosed");
  assert.equal(result.schema, null);
});

test("evaluateReport: an unrecognized report fails closed on EVERY exit code", () => {
  // Exit code must not be able to rescue an unreadable report from either side.
  for (const exitCode of [0, 1, 2, 127]) {
    const result = evaluateReport({ nonsense: true }, exitCode, new Set());
    assert.equal(result.exitCode, 1, `exit ${exitCode}`);
    assert.equal(result.reason, "uninterpretable-failclosed", `exit ${exitCode}`);
  }
});

test("evaluateReport: validly-suppressed high (GHSA) → exit 0", () => {
  const report = reportWith({ 1: HIGH_GHSA });
  const result = evaluateReport(report, 1, new Set(["GHSA-aaaa-bbbb-cccc"]));
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, "clean");
});

test("evaluateReport: validly-suppressed high (CVE) → exit 0", () => {
  const report = reportWith({ 1: HIGH_GHSA });
  const result = evaluateReport(report, 1, new Set(["CVE-2026-1111"]));
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, "clean");
});

test("evaluateReport: unsuppressed critical → exit 1", () => {
  const report = reportWith({ 1: CRITICAL_ADV });
  const result = evaluateReport(report, 1, new Set());
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "unsuppressed");
  assert.equal(result.blocking.length, 1);
});

// ── CLI-level: expired allowlist short-circuits before pnpm ─────────────────

test("runCli: expired allowlist entry → exit non-zero (before pnpm runs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-check-expired-"));
  try {
    const allowlistPath = join(dir, "audit-allowlist.json");
    writeFileSync(
      allowlistPath,
      JSON.stringify([
        { id: "GHSA-aaaa-bbbb-cccc", reason: "was accepted", expires: PAST },
      ]),
    );
    const exit = runCli(["--allowlist", allowlistPath]);
    assert.equal(exit, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli: malformed allowlist entry (missing expires) → exit non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-check-malformed-"));
  try {
    const allowlistPath = join(dir, "audit-allowlist.json");
    writeFileSync(
      allowlistPath,
      JSON.stringify([{ id: "GHSA-aaaa-bbbb-cccc", reason: "no expiry" }]),
    );
    const exit = runCli(["--allowlist", allowlistPath]);
    assert.equal(exit, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli: placeholder expiry copy-pasted from the runbook → exit non-zero", () => {
  // The end-to-end shape of the fail-open: before validation this entry was
  // suppressed forever, and runCli went on to pass the advisory it covered.
  const dir = mkdtempSync(join(tmpdir(), "audit-check-placeholder-"));
  try {
    const allowlistPath = join(dir, "audit-allowlist.json");
    writeFileSync(
      allowlistPath,
      JSON.stringify([
        {
          id: "GHSA-aaaa-bbbb-cccc",
          reason: "No fix available; upstream tracking issue: <URL>",
          expires: "<YYYY-MM-DD>",
        },
      ]),
    );
    assert.equal(runCli(["--allowlist", allowlistPath]), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli: impossible calendar date in expires → exit non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-check-impossible-"));
  try {
    const allowlistPath = join(dir, "audit-allowlist.json");
    writeFileSync(
      allowlistPath,
      JSON.stringify([{ id: "GHSA-aaaa-bbbb-cccc", expires: "2026-02-30" }]),
    );
    assert.equal(runCli(["--allowlist", allowlistPath]), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli: non-array allowlist → exit non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-check-nonarray-"));
  try {
    const allowlistPath = join(dir, "audit-allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify({ not: "an array" }));
    const exit = runCli(["--allowlist", allowlistPath]);
    assert.equal(exit, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── parseArgs / loadAllowlist ───────────────────────────────────────────────

test("parseArgs: --allowlist resolves against cwd; default is audit-allowlist.json", () => {
  assert.equal(
    parseArgs(["--allowlist", "custom.json"], "/repo").allowlistPath,
    "/repo/custom.json",
  );
  assert.equal(
    parseArgs([], "/repo").allowlistPath,
    "/repo/audit-allowlist.json",
  );
});

test("loadAllowlist: absent file returns empty array", () => {
  assert.deepEqual(
    loadAllowlist(join(tmpdir(), "does-not-exist-xyz.json")),
    [],
  );
});

test("loadAllowlist: non-array throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-check-load-"));
  try {
    const p = join(dir, "a.json");
    writeFileSync(p, JSON.stringify({ nope: true }));
    assert.throws(() => loadAllowlist(p), /must be a JSON array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unbounded dependency overrides (Story #365)
//
// The failure these close: nothing lints for an unbounded override. Written as
// a bare lower bound it rewrites a dependent's range open-endedly, leaving the
// committed lockfile as the only pin — so any fresh resolution re-picks the
// newest release and can cross a major. Two consumers derived this rule
// independently after a major jump silently emptied a test suite, and both
// then found further already-escaped overrides.
// ---------------------------------------------------------------------------

test("isBoundedOverride: a bare lower bound is unbounded; a capped range is not", () => {
  for (const unbounded of [">=1.2.3", "> 1.2.3", ">=0", "*", "x", "latest", "", "   "]) {
    assert.equal(isBoundedOverride(unbounded), false, `${JSON.stringify(unbounded)} is unbounded`);
  }
  for (const bounded of ["1.2.3", "^1.2.3", "~1.2.3", "1.2.x", ">=1.2.3 <2.0.0", "<2.0.0"]) {
    assert.equal(isBoundedOverride(bounded), true, `${JSON.stringify(bounded)} is bounded`);
  }
});

// The wildcard truth table (Story #375).
//
// The shipped regex enumerated only some wildcard spellings, so `x.x.x` and
// `x.x` — the exact shape the lint exists to catch, and what npm reads as
// plain `*` — fell through the catch-all and were reported bounded. The
// deciding question is the MAJOR position: a wildcard there is open to every
// future release, while a wildcard below it (`1.2.x`, `1.*`) stays inside its
// major and is genuinely bounded. Every spelling is enumerated so the next
// regex tweak has to keep answering all of them.
const WILDCARD_TRUTH_TABLE = [
  ["*", false],
  ["x", false],
  ["X", false],
  ["*.*", false],
  ["x.x", false],
  ["X.X", false],
  ["*.*.*", false],
  ["x.x.x", false],
  ["X.X.X", false],
  ["x.*", false],
  ["*.x.x", false],
  ["x.2.3", false],
  ["*.x", false],
  ["latest", false],
  ["next", false],
  ["LATEST", false],
  ["NEXT", false],
  ["1.x", true],
  ["1.X", true],
  ["1.*", true],
  ["1.2.x", true],
  ["1.2.*", true],
];

test("AC-1/AC-4: every wildcard spelling is judged on its major position", () => {
  for (const [spec, expected] of WILDCARD_TRUTH_TABLE) {
    assert.equal(
      isBoundedOverride(spec),
      expected,
      `${JSON.stringify(spec)} should be bounded=${expected}`,
    );
  }
});

test("AC-2: a non-registry specifier expresses no upper bound", () => {
  // Each of these re-resolves to whatever the source holds at install time —
  // a branch head, a workspace sibling, a path — so none of them is a range
  // the lint can call bounded.
  for (const spec of [
    "github:owner/repo",
    "github:owner/repo#v1.2.3",
    "git+https://github.com/owner/repo.git",
    "git+ssh://git@github.com/owner/repo.git#main",
    "git://github.com/owner/repo.git",
    "workspace:*",
    "workspace:^",
    "file:../local-pkg",
    "link:../local-pkg",
    "https://example.com/pkg-1.2.3.tgz",
  ]) {
    assert.equal(
      isBoundedOverride(spec),
      false,
      `${JSON.stringify(spec)} pins nothing`,
    );
  }
});

test("AC-2: a git specifier carrying #semver: is judged on that range", () => {
  assert.equal(
    isBoundedOverride("git+https://github.com/owner/repo.git#semver:^1.2.3"),
    true,
  );
  assert.equal(isBoundedOverride("github:owner/repo#semver:>=1.2.3"), false);
});

test("AC-3: a range carrying an explicit upper bound stays bounded", () => {
  for (const bounded of [
    "1.2.3",
    "=1.2.3",
    "^1.2.3",
    "~1.2.3",
    ">=1.2.3 <2.0.0",
    "<2.0.0",
    "1.2.3 - 2.0.0",
  ]) {
    assert.equal(
      isBoundedOverride(bounded),
      true,
      `${JSON.stringify(bounded)} is bounded`,
    );
  }
});

test("AC-3: a wildcard LOWER end still counts as bounded when the range caps it", () => {
  // The wildcard test asks about the major position, so it may only be applied
  // to a single bare token. Applied to a compound range it read the first
  // dot-segment of the whole string and called `x.x <2.0.0` unbounded — a
  // range that plainly carries an upper bound — while the equivalent
  // `* <2.0.0` passed, because its first segment is `* <2`. That
  // self-inconsistency is the tell: it was an artifact of check ordering.
  for (const bounded of [
    "x.x <2.0.0",
    "x.x.x <2.0.0",
    "* <2.0.0",
    "x.x.x - 2.0.0",
    "x - 2.0.0",
    "* - 2.0.0",
  ]) {
    assert.equal(
      isBoundedOverride(bounded),
      true,
      `${JSON.stringify(bounded)} is bounded`,
    );
  }
});

// Residual fail-opens left open by the dotted-wildcard fix. Both classes reach
// the catch-all `return true` and so read as bounded while pinning nothing.
//
// Class 1 — an operator in front of the wildcard. The wildcard test is gated on
// a single BARE token, so any leading range operator defeats it: `^x.x.x` is
// `^` applied to "any version", which is still any version.
const OPERATOR_PREFIXED_WILDCARDS = [
  ["^x.x.x", false],
  ["^x.x", false],
  ["^x", false],
  ["^*", false],
  ["~*", false],
  ["~x.x.x", false],
  ["=x.x.x", false],
  ["=*", false],
  ["=X.X", false],
  ["^latest", false],
  // The same operators over a real version are untouched — this is the
  // near-miss the fix must not break.
  ["^1.2.3", true],
  ["~1.2.3", true],
  ["=1.2.3", true],
  ["^1.x", true],
  ["~1.2.x", true],
];

test("operator-prefixed wildcards are unbounded, real versions unaffected", () => {
  for (const [spec, expected] of OPERATOR_PREFIXED_WILDCARDS) {
    assert.equal(
      isBoundedOverride(spec),
      expected,
      `${JSON.stringify(spec)} should be bounded=${expected}`,
    );
  }
});

test("a compound whose every term is a wildcard or bare lower bound is unbounded", () => {
  // Class 2 — a wildcard lower with no upper bound anywhere. `x.x >=1.0.0`
  // reads as a range only because it is spelled like one; both terms are open
  // above, so the resolved set is still "every future release".
  for (const unbounded of [
    "x.x >=1.0.0",
    "x.x.x >=1.0.0",
    "* >=1.0.0",
    "x.x >1.0.0",
    ">=1.0.0 x.x",
    "x.x - x.x",
    "x.x.x - *",
    "* - x",
    "1.0.0 - x.x.x",
  ]) {
    assert.equal(
      isBoundedOverride(unbounded),
      false,
      `${JSON.stringify(unbounded)} carries no upper bound`,
    );
  }
});

test("a malformed hyphen range carrying a comparator still fails closed", () => {
  // A real hyphen range takes plain versions on both sides. Reading the
  // right-hand side of `>=1.0.0 - 2.0.0` as the cap answers a range npm never
  // agreed to parse, and turns a spec that failed closed into one that passes
  // — the exact fail-open direction this lint exists to prevent.
  for (const unbounded of [">=1.0.0 - 2.0.0", ">=1.0.0 - ^2.0.0", ">1.0.0 - 2.0.0"]) {
    assert.equal(
      isBoundedOverride(unbounded),
      false,
      `${JSON.stringify(unbounded)} is not a hyphen range and must fail closed`,
    );
  }
});

test("a real upper bound still closes a range with a wildcard lower", () => {
  // The regression guard for the trap the dotted-wildcard fix already hit once:
  // testing the wildcard against the whole specifier called these unbounded.
  // An upper bound is an upper bound regardless of how loose the lower end is.
  for (const bounded of [
    "x.x <2.0.0",
    "x.x.x - 2.0.0",
    "* <=2.0.0",
    "x.x >=1.0.0 <2.0.0",
    "^x.x.x - 2.0.0",
  ]) {
    assert.equal(
      isBoundedOverride(bounded),
      true,
      `${JSON.stringify(bounded)} carries a real upper bound`,
    );
  }
});

test("isBoundedOverride: a || union is only as bounded as its loosest arm", () => {
  assert.equal(isBoundedOverride("^1.0.0 || ^2.0.0"), true);
  assert.equal(isBoundedOverride("^1.0.0 || >=2.0.0"), false);
});

test("isBoundedOverride: an npm: alias is judged on the range it carries", () => {
  assert.equal(isBoundedOverride("npm:other-pkg@^1.2.3"), true);
  assert.equal(isBoundedOverride("npm:@scope/other@^1.2.3"), true);
  assert.equal(isBoundedOverride("npm:other-pkg@>=1.2.3"), false);
  // An alias with no range at all pins nothing.
  assert.equal(isBoundedOverride("npm:other-pkg"), false);
});

test("AC-5: findUnboundedOverrides names the package and the bound", () => {
  const findings = findUnboundedOverrides({
    pnpm: { overrides: { "left-pad": ">=1.3.0", semver: "^7.5.2" } },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "left-pad");
  assert.equal(findings[0].bound, ">=1.3.0");
  assert.equal(findings[0].field, "pnpm.overrides");
});

test("AC-5: every override field is checked, npm and pnpm and yarn alike", () => {
  const findings = findUnboundedOverrides({
    overrides: { a: ">=1.0.0" },
    resolutions: { b: "*" },
    pnpm: { overrides: { c: ">2" } },
  });
  assert.deepEqual(
    findings.map((f) => `${f.field}.${f.package}`).sort(),
    ["overrides.a", "pnpm.overrides.c", "resolutions.b"],
  );
});

test("AC-5: a nested (dependent-scoped) override is named by its full path", () => {
  const findings = findUnboundedOverrides({
    overrides: { "some-dep": { "left-pad": ">=1.3.0" } },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "some-dep.left-pad");
  assert.equal(findings[0].bound, ">=1.3.0");
});

test("AC-6: an override that pins a bounded range passes", () => {
  assert.deepEqual(
    findUnboundedOverrides({
      overrides: { a: "^1.2.3", b: "~2.0.0", c: "3.1.4", d: ">=1.0.0 <2.0.0" },
      pnpm: { overrides: { e: "1.2.x" } },
    }),
    [],
  );
});

test("findUnboundedOverrides: a package.json with no overrides at all is clean", () => {
  assert.deepEqual(findUnboundedOverrides({ name: "x", dependencies: { a: ">=1.0.0" } }), []);
  assert.deepEqual(findUnboundedOverrides(null), []);
  assert.deepEqual(findUnboundedOverrides("not-an-object"), []);
});

test("AC-5: runCli fails on an unbounded override before pnpm ever runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-check-override-"));
  try {
    const packageJsonPath = join(dir, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "fixture", pnpm: { overrides: { "left-pad": ">=1.3.0" } } }),
    );
    // An absent allowlist keeps this case about the override and nothing else.
    const exit = runCli([
      "--package-json",
      packageJsonPath,
      "--allowlist",
      join(dir, "no-such-allowlist.json"),
    ]);
    assert.equal(exit, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-6: the override gate passes a bounded override, reaching the audit", () => {
  // Executes the clean path rather than asserting around it. lintOverrides is
  // the gate runCli delegates to, split out precisely so a PASS is provable
  // without `pnpm audit` (which needs a real lockfile and a network).
  const dir = mkdtempSync(join(tmpdir(), "audit-check-bounded-"));
  try {
    const packageJsonPath = join(dir, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "fixture",
        overrides: { a: "^1.3.0", b: ">=1.0.0 <2.0.0" },
        pnpm: { overrides: { "left-pad": "~1.3.0" } },
      }),
    );
    assert.equal(lintOverrides(packageJsonPath), 0);
    assert.equal(parseArgs(["--package-json", packageJsonPath]).packageJsonPath, packageJsonPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-5: the override gate blocks an unbounded override", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-check-lint-"));
  try {
    const packageJsonPath = join(dir, "package.json");
    writeFileSync(packageJsonPath, JSON.stringify({ overrides: { "left-pad": ">=1.3.0" } }));
    assert.equal(lintOverrides(packageJsonPath), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the override gate is a no-op when there is no package.json to read", () => {
  assert.equal(lintOverrides(join(tmpdir(), "audit-check-absent-xyz", "package.json")), 0);
});

test("this repo's own package.json passes the override gate", () => {
  // The lint ships enabled by default; a false positive here would red the
  // platform's own required check on every PR.
  assert.deepEqual(findUnboundedOverrides(JSON.parse(readFileSync("package.json", "utf8"))), []);
});

test("runCli: an unparseable package.json is a hard error, not a skipped check", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-check-badpkg-"));
  try {
    const packageJsonPath = join(dir, "package.json");
    writeFileSync(packageJsonPath, "{ not json");
    assert.equal(
      runCli([
        "--package-json",
        packageJsonPath,
        "--allowlist",
        join(dir, "no-such-allowlist.json"),
      ]),
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgs defaults the package.json path alongside the allowlist path", () => {
  const { allowlistPath, packageJsonPath } = parseArgs([], "/tmp/proj");
  assert.equal(allowlistPath, "/tmp/proj/audit-allowlist.json");
  assert.equal(packageJsonPath, "/tmp/proj/package.json");
});

// ---------------------------------------------------------------------------
// Package-manager detection (Story #475)
//
// The lockfile is the discriminator, not `packageManager` / `engines`: it is
// what the audit actually reads, and this very repo declares one manager in
// metadata while committing the other's lockfile.
// ---------------------------------------------------------------------------

/** existsSync stub answering true for exactly the named basenames. */
function lockfilesPresent(...names) {
  return (path) => names.some((name) => path.endsWith(`/${name}`));
}

test("detectPackageManager: a pnpm lockfile selects pnpm", () => {
  const result = detectPackageManager("/proj", {
    existsSyncImpl: lockfilesPresent("pnpm-lock.yaml"),
  });
  assert.equal(result.manager, "pnpm");
  assert.equal(result.error, undefined);
});

test("detectPackageManager: an npm lockfile selects npm", () => {
  const result = detectPackageManager("/proj", {
    existsSyncImpl: lockfilesPresent("package-lock.json"),
  });
  assert.equal(result.manager, "npm");
  assert.equal(result.error, undefined);
});

test("detectPackageManager: no lockfile is a loud error, never a default", () => {
  // Defaulting to either manager would make the gate's verdict a claim about a
  // graph nobody chose.
  const result = detectPackageManager("/proj", { existsSyncImpl: () => false });
  assert.equal(result.manager, undefined);
  assert.match(result.error, /No lockfile found/);
});

test("detectPackageManager: two lockfiles are a loud error, never a guess", () => {
  const result = detectPackageManager("/proj", {
    existsSyncImpl: lockfilesPresent("pnpm-lock.yaml", "package-lock.json"),
  });
  assert.equal(result.manager, undefined);
  assert.match(result.error, /Ambiguous lockfiles/);
});

// ---------------------------------------------------------------------------
// GHSA id extraction — npm exposes the id ONLY inside the advisory url
// ---------------------------------------------------------------------------

test("ghsaIdFromUrl: reads the id from a GitHub advisory url, canonically", () => {
  // Canonical = uppercase `GHSA-` prefix, lowercase body: what GitHub renders
  // and what an operator pastes into the allowlist. This used to upper-case
  // the whole id while the pnpm path kept its `ghsa_id` verbatim, so the two
  // managers disagreed about what an id even looks like.
  assert.equal(
    ghsaIdFromUrl("https://github.com/advisories/GHSA-aaaa-bbbb-cccc"),
    "GHSA-aaaa-bbbb-cccc",
  );
  assert.equal(
    ghsaIdFromUrl("https://github.com/advisories/GHSA-AAAA-BbBb-CCCC"),
    "GHSA-aaaa-bbbb-cccc",
  );
});

test("ghsaIdFromUrl: only the last path segment counts, never the host", () => {
  // Matching a GHSA-shaped substring anywhere in a caller-controlled URL would
  // let a hostile host or query string mint an id that silences an allowlist
  // lookup. Only the final path segment is tested.
  assert.equal(ghsaIdFromUrl("https://GHSA-aaaa-bbbb-cccc.example.com/x"), null);
  assert.equal(
    ghsaIdFromUrl("https://example.com/p?id=GHSA-aaaa-bbbb-cccc"),
    null,
  );
});

test("ghsaIdFromUrl: rejects non-urls, empty values and non-GHSA segments", () => {
  for (const value of ["", "not a url", null, undefined, 42, "https://example.com/x"]) {
    assert.equal(ghsaIdFromUrl(value), null, String(value));
  }
});

// ---------------------------------------------------------------------------
// The npm v7+ (`auditReportVersion` 2) report shape
//
// Fixture-driven of necessity: this repo has zero vulnerabilities tree-wide,
// so no live npm sample carrying an advisory can be captured from it.
// ---------------------------------------------------------------------------

// The committed sample of a REAL `npm audit --json` v2 report. Every other
// fixture in this suite is built inline, and this one deliberately is not:
// the npm schema is npm's, not ours, and an inline literal drifts toward
// whatever the test needed rather than what the tool emits. Committing the
// shape means a future reader can diff it against a live `npm audit --json`.
//
// It carries no `via[].cve` key, because npm's bundled advisory calculator
// never emits one. The normalizer still READS `cve` — another producer may
// write it — but nothing in this suite asserts a field npm does not emit,
// which is how a test can otherwise certify a code path against a schema that
// does not exist.
const NPM_FIXTURE_URL = new URL("./fixtures/npm-audit-v2.json", import.meta.url);

/** The canonical id the fixture's single advisory carries. */
const NPM_FIXTURE_ID = "GHSA-fixt-ure0-0001";

/**
 * A fresh parse of the committed fixture, optionally re-severitied so the
 * below-gate cases exercise the same real shape.
 *
 * @param {{ severity?: string }} [opts]
 */
function npmFixtureReport({ severity } = {}) {
  const report = JSON.parse(readFileSync(NPM_FIXTURE_URL, "utf8"));
  if (severity !== undefined) {
    for (const entry of Object.values(report.vulnerabilities)) {
      entry.severity = severity;
      for (const via of entry.via) {
        if (typeof via === "object") {
          via.severity = severity;
        }
      }
    }
  }
  return report;
}

test("#488 AC-5: the committed fixture is the real npm audit v2 shape", () => {
  const report = npmFixtureReport();
  assert.equal(report.auditReportVersion, 2);

  const via = report.vulnerabilities["fixture-lib"].via[0];
  for (const key of [
    "source",
    "name",
    "dependency",
    "title",
    "url",
    "severity",
    "cwe",
    "cvss",
    "range",
  ]) {
    assert.ok(key in via, `via[] advisory must carry \`${key}\``);
  }
  assert.equal(
    "cve" in via,
    false,
    "npm's advisory calculator emits no `cve` on a via[] advisory",
  );
});

test("#488 AC-5: recognizeReport normalizes the committed npm fixture", () => {
  const { schema, advisories } = recognizeReport(npmFixtureReport());
  assert.equal(schema, "npm");
  // The fixture's second package reaches the same advisory through a STRING
  // edge, so this also pins the transitive chain to one finding.
  assert.equal(advisories.length, 1);
  assert.deepEqual(advisories[0].ids, [NPM_FIXTURE_ID]);
  assert.equal(advisories[0].severity, "high");
  assert.equal(advisories[0].title, "Prototype pollution in fixture-lib");
});

test("recognizeReport: identifies each schema and normalizes its advisories", () => {
  assert.equal(recognizeReport(reportWith({ 1: HIGH_GHSA })).schema, "legacy");

  const npm = recognizeReport(npmFixtureReport());
  assert.equal(npm.schema, "npm");
  assert.equal(npm.advisories.length, 1);
  assert.deepEqual(npm.advisories[0].ids, [NPM_FIXTURE_ID]);
  assert.equal(npm.advisories[0].severity, "high");
});

test("recognizeReport: an empty npm report is RECOGNIZED, not unreadable", () => {
  // The real shape this repo produces today. It must read as a genuine clean —
  // reached by inspecting `vulnerabilities`, not by failing to find
  // `advisories`.
  const result = recognizeReport({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { total: 0 } },
  });
  assert.equal(result.schema, "npm");
  assert.deepEqual(result.advisories, []);
});

test("evaluateReport: an unsuppressed high in the NPM shape blocks", () => {
  const result = evaluateReport(npmFixtureReport(), 1, new Set());
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "unsuppressed");
  assert.equal(result.schema, "npm");
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].id, NPM_FIXTURE_ID);
});

test("evaluateReport: an allowlisted GHSA id suppresses in the NPM shape", () => {
  // The id exists only inside `via[].url` here, so this is the assertion that
  // the allowlist still means something once the schema changes.
  const result = evaluateReport(
    npmFixtureReport(),
    1,
    new Set([NPM_FIXTURE_ID]),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, "clean");
});

test("evaluateReport: below-gate npm severities never block", () => {
  for (const severity of ["moderate", "low", "info"]) {
    const result = evaluateReport(npmFixtureReport({ severity }), 0, new Set());
    assert.equal(result.exitCode, 0, severity);
    assert.equal(result.reason, "clean", severity);
  }
});

// ---------------------------------------------------------------------------
// Story #488 — id normalization
//
// The allowlist is this gate's ONLY sanctioned suppression mechanism, and it
// was inert for the id form GitHub renders and every operator pastes: the npm
// path upper-cased the id it parsed out of `via[].url`, the pnpm path kept
// `ghsa_id` verbatim, and `partitionAllowlist` matched with an exact
// `Set.has`. A canonical `GHSA-7w5x-hrqm-74c2` therefore suppressed under pnpm
// and silently did nothing under npm — the worst shape of failure available,
// because the entry LOOKS applied.
// ---------------------------------------------------------------------------

test("normalizeAdvisoryId: GHSA ids fold to the canonical rendering", () => {
  for (const spelling of [
    "GHSA-7w5x-hrqm-74c2",
    "ghsa-7w5x-hrqm-74c2",
    "GHSA-7W5X-HRQM-74C2",
    "GHSA-7W5x-HrQm-74c2",
    "  GHSA-7w5x-hrqm-74c2  ",
  ]) {
    assert.equal(
      normalizeAdvisoryId(spelling),
      "GHSA-7w5x-hrqm-74c2",
      spelling,
    );
  }
});

test("normalizeAdvisoryId: a CVE id folds to its own canonical upper case", () => {
  assert.equal(normalizeAdvisoryId("cve-2026-0994"), "CVE-2026-0994");
  assert.equal(normalizeAdvisoryId("CVE-2026-0994"), "CVE-2026-0994");
});

test("normalizeAdvisoryId: nothing to normalize yields the empty string", () => {
  for (const value of ["", "   ", null, undefined, 42, {}, []]) {
    assert.equal(normalizeAdvisoryId(value), "", JSON.stringify(value));
  }
});

test("partitionAllowlist: a mixed-case allowlist id lands canonical", () => {
  const { suppressed } = partitionAllowlist(
    [{ id: "GHSA-7W5X-HRQM-74C2", reason: "accepted", expires: FUTURE }],
    TODAY,
  );
  assert.ok(suppressed.has("GHSA-7w5x-hrqm-74c2"));
});

// ---------------------------------------------------------------------------
// Story #488 — the CLI, driven through its injectable subprocess seam
//
// `runCli(argv, { spawnImpl })` is the seam (`.agents/rules/test-seams.md`):
// production keeps the real `spawnSync`, and these cases substitute a stub so
// the whole CLI path — allowlist, manager detection, audit invocation, report
// evaluation, exit code — is executable without spawning a package manager or
// reaching a registry. Before it existed, every one of those paths was
// reachable only by running a real audit, which is why the ones below shipped
// broken.
// ---------------------------------------------------------------------------

/** A recording `spawnSync` stub returning a canned result. */
function stubSpawn(result, calls = []) {
  return (bin, args, options) => {
    calls.push({ bin, args, options });
    return { status: 0, stdout: "", stderr: "", ...result };
  };
}

/**
 * Materialize a throwaway project — package.json, one lockfile, an optional
 * allowlist — and run `fn` against its absolute argv.
 *
 * @param {{ lockfile: string; allowlist?: unknown[] }} spec
 * @param {(ctx: { dir: string; argv: string[] }) => void} fn
 */
function withProject({ lockfile, allowlist }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "audit-check-cli-"));
  try {
    const packageJsonPath = join(dir, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    writeFileSync(
      join(dir, lockfile),
      lockfile.endsWith(".json") ? "{}\n" : "lockfileVersion: '9.0'\n",
    );

    const allowlistPath = join(dir, "audit-allowlist.json");
    if (allowlist !== undefined) {
      writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2));
    }

    fn({
      dir,
      argv: ["--package-json", packageJsonPath, "--allowlist", allowlistPath],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `fn` with console output collected rather than printed. */
function captureConsole(fn) {
  /** @type {string[]} */
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    return { value: fn(), output: lines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("#488 AC-1: a canonical lowercase allowlist id suppresses an npm advisory written in any case", () => {
  // The npm report exposes its id ONLY inside `via[].url`, and GitHub's own
  // links are mixed-case-tolerant. The allowlist entry is written exactly as
  // the runbook shows it.
  const report = npmFixtureReport();
  report.vulnerabilities["fixture-lib"].via[0].url =
    "https://github.com/advisories/GHSA-7W5X-HrQm-74C2";
  const stdout = JSON.stringify(report);

  withProject(
    {
      lockfile: "package-lock.json",
      allowlist: [
        {
          id: "GHSA-7w5x-hrqm-74c2",
          reason: "no fix available upstream yet",
          expires: FUTURE,
        },
      ],
    },
    ({ argv }) => {
      const { value } = captureConsole(() =>
        runCli(argv, { spawnImpl: stubSpawn({ status: 1, stdout }) }),
      );
      assert.equal(value, 0, "the canonical id must suppress under npm");
    },
  );

  // Control: the same advisory with nothing allowlisted still blocks, so the
  // exit 0 above is suppression rather than a report that was never read.
  withProject({ lockfile: "package-lock.json" }, ({ argv }) => {
    const { value } = captureConsole(() =>
      runCli(argv, { spawnImpl: stubSpawn({ status: 1, stdout }) }),
    );
    assert.equal(value, 1);
  });
});

test("#488 AC-1: the same canonical id suppresses a pnpm advisory written in any case", () => {
  const stdout = JSON.stringify(
    reportWith({
      1: {
        ghsa_id: "GHSA-7W5x-HrQm-74C2",
        severity: "high",
        title: "High severity in a transitive dep",
        url: "https://github.com/advisories/GHSA-7w5x-hrqm-74c2",
      },
    }),
  );

  withProject(
    {
      lockfile: "pnpm-lock.yaml",
      allowlist: [
        {
          id: "GHSA-7w5x-hrqm-74c2",
          reason: "no fix available upstream yet",
          expires: FUTURE,
        },
      ],
    },
    ({ argv }) => {
      const { value } = captureConsole(() =>
        runCli(argv, { spawnImpl: stubSpawn({ status: 1, stdout }) }),
      );
      assert.equal(value, 0, "the canonical id must suppress under pnpm");
    },
  );

  withProject({ lockfile: "pnpm-lock.yaml" }, ({ argv }) => {
    const { value } = captureConsole(() =>
      runCli(argv, { spawnImpl: stubSpawn({ status: 1, stdout }) }),
    );
    assert.equal(value, 1);
  });
});

test("#488 AC-2: the audit runs in the directory whose lockfile was detected, bounded", () => {
  // `detectPackageManager` reads `dirname(--package-json)`; the audit used to
  // run in `process.cwd()`. When those differ the gate reported on a graph it
  // never audited — an unfalsifiable claim, which is the one thing this gate
  // must not produce.
  const calls = [];
  const stdout = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {},
  });

  withProject({ lockfile: "package-lock.json" }, ({ dir, argv }) => {
    const { value } = captureConsole(() =>
      runCli(argv, { spawnImpl: stubSpawn({ status: 0, stdout }, calls) }),
    );
    assert.equal(value, 0);
    assert.equal(calls.length, 1);

    const [call] = calls;
    assert.equal(call.bin, "npm");
    assert.deepEqual(call.args, ["audit", "--omit=dev", "--json"]);
    assert.equal(call.options.cwd, dir);
    assert.ok(
      typeof call.options.timeout === "number" && call.options.timeout > 0,
      "the audit must be time-bounded",
    );
    assert.ok(
      call.options.maxBuffer >= 64 * 1024 * 1024,
      `maxBuffer must be at least 64 MiB, got ${call.options.maxBuffer}`,
    );
    // No shell string, ever: the argv form is what keeps this call off an
    // injection surface, and what kept stderr out of `/dev/null`.
    assert.equal(call.options.shell, undefined);
  });
});

test("#488 AC-2: the pnpm branch spawns pnpm's own argv in the detected directory", () => {
  const calls = [];
  const stdout = JSON.stringify({ advisories: {}, metadata: {} });

  withProject({ lockfile: "pnpm-lock.yaml" }, ({ dir, argv }) => {
    const { value } = captureConsole(() =>
      runCli(argv, { spawnImpl: stubSpawn({ status: 0, stdout }, calls) }),
    );
    assert.equal(value, 0);
    assert.equal(calls[0].bin, "pnpm");
    assert.deepEqual(calls[0].args, ["audit", "--prod", "--json"]);
    assert.equal(calls[0].options.cwd, dir);
  });
});

test("#488 AC-3: an audit that says nothing is never clean, and its stderr is shown", () => {
  // Exit 0 with unreadable stdout is how EVERY failure to run at all presents:
  // a missing binary, a killed child, an output ceiling hit mid-write. The old
  // contract printed "No vulnerabilities found" and exited 0 for all of them.
  const stderrText = "npm error code ENETUNREACH: registry unreachable";

  for (const [label, stdout] of [
    ["empty stdout", ""],
    ["whitespace only", "   \n"],
    ["a human-readable notice", "up to date, audited 214 packages\n"],
  ]) {
    withProject({ lockfile: "package-lock.json" }, ({ argv }) => {
      const { value, output } = captureConsole(() =>
        runCli(argv, {
          spawnImpl: stubSpawn({ status: 0, stdout, stderr: stderrText }),
        }),
      );
      assert.equal(value, 1, label);
      assert.match(output, /Failing closed/, label);
      assert.ok(output.includes(stderrText), `${label} must show the stderr`);
      assert.ok(
        !output.includes("No vulnerabilities found"),
        `${label} must not report clean`,
      );
    });
  }
});

test("#488 AC-3: a spawn that never ran at all fails closed with its reason", () => {
  // `spawnSync` reports a missing binary or a fired timeout through `error`,
  // with no exit status at all.
  withProject({ lockfile: "package-lock.json" }, ({ argv }) => {
    const { value, output } = captureConsole(() =>
      runCli(argv, {
        spawnImpl: () => ({
          status: null,
          stdout: "",
          stderr: "",
          error: new Error("spawnSync npm ENOENT"),
        }),
      }),
    );
    assert.equal(value, 1);
    assert.match(output, /ENOENT/);
  });
});

test("#488 AC-3: a parsed report matching no known schema still fails closed", () => {
  withProject({ lockfile: "package-lock.json" }, ({ argv }) => {
    const { value, output } = captureConsole(() =>
      runCli(argv, {
        spawnImpl: stubSpawn({
          status: 0,
          stdout: JSON.stringify({ auditReportVersion: 3, findings: [] }),
          stderr: "npm warn audit schema changed",
        }),
      }),
    );
    assert.equal(value, 1);
    assert.match(output, /matching no known audit schema/);
    assert.match(output, /npm warn audit schema changed/);
  });
});

test("#488 AC-4: a blocking advisory with no parseable id is reported, never dropped", () => {
  // The npm identity fallback was `ghsaId ?? source ?? url`, and `source` is
  // coerced to `""` when absent — so `"" ?? url` is `""`, the url arm was dead
  // code, and the empty key hit a `continue` that DISCARDED the advisory. A
  // Critical silently vanished for lacking a name.
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      nameless: {
        name: "nameless",
        severity: "critical",
        via: [{ name: "nameless", title: "Critical with no id", severity: "critical" }],
      },
    },
    metadata: {},
  };

  const result = evaluateReport(report, 0, new Set());
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "unsuppressed");
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].id, "(unknown)");
  assert.equal(result.blocking[0].title, "Critical with no id");
});

test("#488 AC-4: two id-less advisories are two findings, not one collapsed key", () => {
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      first: {
        name: "first",
        severity: "high",
        via: [{ name: "first", title: "First nameless high", severity: "high" }],
      },
      second: {
        name: "second",
        severity: "critical",
        via: [{ name: "second", title: "Second nameless critical", severity: "critical" }],
      },
    },
    metadata: {},
  };

  assert.equal(evaluateReport(report, 0, new Set()).blocking.length, 2);
});

test("#488 AC-4: an id-less advisory blocks through the CLI and prints (unknown)", () => {
  const stdout = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      nameless: {
        name: "nameless",
        severity: "critical",
        via: [{ name: "nameless", title: "Critical with no id", severity: "critical" }],
      },
    },
    metadata: {},
  });

  withProject({ lockfile: "package-lock.json" }, ({ argv }) => {
    const { value, output } = captureConsole(() =>
      runCli(argv, { spawnImpl: stubSpawn({ status: 1, stdout }) }),
    );
    assert.equal(value, 1);
    assert.match(output, /\(unknown\)/);
  });
});

test("#488 AC-4: an id-less advisory in the legacy schema blocks too", () => {
  const report = reportWith({
    1: { severity: "critical", title: "Legacy critical with no id" },
  });
  const result = evaluateReport(report, 0, new Set());
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].id, "(unknown)");
});

test("#488 AC-5: the committed fixture blocks through the CLI, naming its canonical id", () => {
  const stdout = JSON.stringify(npmFixtureReport());

  withProject({ lockfile: "package-lock.json" }, ({ argv }) => {
    const { value, output } = captureConsole(() =>
      runCli(argv, { spawnImpl: stubSpawn({ status: 1, stdout }) }),
    );
    assert.equal(value, 1);
    assert.ok(output.includes(NPM_FIXTURE_ID), output);
  });
});
