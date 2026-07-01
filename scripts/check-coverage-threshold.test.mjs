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
  assert.equal(verdict.results[0].ok, true);
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
  assert.equal(verdict.results[0].ok, false);
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

test("evaluateGate: SET, one of many packages below floor → fail", () => {
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
  assert.equal(verdict.results.find((r) => r.file.startsWith("a")).ok, true);
  assert.equal(verdict.results.find((r) => r.file.startsWith("b")).ok, false);
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
// pr-quality.yml Coverage threshold gate — inline step regression (#163)
//
// The workflow step embeds its OWN copy of the discovery logic (it must stay
// dependency-free for consumer checkouts that have not adopted
// check-coverage-threshold.mjs). #158 fixed only the standalone script; this
// suite's `findCoverageSummaries` tests above cannot catch a regression in the
// workflow file's embedded JS. These tests extract that embedded node script
// straight out of pr-quality.yml and run it against real fixture trees, so the
// exact #163 bug (matching a directory literally named `coverage`, missing
// `coverage/<workspace>/coverage-summary.json`) cannot survive a refactor.
// ---------------------------------------------------------------------------

// Pull the embedded `node --input-type=module - <<'NODE' … NODE` script body
// out of the "Coverage threshold gate" step, de-indenting the YAML block
// scalar so it runs as a standalone ES module.
function extractGateScript() {
  const yaml = readFileSync(
    join(__dirname, "..", ".github", "workflows", "pr-quality.yml"),
    "utf8",
  );
  const lines = yaml.split(/\r?\n/);
  const startIdx = lines.findIndex((l) =>
    /node --input-type=module - <<'NODE'\s*$/.test(l),
  );
  assert.ok(
    startIdx !== -1,
    "expected an embedded `<<'NODE'` heredoc in pr-quality.yml",
  );
  // The heredoc opener carries the block-scalar indent; every body line shares
  // at least that indent, and the closing `NODE` sentinel sits at the same
  // indent. Strip it uniformly.
  const indent = lines[startIdx].match(/^(\s*)/)[1];
  const body = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "NODE") return body.join("\n");
    body.push(
      lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i],
    );
  }
  throw new Error("unterminated `NODE` heredoc in pr-quality.yml gate step");
}

// Run the extracted gate script with COVERAGE_THRESHOLD / COVERAGE_METRIC set
// and cwd pointed at `treeRoot`. Returns { status, stdout, stderr }.
function runGateStep(treeRoot, { threshold = "0", metric = "lines" } = {}) {
  const scriptPath = join(treeRoot, "__gate-step.mjs");
  writeFileSync(scriptPath, extractGateScript());
  try {
    const stdout = execFileSync("node", [scriptPath], {
      cwd: treeRoot,
      env: {
        ...process.env,
        COVERAGE_THRESHOLD: threshold,
        COVERAGE_METRIC: metric,
      },
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

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
