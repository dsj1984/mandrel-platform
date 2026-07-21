#!/usr/bin/env node
/**
 * OSV report severity-band gate (Story #310).
 *
 * Extracted verbatim-in-behaviour from the ~220-line Node heredoc that used
 * to live inside `pr-quality.yml`'s `osv-scan` job. Nothing about the gating
 * semantics changes here — the point of the move is that a heredoc cannot be
 * unit-tested, so the banding, the allow-list schema validation (Story #145),
 * and the `revisitBy` re-gating had no coverage at all. As a real module they
 * do: `scripts/osv-report-gate.test.mjs`.
 *
 * The file ships INSIDE the composite action directory rather than under
 * `scripts/`, because a composite action's whole directory is checked out on
 * the runner when a workflow resolves `uses:` — so a consumer needs NO extra
 * file in its own checkout (the same property the heredoc had).
 *
 * Gate semantics (documented in docs/reusable-workflows.md):
 *   • OSV-scanner's own exit code is non-zero on ANY advisory regardless of
 *     severity. We do NOT rely on it. Instead we bucket each group's
 *     `max_severity` CVSS base score into critical (>=9.0) / high (>=7.0) /
 *     medium (>=4.0) / low (>0) / none (unscored), and BLOCK only when a
 *     finding lands at or above `failOn`.
 *   • Findings below the band are reported as warnings without blocking.
 *   • An allow-list entry suppresses a would-block finding until its
 *     `revisitBy` date passes, after which it re-gates as blocking.
 *
 * Exit codes (CLI mode): 0 = pass, 1 = blocking findings (or a hard error:
 * malformed report / malformed allow-list / invalid fail-on band). Under
 * `OSV_NON_BLOCKING=true` a blocking finding SET still reports and still
 * writes its outputs, but exits 0 — the scheduled advisory workflow wants the
 * finding set, not a red job. Hard errors ignore non-blocking mode: a gate
 * that could not evaluate is never a soft signal.
 */

import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";

export const BANDS = ["none", "low", "medium", "high", "critical"];

/** Rank a band for threshold comparison; a finding blocks when rank >= failOn rank. */
export const rank = (band) => BANDS.indexOf(band);

/** CVSS base score → severity band. */
export function bandOf(score) {
  if (!Number.isFinite(score) || score <= 0) return "none";
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  return "low";
}

/** Thrown for any condition that must fail the gate closed rather than pass silently. */
export class OsvGateError extends Error {}

/**
 * Flatten an OSV-scanner JSON report into gate rows.
 *
 * Each `group` bundles aliased advisories under a single `max_severity`. A
 * package whose advisories are NOT surfaced via a group still contributes one
 * unscored ("none") row per vulnerability — defensive, so an advisory can
 * never silently vanish because the report shape drifted.
 */
export function collectRows(report) {
  const rows = [];
  for (const res of report?.results || []) {
    const source = res.source?.path || "(unknown source)";
    for (const pkg of res.packages || []) {
      const name = pkg.package?.name || "(unknown)";
      const version = pkg.package?.version || "?";
      const ecosystem = pkg.package?.ecosystem || "";
      for (const group of pkg.groups || []) {
        const score = Number.parseFloat(group.max_severity ?? "");
        rows.push({
          source,
          name,
          version,
          ecosystem,
          band: bandOf(score),
          score,
          ids: group.ids || [],
        });
      }
      if ((pkg.groups || []).length === 0) {
        for (const v of pkg.vulnerabilities || []) {
          rows.push({
            source,
            name,
            version,
            ecosystem,
            band: "none",
            score: NaN,
            ids: [v.id || "(unknown)"],
          });
        }
      }
    }
  }
  return rows;
}

const isValidDate = (s) =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * Read + validate the optional allow-list.
 *
 * A MISSING file yields an empty allow-list, so gating is byte-for-byte
 * identical to having no allow-list at all (the Story #145 backwards-
 * compatibility criterion). A PRESENT but malformed file is a hard error —
 * fail loud rather than silently matching nothing (or everything).
 */
export function loadAllowlist(allowlistPath, { readFile = readFileSync, exists = existsSync } = {}) {
  const path = (allowlistPath || ".osv-allowlist.json").trim();
  if (!path || !exists(path)) return [];

  let raw;
  try {
    raw = JSON.parse(readFile(path, "utf8"));
  } catch (e) {
    throw new OsvGateError(`Could not parse OSV allow-list "${path}": ${e.message}`);
  }

  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.suppressions)
      ? raw.suppressions
      : null;
  if (entries === null) {
    throw new OsvGateError(
      `OSV allow-list "${path}" must be a JSON array of entries, or an object with a ` +
        `"suppressions" array. See docs/reusable-workflows.md.`,
    );
  }

  return entries.map((entry, i) => {
    const where = `${path}[${i}]`;
    if (!entry || typeof entry !== "object") {
      throw new OsvGateError(`${where}: entry must be an object.`);
    }
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new OsvGateError(`${where}: missing required string field "id" (OSV/GHSA id).`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new OsvGateError(`${where} (id=${entry.id}): missing required string field "reason".`);
    }
    if (!isValidDate(entry.revisitBy)) {
      throw new OsvGateError(
        `${where} (id=${entry.id}): missing or invalid required field "revisitBy" ` +
          `(expected "YYYY-MM-DD").`,
      );
    }
    if (entry.package !== undefined && typeof entry.package !== "string") {
      throw new OsvGateError(`${where} (id=${entry.id}): "package" must be a string when present.`);
    }
    if (entry.ecosystem !== undefined && typeof entry.ecosystem !== "string") {
      throw new OsvGateError(
        `${where} (id=${entry.id}): "ecosystem" must be a string when present.`,
      );
    }
    return entry;
  });
}

/**
 * Partition rows into blocking / warning / suppressed / expired.
 *
 * `today` is injected so the `revisitBy` boundary is testable without clock
 * games; it defaults to the local midnight of the current day, matching the
 * original inline behaviour.
 */
export function classify(rows, { failOn = "high", allowlist = [], today = null } = {}) {
  const band = String(failOn).trim().toLowerCase();
  if (!BANDS.includes(band)) {
    throw new OsvGateError(
      `Invalid osv-fail-on-severity "${failOn}" (expected: ${BANDS.join(", ")}).`,
    );
  }

  const midnight = today ? new Date(today) : new Date();
  midnight.setHours(0, 0, 0, 0);

  const matchEntry = (row) =>
    allowlist.find((e) => {
      if (!row.ids.includes(e.id)) return false;
      if (e.package !== undefined && e.package !== row.name) return false;
      if (e.ecosystem !== undefined && e.ecosystem !== row.ecosystem) return false;
      return true;
    });

  // Most-severe first, so every rendered table and the digest are stable.
  const sorted = [...rows].sort(
    (a, b) => rank(b.band) - rank(a.band) || (b.score || 0) - (a.score || 0),
  );

  const blocking = [];
  const warning = [];
  const suppressed = [];
  const expired = [];

  for (const r of sorted) {
    const wouldBlock = rank(r.band) >= rank(band);
    if (!wouldBlock) {
      warning.push(r);
      continue;
    }
    const entry = matchEntry(r);
    if (!entry) {
      blocking.push(r);
      continue;
    }
    // A suppression past its revisitBy re-gates as if unsuppressed — a stale
    // suppression must not silently shield a finding forever.
    const revisitDate = new Date(entry.revisitBy);
    revisitDate.setHours(0, 0, 0, 0);
    if (revisitDate.getTime() < midnight.getTime()) {
      expired.push({ ...r, entry });
      blocking.push(r);
    } else {
      suppressed.push({ ...r, entry });
    }
  }

  return { failOn: band, blocking, warning, suppressed, expired };
}

const fmtScore = (r) => (Number.isFinite(r.score) ? r.score.toFixed(1) : "—");
const fmtPkg = (r) => (r.ecosystem ? `${r.ecosystem}:${r.name}` : r.name);

const TABLE_HEADER = [
  "| Severity | Score | Advisory | Package | Version | Source |",
  "| -------- | ----- | -------- | ------- | ------- | ------ |",
];
const ENTRY_TABLE_HEADER = [
  "| Severity | Score | Advisory | Package | Version | Source | revisitBy | reason |",
  "| -------- | ----- | -------- | ------- | ------- | ------ | --------- | ------ |",
];

const fmtRow = (r) =>
  `| ${r.band} | ${fmtScore(r)} | ${r.ids.join(", ")} | ${fmtPkg(r)} | ${r.version} | ${r.source} |`;
const fmtEntryRow = (r) =>
  `| ${r.band} | ${fmtScore(r)} | ${r.ids.join(", ")} | ${fmtPkg(r)} | ${r.version} | ${r.source} | ${r.entry.revisitBy} | ${r.entry.reason} |`;

/**
 * Render the markdown block written to the job summary — and reused verbatim
 * as the tracking-issue body by the scheduled workflow, so a reader sees the
 * same table in both places.
 */
export function renderSummary(verdictSet, { heading = "OSV advisory scan" } = {}) {
  const { failOn, blocking, warning, suppressed, expired } = verdictSet;
  const lines = [];

  if (blocking.length === 0 && warning.length === 0 && suppressed.length === 0) {
    lines.push(`### ✅ ${heading} — no known advisories`);
    lines.push("");
    lines.push("OSV-scanner found no known advisories in the lockfile/manifest tree.");
    return lines;
  }

  const verdict = blocking.length > 0 ? "❌ BLOCKED" : "⚠️ advisories found (below gate)";
  lines.push(`### ${heading} — ${verdict}`);
  lines.push("");
  lines.push(
    `Gate: fail on **${failOn}** or above. ${blocking.length} blocking, ${warning.length} below-gate ` +
      `(warn), ${suppressed.length} suppressed via allow-list.`,
  );
  lines.push("");

  if (expired.length > 0) {
    lines.push(`#### ⚠️ ${expired.length} suppression(s) past \`revisitBy\` — re-gated as blocking`);
    lines.push("");
    lines.push(...ENTRY_TABLE_HEADER);
    for (const r of expired) lines.push(fmtEntryRow(r));
    lines.push("");
  }
  if (blocking.length > 0) {
    lines.push(`#### ❌ Blocking (${blocking.length})`);
    lines.push("");
    lines.push(...TABLE_HEADER);
    for (const r of blocking) lines.push(fmtRow(r));
    lines.push("");
  }
  if (warning.length > 0) {
    lines.push(`#### ⚠️ Warning — below gate (${warning.length})`);
    lines.push("");
    lines.push(...TABLE_HEADER);
    for (const r of warning) lines.push(fmtRow(r));
    lines.push("");
  }
  if (suppressed.length > 0) {
    lines.push(`#### 🔕 Suppressed via allow-list (${suppressed.length})`);
    lines.push("");
    lines.push(...ENTRY_TABLE_HEADER);
    for (const r of suppressed) lines.push(fmtEntryRow(r));
    lines.push("");
  }
  return lines;
}

/**
 * Stable digest of the BLOCKING finding set.
 *
 * The scheduled workflow upserts its tracking issue only when this changes,
 * so it must depend on the finding identity (advisory ids + package + version
 * + source) and NOT on ordering, scan timestamps, or the below-gate rows —
 * otherwise an unchanged advisory set would rewrite the issue body daily.
 */
export function findingsDigest(blocking) {
  const keys = blocking
    .map((r) => `${[...r.ids].sort().join("+")}|${r.ecosystem}:${r.name}@${r.version}|${r.source}`)
    .sort();
  // FNV-1a — a short, dependency-free, stable hash; this is a change-detector,
  // not a security primitive.
  let hash = 0x811c9dc5;
  for (const ch of keys.join("\n")) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${keys.length}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function emitOutputs(outputs) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  const body = Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  appendFileSync(outPath, body + "\n");
}

export function main() {
  const nonBlocking = String(process.env.OSV_NON_BLOCKING || "").trim() === "true";
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const emit = (line) => {
    if (summaryPath) appendFileSync(summaryPath, line + "\n");
    console.log(line);
  };

  let report;
  try {
    report = JSON.parse(readFileSync(process.env.OSV_REPORT, "utf8"));
  } catch (e) {
    console.error(`::error::Could not parse OSV JSON report: ${e.message}`);
    return 1;
  }

  let verdictSet;
  try {
    verdictSet = classify(collectRows(report), {
      failOn: process.env.OSV_FAIL_ON || "high",
      allowlist: loadAllowlist(process.env.OSV_ALLOWLIST_PATH),
    });
  } catch (e) {
    if (e instanceof OsvGateError) {
      console.error(`::error::${e.message}`);
      return 1;
    }
    throw e;
  }

  const { blocking, warning, suppressed, expired } = verdictSet;
  for (const line of renderSummary(verdictSet)) emit(line);

  const digest = findingsDigest(blocking);
  emitOutputs({
    "blocking-count": blocking.length,
    "warning-count": warning.length,
    "suppressed-count": suppressed.length,
    "expired-count": expired.length,
    "findings-digest": digest,
  });

  // Machine-readable findings for a downstream consumer (the scheduled
  // workflow's tracking-issue upsert). Written only when asked for, so the
  // pr-quality path is unchanged.
  if (process.env.OSV_FINDINGS_OUT) {
    writeFileSync(
      process.env.OSV_FINDINGS_OUT,
      JSON.stringify(
        {
          failOn: verdictSet.failOn,
          digest,
          counts: {
            blocking: blocking.length,
            warning: warning.length,
            suppressed: suppressed.length,
            expired: expired.length,
          },
          summary: renderSummary(verdictSet).join("\n"),
        },
        null,
        2,
      ) + "\n",
    );
  }

  if (blocking.length > 0) {
    const detail =
      `OSV advisory scan: ${blocking.length} finding(s) at or above the '${verdictSet.failOn}' gate ` +
      `(${expired.length} via expired suppression). See the job summary for the advisory table.`;
    if (nonBlocking) {
      console.log(`::warning::${detail} (non-blocking mode — reported, not gated.)`);
      return 0;
    }
    console.error(`::error::${detail}`);
    return 1;
  }

  if (blocking.length === 0 && (warning.length > 0 || suppressed.length > 0)) {
    emit(
      `✅ No advisory at or above the '${verdictSet.failOn}' gate. ${warning.length} below-gate ` +
        `finding(s) reported as warnings; ${suppressed.length} suppressed via allow-list.`,
    );
  }
  return 0;
}

// Run only when invoked directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
