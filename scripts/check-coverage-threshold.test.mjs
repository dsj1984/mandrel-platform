#!/usr/bin/env node
/**
 * check-coverage-threshold.test.mjs — node:test suite for the optional
 * coverage-floor gate that backs `pr-quality.yml`'s `coverage-threshold`
 * input (Story #109).
 *
 * This is the "equivalent self-test" the Story's acceptance criteria call for:
 * it exercises the gate with the threshold both UNSET (0 → no-op, exit 0) and
 * SET (pass when measured ≥ floor, fail when below, fail when the floor is set
 * but no coverage summary exists). Pure helpers + an injectable summary
 * source keep the whole pipeline offline — no real coverage tree needed.
 *
 * Run: node scripts/check-coverage-threshold.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  VALID_METRICS,
  parseArgs,
  parseThreshold,
  extractPct,
  meetsThreshold,
  findCoverageSummaries,
  readSummary,
  evaluateGate,
  formatVerdict,
  runCli,
  summaryFileKeys,
  commonDirPrefix,
  toRepoRelativeKey,
  normalizeSummary,
  mergeNormalized,
} from "./check-coverage-threshold.mjs";

// Build a minimal Istanbul/c8/vitest-shaped coverage-summary object.
function summary({
  lines = 0,
  statements = 0,
  functions = 0,
  branches = 0,
} = {}) {
  return {
    total: {
      lines: { total: 100, covered: lines, skipped: 0, pct: lines },
      statements: {
        total: 100,
        covered: statements,
        skipped: 0,
        pct: statements,
      },
      functions: { total: 100, covered: functions, skipped: 0, pct: functions },
      branches: { total: 100, covered: branches, skipped: 0, pct: branches },
    },
  };
}

// ---------------------------------------------------------------------------
// parseThreshold
// ---------------------------------------------------------------------------

test("parseThreshold treats empty/unset as 0 (gate off)", () => {
  assert.equal(parseThreshold(""), 0);
  assert.equal(parseThreshold("   "), 0);
  assert.equal(parseThreshold(undefined), 0);
  assert.equal(parseThreshold(null), 0);
});

test("parseThreshold coerces numeric strings", () => {
  assert.equal(parseThreshold("80"), 80);
  assert.equal(parseThreshold("0"), 0);
  assert.equal(parseThreshold("99.5"), 99.5);
});

test("parseThreshold rejects non-numeric and out-of-range values", () => {
  assert.throws(() => parseThreshold("abc"), /must be a number/);
  assert.throws(() => parseThreshold("-1"), /out of range/);
  assert.throws(() => parseThreshold("101"), /out of range/);
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs defaults: threshold 0, metric lines", () => {
  const opts = parseArgs([]);
  assert.equal(opts.threshold, 0);
  assert.equal(opts.metric, "lines");
  assert.deepEqual(opts.coverageDirs, []);
});

test("parseArgs reads --threshold/--metric/--coverage-dir", () => {
  const opts = parseArgs([
    "--threshold",
    "85",
    "--metric",
    "Statements",
    "--coverage-dir",
    "packages/api/coverage",
    "--coverage-dir",
    "packages/web/coverage",
  ]);
  assert.equal(opts.threshold, 85);
  assert.equal(opts.metric, "statements"); // normalized lowercase
  assert.deepEqual(opts.coverageDirs, [
    "packages/api/coverage",
    "packages/web/coverage",
  ]);
});

test("parseArgs rejects an unknown --metric", () => {
  assert.throws(() => parseArgs(["--metric", "nonsense"]), /unknown --metric/);
});

test("parseArgs rejects a valueless --threshold (must not silently disable the gate)", () => {
  // A bare trailing `--threshold` previously fell through and left the
  // threshold at its 0 default — silently turning the gate OFF. It MUST now
  // throw instead.
  assert.throws(() => parseArgs(["--threshold"]), /requires a value/);
  assert.throws(() => parseArgs(["-t"]), /requires a value/);
  // Same for the other value-taking flags.
  assert.throws(() => parseArgs(["--metric"]), /requires a value/);
  assert.throws(() => parseArgs(["--coverage-dir"]), /requires a value/);
  assert.throws(() => parseArgs(["--cwd"]), /requires a value/);
});

test("parseArgs rejects a mistyped/unknown flag rather than ignoring it", () => {
  // A typo like `--threshhold 80` used to be silently dropped, disabling the
  // gate. It MUST now fail loudly.
  assert.throws(() => parseArgs(["--threshhold", "80"]), /unknown flag/);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag/);
});

test("parseArgs rejects unexpected positional arguments", () => {
  assert.throws(() => parseArgs(["80"]), /unexpected positional argument/);
});

test("runCli: a mistyped threshold flag exits non-zero instead of passing silently", () => {
  const out = [];
  const code = runCli(["--threshhold", "80"], {
    log: (m) => out.push(m),
    err: (m) => out.push(m),
  });
  assert.equal(code, 1);
  assert.ok(out.some((l) => /unknown flag/.test(l)));
});

test("runCli: a valueless threshold flag exits non-zero instead of passing silently", () => {
  const out = [];
  const code = runCli(["--threshold"], {
    log: (m) => out.push(m),
    err: (m) => out.push(m),
  });
  assert.equal(code, 1);
  assert.ok(out.some((l) => /requires a value/.test(l)));
});

test("VALID_METRICS covers the four Istanbul totals", () => {
  assert.deepEqual(VALID_METRICS, [
    "lines",
    "statements",
    "functions",
    "branches",
  ]);
});

// ---------------------------------------------------------------------------
// extractPct / meetsThreshold
// ---------------------------------------------------------------------------

test("extractPct pulls total.<metric>.pct", () => {
  const s = summary({ lines: 82, branches: 71 });
  assert.equal(extractPct(s, "lines"), 82);
  assert.equal(extractPct(s, "branches"), 71);
});

test("extractPct returns null for malformed shapes", () => {
  assert.equal(extractPct(null, "lines"), null);
  assert.equal(extractPct({}, "lines"), null);
  assert.equal(extractPct({ total: {} }, "lines"), null);
  assert.equal(extractPct({ total: { lines: {} } }, "lines"), null);
  assert.equal(extractPct({ total: { lines: { pct: "x" } } }, "lines"), null);
});

test("meetsThreshold is inclusive at the floor", () => {
  assert.equal(meetsThreshold(80, 80), true);
  assert.equal(meetsThreshold(80.01, 80), true);
  assert.equal(meetsThreshold(79.99, 80), false);
  assert.equal(meetsThreshold(null, 80), false);
});

// ---------------------------------------------------------------------------
// evaluateGate — threshold UNSET (the non-adopter no-op path)
// ---------------------------------------------------------------------------

test("evaluateGate: threshold 0 is a no-op pass (skipped)", () => {
  const verdict = evaluateGate(
    { threshold: 0, metric: "lines", cwd: ".", coverageDirs: [] },
    {
      // These MUST NOT be consulted when the gate is off.
      findSummaries: () => {
        throw new Error("findSummaries should not run when gate is disabled");
      },
      read: () => {
        throw new Error("read should not run when gate is disabled");
      },
    },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.skipped, true);
  assert.match(verdict.reason, /disabled/);
});

// ---------------------------------------------------------------------------
// evaluateGate — threshold SET
// ---------------------------------------------------------------------------

test("evaluateGate: SET + measured above floor → pass", () => {
  const verdict = evaluateGate(
    { threshold: 80, metric: "lines", cwd: ".", coverageDirs: [] },
    {
      findSummaries: () => ["/x/coverage/coverage-summary.json"],
      read: () => summary({ lines: 91 }),
    },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.skipped, false);
  assert.equal(verdict.results[0].pct, 91);
  assert.equal(verdict.results[0].contributed, true);
  assert.equal(verdict.merged.pct, 91);
});

test("evaluateGate: SET + measured below floor → fail", () => {
  const verdict = evaluateGate(
    { threshold: 80, metric: "lines", cwd: ".", coverageDirs: [] },
    {
      findSummaries: () => ["/x/coverage/coverage-summary.json"],
      read: () => summary({ lines: 73 }),
    },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.results[0].pct, 73);
  assert.equal(verdict.merged.pct, 73);
});

test("evaluateGate: SET but no coverage summary found → fail (never silent-pass)", () => {
  const verdict = evaluateGate(
    { threshold: 80, metric: "lines", cwd: ".", coverageDirs: [] },
    {
      findSummaries: () => [],
      read: () => null,
    },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.skipped, false);
  assert.match(verdict.reason, /no coverage-summary\.json was found/);
});

test("evaluateGate: SET, many packages — the floor is one merged number, not a per-summary AND", () => {
  // 95/100 + 40/100 = 135/200 = 67.5%, below the 80 floor. Both summaries are
  // still REPORTED as contributions (the log names which artifact carried
  // what) but neither is asserted on its own.
  const verdict = evaluateGate(
    { threshold: 80, metric: "statements", cwd: ".", coverageDirs: [] },
    {
      findSummaries: () => [
        "a/coverage/coverage-summary.json",
        "b/coverage/coverage-summary.json",
      ],
      read: (f) =>
        f.startsWith("a")
          ? summary({ statements: 95 })
          : summary({ statements: 40 }),
    },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.results.length, 2);
  assert.equal(verdict.merged.covered, 135);
  assert.equal(verdict.merged.total, 200);
  assert.equal(verdict.merged.pct, 67.5);
  assert.ok(
    verdict.results.every((r) => r.contributed),
    "both summaries must be reported as contributions",
  );
});

// ---------------------------------------------------------------------------
// findCoverageSummaries / readSummary — real filesystem
// ---------------------------------------------------------------------------

test("findCoverageSummaries auto-scans **/coverage/, pruning node_modules + dotted dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-"));
  try {
    // A real package coverage dir.
    mkdirSync(join(root, "packages", "api", "coverage"), { recursive: true });
    writeFileSync(
      join(root, "packages", "api", "coverage", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 88 })),
    );
    // A decoy under node_modules that MUST be pruned.
    mkdirSync(join(root, "node_modules", "dep", "coverage"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "node_modules", "dep", "coverage", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 1 })),
    );
    // A decoy under a dotted dir that MUST be pruned.
    mkdirSync(join(root, ".agents", "coverage"), { recursive: true });
    writeFileSync(
      join(root, ".agents", "coverage", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 2 })),
    );

    const files = findCoverageSummaries(root);
    assert.equal(files.length, 1);
    assert.match(
      files[0],
      /packages[/\\]api[/\\]coverage[/\\]coverage-summary\.json$/,
    );

    const parsed = readSummary(files[0]);
    assert.equal(extractPct(parsed, "lines"), 88);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findCoverageSummaries discovers a per-workspace fan-out layout (coverage/<workspace>/coverage-summary.json)", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-"));
  try {
    // domio's shape: top-level coverage/ dir nests per-workspace subdirs that
    // are NOT themselves named "coverage".
    mkdirSync(join(root, "coverage", "web"), { recursive: true });
    writeFileSync(
      join(root, "coverage", "web", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 77 })),
    );
    mkdirSync(join(root, "coverage", "shared"), { recursive: true });
    writeFileSync(
      join(root, "coverage", "shared", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 93 })),
    );
    // Decoys that must still be pruned.
    mkdirSync(join(root, "node_modules", "dep", "coverage"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "node_modules", "dep", "coverage", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 1 })),
    );
    mkdirSync(join(root, ".agents", "coverage"), { recursive: true });
    writeFileSync(
      join(root, ".agents", "coverage", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 2 })),
    );

    const files = findCoverageSummaries(root).sort();
    assert.equal(files.length, 2);
    assert.ok(
      files.some((f) =>
        /coverage[/\\]shared[/\\]coverage-summary\.json$/.test(f),
      ),
    );
    assert.ok(
      files.some((f) => /coverage[/\\]web[/\\]coverage-summary\.json$/.test(f)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findCoverageSummaries honours explicit --coverage-dir roots", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-"));
  try {
    mkdirSync(join(root, "custom", "cov"), { recursive: true });
    writeFileSync(
      join(root, "custom", "cov", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 90 })),
    );
    const files = findCoverageSummaries(root, ["custom/cov"]);
    assert.equal(files.length, 1);
    assert.match(files[0], /custom[/\\]cov[/\\]coverage-summary\.json$/);

    // A non-existent override yields nothing (the gate then fails as "no data").
    assert.deepEqual(findCoverageSummaries(root, ["does/not/exist"]), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSummary returns null on unreadable / malformed JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-"));
  try {
    const bad = join(root, "coverage-summary.json");
    writeFileSync(bad, "{ not valid json");
    assert.equal(readSummary(bad), null);
    assert.equal(readSummary(join(root, "missing.json")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runCli — end-to-end exit codes (threshold both unset and set)
// ---------------------------------------------------------------------------

test("runCli: threshold unset → exit 0 (preserves non-adopter behaviour)", () => {
  const out = [];
  const code = runCli([], { log: (m) => out.push(m), err: (m) => out.push(m) });
  assert.equal(code, 0);
  assert.ok(out.some((l) => /disabled/.test(l)));
});

test("runCli: threshold set, real passing coverage tree → exit 0", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-"));
  try {
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 95 })),
    );
    const out = [];
    const code = runCli(["--threshold", "80", "--cwd", root], {
      log: (m) => out.push(m),
      err: (m) => out.push(m),
    });
    assert.equal(code, 0);
    assert.ok(out.some((l) => /meets the 80% floor/.test(l)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCli: threshold set, real failing coverage tree → exit 1", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-"));
  try {
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 50 })),
    );
    const out = [];
    const code = runCli(["--threshold", "80", "--cwd", root], {
      log: (m) => out.push(m),
      err: (m) => out.push(m),
    });
    assert.equal(code, 1);
    assert.ok(out.some((l) => /below the 80% floor/.test(l)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCli: threshold set but no coverage data → exit 1", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-"));
  try {
    const out = [];
    const code = runCli(["--threshold", "80", "--cwd", root], {
      log: (m) => out.push(m),
      err: (m) => out.push(m),
    });
    assert.equal(code, 1);
    assert.ok(out.some((l) => /no coverage-summary\.json was found/.test(l)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatVerdict renders a skip line for the disabled gate", () => {
  const lines = formatVerdict({
    ok: true,
    skipped: true,
    reason: "threshold 0 — coverage gate disabled (no-op)",
    threshold: 0,
    metric: "lines",
    results: [],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /⏭️/);
});

// ---------------------------------------------------------------------------
// Merged measurement (Story #468)
//
// The floor used to be a logical AND across per-workspace summaries, which
// made it an artifact of which JOB ran which tests: a scoped tier's summary is
// a partial measurement of the repo, and every shard of a sharded tier
// false-failed on its own subset. These tests pin the union semantics and the
// lower-bound property that makes the union safe to assert.
// ---------------------------------------------------------------------------

// A coverage-summary.json with real per-file entries: { "<abs path>": pct-ish
// counts }, plus the `total` block json-summary always writes.
function fileSummary(entries, metric = "lines") {
  const out = {};
  let covered = 0;
  let total = 0;
  for (const [path, counts] of Object.entries(entries)) {
    covered += counts.covered;
    total += counts.total;
    out[path] = {
      [metric]: {
        total: counts.total,
        covered: counts.covered,
        skipped: 0,
        pct: (counts.covered / counts.total) * 100,
      },
    };
  }
  out.total = {
    [metric]: {
      total,
      covered,
      skipped: 0,
      pct: total > 0 ? (covered / total) * 100 : 0,
    },
  };
  return out;
}

/** An `exists` stub that answers true only for a known set of repo-relative paths. */
function existsIn(relPaths, cwd = "/repo") {
  const known = new Set(relPaths.map((r) => join(cwd, r)));
  return (candidate) => known.has(candidate);
}

test("summaryFileKeys returns per-file entries and never `total`", () => {
  const sum = fileSummary({ "/ws/src/a.ts": { covered: 5, total: 10 } });
  assert.deepEqual(summaryFileKeys(sum), ["/ws/src/a.ts"]);
  assert.deepEqual(summaryFileKeys(null), []);
});

test("commonDirPrefix excludes the filename, so a single entry yields its directory", () => {
  assert.equal(commonDirPrefix(["/ws/repo/src/a.ts"]), "/ws/repo/src/");
  assert.equal(commonDirPrefix(["/ws/repo/src/a.ts", "/ws/repo/api/b.ts"]), "/ws/repo/");
  assert.equal(commonDirPrefix([]), "");
});

test("toRepoRelativeKey anchors on the checkout — different workspace roots normalize alike", () => {
  const exists = existsIn(["src/foo.ts"]);
  // Two tiers, two runner workspace roots, one source file.
  assert.equal(
    toRepoRelativeKey("/actions-runner/_work/repo/repo/src/foo.ts", { exists, cwd: "/repo" }),
    "src/foo.ts",
  );
  assert.equal(
    toRepoRelativeKey("/srv/runner2/_work/repo/repo/src/foo.ts", { exists, cwd: "/repo" }),
    "src/foo.ts",
  );
});

test("toRepoRelativeKey returns null when nothing resolves against the checkout", () => {
  const exists = existsIn(["src/foo.ts"]);
  assert.equal(toRepoRelativeKey("/ws/generated/nope.ts", { exists, cwd: "/repo" }), null);
  assert.equal(toRepoRelativeKey("", { exists, cwd: "/repo" }), null);
});

test("mergeNormalized: disjoint files sum — aggregate is sum(covered)/sum(total)", () => {
  const exists = existsIn(["src/a.ts", "api/b.ts"]);
  const opts = { exists, cwd: "/repo" };
  const unit = normalizeSummary(
    fileSummary({ "/ws/repo/src/a.ts": { covered: 90, total: 100 } }),
    "lines",
    opts,
  );
  const contract = normalizeSummary(
    fileSummary({ "/ws/repo/api/b.ts": { covered: 30, total: 100 } }),
    "lines",
    opts,
  );
  const merged = mergeNormalized([unit, contract]);
  assert.equal(merged.covered, 120);
  assert.equal(merged.total, 200);
  assert.equal(merged.pct, 60);
  assert.equal(merged.fileCount, 2);
});

test("mergeNormalized: an overlapping file takes MAX(covered), never the sum (the lower-bound property)", () => {
  const exists = existsIn(["src/shared.ts"]);
  const opts = { exists, cwd: "/repo" };
  const unit = normalizeSummary(
    fileSummary({ "/ws/repo/src/shared.ts": { covered: 40, total: 100 } }),
    "lines",
    opts,
  );
  const contract = normalizeSummary(
    fileSummary({ "/ws/repo/src/shared.ts": { covered: 70, total: 100 } }),
    "lines",
    opts,
  );
  const merged = mergeNormalized([unit, contract]);
  // Summing would give 110/200 — and 110 covered lines in a 100-line file is
  // not a measurement, it is an artifact. max() is a lower bound on the union.
  assert.equal(merged.covered, 70);
  assert.equal(merged.total, 100);
  assert.equal(merged.pct, 70);
  assert.equal(merged.fileCount, 1, "the shared file must merge into ONE entry");
});

test("normalizeSummary: mixed-depth tiers still merge the same file into one entry", () => {
  // The unit tier spans the repo; the contract tier is scoped to packages/api.
  // Their own longest-common-dir prefixes differ in DEPTH, so prefix-relative
  // keys alone would disagree ("packages/api/src/db.ts" vs "src/db.ts") and
  // double-count the shared file. Anchoring on the checkout resolves both.
  const exists = existsIn(["packages/web/src/ui.ts", "packages/api/src/db.ts"]);
  const opts = { exists, cwd: "/repo" };
  const unit = normalizeSummary(
    fileSummary({
      "/ws/repo/packages/web/src/ui.ts": { covered: 80, total: 100 },
      "/ws/repo/packages/api/src/db.ts": { covered: 10, total: 100 },
    }),
    "lines",
    opts,
  );
  const contract = normalizeSummary(
    fileSummary({ "/ws/repo/packages/api/src/db.ts": { covered: 95, total: 100 } }),
    "lines",
    opts,
  );
  assert.equal(contract.files.size, 1);
  assert.ok(contract.files.has("packages/api/src/db.ts"));
  const merged = mergeNormalized([unit, contract]);
  assert.equal(merged.fileCount, 2, "the shared file must not double-count");
  assert.equal(merged.covered, 175, "80 + max(10, 95)");
  assert.equal(merged.total, 200);
});

test("normalizeSummary counts keys it could not resolve against the checkout", () => {
  const exists = existsIn(["src/a.ts"]);
  const part = normalizeSummary(
    fileSummary({
      "/ws/repo/src/a.ts": { covered: 5, total: 10 },
      "/ws/repo/dist/generated.js": { covered: 1, total: 10 },
    }),
    "lines",
    { exists, cwd: "/repo" },
  );
  assert.equal(part.unresolved, 1);
  assert.equal(part.files.size, 2, "an unresolved key still contributes, via the prefix fallback");
});

test("evaluateGate: a weighted merge PASSES where the old per-summary AND failed", () => {
  // 900/1000 (90%) + 70/100 (70%) = 970/1100 = 88.18%, above an 80 floor.
  // Under the old AND the 70% summary alone red the gate — which is exactly
  // the false-fail that forced a consumer to keep its whole suite in one tier.
  const exists = existsIn(["src/big.ts", "api/small.ts"]);
  const verdict = evaluateGate(
    { threshold: 80, metric: "lines", cwd: "/repo", coverageDirs: [] },
    {
      exists,
      findSummaries: () => ["unit/coverage/coverage-summary.json", "contract/coverage/coverage-summary.json"],
      read: (f) =>
        f.startsWith("unit")
          ? fileSummary({ "/ws/repo/src/big.ts": { covered: 900, total: 1000 } })
          : fileSummary({ "/ws/repo/api/small.ts": { covered: 70, total: 100 } }),
    },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.merged.covered, 970);
  assert.equal(verdict.merged.total, 1100);
  assert.equal(Math.round(verdict.merged.pct * 100) / 100, 88.18);
});

test("evaluateGate: equal-weight 85% + 70% against an 80 floor fails on the weighted number (77.5%)", () => {
  const exists = existsIn(["src/a.ts", "api/b.ts"]);
  const verdict = evaluateGate(
    { threshold: 80, metric: "lines", cwd: "/repo", coverageDirs: [] },
    {
      exists,
      findSummaries: () => ["a/coverage/coverage-summary.json", "b/coverage/coverage-summary.json"],
      read: (f) =>
        f.startsWith("a")
          ? fileSummary({ "/ws/repo/src/a.ts": { covered: 85, total: 100 } })
          : fileSummary({ "/ws/repo/api/b.ts": { covered: 70, total: 100 } }),
    },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.merged.pct, 77.5);
});

test("evaluateGate: a sharded tier's partial summaries merge instead of each false-failing", () => {
  // Two shards of ONE tier, each measuring only the files its shard ran.
  // Asserted individually both sit at 50%; merged they are the repo's 90%.
  const exists = existsIn(["src/a.ts", "src/b.ts"]);
  const verdict = evaluateGate(
    { threshold: 80, metric: "lines", cwd: "/repo", coverageDirs: [] },
    {
      exists,
      findSummaries: () => ["unit-results-1/coverage/coverage-summary.json", "unit-results-2/coverage/coverage-summary.json"],
      read: (f) =>
        f.includes("unit-results-1")
          ? fileSummary({
              "/ws/repo/src/a.ts": { covered: 90, total: 100 },
              "/ws/repo/src/b.ts": { covered: 10, total: 100 },
            })
          : fileSummary({
              "/ws/repo/src/a.ts": { covered: 10, total: 100 },
              "/ws/repo/src/b.ts": { covered: 90, total: 100 },
            }),
    },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.merged.covered, 180, "max per file across shards: 90 + 90");
  assert.equal(verdict.merged.pct, 90);
});

test("evaluateGate: summaries carrying only a `total` block still contribute (no silent vanish)", () => {
  const verdict = evaluateGate(
    { threshold: 80, metric: "lines", cwd: "/repo", coverageDirs: [] },
    {
      exists: () => false,
      findSummaries: () => ["a/coverage/coverage-summary.json"],
      read: () => summary({ lines: 91 }),
    },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.merged.covered, 91);
  assert.equal(verdict.merged.total, 100);
  assert.equal(verdict.results[0].contributed, true);
});

test("evaluateGate: a set floor with summaries that carry no readable counts still FAILS", () => {
  const verdict = evaluateGate(
    { threshold: 80, metric: "lines", cwd: "/repo", coverageDirs: [] },
    {
      exists: () => false,
      findSummaries: () => ["a/coverage/coverage-summary.json"],
      read: () => ({ total: { branches: { total: 1, covered: 1, pct: 100 } } }),
    },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /could be read from/);
});

test("formatVerdict names each contributing artifact and the merged total", () => {
  const exists = existsIn(["src/a.ts", "api/b.ts"]);
  const verdict = evaluateGate(
    { threshold: 80, metric: "lines", cwd: "/repo", coverageDirs: [] },
    {
      exists,
      findSummaries: () => ["unit-results-1/coverage/coverage-summary.json", "contract-results-1/coverage/coverage-summary.json"],
      read: (f) =>
        f.startsWith("unit")
          ? fileSummary({ "/ws/repo/src/a.ts": { covered: 90, total: 100 } })
          : fileSummary({ "/ws/repo/api/b.ts": { covered: 80, total: 100 } }),
    },
  );
  const out = formatVerdict(verdict).join("\n");
  assert.match(out, /unit-results-1\/coverage\/coverage-summary\.json/);
  assert.match(out, /contract-results-1\/coverage\/coverage-summary\.json/);
  assert.match(out, /merged across 2 summary\(ies\)/);
  assert.match(out, /170\/200/);
});

// ---------------------------------------------------------------------------
// pr-quality.yml Coverage threshold gate — workflow-step parity (#163, #230)
//
// The workflow's "Coverage threshold gate" step no longer embeds a copy of
// this script (Story #230): it sparse-side-checkouts mandrel-platform at
// `job.workflow_sha` into `_mandrel-platform-scripts/` and runs
// `scripts/check-coverage-threshold.mjs` directly. These tests exercise that
// exact invocation shape — the real script, run from the side-checkout path,
// with the workflow's `--threshold` / `--metric` args and the consumer
// checkout as cwd — against real fixture trees, so the original #163 bug
// (matching a directory literally named `coverage`, missing
// `coverage/<workspace>/coverage-summary.json`) still cannot regress, and a
// drift between "what the workflow runs" and "what these tests run" is
// structurally impossible.
// ---------------------------------------------------------------------------

const WORKFLOW_FILE = join(__dirname, "..", ".github", "workflows", "pr-quality.yml");
const GATE_SCRIPT = join(__dirname, "check-coverage-threshold.mjs");

// Mirror the workflow step: materialize the side-checkout layout
// (`_mandrel-platform-scripts/scripts/check-coverage-threshold.mjs`) inside
// the fixture tree, then run the script exactly as the workflow does.
function runGateStep(treeRoot, { threshold = "0", metric = "lines" } = {}) {
  const sideCheckout = join(treeRoot, "_mandrel-platform-scripts", "scripts");
  mkdirSync(sideCheckout, { recursive: true });
  writeFileSync(
    join(sideCheckout, "check-coverage-threshold.mjs"),
    readFileSync(GATE_SCRIPT, "utf8"),
  );
  try {
    const stdout = execFileSync(
      "node",
      [
        join("_mandrel-platform-scripts", "scripts", "check-coverage-threshold.mjs"),
        "--threshold",
        threshold,
        "--metric",
        metric,
      ],
      { cwd: treeRoot, env: { ...process.env }, encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

test("pr-quality.yml runs the side-checkout script — no inline coverage heredoc remains (#230)", () => {
  const yaml = readFileSync(WORKFLOW_FILE, "utf8");
  // The gate step invokes the platform script from the side-checkout…
  assert.match(
    yaml,
    /node _mandrel-platform-scripts\/scripts\/check-coverage-threshold\.mjs/,
    "the Coverage threshold gate must run scripts/check-coverage-threshold.mjs from the side-checkout",
  );
  // …and the migration guard does the same.
  assert.match(
    yaml,
    /node _mandrel-platform-scripts\/scripts\/check-destructive-migration\.mjs/,
    "the migration guard must run scripts/check-destructive-migration.mjs from the side-checkout",
  );
  // The old inlined coverage-discovery copy (the #163 drift class) is gone.
  assert.doesNotMatch(
    yaml,
    /findCoverageSummaries|intentionally duplicated|keep the two in sync/i,
    "no inlined copy of the coverage gate may remain in pr-quality.yml",
  );
});

test("pr-quality gate step discovers a per-workspace coverage/<ws>/ layout (#163 regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-step-fanout-"));
  try {
    // Per-workspace fan-out: NO top-level coverage/coverage-summary.json,
    // only coverage/web/ and coverage/shared/ — the exact shape that the
    // pre-#158 literal-`coverage`-name match missed.
    mkdirSync(join(dir, "coverage", "web"), { recursive: true });
    mkdirSync(join(dir, "coverage", "shared"), { recursive: true });
    writeFileSync(
      join(dir, "coverage", "web", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 95 })),
    );
    writeFileSync(
      join(dir, "coverage", "shared", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 90 })),
    );

    const res = runGateStep(dir, { threshold: "80", metric: "lines" });
    assert.equal(
      res.status,
      0,
      `gate step should PASS on the fan-out layout, got exit ${res.status}\n${res.stderr}`,
    );
    // Both per-workspace summaries were discovered and gated — not the
    // "no coverage-summary.json was found" false failure.
    assert.doesNotMatch(res.stderr, /no coverage-summary\.json/);
    assert.match(res.stdout, /coverage[/\\]web[/\\]coverage-summary\.json/);
    assert.match(res.stdout, /coverage[/\\]shared[/\\]coverage-summary\.json/);
    assert.match(res.stdout, /coverage meets the 80% floor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr-quality gate step: per-workspace summary below floor fails (#163 regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-step-fanout-fail-"));
  try {
    mkdirSync(join(dir, "coverage", "web"), { recursive: true });
    writeFileSync(
      join(dir, "coverage", "web", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 40 })),
    );
    const res = runGateStep(dir, { threshold: "80", metric: "lines" });
    assert.equal(
      res.status,
      1,
      "below-floor per-workspace coverage must fail the gate",
    );
    assert.match(res.stderr, /coverage[/\\]web[/\\]coverage-summary\.json/);
    assert.match(res.stderr, /below the 80% floor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr-quality gate step stays byte-for-byte compatible with the single coverage/ dir shape (#163)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-step-single-"));
  try {
    // Legacy single-workspace shape: coverage/coverage-summary.json directly.
    mkdirSync(join(dir, "coverage"), { recursive: true });
    writeFileSync(
      join(dir, "coverage", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 88 })),
    );
    // node_modules + dotted dirs must still be pruned (never read a vendored
    // coverage tree).
    mkdirSync(join(dir, "node_modules", "pkg", "coverage"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "node_modules", "pkg", "coverage", "coverage-summary.json"),
      JSON.stringify(summary({ lines: 1 })),
    );
    const res = runGateStep(dir, { threshold: "80", metric: "lines" });
    assert.equal(
      res.status,
      0,
      `single-dir shape should PASS, got exit ${res.status}\n${res.stderr}`,
    );
    assert.match(res.stdout, /coverage[/\\]coverage-summary\.json/);
    assert.doesNotMatch(res.stdout, /node_modules/);
    assert.doesNotMatch(res.stderr, /node_modules/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr-quality gate step still hard-fails when threshold set but no summary exists (#163)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-step-empty-"));
  try {
    const res = runGateStep(dir, { threshold: "80", metric: "lines" });
    assert.equal(res.status, 1, "a set floor must not pass on missing data");
    assert.match(res.stderr, /no coverage-summary\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
