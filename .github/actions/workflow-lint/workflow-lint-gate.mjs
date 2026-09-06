// Workflow-lint gate — turns actionlint + zizmor reports into ONE verdict
// (Story #425).
//
// WHY THIS IS A SCRIPT AND NOT INLINE SHELL
// -----------------------------------------
// The enforcement decision is the load-bearing part of this tier: the gate
// ships ADVISORY (findings are reported and the tier stays green) and flips to
// blocking only when the caller sets `workflow-lint-enforce: true`. A grep over
// the workflow YAML cannot tell a working dial from a broken one — it pins the
// spelling, not the behaviour — so the decision lives here and is unit-tested
// from `scripts/workflow-lint-gate.test.mjs`, mirroring the `osv-report-gate`
// seam next door.
//
// TOOL FAILURE IS NEVER ADVISORY. A missing or unparseable report means the
// linter did not run; that is a broken gate, not a clean one, so it exits
// non-zero regardless of the enforcement setting. Only genuine FINDINGS are
// subject to the dial. The composite enforces the same split on its side by
// distinguishing each linter's findings exit code from its tool-failure codes.
//
// ENFORCEMENT IS PER TOOL, because the two linters arrive with different debt.
// This repo is the worked example: actionlint has been blocking in ci.yml since
// Story #108 and reports zero findings, while zizmor is new here and reports 23
// pre-existing ones. A single tier-wide dial would force a choice between
// regressing the actionlint gate and reddening the platform's own CI, so
// `classify` accepts either a boolean (the whole tier) or a per-tool map.

import { readFileSync, existsSync, appendFileSync } from "node:fs";

/** Thrown when a report cannot be read or parsed — always fatal. */
export class WorkflowLintGateError extends Error {}

/**
 * Severity ladder, weakest first. actionlint has no severity model — every
 * diagnostic it emits is an error — so its findings are normalized to `high`
 * to sort alongside zizmor's. zizmor's own filtering is done upstream by
 * `--min-severity`; this ladder only orders the report.
 */
export const SEVERITY_ORDER = ["unknown", "informational", "low", "medium", "high"];

/** @param {string} severity @returns {number} */
export const severityRank = (severity) =>
  Math.max(0, SEVERITY_ORDER.indexOf(String(severity || "unknown").toLowerCase()));

/**
 * Normalize an actionlint `-format '{{json .}}'` report.
 *
 * Shape: a flat array of `{ message, filepath, line, column, kind }`. There is
 * no severity field — actionlint exits 1 on any diagnostic — so each finding is
 * recorded at `high` and keyed by its `kind` (the check that fired).
 *
 * @param {unknown} report
 * @returns {Array<{tool: string, id: string, severity: string, file: string, line: number, column: number, message: string, url: string}>}
 */
export function normalizeActionlint(report) {
  if (!Array.isArray(report)) {
    throw new WorkflowLintGateError(
      `actionlint report must be a JSON array, got ${typeof report}`,
    );
  }
  return report.map((row) => ({
    tool: "actionlint",
    id: String(row?.kind || "actionlint"),
    severity: "high",
    file: String(row?.filepath || ""),
    line: Number(row?.line) || 0,
    column: Number(row?.column) || 0,
    message: String(row?.message || "").split("\n")[0],
    url: "",
  }));
}

/**
 * Normalize a zizmor `--format json` (v1) report.
 *
 * Shape: a flat array of `{ ident, desc, url, determinations, locations }`.
 * The primary location carries the path under
 * `symbolic.key.Local.verbatim_path`, and `concrete.location.start_point`
 * holds a ZERO-indexed row/column — both are incremented here so the rendered
 * `file:line:col` matches what zizmor's own plain output prints.
 *
 * @param {unknown} report
 * @returns {Array<{tool: string, id: string, severity: string, file: string, line: number, column: number, message: string, url: string}>}
 */
export function normalizeZizmor(report) {
  if (!Array.isArray(report)) {
    throw new WorkflowLintGateError(
      `zizmor report must be a JSON array, got ${typeof report}`,
    );
  }
  return report.map((row) => {
    const primary =
      (row?.locations || []).find((loc) => loc?.symbolic?.kind === "Primary") ||
      (row?.locations || [])[0] ||
      {};
    const point = primary?.concrete?.location?.start_point || {};
    return {
      tool: "zizmor",
      id: String(row?.ident || "zizmor"),
      severity: String(row?.determinations?.severity || "unknown").toLowerCase(),
      file: String(primary?.symbolic?.key?.Local?.verbatim_path || ""),
      // zizmor's start_point is 0-indexed; +1 to match its plain renderer.
      line: Number.isFinite(Number(point?.row)) ? Number(point.row) + 1 : 0,
      column: Number.isFinite(Number(point?.column)) ? Number(point.column) + 1 : 0,
      message: String(row?.desc || ""),
      url: String(row?.url || ""),
    };
  });
}

/**
 * Decide the tier's exit code from the normalized findings.
 *
 * ADVISORY (`enforce: false`, the default): every finding is reported and the
 * exit code stays 0. ENFORCING (`enforce: true`): any finding fails the tier.
 * The findings themselves are identical either way — the dial changes only
 * whether they are blocking, which is what lets a consumer inherit the tier on
 * a pin bump without their pre-existing workflow debt reddening the merge.
 *
 * @param {Array<object>} findings
 * @param {{enforce?: boolean}} [opts]
 */
export function classify(findings, { enforce = false } = {}) {
  const sorted = [...findings].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      String(a.tool).localeCompare(String(b.tool)) ||
      String(a.file).localeCompare(String(b.file)) ||
      (a.line || 0) - (b.line || 0),
  );
  const enforcedFor = (tool) =>
    typeof enforce === "object" && enforce !== null
      ? Boolean(enforce[tool])
      : Boolean(enforce);
  const blocking = sorted.filter((f) => enforcedFor(f.tool));
  const anyEnforced =
    typeof enforce === "object" && enforce !== null
      ? Object.values(enforce).some(Boolean)
      : Boolean(enforce);
  return {
    enforce,
    anyEnforced,
    enforcedFor,
    findings: sorted,
    blocking,
    counts: countBySeverity(sorted),
    exitCode: blocking.length > 0 ? 1 : 0,
  };
}

/**
 * Resolve the enforcement map from the three env-shaped values. A per-tool
 * value wins over the tier-wide one; an unset per-tool value inherits it. Only
 * the literal string 'true' enables enforcement — anything else (including
 * 'TRUE', '1', 'yes') stays advisory, so a typo can never silently start
 * blocking a consumer's merges.
 *
 * @param {{enforce?: string, actionlint?: string, zizmor?: string}} raw
 * @returns {{actionlint: boolean, zizmor: boolean}}
 */
export function resolveEnforcement({ enforce = "", actionlint = "", zizmor = "" } = {}) {
  const isTrue = (v) => String(v || "").trim() === "true";
  const base = isTrue(enforce);
  const perTool = (v) => (String(v || "").trim() === "" ? base : isTrue(v));
  return { actionlint: perTool(actionlint), zizmor: perTool(zizmor) };
}

/** @param {Array<object>} findings */
export function countBySeverity(findings) {
  const counts = { high: 0, medium: 0, low: 0, informational: 0, unknown: 0 };
  for (const f of findings) {
    const key = String(f.severity || "unknown").toLowerCase();
    if (key in counts) counts[key] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

/**
 * One-line digest for the run log.
 * @param {ReturnType<typeof classify>} verdict
 */
export function findingsDigest(verdict) {
  const { counts, findings, blocking } = verdict;
  if (findings.length === 0) return "workflow-lint: no findings.";
  const bands = SEVERITY_ORDER.slice()
    .reverse()
    .filter((band) => counts[band] > 0)
    .map((band) => `${counts[band]} ${band}`)
    .join(", ");
  const tail =
    blocking.length === 0
      ? "all advisory, so they do NOT fail this tier (set workflow-lint-enforce: true to gate on them)."
      : blocking.length === findings.length
        ? "ENFORCING, so they fail this tier."
        : `${blocking.length} ENFORCING (failing this tier), ${findings.length - blocking.length} advisory.`;
  return `workflow-lint: ${findings.length} finding(s) (${bands}) — ${tail}`;
}

const TABLE_HEADER = [
  "| Gate | Severity | Tool | Check | Location | Finding |",
  "| ---- | -------- | ---- | ----- | -------- | ------- |",
];

/**
 * Markdown for the job summary. Findings are ALWAYS rendered, advisory or not —
 * an advisory tier whose findings are invisible is the same as no tier at all.
 *
 * @param {ReturnType<typeof classify>} verdict
 * @param {{heading?: string}} [opts]
 */
export function renderSummary(verdict, { heading = "Workflow lint" } = {}) {
  const lines = [`## ${heading}`, ""];
  if (verdict.findings.length === 0) {
    lines.push("✅ actionlint and zizmor reported no findings.", "");
    return lines.join("\n");
  }
  const blockingCount = verdict.blocking.length;
  lines.push(
    blockingCount === 0
      ? `⚠️ **${verdict.findings.length} finding(s)** — all **advisory**, so they do **not** fail the build. Set \`workflow-lint-enforce: true\` to gate on them.`
      : `❌ **${blockingCount} of ${verdict.findings.length} finding(s)** are **enforcing** and fail the build.`,
    "",
    ...TABLE_HEADER,
  );
  for (const f of verdict.findings) {
    const where = f.file ? `\`${f.file}:${f.line}:${f.column}\`` : "—";
    const check = f.url ? `[${f.id}](${f.url})` : `\`${f.id}\``;
    const gate = verdict.enforcedFor(f.tool) ? "❌ blocking" : "⚠️ advisory";
    lines.push(
      `| ${gate} | ${f.severity} | ${f.tool} | ${check} | ${where} | ${escapeCell(f.message)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Escape one finding message for a markdown table cell.
 *
 * Backslashes MUST be escaped BEFORE pipes: escaping pipes first turns an
 * input backslash into the escape character for the pipe that follows it, so
 * `a\` + `|b` would render as an escaped pipe and silently merge two cells
 * (CodeQL js/incomplete-sanitization). Finding messages are tool output, not
 * user input, but a linter that garbles its own report is still a bad report.
 *
 * @param {string} text
 */
function escapeCell(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

/**
 * Read and parse one linter report. A missing or malformed file is a TOOL
 * FAILURE, never an advisory pass — see the header note.
 *
 * @param {string} label
 * @param {string} path
 * @param {{readFile?: typeof readFileSync, exists?: typeof existsSync}} [io]
 */
export function loadReport(label, path, { readFile = readFileSync, exists = existsSync } = {}) {
  const trimmed = String(path || "").trim();
  if (!trimmed) return [];
  if (!exists(trimmed)) {
    throw new WorkflowLintGateError(
      `${label} report not found at ${trimmed} — the linter did not run, so this gate cannot vouch for anything.`,
    );
  }
  const raw = String(readFile(trimmed, "utf8")).trim();
  if (raw === "") return [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new WorkflowLintGateError(
      `${label} report at ${trimmed} is not valid JSON: ${err.message}`,
    );
  }
}

/** @returns {number} process exit code */
export function main() {
  const enforce = resolveEnforcement({
    enforce: process.env.WORKFLOW_LINT_ENFORCE,
    actionlint: process.env.WORKFLOW_LINT_ENFORCE_ACTIONLINT,
    zizmor: process.env.WORKFLOW_LINT_ENFORCE_ZIZMOR,
  });
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  let findings;
  try {
    findings = [
      ...normalizeActionlint(loadReport("actionlint", process.env.ACTIONLINT_REPORT)),
      ...normalizeZizmor(loadReport("zizmor", process.env.ZIZMOR_REPORT)),
    ];
  } catch (err) {
    if (err instanceof WorkflowLintGateError) {
      console.error(`::error::workflow-lint gate: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const verdict = classify(findings, { enforce });
  const summary = renderSummary(verdict);

  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `${summary}\n`);
    } catch (err) {
      console.error(`::warning::could not write job summary: ${err.message}`);
    }
  }
  console.log(summary);
  console.log(findingsDigest(verdict));

  // Annotate each finding so it lands on the PR's Files-changed view. Advisory
  // findings are `::warning::` and never red; enforcing ones are `::error::`.
  for (const f of verdict.findings) {
    const level = verdict.enforcedFor(f.tool) ? "error" : "warning";
    const loc = f.file ? `file=${f.file},line=${f.line || 1}` : "";
    console.log(`::${level} ${loc}::[${f.tool}/${f.id}] ${f.message}`);
  }

  return verdict.exitCode;
}

// Run only when invoked directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
