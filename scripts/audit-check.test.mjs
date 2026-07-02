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
