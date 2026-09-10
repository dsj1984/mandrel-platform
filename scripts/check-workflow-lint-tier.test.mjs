// Structural guards for the workflow-lint tier (Story #425).
//
// These assertions are deliberately STRUCTURAL rather than textual: each one
// resolves the actual `workflow-lint` job block and inspects the keys inside
// it. A repo-wide grep cannot do this job — `pr-quality.yml` legitimately
// carries job-level `permissions:` on three OTHER jobs, so "does the file
// contain `permissions:`" answers a question nobody asked.
//
// The invariant that matters most here is the ABSENCE of a job-level
// `permissions:` on the new tier. GitHub validates a called reusable
// workflow's declared job permissions against the caller's grant at COMPILE
// time, regardless of the job's `if:` gate — so adding a scope to this job
// fails the ENTIRE call with `startup_failure` (zero jobs) for every consumer
// that has not granted it, including consumers who turned the tier off. Story
// #292 is the precedent: `pull-requests: read` on migration-guard broke
// ci.yml and the cross-repo smoke consumer, and stranded a release
// unpublished. That break is invisible until a consumer's next pin bump,
// which is exactly the kind of regression a unit test should hold.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

const PR_QUALITY = read(".github/workflows/pr-quality.yml");
const CI = read(".github/workflows/ci.yml");
const ACTION = read(".github/actions/workflow-lint/action.yml");
const DOCS = read("docs/reusable-workflows.md");

/**
 * Return the lines belonging to one top-level job — from `  <name>:` until the
 * next key at the same indentation. This is the "parse" the permissions
 * assertion needs: it scopes the search to ONE job rather than the file.
 *
 * @param {string} text  Workflow file contents.
 * @param {string} job   Job id, e.g. "workflow-lint".
 * @returns {string[]}
 */
export function jobBlock(text, job) {
  const lines = text.split(/\r?\n/);
  // A plain line comparison, not a built regex: Semgrep's
  // detect-non-literal-regexp rejects a RegExp built from a non-literal,
  // and a job header is an exact line anyway.
  const start = lines.findIndex((l) => l.trimEnd() === `  ${job}:`);
  assert.notEqual(start, -1, `job '${job}' not found`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // A new key at the job's own indent (2 spaces) ends this block. Blank
    // lines and comments belong to whatever follows, so they never terminate.
    if (/^ {2}\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

/** Keys declared directly on a job (indent 4), ignoring nested mappings. */
export function jobKeys(block) {
  return block
    .filter((l) => /^ {4}[A-Za-z_-]+:/.test(l))
    .map((l) => l.trim().split(":")[0]);
}

/**
 * The composite's single `run:` block — everything after its `run: |` line.
 * The infra-failure assertions below are about SHELL CONTROL FLOW, so they
 * must not be able to match the action's header comments, which describe that
 * flow in prose using the same words.
 *
 * @param {string} text
 * @returns {string}
 */
export function runBlock(text) {
  const marker = "\n      run: |\n";
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, "the composite's run: block was not found");
  const block = text.slice(start + marker.length);
  assert.ok(block.includes("set -euo pipefail"), "run: block did not resolve to the script");
  return block;
}

/**
 * The body of one shell function defined at the run-block's own indent.
 * Scoped like `jobBlock`: the point is to assert what `infra_fail` does, not
 * that the two words appear somewhere in a 300-line file.
 *
 * @param {string} run @param {string} name
 * @returns {string}
 */
export function shellFunction(run, name) {
  const lines = run.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `${name}() {`);
  assert.notEqual(start, -1, `shell function '${name}' not defined`);
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "}") return body.join("\n");
    body.push(lines[i]);
  }
  assert.fail(`shell function '${name}' is unterminated`);
}

/**
 * The block declaring one composite-action input. Anchored to a line start
 * because the action's header carries USAGE COMMENTS that contain the same
 * `  <input>:` text — an unanchored indexOf reads the comment instead.
 *
 * @param {string} text @param {string} name
 */
export function actionInput(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimEnd() === `  ${name}:`);
  assert.ok(start !== -1, `input '${name}' not declared`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    // The next input header (indent 2, bare key) ends this block.
    if (/^ {2}[A-Za-z_-]+:\s*$/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join("\n");
}

// ---------------------------------------------------------------------------
// The compile-time consumer break (AC-3)
// ---------------------------------------------------------------------------

test("the workflow-lint job declares NO job-level permissions", () => {
  const keys = jobKeys(jobBlock(PR_QUALITY, "workflow-lint"));
  assert.ok(
    !keys.includes("permissions"),
    "adding a job-level `permissions:` scope here fails the ENTIRE reusable-workflow " +
      "call with startup_failure for every consumer lacking that grant, regardless " +
      "of the job's `if:` gate (Story #292). Use the workflow-level grant instead.",
  );
});

test("the scoping is real: other pr-quality jobs DO declare permissions", () => {
  // If this ever fails, `jobBlock` has stopped scoping and the assertion above
  // has quietly become vacuous.
  const withPermissions = ["migration-guard", "security", "osv-scan"].filter((job) =>
    jobKeys(jobBlock(PR_QUALITY, job)).includes("permissions"),
  );
  assert.ok(
    withPermissions.length > 0,
    "expected at least one job to declare permissions, else the guard above proves nothing",
  );
});

// ---------------------------------------------------------------------------
// Inputs and defaults (AC-3, AC-8)
// ---------------------------------------------------------------------------

test("enable-workflow-lint is a boolean defaulting to true", () => {
  const block = PR_QUALITY.slice(PR_QUALITY.indexOf("      enable-workflow-lint:"));
  assert.match(block.slice(0, 300), /type: boolean/);
  assert.match(block.slice(0, 300), /default: true/);
});

test("workflow-lint-enforce is a boolean defaulting to false — advisory on arrival", () => {
  const block = PR_QUALITY.slice(PR_QUALITY.indexOf("      workflow-lint-enforce:"));
  assert.match(block.slice(0, 400), /type: boolean/);
  assert.match(
    block.slice(0, 400),
    /default: false/,
    "the tier must ship advisory: a consumer inheriting it on a pin bump must not " +
      "have pre-existing workflow debt red their merge",
  );
});

test("the tier-timeouts description names the new tier key", () => {
  const desc = PR_QUALITY.slice(
    PR_QUALITY.indexOf("      tier-timeouts:"),
    PR_QUALITY.indexOf("      tier-timeouts:") + 900,
  );
  assert.match(desc, /workflow-lint/);
});

// ---------------------------------------------------------------------------
// Gate wiring (AC-4)
// ---------------------------------------------------------------------------

test("workflow-lint is a needs: of ci-required", () => {
  const block = jobBlock(PR_QUALITY, "ci-required").join("\n");
  const needs = block.slice(block.indexOf("needs:"), block.indexOf("steps:"));
  assert.match(
    needs,
    /^\s*- workflow-lint$/m,
    "the aggregator is self-maintaining — adding the job to needs: is the only edit " +
      "required to make the tier branch-protection load-bearing, with no new required " +
      "context to register when it later flips to enforcing",
  );
});

test("the tier's base timeout is present in TIER_TIMEOUT_BASES", () => {
  const job = jobBlock(PR_QUALITY, "workflow-lint").join("\n");
  const m = job.match(/tier-timeouts\)\['workflow-lint'\]\s*\|\|\s*(\d+)/);
  assert.ok(m, "the tier must read its budget from the tier-timeouts map");
  const base = m[1];
  const bases = PR_QUALITY.match(/TIER_TIMEOUT_BASES:\s*'(\[[^\]]*\])'/);
  assert.ok(bases, "TIER_TIMEOUT_BASES not found");
  assert.ok(
    JSON.parse(bases[1]).includes(Number(base)),
    `base ceiling ${base} must appear in TIER_TIMEOUT_BASES ${bases[1]} — the ` +
      "cancelled-provenance classifier infers a timed-out cancel by matching a job's " +
      "wall duration against that set",
  );
});

test("the tier honours the runner input like every other tier", () => {
  const job = jobBlock(PR_QUALITY, "workflow-lint").join("\n");
  assert.match(job, /runs-on: \$\{\{ fromJSON\(startsWith\(inputs\.runner, '\['\)/);
});

test("the tier is gated on its enable input", () => {
  const job = jobBlock(PR_QUALITY, "workflow-lint").join("\n");
  assert.match(job, /if: \$\{\{ inputs\.enable-workflow-lint \}\}/);
});

test("pr-quality pins the composite by absolute SHA, as consumers require", () => {
  const job = jobBlock(PR_QUALITY, "workflow-lint").join("\n");
  assert.match(
    job,
    /uses: dsj1984\/mandrel-platform\/\.github\/actions\/workflow-lint@[0-9a-f]{40}$/m,
    "a reusable workflow must reference first-party actions by absolute owner/repo " +
      "path at a full 40-hex SHA — a relative ./ path resolves against the CALLER's " +
      "checkout, where this action does not exist",
  );
});

// ---------------------------------------------------------------------------
// Tool posture (AC-6) and consolidation (AC-7)
// ---------------------------------------------------------------------------

test("zizmor runs offline at the configured minimum severity", () => {
  assert.match(ACTION, /--offline/, "online audits red on real ref-version-mismatch " +
    "findings and would make the gate depend on a live API call");
  assert.match(ACTION, /--min-severity "\$\{ZIZMOR_MIN_SEVERITY\}"/);
  assert.match(ACTION, /default: 'medium'/);
});

test("zizmor's findings never set the exit code — the gate script decides", () => {
  assert.match(ACTION, /--no-exit-codes/);
});

test("pyflakes is always disabled and shellcheck is opt-in", () => {
  assert.match(ACTION, /-pyflakes=/, "pyflakes must be explicitly disabled, not left to PATH");
  assert.match(ACTION, /inputs\.shellcheck/);
  assert.match(
    actionInput(ACTION, "shellcheck"),
    /default: ''|default: 'false'/,
    "consumers must not inherit a PATH-dependent gate",
  );
});

test("consumers get shellcheck off; this repo's own ci.yml opts in", () => {
  const job = jobBlock(PR_QUALITY, "workflow-lint").join("\n");
  assert.match(job, /shellcheck: 'false'/);
  const ciJob = jobBlock(CI, "actionlint").join("\n");
  assert.match(
    ciJob,
    /shellcheck: 'true'/,
    "ci.yml relied on ubuntu-latest's PATH shellcheck before this tier existed; " +
      "consolidating onto the composite must not silently drop that coverage",
  );
});

test("ci.yml keeps actionlint blocking while zizmor lands advisory", () => {
  const ciJob = jobBlock(CI, "actionlint").join("\n");
  assert.match(ciJob, /enforce-actionlint: 'true'/);
  assert.match(ciJob, /enforce-zizmor: 'false'/);
});

test("ci.yml carries no actionlint version or checksum of its own (AC-7)", () => {
  assert.ok(
    !/ACTIONLINT_VERSION|ACTIONLINT_SHA256/.test(CI),
    "the version + checksum map must exist in exactly one place — the composite — " +
      "or a bump silently updates one copy and leaves the other running an old binary",
  );
  assert.match(jobBlock(CI, "actionlint").join("\n"), /uses: \.\/\.github\/actions\/workflow-lint/);
});

test("the composite pins four checksums per tool across darwin/linux x amd64/arm64", () => {
  for (const slug of [
    "1.7.12_darwin_amd64",
    "1.7.12_darwin_arm64",
    "1.7.12_linux_amd64",
    "1.7.12_linux_arm64",
    "1.30.0_aarch64-apple-darwin",
    "1.30.0_x86_64-apple-darwin",
    "1.30.0_aarch64-unknown-linux-gnu",
    "1.30.0_x86_64-unknown-linux-gnu",
  ]) {
    // Plain string scan (no built regex — see jobBlock): find the slug's own
    // case arm, then assert the 64-hex literal that follows it on that line.
    const arm = ACTION.split(/\r?\n/).find((l) => l.includes(`"${slug}")`));
    assert.ok(arm, `missing case arm for ${slug}`);
    assert.match(arm, /="[0-9a-f]{64}"/, `missing pinned SHA-256 for ${slug}`);
  }
});

test("an unmapped platform slug is a hard error, never a silent skip", () => {
  assert.match(ACTION, /No pinned checksum for actionlint/);
  assert.match(ACTION, /No pinned checksum for zizmor/);
  assert.match(ACTION, /actionlint checksum mismatch/);
  assert.match(ACTION, /zizmor checksum mismatch/);
});

test("actionlint gets no path arguments — it errors on a directory", () => {
  // The tools disagree on argument shape; unifying them broke the first cut.
  assert.match(ACTION, /auto-discovers/);
  assert.match(ACTION, /\$\{zz_targets\}/, "zizmor takes the resolved directory list");
  assert.ok(
    !/actionlint" -no-color -format '\{\{json \.\}\}'[^\n]*\$\{zz_targets\}/.test(ACTION),
    "actionlint must not be handed directory arguments",
  );
});

test("ci.yml's dogfood self-call does not run the natively-covered tier", () => {
  // The self-call exists to dogfood the SECURITY tier; every tier ci.yml runs
  // itself is disabled there. workflow-lint is now one of them — and leaving it
  // on would also make the dogfood depend on the tier's SHA-pinned `uses:`,
  // which cannot resolve in the PR that first introduces the action.
  const block = CI.slice(CI.indexOf("uses: ./.github/workflows/pr-quality.yml"));
  assert.match(block.slice(0, 1500), /enable-workflow-lint: false/);
});

test("no test or action file builds a RegExp from a non-literal", () => {
  // Semgrep's detect-non-literal-regexp is diff-baselined and blocks new JS
  // that does. Pinning it here keeps a future edit from rediscovering it in CI.
  for (const rel of [
    "scripts/check-workflow-lint-tier.test.mjs",
    "scripts/workflow-lint-gate.test.mjs",
    ".github/actions/workflow-lint/workflow-lint-gate.mjs",
  ]) {
    // Assembled so this guard's own needle is not a literal occurrence.
    const needle = ["new", "RegExp("].join(" ");
    assert.ok(!read(rel).includes(needle), `${rel} builds a RegExp dynamically`);
  }
});

// ---------------------------------------------------------------------------
// Documentation (AC-8)
// ---------------------------------------------------------------------------

test("the docs carry an inputs row and a dedicated tier section", () => {
  assert.match(DOCS, /\| `enable-workflow-lint`/);
  assert.match(DOCS, /### Workflow lint tier \(`enable-workflow-lint`\)/);
});

test("the docs explain the advisory posture, the dial, shellcheck and provenance", () => {
  const start = DOCS.indexOf("### Workflow lint tier (`enable-workflow-lint`)");
  assert.notEqual(start, -1);
  const section = DOCS.slice(start, start + 9000);
  assert.match(section, /advisory/i);
  assert.match(section, /workflow-lint-enforce/);
  assert.match(section, /shellcheck/i);
  assert.match(section, /checksum/i);
  assert.match(section, /no checksums file/i, "the zizmor provenance caveat must be recorded");
});

// ---------------------------------------------------------------------------
// Infrastructure failure routes to the gate, not to `exit 1` (Story #496, AC-2)
// ---------------------------------------------------------------------------
//
// Before #496 a release-CDN blip on either binary `exit 1`-ed inside this
// inline bash BEFORE the gate script was ever invoked, so the enforcement dial
// the gate owns could not see it: an advisory tier reddened every consumer's
// required check on someone else's outage. These assertions pin the routing —
// the behaviour on the other side of it is unit-tested end-to-end in
// `workflow-lint-gate.test.mjs`, which runs the real gate.

test("the gate is the ONE exit from this step — every path funnels through it", () => {
  const run = runBlock(ACTION);
  assert.equal(
    run.split("workflow-lint-gate.mjs").length - 1,
    1,
    "the gate must be invoked from exactly one place (`run_gate`), or the infra " +
      "path and the normal path can drift into disagreeing about the dial",
  );
  const gate = shellFunction(run, "run_gate");
  assert.match(
    gate,
    /WORKFLOW_LINT_INFRA_FAILURE="\$\{1:-\}"/,
    "the reason travels to the gate as an env var, empty on the normal path",
  );
  assert.match(gate, /WORKFLOW_LINT_ENFORCE="\$\{WORKFLOW_LINT_ENFORCE\}"/);
  assert.match(gate, /node "\$\{ACTION_PATH\}\/workflow-lint-gate\.mjs"/);
  assert.match(run, /^\s*run_gate ""$/m, "the normal path still invokes the gate");
});

test("infra_fail writes empty reports and hands the reason to the gate", () => {
  const body = shellFunction(runBlock(ACTION), "infra_fail");
  assert.match(body, /echo "\[\]" > "\$\{al_report\}"/);
  assert.match(body, /echo "\[\]" > "\$\{zz_report\}"/);
  assert.match(body, /run_gate "\$1"/, "the failure reason is forwarded, not swallowed");
  assert.match(
    body,
    /exit "\$infra_code"/,
    "the step's exit code is the GATE's verdict, not a hard-coded 1",
  );
});

test("the download branches route to infra_fail rather than exiting 1", () => {
  const run = runBlock(ACTION);
  // curl's failure must be CAPTURED — an unguarded curl under `set -e` aborts
  // the step before any of this routing can run.
  for (const varName of ["al_curl", "zz_curl"]) {
    assert.ok(run.includes(`${varName}=$?`), `${varName} does not capture curl's exit code`);
    assert.ok(
      run.includes(`if [ "$${varName}" -ne 0 ]; then`),
      `${varName} is captured but never branched on`,
    );
  }
  assert.equal(
    run.split('infra_fail "download-failed:').length - 1,
    2,
    "both downloads (actionlint and zizmor) must route to infra_fail",
  );
});

test("the checksum-mismatch branches route to infra_fail rather than exiting 1", () => {
  const run = runBlock(ACTION);
  assert.equal(
    run.split('infra_fail "checksum-mismatch:').length - 1,
    2,
    "both checksum comparisons must route to infra_fail",
  );
  // Trust is unchanged: a mismatch still never reaches extract/execute.
  const mismatch = run.slice(run.indexOf('infra_fail "checksum-mismatch: actionlint'));
  assert.ok(
    mismatch.indexOf("tar -xzf") > 0,
    "the mismatch branch must precede extraction — an unverified archive is never opened",
  );
});

test("an unmapped platform routes to infra_fail from all four sites", () => {
  const run = runBlock(ACTION);
  assert.equal(
    run.split('infra_fail "unmapped-platform:').length - 1,
    4,
    "unsupported OS, unsupported arch, and the two unmapped checksum slugs",
  );
});

test("no infrastructure path exits 1 directly any more", () => {
  const run = runBlock(ACTION);
  const hardExits = run
    .split(/\r?\n/)
    .filter((l) => l.trim() === "exit 1" || l.trim().endsWith("; exit 1 ;;"));
  assert.deepEqual(
    hardExits,
    [],
    "a bare `exit 1` here bypasses the gate's dial entirely, which is the defect " +
      "Story #496 removed. Route the failure through infra_fail instead.",
  );
});

test("a genuine TOOL failure still exits non-zero regardless of the dial", () => {
  // The split matters: a linter that RAN and crashed is about the caller's
  // tree, not about a third-party CDN, so it is red either way.
  const run = runBlock(ACTION);
  assert.match(run, /exit "\$al_code"/);
  assert.match(run, /exit "\$zz_code"/);
});

// ---------------------------------------------------------------------------
// The posture is documented on both surfaces (Story #496, AC-3)
// ---------------------------------------------------------------------------

test("the enforce input describes the advisory infra-failure posture", () => {
  const desc = actionInput(ACTION, "enforce").replace(/\s+/g, " ");
  assert.match(desc, /INFRASTRUCTURE FAILURES follow this same dial/);
  assert.match(desc, /exits 0 while the tier is advisory/);
  assert.match(
    desc,
    /TOOL failure/,
    "the description must still name the class that is red regardless",
  );
});

test("the docs no longer claim infrastructure failures always fail the tier", () => {
  assert.ok(
    !/always fails? the tier/i.test(DOCS),
    "the retired sentence (download/checksum/tool failures always fail the tier) " +
      "is now wrong for two of those three classes",
  );
  const start = DOCS.indexOf("### Workflow lint tier (`enable-workflow-lint`)");
  assert.notEqual(start, -1);
  const section = DOCS.slice(start, start + 9000);
  assert.match(section, /infrastructure failure/i);
  assert.match(
    section,
    /exits 0 while the tier\s+is advisory/,
    "the section must state the advisory-until-enforced behaviour explicitly",
  );
  assert.match(section, /never extracted or executed/, "the trust caveat must survive");
});
