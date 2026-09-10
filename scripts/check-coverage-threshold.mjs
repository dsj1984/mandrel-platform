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
 * workflow layer. This script is that floor: the `coverage-floor` job runs it
 * with the `coverage-threshold` workflow input, and a non-zero exit fails the
 * job — which is a `needs:` of `ci-required`.
 *
 * MERGED MEASUREMENT (Story #468). The gate used to assert every discovered
 * `coverage-summary.json` INDEPENDENTLY — a logical AND across per-workspace
 * summaries. That made the floor an artifact of which job happened to run
 * which tests: it false-failed every shard of a sharded tier (each shard
 * measures its own subset), and it forced a consumer to keep its whole suite
 * in the one tier the gate could see, because a scoped tier's summary is a
 * partial measurement of the repo. The gate now UNIONS every summary it finds
 * into one measurement and asserts the floor once.
 *
 * Two tiers can exercise the same source file, and a summary records how MANY
 * lines each covered, never WHICH — so the true union is not recoverable from
 * counts. Overlap therefore resolves as per-file `max(covered)`, which is a
 * provable LOWER BOUND on the union: the merged number can only understate
 * real coverage, so the floor may false-fail and can never false-pass. Tiers
 * scoped to disjoint projects — the case this exists for — overlap on nothing
 * and merge exactly.
 *
 * That never-false-pass claim rests on TWO invariants the gate now enforces
 * outright (Story #489), because each was violable on its own:
 *
 *   1. A file is counted ONCE. `max(covered)` only applies to entries that
 *      merged under the SAME key, so any normalization that gives one file two
 *      keys turns the max into a SUM — which inflates the aggregate and lets
 *      the floor false-pass, the exact failure the paragraph above rules out.
 *      Keys that resolve against the checkout were always safe; keys that do
 *      not (a generated or since-deleted file) fall back to prefix-stripping,
 *      and that prefix is now computed ONCE across every summary rather than
 *      per summary — see `sharedDirPrefix`. Anything still unresolved after
 *      that is NAMED in the verdict, so a residual double-count is visible
 *      rather than silent.
 *   2. The percentage is EXACT at every integer. `(covered * 100) / total`,
 *      never `(covered / total) * 100` — see `mergeNormalized`. The floor
 *      compare is inclusive, so a boundary run must land exactly on the floor
 *      rather than a rounding step below it, and the printed number must be
 *      the number the decision was made on (`formatPctForVerdict`).
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
 *   1 — merged coverage below the threshold, OR the threshold is set but no
 *       coverage summary could be found / parsed (a set floor must never pass
 *       silently on missing data).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
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
 * Render a measured pct for the log at the LOWEST precision that still agrees
 * with the decision `meetsThreshold` made on it.
 *
 * A verdict that prints "57% (floor 57%)" and then fails is not a report, it
 * is a contradiction — and rounding for readability is what manufactures one:
 * 56.999% displayed at 2dp is "57". So the displayed value is widened until
 * its side of the floor matches the real one, and only then printed.
 */
export function formatPctForVerdict(pct, threshold) {
  const met = meetsThreshold(pct, threshold);
  for (const digits of [2, 4, 6]) {
    const factor = 10 ** digits;
    const rounded = Math.round(pct * factor) / factor;
    if ((rounded >= threshold) === met) return String(rounded);
  }
  return String(pct);
}

/**
 * The per-file keys of a coverage-summary.json (everything but `total`).
 * json-summary emits one entry per source file, keyed by the ABSOLUTE path it
 * had in the workspace that produced it.
 */
export function summaryFileKeys(summary) {
  if (!summary || typeof summary !== "object") return [];
  return Object.keys(summary).filter(
    (k) => k !== "total" && summary[k] && typeof summary[k] === "object"
  );
}

/**
 * Longest common DIRECTORY prefix of a key list (trailing slash included, or
 * "" when there is none). Filenames are excluded from the comparison so a
 * single-entry summary yields its own directory rather than the file itself.
 *
 * This is the FALLBACK normalizer only — see `toRepoRelativeKey`. Feed it the
 * keys of EVERY summary at once (`sharedDirPrefix`), never one summary's keys:
 * two tiers whose file sets bottom out at different depths (one scoped to
 * `packages/api`, one spanning the repo) produce prefixes of different lengths,
 * so the same file normalizes to two different keys and the union
 * double-counts it.
 */
export function commonDirPrefix(keys) {
  const lists = keys.map((k) => String(k).replace(/\\/g, "/").split("/").slice(0, -1));
  if (lists.length === 0) return "";
  let prefix = lists[0];
  for (let i = 1; i < lists.length; i++) {
    const other = lists[i];
    let n = 0;
    while (n < prefix.length && n < other.length && prefix[n] === other[n]) n++;
    prefix = prefix.slice(0, n);
  }
  return prefix.length > 0 ? prefix.join("/") + "/" : "";
}

/**
 * The ONE prefix every summary's unresolved keys are stripped against: the
 * longest common directory prefix over the union of every summary's file keys.
 *
 * Computing this per summary is the double-count bug: the prefix is a function
 * of the key set it is given, so a repo-spanning tier and a `packages/api`
 * tier strip different amounts from the SAME absolute path and the file lands
 * under two keys, which `mergeNormalized` sums instead of maxing. One prefix
 * across all summaries strips the same amount everywhere, so the file merges.
 */
export function sharedDirPrefix(summaries) {
  const keys = [];
  for (const summary of summaries) keys.push(...summaryFileKeys(summary));
  return commonDirPrefix(keys);
}

/**
 * Normalize one absolute coverage key to a repo-relative path, ANCHORED ON
 * THE CHECKOUT rather than on the key list's own shape: walk the key's
 * segments left-to-right and return the first (longest) suffix that resolves
 * to a real path under `cwd`.
 *
 * This is what lets two tiers' summaries merge when they were produced under
 * different workspace roots — a self-hosted fleet where one job ran under
 * `/actions-runner/_work/repo/repo` and another under `/srv/runner2/_work/repo/repo`
 * still normalizes both to `src/foo.ts`. Anchoring on the checkout also avoids
 * the mixed-depth failure `commonDirPrefix` has on its own.
 *
 * Returns null when nothing resolves (a generated or since-deleted file); the
 * caller falls back to the prefix form and counts it.
 */
export function toRepoRelativeKey(key, { exists = existsSync, cwd = process.cwd() } = {}) {
  if (typeof key !== "string" || key.trim() === "") return null;
  const norm = key.replace(/\\/g, "/");
  const absolute = norm.startsWith("/") || /^[A-Za-z]:\//.test(norm);
  if (!absolute) return norm.replace(/^\.\//, "");
  const segs = norm.split("/").filter((seg) => seg !== "" && !/^[A-Za-z]:$/.test(seg));
  for (let i = 0; i < segs.length; i++) {
    const candidate = segs.slice(i).join("/");
    if (exists(join(cwd, candidate))) return candidate;
  }
  return null;
}

/**
 * Reduce one parsed summary to the per-file {covered, total} counts for
 * `metric`, keyed by normalized path.
 *
 * `prefix` is the SHARED prefix from `sharedDirPrefix`, computed once across
 * every summary in the run. It defaults to "" — meaning an unresolved key is
 * kept whole — rather than to this summary's own prefix, so a caller that
 * forgets to thread it through under-merges (two long keys) instead of
 * silently reintroducing the per-summary double-count.
 *
 * A summary carrying ONLY a `total` block (no per-file entries) cannot be
 * merged per file, so it is kept as an OPAQUE contribution keyed by nothing —
 * its counts are added to the aggregate whole. That can double-count a file
 * two such summaries share, which is why json-summary's per-file output is the
 * supported shape; the opaque path exists so a reduced summary degrades to
 * today's arithmetic rather than vanishing from the measurement.
 */
export function normalizeSummary(
  summary,
  metric,
  { exists = existsSync, cwd = process.cwd(), prefix = "" } = {}
) {
  const files = new Map();
  const unresolvedKeys = [];
  let unresolved = 0;
  const keys = summaryFileKeys(summary);

  if (keys.length === 0) {
    const total = summary && typeof summary === "object" ? summary.total : null;
    const entry = total && typeof total === "object" ? total[metric] : null;
    const covered = entry && Number.isFinite(entry.covered) ? entry.covered : null;
    const denom = entry && Number.isFinite(entry.total) ? entry.total : null;
    return {
      files,
      unresolved,
      unresolvedKeys,
      opaque: covered !== null && denom !== null ? { covered, total: denom } : null,
    };
  }

  for (const key of keys) {
    const entry = summary[key][metric];
    if (!entry || !Number.isFinite(entry.covered) || !Number.isFinite(entry.total)) continue;
    let normalized = toRepoRelativeKey(key, { exists, cwd });
    if (normalized === null) {
      unresolved += 1;
      const raw = String(key).replace(/\\/g, "/");
      normalized = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
      unresolvedKeys.push(normalized);
    }
    const prev = files.get(normalized);
    files.set(
      normalized,
      prev
        ? {
            // MAX, never sum. Two tiers exercising the same file report how
            // MANY lines each covered, never WHICH — so the true union is
            // unknowable from counts alone. max() is a provable lower bound on
            // it (the union is at least the larger contribution), which keeps
            // the floor able to false-fail but never to false-pass.
            covered: Math.max(prev.covered, entry.covered),
            total: Math.max(prev.total, entry.total),
          }
        : { covered: entry.covered, total: entry.total }
    );
  }
  return { files, unresolved, unresolvedKeys, opaque: null };
}

/**
 * Union a list of normalized summaries into ONE measurement:
 * `sum(covered) / sum(total) * 100` over the merged per-file map.
 */
export function mergeNormalized(parts) {
  const files = new Map();
  const unresolvedKeys = new Set();
  let covered = 0;
  let total = 0;

  for (const part of parts) {
    for (const key of part.unresolvedKeys || []) unresolvedKeys.add(key);
    for (const [key, value] of part.files) {
      const prev = files.get(key);
      files.set(
        key,
        prev
          ? {
              covered: Math.max(prev.covered, value.covered),
              total: Math.max(prev.total, value.total),
            }
          : { covered: value.covered, total: value.total }
      );
    }
    if (part.opaque) {
      covered += part.opaque.covered;
      total += part.opaque.total;
    }
  }
  for (const value of files.values()) {
    covered += value.covered;
    total += value.total;
  }
  const unresolvedList = [...unresolvedKeys].sort();
  return {
    covered,
    total,
    // `(covered * 100) / total`, NOT `(covered / total) * 100`. The latter
    // forms a ratio in [0,1] first, and most such ratios are unrepresentable
    // in binary: 57/100 is stored as 0.5699999999999999, so scaling by 100
    // yields 56.99999999999999 and the inclusive `>= 57` compare FAILS on a
    // run that is exactly at its floor. Multiplying first keeps the numerator
    // an exact integer, so every integer percentage is exact.
    pct: total > 0 ? (covered * 100) / total : null,
    fileCount: files.size,
    // Unique unresolved FILES, not unresolved contributions: the same
    // generated file seen by two tiers is one unresolved path, and reporting
    // it twice would misdescribe how much of the aggregate is uncertain.
    unresolved: unresolvedList.length,
    unresolvedKeys: unresolvedList,
  };
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
export function evaluateGate(
  opts,
  { findSummaries = findCoverageSummaries, read = readSummary, exists = existsSync } = {}
) {
  const { threshold, metric, cwd, coverageDirs } = opts;

  if (threshold <= 0) {
    return {
      ok: true,
      skipped: true,
      reason: "threshold 0 — coverage gate disabled (no-op)",
      threshold,
      metric,
      results: [],
      merged: null,
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
      merged: null,
    };
  }

  // Per-summary rows stay in the verdict as CONTRIBUTIONS — they name which
  // artifact carried which numbers, so a tier that quietly stopped producing
  // coverage is visible in the log. They are no longer individually asserted:
  // the floor is one verdict over the union (see the header note).
  // Parse every summary BEFORE normalizing any of them: the prefix unresolved
  // keys are stripped against is computed once over the union of all their
  // keys (`sharedDirPrefix`). Computed per summary it is a function of that
  // summary's own depth, so one file gets two keys and the union sums it.
  const parsed = files.map((file) => ({ file, summary: read(file) }));
  const prefix = sharedDirPrefix(parsed.map((entry) => entry.summary));

  const results = [];
  const parts = [];
  for (const { file, summary } of parsed) {
    const pct = extractPct(summary, metric);
    const part = normalizeSummary(summary, metric, { exists, cwd, prefix });
    parts.push(part);
    results.push({
      file,
      pct,
      fileCount: part.files.size,
      unresolved: part.unresolved,
      contributed: part.files.size > 0 || part.opaque !== null,
    });
  }

  const merged = mergeNormalized(parts);

  if (merged.pct === null) {
    return {
      ok: false,
      skipped: false,
      reason:
        `coverage threshold is set but no "${metric}" counts could be read from ` +
        `any of the ${files.length} coverage summaries found (a set floor must ` +
        "not pass on unreadable data)",
      threshold,
      metric,
      results,
      merged,
    };
  }

  const ok = meetsThreshold(merged.pct, threshold);
  return {
    ok,
    skipped: false,
    reason: ok ? "merged coverage meets the floor" : "below floor",
    threshold,
    metric,
    results,
    merged,
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

  // Contribution rows first: which artifact carried what.
  for (const r of verdict.results) {
    if (!r.contributed) {
      lines.push(
        `[coverage-threshold] ⚠️  ${r.file}: no "${verdict.metric}" counts — contributed nothing`
      );
      continue;
    }
    const shown = r.pct === null ? "n/a" : `${r.pct}%`;
    const unresolvedNote =
      r.unresolved > 0 ? `, ${r.unresolved} path(s) unresolved against the checkout` : "";
    lines.push(
      `[coverage-threshold] • ${r.file}: ${r.fileCount} file(s), ` +
        `${verdict.metric} ${shown} on its own${unresolvedNote}`
    );
  }

  const m = verdict.merged;
  if (!m || m.pct === null) {
    lines.push(`[coverage-threshold] ❌ ${verdict.reason}`);
    return lines;
  }

  const shownPct = formatPctForVerdict(m.pct, verdict.threshold);
  lines.push(
    `[coverage-threshold] Σ merged across ${verdict.results.length} summary(ies): ` +
      `${m.covered}/${m.total} ${verdict.metric} over ${m.fileCount} unique file(s) ` +
      `= ${shownPct}% (floor ${verdict.threshold}%)`
  );
  // Name every path that never resolved against the checkout. Such a key is
  // merged on its prefix-stripped form, which is a weaker identity than a
  // checkout-anchored one — so if a residual double-count IS inflating the
  // aggregate, the file responsible is in the log rather than inferred.
  if (m.unresolvedKeys && m.unresolvedKeys.length > 0) {
    lines.push(
      `[coverage-threshold] ⚠️  ${m.unresolvedKeys.length} path(s) never resolved ` +
        `against the checkout and were merged on their normalized key: ` +
        m.unresolvedKeys.join(", ")
    );
  }
  if (verdict.ok) {
    lines.push(
      `[coverage-threshold] ✅ merged ${verdict.metric} coverage meets the ${verdict.threshold}% floor.`
    );
  } else {
    lines.push(
      `[coverage-threshold] ❌ merged ${verdict.metric} coverage is below the ${verdict.threshold}% floor.`
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
