#!/usr/bin/env node
/**
 * Single-issue failure tracker (Story #389).
 *
 * A scheduled, non-gating workflow has no red check to report through — its
 * signal has to be an issue. Filing one per run turns a persistent failure
 * into a wall of duplicates, so the useful shape is exactly ONE tracked issue
 * kept in sync with the current failing set:
 *
 *   • failing set non-empty, no marked open issue  → CREATE one
 *   • failing set non-empty, marked issue, same set → NOOP (or REFRESH)
 *   • failing set non-empty, marked issue, new set  → UPDATE its body
 *   • failing set now empty, marked issue open      → CLOSE with a comment
 *   • failing set empty, no marked issue            → NOOP
 *
 * The decision is a pure function of (existing issue, failing set), so the
 * idempotence contract is unit-tested without any network access
 * (scripts/track-issue.test.mjs). `main()` only translates the verdict into
 * `gh` CLI calls.
 *
 * The issue is discovered by an HTML-comment MARKER in its body, and the
 * change-detection key is a DIGEST embedded as a second marker — so a run over
 * an unchanged failing set rewrites nothing. The action always owns both
 * marker lines: a caller supplies the marker KEY, never the rendered comment,
 * because a caller that could alter those lines could silently orphan a live
 * tracked issue and open a second one.
 *
 * Every seam is parameterized through environment variables the composite
 * manifest sets from its inputs, so a preset (see the sibling
 * `.github/actions/osv-track-issue/`) is a thin adapter that converts its own
 * domain payload into this contract rather than a fork of the state machine.
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Body text used when a caller supplies no `body-intro`. */
export const DEFAULT_INTRO = [
  "This issue is maintained automatically by a scheduled workflow — it is updated",
  "when the failing set changes and closed automatically when the set clears.",
  "Do not edit the markers above.",
].join("\n");

/** Comment posted before closing when a caller supplies no `close-comment`. */
export const DEFAULT_CLOSE_COMMENT =
  "✅ The tracked failures have cleared — nothing is failing as of the latest run. Closing automatically.";

// ---------------------------------------------------------------------------
// Marker + digest contract
// ---------------------------------------------------------------------------

/**
 * Normalize a marker key to its bare form, tolerating a caller that passed the
 * rendered HTML comment instead. Without this, `<!-- k -->` would render as
 * `<!-- <!-- k --> -->` and never match a live issue again.
 *
 * @param {string} marker
 * @returns {string}
 */
export function markerKey(marker) {
  return String(marker ?? "")
    .trim()
    .replace(/^<!--\s*/, "")
    .replace(/\s*-->$/, "")
    .trim();
}

/** Render the discovery marker a tracked issue body is found by. */
export const markerLine = (marker) => `<!-- ${markerKey(marker)} -->`;

/** The digest prefix a caller gets when it supplies none. */
export const defaultDigestPrefix = (marker) => `${markerKey(marker)}-digest:`;

/** Embed the change-detection digest as a discoverable HTML comment. */
export const digestMarker = (digest, digestPrefix) =>
  `<!-- ${String(digestPrefix).trim()} ${digest} -->`;

/** Escape a caller-supplied prefix for use inside a RegExp. */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Recover the digest a previously-filed issue body carries (null if none).
 *
 * @param {string|null|undefined} body
 * @param {string} digestPrefix
 * @returns {string|null}
 */
export function extractDigest(body, digestPrefix) {
  if (!body) return null;
  const m = body.match(new RegExp(`<!--\\s*${escapeRe(String(digestPrefix).trim())}\\s*(\\S+)\\s*-->`));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Failing-set derivation
// ---------------------------------------------------------------------------

/**
 * Reduce a `toJSON(needs)` payload to the ids that genuinely FAILED.
 *
 * Only `failure` counts. `cancelled` and `skipped` are deliberately not
 * failures: a self-hosted fleet produces spurious cancellations, and raising an
 * issue for those is precisely the noise this tracker exists to avoid.
 *
 * @param {Record<string, {result?: string}|string>|null|undefined} jobResults
 * @returns {string[]} Sorted ids whose result is exactly `failure`.
 */
export function failingJobs(jobResults) {
  if (!jobResults || typeof jobResults !== "object" || Array.isArray(jobResults)) return [];
  return Object.entries(jobResults)
    .filter(([, v]) => (v && typeof v === "object" ? v.result : v) === "failure")
    .map(([id]) => id)
    .sort();
}

/**
 * Derive a stable change-detection key from the failing set.
 *
 * Order-independent (the set is sorted and de-duplicated first) so a runner
 * re-ordering `needs` never churns the issue body, and distinctly `green-0`
 * when nothing is failing so an empty set is legible in the body rather than
 * being an opaque hash.
 *
 * @param {string[]} failedItems
 * @returns {string}
 */
export function computeDigest(failedItems) {
  const sorted = [...new Set((failedItems || []).map((s) => String(s)))].sort();
  if (sorted.length === 0) return "green-0";
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Pure verdict
// ---------------------------------------------------------------------------

/**
 * Pure upsert decision.
 *
 * @param {{number: number, body: string}|null} existing The open marked issue, or null.
 * @param {{failedCount: number, digest: string}} signal
 * @param {{digestPrefix: string, unchangedBehavior?: "noop"|"refresh"}} options
 * @returns {{action: 'create'|'update'|'noop'|'close', reason: string, changed: boolean}}
 */
export function decideVerdict(existing, signal, options = {}) {
  const digestPrefix = options.digestPrefix;
  const unchangedBehavior = options.unchangedBehavior === "refresh" ? "refresh" : "noop";
  const failed = Number(signal?.failedCount ?? 0);

  if (failed > 0) {
    if (!existing) {
      return { action: "create", reason: "failing items and no open tracking issue", changed: true };
    }
    const prevDigest = extractDigest(existing.body, digestPrefix);
    if (prevDigest === signal.digest) {
      if (unchangedBehavior === "refresh") {
        return {
          action: "update",
          reason: "failing set unchanged — refreshing the body so its run link stays current",
          changed: false,
        };
      }
      return {
        action: "noop",
        reason: "tracking issue already reflects this failing set",
        changed: false,
      };
    }
    return {
      action: "update",
      reason: "failing set changed since the tracking issue was last written",
      changed: true,
    };
  }

  // Nothing failing.
  if (existing) return { action: "close", reason: "failing set is now empty", changed: true };
  return { action: "noop", reason: "nothing failing and no tracking issue to close", changed: false };
}

/**
 * Compose the tracking-issue body: the two action-owned markers, the caller's
 * intro, an optional run link, then the caller's detail block.
 *
 * @param {{marker: string, digestPrefix: string, digest: string, intro?: string, detail?: string, runUrl?: string}} args
 * @returns {string}
 */
export function buildIssueBody({ marker, digestPrefix, digest, intro, detail, runUrl }) {
  const lines = [markerLine(marker), digestMarker(digest, digestPrefix), ""];
  lines.push(intro && String(intro).trim() ? String(intro) : DEFAULT_INTRO);
  lines.push("");
  if (runUrl && String(runUrl).trim()) {
    lines.push(`Latest run: ${String(runUrl).trim()}`);
    lines.push("");
  }
  lines.push(detail && String(detail).trim() ? String(detail) : "_(no detail provided)_");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// gh CLI adapter — thin, so the verdict above stays pure and testable.
// ---------------------------------------------------------------------------

function gh(args, { repo }) {
  return execFileSync("gh", [...args, "--repo", repo], { encoding: "utf8" });
}

/**
 * Find the single open issue carrying the tracker marker (null if none).
 *
 * @param {{repo: string, labels?: string[], marker: string}} args
 * @param {Function} [runner]
 * @returns {{number: number, body: string}|null}
 */
export function findTrackingIssue({ repo, labels, marker }, runner = gh) {
  const line = markerLine(marker);
  const searchLabels = (labels || []).filter(Boolean);
  const args = [
    "issue",
    "list",
    "--state",
    "open",
    "--search",
    `"${line}" in:body`,
    "--json",
    "number,body",
    "--limit",
    "50",
  ];
  for (const l of searchLabels) args.push("--label", l);
  let out;
  try {
    out = runner(args, { repo });
  } catch (e) {
    throw new Error(`gh issue list failed: ${e.message}`);
  }
  const issues = JSON.parse(out || "[]");
  // The `in:body` search is a hint, not an exact match — confirm the marker.
  return issues.find((i) => (i.body || "").includes(line)) || null;
}

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

/**
 * Resolve the whole input contract from an environment bag. Pure, so a test
 * can assert the derivation (precedence, defaults, digest fallback) without
 * mutating `process.env`.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{marker: string, digestPrefix: string, failedItems: string[], digest: string, repo: string, branch: string, title: string, labels: string[], runUrl: string, intro: string, detail: string, closeComment: string, unchangedBehavior: string, commentOnChange: boolean, dryRun: boolean, error: string|null}}
 */
export function resolveConfig(env) {
  const marker = markerKey(env.TRACK_MARKER || "");
  const repo = String(env.TRACK_REPO || "").trim();

  let failedItems = null;
  let error = null;

  const rawItems = String(env.TRACK_FAILED_ITEMS ?? "").trim();
  if (rawItems !== "") {
    try {
      const parsed = JSON.parse(rawItems);
      if (!Array.isArray(parsed)) throw new Error("not a JSON array");
      failedItems = parsed.map((v) => String(v));
    } catch (e) {
      error = `TRACK_FAILED_ITEMS must be a JSON string array: ${e.message}`;
    }
  }

  const rawJobs = String(env.TRACK_JOB_RESULTS ?? "").trim();
  if (failedItems === null && rawJobs !== "" && error === null) {
    try {
      failedItems = failingJobs(JSON.parse(rawJobs));
    } catch (e) {
      error = `TRACK_JOB_RESULTS must be a JSON object (toJSON(needs)): ${e.message}`;
    }
  }
  if (failedItems === null) failedItems = [];

  const explicitDigest = String(env.TRACK_DIGEST ?? "").trim();

  return {
    marker,
    digestPrefix: String(env.TRACK_DIGEST_PREFIX || "").trim() || defaultDigestPrefix(marker),
    failedItems,
    digest: explicitDigest || computeDigest(failedItems),
    repo,
    branch: String(env.TRACK_BRANCH || "main").trim(),
    title: String(env.TRACK_TITLE || "Tracked failures").trim(),
    labels: String(env.TRACK_LABELS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    runUrl: String(env.TRACK_RUN_URL || "").trim(),
    intro: String(env.TRACK_BODY_INTRO || ""),
    detail: String(env.TRACK_BODY_DETAIL || ""),
    closeComment: String(env.TRACK_CLOSE_COMMENT || "").trim() || DEFAULT_CLOSE_COMMENT,
    unchangedBehavior: String(env.TRACK_UNCHANGED_BEHAVIOR || "noop").trim() === "refresh"
      ? "refresh"
      : "noop",
    commentOnChange: String(env.TRACK_COMMENT_ON_CHANGE || "").trim() === "true",
    dryRun: String(env.TRACK_DRY_RUN || "").trim() === "true",
    error,
  };
}

/**
 * Render one `KEY=value` entry for `$GITHUB_ENV`, escalating to the heredoc
 * form for a multi-line value. Exported because presets compose their env
 * hand-off from it and a broken delimiter silently truncates a body.
 *
 * @param {string} key
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
export function renderEnvEntry(key, value) {
  const v = String(value ?? "");
  if (!v.includes("\n")) return `${key}=${v}\n`;
  const delimiter = `${key}_EOF_7f3a`;
  if (v.includes(delimiter)) {
    throw new Error(`value for ${key} contains the heredoc delimiter ${delimiter}`);
  }
  return `${key}<<${delimiter}\n${v}\n${delimiter}\n`;
}

/**
 * Append `KEY=value` entries to the `$GITHUB_ENV` file so subsequent steps in
 * the same composite see them.
 *
 * @param {Array<[string, string]>} entries
 * @param {string|undefined} githubEnvPath
 */
export function writeGithubEnv(entries, githubEnvPath) {
  if (!githubEnvPath) throw new Error("GITHUB_ENV is not set — cannot hand values to the next step");
  appendFileSync(githubEnvPath, entries.map(([k, v]) => renderEnvEntry(k, v)).join(""), "utf8");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(env = process.env) {
  const cfg = resolveConfig(env);

  if (cfg.error !== null) {
    console.error(`::error::${cfg.error}`);
    return 1;
  }
  if (!cfg.marker) {
    console.error("::error::TRACK_MARKER is required (the key the tracked issue is discovered by).");
    return 1;
  }
  if (!cfg.repo) {
    console.error("::error::TRACK_REPO is required (owner/repo of the tracking target).");
    return 1;
  }

  const existing = findTrackingIssue({ repo: cfg.repo, labels: cfg.labels, marker: cfg.marker });
  const verdict = decideVerdict(
    existing,
    { failedCount: cfg.failedItems.length, digest: cfg.digest },
    { digestPrefix: cfg.digestPrefix, unchangedBehavior: cfg.unchangedBehavior },
  );
  console.log(`track-issue: ${verdict.action} — ${verdict.reason}`);

  if (cfg.dryRun) {
    console.log(`(dry-run) would ${verdict.action}` + (existing ? ` issue #${existing.number}` : ""));
    return 0;
  }

  const body = buildIssueBody({
    marker: cfg.marker,
    digestPrefix: cfg.digestPrefix,
    digest: cfg.digest,
    intro: cfg.intro,
    detail: cfg.detail,
    runUrl: cfg.runUrl,
  });
  const repo = cfg.repo;

  switch (verdict.action) {
    case "create": {
      const args = ["issue", "create", "--title", cfg.title, "--body", body];
      for (const l of cfg.labels) args.push("--label", l);
      const out = gh(args, { repo });
      console.log(`Opened tracking issue: ${out.trim()}`);
      return 0;
    }
    case "update": {
      gh(["issue", "edit", String(existing.number), "--body", body], { repo });
      console.log(`Updated tracking issue #${existing.number} (${verdict.reason}).`);
      if (cfg.commentOnChange && verdict.changed) {
        gh(
          [
            "issue",
            "comment",
            String(existing.number),
            "--body",
            `🔁 The failing set changed: ${cfg.failedItems.join(", ")}.`,
          ],
          { repo },
        );
      }
      return 0;
    }
    case "close": {
      gh(["issue", "comment", String(existing.number), "--body", cfg.closeComment], { repo });
      gh(["issue", "close", String(existing.number), "--reason", "completed"], { repo });
      console.log(`Closed tracking issue #${existing.number} — failing set cleared.`);
      return 0;
    }
    case "noop":
    default:
      return 0;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
