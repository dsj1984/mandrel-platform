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
  const startRe = new RegExp(`^  ${job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`);
  const start = lines.findIndex((l) => startRe.test(l));
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
 * The block declaring one composite-action input. Anchored to a line start
 * because the action's header carries USAGE COMMENTS that contain the same
 * `  <input>:` text — an unanchored indexOf reads the comment instead.
 *
 * @param {string} text @param {string} name
 */
export function actionInput(text, name) {
  const m = new RegExp(`^  ${name}:$`, "m").exec(text);
  assert.ok(m, `input '${name}' not declared`);
  const rest = text.slice(m.index + m[0].length);
  const next = /^  [A-Za-z_-]+:$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
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
    const m = ACTION.match(
      new RegExp(`"${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)\\s*\\w+="([0-9a-f]{64})"`),
    );
    assert.ok(m, `missing pinned SHA-256 for ${slug}`);
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
