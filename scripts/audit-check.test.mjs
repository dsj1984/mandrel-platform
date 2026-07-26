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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

test("evaluateReport: uninterpretable report + zero exit → exit 0 (clean, nothing to report)", () => {
  const result = evaluateReport({ metadata: {} }, 0, new Set());
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, "clean-no-advisories");
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
