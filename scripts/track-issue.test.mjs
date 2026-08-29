// Unit coverage for the generic single-issue failure tracker (Story #389).
//
// The whole point of this action is a SINGLE tracked issue that does not spam:
// it must open once, stay quiet while the failing set is unchanged, update only
// on a real change, and close when the set clears. That contract is the pure
// `decideVerdict` function — these tests pin every branch of it, plus the
// failing-set derivation, the digest, the marker round-trip and the gh-driven
// lookup, without any network access.
//
// Run: node --test scripts/track-issue.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CLOSE_COMMENT,
  DEFAULT_INTRO,
  buildIssueBody,
  computeDigest,
  decideVerdict,
  defaultDigestPrefix,
  digestMarker,
  extractDigest,
  failingJobs,
  findTrackingIssue,
  markerKey,
  markerLine,
  parseIssueNumberFromUrl,
  renderEnvEntry,
  resolveConfig,
  resolveTrackerOutputs,
  writeGithubEnv,
  writeGithubOutput,
} from "../.github/actions/track-issue/track-issue.mjs";

const MARKER = "acme:nightly-tracker";
const PREFIX = defaultDigestPrefix(MARKER);
const OPTS = { digestPrefix: PREFIX };

/** An open tracked issue whose body carries `digest`. */
const issueWithDigest = (number, digest) => ({
  number,
  body: buildIssueBody({ marker: MARKER, digestPrefix: PREFIX, digest, detail: "…" }),
});

// ---------------------------------------------------------------------------
// AC-3 — the four-way state machine survives the extraction unchanged
// ---------------------------------------------------------------------------

test("CREATE when items are failing and no tracking issue is open", () => {
  const v = decideVerdict(null, { failedCount: 2, digest: "abcd1234" }, OPTS);
  assert.equal(v.action, "create");
});

test("UPDATE when the failing-set digest changed since the issue was written", () => {
  const existing = issueWithDigest(42, "abcd1234");
  const v = decideVerdict(existing, { failedCount: 3, digest: "zzzz9999" }, OPTS);
  assert.equal(v.action, "update");
});

test("CLOSE when the failing set is now empty but an issue is still open", () => {
  const existing = issueWithDigest(42, "abcd1234");
  const v = decideVerdict(existing, { failedCount: 0, digest: "green-0" }, OPTS);
  assert.equal(v.action, "close");
});

test("NOOP when nothing is failing and there is no issue to close", () => {
  const v = decideVerdict(null, { failedCount: 0, digest: "green-0" }, OPTS);
  assert.equal(v.action, "noop");
});

// ---------------------------------------------------------------------------
// AC-4 — the never-a-second-issue invariant, asserted on the core
// ---------------------------------------------------------------------------

test("two consecutive failing runs against an open marked issue never yield CREATE", () => {
  // Run 1 opens the issue; the tracker then finds it on every subsequent run.
  assert.equal(decideVerdict(null, { failedCount: 1, digest: "d1" }, OPTS).action, "create");
  const open = issueWithDigest(7, "d1");

  // Run 2 — same failing set. Run 3 — a DIFFERENT failing set. Neither may
  // create: a second issue is the duplicate-spam failure this action prevents.
  const second = decideVerdict(open, { failedCount: 1, digest: "d1" }, OPTS);
  const third = decideVerdict(open, { failedCount: 4, digest: "d2" }, OPTS);

  assert.equal(second.action, "noop");
  assert.equal(third.action, "update");
  for (const v of [second, third]) assert.notEqual(v.action, "create");
});

test("an unparseable body never yields CREATE while an issue is open", () => {
  // A human editing the body away is not a licence to open a second issue: the
  // marker still found the issue, so the worst case is a redundant UPDATE.
  const mangled = { number: 9, body: "someone deleted the digest marker" };
  assert.equal(decideVerdict(mangled, { failedCount: 2, digest: "d9" }, OPTS).action, "update");
});

// ---------------------------------------------------------------------------
// AC-5 — only `failure` counts; cancelled/skipped are not failures
// ---------------------------------------------------------------------------

test("failingJobs counts only entries whose result is exactly `failure`", () => {
  const needs = {
    build: { result: "success" },
    test: { result: "failure" },
    deploy: { result: "cancelled" },
    docs: { result: "skipped" },
    lint: { result: "failure" },
  };
  assert.deepEqual(failingJobs(needs), ["lint", "test"]);
});

test("a job-results payload of only cancelled/skipped never yields CREATE", () => {
  // A self-hosted fleet going down produces a wall of `cancelled` — raising an
  // issue for that is precisely the noise this tracker exists to avoid.
  const noise = { a: { result: "cancelled" }, b: { result: "skipped" }, c: { result: "success" } };
  const failed = failingJobs(noise);
  assert.deepEqual(failed, []);

  const digest = computeDigest(failed);
  assert.equal(
    decideVerdict(null, { failedCount: failed.length, digest }, OPTS).action,
    "noop",
    "no open issue → nothing to do",
  );
  assert.equal(
    decideVerdict(issueWithDigest(3, "d1"), { failedCount: failed.length, digest }, OPTS).action,
    "close",
    "an open issue is closed, because nothing is actually failing",
  );
});

test("resolveConfig derives an empty failing set from an all-cancelled job payload", () => {
  const cfg = resolveConfig({
    TRACK_MARKER: MARKER,
    TRACK_REPO: "acme/app",
    TRACK_JOB_RESULTS: JSON.stringify({ a: { result: "cancelled" }, b: { result: "skipped" } }),
  });
  assert.deepEqual(cfg.failedItems, []);
  assert.equal(cfg.digest, "green-0");
});

// ---------------------------------------------------------------------------
// AC-6 — unchanged-set behaviour is selectable, defaulting to today's posture
// ---------------------------------------------------------------------------

test("an unchanged digest is NOOP by default", () => {
  const existing = issueWithDigest(42, "same-digest");
  const v = decideVerdict(existing, { failedCount: 2, digest: "same-digest" }, OPTS);
  assert.equal(v.action, "noop");
  assert.equal(v.changed, false);
});

test("the same unchanged digest is UPDATE under `unchanged-behavior: refresh`", () => {
  const existing = issueWithDigest(42, "same-digest");
  const v = decideVerdict(
    existing,
    { failedCount: 2, digest: "same-digest" },
    { ...OPTS, unchangedBehavior: "refresh" },
  );
  assert.equal(v.action, "update");
  assert.equal(v.changed, false, "a refresh is not a change — it must not fire a change comment");
});

test("resolveConfig defaults unchanged-behavior to noop and rejects an unknown value", () => {
  const base = { TRACK_MARKER: MARKER, TRACK_REPO: "acme/app" };
  assert.equal(resolveConfig(base).unchangedBehavior, "noop");
  assert.equal(resolveConfig({ ...base, TRACK_UNCHANGED_BEHAVIOR: "refresh" }).unchangedBehavior, "refresh");
  assert.equal(
    resolveConfig({ ...base, TRACK_UNCHANGED_BEHAVIOR: "shout" }).unchangedBehavior,
    "noop",
    "an unrecognised value falls back to the quiet posture rather than spamming",
  );
});

// ---------------------------------------------------------------------------
// Marker + digest contract
// ---------------------------------------------------------------------------

test("the action owns both marker lines and they round-trip through a body", () => {
  const body = buildIssueBody({
    marker: MARKER,
    digestPrefix: PREFIX,
    digest: "deadbeef",
    intro: "watching the nightly",
    detail: "one job is red",
  });

  assert.ok(body.includes(markerLine(MARKER)));
  assert.equal(extractDigest(body, PREFIX), "deadbeef");
  assert.equal(extractDigest("no markers here", PREFIX), null);
  assert.match(body, /watching the nightly/);
  assert.match(body, /one job is red/);
});

test("a marker supplied as a rendered comment is not double-wrapped", () => {
  // A caller that hands over `<!-- k -->` must still produce `<!-- k -->` —
  // a double-wrapped marker would never match the live issue again.
  assert.equal(markerKey("<!-- acme:x -->"), "acme:x");
  assert.equal(markerLine("<!-- acme:x -->"), "<!-- acme:x -->");
});

test("the legacy `--!>` comment terminator is stripped, not left in the key", () => {
  // `--!>` closes an HTML comment just as `-->` does. A stripper blind to it
  // leaves a stray `!` in the key, so the rendered marker stops matching the
  // live issue and the next run opens a second one.
  assert.equal(markerKey("<!-- acme:x --!>"), "acme:x");
  assert.equal(markerLine("<!-- acme:x --!>"), "<!-- acme:x -->");
});

test("a digest marker closed with `--!>` is still recovered", () => {
  assert.equal(extractDigest("<!-- acme:d: abc123 --!>", "acme:d:"), "abc123");
});

test("extractDigest skips non-matching comments and needs a single token", () => {
  const body = [
    "<!-- acme:nightly-tracker -->",
    "<!-- unrelated: note -->",
    "<!-- acme:d: two tokens -->",
    "<!-- acme:d: realdigest -->",
  ].join("\n");
  assert.equal(extractDigest(body, "acme:d:"), "realdigest");
  assert.equal(extractDigest("<!-- acme:d: -->", "acme:d:"), null);
  assert.equal(extractDigest("<!-- acme:d: unterminated", "acme:d:"), null);
});

test("the digest prefix defaults from the marker but is overridable", () => {
  assert.equal(defaultDigestPrefix(MARKER), "acme:nightly-tracker-digest:");
  assert.match(digestMarker("abc", "custom:pfx:"), /<!-- custom:pfx: abc -->/);
  assert.equal(extractDigest(digestMarker("abc", "custom:pfx:"), "custom:pfx:"), "abc");
});

test("a regex-special digest prefix is matched literally, not as a pattern", () => {
  const prefix = "acme(v1).digest:";
  assert.equal(extractDigest(digestMarker("xyz", prefix), prefix), "xyz");
  assert.equal(extractDigest("<!-- acmeXv1Yxdigest: xyz -->", prefix), null);
});

test("body defaults fill in when the caller supplies no prose", () => {
  const body = buildIssueBody({ marker: MARKER, digestPrefix: PREFIX, digest: "d" });
  assert.ok(body.includes(DEFAULT_INTRO));
  assert.match(body, /_\(no detail provided\)_/);
  assert.ok(!body.includes("Latest run:"), "an absent run-url omits the line entirely");
});

test("a run-url is rendered only when supplied", () => {
  const body = buildIssueBody({
    marker: MARKER,
    digestPrefix: PREFIX,
    digest: "d",
    runUrl: "https://example.invalid/run/1",
  });
  assert.match(body, /Latest run: https:\/\/example\.invalid\/run\/1/);
});

// ---------------------------------------------------------------------------
// Digest derivation
// ---------------------------------------------------------------------------

test("computeDigest is order-independent and de-duplicating", () => {
  assert.equal(computeDigest(["b", "a"]), computeDigest(["a", "b"]));
  assert.equal(computeDigest(["a", "a", "b"]), computeDigest(["a", "b"]));
  assert.notEqual(computeDigest(["a"]), computeDigest(["a", "b"]));
  assert.match(computeDigest(["a"]), /^[0-9a-f]{12}$/);
});

test("computeDigest marks an empty set legibly rather than hashing nothing", () => {
  assert.equal(computeDigest([]), "green-0");
  assert.equal(computeDigest(undefined), "green-0");
});

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

test("failed-items takes precedence over job-results when both are supplied", () => {
  const cfg = resolveConfig({
    TRACK_MARKER: MARKER,
    TRACK_REPO: "acme/app",
    TRACK_FAILED_ITEMS: JSON.stringify(["explicit"]),
    TRACK_JOB_RESULTS: JSON.stringify({ ignored: { result: "failure" } }),
  });
  assert.deepEqual(cfg.failedItems, ["explicit"]);
});

test("an explicit digest wins over the derived one", () => {
  const cfg = resolveConfig({
    TRACK_MARKER: MARKER,
    TRACK_REPO: "acme/app",
    TRACK_FAILED_ITEMS: JSON.stringify(["a"]),
    TRACK_DIGEST: "caller-supplied",
  });
  assert.equal(cfg.digest, "caller-supplied");
});

test("malformed failed-items is an error, not a silently-empty failing set", () => {
  // Swallowing a parse error here would CLOSE a live tracked issue while the
  // failures it names are still happening.
  const cfg = resolveConfig({
    TRACK_MARKER: MARKER,
    TRACK_REPO: "acme/app",
    TRACK_FAILED_ITEMS: "{not json",
  });
  assert.match(cfg.error, /TRACK_FAILED_ITEMS/);

  const notAnArray = resolveConfig({
    TRACK_MARKER: MARKER,
    TRACK_REPO: "acme/app",
    TRACK_FAILED_ITEMS: '{"a":1}',
  });
  assert.match(notAnArray.error, /JSON string array/);
});

test("malformed job-results is an error rather than an empty failing set", () => {
  const cfg = resolveConfig({
    TRACK_MARKER: MARKER,
    TRACK_REPO: "acme/app",
    TRACK_JOB_RESULTS: "{not json",
  });
  assert.match(cfg.error, /TRACK_JOB_RESULTS/);
});

test("resolveConfig splits labels and defaults the quiet knobs", () => {
  const cfg = resolveConfig({
    TRACK_MARKER: MARKER,
    TRACK_REPO: "acme/app",
    TRACK_LABELS: " ci , ,tracking ",
  });
  assert.deepEqual(cfg.labels, ["ci", "tracking"]);
  assert.equal(cfg.commentOnChange, false);
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.branch, "main");
  assert.equal(cfg.closeComment, DEFAULT_CLOSE_COMMENT);
});

test("renderEnvEntry escalates a multi-line value to the heredoc form", () => {
  assert.equal(renderEnvEntry("K", "one"), "K=one\n");
  const multi = renderEnvEntry("K", "one\ntwo");
  assert.match(multi, /^K<<K_EOF_7f3a\none\ntwo\nK_EOF_7f3a\n$/);
  assert.throws(() => renderEnvEntry("K", "a\nK_EOF_7f3a"), /delimiter/);
});

// ---------------------------------------------------------------------------
// gh lookup
// ---------------------------------------------------------------------------

test("findTrackingIssue confirms the marker rather than trusting the search hint", () => {
  const calls = [];
  const runner = (args, opts) => {
    calls.push({ args, opts });
    // gh's `in:body` search is fuzzy — return one true match and one false positive.
    return JSON.stringify([
      { number: 99, body: "unrelated issue mentioning nightly-tracker in prose" },
      { number: 100, body: `${markerLine(MARKER)}\n${digestMarker("x-1", PREFIX)}\nbody` },
    ]);
  };

  const found = findTrackingIssue({ repo: "acme/app", labels: ["ci"], marker: MARKER }, runner);

  assert.equal(found.number, 100);
  assert.ok(calls[0].args.includes("--label"));
  assert.ok(calls[0].args.includes("ci"));
});

test("findTrackingIssue returns null when nothing carries the marker", () => {
  const runner = () => JSON.stringify([{ number: 1, body: "no marker" }]);
  assert.equal(findTrackingIssue({ repo: "acme/app", labels: [], marker: MARKER }, runner), null);
});

test("findTrackingIssue surfaces a gh failure rather than reporting no issue", () => {
  // Reporting "no issue" on a failed lookup would open a duplicate.
  const runner = () => {
    throw new Error("gh: not authenticated");
  };
  assert.throws(
    () => findTrackingIssue({ repo: "acme/app", labels: [], marker: MARKER }, runner),
    /gh issue list failed/,
  );
});

// ---------------------------------------------------------------------------
// Composite outputs (Story #412)
//
// The tracker's whole purpose is to notify someone, and a caller that wants to
// assign or link the issue previously had to re-discover it with a `gh issue
// list` that races the create this action just made. These pin the pure
// verdict → output mapping that removes the race.
// ---------------------------------------------------------------------------

/** The public vocabulary, written as literals — never derived from the module
 *  under test, or a rename would silently redefine the contract it asserts. */
const PUBLIC_ACTIONS = ["opened", "updated", "closed", "noop"];

test("every state-table row maps to its public action and the right number", () => {
  const existing = { number: 4242, body: "…" };

  // create → opened, number parsed from the URL gh printed.
  assert.deepEqual(
    resolveTrackerOutputs({
      verdict: { action: "create" },
      existing: null,
      createdUrl: "https://github.com/acme/app/issues/77\n",
    }),
    { issueNumber: "77", actionTaken: "opened" },
  );

  // update → updated, the live issue's number.
  assert.deepEqual(resolveTrackerOutputs({ verdict: { action: "update" }, existing }), {
    issueNumber: "4242",
    actionTaken: "updated",
  });

  // close → closed. The number still reports: the caller may want to link the
  // issue it just closed.
  assert.deepEqual(resolveTrackerOutputs({ verdict: { action: "close" }, existing }), {
    issueNumber: "4242",
    actionTaken: "closed",
  });

  // same-digest noop → noop, WITH the number. This is the load-bearing row:
  // without it, "issue exists, set unchanged" is indistinguishable from
  // "nothing failing, no issue" — the exact ambiguity the outputs remove.
  assert.deepEqual(resolveTrackerOutputs({ verdict: { action: "noop" }, existing }), {
    issueNumber: "4242",
    actionTaken: "noop",
  });

  // empty-set-with-no-issue noop → noop, and empty is the ONLY case that is.
  assert.deepEqual(resolveTrackerOutputs({ verdict: { action: "noop" }, existing: null }), {
    issueNumber: "",
    actionTaken: "noop",
  });
});

test("action-taken only ever emits the four public past-tense values", () => {
  for (const action of ["create", "update", "close", "noop"]) {
    const { actionTaken } = resolveTrackerOutputs({
      verdict: { action },
      existing: { number: 1 },
      createdUrl: "https://github.com/acme/app/issues/1",
    });
    assert.ok(
      PUBLIC_ACTIONS.includes(actionTaken),
      `${action} produced ${actionTaken}, which is not a public output value`,
    );
    // The internal imperative verdict names must not leak out as-is; only
    // `noop` is deliberately spelled the same in both vocabularies.
    if (action !== "noop") assert.notEqual(actionTaken, action);
  }

  // An unrecognised verdict degrades to the quietest value rather than
  // emitting a fifth word a caller's `if:` has never heard of.
  assert.equal(resolveTrackerOutputs({ verdict: { action: "reopen" } }).actionTaken, "noop");
  assert.equal(resolveTrackerOutputs({}).actionTaken, "noop");
});

test("the created issue number is parsed from the gh issue create URL", () => {
  assert.equal(parseIssueNumberFromUrl("https://github.com/acme/app/issues/512\n"), "512");
  // gh is free to print chatter before the URL; the URL is always last.
  assert.equal(
    parseIssueNumberFromUrl("Creating issue in acme/app\nhttps://github.com/acme/app/issues/9"),
    "9",
  );
});

test("an unparseable create URL yields opened with an empty number, never a throw", () => {
  // A successful create whose URL we cannot read is degraded, not failed — the
  // issue exists, so throwing here would discard a real write.
  for (const payload of ["", "   ", "not a url", "https://github.com/acme/app/pull/3", null]) {
    const outputs = resolveTrackerOutputs({
      verdict: { action: "create" },
      existing: null,
      createdUrl: payload,
    });
    assert.deepEqual(outputs, { issueNumber: "", actionTaken: "opened" });
  }
});

test("writeGithubOutput reuses renderEnvEntry's heredoc escaping", () => {
  const dir = mkdtempSync(join(tmpdir(), "track-issue-out-"));
  const file = join(dir, "gh-output");
  const entries = [
    ["issue-number", "77"],
    ["action-taken", "opened"],
    ["detail", "line one\nline two"],
  ];

  writeGithubOutput(entries, file);

  assert.equal(
    readFileSync(file, "utf8"),
    entries.map(([k, v]) => renderEnvEntry(k, v)).join(""),
  );
  // The multi-line value must be the heredoc form, not a truncated KEY=value.
  assert.match(readFileSync(file, "utf8"), /detail<<detail_EOF_7f3a\nline one\nline two\n/);
});

test("an unset GITHUB_OUTPUT skips the write and returns, where GITHUB_ENV throws", () => {
  // Outputs are additive — a caller that ignores them is the normal case — so
  // a missing $GITHUB_OUTPUT must never fail an otherwise-healthy tracker run.
  for (const missing of [undefined, "", null]) {
    assert.doesNotThrow(() => writeGithubOutput([["issue-number", "77"]], missing));
    assert.equal(writeGithubOutput([["issue-number", "77"]], missing), undefined);
  }

  // The asymmetry is deliberate: the next step of the composite cannot run
  // without the $GITHUB_ENV hand-off, so that one still fails loudly.
  assert.throws(() => writeGithubEnv([["K", "v"]], undefined), /GITHUB_ENV is not set/);
});

test("a dry run reports the verdict that would have run without writing anything", () => {
  const cfg = resolveConfig({
    TRACK_MARKER: MARKER,
    TRACK_REPO: "acme/app",
    TRACK_DRY_RUN: "true",
    TRACK_FAILED_ITEMS: JSON.stringify(["a", "b"]),
  });
  assert.equal(cfg.dryRun, true);

  // main() returns on cfg.dryRun BEFORE the switch that holds every gh
  // mutation, so "no tracker write" is structural; what needs asserting is
  // that the outputs still describe the verdict it declined to perform.
  const existing = issueWithDigest(31, "stale-digest");
  const verdict = decideVerdict(
    existing,
    { failedCount: cfg.failedItems.length, digest: cfg.digest },
    { digestPrefix: cfg.digestPrefix, unchangedBehavior: cfg.unchangedBehavior },
  );
  assert.equal(verdict.action, "update");
  assert.deepEqual(resolveTrackerOutputs({ verdict, existing }), {
    issueNumber: "31",
    actionTaken: "updated",
  });

  // And a dry run over an unchanged set still surfaces the live issue number.
  const unchanged = decideVerdict(
    issueWithDigest(31, cfg.digest),
    { failedCount: cfg.failedItems.length, digest: cfg.digest },
    { digestPrefix: cfg.digestPrefix },
  );
  assert.equal(unchanged.action, "noop");
  assert.deepEqual(
    resolveTrackerOutputs({ verdict: unchanged, existing: issueWithDigest(31, cfg.digest) }),
    { issueNumber: "31", actionTaken: "noop" },
  );
});
