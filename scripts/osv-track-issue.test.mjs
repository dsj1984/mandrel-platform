// Unit coverage for the OSV tracking-issue upsert verdict (Story #310).
//
// The whole point of the scheduled advisory workflow is a SINGLE tracking
// issue that does not spam: it must open once, stay quiet while the finding
// set is unchanged, update only on a real change, and close when the set
// clears. That contract is the pure `decideVerdict` function — these tests
// pin every branch of it, plus the marker round-trip and the gh-driven
// lookup, without any network access.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideVerdict,
  extractDigest,
  digestMarker,
  buildIssueBody,
  findTrackingIssue,
  TRACKER_MARKER,
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
