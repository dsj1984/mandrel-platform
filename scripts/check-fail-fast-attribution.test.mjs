#!/usr/bin/env node
/**
 * check-fail-fast-attribution.test.mjs — regression guard for fail-fast
 * cancellation attribution in `.github/workflows/pr-quality.yml` (Story #331).
 *
 * WHY THIS EXISTS
 * ---------------
 * Opt-in `fail-fast` (Story #223) cancels the whole run on the first tier
 * failure. GitHub records a bare `cancelled` conclusion on every sibling tier
 * — with no pointer to the tier that actually failed. A job-status scan then
 * reads N red jobs and blames the wrong one: in swarm-os run 30168441137 the
 * Accessibility tier failed on a transient build flake, fail-fast cancelled
 * Typecheck and Lint & format (both of which had already passed their own work
 * step), and triage landed on Typecheck.
 *
 * The fix writes the attribution at two workflow surfaces, and this suite pins
 * both against regression:
 *
 *   1. TRIGGER SIDE (`&cancel-on-failure`) — the authoritative record. It runs
 *      in a job whose conclusion is `failure`, never `cancelled`, so it is not
 *      subject to the runner's cancellation grace budget. It emits a run-level
 *      `::error title=fail-fast::` annotation and a job-summary block naming
 *      the tier, BEFORE requesting the cancel — so the record survives even
 *      when the cancel call itself fails.
 *
 *   2. COLLATERAL SIDE (`&explain-cancellation`) — best effort. Fires only on
 *      `cancelled()`, states that this tier did not itself fail, and resolves
 *      the real culprit from the Actions API. Loud-but-non-fatal on the cancel
 *      step's terms: every lookup failure degrades to a generic message and
 *      exits 0, and `timeout-minutes: 1` keeps the lookup from eating the
 *      grace budget the tier's own artifact uploads need.
 *
 * It also pins the negative space that makes this change safe to ship to
 * consumers: no new permission surface. GitHub validates a called workflow's
 * declared JOB permissions against the caller's grant at compile time,
 * ignoring the job's `if:` gate — so a job-level `permissions:` block here
 * would `startup_failure` every consumer that has not widened its caller
 * token, whether or not they enable fail-fast.
 *
 * Run: node --test scripts/check-fail-fast-attribution.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/pr-quality.yml";
const source = readFileSync(join(repoRoot, WORKFLOW), "utf8");
const lines = source.split("\n");

const EXPLAIN = "explain-cancellation";
const CANCEL = "cancel-on-failure";

// ---------------------------------------------------------------------------
// Indentation-based extraction (dependency-free, mirroring the approach in
// check-ci-required-aggregator.test.mjs). Steps are `      - ` entries at
// 6-space indent; jobs are `  <id>:` at 2-space indent.
// ---------------------------------------------------------------------------

/** The step block introduced by `      - &<anchor>`, through its last line. */
function extractAnchoredStep(anchor) {
  const start = lines.findIndex((l) => l === `      - &${anchor}`);
  assert.notEqual(start, -1, `anchor \`&${anchor}\` not found in ${WORKFLOW}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (lines[i].match(/^(\s*)/)[1].length <= 6) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The dedented body of a step's `run: |` block scalar. */
function extractRunScript(step) {
  const stepLines = step.split("\n");
  const start = stepLines.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l));
  assert.notEqual(start, -1, "`run: |` block not found");
  const runIndent = stepLines[start].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = start + 1; i < stepLines.length; i++) {
    if (/^\s*$/.test(stepLines[i])) {
      body.push("");
      continue;
    }
    if (stepLines[i].match(/^(\s*)/)[1].length <= runIndent) break;
    body.push(stepLines[i].slice(runIndent + 2));
  }
  return body.join("\n");
}

/**
 * Every job in the workflow, as `{ id, stepRefs }` where `stepRefs` is the
 * ordered list of anchor/alias names used as step entries (`- &x` / `- *x`).
 * A plain `- name: …` step contributes nothing — only the aliased ones matter
 * for the ordering invariant this suite pins.
 */
function extractJobs() {
  const jobsStart = lines.findIndex((l) => l === "jobs:");
  assert.notEqual(jobsStart, -1, "`jobs:` not found");
  const jobs = [];
  let current = null;
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const jobHeader = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobHeader) {
      current = { id: jobHeader[1], stepRefs: [] };
      jobs.push(current);
      continue;
    }
    const stepRef = lines[i].match(/^ {6}- [&*]([A-Za-z0-9_-]+)\s*$/);
    if (stepRef && current) current.stepRefs.push(stepRef[1]);
  }
  assert.ok(jobs.length > 0, "no jobs parsed");
  return jobs;
}

const explainStep = extractAnchoredStep(EXPLAIN);
const cancelStep = extractAnchoredStep(CANCEL);
const jobs = extractJobs();

// ---------------------------------------------------------------------------
// 1. STRUCTURE — the two attribution surfaces exist, are correctly gated, and
//    are wired into every tier job that participates in fail-fast.
// ---------------------------------------------------------------------------

test("the collateral explainer fires only on cancellation under fail-fast", () => {
  assert.match(
    explainStep,
    /^\s+if:\s+\$\{\{\s*cancelled\(\)\s*&&\s*inputs\.fail-fast\s*\}\}\s*$/m,
    "`&explain-cancellation` must be gated `cancelled() && inputs.fail-fast` — " +
      "an `always()` gate would fire it on the green path"
  );
});

test("the trigger-side record fires only on this tier's own failure", () => {
  assert.match(
    cancelStep,
    /^\s+if:\s+\$\{\{\s*failure\(\)\s*&&\s*inputs\.fail-fast\s*\}\}\s*$/m,
    "`&cancel-on-failure` must stay gated `failure() && inputs.fail-fast` — " +
      "the two attribution gates must remain mutually exclusive"
  );
});

test("the collateral explainer is time-bounded", () => {
  // A cancelled job runs its remaining cancelled()/always() steps inside a
  // bounded runner grace period. An unbounded API lookup here would compete
  // with the tier's own artifact uploads for that budget.
  assert.match(
    explainStep,
    /^\s+timeout-minutes:\s+1\s*$/m,
    "`&explain-cancellation` must declare `timeout-minutes: 1`"
  );
});

test("every fail-fast tier job carries both attribution steps", () => {
  const participating = jobs.filter((j) => j.stepRefs.includes(CANCEL));
  assert.ok(
    participating.length >= 8,
    `expected every tier job to alias \`${CANCEL}\`; found ${participating.length}`
  );
  for (const job of participating) {
    assert.ok(
      job.stepRefs.includes(EXPLAIN),
      `job \`${job.id}\` aliases \`${CANCEL}\` but not \`${EXPLAIN}\` — a ` +
        `cancelled ${job.id} would report a bare 'cancelled' with no upstream pointer`
    );
  }
});

test("the explainer immediately precedes the cancel step, which stays last", () => {
  for (const job of jobs.filter((j) => j.stepRefs.includes(CANCEL))) {
    const cancelIdx = job.stepRefs.indexOf(CANCEL);
    const explainIdx = job.stepRefs.indexOf(EXPLAIN);
    assert.equal(
      explainIdx,
      cancelIdx - 1,
      `job \`${job.id}\`: \`${EXPLAIN}\` must sit immediately before \`${CANCEL}\``
    );
    assert.equal(
      cancelIdx,
      job.stepRefs.length - 1,
      `job \`${job.id}\`: \`${CANCEL}\` must remain the LAST step, so ` +
        `\`if: always()\` uploads finish before the run-wide cancel signal lands`
    );
  }
});

// ---------------------------------------------------------------------------
// 2. PERMISSION SURFACE — unchanged. `gh run view` needs only `actions: read`,
//    already covered by the workflow-level `actions: write`.
// ---------------------------------------------------------------------------

/**
 * Job-level permission blocks, as `{ job: [scope, …] }`. Three jobs already
 * declare one on `main` (a job-level block REPLACES the workflow-level one, so
 * each has to re-declare the fail-fast cancel grant). This suite pins that
 * inventory rather than forbidding it outright: the invariant that matters is
 * that fail-fast attribution introduced no NEW grant.
 */
function extractJobPermissions() {
  const found = {};
  let job = null;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) job = header[1];
    if (!/^ {4}permissions:/.test(lines[i])) continue;
    const scopes = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*#/.test(lines[j])) continue;
      const scope = lines[j].match(/^ {6}([a-z-]+):\s*(\S+)\s*$/);
      if (!scope) break;
      scopes.push(`${scope[1]}: ${scope[2]}`);
    }
    found[job] = scopes;
  }
  return found;
}

test("no job declares a permission beyond the pre-existing inventory", () => {
  // A job-level `permissions:` block is validated against the CALLER's grant
  // at compile time, ignoring the job's `if:` gate — a new or widened one here
  // startup_failures EVERY consumer that has not widened its caller token,
  // including consumers that never enable the tier. `gh run view` (the
  // collateral explainer's culprit lookup) needs only `actions: read`, which
  // the existing `actions: write` already covers, so nothing had to change.
  assert.deepEqual(extractJobPermissions(), {
    "migration-guard": ["contents: read", "actions: write", "pull-requests: read"],
    security: ["contents: read", "actions: write"],
    "osv-scan": ["contents: read", "actions: write"],
  });
});

test("the workflow-level permission grant is unchanged", () => {
  assert.match(
    source,
    /^permissions:\n {2}contents: read\n {2}actions: write\n/m,
    "the attribution steps must not widen the declared permission surface"
  );
});

// ---------------------------------------------------------------------------
// 3. SEMANTICS — the two run scripts, executed under real bash against a
//    stubbed `gh` on PATH.
// ---------------------------------------------------------------------------

/**
 * Execute a step's run script with a stubbed `gh` (and `curl`) shadowing any
 * real binaries, so the scripts' branches are exercised without network I/O.
 */
function runStep(script, { ghExit = 0, ghStdout = "", env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fail-fast-attr-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const cmd of ["gh", "curl"]) {
      const stub = join(bin, cmd);
      writeFileSync(
        stub,
        `#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(ghStdout)}\nexit ${ghExit}\n`
      );
      chmodSync(stub, 0o755);
    }
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const file = join(dir, "step.sh");
    writeFileSync(file, script);
    const r = spawnSync("bash", [file], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_API_URL: "https://api.github.invalid",
        GH_TOKEN: "stub-token",
        RUN_ID: "30168441137",
        REPO: "Beestera/swarm-os",
        TIER_ID: "typecheck",
        ...env,
      },
    });
    return { ...r, summary: readFileSync(summary, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cancelScript = extractRunScript(cancelStep);
const explainScript = extractRunScript(explainStep);

test("trigger side: names the failing tier in a run-level annotation", () => {
  const r = runStep(cancelScript, { env: { TIER_ID: "e2e" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /::error title=fail-fast::/,
    "the trigger must emit a run-level annotation, not just a log line"
  );
  assert.match(r.stdout, /e2e/, "the annotation must name the tier that failed");
  assert.match(r.stdout, /collateral/);
});

test("trigger side: writes the attribution to the job summary", () => {
  const r = runStep(cancelScript, { env: { TIER_ID: "e2e" } });
  assert.match(r.summary, /fail-fast triggered by/);
  assert.match(r.summary, /e2e/);
});

test("trigger side: records the attribution even when the cancel call fails", () => {
  // A caller whose token lacks `actions: write` cannot cancel — the record of
  // WHICH tier failed must still land, which is why it is written first.
  const r = runStep(cancelScript, { ghExit: 1, ghStdout: "000" });
  assert.equal(r.status, 0, "the cancel step stays non-fatal");
  assert.match(r.stdout, /::error title=fail-fast::/);
  assert.match(r.summary, /fail-fast triggered by/);
});

test("collateral side: names the real culprit when the lookup succeeds", () => {
  const r = runStep(explainScript, { ghStdout: "Accessibility (2/3)" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::notice title=fail-fast collateral::/);
  assert.match(r.stdout, /Accessibility \(2\/3\)/);
  assert.match(r.summary, /Accessibility \(2\/3\)/);
  assert.match(r.summary, /did \*\*not\*\* fail/);
});

test("collateral side: degrades to a generic message when the lookup fails", () => {
  const r = runStep(explainScript, { ghExit: 1 });
  assert.equal(
    r.status,
    0,
    "a failed culprit lookup must never fail the step — it is best-effort"
  );
  assert.match(r.stdout, /::notice title=fail-fast collateral::/);
  assert.match(r.stdout, /could not be resolved/);
  assert.match(r.summary, /could not be resolved/);
});

test("collateral side: still explains itself when gh is absent entirely", () => {
  // Self-hosted runners are not guaranteed to ship the gh CLI.
  const dir = mkdtempSync(join(tmpdir(), "fail-fast-nogh-"));
  try {
    const empty = join(dir, "bin");
    mkdirSync(empty);
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const file = join(dir, "step.sh");
    writeFileSync(file, explainScript);
    // Resolve bash absolutely — PATH is deliberately emptied for the child so
    // `command -v gh` finds nothing.
    const r = spawnSync("/bin/bash", [file], {
      encoding: "utf8",
      env: {
        PATH: empty,
        GITHUB_STEP_SUMMARY: summary,
        RUN_ID: "1",
        REPO: "o/r",
        TIER_ID: "lint",
        GH_TOKEN: "stub-token",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lint/);
    assert.match(readFileSync(summary, "utf8"), /could not be resolved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collateral side: never claims this tier failed", () => {
  const r = runStep(explainScript, { ghStdout: "Accessibility (2/3)" });
  assert.doesNotMatch(
    r.stdout,
    /::error/,
    "a collateral cancel must not emit a failure annotation — that is what " +
      "made cancelled siblings indistinguishable from the real failure"
  );
});
