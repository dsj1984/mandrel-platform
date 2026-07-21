// Unit coverage for the OSV report severity-band gate (Story #310).
//
// This logic used to live as a heredoc inside pr-quality.yml and was
// therefore untestable. The banding thresholds, the Story #145 allow-list
// schema validation, and the `revisitBy` re-gating are the load-bearing
// pieces — a silent regression in any of them either lets a real advisory
// through or blocks a legitimately-suppressed one. These tests pin them.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bandOf,
  collectRows,
  loadAllowlist,
  classify,
  findingsDigest,
  renderSummary,
  OsvGateError,
} from "../.github/actions/osv-scan/osv-report-gate.mjs";

// Build an OSV-scanner-shaped report for one grouped advisory.
const reportWith = (groups) => ({
  results: [
    {
      source: { path: "pnpm-lock.yaml" },
      packages: groups.map((g) => ({
        package: { name: g.name, version: g.version || "1.0.0", ecosystem: g.ecosystem || "npm" },
        groups: [{ ids: g.ids, max_severity: g.score }],
      })),
    },
  ],
});

test("bandOf buckets CVSS scores into the documented bands", () => {
  assert.equal(bandOf(9.8), "critical");
  assert.equal(bandOf(9.0), "critical");
  assert.equal(bandOf(7.5), "high");
  assert.equal(bandOf(7.0), "high");
  assert.equal(bandOf(4.0), "medium");
  assert.equal(bandOf(6.9), "medium");
  assert.equal(bandOf(0.1), "low");
  assert.equal(bandOf(0), "none");
  assert.equal(bandOf(NaN), "none");
});

test("a high finding blocks at the default gate; a medium finding warns", () => {
  const rows = collectRows(
    reportWith([
      { name: "brace-expansion", ids: ["GHSA-3jxr-9vmj-r5cp"], score: "7.5" },
      { name: "some-medium", ids: ["GHSA-medium"], score: "5.0" },
    ]),
  );
  const v = classify(rows, { failOn: "high" });
  assert.equal(v.blocking.length, 1);
  assert.equal(v.blocking[0].ids[0], "GHSA-3jxr-9vmj-r5cp");
  assert.equal(v.warning.length, 1);
  assert.equal(v.warning[0].ids[0], "GHSA-medium");
});

test("critical, high, medium, low, none all classify against a high gate", () => {
  const rows = collectRows(
    reportWith([
      { name: "crit", ids: ["C"], score: "9.9" },
      { name: "hi", ids: ["H"], score: "7.1" },
      { name: "med", ids: ["M"], score: "4.5" },
      { name: "lo", ids: ["L"], score: "1.0" },
      { name: "un", ids: ["U"], score: "" }, // unscored → none
    ]),
  );
  const v = classify(rows, { failOn: "high" });
  assert.deepEqual(
    v.blocking.map((r) => r.band),
    ["critical", "high"],
  );
  assert.deepEqual(
    v.warning.map((r) => r.band),
    ["medium", "low", "none"],
  );
});

test("an advisory with no group still counts as an unscored 'none' finding", () => {
  const report = {
    results: [
      {
        source: { path: "package-lock.json" },
        packages: [
          {
            package: { name: "loner", version: "2.0.0", ecosystem: "npm" },
            vulnerabilities: [{ id: "GHSA-ungrouped" }],
          },
        ],
      },
    ],
  };
  const rows = collectRows(report);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].band, "none");
  assert.equal(rows[0].ids[0], "GHSA-ungrouped");
});

test("a missing allow-list yields gating identical to no allow-list", () => {
  // exists() returns false → empty list, no throw.
  const allowlist = loadAllowlist(".osv-allowlist.json", { exists: () => false });
  assert.deepEqual(allowlist, []);

  const rows = collectRows(reportWith([{ name: "brace-expansion", ids: ["GHSA-x"], score: "7.5" }]));
  const withMissing = classify(rows, { failOn: "high", allowlist });
  const withNone = classify(rows, { failOn: "high", allowlist: [] });
  assert.deepEqual(withMissing.blocking, withNone.blocking);
  assert.equal(withMissing.blocking.length, 1);
});

test("a present-but-malformed allow-list is a hard error, not a silent match", () => {
  const opts = { exists: () => true, readFile: () => "{ not json" };
  assert.throws(() => loadAllowlist(".osv-allowlist.json", opts), OsvGateError);

  const notArray = { exists: () => true, readFile: () => JSON.stringify({ nope: true }) };
  assert.throws(() => loadAllowlist(".osv-allowlist.json", notArray), OsvGateError);

  const missingReason = {
    exists: () => true,
    readFile: () => JSON.stringify([{ id: "GHSA-x", revisitBy: "2099-01-01" }]),
  };
  assert.throws(() => loadAllowlist(".osv-allowlist.json", missingReason), OsvGateError);

  const badDate = {
    exists: () => true,
    readFile: () => JSON.stringify([{ id: "GHSA-x", reason: "triaged", revisitBy: "soon" }]),
  };
  assert.throws(() => loadAllowlist(".osv-allowlist.json", badDate), OsvGateError);
});

test("an unexpired suppression moves a blocking finding to suppressed", () => {
  const rows = collectRows(
    reportWith([{ name: "brace-expansion", ids: ["GHSA-3jxr-9vmj-r5cp"], score: "7.5" }]),
  );
  const allowlist = [
    { id: "GHSA-3jxr-9vmj-r5cp", reason: "no reachable sink", revisitBy: "2099-12-31" },
  ];
  const v = classify(rows, { failOn: "high", allowlist, today: "2026-07-21" });
  assert.equal(v.blocking.length, 0);
  assert.equal(v.suppressed.length, 1);
  assert.equal(v.expired.length, 0);
});

test("a suppression past revisitBy re-gates as blocking", () => {
  const rows = collectRows(
    reportWith([{ name: "brace-expansion", ids: ["GHSA-3jxr-9vmj-r5cp"], score: "7.5" }]),
  );
  const allowlist = [
    { id: "GHSA-3jxr-9vmj-r5cp", reason: "stale triage", revisitBy: "2026-01-01" },
  ];
  const v = classify(rows, { failOn: "high", allowlist, today: "2026-07-21" });
  assert.equal(v.blocking.length, 1);
  assert.equal(v.expired.length, 1);
  assert.equal(v.suppressed.length, 0);
});

test("a package/ecosystem-scoped suppression only matches its own package", () => {
  const rows = collectRows(
    reportWith([
      { name: "brace-expansion", ids: ["GHSA-shared"], score: "7.5" },
      { name: "other-pkg", ids: ["GHSA-shared"], score: "7.5" },
    ]),
  );
  const allowlist = [
    {
      id: "GHSA-shared",
      reason: "only brace-expansion is unreachable",
      revisitBy: "2099-12-31",
      package: "brace-expansion",
      ecosystem: "npm",
    },
  ];
  const v = classify(rows, { failOn: "high", allowlist, today: "2026-07-21" });
  assert.equal(v.suppressed.length, 1);
  assert.equal(v.suppressed[0].name, "brace-expansion");
  assert.equal(v.blocking.length, 1);
  assert.equal(v.blocking[0].name, "other-pkg");
});

test("an invalid fail-on band is a hard error", () => {
  assert.throws(() => classify([], { failOn: "sky-high" }), OsvGateError);
});

test("findingsDigest is stable across row order and ignores below-gate rows", () => {
  const a = collectRows(
    reportWith([
      { name: "p1", ids: ["GHSA-a"], score: "7.5" },
      { name: "p2", ids: ["GHSA-b"], score: "9.1" },
    ]),
  );
  const b = collectRows(
    reportWith([
      { name: "p2", ids: ["GHSA-b"], score: "9.1" },
      { name: "p1", ids: ["GHSA-a"], score: "7.5" },
    ]),
  );
  const va = classify(a, { failOn: "high" });
  const vb = classify(b, { failOn: "high" });
  assert.equal(findingsDigest(va.blocking), findingsDigest(vb.blocking));

  // A new blocking advisory changes the digest.
  const c = collectRows(
    reportWith([
      { name: "p1", ids: ["GHSA-a"], score: "7.5" },
      { name: "p2", ids: ["GHSA-b"], score: "9.1" },
      { name: "p3", ids: ["GHSA-c"], score: "8.0" },
    ]),
  );
  const vc = classify(c, { failOn: "high" });
  assert.notEqual(findingsDigest(va.blocking), findingsDigest(vc.blocking));
});

test("renderSummary reports a clean scan and a blocked scan distinctly", () => {
  const clean = renderSummary(classify([], { failOn: "high" }));
  assert.match(clean.join("\n"), /no known advisories/);

  const blocked = renderSummary(
    classify(collectRows(reportWith([{ name: "p", ids: ["GHSA-x"], score: "9.0" }])), {
      failOn: "high",
    }),
  );
  assert.match(blocked.join("\n"), /❌ BLOCKED/);
  assert.match(blocked.join("\n"), /GHSA-x/);
});
