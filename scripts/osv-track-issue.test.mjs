// Unit coverage for the OSV tracking-issue upsert verdict (Story #310).
//
// The whole point of the scheduled advisory workflow is a SINGLE tracking
// issue that does not spam: it must open once, stay quiet while the finding
// set is unchanged, update only on a real change, and close when the set
// clears. That contract is the pure `decideVerdict` function — these tests
// pin every branch of it, plus the marker round-trip and the gh-driven
// lookup, without any network access.
//
// Story #389 moved that state machine into the generic
// `.github/actions/track-issue` core and reduced this module to a preset over
// it. Every test below predates that move and is retained verbatim: passing
// unmodified is the evidence that the extraction preserved the OSV verdict
// contract rather than rewriting it. The sections appended at the end cover
// what the move newly put at risk — marker continuity against a LIVE advisory
// issue, and the findings-envelope adapter.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideVerdict,
  extractDigest,
  digestMarker,
  buildIssueBody,
  buildEnvUpdates,
  findTrackingIssue,
  DIGEST_PREFIX,
  TRACKER_MARKER,
  TRACKER_MARKER_KEY,
} from "../.github/actions/osv-track-issue/osv-track-issue.mjs";

const issueWithDigest = (number, digest) => ({
  number,
  body: buildIssueBody({ digest, summary: "…", repo: "acme/app", branch: "main" }),
});

test("CREATE when blocking findings exist and no tracking issue is open", () => {
  const v = decideVerdict(null, { blockingCount: 2, digest: "abcd1234-2" });
  assert.equal(v.action, "create");
});

test("NOOP when the open issue already reflects this exact finding set", () => {
  const existing = issueWithDigest(42, "abcd1234-2");
  const v = decideVerdict(existing, { blockingCount: 2, digest: "abcd1234-2" });
  assert.equal(v.action, "noop");
});

test("UPDATE when the finding-set digest changed since the issue was written", () => {
  const existing = issueWithDigest(42, "abcd1234-2");
  const v = decideVerdict(existing, { blockingCount: 3, digest: " zzzz9999-3".trim() });
  assert.equal(v.action, "update");
});

test("CLOSE when the blocking set is now empty but an issue is still open", () => {
  const existing = issueWithDigest(42, "abcd1234-2");
  const v = decideVerdict(existing, { blockingCount: 0, digest: "empty-0" });
  assert.equal(v.action, "close");
});

test("NOOP when there are no blocking findings and no issue to close", () => {
  const v = decideVerdict(null, { blockingCount: 0, digest: "empty-0" });
  assert.equal(v.action, "noop");
});

test("a finding set of only allow-list-suppressed advisories never opens an issue", () => {
  // Suppressed / below-gate findings do not count toward blockingCount, so the
  // gate hands this path blockingCount: 0 — verdict must be close/noop, not create.
  assert.equal(decideVerdict(null, { blockingCount: 0, digest: "empty-0" }).action, "noop");
  const existing = issueWithDigest(7, "abcd1234-1");
  assert.equal(decideVerdict(existing, { blockingCount: 0, digest: "empty-0" }).action, "close");
});

test("the digest marker round-trips through a rendered issue body", () => {
  assert.match(digestMarker("deadbeef-4"), /mandrel:osv-advisory-digest: deadbeef-4/);
  const body = buildIssueBody({ digest: "deadbeef-4", summary: "s", repo: "a/b", branch: "main" });
  assert.ok(body.includes(TRACKER_MARKER));
  assert.equal(extractDigest(body), "deadbeef-4");
  assert.equal(extractDigest("no markers here"), null);
});

test("findTrackingIssue confirms the marker rather than trusting the search hint", () => {
  const calls = [];
  const runner = (args, opts) => {
    calls.push({ args, opts });
    // gh's `in:body` search is fuzzy — return one true match and one false positive.
    return JSON.stringify([
      { number: 99, body: "unrelated issue mentioning osv-advisory in prose" },
      { number: 100, body: `${TRACKER_MARKER}\n${digestMarker("x-1")}\nbody` },
    ]);
  };
  const found = findTrackingIssue({ repo: "acme/app", labels: ["security"] }, runner);
  assert.equal(found.number, 100);
  // The label scope is forwarded to gh.
  assert.ok(calls[0].args.includes("--label"));
  assert.ok(calls[0].args.includes("security"));
});

test("findTrackingIssue returns null when nothing carries the marker", () => {
  const runner = () => JSON.stringify([{ number: 1, body: "no marker" }]);
  assert.equal(findTrackingIssue({ repo: "acme/app", labels: [] }, runner), null);
});

// ---------------------------------------------------------------------------
// Story #389 — marker continuity across the extraction
//
// These two strings are what a LIVE advisory issue in a consumer repo is keyed
// on. A changed byte in either would leave that issue undiscoverable, so the
// next scheduled run would open a SECOND one — the exact duplicate-spam
// failure this action exists to prevent. They are therefore asserted as
// literals, not derived from the module under test.
// ---------------------------------------------------------------------------

test("the tracker marker is byte-identical to the live one", () => {
  assert.equal(TRACKER_MARKER, "<!-- mandrel:osv-advisory-tracker -->");
  assert.equal(TRACKER_MARKER_KEY, "mandrel:osv-advisory-tracker");
  assert.equal(DIGEST_PREFIX, "mandrel:osv-advisory-digest:");
});

test("a rendered OSV body round-trips its digest through the live digest prefix", () => {
  const body = buildIssueBody({
    digest: "cafe1234-3",
    summary: "| advisory | package |",
    repo: "acme/app",
    branch: "main",
  });

  assert.ok(body.includes("<!-- mandrel:osv-advisory-tracker -->"));
  assert.ok(body.includes("<!-- mandrel:osv-advisory-digest: cafe1234-3 -->"));
  assert.equal(extractDigest(body), "cafe1234-3");
});

test("the OSV body is unchanged by the extraction — markers, prose, then summary", () => {
  // Pinned against the shape the pre-#389 module produced. A silent body
  // rewrite would churn every consumer's tracking issue on the next run.
  const body = buildIssueBody({
    digest: "d-1",
    summary: "SUMMARY-BLOCK",
    repo: "acme/app",
    branch: "trunk",
  });

  assert.equal(
    body,
    [
      "<!-- mandrel:osv-advisory-tracker -->",
      "<!-- mandrel:osv-advisory-digest: d-1 -->",
      "",
      "Scheduled OSV advisory scan of `acme/app` (default branch `trunk`) found advisories at or",
      "above the configured gate. This issue is maintained automatically by the",
      "`advisory-scan.yml` reusable workflow — it is updated when the finding set changes",
      "and closed automatically when the set clears. Do not edit the markers above.",
      "",
      "SUMMARY-BLOCK",
    ].join("\n"),
  );
});

test("an empty summary still renders the historical placeholder", () => {
  const body = buildIssueBody({ digest: "d-1", summary: "", repo: "a/b", branch: "main" });
  assert.match(body, /_\(no summary provided\)_/);
});

// ---------------------------------------------------------------------------
// Story #389 — the findings-envelope adapter
//
// This module no longer performs the upsert; it translates the osv-scan
// envelope into the generic TRACK_* contract and hands it to the shared core.
// ---------------------------------------------------------------------------

/** Collapse the adapter's entry list into a lookup for assertion. */
const asMap = (entries) => Object.fromEntries(entries);

test("the adapter forwards the live marker and digest prefix verbatim", () => {
  const env = asMap(
    buildEnvUpdates({ digest: "abc123", counts: { blocking: 2 }, failOn: "high", summary: "s" }, {
      OSV_TRACK_REPO: "acme/app",
    }),
  );

  assert.equal(env.TRACK_MARKER, "mandrel:osv-advisory-tracker");
  assert.equal(env.TRACK_DIGEST_PREFIX, "mandrel:osv-advisory-digest:");
});

test("the adapter passes the scanner's own digest rather than deriving one", () => {
  // The scanner digest depends on finding identity (id + package + version +
  // source); a derived one over a count-shaped label would churn on nothing.
  const env = asMap(
    buildEnvUpdates({ digest: "scanner-digest", counts: { blocking: 3 }, failOn: "high" }, {
      OSV_TRACK_REPO: "acme/app",
    }),
  );
  assert.equal(env.TRACK_DIGEST, "scanner-digest");
});

test("a blocking count of zero yields an empty failing set", () => {
  const env = asMap(
    buildEnvUpdates({ digest: "empty-0", counts: { blocking: 0 }, failOn: "high" }, {
      OSV_TRACK_REPO: "acme/app",
    }),
  );
  assert.deepEqual(JSON.parse(env.TRACK_FAILED_ITEMS), []);
});

test("a non-zero blocking count yields a non-empty failing set", () => {
  const env = asMap(
    buildEnvUpdates({ digest: "d", counts: { blocking: 4 }, failOn: "critical" }, {
      OSV_TRACK_REPO: "acme/app",
    }),
  );
  const items = JSON.parse(env.TRACK_FAILED_ITEMS);
  assert.equal(items.length, 1);
  assert.match(items[0], /4 advisory finding\(s\) at or above the 'critical' gate/);
});

test("the adapter neither refreshes on an unchanged set nor comments on change", () => {
  // Both knobs default to today's OSV posture, so the preset must set neither.
  const env = asMap(buildEnvUpdates({ digest: "d", counts: { blocking: 1 } }, { OSV_TRACK_REPO: "a/b" }));
  assert.equal(env.TRACK_UNCHANGED_BEHAVIOR, undefined);
  assert.equal(env.TRACK_COMMENT_ON_CHANGE, undefined);
  assert.equal(env.TRACK_RUN_URL, undefined, "no run link — the body stays byte-stable across runs");
});

test("the adapter carries the caller's title, labels and branch through", () => {
  const env = asMap(
    buildEnvUpdates({ digest: "d", counts: { blocking: 1 } }, {
      OSV_TRACK_REPO: "acme/app",
      OSV_TRACK_BRANCH: "trunk",
      OSV_TRACK_TITLE: "Custom title",
      OSV_TRACK_LABELS: "security,ops",
    }),
  );

  assert.equal(env.TRACK_REPO, "acme/app");
  assert.equal(env.TRACK_BRANCH, "trunk");
  assert.equal(env.TRACK_TITLE, "Custom title");
  assert.equal(env.TRACK_LABELS, "security,ops");
  assert.match(env.TRACK_BODY_INTRO, /Scheduled OSV advisory scan of `acme\/app` \(default branch `trunk`\)/);
  assert.match(env.TRACK_CLOSE_COMMENT, /no longer reports any finding at or above the gate/);
});

test("the adapter defaults the title to the documented one when the caller omits it", () => {
  const env = asMap(buildEnvUpdates({ digest: "d", counts: { blocking: 1 } }, { OSV_TRACK_REPO: "a/b" }));
  assert.equal(env.TRACK_TITLE, "OSV advisory scan — default branch findings");
  assert.equal(env.TRACK_BRANCH, "main");
});
