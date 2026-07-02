#!/usr/bin/env node
/**
 * check-coverage-threshold.mjs
 *
 * Optional coverage-floor gate for the shared `pr-quality.yml` reusable
 * workflow (Story #109).
 *
 * `pr-quality.yml` already uploads the `coverage/` tree as a build artifact,
 * but no job asserts a floor — a PR can drop coverage and `ci-required` stays
 * green.
 * The `.agents/` harness ships a CRAP/MI/coverage *ratchet*, but the shared CI
 * workflow itself had no coverage floor an operator could opt into at the
 * workflow layer. This script is that floor: the `unit` job runs it with the
 * `coverage-threshold` workflow input, and a non-zero exit fails the job —
 * which is a `needs:` of `ci-required`.
 *
 * Design constraints:
 *   • OPT-IN. A threshold of 0 (the default) is a no-op: the gate prints a
 *     skip note and exits 0, preserving today's behaviour for non-adopters.
 *   • No new tooling for consumers. The coverage source is the EXISTING
 *     coverage output. We read the standard Istanbul/c8/vitest
 *     `coverage-summary.json` (`total.<metric>.pct`) — the same file the test
 *     runners already emit alongside the artifact upload.
 *   • Dependency-free (no YAML/JSON-schema libs) so it copies cleanly into any
 *     consumer's `scripts/` directory, exactly like the other shared lints.
 *
 * Usage:
 *   node scripts/check-coverage-threshold.mjs --threshold 80
 *   node scripts/check-coverage-threshold.mjs --threshold 80 --metric statements
 *   node scripts/check-coverage-threshold.mjs --threshold 80 --coverage-dir packages/api/coverage
 *
 * Flags:
 *   --threshold <pct>    Minimum coverage percentage (0 disables the gate).
 *   --metric <name>      Which summary metric to assert: lines | statements |
 *                        functions | branches. Default: lines.
 *   --coverage-dir <d>   Override the coverage directory glob root. May be
 *                        repeated. Default: scan the working tree for every
 *                        coverage/coverage-summary.json under it.
 *   --cwd <dir>          Root to resolve coverage paths against. Default: cwd.
 *
 * Exit codes:
 *   0 — gate disabled (threshold 0), or measured coverage ≥ threshold.
 *   1 — measured coverage below the threshold, OR the threshold is set but no
 *       coverage summary could be found / parsed (a set floor must never pass
 *       silently on missing data).
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Pure helpers (exported for the sibling node:test suite)
// ---------------------------------------------------------------------------

export const VALID_METRICS = ["lines", "statements", "functions", "branches"];

/**
 * Assert that a value-taking flag at index `i` is actually followed by a
 * value token. Throws otherwise so a trailing/valueless flag fails loudly
 * instead of falling through to a silent default (e.g. a bare `--threshold`
 * must not leave the gate disabled at threshold 0).
 */
export function requireValue(flag, argv, i) {
  if (argv[i + 1] === undefined) {
    throw new Error(`flag "${flag}" requires a value`);
  }
}

/**
 * Parse the CLI argv (array AFTER `node script.mjs`) into an options object.
 * Throws on a malformed numeric threshold, an unknown metric, an unknown
 * flag, or a valueless value-taking flag so the gate fails loudly rather
 * than silently mis-reading its own configuration.
 */
export function parseArgs(argv) {
  const opts = {
    threshold: 0,
    metric: "lines",
    coverageDirs: [],
    cwd: process.cwd(),
  };
  // Value-taking flags. Each MUST be followed by a value token; a trailing
  // (valueless) occurrence is a hard error rather than a silent skip — a
  // valueless `--threshold` must never leave the gate at its disabled default.
  const VALUE_FLAGS = new Set([
    "--threshold",
    "-t",
    "--metric",
    "-m",
    "--coverage-dir",
    "--cwd",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--threshold" || arg === "-t") {
      requireValue(arg, argv, i);
      opts.threshold = parseThreshold(argv[++i]);
    } else if (arg === "--metric" || arg === "-m") {
      requireValue(arg, argv, i);
      const metric = String(argv[++i]).trim().toLowerCase();
      if (!VALID_METRICS.includes(metric)) {
        throw new Error(
          `unknown --metric "${metric}" (expected one of: ${VALID_METRICS.join(", ")})`
        );
      }
      opts.metric = metric;
    } else if (arg === "--coverage-dir") {
      requireValue(arg, argv, i);
      opts.coverageDirs.push(String(argv[++i]));
    } else if (arg === "--cwd") {
      requireValue(arg, argv, i);
      opts.cwd = String(argv[++i]);
    } else if (arg.startsWith("-")) {
      // An unknown flag (e.g. a typo'd `--threshhold`) MUST fail loudly. Left
      // unhandled it would be silently ignored, leaving `--threshold` at its
      // 0 default and disabling the gate — the exact fail-open we forbid.
      throw new Error(
        `unknown flag "${arg}" (expected one of: ${[...VALUE_FLAGS].join(", ")})`
      );
    } else {
      throw new Error(`unexpected positional argument "${arg}"`);
    }
  }
  return opts;
}

/**
 * Coerce a raw threshold token into a number in [0, 100]. An empty / unset
 * value is treated as 0 (gate off), mirroring the workflow input default.
 * Throws on a non-numeric or out-of-range value.
 */
export function parseThreshold(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return 0;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    throw new Error(`invalid --threshold "${raw}" (must be a number)`);
  }
  if (n < 0 || n > 100) {
    throw new Error(`--threshold ${n} out of range (must be between 0 and 100)`);
  }
  return n;
}

/**
 * Extract `total.<metric>.pct` from a parsed coverage-summary.json object.
 * Returns a finite number, or null when the shape doesn't carry it.
 */
export function extractPct(summary, metric) {
  if (!summary || typeof summary !== "object") return null;
  const total = summary.total;
  if (!total || typeof total !== "object") return null;
  const entry = total[metric];
  if (!entry || typeof entry !== "object") return null;
  const pct = entry.pct;
  return typeof pct === "number" && Number.isFinite(pct) ? pct : null;
}

/**
 * Decide pass/fail for a single measured pct against a threshold. The gate is
 * inclusive: measured === threshold PASSES (a floor of 80 admits exactly 80%).
 */
export function meetsThreshold(pct, threshold) {
  return typeof pct === "number" && Number.isFinite(pct) && pct >= threshold;
}

/**
 * Recursively find every `coverage-summary.json` under `root`, regardless of
 * the name of the directory that directly contains it. `node_modules` and
 * dotted dirs (e.g. `.git`, `.agents`) are pruned so the scan stays fast and
 * never reads a vendored framework tree. `roots` (from `--coverage-dir`)
 * overrides the auto-scan when provided.
 *
 * A directory literally named `coverage` (the common single-workspace shape)
 * is still discovered, but so is a per-workspace fan-out layout where the
 * top-level `coverage/` dir nests differently-named subdirectories per
 * package (e.g. `coverage/web/coverage-summary.json`,
 * `coverage/shared/coverage-summary.json`) — the match condition is "this
 * directory contains a coverage-summary.json file", not "this directory is
 * named coverage".
 */
export function findCoverageSummaries(root, roots = []) {
  if (roots.length > 0) {
    const out = [];
    for (const dir of roots) {
      const abs = resolve(root, dir);
      const file = join(abs, "coverage-summary.json");
      if (existsSync(file)) out.push(file);
    }
    return out;
  }

  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const file = join(dir, "coverage-summary.json");
    if (existsSync(file)) found.push(file);
    for (const entry of entries) {
      const name = entry.name;
      if (!entry.isDirectory()) continue;
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(join(dir, name));
    }
  };
  walk(resolve(root));
  return found;
}

/**
 * Read + parse a coverage-summary.json file. Returns the parsed object, or
 * null on a read / JSON-parse failure (the caller treats this as "no data").
 */
export function readSummary(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Core gate evaluation, decoupled from argv + process so the test suite can
 * drive it directly. Returns a structured verdict:
 *   { ok, skipped, reason, threshold, metric, results: [{ file, pct, ok }] }
 */
export function evaluateGate(opts, { findSummaries = findCoverageSummaries, read = readSummary } = {}) {
  const { threshold, metric, cwd, coverageDirs } = opts;

  if (threshold <= 0) {
    return {
      ok: true,
      skipped: true,
      reason: "threshold 0 — coverage gate disabled (no-op)",
      threshold,
      metric,
      results: [],
    };
  }

  const files = findSummaries(cwd, coverageDirs);
  if (files.length === 0) {
    return {
      ok: false,
      skipped: false,
      reason:
        "coverage threshold is set but no coverage-summary.json was found under " +
        "any **/coverage/ directory — ensure the test step emits a json-summary " +
        "reporter (a set floor must not pass on missing data)",
      threshold,
      metric,
      results: [],
    };
  }

  const results = [];
  for (const file of files) {
    const summary = read(file);
    const pct = extractPct(summary, metric);
    if (pct === null) {
      results.push({ file, pct: null, ok: false });
    } else {
      results.push({ file, pct, ok: meetsThreshold(pct, threshold) });
    }
  }

  const failures = results.filter((r) => !r.ok);
  return {
    ok: failures.length === 0,
    skipped: false,
    reason: failures.length === 0 ? "all coverage summaries meet the floor" : "below floor",
    threshold,
    metric,
    results,
  };
}

/** Render the verdict to human-readable lines for the workflow log. */
export function formatVerdict(verdict) {
  const lines = [];
  if (verdict.skipped) {
    lines.push(`[coverage-threshold] ⏭️  ${verdict.reason}`);
    return lines;
  }
  if (verdict.results.length === 0) {
    lines.push(`[coverage-threshold] ❌ ${verdict.reason}`);
    return lines;
  }
  for (const r of verdict.results) {
    if (r.pct === null) {
      lines.push(
        `[coverage-threshold] ❌ ${r.file}: no "${verdict.metric}" total.pct in summary`
      );
    } else {
      const mark = r.ok ? "✅" : "❌";
      lines.push(
        `[coverage-threshold] ${mark} ${r.file}: ${verdict.metric} ${r.pct}% ` +
        `(floor ${verdict.threshold}%)`
      );
    }
  }
  if (verdict.ok) {
    lines.push(
      `[coverage-threshold] ✅ ${verdict.metric} coverage meets the ${verdict.threshold}% floor.`
    );
  } else {
    lines.push(
      `[coverage-threshold] ❌ ${verdict.metric} coverage is below the ${verdict.threshold}% floor.`
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// CLI entrypoint (skipped under `node --test` import)
// ---------------------------------------------------------------------------

export function runCli(argv, { log = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`[coverage-threshold] ❌ ${e.message}`);
    return 1;
  }

  const verdict = evaluateGate(opts);
  for (const line of formatVerdict(verdict)) {
    (verdict.ok ? log : err)(line);
  }
  return verdict.ok ? 0 : 1;
}

// Only run when executed directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("check-coverage-threshold.mjs");
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
