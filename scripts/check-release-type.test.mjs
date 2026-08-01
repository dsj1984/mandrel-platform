#!/usr/bin/env node
/**
 * check-release-type.test.mjs — node:test suite for the release-type advisory
 * (Story #368).
 *
 * The check exists to catch ONE pair: a diff touching the surface this
 * repository publishes, landed under a title whose conventional-commit type
 * cuts no release. Every other combination must stay silent, so the suite
 * spends as much effort proving the quiet cases as the loud one — a lint that
 * cries wolf on internal edits is worse than no lint.
 *
 * `runCheck` is pure (title, file list, type sets and a `readFile` seam all
 * passed in), so the behavioural cases need no repository and no git. The
 * wiring cases read the real ci.yml, release-please-config.json and
 * package.json, because "reads the type set from the release config" and
 * "adds no new status context" are claims about THIS repo, not about a
 * fixture.
 *
 * Run: node --test scripts/check-release-type.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stepByName, runScript } from "./lib/yaml-step.mjs";
import {
  EXIT,
  parseArgs,
  parseTitleType,
  loadReleaseTypes,
  loadPublishedPaths,
  classifyTitle,
  classifyFile,
  runCheck,
  renderReport,
  changedFiles,
  runCli,
} from "./check-release-type.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(REPO_ROOT, p), "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal release-please config with the same hidden/visible split shape. */
const CONFIG = JSON.stringify({
  packages: {
    ".": {
      "changelog-sections": [
        { type: "feat", section: "Added" },
        { type: "fix", section: "Fixed" },
        { type: "refactor", section: "Changed" },
        { type: "docs", section: "Documentation", hidden: true },
        { type: "chore", section: "Chores", hidden: true },
        { type: "ci", section: "CI/CD", hidden: true },
      ],
    },
  },
});

const TYPES = loadReleaseTypes(CONFIG);
const PUBLISHED = ["config", "default.json", "scripts", "templates"];

const REUSABLE_WORKFLOW = [
  "name: PR quality",
  "on:",
  "  workflow_call:",
  "    inputs:",
  "      enable-lint:",
  "        type: boolean",
  "jobs: {}",
].join("\n");

const INTERNAL_WORKFLOW = [
  "name: CI",
  "on:",
  "  pull_request:",
  "    branches: [main]",
  "jobs: {}",
].join("\n");

/** A `readFile` seam over an in-memory path → body map. */
const files = (map) => (p) => (Object.hasOwn(map, p) ? map[p] : null);

const TREE = files({
  ".github/workflows/pr-quality.yml": REUSABLE_WORKFLOW,
  ".github/workflows/ci.yml": INTERNAL_WORKFLOW,
});

/** Drive `runCheck` with the shared fixture context. */
const check = (title, changed, readFile = TREE) =>
  runCheck({ title, files: changed, types: TYPES, publishedPaths: PUBLISHED, readFile });

/** Drive `runCli`, capturing both streams. */
function cli(argv) {
  const out = [];
  const errs = [];
  const code = runCli(argv, {
    log: (s) => out.push(String(s)),
    err: (s) => errs.push(String(s)),
  });
  return { code, out: out.join("\n"), err: errs.join("\n") };
}

// ---------------------------------------------------------------------------
// Title parsing
// ---------------------------------------------------------------------------

test("parseTitleType reads the type, tolerating a scope and casing", () => {
  assert.deepEqual(parseTitleType("feat: add a thing"), {
    parsed: true,
    type: "feat",
    breaking: false,
  });
  assert.deepEqual(parseTitleType("fix(scripts): correct the range"), {
    parsed: true,
    type: "fix",
    breaking: false,
  });
  assert.deepEqual(parseTitleType("CI: bump the runner"), {
    parsed: true,
    type: "ci",
    breaking: false,
  });
});

test("parseTitleType flags the `!` breaking marker in both positions", () => {
  assert.equal(parseTitleType("ci!: drop an input").breaking, true);
  assert.equal(parseTitleType("ci(workflows)!: drop an input").breaking, true);
});

test("parseTitleType refuses a subject that is not conventional-commit shaped", () => {
  for (const title of ["", "just some words", "feat add a thing", "feat:", "feat:   "]) {
    assert.equal(parseTitleType(title).parsed, false, `expected unparseable: ${title}`);
  }
});

// ---------------------------------------------------------------------------
// AC-4 — the type set comes from the release configuration
// ---------------------------------------------------------------------------

test("AC-4: the hidden/releasable split is read from the release config", () => {
  const types = loadReleaseTypes(CONFIG);
  assert.deepEqual([...types.releasable].sort(), ["feat", "fix", "refactor"]);
  assert.deepEqual([...types.hidden].sort(), ["chore", "ci", "docs"]);
});

test("AC-4: flipping `hidden` in the config flips the verdict — nothing is duplicated in the check", () => {
  const inverted = JSON.stringify({
    packages: {
      ".": {
        "changelog-sections": [
          { type: "feat", section: "Added", hidden: true },
          { type: "ci", section: "CI/CD" },
        ],
      },
    },
  });
  const types = loadReleaseTypes(inverted);
  assert.equal(classifyTitle("feat: a thing", types).releasable, false);
  assert.equal(classifyTitle("ci: a thing", types).releasable, true);
});

test("AC-4: this repo's real release config parses, and hides `ci` while releasing `feat`", () => {
  const types = loadReleaseTypes(read("release-please-config.json"));
  assert.notEqual(types, null);
  assert.equal(types.hidden.has("ci"), true);
  assert.equal(types.releasable.has("feat"), true);
  assert.equal(types.releasable.has("fix"), true);
});

test("loadReleaseTypes returns null when the config declares no sections", () => {
  assert.equal(loadReleaseTypes("{}"), null);
  assert.equal(loadReleaseTypes("not json"), null);
});

test("a type visible in any package is releasable, and never also reported hidden", () => {
  const multi = JSON.stringify({
    packages: {
      a: { "changelog-sections": [{ type: "perf", section: "Perf", hidden: true }] },
      b: { "changelog-sections": [{ type: "perf", section: "Perf" }] },
    },
  });
  const types = loadReleaseTypes(multi);
  assert.equal(types.releasable.has("perf"), true);
  assert.equal(types.hidden.has("perf"), false);
});

test("classifyTitle: a breaking marker releases even on a hidden type", () => {
  const verdict = classifyTitle("ci!: drop a workflow input", TYPES);
  assert.equal(verdict.releasable, true);
  assert.equal(verdict.titleClass, "breaking");
});

test("classifyTitle: a type with no configured section cannot release", () => {
  const verdict = classifyTitle("wip: half a thing", TYPES);
  assert.equal(verdict.releasable, false);
  assert.equal(verdict.titleClass, "unknown-type");
});

// ---------------------------------------------------------------------------
// Surface classification
// ---------------------------------------------------------------------------

test("a workflow declaring workflow_call is consumer-facing; a standing check is not", () => {
  assert.deepEqual(
    classifyFile(".github/workflows/pr-quality.yml", { publishedPaths: PUBLISHED, readFile: TREE }),
    { consumerFacing: true, surface: "reusable workflow" }
  );
  assert.deepEqual(
    classifyFile(".github/workflows/ci.yml", { publishedPaths: PUBLISHED, readFile: TREE }),
    { consumerFacing: false, surface: null }
  );
});

test("a workflow that cannot be read is treated as consumer-facing (the deleted case)", () => {
  const c = classifyFile(".github/workflows/gone.yml", {
    publishedPaths: PUBLISHED,
    readFile: TREE,
  });
  assert.equal(c.consumerFacing, true);
  assert.match(c.surface, /deleted or unreadable/);
});

test("composite actions and published package files are consumer-facing", () => {
  for (const [path, surface] of [
    [".github/actions/setup-toolchain/action.yml", "composite action"],
    ["config/biome.base.json", "published package file"],
    ["config/edge-security/rate-limit.mjs", "published package file"],
    ["default.json", "published package file"],
    ["scripts/check-action-pins.mjs", "published package file"],
    ["templates/runbooks/deploy-promotion.md", "published package file"],
  ]) {
    const c = classifyFile(path, { publishedPaths: PUBLISHED, readFile: TREE });
    assert.equal(c.consumerFacing, true, `expected consumer-facing: ${path}`);
    assert.equal(c.surface, surface);
  }
});

test("internal tooling, tests, docs and package.json are not consumer-facing", () => {
  for (const path of [
    "docs/architecture.md",
    "docs/runbooks/main-protection.json",
    "README.md",
    "CHANGELOG.md",
    "package.json",
    "package-lock.json",
    ".agents/instructions.md",
    ".github/ISSUE_TEMPLATE/story.yml",
    "scripts/check-action-pins.test.mjs",
    "config/edge-security/rate-limit.test.mjs",
  ]) {
    assert.deepEqual(
      classifyFile(path, { publishedPaths: PUBLISHED, readFile: TREE }),
      { consumerFacing: false, surface: null },
      `expected internal: ${path}`
    );
  }
});

test("loadPublishedPaths normalises the npm files allowlist and drops glob entries", () => {
  assert.deepEqual(
    loadPublishedPaths(JSON.stringify({ files: ["config/", "./default.json", "dist/**", ""] })),
    ["config", "default.json"]
  );
  assert.deepEqual(loadPublishedPaths("{}"), []);
  assert.deepEqual(loadPublishedPaths("nonsense"), []);
});

test("this repo's real package.json publishes config/, default.json, scripts/ and templates/", () => {
  assert.deepEqual(loadPublishedPaths(read("package.json")).sort(), [
    "config",
    "default.json",
    "scripts",
    "templates",
  ]);
});

// ---------------------------------------------------------------------------
// AC-1 / AC-2 / AC-3 — the pair, and only the pair
// ---------------------------------------------------------------------------

test("AC-1: a consumer-facing change under a hidden type is reported with type and surface", () => {
  const result = check("ci: add a workflow input", [
    ".github/workflows/pr-quality.yml",
    "docs/architecture.md",
  ]);
  assert.equal(result.status, "mismatch");
  assert.equal(result.type, "ci");
  assert.equal(result.titleClass, "hidden");
  assert.deepEqual(result.surfaces, [
    { file: ".github/workflows/pr-quality.yml", surface: "reusable workflow" },
  ]);
  // The internal file rode along but is not part of the finding.
  assert.equal(result.surfaces.some((s) => s.file === "docs/architecture.md"), false);
});

test("AC-1: an unparseable title over a consumer-facing change is reported too", () => {
  const result = check("bump the pins", ["config/renovate.json"]);
  assert.equal(result.status, "mismatch");
  assert.equal(result.type, null);
  assert.equal(result.titleClass, "unparseable");
});

test("AC-1: the report names both the title type and the surface it touched", () => {
  const result = check("ci: add a workflow input", [
    ".github/workflows/pr-quality.yml",
    "config/biome.base.json",
  ]);
  const { lines, annotation, summary } = renderReport(result);
  const text = lines.join("\n");

  // The title type, by name.
  assert.match(text, /`ci`/);
  assert.match(text, /hidden: true/);
  // Each surface, by path AND by what kind of surface it is.
  assert.match(text, /\.github\/workflows\/pr-quality\.yml \[reusable workflow\]/);
  assert.match(text, /config\/biome\.base\.json \[published package file\]/);

  // The annotation is one line — GitHub truncates a workflow command at the
  // first real newline, which would silently drop every path but the first.
  assert.equal(annotation.includes("\n"), false);
  assert.match(annotation, /^::warning title=/);
  assert.match(annotation, /pr-quality\.yml/);
  assert.match(annotation, /biome\.base\.json/);

  assert.match(summary, /pr-quality\.yml/);
  assert.match(summary, /never fails the pull request/);
});

test("AC-2: the same change under a releasing title passes silently", () => {
  for (const title of ["feat: add a workflow input", "fix: correct a workflow input"]) {
    const result = check(title, [".github/workflows/pr-quality.yml", "config/biome.base.json"]);
    assert.equal(result.status, "ok", title);
  }
});

test("AC-3: a change confined to internal tooling, tests or docs stays quiet under a hidden type", () => {
  const result = check("ci: retune the aggregator", [
    ".github/workflows/ci.yml",
    "scripts/check-action-pins.test.mjs",
    "docs/architecture.md",
    "README.md",
    "package.json",
  ]);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.surfaces, []);
});

test("AC-3: release-please's own release pull request does not trip the check", () => {
  const result = check("chore(main): release mandrel-platform 1.2.0", [
    "package.json",
    "CHANGELOG.md",
    ".release-please-manifest.json",
  ]);
  assert.equal(result.status, "ok");
});

test("a missing title, an unanswerable config, or an unresolvable diff all skip", () => {
  assert.equal(check("", [".github/workflows/pr-quality.yml"]).status, "skipped");
  assert.equal(
    runCheck({ title: "ci: x", files: ["config/a.json"], types: null }).status,
    "skipped"
  );
  assert.equal(
    runCheck({ title: "ci: x", files: null, types: TYPES }).status,
    "skipped"
  );
});

test("changedFiles answers null rather than throwing on an unresolvable range", () => {
  assert.equal(changedFiles(REPO_ROOT, "", ""), null);
  assert.equal(changedFiles(REPO_ROOT, "definitely-not-a-ref", "HEAD"), null);
});

// ---------------------------------------------------------------------------
// AC-6 — reports, never blocks
// ---------------------------------------------------------------------------

/**
 * Build a throwaway repository whose HEAD commit edits `changed`, so the CLI
 * can be driven over a REAL diff range — the only way to cover the
 * argv → git → classify → render path end to end.
 */
function fixtureRepo(changed) {
  const root = mkdtempSync(join(tmpdir(), "release-type-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const put = (rel, body) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body, "utf8");
  };

  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");

  put("release-please-config.json", CONFIG);
  put("package.json", JSON.stringify({ files: ["config/", "scripts/"] }));
  put(".github/workflows/pr-quality.yml", REUSABLE_WORKFLOW);
  put(".github/workflows/ci.yml", INTERNAL_WORKFLOW);
  put("docs/architecture.md", "# base\n");
  put("config/biome.base.json", "{}\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();

  for (const [rel, body] of Object.entries(changed)) put(rel, body);
  git("add", "-A");
  git("commit", "-qm", "change");
  const head = git("rev-parse", "HEAD").trim();

  return { root, base, head, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("AC-6: end to end, a real mismatch exits 0 and reports rather than failing", () => {
  const repo = fixtureRepo({
    ".github/workflows/pr-quality.yml": `${REUSABLE_WORKFLOW}\n# edited\n`,
    "docs/architecture.md": "# edited\n",
  });
  try {
    const { code, out, err } = cli([
      "--cwd",
      repo.root,
      "--base",
      repo.base,
      "--head",
      repo.head,
      "--title",
      "ci: add a workflow input",
    ]);
    assert.equal(code, EXIT.mismatch, "a finding is reported as its own exit code");
    assert.match(err, /⚠️/);
    assert.match(err, /`ci`/);
    assert.match(err, /pr-quality\.yml \[reusable workflow\]/);
    assert.match(out, /^::warning title=/m);
    // The internal file in the same diff is not part of the finding.
    assert.equal(/architecture\.md/.test(err), false);
    assert.equal(/❌/.test(out) || /❌/.test(err), false);
  } finally {
    repo.cleanup();
  }
});

test("AC-2: end to end, the same diff under `feat:` reports nothing", () => {
  const repo = fixtureRepo({
    ".github/workflows/pr-quality.yml": `${REUSABLE_WORKFLOW}\n# edited\n`,
  });
  try {
    const { code, out, err } = cli([
      "--cwd",
      repo.root,
      "--base",
      repo.base,
      "--head",
      repo.head,
      "--title",
      "feat: add a workflow input",
    ]);
    assert.equal(code, 0);
    assert.equal(err, "");
    assert.equal(out.includes("::warning"), false);
    assert.equal(out.includes("⚠️"), false);
  } finally {
    repo.cleanup();
  }
});

test("AC-3: end to end, an internal-only diff under `ci:` reports nothing", () => {
  const repo = fixtureRepo({
    ".github/workflows/ci.yml": `${INTERNAL_WORKFLOW}\n# edited\n`,
    "docs/architecture.md": "# edited\n",
  });
  try {
    const { code, out, err } = cli([
      "--cwd",
      repo.root,
      "--base",
      repo.base,
      "--head",
      repo.head,
      "--title",
      "ci: retune the aggregator",
    ]);
    assert.equal(code, 0);
    assert.equal(err, "");
    assert.equal(out.includes("::warning"), false);
  } finally {
    repo.cleanup();
  }
});

test("AC-6: a push run with no pull-request title skips instead of guessing", () => {
  assert.equal(cli(["--title", ""]).code, EXIT.skipped);
  assert.match(cli(["--title", ""]).out, /skipped/);
});

test("an unknown flag is the usage error that means the check did not run", () => {
  assert.equal(cli(["--nope"]).code, EXIT.usage);
  assert.equal(parseArgs(["--title", "feat: x"]).title, "feat: x");
});

// ---------------------------------------------------------------------------
// AC-5 (Story #377) — three outcomes, three exit codes, still not blocking
// ---------------------------------------------------------------------------

test("AC-5: ok, mismatch and skipped are three distinguishable exit codes", () => {
  // The whole point: a caller can tell the three apart without parsing log
  // text. Exiting 0 uniformly let this capability go permanently inert — a
  // check that skips forever looked exactly like one that kept finding
  // nothing.
  assert.deepEqual(
    [EXIT.ok, EXIT.usage, EXIT.mismatch, EXIT.skipped],
    [0, 1, 2, 3],
    "the exit codes are a published contract; changing one is a breaking change"
  );
  assert.equal(new Set(Object.values(EXIT)).size, 4, "no two outcomes share a code");
});

test("AC-5: each outcome returns its own code end to end", () => {
  const mismatch = fixtureRepo({
    ".github/workflows/pr-quality.yml": `${REUSABLE_WORKFLOW}\n# edited\n`,
  });
  try {
    const range = ["--cwd", mismatch.root, "--base", mismatch.base, "--head", mismatch.head];

    assert.equal(cli([...range, "--title", "ci: add a workflow input"]).code, EXIT.mismatch);
    assert.equal(cli([...range, "--title", "feat: add a workflow input"]).code, EXIT.ok);
    // An unresolvable range is the shallow-clone degradation: a skip, and now
    // a skip that says so.
    assert.equal(
      cli(["--cwd", mismatch.root, "--title", "ci: add a workflow input"]).code,
      EXIT.skipped
    );
  } finally {
    mismatch.cleanup();
  }
});

/**
 * Execute the ci.yml step's real `run:` body against a stub `node` that exits
 * `stubCode`, and return what the STEP exited with.
 *
 * Asserting the tolerance by regex would prove only that some text is present.
 * The claim under test — "a mismatch cannot fail the build, a broken check
 * still can" — is a property of the shell branch, so the shell branch is what
 * runs here. `bash -eo pipefail` mirrors GitHub's default `run:` shell, which
 * is the part most likely to break a naive `|| code=$?`.
 */
function runCiStep(stubCode) {
  const step = stepByName(read(".github/workflows/ci.yml"), "non-releasing title");
  const body = runScript(step);

  const dir = mkdtempSync(join(tmpdir(), "release-type-step-"));
  try {
    const stub = join(dir, "node");
    writeFileSync(stub, `#!/bin/sh\nexit ${stubCode}\n`);
    chmodSync(stub, 0o755);
    const script = join(dir, "step.sh");
    writeFileSync(script, body);

    const opts = {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${dir}${delimiter}${process.env.PATH}` },
    };
    try {
      return { code: 0, output: execFileSync("bash", ["-eo", "pipefail", script], opts) };
    } catch (e) {
      return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("AC-5: the ci.yml step tolerates every advisory outcome and names which one it got", () => {
  for (const [stubCode, label] of [
    [EXIT.ok, /outcome: ok/],
    [EXIT.mismatch, /outcome: mismatch/],
    [EXIT.skipped, /outcome: skipped/],
  ]) {
    const { code, output } = runCiStep(stubCode);
    assert.equal(code, 0, `exit ${stubCode} must not fail the step or the required aggregator`);
    assert.match(output, label);
  }
});

test("AC-5: a check that could not run still fails the step", () => {
  // The other half, and the reason the tolerance is a `case` rather than a
  // `|| true`: a usage error means the check never ran, which must not read as
  // a check that ran and found nothing.
  const { code, output } = runCiStep(EXIT.usage);
  assert.equal(code, EXIT.usage);
  assert.match(output, /the check itself failed/);
});

// ---------------------------------------------------------------------------
// AC-5 — wired as a step in the existing job, adding no status context
// ---------------------------------------------------------------------------

/** Top-level job ids declared under `jobs:` in a workflow body. */
function jobIds(body) {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.notEqual(start, -1, "ci.yml declares a jobs: block");
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** The body of one top-level job, as text. */
function jobBlock(body, jobId) {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`  ${jobId}:`));
  assert.notEqual(start, -1, `ci.yml declares the ${jobId} job`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

test("AC-5: the check runs as a step in the existing node-scripts job", () => {
  const ci = read(".github/workflows/ci.yml");
  const block = jobBlock(ci, "node-scripts");
  assert.match(runScript(stepByName(block, "non-releasing title")), /node scripts\/check-release-type\.mjs/);
});

test("AC-4 (#377): the node-scripts job checks out full history", () => {
  // `changedFiles` resolves the diff with `git diff base...head`, which needs
  // the merge base in the local object store. A shallow clone makes that range
  // unresolvable, the check degrades to `skipped`, and it stays green forever
  // while classifying nothing — so the depth this check depends on is pinned
  // here rather than left to a comment. The pin-lag guard in
  // check-workflow-portability.mjs depends on the same full history.
  const checkout = stepByName(jobBlock(read(".github/workflows/ci.yml"), "node-scripts"), "Checkout");

  assert.match(
    checkout,
    /^\s+fetch-depth: 0\s*$/m,
    "the node-scripts checkout must fetch full history"
  );
});

test("AC-5: the step is given the pull-request title and diff range it needs", () => {
  const block = jobBlock(read(".github/workflows/ci.yml"), "node-scripts");
  assert.match(block, /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(block, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(block, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
});

test("AC-5: no new job — and therefore no new status context — is introduced", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.deepEqual(jobIds(ci).sort(), [
    "actionlint",
    "ci-required",
    "code-scanning",
    "node-scripts",
    "runner-kit-bash32",
    "security",
  ]);

  // The branch-protection contract still names exactly one required context.
  const protection = JSON.parse(read("docs/runbooks/main-protection.json"));
  assert.deepEqual(protection.requiredStatusChecks, ["ci-required"]);
});
