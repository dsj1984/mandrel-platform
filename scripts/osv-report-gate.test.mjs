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
  normalizeSource,
  rowKey,
  buildBaselineSet,
  OsvGateError,
} from "../.github/actions/osv-scan/osv-report-gate.mjs";

// Build an OSV-scanner-shaped report for one grouped advisory. `published`
// rides on the per-vulnerability entries, mirroring the real OSV schema —
// group rows carry the severity, never the date.
const reportWith = (groups, { sourcePath = "pnpm-lock.yaml" } = {}) => ({
  results: [
    {
      source: { path: sourcePath },
      packages: groups.map((g) => ({
        package: { name: g.name, version: g.version || "1.0.0", ecosystem: g.ecosystem || "npm" },
        groups: [{ ids: g.ids, max_severity: g.score }],
        ...(g.published
          ? { vulnerabilities: g.ids.map((id) => ({ id, published: g.published })) }
          : {}),
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

// ---------------------------------------------------------------------------
// Diff-aware baseline + publish grace window (Story #325)
//
// The failure these close: a newly-published advisory against a dependency
// that has been on `main` for weeks reds EVERY open PR simultaneously — the
// postcss GHSA-r28c-9q8g-f849 / brace-expansion GHSA-mh99-v99m-4gvg incidents
// on the swarm-os consumer. The gate must tell "this PR introduced it" from
// "this was already here", without ever letting a real PR-introduced advisory
// through and without neutering the operator-authored `revisitBy` re-gate.
// ---------------------------------------------------------------------------

// A baseline built from the SAME tree, as the merge-base worktree scan yields.
const baselineOf = (groups, opts) => buildBaselineSet(collectRows(reportWith(groups, opts), opts));

test("a finding already present at the baseline is demoted, not blocked", () => {
  const groups = [{ name: "postcss", ids: ["GHSA-r28c-9q8g-f849"], score: "7.5" }];
  const v = classify(collectRows(reportWith(groups)), {
    failOn: "high",
    baseline: baselineOf(groups),
  });
  assert.equal(v.blocking.length, 0);
  assert.equal(v.preexisting.length, 1);
  assert.equal(v.preexisting[0].ids[0], "GHSA-r28c-9q8g-f849");
});

test("a head-only finding is PR-introduced and still blocks", () => {
  const v = classify(
    collectRows(
      reportWith([
        { name: "postcss", ids: ["GHSA-r28c-9q8g-f849"], score: "7.5" },
        { name: "brand-new-dep", ids: ["GHSA-new"], score: "8.2" },
      ]),
    ),
    {
      failOn: "high",
      baseline: baselineOf([{ name: "postcss", ids: ["GHSA-r28c-9q8g-f849"], score: "7.5" }]),
    },
  );
  assert.equal(v.blocking.length, 1);
  assert.equal(v.blocking[0].name, "brand-new-dep");
  assert.equal(v.preexisting.length, 1);
  assert.equal(v.preexisting[0].name, "postcss");
});

test("bumping an advisory-bearing dep to another vulnerable version still blocks", () => {
  // Same package, same advisory id — only the version moved. The baseline key
  // carries @version precisely so this cannot inherit the demotion.
  const v = classify(
    collectRows(reportWith([{ name: "postcss", ids: ["GHSA-r28c"], score: "7.5", version: "8.4.0" }])),
    {
      failOn: "high",
      baseline: baselineOf([
        { name: "postcss", ids: ["GHSA-r28c"], score: "7.5", version: "8.3.0" },
      ]),
    },
  );
  assert.equal(v.blocking.length, 1);
  assert.equal(v.blocking[0].version, "8.4.0");
  assert.equal(v.preexisting.length, 0);
});

test("normalizeSource reduces worktree-rooted and workspace-rooted paths alike", () => {
  assert.equal(normalizeSource("/tmp/osv-baseline/pnpm-lock.yaml", "/tmp/osv-baseline"), "pnpm-lock.yaml");
  assert.equal(normalizeSource("/home/runner/work/repo/pnpm-lock.yaml", "/home/runner/work/repo"), "pnpm-lock.yaml");
  assert.equal(normalizeSource("./pnpm-lock.yaml", "/tmp/osv-baseline"), "pnpm-lock.yaml");
  assert.equal(normalizeSource("pnpm-lock.yaml", ""), "pnpm-lock.yaml");
  // A trailing slash on the root must not leave a leading slash behind.
  assert.equal(normalizeSource("/tmp/base/apps/web/pnpm-lock.yaml", "/tmp/base/"), "apps/web/pnpm-lock.yaml");
});

test("the baseline matches across differing scan roots", () => {
  // The head scan runs in the workspace; the baseline scan runs in a git
  // worktree at a different absolute path. Un-normalized, every head finding
  // would look head-only and the diff-aware gate would block everything.
  const groups = [{ name: "postcss", ids: ["GHSA-r28c"], score: "7.5" }];
  const headRows = collectRows(
    reportWith(groups, { sourcePath: "/home/runner/work/repo/pnpm-lock.yaml" }),
    { scanRoot: "/home/runner/work/repo" },
  );
  const baseRows = collectRows(reportWith(groups, { sourcePath: "/tmp/osv-baseline/pnpm-lock.yaml" }), {
    scanRoot: "/tmp/osv-baseline",
  });
  assert.equal(rowKey(headRows[0]), rowKey(baseRows[0]));

  const v = classify(headRows, { failOn: "high", baseline: buildBaselineSet(baseRows) });
  assert.equal(v.blocking.length, 0);
  assert.equal(v.preexisting.length, 1);
});

test("an EXPIRED suppression outranks the baseline demotion and still re-gates", () => {
  // The load-bearing precedence rule. An expired suppression is by
  // construction on a pre-existing dependency, so letting the baseline demote
  // it would neuter `revisitBy` on PRs entirely.
  const groups = [{ name: "brace-expansion", ids: ["GHSA-mh99-v99m-4gvg"], score: "7.5" }];
  const v = classify(collectRows(reportWith(groups)), {
    failOn: "high",
    allowlist: [{ id: "GHSA-mh99-v99m-4gvg", reason: "stale triage", revisitBy: "2026-01-01" }],
    today: "2026-07-24",
    baseline: baselineOf(groups),
    graceDays: 3650,
  });
  assert.equal(v.blocking.length, 1);
  assert.equal(v.expired.length, 1);
  assert.equal(v.preexisting.length, 0);
  assert.equal(v.grace.length, 0);
});

test("an UNEXPIRED suppression stays suppressed and is not double-counted", () => {
  const groups = [{ name: "brace-expansion", ids: ["GHSA-mh99-v99m-4gvg"], score: "7.5" }];
  const v = classify(collectRows(reportWith(groups)), {
    failOn: "high",
    allowlist: [{ id: "GHSA-mh99-v99m-4gvg", reason: "not reachable", revisitBy: "2099-12-31" }],
    today: "2026-07-24",
    baseline: baselineOf(groups),
  });
  assert.equal(v.suppressed.length, 1);
  assert.equal(v.blocking.length, 0);
  assert.equal(v.preexisting.length, 0);
});

test("the grace window demotes a recent advisory and not an old one", () => {
  const rows = collectRows(
    reportWith([
      { name: "fresh", ids: ["GHSA-fresh"], score: "8.0", published: "2026-07-21T00:00:00Z" },
      { name: "stale", ids: ["GHSA-stale"], score: "8.0", published: "2026-06-24T00:00:00Z" },
    ]),
  );
  const v = classify(rows, { failOn: "high", graceDays: 7, today: "2026-07-24" });
  assert.deepEqual(
    v.grace.map((r) => r.name),
    ["fresh"],
  );
  assert.deepEqual(
    v.blocking.map((r) => r.name),
    ["stale"],
  );
});

test("the grace window fails closed when the publish date is unresolvable", () => {
  // No `published` on the vulnerability entries at all…
  const undated = classify(collectRows(reportWith([{ name: "p", ids: ["GHSA-x"], score: "8.0" }])), {
    failOn: "high",
    graceDays: 7,
    today: "2026-07-24",
  });
  assert.equal(undated.blocking.length, 1);
  assert.equal(undated.grace.length, 0);

  // …and a present-but-garbage date is equally not a free pass.
  const garbage = classify(
    collectRows(reportWith([{ name: "p", ids: ["GHSA-x"], score: "8.0", published: "not-a-date" }])),
    { failOn: "high", graceDays: 7, today: "2026-07-24" },
  );
  assert.equal(garbage.blocking.length, 1);
  assert.equal(garbage.grace.length, 0);
});

test("the grace window is off at the default of 0", () => {
  const rows = collectRows(
    reportWith([
      { name: "fresh", ids: ["GHSA-fresh"], score: "8.0", published: "2026-07-23T00:00:00Z" },
    ]),
  );
  const v = classify(rows, { failOn: "high", today: "2026-07-24" });
  assert.equal(v.graceDays, 0);
  assert.equal(v.grace.length, 0);
  assert.equal(v.blocking.length, 1);
});

test("collectRows takes the EARLIEST published date across a group's aliased ids", () => {
  const report = {
    results: [
      {
        source: { path: "pnpm-lock.yaml" },
        packages: [
          {
            package: { name: "p", version: "1.0.0", ecosystem: "npm" },
            groups: [{ ids: ["GHSA-a", "CVE-b"], max_severity: "8.0" }],
            vulnerabilities: [
              { id: "GHSA-a", published: "2026-07-20T00:00:00Z" },
              { id: "CVE-b", published: "2026-05-01T00:00:00Z" },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(collectRows(report)[0].published, "2026-05-01T00:00:00Z");

  // …and the earliest date is what the window is judged against, so an alias
  // published long ago cannot be laundered into the window by a fresh alias.
  const v = classify(collectRows(report), { failOn: "high", graceDays: 7, today: "2026-07-24" });
  assert.equal(v.blocking.length, 1);
  assert.equal(v.grace.length, 0);
});

test("with no baseline and no grace window the partition is unchanged", () => {
  // The backward-compatibility contract: default inputs must classify exactly
  // as they did before diff-awareness existed.
  const rows = collectRows(
    reportWith([
      { name: "crit", ids: ["C"], score: "9.9" },
      { name: "hi", ids: ["H"], score: "7.1" },
      { name: "med", ids: ["M"], score: "4.5" },
      { name: "sup", ids: ["S"], score: "8.0" },
    ]),
  );
  const allowlist = [{ id: "S", reason: "triaged", revisitBy: "2099-12-31" }];
  const v = classify(rows, { failOn: "high", allowlist, today: "2026-07-24" });

  assert.deepEqual(
    v.blocking.map((r) => r.name),
    ["crit", "hi"],
  );
  assert.deepEqual(
    v.warning.map((r) => r.name),
    ["med"],
  );
  assert.equal(v.suppressed.length, 1);
  assert.equal(v.expired.length, 0);
  // The new buckets exist but are inert.
  assert.deepEqual(v.preexisting, []);
  assert.deepEqual(v.grace, []);
  assert.equal(v.baselineApplied, false);
});

test("findingsDigest ignores preexisting and grace rows entirely", () => {
  // The scheduled tracking issue keys off this digest; a PR-side demotion must
  // not rewrite the issue body or make an unchanged advisory set look new.
  const groups = [
    { name: "p1", ids: ["GHSA-a"], score: "7.5" },
    { name: "p2", ids: ["GHSA-b"], score: "9.1", published: "2026-07-23T00:00:00Z" },
  ];
  const plain = classify(collectRows(reportWith(groups)), { failOn: "high", today: "2026-07-24" });
  const demoted = classify(collectRows(reportWith(groups)), {
    failOn: "high",
    today: "2026-07-24",
    baseline: baselineOf([groups[0]]),
    graceDays: 7,
  });

  assert.equal(demoted.blocking.length, 0);
  assert.equal(demoted.preexisting.length, 1);
  assert.equal(demoted.grace.length, 1);
  assert.equal(findingsDigest(demoted.blocking), findingsDigest([]));
  assert.notEqual(findingsDigest(plain.blocking), findingsDigest(demoted.blocking));
});

test("renderSummary names both demotion buckets with one table row each", () => {
  const groups = [
    { name: "postcss", ids: ["GHSA-r28c-9q8g-f849"], score: "7.5" },
    { name: "fresh", ids: ["GHSA-fresh"], score: "8.0", published: "2026-07-23T00:00:00Z" },
  ];
  const v = classify(collectRows(reportWith(groups)), {
    failOn: "high",
    today: "2026-07-24",
    baseline: baselineOf([groups[0]]),
    graceDays: 7,
  });
  const out = renderSummary(v).join("\n");

  assert.match(out, /Pre-existing on the base branch — not introduced by this PR \(1\)/);
  assert.match(out, /Within the publish grace window \(1\)/);
  assert.match(out, /GHSA-r28c-9q8g-f849/);
  assert.match(out, /GHSA-fresh/);
  // Demotions are not a pass-with-nothing-to-say: the verdict line must not
  // claim BLOCKED when everything was demoted.
  assert.doesNotMatch(out, /❌ BLOCKED/);
  // The grace table carries the publish date that justified the demotion.
  assert.match(out, /\| 2026-07-23T00:00:00Z \|/);
});

test("a fully-demoted verdict set is not rendered as a clean scan", () => {
  // Demoted findings still have to be visible — silently reporting "no known
  // advisories" would hide exactly what the diff-aware mode chose not to gate.
  const groups = [{ name: "postcss", ids: ["GHSA-r28c"], score: "7.5" }];
  const v = classify(collectRows(reportWith(groups)), {
    failOn: "high",
    baseline: baselineOf(groups),
  });
  const out = renderSummary(v).join("\n");
  assert.doesNotMatch(out, /no known advisories/);
  assert.match(out, /GHSA-r28c/);
});
