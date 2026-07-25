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
 * Diff-aware gating (Story #325). A would-block finding that is ALREADY
 * present on the base branch is demoted to a non-blocking `preexisting` bucket,
 * so a newly-published advisory against a dependency committed weeks ago stops
 * reding every open PR at once (the postcss GHSA-r28c-9q8g-f849 /
 * brace-expansion GHSA-mh99-v99m-4gvg incidents). The baseline is the SAME
 * whole-tree scan run against a worktree at the merge base — not a lockfile
 * parse — so it stays correct for every ecosystem OSV-scanner supports. An
 * optional publish grace window (`graceDays`) additionally demotes advisories
 * published less than N days ago, acknowledging that a patched version is
 * frequently unresolvable inside a package manager's release-age cooldown.
 *
 * PRECEDENCE MATTERS: the allow-list is resolved FIRST and wins. A suppression
 * past its `revisitBy` re-gates as blocking even when the finding is
 * pre-existing or inside the grace window — an expired suppression is an
 * operator-authored time box that ran out, and demoting it would neuter
 * `revisitBy` on PRs entirely (such a finding is by construction on a
 * pre-existing dependency).
 *
 * Exit codes (CLI mode): 0 = pass, 1 = blocking findings (or a hard error:
 * malformed report / malformed allow-list / invalid fail-on band). Under
 * `OSV_NON_BLOCKING=true` a blocking finding SET still reports and still
 * writes its outputs, but exits 0 — the scheduled advisory workflow wants the
 * finding set, not a red job. Hard errors ignore non-blocking mode: a gate
 * that could not evaluate is never a soft signal.
 *
 * `OSV_CLASSIFY_ONLY=true` runs a counts-only probe: it prints
 * `blocking-count=<n>` on stdout and writes NO summary and NO outputs. The
 * composite uses it to decide whether the merge-base baseline scan is worth
 * paying for, so a clean tree costs exactly what it cost before this change.
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
 * Normalize an OSV-scanner `source.path` against the root the scan ran from.
 *
 * The merge-base baseline is scanned inside a `git worktree` at a DIFFERENT
 * absolute path than the workspace, so an un-normalized source would make
 * every head finding look like it had no baseline counterpart — the diff-aware
 * gate would then block everything and be indistinguishable from the old
 * whole-tree behaviour. Stripping the scan root reduces both trees to the same
 * repo-relative path.
 */
export function normalizeSource(source, scanRoot = "") {
  let s = String(source ?? "").trim();
  if (s === "") return "";
  const root = String(scanRoot ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (root !== "") {
    if (s === root) return "";
    if (s.startsWith(`${root}/`)) s = s.slice(root.length + 1);
  }
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/**
 * Identity of a finding for baseline comparison.
 *
 * Deliberately includes `@version`: a PR that bumps an advisory-bearing
 * dependency to ANOTHER still-vulnerable version produces a key absent from
 * the baseline, and therefore correctly blocks rather than inheriting the
 * pre-existing demotion.
 */
export function rowKey(row) {
  const ids = [...(row?.ids || [])].sort().join("+");
  return `${ids}|${row?.ecosystem ?? ""}:${row?.name ?? ""}@${row?.version ?? ""}|${row?.source ?? ""}`;
}

/** Build the lookup a `classify({ baseline })` call consumes from baseline rows. */
export function buildBaselineSet(rows) {
  return new Set((rows || []).map(rowKey));
}

/**
 * Earliest resolvable OSV `published` date across a group's advisory ids.
 *
 * Returns null when NO id carries a parseable date. That null is load-bearing:
 * the grace window does not apply to a finding with no known publish date, so
 * a report shape that omits `published` fails closed (the finding blocks)
 * rather than silently opening the gate.
 */
function earliestPublished(ids, publishedById) {
  let best = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const id of ids || []) {
    const raw = publishedById.get(id);
    if (typeof raw !== "string") continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = raw;
    }
  }
  return best;
}

/**
 * Flatten an OSV-scanner JSON report into gate rows.
 *
 * Each `group` bundles aliased advisories under a single `max_severity`. A
 * package whose advisories are NOT surfaced via a group still contributes one
 * unscored ("none") row per vulnerability — defensive, so an advisory can
 * never silently vanish because the report shape drifted.
 *
 * `scanRoot` normalizes `source` so head and baseline reports produced from
 * different working trees key identically (see `normalizeSource`).
 */
export function collectRows(report, { scanRoot = "" } = {}) {
  const rows = [];
  for (const res of report?.results || []) {
    const rawSource = res.source?.path;
    const source = rawSource ? normalizeSource(rawSource, scanRoot) : "(unknown source)";
    for (const pkg of res.packages || []) {
      const name = pkg.package?.name || "(unknown)";
      const version = pkg.package?.version || "?";
      const ecosystem = pkg.package?.ecosystem || "";

      // Group rows carry the severity but not the publish date; the date lives
      // on the per-vulnerability entries the group's ids reference.
      const publishedById = new Map();
      for (const v of pkg.vulnerabilities || []) {
        if (v?.id && typeof v.published === "string") publishedById.set(v.id, v.published);
      }

      for (const group of pkg.groups || []) {
        const score = Number.parseFloat(group.max_severity ?? "");
        const ids = group.ids || [];
        rows.push({
          source,
          name,
          version,
          ecosystem,
          band: bandOf(score),
          score,
          ids,
          published: earliestPublished(ids, publishedById),
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
            published: typeof v.published === "string" ? v.published : null,
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Is this finding inside the publish grace window?
 *
 * False whenever the publish date is unknown or unparseable — the window is a
 * deliberate softening that only applies to an advisory we can positively date.
 */
function withinGraceWindow(row, midnight, graceDays) {
  if (graceDays <= 0) return false;
  if (typeof row.published !== "string") return false;
  const ms = Date.parse(row.published);
  if (!Number.isFinite(ms)) return false;
  return (midnight.getTime() - ms) / DAY_MS < graceDays;
}

/**
 * Partition rows into blocking / warning / suppressed / expired / preexisting /
 * grace.
 *
 * `today` is injected so the `revisitBy` and grace-window boundaries are
 * testable without clock games; it defaults to the local midnight of the
 * current day, matching the original inline behaviour.
 *
 * `baseline` is a Set (or any iterable) of `rowKey()` strings from the
 * merge-base scan; null means no baseline was available and the gate keeps
 * whole-tree blocking semantics. `graceDays` of 0 disables the grace window.
 * With `baseline: null` and `graceDays: 0` this function is byte-for-byte the
 * pre-Story-#325 partition.
 */
export function classify(
  rows,
  { failOn = "high", allowlist = [], today = null, baseline = null, graceDays = 0 } = {},
) {
  const band = String(failOn).trim().toLowerCase();
  if (!BANDS.includes(band)) {
    throw new OsvGateError(
      `Invalid osv-fail-on-severity "${failOn}" (expected: ${BANDS.join(", ")}).`,
    );
  }

  const parsedGrace = Number(graceDays);
  const graceWindow = Number.isFinite(parsedGrace) ? Math.max(0, Math.trunc(parsedGrace)) : 0;
  const baselineSet =
    baseline == null ? null : baseline instanceof Set ? baseline : new Set(baseline);

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
  const preexisting = [];
  const grace = [];

  for (const r of sorted) {
    const wouldBlock = rank(r.band) >= rank(band);
    if (!wouldBlock) {
      warning.push(r);
      continue;
    }

    // The allow-list resolves FIRST and wins outright over both demotions. An
    // expired suppression is an operator-authored time box that ran out; since
    // such a finding is by construction on a pre-existing dependency, letting
    // the baseline demote it would neuter `revisitBy` on PRs entirely.
    const entry = matchEntry(r);
    if (entry) {
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
      continue;
    }

    if (baselineSet && baselineSet.has(rowKey(r))) {
      preexisting.push(r);
      continue;
    }
    if (withinGraceWindow(r, midnight, graceWindow)) {
      grace.push(r);
      continue;
    }
    blocking.push(r);
  }

  return {
    failOn: band,
    blocking,
    warning,
    suppressed,
    expired,
    preexisting,
    grace,
    baselineApplied: baselineSet !== null,
    graceDays: graceWindow,
  };
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
const PUBLISHED_TABLE_HEADER = [
  "| Severity | Score | Advisory | Package | Version | Source | Published |",
  "| -------- | ----- | -------- | ------- | ------- | ------ | --------- |",
];

const fmtRow = (r) =>
  `| ${r.band} | ${fmtScore(r)} | ${r.ids.join(", ")} | ${fmtPkg(r)} | ${r.version} | ${r.source} |`;
const fmtEntryRow = (r) =>
  `| ${r.band} | ${fmtScore(r)} | ${r.ids.join(", ")} | ${fmtPkg(r)} | ${r.version} | ${r.source} | ${r.entry.revisitBy} | ${r.entry.reason} |`;
const fmtPublishedRow = (r) =>
  `| ${r.band} | ${fmtScore(r)} | ${r.ids.join(", ")} | ${fmtPkg(r)} | ${r.version} | ${r.source} | ${r.published ?? "—"} |`;

/**
 * Render the markdown block written to the job summary — and reused verbatim
 * as the tracking-issue body by the scheduled workflow, so a reader sees the
 * same table in both places.
 */
export function renderSummary(verdictSet, { heading = "OSV advisory scan" } = {}) {
  const { failOn, blocking, warning, suppressed, expired } = verdictSet;
  const preexisting = verdictSet.preexisting || [];
  const grace = verdictSet.grace || [];
  const lines = [];

  if (
    blocking.length === 0 &&
    warning.length === 0 &&
    suppressed.length === 0 &&
    preexisting.length === 0 &&
    grace.length === 0
  ) {
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
  if (verdictSet.baselineApplied || preexisting.length > 0) {
    lines.push("");
    lines.push(
      `Diff-aware: ${preexisting.length} finding(s) already present on the base branch — ` +
        `reported here, not attributed to this PR. The scheduled advisory scan owns those.`,
    );
  }
  if (grace.length > 0) {
    lines.push("");
    lines.push(
      `Grace window: ${grace.length} finding(s) published within ${verdictSet.graceDays} day(s) — ` +
        `reported, not blocking.`,
    );
  }
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
  if (preexisting.length > 0) {
    lines.push(
      `#### ℹ️ Pre-existing on the base branch — not introduced by this PR (${preexisting.length})`,
    );
    lines.push("");
    lines.push(
      "These advisories affect dependencies this PR did not add or change. They are tracked by the",
    );
    lines.push("scheduled advisory scan against the default branch, not by this PR's gate.");
    lines.push("");
    lines.push(...TABLE_HEADER);
    for (const r of preexisting) lines.push(fmtRow(r));
    lines.push("");
  }
  if (grace.length > 0) {
    lines.push(`#### ⏳ Within the publish grace window (${grace.length})`);
    lines.push("");
    lines.push(
      `Published less than ${verdictSet.graceDays} day(s) ago — a patched version is often not yet`,
    );
    lines.push("resolvable inside a package manager's release-age cooldown.");
    lines.push("");
    lines.push(...PUBLISHED_TABLE_HEADER);
    for (const r of grace) lines.push(fmtPublishedRow(r));
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
  const classifyOnly = String(process.env.OSV_CLASSIFY_ONLY || "").trim() === "true";
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const emit = (line) => {
    if (summaryPath) appendFileSync(summaryPath, line + "\n");
    console.log(line);
  };
  // Deferred so the classify-only probe stays silent on the job summary.
  const deferredNotes = [];

  let report;
  try {
    report = JSON.parse(readFileSync(process.env.OSV_REPORT, "utf8"));
  } catch (e) {
    console.error(`::error::Could not parse OSV JSON report: ${e.message}`);
    return 1;
  }

  const graceDays = process.env.OSV_GRACE_DAYS || 0;

  // Merge-base baseline (Story #325). A baseline that cannot be read is NOT a
  // silent pass: we drop to whole-tree blocking semantics and say so. Over-
  // blocking is the safe degradation direction; treating an unreadable
  // baseline as "everything is pre-existing" would open the gate on a real
  // PR-introduced advisory.
  let baseline = null;
  const baseReportPath = (process.env.OSV_BASE_REPORT || "").trim();
  if (baseReportPath) {
    try {
      const baseReport = JSON.parse(readFileSync(baseReportPath, "utf8"));
      baseline = buildBaselineSet(
        collectRows(baseReport, { scanRoot: process.env.OSV_BASE_SCAN_ROOT || "" }),
      );
    } catch (e) {
      console.error(
        `::warning::Could not read the merge-base OSV baseline (${baseReportPath}): ${e.message}. ` +
          `Falling back to whole-tree blocking semantics — every finding is gated as if PR-introduced.`,
      );
      deferredNotes.push(
        `> ⚠️ The merge-base baseline could not be read, so this run gated every finding as ` +
          `PR-introduced (whole-tree semantics). Failing closed rather than under-blocking.`,
      );
      baseline = null;
    }
  }

  let verdictSet;
  try {
    verdictSet = classify(collectRows(report, { scanRoot: process.env.OSV_SCAN_ROOT || "" }), {
      failOn: process.env.OSV_FAIL_ON || "high",
      allowlist: loadAllowlist(process.env.OSV_ALLOWLIST_PATH),
      baseline,
      graceDays,
    });
  } catch (e) {
    if (e instanceof OsvGateError) {
      console.error(`::error::${e.message}`);
      return 1;
    }
    throw e;
  }

  const { blocking, warning, suppressed, expired, preexisting, grace } = verdictSet;

  // Counts-only probe: the composite runs this to decide whether the merge-base
  // baseline scan is worth paying for. Writes no summary and no outputs.
  if (classifyOnly) {
    console.log(`blocking-count=${blocking.length}`);
    return 0;
  }

  for (const line of renderSummary(verdictSet)) emit(line);
  for (const note of deferredNotes) emit(note);

  const digest = findingsDigest(blocking);
  emitOutputs({
    "blocking-count": blocking.length,
    "warning-count": warning.length,
    "suppressed-count": suppressed.length,
    "expired-count": expired.length,
    "preexisting-count": preexisting.length,
    "grace-count": grace.length,
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
            preexisting: preexisting.length,
            grace: grace.length,
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

  if (
    blocking.length === 0 &&
    (warning.length > 0 || suppressed.length > 0 || preexisting.length > 0 || grace.length > 0)
  ) {
    emit(
      `✅ No advisory at or above the '${verdictSet.failOn}' gate is attributable to this change. ` +
        `${warning.length} below-gate finding(s) reported as warnings; ${suppressed.length} suppressed ` +
        `via allow-list; ${preexisting.length} already present on the base branch; ${grace.length} ` +
        `within the publish grace window.`,
    );
  }
  return 0;
}

// Run only when invoked directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
