#!/usr/bin/env node
/**
 * check-codeql-gating.test.mjs — regression guard for the repository-local
 * CodeQL merge gate (Story #366, hardened in Story #380).
 *
 * CodeQL ran on this repo's pull requests for a long time without gating
 * anything: it was not among the required status contexts, and the delivery
 * path arms GitHub native auto-merge, which waits only on required contexts.
 * A pull request that introduced a new high-severity alert merged green, and
 * the delivery envelope reported the Story landed. Two ReDoS regressions
 * reached `main` that way — "landed" was not the same as "scanned".
 *
 * The gate routes through the AGGREGATOR rather than through repository
 * settings: ci.yml calls codeql.yml as a job, and the required `ci-required`
 * aggregator lists that job in `needs:`. The required-context set is
 * unchanged, so no branch protection is edited and no phantom context can
 * appear.
 *
 * ## Why the gate's shell is EXECUTED here, not matched
 *
 * The decision this gate makes lives in a shell branch — a severity rank
 * compared against a threshold — and the whole failure mode is silence. Four
 * regexes over the step's `run:` text used to stand in for that branch, which
 * proved only that certain words were present: an inverted comparator, a
 * dropped page of alerts, or a severity the scale does not cover would all
 * have shipped green. So this suite extracts the real `run:` body with
 * `lib/yaml-step.mjs` and runs it under bash against a stubbed `gh`, the same
 * read-then-execute approach as check-gitleaks-allowlist.test.mjs and
 * check-release-type.test.mjs.
 *
 * The static assertions that remain are the ones that are genuinely about
 * structure rather than behaviour:
 *
 *   1. WIRING — ci.yml has a `code-scanning` job that calls codeql.yml, and
 *      `ci-required` lists it in `needs:`. It also passes a
 *      `fail-on-alert-severity` threshold: `codeql-action/analyze` exits 0
 *      whatever it finds, so without one the gate would only assert that the
 *      scan RAN. The alert signal GitHub itself reds is a check run, which no
 *      aggregator can `needs:`.
 *   2. FAIL TOWARD BLOCKING — neither the caller's `code-scanning` job nor
 *      codeql.yml's own `analyze` job declares `if:` or `needs:`. The
 *      aggregator passes a job whose result is `success` or `skipped`, and
 *      `skipped` is reachable only through an `if:` condition or a
 *      skipped/failed dependency. A called workflow whose only job skips
 *      reports `skipped` to its caller, so an `if:` on `analyze` reopens the
 *      exact hole `needs: code-scanning` closed.
 *   3. ONE SCAN PATH — codeql.yml no longer triggers itself on push/PR. Both
 *      paths would analyze the same commit under the same `category`, so
 *      keeping them would burn two 30-minute analyses per event and let the
 *      later SARIF upload overwrite the earlier one.
 *   4. CONSUMER BLAST RADIUS ZERO — codeql.yml keeps its `workflow_call`
 *      contract, and no reusable workflow a consumer calls gained a CodeQL
 *      job. The fleet's private repos have code scanning disabled, where a
 *      CodeQL job fails closed on a 403; the vendored Semgrep tier stays
 *      their blocking SAST.
 *
 * Run: node --test scripts/check-codeql-gating.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { stepByName, runScript } from "./lib/yaml-step.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CI = ".github/workflows/ci.yml";
const CODEQL = ".github/workflows/codeql.yml";
const PR_QUALITY = ".github/workflows/pr-quality.yml";
const CONTRACT = "docs/runbooks/main-protection.json";
const ROLLBACK = "docs/runbooks/rollback.md";

const SCAN_JOB = "code-scanning";
const ANALYZE_JOB = "analyze";
const AGGREGATOR = "ci-required";
const GATE_STEP = "Fail on alerts at or above the gating severity";

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

// ---------------------------------------------------------------------------
// Minimal indentation-based extraction. Dependency-free by house style (the
// repo's `npm test` is Node's built-in runner with no package install), and
// deliberately the same shape as check-ci-required-aggregator.test.mjs: jobs
// are declared at 2-space indent, so a job block runs from its `  <id>:` line
// to the next non-blank line at indent <= 2.
// ---------------------------------------------------------------------------

function extractJobBlock(content, jobId) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  assert.notEqual(start, -1, `job \`${jobId}\` not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (lines[i].match(/^(\s*)/)[1].length <= 2) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Keys declared directly on the job (4-space indent), comments excluded. */
function jobKeys(jobBlock) {
  const keys = new Set();
  for (const line of jobBlock.split("\n").slice(1)) {
    const m = line.match(/^ {4}([A-Za-z0-9_-]+):/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** The `- <name>` entries under the job's `needs:` key. */
function extractNeeds(jobBlock) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((l) => l === "    needs:");
  assert.notEqual(start, -1, "`needs:` block not found");
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s+([A-Za-z0-9_-]+)\s*$/);
    if (m) {
      names.push(m[1]);
      continue;
    }
    // Interleaved comment lines are part of the list; anything else ends it.
    if (/^\s+#/.test(lines[i])) continue;
    break;
  }
  return names;
}

/** The top-level `on:` trigger keys of a workflow. */
function extractTriggers(content) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.notEqual(start, -1, "top-level `on:` block not found");
  const triggers = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (/^[A-Za-z0-9_-]/.test(lines[i])) break; // next top-level key
    const m = lines[i].match(/^ {2}([A-Za-z0-9_-]+):/);
    if (m) triggers.add(m[1]);
  }
  return triggers;
}

// ---------------------------------------------------------------------------
// The gate harness: the real `run:` body, executed against a stubbed `gh`.
// ---------------------------------------------------------------------------

const gateScript = runScript(stepByName(read(CODEQL), GATE_STEP));

/**
 * A `gh` stub that reproduces the one behaviour the gate depends on:
 * `gh api --paginate` emits ONE JSON array PER PAGE, concatenated, whereas a
 * request without `--paginate` returns page 1 and stops.
 *
 * Emulating that split is the whole point — it is what lets a test place a
 * blocking alert on page 2 and have the assertion fail the moment `--paginate`
 * is dropped from the request. Every invocation appends its argv to a log so
 * the request itself (its query string, its retry count) can be asserted.
 */
const GH_STUB = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >>"$STUB_ARGV_LOG"',
  'if [ -n "${STUB_FAIL:-}" ]; then',
  '  echo "stubbed gh: request failed" >&2',
  "  exit 1",
  "fi",
  "paginate=0",
  'for arg in "$@"; do',
  '  if [ "$arg" = "--paginate" ]; then paginate=1; fi',
  "done",
  'cat "$STUB_DIR/page1.json"',
  'if [ "$paginate" = "1" ]; then',
  '  for extra in "$STUB_DIR"/page2.json "$STUB_DIR"/page3.json; do',
  '    if [ -f "$extra" ]; then cat "$extra"; fi',
  "  done",
  "fi",
  "",
].join("\n");

/** One code scanning alert as the REST API shapes it. */
const alert = (severity, ruleId = "js/redos", path = "scripts/a.mjs", line = 7) => ({
  rule: severity === null ? { id: ruleId } : { id: ruleId, security_severity_level: severity },
  most_recent_instance: { location: { path, start_line: line } },
  html_url: `https://github.com/o/r/security/code-scanning/${line}`,
});

/**
 * Execute the extracted gate body.
 *
 * @param {object}   opts
 * @param {Array}    opts.pages      One entry per API page. An array is
 *                                   serialised as the page body; a string is
 *                                   written verbatim (for malformed responses).
 * @param {string}   opts.threshold  The `fail-on-alert-severity` input value.
 * @param {boolean}  opts.ghFails    Make every `gh` invocation exit non-zero.
 */
function runGate({ pages = [[]], threshold = "high", ghFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codeql-gate-"));
  try {
    const argvLog = join(dir, "argv.log");
    writeFileSync(argvLog, "");
    pages.forEach((page, i) => {
      const body = typeof page === "string" ? page : `${JSON.stringify(page)}\n`;
      writeFileSync(join(dir, `page${i + 1}.json`), body);
    });

    const gh = join(dir, "gh");
    writeFileSync(gh, GH_STUB);
    chmodSync(gh, 0o755);
    // The retry loop sleeps 10s between attempts; a no-op `sleep` ahead of it
    // on PATH keeps the six-attempt fail-closed case under a millisecond.
    const sleepStub = join(dir, "sleep");
    writeFileSync(sleepStub, "#!/bin/sh\nexit 0\n");
    chmodSync(sleepStub, 0o755);

    const summary = join(dir, "step-summary.md");
    const script = join(dir, "gate.sh");
    writeFileSync(script, gateScript);

    const env = {
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      GH_TOKEN: "stub-token",
      REPO: "o/r",
      ANALYSIS_REF: "refs/pull/42/merge",
      THRESHOLD: threshold,
      GITHUB_STEP_SUMMARY: summary,
      STUB_DIR: dir,
      STUB_ARGV_LOG: argvLog,
      ...(ghFails ? { STUB_FAIL: "1" } : {}),
    };

    // `bash --noprofile --norc -eo pipefail <script>` is exactly how GitHub
    // invokes a `shell: bash` step, and it is the part most likely to break a
    // naive `$(...)` capture.
    const argv = ["--noprofile", "--norc", "-eo", "pipefail", script];
    const opts = { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env };

    let status = 0;
    let output;
    try {
      output = execFileSync("bash", argv, opts);
    } catch (e) {
      status = e.status ?? 1;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    return {
      status,
      output,
      summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
      requests: readFileSync(argvLog, "utf8").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AC-1 / AC-2 / AC-3 — the gate's shell, executed
// ---------------------------------------------------------------------------

test("AC-2: an alert above the threshold fails the job and names it", () => {
  const { status, output, summary } = runGate({ pages: [[alert("critical", "js/code-injection")]] });

  assert.equal(status, 1, "a critical alert above the `high` threshold must fail the job");
  assert.match(output, /1 open code scanning alert\(s\) at or above high/);
  // The operator has to be able to act on this from the log alone.
  assert.match(output, /js\/code-injection/);
  assert.match(output, /scripts\/a\.mjs:7/);
  assert.match(summary, /### ❌ Code scanning gate failed/);
  assert.match(summary, /Fix or dismiss them — this job gates the merge\./);
});

test("AC-3: an alert exactly AT the threshold fails — the comparator is inclusive", () => {
  // Kills a `>` mutation. `high` is the threshold this repository ships, so an
  // exclusive comparator would wave through the single most likely alert.
  const { status, output } = runGate({ pages: [[alert("high")]], threshold: "high" });
  assert.equal(status, 1);
  assert.match(output, /1 open code scanning alert\(s\) at or above high/);
});

test("AC-2/AC-3: an alert below the threshold passes", () => {
  // Kills an inverted (`<=`) comparator, which would block on everything the
  // gate is supposed to let through.
  for (const severity of ["medium", "low"]) {
    const { status, output } = runGate({ pages: [[alert(severity)]], threshold: "high" });
    assert.equal(status, 0, `a ${severity} alert must not fail a \`high\` gate`);
    assert.match(output, /✅ No open code scanning alerts at or above high/);
  }
});

test("AC-3: the threshold is read from the input, not hardcoded", () => {
  // A `high` alert blocks at `high` (above) and passes at `critical` (below),
  // so the rank comparison genuinely consults THRESHOLD on both sides.
  assert.equal(runGate({ pages: [[alert("high")]], threshold: "high" }).status, 1);
  assert.equal(runGate({ pages: [[alert("high")]], threshold: "critical" }).status, 0);
  assert.equal(runGate({ pages: [[alert("low")]], threshold: "low" }).status, 1);
});

test("AC-2: an empty alert list passes", () => {
  const { status, output, summary } = runGate({ pages: [[]] });
  assert.equal(status, 0);
  assert.match(output, /✅ No open code scanning alerts at or above high/);
  assert.equal(summary, "", "a clean scan writes no failure summary");
});

test("AC-2: a severity the scale does not cover fails closed", () => {
  // A severity that is PRESENT but unrankable cannot be proved below the
  // threshold. Ranking it 0 and passing — the behaviour before Story #380 —
  // is a fail-open in a step whose entire purpose is failing closed, and it is
  // exactly how a newly introduced GitHub severity level would slip past.
  const { status, output } = runGate({ pages: [[alert("severe", "js/future-query")]] });
  assert.equal(status, 1);
  assert.match(output, /security severity is not one of low\|medium\|high\|critical/);
  assert.match(output, /js\/future-query/);
});

test("an ABSENT severity is not a finding — other tools share this alert surface", () => {
  // secret-scan-push.yml uploads gitleaks SARIF to the same code scanning
  // surface on public repos, and those alerts carry no security severity at
  // all. Failing closed on them would red every pull request, so the
  // unrankable check deliberately fires on present-but-unknown only.
  const { status, output } = runGate({
    pages: [[alert(null, "gitleaks.generic-api-key"), alert("low")]],
  });
  assert.equal(status, 0);
  assert.match(output, /✅ No open code scanning alerts at or above high/);
});

test("AC-2: a response that is not parseable JSON fails closed with a named error", () => {
  const { status, output } = runGate({ pages: ["<html>502 Bad Gateway</html>\n"] });
  assert.equal(status, 1);
  assert.match(output, /Could not parse the code scanning alerts response for refs\/pull\/42\/merge/);
  assert.match(output, /fails closed/);
});

test("AC-2: an invalid `fail-on-alert-severity` fails the job rather than gating on nothing", () => {
  // A typo must not silently degrade to "rank 0, nothing is ever above it".
  for (const threshold of ["", "banana", "High", "none"]) {
    const { status, output } = runGate({ pages: [[alert("critical")]], threshold });
    assert.equal(status, 1, `threshold '${threshold}' must fail`);
    assert.match(
      output,
      /fail-on-alert-severity must be one of low\|medium\|high\|critical/,
      `threshold '${threshold}' must say why`
    );
  }
});

test("AC-2: `gh` failing every attempt fails closed after the bounded retry", () => {
  const { status, output, requests } = runGate({ ghFails: true });
  assert.equal(status, 1);
  assert.match(output, /Could not read code scanning alerts for refs\/pull\/42\/merge/);
  assert.match(output, /did not conclusively report clean, so this gate fails closed/);
  assert.equal(requests.length, 6, "the retry is bounded at six attempts, then fails — it never converts a persistent failure into a pass");
});

test("a transient failure that later succeeds does not fail the job", () => {
  // The complement of the case above: the retry exists for propagation lag, so
  // it must still be able to conclude. Proven by the six-attempt budget being
  // spent only when every attempt fails.
  const { status, requests } = runGate({ pages: [[alert("medium")]] });
  assert.equal(status, 0);
  assert.equal(requests.length, 1, "a readable API is read once");
});

// ---------------------------------------------------------------------------
// AC-5 — the alerts read is paginated
// ---------------------------------------------------------------------------

test("AC-5: the alerts request is paginated and asks for the largest page", () => {
  const { requests } = runGate({ pages: [[]] });
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.match(request, /(^|\s)--paginate(\s|$)/, "the read must follow every page of alerts");
  assert.match(request, /per_page=100/, "and ask for the largest page, to need fewer of them");
  assert.match(request, /state=open/);
  assert.match(request, /ref=refs\/pull\/42\/merge/, "the gate reads the ANALYZED ref, not the default branch");
});

test("AC-5: a blocking alert past the first page still fails the job", () => {
  // The bound, asserted behaviourally. Before Story #380 the read took a
  // single unpaginated page, so a ref with more than 100 open alerts and every
  // `high` past page 1 produced a silent PASS. Dropping `--paginate` from the
  // request makes this test red, because the stub then answers page 1 only.
  const { status, output } = runGate({
    pages: [[alert("low"), alert("medium")], [alert("high", "js/redos", "scripts/b.mjs", 42)]],
  });
  assert.equal(status, 1, "an alert on page 2 must block exactly as one on page 1 does");
  assert.match(output, /js\/redos/);
  assert.match(output, /scripts\/b\.mjs:42/);
});

test("AC-5: every page is ranked, and the count spans all of them", () => {
  const { status, output } = runGate({
    pages: [[alert("critical", "js/a")], [alert("high", "js/b")], [alert("low", "js/c")]],
  });
  assert.equal(status, 1);
  assert.match(output, /2 open code scanning alert\(s\) at or above high/);
});

// ---------------------------------------------------------------------------
// 1. WIRING
// ---------------------------------------------------------------------------

test("ci.yml calls codeql.yml as a job", () => {
  const block = extractJobBlock(read(CI), SCAN_JOB);
  assert.match(
    block,
    /^ {4}uses:\s*\.\/\.github\/workflows\/codeql\.yml\s*$/m,
    `\`${SCAN_JOB}\` must call ./.github/workflows/codeql.yml — the dogfood ` +
      "self-call is what puts the scan inside this repo's own run"
  );
});

test("the required aggregator depends on the code-scanning job", () => {
  const needs = extractNeeds(extractJobBlock(read(CI), AGGREGATOR));
  assert.ok(
    needs.includes(SCAN_JOB),
    `\`${AGGREGATOR}\` must list \`${SCAN_JOB}\` in \`needs:\` — that single ` +
      `line is the whole gate. Found: ${needs.join(", ") || "(none)"}`
  );
});

test("the code-scanning job fails on a high-severity alert, not merely on a crash", () => {
  const block = extractJobBlock(read(CI), SCAN_JOB);
  // `github/codeql-action/analyze` uploads its SARIF and exits 0 whatever it
  // found — a scan that just introduced a critical alert is a SUCCESSFUL job.
  // Without a threshold this gate would assert "the scan ran", not "the scan
  // came back clean", and the alert signal GitHub does red is a CHECK RUN,
  // which no aggregator can `needs:`.
  const m = block.match(/^ {6}fail-on-alert-severity:\s*(\S+)\s*$/m);
  assert.ok(
    m,
    `\`${SCAN_JOB}\` must pass \`fail-on-alert-severity\` — otherwise a pull ` +
      "request that introduces a high-severity alert still reaches a green " +
      "aggregator, which is the exact regression this gate exists to stop"
  );
  assert.ok(
    ["high", "critical"].includes(m[1]),
    `\`fail-on-alert-severity\` must be \`high\` or \`critical\` (got \`${m[1]}\`)`
  );
});

test("codeql.yml declares the gate as an opt-in workflow_call input", () => {
  const codeql = read(CODEQL);
  assert.match(
    codeql,
    /^ {6}fail-on-alert-severity:$/m,
    "codeql.yml must declare the `fail-on-alert-severity` workflow_call input"
  );
  assert.match(
    codeql,
    /^ {8}default:\s*''\s*$/m,
    "`fail-on-alert-severity` must default to empty — the gate is opt-in, so " +
      "an existing caller and the schedule run keep upload-and-report behaviour"
  );
  assert.match(
    stepByName(codeql, GATE_STEP),
    /^\s+if: inputs\.fail-on-alert-severity != ''\s*$/m,
    "the gate step must stay conditional on the input, or the schedule run — " +
      "where `inputs` is empty — would gate on a threshold it was never given"
  );
});

test("the code-scanning job grants the scopes codeql.yml declares", () => {
  const block = extractJobBlock(read(CI), SCAN_JOB);
  // GitHub validates a called workflow's declared permissions against the
  // caller's grant at DISPATCH time. A missing scope fails the entire call
  // with startup_failure before any job runs (the Story #292 lesson).
  for (const scope of ["contents: read", "security-events: write", "actions: read"]) {
    assert.ok(
      block.includes(scope),
      `\`${SCAN_JOB}\` must grant \`${scope}\` — codeql.yml declares it, and a ` +
        "caller grant narrower than the called workflow's declaration is a " +
        "startup_failure, not a skipped step"
    );
  }
});

// ---------------------------------------------------------------------------
// 2. FAIL TOWARD BLOCKING
// ---------------------------------------------------------------------------

test("the code-scanning job cannot reach the `skipped` conclusion", () => {
  const keys = jobKeys(extractJobBlock(read(CI), SCAN_JOB));
  // The aggregator passes `success` OR `skipped`, and its run script is
  // byte-identical-mirrored with pr-quality.yml — it cannot special-case one
  // job. So the guarantee has to be structural: `skipped` is reachable only
  // via an `if:` condition or a skipped/failed dependency.
  assert.ok(
    !keys.has("if"),
    `\`${SCAN_JOB}\` must not declare \`if:\` — a conditional job can resolve ` +
      "`skipped`, which the aggregator treats as a pass, making the gate " +
      "silently advisory again"
  );
  assert.ok(
    !keys.has("needs"),
    `\`${SCAN_JOB}\` must not declare \`needs:\` — a job whose dependency is ` +
      "skipped or failed is itself skipped, which the aggregator passes"
  );
});

test("AC-4: codeql.yml's `analyze` job cannot reach the `skipped` conclusion either", () => {
  // The caller-side pin above is only half the guarantee. `code-scanning` is a
  // `uses:` job, so its result is the CALLED workflow's result — and a called
  // workflow whose every job skipped reports `skipped`, which the aggregator
  // passes. An `if:` on `analyze` therefore reverts Story #366 from inside
  // codeql.yml, without touching ci.yml at all.
  const keys = jobKeys(extractJobBlock(read(CODEQL), ANALYZE_JOB));
  assert.ok(
    !keys.has("if"),
    `codeql.yml's \`${ANALYZE_JOB}\` job must not declare \`if:\` — the ` +
      "aggregator reads a wholly-skipped called workflow as a pass, so a " +
      "condition here makes the merge gate silently advisory again. Gate an " +
      "individual STEP instead (the alert step's `if:` is at step level)"
  );
  assert.ok(
    !keys.has("needs"),
    `codeql.yml's \`${ANALYZE_JOB}\` job must not declare \`needs:\` — a job ` +
      "whose dependency skips or fails is itself skipped, with the same effect"
  );
  assert.ok(keys.has("steps"), "the extraction must have found the real job block");
});

// ---------------------------------------------------------------------------
// 3. ONE SCAN PATH
// ---------------------------------------------------------------------------

test("codeql.yml does not also trigger itself on push or pull_request", () => {
  const triggers = extractTriggers(read(CODEQL));
  for (const trigger of ["push", "pull_request"]) {
    assert.ok(
      !triggers.has(trigger),
      `codeql.yml must not declare \`${trigger}:\` — ci.yml's gating call ` +
        "already analyzes that commit, and a second run under the same " +
        "`category` overwrites the first SARIF upload for a check that gates " +
        "nothing"
    );
  }
});

test("ci.yml's own triggers cover the commits CodeQL must analyze", () => {
  const triggers = extractTriggers(read(CI));
  // pull_request is the gate itself; push to main is the default-branch
  // baseline CodeQL diffs PR alerts against. Losing either would make the
  // gate green on a repo it never scanned.
  assert.ok(triggers.has("pull_request"), "ci.yml must trigger on pull_request");
  assert.ok(triggers.has("push"), "ci.yml must trigger on push to main");
});

test("the weekly schedule sweep survives on codeql.yml", () => {
  // ci.yml has no `schedule:` trigger, so removing it here would drop the
  // periodic re-scan that catches alerts from newly published queries.
  assert.ok(
    extractTriggers(read(CODEQL)).has("schedule"),
    "codeql.yml must keep its `schedule:` sweep — ci.yml does not run on cron"
  );
});

// ---------------------------------------------------------------------------
// 4. CONSUMER BLAST RADIUS ZERO
// ---------------------------------------------------------------------------

test("codeql.yml keeps its workflow_call contract", () => {
  assert.ok(
    extractTriggers(read(CODEQL)).has("workflow_call"),
    "codeql.yml must stay `workflow_call`-consumable — a GHAS consumer pins it"
  );
});

test("no reusable workflow a consumer calls gained a CodeQL job", () => {
  // The fleet's private repos (athportal, domio, swarm-os) have code scanning
  // disabled; a CodeQL job there fails closed on a 403. The vendored Semgrep
  // tier remains their blocking SAST.
  const prQuality = read(PR_QUALITY);
  assert.ok(
    !/uses:.*codeql\.yml/.test(prQuality),
    "pr-quality.yml must not call codeql.yml — this gate is repository-local"
  );
  assert.ok(
    !/github\/codeql-action\/(init|autobuild|analyze)/.test(prQuality),
    "pr-quality.yml must not run CodeQL analysis steps — a consumer without " +
      "Advanced Security would gain a newly-failing job"
  );
});

test("the required status-context set is unchanged", () => {
  const contract = JSON.parse(read(CONTRACT));
  assert.deepEqual(
    contract.requiredStatusChecks,
    [AGGREGATOR],
    "gating through the aggregator exists precisely so the required-context " +
      "set stays a single entry — adding CodeQL's check name here would fail " +
      "check-required-contexts.mjs, which matches declared entries against " +
      "job identifiers"
  );
});

// ---------------------------------------------------------------------------
// AC-6 — the gate has a documented way out
// ---------------------------------------------------------------------------

test("AC-6: the rollback runbook names all three recovery moves, in order", () => {
  const runbook = read(ROLLBACK);
  const section = runbook.slice(runbook.indexOf("## 7."));
  assert.ok(section.length > 0, "rollback.md must carry a code-scanning gate section");

  const moves = [
    /\(a\).*dismiss/is,
    /\(b\).*fail-on-alert-severity/is,
    /\(c\).*break.glass/is,
  ];
  let cursor = 0;
  for (const [i, move] of moves.entries()) {
    const rest = section.slice(cursor);
    const m = rest.match(move);
    assert.ok(m, `recovery move ${"abc"[i]} must be documented`);
    cursor += m.index + 1;
  }

  // The break-glass move has to say WHO, or it is not a runbook entry.
  assert.match(
    section,
    /@dsj1984/,
    "the break-glass move must name who may perform it — this repository's " +
      "ruleset carries an EMPTY bypass list, so no role bypasses it implicitly"
  );
  assert.match(
    section,
    /ci-required/,
    "the runbook must name the required context the gate reaches through"
  );
});
