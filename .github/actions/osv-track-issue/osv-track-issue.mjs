#!/usr/bin/env node
/**
 * Tracking-issue upsert for the scheduled OSV advisory scan (Story #310).
 *
 * The scheduled advisory-scan.yml workflow runs the osv-scan composite in
 * non-blocking mode against the default branch, then hands the findings here.
 * This module keeps a SINGLE tracking issue in sync with the current blocking
 * finding set:
 *
 *   • blocking findings present, no marked open issue  → CREATE one
 *   • blocking findings present, marked issue, same set → NOOP (no daily spam)
 *   • blocking findings present, marked issue, new set  → UPDATE its body
 *   • blocking set now empty, marked issue open         → CLOSE with a comment
 *   • blocking set empty, no marked issue               → NOOP
 *
 * The decision is a pure function of (existing issue, finding set), so the
 * idempotence contract is unit-tested without any network access
 * (scripts/osv-track-issue.test.mjs). `main()` only translates the verdict
 * into `gh` CLI calls.
 *
 * The issue is discovered by an HTML-comment MARKER in its body, and the
 * change-detection key is the findings DIGEST embedded as a second marker —
 * so a run over an unchanged advisory set rewrites nothing. Allow-list-
 * suppressed and below-gate findings never open or reopen an issue; they are
 * context in the body, not a reason to raise.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const TRACKER_MARKER = "<!-- mandrel:osv-advisory-tracker -->";
const DIGEST_PREFIX = "mandrel:osv-advisory-digest:";

/** Embed the change-detection digest as a discoverable HTML comment. */
export const digestMarker = (digest) => `<!-- ${DIGEST_PREFIX} ${digest} -->`;

/** Recover the digest a previously-filed issue body carries (null if none). */
export function extractDigest(body) {
  if (!body) return null;
  const m = body.match(new RegExp(`<!--\\s*${DIGEST_PREFIX}\\s*(\\S+)\\s*-->`));
  return m ? m[1] : null;
}

/**
 * Pure upsert decision.
 *
 * @param {object|null} existing  The open marked issue ({ number, body }) or null.
 * @param {object} findings       { blockingCount, digest }.
 * @returns {{ action: 'create'|'update'|'noop'|'close', reason: string }}
 */
export function decideVerdict(existing, findings) {
  const blocking = Number(findings?.blockingCount ?? 0);

  if (blocking > 0) {
    if (!existing) return { action: "create", reason: "blocking findings and no open tracking issue" };
    const prevDigest = extractDigest(existing.body);
    if (prevDigest === findings.digest) {
      return { action: "noop", reason: "tracking issue already reflects this finding set" };
    }
    return { action: "update", reason: "finding set changed since the tracking issue was last written" };
  }

  // No blocking findings.
  if (existing) return { action: "close", reason: "blocking finding set is now empty" };
  return { action: "noop", reason: "no blocking findings and no tracking issue to close" };
}

/**
 * Compose the tracking-issue body: the two markers, then the rendered
 * advisory summary from the osv-scan findings JSON.
 */
export function buildIssueBody({ digest, summary, repo, branch }) {
  return [
    TRACKER_MARKER,
    digestMarker(digest),
    "",
    `Scheduled OSV advisory scan of \`${repo}\` (default branch \`${branch}\`) found advisories at or`,
    "above the configured gate. This issue is maintained automatically by the",
    "`advisory-scan.yml` reusable workflow — it is updated when the finding set changes",
    "and closed automatically when the set clears. Do not edit the markers above.",
    "",
    summary || "_(no summary provided)_",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// gh CLI adapter — thin, so the verdict above stays pure and testable.
// ---------------------------------------------------------------------------

function gh(args, { repo }) {
  return execFileSync("gh", [...args, "--repo", repo], { encoding: "utf8" });
}

/** Find the single open issue carrying the tracker marker (null if none). */
export function findTrackingIssue({ repo, labels }, runner = gh) {
  const searchLabels = (labels || []).filter(Boolean);
  const args = [
    "issue",
    "list",
    "--state",
    "open",
    "--search",
    `"${TRACKER_MARKER}" in:body`,
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
  return issues.find((i) => (i.body || "").includes(TRACKER_MARKER)) || null;
}

export function main() {
  const findingsPath = process.env.OSV_FINDINGS_PATH;
  const repo = process.env.OSV_TRACK_REPO;
  const branch = process.env.OSV_TRACK_BRANCH || "main";
  const title = process.env.OSV_TRACK_TITLE || "OSV advisory scan — default branch findings";
  const labels = (process.env.OSV_TRACK_LABELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const dryRun = String(process.env.OSV_TRACK_DRY_RUN || "").trim() === "true";

  if (!repo) {
    console.error("::error::OSV_TRACK_REPO is required (owner/repo of the tracking target).");
    return 1;
  }

  let findings;
  try {
    findings = JSON.parse(readFileSync(findingsPath, "utf8"));
  } catch (e) {
    console.error(`::error::Could not read findings JSON "${findingsPath}": ${e.message}`);
    return 1;
  }

  const blockingCount = Number(findings?.counts?.blocking ?? findings?.blockingCount ?? 0);
  const digest = findings?.digest ?? "empty-0";
  const summary = findings?.summary ?? "";

  const existing = findTrackingIssue({ repo, labels });
  const verdict = decideVerdict(existing, { blockingCount, digest });
  console.log(`osv-track-issue: ${verdict.action} — ${verdict.reason}`);

  if (dryRun) {
    console.log(`(dry-run) would ${verdict.action}` + (existing ? ` issue #${existing.number}` : ""));
    return 0;
  }

  const body = buildIssueBody({ digest, summary, repo, branch });

  switch (verdict.action) {
    case "create": {
      const args = ["issue", "create", "--title", title, "--body", body];
      for (const l of labels) args.push("--label", l);
      const out = gh(args, { repo });
      console.log(`Opened tracking issue: ${out.trim()}`);
      return 0;
    }
    case "update": {
      gh(["issue", "edit", String(existing.number), "--body", body], { repo });
      console.log(`Updated tracking issue #${existing.number} (finding set changed).`);
      return 0;
    }
    case "close": {
      gh(
        [
          "issue",
          "comment",
          String(existing.number),
          "--body",
          `✅ The scheduled OSV advisory scan of \`${repo}\` no longer reports any finding at or above the gate. Closing automatically.`,
        ],
        { repo },
      );
      gh(["issue", "close", String(existing.number), "--reason", "completed"], { repo });
      console.log(`Closed tracking issue #${existing.number} — advisory set cleared.`);
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
