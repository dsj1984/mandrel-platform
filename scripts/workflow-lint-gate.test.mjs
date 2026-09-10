// Unit coverage for the workflow-lint advisory/enforcing gate (Story #425).
//
// The enforcement dial is the load-bearing part of this tier: the gate ships
// ADVISORY so a consumer inheriting it on a pin bump does not have their
// pre-existing workflow debt redden the merge, and flips to blocking only when
// the caller opts in. A grep over pr-quality.yml cannot tell a working dial
// from a broken one — it pins the spelling, not the behaviour — so the
// decision lives in a script and is pinned here, mirroring
// `osv-report-gate.test.mjs` next door.
//
// The other invariant these tests hold: a missing or malformed report is a
// TOOL FAILURE and exits non-zero even in advisory mode. A gate that reports
// "no findings" because the linter never ran is worse than no gate at all.
//
// Story #496 adds the third class and pins its split from the second: an
// INFRASTRUCTURE failure — a tool that never arrived at all, because the
// release CDN blipped, the checksum did not match, or the platform has no
// pinned entry — obeys the same dial findings do. It used to `exit 1` inside
// the composite's inline bash, so a CDN blip reddened every consumer's
// required check while this tier was documented as advisory. What it must
// never become is silent: an advisory infra failure still says, loudly, that
// nothing was linted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import {
  normalizeActionlint,
  normalizeZizmor,
  classify,
  countBySeverity,
  findingsDigest,
  renderSummary,
  loadReport,
  severityRank,
  resolveEnforcement,
  classifyInfraFailure,
  renderInfraSummary,
  INFRA_FAILURE_ENV,
  WorkflowLintGateError,
} from "../.github/actions/workflow-lint/workflow-lint-gate.mjs";

// A composite-supplied reason, in the shape action.yml actually emits. Kept
// free of any URL-shaped literal on purpose: asserting a substring against one
// is CodeQL js/incomplete-url-substring-sanitization, so the marker asserted
// on below is the slug prefix, never a host.
const INFRA_REASON =
  "download-failed: curl exited 22 fetching actionlint_1.7.12_linux_amd64.tar.gz " +
  "from the actionlint release assets.";
const INFRA_MARKER = "download-failed";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(repoRoot, ".github/actions/workflow-lint/workflow-lint-gate.mjs");

// An actionlint `-format '{{json .}}'` row, as the real binary emits it.
const actionlintRow = (over = {}) => ({
  message: "got unexpected character '+' while lexing expression",
  filepath: ".github/workflows/bad.yml",
  line: 6,
  column: 29,
  kind: "expression",
  snippet: "    timeout-minutes: ${{ 15 + 3 }}",
  ...over,
});

// A zizmor `--format json` (v1) finding, as the real binary emits it. Note the
// ZERO-indexed start_point — the +1 is the thing worth pinning.
const zizmorRow = (over = {}) => ({
  ident: "excessive-permissions",
  desc: "overly broad permissions",
  url: "https://docs.zizmor.sh/audits/#excessive-permissions",
  determinations: { confidence: "High", severity: "High", persona: "Regular" },
  locations: [
    {
      symbolic: {
        key: { Local: { verbatim_path: ".github/workflows/release-please.yml" } },
        kind: "Primary",
      },
      concrete: { location: { start_point: { row: 31, column: 2 } } },
    },
  ],
  ...over,
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test("normalizeActionlint maps a row and records it at high severity", () => {
  const [f] = normalizeActionlint([actionlintRow()]);
  assert.equal(f.tool, "actionlint");
  assert.equal(f.id, "expression");
  // actionlint has no severity model — every diagnostic is an error.
  assert.equal(f.severity, "high");
  assert.equal(f.file, ".github/workflows/bad.yml");
  assert.equal(f.line, 6);
  assert.equal(f.column, 29);
});

test("normalizeActionlint keeps only the first line of a multi-line message", () => {
  const [f] = normalizeActionlint([actionlintRow({ message: "first\nsecond" })]);
  assert.equal(f.message, "first");
});

test("normalizeZizmor converts zizmor's 0-indexed point to a 1-indexed location", () => {
  const [f] = normalizeZizmor([zizmorRow()]);
  assert.equal(f.tool, "zizmor");
  assert.equal(f.id, "excessive-permissions");
  assert.equal(f.severity, "high");
  assert.equal(f.file, ".github/workflows/release-please.yml");
  // row 31 / column 2 are 0-indexed; zizmor's own plain renderer prints 32:3.
  assert.equal(f.line, 32);
  assert.equal(f.column, 3);
});

test("normalizeZizmor prefers the Primary location over other locations", () => {
  const row = zizmorRow({
    locations: [
      {
        symbolic: { key: { Local: { verbatim_path: "other.yml" } }, kind: "Related" },
        concrete: { location: { start_point: { row: 0, column: 0 } } },
      },
      {
        symbolic: { key: { Local: { verbatim_path: "primary.yml" } }, kind: "Primary" },
        concrete: { location: { start_point: { row: 9, column: 4 } } },
      },
    ],
  });
  const [f] = normalizeZizmor([row]);
  assert.equal(f.file, "primary.yml");
  assert.equal(f.line, 10);
});

test("normalizeZizmor tolerates a finding with no locations", () => {
  const [f] = normalizeZizmor([zizmorRow({ locations: [] })]);
  assert.equal(f.file, "");
  assert.equal(f.line, 0);
});

test("a non-array report is a hard error for either tool", () => {
  assert.throws(() => normalizeActionlint({ nope: true }), WorkflowLintGateError);
  assert.throws(() => normalizeZizmor("nope"), WorkflowLintGateError);
});

// ---------------------------------------------------------------------------
// The enforcement dial — the reason this file exists
// ---------------------------------------------------------------------------

test("advisory (the default): findings are reported but do NOT fail the tier", () => {
  const findings = [
    ...normalizeActionlint([actionlintRow()]),
    ...normalizeZizmor([zizmorRow()]),
  ];
  const verdict = classify(findings);
  assert.equal(verdict.enforce, false);
  assert.equal(verdict.findings.length, 2, "every finding is still reported");
  assert.equal(verdict.blocking.length, 0);
  assert.equal(verdict.exitCode, 0, "advisory mode must never red the tier");
});

test("enforcing: the same findings DO fail the tier", () => {
  const findings = normalizeZizmor([zizmorRow()]);
  const verdict = classify(findings, { enforce: true });
  assert.equal(verdict.blocking.length, 1);
  assert.equal(verdict.exitCode, 1);
});

test("no findings passes under either setting", () => {
  assert.equal(classify([]).exitCode, 0);
  assert.equal(classify([], { enforce: true }).exitCode, 0);
});

test("findings sort by severity, strongest first", () => {
  const findings = [
    { tool: "zizmor", id: "a", severity: "medium", file: "a.yml", line: 1 },
    { tool: "zizmor", id: "b", severity: "high", file: "b.yml", line: 1 },
  ];
  assert.equal(classify(findings).findings[0].severity, "high");
});

test("severityRank orders the ladder and floors an unknown band", () => {
  assert.ok(severityRank("high") > severityRank("medium"));
  assert.ok(severityRank("medium") > severityRank("low"));
  assert.equal(severityRank("nonsense"), 0);
});

test("countBySeverity buckets each band and files strays under unknown", () => {
  const counts = countBySeverity([
    { severity: "high" },
    { severity: "medium" },
    { severity: "medium" },
    { severity: "bogus" },
  ]);
  assert.equal(counts.high, 1);
  assert.equal(counts.medium, 2);
  assert.equal(counts.unknown, 1);
});

// ---------------------------------------------------------------------------
// Per-tool enforcement — the two linters arrive with different debt
// ---------------------------------------------------------------------------

test("resolveEnforcement: a per-tool value overrides the tier-wide default", () => {
  assert.deepEqual(resolveEnforcement({ enforce: "false", actionlint: "true" }), {
    actionlint: true,
    zizmor: false,
  });
  assert.deepEqual(resolveEnforcement({ enforce: "true", zizmor: "false" }), {
    actionlint: true,
    zizmor: false,
  });
});

test("resolveEnforcement: an empty per-tool value inherits the tier default", () => {
  assert.deepEqual(resolveEnforcement({ enforce: "true" }), {
    actionlint: true,
    zizmor: true,
  });
  assert.deepEqual(resolveEnforcement({}), { actionlint: false, zizmor: false });
});

test("resolveEnforcement: only the literal 'true' enables a tool", () => {
  for (const value of ["TRUE", "1", "yes", "on"]) {
    assert.deepEqual(
      resolveEnforcement({ actionlint: value, zizmor: value }),
      { actionlint: false, zizmor: false },
      `${value} must not enable enforcement`,
    );
  }
});

test("only the enforcing tool's findings block — this repo's ci.yml case", () => {
  // actionlint blocking (clean), zizmor advisory (pre-existing backlog).
  const findings = [
    ...normalizeActionlint([actionlintRow()]),
    ...normalizeZizmor([zizmorRow()]),
  ];
  const verdict = classify(findings, {
    enforce: { actionlint: true, zizmor: false },
  });
  assert.equal(verdict.findings.length, 2, "both are still reported");
  assert.equal(verdict.blocking.length, 1);
  assert.equal(verdict.blocking[0].tool, "actionlint");
  assert.equal(verdict.exitCode, 1);
});

test("a clean enforcing tool passes even while the advisory tool has findings", () => {
  const verdict = classify(normalizeZizmor([zizmorRow()]), {
    enforce: { actionlint: true, zizmor: false },
  });
  assert.equal(verdict.findings.length, 1);
  assert.equal(verdict.blocking.length, 0);
  assert.equal(verdict.exitCode, 0);
});

test("the summary labels each row's own gate when the tools differ", () => {
  const findings = [
    ...normalizeActionlint([actionlintRow()]),
    ...normalizeZizmor([zizmorRow()]),
  ];
  const md = renderSummary(classify(findings, { enforce: { actionlint: true, zizmor: false } }));
  assert.match(md, /❌ blocking \| high \| actionlint/);
  assert.match(md, /⚠️ advisory \| high \| zizmor/);
  assert.match(md, /1 of 2 finding\(s\)/);
});

test("the digest counts a mixed verdict rather than calling it all-or-nothing", () => {
  const findings = [
    ...normalizeActionlint([actionlintRow()]),
    ...normalizeZizmor([zizmorRow()]),
  ];
  const digest = findingsDigest(
    classify(findings, { enforce: { actionlint: true, zizmor: false } }),
  );
  assert.match(digest, /1 ENFORCING \(failing this tier\), 1 advisory/);
});

test("CLI: per-tool env vars drive the gate", () => {
  const both = { actionlint: [actionlintRow()], zizmor: [zizmorRow()] };
  // actionlint enforcing → red, even though the tier default is advisory.
  assert.equal(
    runGate({ WORKFLOW_LINT_ENFORCE_ACTIONLINT: "true" }, both).status,
    1,
  );
  // zizmor advisory override beats an enforcing tier default → its findings
  // alone cannot red the tier.
  assert.equal(
    runGate(
      { WORKFLOW_LINT_ENFORCE: "true", WORKFLOW_LINT_ENFORCE_ACTIONLINT: "false", WORKFLOW_LINT_ENFORCE_ZIZMOR: "false" },
      both,
    ).status,
    0,
  );
});

// ---------------------------------------------------------------------------
// Reporting — an advisory finding nobody can see is the same as no tier
// ---------------------------------------------------------------------------

test("the digest names the posture so a green log is not mistaken for clean", () => {
  const findings = normalizeZizmor([zizmorRow()]);
  assert.match(findingsDigest(classify(findings)), /advisory, so they do NOT fail/);
  assert.match(findingsDigest(classify(findings, { enforce: true })), /ENFORCING/);
  assert.match(findingsDigest(classify([])), /no findings/);
});

test("the summary renders every finding in advisory mode", () => {
  const md = renderSummary(classify(normalizeZizmor([zizmorRow()])));
  assert.match(md, /advisory/);
  assert.match(md, /workflow-lint-enforce: true/);
  assert.match(md, /release-please\.yml:32:3/);
  assert.match(md, /excessive-permissions/);
});

test("the summary says findings fail the build when enforcing", () => {
  const md = renderSummary(classify(normalizeZizmor([zizmorRow()]), { enforce: true }));
  assert.match(md, /enforcing/);
  assert.doesNotMatch(md, /do \*\*not\*\* fail/);
});

test("backslashes are escaped BEFORE pipes, so a cell cannot be merged", () => {
  // CodeQL js/incomplete-sanitization: escaping pipes first would let an input
  // backslash become the escape character for the pipe after it, silently
  // merging two table cells.
  const md = renderSummary(
    classify(normalizeActionlint([actionlintRow({ message: String.raw`a \ b | c` })])),
  );
  const row = md.split("\n").find((l) => l.includes("| actionlint |"));
  assert.ok(row.includes(String.raw`a \\ b \| c`), row);
});

test("a pipe in a finding message cannot break the summary table", () => {
  const md = renderSummary(
    classify(normalizeActionlint([actionlintRow({ message: "a | b" })])),
  );
  assert.match(md, /a \\\| b/);
});

// ---------------------------------------------------------------------------
// Report loading — a report that did not arrive is never a pass
// ---------------------------------------------------------------------------

test("an unset report path contributes nothing", () => {
  assert.deepEqual(loadReport("actionlint", ""), []);
});

test("a missing report file is fatal, not an empty pass", () => {
  assert.throws(
    () => loadReport("zizmor", "/no/such/report.json"),
    (err) => err instanceof WorkflowLintGateError && /did not run/.test(err.message),
  );
});

test("an unparseable report is fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "wl-gate-"));
  try {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    assert.throws(() => loadReport("actionlint", p), WorkflowLintGateError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty report file reads as no findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "wl-gate-"));
  try {
    const p = join(dir, "empty.json");
    writeFileSync(p, "   ");
    assert.deepEqual(loadReport("actionlint", p), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end through the real CLI entrypoint (AC-5)
// ---------------------------------------------------------------------------

function runGate(env, { actionlint = [], zizmor = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wl-gate-e2e-"));
  try {
    const alPath = join(dir, "al.json");
    const zzPath = join(dir, "zz.json");
    writeFileSync(alPath, JSON.stringify(actionlint));
    writeFileSync(zzPath, JSON.stringify(zizmor));
    return spawnSync(process.execPath, [GATE], {
      encoding: "utf8",
      env: {
        ...process.env,
        ACTIONLINT_REPORT: alPath,
        ZIZMOR_REPORT: zzPath,
        GITHUB_STEP_SUMMARY: "",
        ...env,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI: a finding exits 0 in advisory mode and still reports itself", () => {
  const res = runGate({}, { zizmor: [zizmorRow()] });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /excessive-permissions/);
  assert.match(res.stdout, /advisory/);
  // Advisory findings annotate as warnings, which never red a check run.
  assert.match(res.stdout, /::warning /);
});

test("CLI: the same finding exits non-zero when enforcing", () => {
  const res = runGate({ WORKFLOW_LINT_ENFORCE: "true" }, { zizmor: [zizmorRow()] });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error /);
});

test("CLI: a clean report exits 0 either way", () => {
  assert.equal(runGate({}).status, 0);
  assert.equal(runGate({ WORKFLOW_LINT_ENFORCE: "true" }).status, 0);
});

test("CLI: a missing report fails even in advisory mode", () => {
  const res = spawnSync(process.execPath, [GATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACTIONLINT_REPORT: "/no/such/al.json",
      ZIZMOR_REPORT: "",
      WORKFLOW_LINT_ENFORCE: "false",
    },
  });
  assert.equal(res.status, 1, "a linter that never ran is not a clean gate");
  assert.match(res.stderr, /::error::workflow-lint gate/);
});

test("CLI: only the literal string 'true' enables enforcement", () => {
  for (const value of ["false", "TRUE", "1", "yes", ""]) {
    const res = runGate({ WORKFLOW_LINT_ENFORCE: value }, { zizmor: [zizmorRow()] });
    assert.equal(res.status, 0, `enforce=${JSON.stringify(value)} must stay advisory`);
  }
});

// ---------------------------------------------------------------------------
// Infrastructure failure — a tool that never arrived (Story #496, AC-1)
// ---------------------------------------------------------------------------

test("classifyInfraFailure: no reason means there is nothing to report", () => {
  assert.equal(classifyInfraFailure(undefined, false), null);
  assert.equal(classifyInfraFailure("", true), null);
  assert.equal(classifyInfraFailure("   \n ", true), null, "whitespace is not a reason");
});

test("classifyInfraFailure: advisory tier warns and does NOT fail", () => {
  const infra = classifyInfraFailure(INFRA_REASON, { actionlint: false, zizmor: false });
  assert.equal(infra.enforced, false);
  assert.equal(infra.level, "warning");
  assert.equal(infra.exitCode, 0, "a CDN blip must not red an advisory tier");
  assert.ok(infra.message.includes(INFRA_MARKER), infra.message);
});

test("classifyInfraFailure: an enforcing tier fails — tier-wide or per tool", () => {
  assert.equal(classifyInfraFailure(INFRA_REASON, true).exitCode, 1);
  assert.equal(classifyInfraFailure(INFRA_REASON, true).level, "error");
  // A consumer who enforced ONE tool still asked this tier to block, so a
  // gate that could not run is a failure for them.
  const perTool = classifyInfraFailure(INFRA_REASON, { actionlint: true, zizmor: false });
  assert.equal(perTool.enforced, true);
  assert.equal(perTool.exitCode, 1);
});

test("renderInfraSummary states the posture and that nothing was linted", () => {
  const advisory = renderInfraSummary(classifyInfraFailure(INFRA_REASON, false));
  assert.match(advisory, /advisory/);
  assert.match(advisory, /no workflows were linted/i);
  assert.ok(advisory.includes(INFRA_MARKER), advisory);
  const enforcing = renderInfraSummary(classifyInfraFailure(INFRA_REASON, true));
  assert.match(enforcing, /enforcing/);
  assert.doesNotMatch(enforcing, /does \*\*not\*\* fail/);
});

test("CLI: an infra failure exits 0 and warns while nothing is enforced", () => {
  const res = runGate({
    [INFRA_FAILURE_ENV]: INFRA_REASON,
    WORKFLOW_LINT_ENFORCE: "false",
    WORKFLOW_LINT_ENFORCE_ACTIONLINT: "false",
    WORKFLOW_LINT_ENFORCE_ZIZMOR: "false",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /::warning::/);
  assert.doesNotMatch(res.stdout, /::error::/);
  assert.ok(res.stdout.includes(INFRA_MARKER), res.stdout);
});

test("CLI: the same infra failure exits 1 and errors when the tier is enforced", () => {
  const res = runGate({
    [INFRA_FAILURE_ENV]: INFRA_REASON,
    WORKFLOW_LINT_ENFORCE: "true",
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::/);
  assert.ok(res.stdout.includes(INFRA_MARKER), res.stdout);
});

test("CLI: a per-tool enforce alone makes an infra failure blocking", () => {
  const res = runGate({
    [INFRA_FAILURE_ENV]: INFRA_REASON,
    WORKFLOW_LINT_ENFORCE: "false",
    WORKFLOW_LINT_ENFORCE_ZIZMOR: "true",
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::/);
});

test("CLI: an advisory infra failure is never reported as a clean run", () => {
  // The empty reports the composite writes alongside the signal carry no
  // information. Rendering them as "no findings" would turn a gate that never
  // ran into a green tick that looks audited.
  const res = runGate({
    [INFRA_FAILURE_ENV]: INFRA_REASON,
    WORKFLOW_LINT_ENFORCE: "false",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /no findings/);
  assert.doesNotMatch(res.stdout, /reported no findings/);
});

test("CLI: an unset infra reason leaves the findings path untouched", () => {
  const res = runGate({ [INFRA_FAILURE_ENV]: "" }, { zizmor: [zizmorRow()] });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /excessive-permissions/);
});

test("an infra failure does not relax the missing-report rule", () => {
  // Different class, different answer: a report that never arrived means the
  // linter ran and produced nothing readable, which stays fatal.
  const res = spawnSync(process.execPath, [GATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACTIONLINT_REPORT: "/no/such/al.json",
      ZIZMOR_REPORT: "",
      WORKFLOW_LINT_ENFORCE: "false",
      [INFRA_FAILURE_ENV]: "",
    },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /::error::workflow-lint gate/);
});
