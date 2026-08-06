#!/usr/bin/env node
/**
 * OSV advisory preset over the generic single-issue failure tracker
 * (Story #310, generalized in Story #389).
 *
 * The scheduled advisory-scan.yml workflow runs the osv-scan composite in
 * non-blocking mode against the default branch, then hands the findings here.
 * Everything about the "one tracked issue, never a second one" state machine —
 * the four-way verdict, the marker/digest contract, the gh adapter — now lives
 * in the sibling `.github/actions/track-issue/track-issue.mjs`, because that
 * behaviour is useful to any non-gating scheduled workflow and was reachable
 * only through this OSV-shaped input contract.
 *
 * What remains here is the ADAPTER: it converts the osv-scan findings envelope
 * (`counts.blocking` / `digest` / `summary` / `failOn`) into the generic env
 * contract and hands it to the next composite step through `$GITHUB_ENV`. It
 * also re-exports the core's named symbols BOUND to the OSV marker and digest
 * prefix, so the pre-existing verdict suite keeps importing the same names
 * from this same path.
 *
 * Marker continuity is load-bearing. `<!-- mandrel:osv-advisory-tracker -->`
 * and `mandrel:osv-advisory-digest:` are what a LIVE advisory issue in a
 * consumer repo is keyed on: changing either byte would leave that issue
 * undiscoverable and open a second one.
 *
 * Allow-list-suppressed and below-gate findings never open or reopen an issue;
 * they are context in the body, not a reason to raise.
 */

import { readFileSync } from "node:fs";

import {
  buildIssueBody as buildGenericIssueBody,
  decideVerdict as decideGenericVerdict,
  digestMarker as genericDigestMarker,
  extractDigest as genericExtractDigest,
  findTrackingIssue as findGenericTrackingIssue,
  markerLine,
  writeGithubEnv,
} from "../track-issue/track-issue.mjs";

/** Bare marker key handed to the generic action as its `marker` input. */
export const TRACKER_MARKER_KEY = "mandrel:osv-advisory-tracker";

/** The rendered discovery marker a live advisory issue carries. */
export const TRACKER_MARKER = markerLine(TRACKER_MARKER_KEY);

/**
 * The live digest prefix. Passed to the generic action explicitly rather than
 * derived: the live pair (`…-tracker` / `…-digest:`) is not derivable from
 * either half, and deriving it would silently orphan every existing issue.
 */
export const DIGEST_PREFIX = "mandrel:osv-advisory-digest:";

/** Embed the change-detection digest as a discoverable HTML comment. */
export const digestMarker = (digest) => genericDigestMarker(digest, DIGEST_PREFIX);

/** Recover the digest a previously-filed issue body carries (null if none). */
export const extractDigest = (body) => genericExtractDigest(body, DIGEST_PREFIX);

/**
 * Pure upsert decision, in OSV vocabulary.
 *
 * @param {{number: number, body: string}|null} existing The open marked issue, or null.
 * @param {{blockingCount: number, digest: string}} findings
 * @returns {{action: 'create'|'update'|'noop'|'close', reason: string, changed: boolean}}
 */
export function decideVerdict(existing, findings) {
  return decideGenericVerdict(
    existing,
    { failedCount: Number(findings?.blockingCount ?? 0), digest: findings?.digest },
    { digestPrefix: DIGEST_PREFIX, unchangedBehavior: "noop" },
  );
}

/** The prose the advisory issue body carries under its markers. */
export const buildIntro = (repo, branch) =>
  [
    `Scheduled OSV advisory scan of \`${repo}\` (default branch \`${branch}\`) found advisories at or`,
    "above the configured gate. This issue is maintained automatically by the",
    "`advisory-scan.yml` reusable workflow — it is updated when the finding set changes",
    "and closed automatically when the set clears. Do not edit the markers above.",
  ].join("\n");

/** The comment posted immediately before the advisory issue is closed. */
export const buildCloseComment = (repo) =>
  `✅ The scheduled OSV advisory scan of \`${repo}\` no longer reports any finding at or above the gate. Closing automatically.`;

/**
 * Compose the advisory tracking-issue body.
 *
 * @param {{digest: string, summary: string, repo: string, branch: string}} args
 * @returns {string}
 */
export function buildIssueBody({ digest, summary, repo, branch }) {
  return buildGenericIssueBody({
    marker: TRACKER_MARKER_KEY,
    digestPrefix: DIGEST_PREFIX,
    digest,
    intro: buildIntro(repo, branch),
    detail: summary || "_(no summary provided)_",
  });
}

/** Find the single open issue carrying the advisory tracker marker. */
export function findTrackingIssue({ repo, labels }, runner) {
  return findGenericTrackingIssue({ repo, labels, marker: TRACKER_MARKER_KEY }, runner);
}

// ---------------------------------------------------------------------------
// Adapter — osv-scan findings envelope → the generic env contract
// ---------------------------------------------------------------------------

/**
 * Translate the findings envelope plus this step's own inputs into the
 * `TRACK_*` entries the generic tracker reads.
 *
 * The failing SET is a single count-derived label rather than a list of
 * advisory ids: the envelope carries counts, not identities. That costs
 * nothing, because `TRACK_DIGEST` is supplied explicitly from the scanner's own
 * finding-identity digest — the item names never drive change detection here.
 *
 * @param {object} findings Parsed osv-scan findings envelope.
 * @param {Record<string, string|undefined>} env
 * @returns {Array<[string, string]>}
 */
export function buildEnvUpdates(findings, env) {
  const repo = String(env.OSV_TRACK_REPO || "").trim();
  const branch = String(env.OSV_TRACK_BRANCH || "main").trim();
  const blockingCount = Number(findings?.counts?.blocking ?? findings?.blockingCount ?? 0);
  const failOn = String(findings?.failOn || "the configured");
  const failedItems =
    blockingCount > 0
      ? [`${blockingCount} advisory finding(s) at or above the '${failOn}' gate`]
      : [];

  return [
    ["TRACK_MARKER", TRACKER_MARKER_KEY],
    ["TRACK_DIGEST_PREFIX", DIGEST_PREFIX],
    ["TRACK_FAILED_ITEMS", JSON.stringify(failedItems)],
    ["TRACK_DIGEST", String(findings?.digest ?? "empty-0")],
    ["TRACK_REPO", repo],
    ["TRACK_BRANCH", branch],
    ["TRACK_TITLE", String(env.OSV_TRACK_TITLE || "OSV advisory scan — default branch findings")],
    ["TRACK_LABELS", String(env.OSV_TRACK_LABELS || "")],
    ["TRACK_BODY_INTRO", buildIntro(repo, branch)],
    ["TRACK_BODY_DETAIL", String(findings?.summary ?? "") || "_(no summary provided)_"],
    ["TRACK_CLOSE_COMMENT", buildCloseComment(repo)],
    ["TRACK_DRY_RUN", String(env.OSV_TRACK_DRY_RUN || "").trim() === "true" ? "true" : "false"],
  ];
}

export function main(env = process.env) {
  const findingsPath = env.OSV_FINDINGS_PATH;

  if (!String(env.OSV_TRACK_REPO || "").trim()) {
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

  try {
    writeGithubEnv(buildEnvUpdates(findings, env), env.GITHUB_ENV);
  } catch (e) {
    console.error(`::error::Could not hand the advisory signal to the tracker step: ${e.message}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
