#!/usr/bin/env node
/**
 * check-release-type.mjs
 *
 * Release-type advisory for consumer-facing changes (Story #368).
 *
 * ## The defect
 *
 * This repository merges by SQUASH, so the pull-request title becomes the
 * single commit subject on `main` — and release-please derives the release
 * from that subject. Several conventional-commit types are configured
 * `hidden: true` in release-please-config.json (`ci`, `chore`, `docs`,
 * `test`, `build`, `style`): a change landed under one of them cuts no
 * release and never reaches the CHANGELOG.
 *
 * For an internal edit that is exactly right. For a change to the surface
 * this repository PUBLISHES — the reusable workflows, the composite actions,
 * and the files in the npm `files` allowlist — it means the change exists on
 * `main` and nowhere a consumer can reach it. That already happened: a
 * consumer-facing reusable-workflow input landed under a `ci:` title, shipped
 * to nobody, and had to be re-released later under a corrected title. Nothing
 * signalled it at the time, because every check was green.
 *
 * ## The signal is the PAIR, not the title
 *
 * A hidden type is only a defect when the diff touches the published surface.
 * This check reports exactly that pair and nothing else:
 *
 *   consumer-facing file(s) touched  AND  a title type that cannot release
 *
 * A diff confined to internal tooling, this repo's own tests, or `docs/`
 * under a hidden type is CORRECT and stays silent. A releasable title passes
 * silently whatever it touches. Silence is the common case by construction —
 * a check reviewers learn to scroll past is worse than no check.
 *
 * ## Advisory, deliberately
 *
 * The classification is a heuristic over a human-written title. Blocking a
 * pull request on it would be worse than the defect it prevents: an
 * unappealable stop on a judgement call teaches people to route around the
 * gate. So a mismatch reports through a `::warning::` annotation and the job
 * summary, and the CI step deliberately TOLERATES the mismatch exit code. It
 * runs as a STEP in the existing `node-scripts` job — no new job, therefore no
 * new status context and no branch-protection change.
 *
 * ## Advisory is not the same as silent (Story #377)
 *
 * Advisory used to mean "exit 0 whatever happened", which collapsed three very
 * different outcomes into one indistinguishable signal. `skipped` in
 * particular is the dangerous one: a shallow clone, a missing pull-request
 * title, or a release config that stops declaring `changelog-sections` all
 * degrade this check to a skip, and a check that skips on every run forever is
 * inert with nothing to notice. The three outcomes now carry three exit codes
 * (see {@link EXIT}) so the caller can tell them apart; keeping the pull
 * request unblocked is the CI step's job, not the exit code's.
 *
 * ## Where the type set comes from
 *
 * Nowhere in this file. The hidden-versus-releasable split is read from
 * release-please-config.json's `changelog-sections` at run time, so changing
 * which types are hidden changes this check with no edit here. A config that
 * declares no sections leaves the question unanswerable, and the check skips
 * rather than guessing at release-please's built-in defaults.
 *
 * A `!` breaking marker (`ci!: …`) always releases — release-please cuts a
 * major for a breaking change regardless of the type's section visibility —
 * so it is treated as releasable.
 *
 * ## Where the published surface comes from
 *
 * Also from configuration:
 *
 *   • reusable workflows — a `.github/workflows/*.yml` that declares
 *     `workflow_call`. That is what makes it callable by a consumer;
 *     `ci.yml` and the other standing checks are not, and are internal.
 *   • composite actions — anything under `.github/actions/`.
 *   • published package files — anything under a `files[]` entry in
 *     package.json (`config/`, `default.json`, `scripts/`, `templates/`),
 *     minus the `*.test.mjs` siblings, which ship but are this repo's own
 *     tests rather than a consumer-facing contract.
 *
 * `package.json` itself is deliberately NOT classified: it is not in its own
 * `files[]`, and release-please's own release pull request edits it under a
 * `chore(main): release …` title on every single release — classifying it
 * would make this check fire on the one pull request that most certainly
 * does cut a release.
 *
 * The `workflow_call` detection reuses `walkYaml` / `isReusableWorkflow` from
 * check-workflow-portability.mjs rather than growing a second YAML walker.
 * This check is an INTERNAL repository lint (see Non-Goals on #368), not part
 * of the published contract, so the sibling import costs no consumer anything.
 *
 * Usage:
 *   node scripts/check-release-type.mjs
 *   node scripts/check-release-type.mjs --title "ci: tweak" --base <sha> --head <sha>
 *
 * Environment (how CI supplies the context):
 *   PR_TITLE   the pull-request title. Absent (a push run) → skip.
 *   BASE_SHA   pull_request.base.sha
 *   HEAD_SHA   pull_request.head.sha
 *
 * Exit codes: see {@link EXIT}. Only a usage error (1) is a fault in the check
 * itself; 2 and 3 are findings, and the CI step tolerates them by name.
 */

import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

import { parseFlags } from "./lib/args.mjs";
import { walkYaml, isReusableWorkflow } from "./check-workflow-portability.mjs";

/**
 * The outcome of a run, as a POSIX exit code.
 *
 * `mismatch` and `skipped` are non-zero so a caller can DISTINGUISH them —
 * from each other and from a clean run — without parsing log text. That does
 * not make either one blocking: the ci.yml step maps 0/2/3 onto a passing step
 * and only propagates anything else, which is asserted directly by
 * check-release-type.test.mjs so the tolerance cannot be dropped by accident.
 *
 * `usage` is the one genuinely broken state — a flag this check does not
 * understand means it did not run, and a check that did not run must not
 * report as one that found nothing.
 */
export const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  mismatch: 2,
  skipped: 3,
});

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Parse the CLI argv slice (everything AFTER `node script.mjs`). Flags win
 * over the environment so a local run can reproduce a CI finding exactly.
 *
 * @param {string[]} argv
 * @returns {{title: string, base: string, head: string, cwd: string, config: string, help: boolean}}
 */
export function parseArgs(argv) {
  return parseFlags(argv, {
    flags: {
      "--title": { type: "string", dest: "title", default: process.env.PR_TITLE || "" },
      "--base": { type: "string", dest: "base", default: process.env.BASE_SHA || "" },
      "--head": { type: "string", dest: "head", default: process.env.HEAD_SHA || "" },
      "--cwd": { type: "string", dest: "cwd", default: process.cwd() },
      "--config": {
        type: "string",
        dest: "config",
        default: "release-please-config.json",
      },
      "--help": { type: "boolean", dest: "help", value: true, default: false },
    },
    aliases: { "-h": "--help" },
    onUnknown: "throw",
  });
}

// ---------------------------------------------------------------------------
// Title → release type
// ---------------------------------------------------------------------------

// Conventional-commit subject: `type(optional-scope)!: description`.
const SUBJECT = /^(?<type>[A-Za-z][A-Za-z0-9]*)(?:\(([^)]*)\))?(?<bang>!)?:\s+\S/;

/**
 * Parse a pull-request title into its conventional-commit type.
 *
 * @param {string} title
 * @returns {{parsed: boolean, type: string|null, breaking: boolean}}
 */
export function parseTitleType(title) {
  const m = SUBJECT.exec(String(title || "").trim());
  if (m === null) return { parsed: false, type: null, breaking: false };
  return {
    parsed: true,
    type: m.groups.type.toLowerCase(),
    breaking: m.groups.bang === "!",
  };
}

/**
 * Read the hidden-versus-releasable type split out of a release-please config
 * body. A type is releasable when its changelog section is not `hidden` — that
 * is the same field release-please itself reads, so the two cannot drift.
 *
 * Every package entry contributes: a multi-package config that hides a type in
 * one package and shows it in another still RELEASES on that type somewhere,
 * so the union is the correct releasable set.
 *
 * Returns null when the config declares no sections at all. The answer is then
 * release-please's built-in default, and hardcoding a copy of that default
 * here is precisely the duplication this check exists without.
 *
 * @param {string} configText
 * @returns {{releasable: Set<string>, hidden: Set<string>} | null}
 */
export function loadReleaseTypes(configText) {
  let cfg;
  try {
    cfg = JSON.parse(configText);
  } catch {
    return null;
  }
  const releasable = new Set();
  const hidden = new Set();

  const sectionSets = [];
  if (Array.isArray(cfg?.["changelog-sections"])) sectionSets.push(cfg["changelog-sections"]);
  for (const pkg of Object.values(cfg?.packages ?? {})) {
    if (Array.isArray(pkg?.["changelog-sections"])) sectionSets.push(pkg["changelog-sections"]);
  }

  for (const sections of sectionSets) {
    for (const section of sections) {
      const type = String(section?.type || "").toLowerCase();
      if (!type) continue;
      if (section?.hidden === true) hidden.add(type);
      else releasable.add(type);
    }
  }

  // A type visible in ANY package releases; drop it from the hidden set so the
  // two are disjoint and the report cannot claim both.
  for (const type of releasable) hidden.delete(type);

  if (releasable.size === 0 && hidden.size === 0) return null;
  return { releasable, hidden };
}

/**
 * Decide whether a title can produce a release.
 *
 * @param {string} title
 * @param {{releasable: Set<string>, hidden: Set<string>}} types
 * @returns {{releasable: boolean, type: string|null, titleClass: "releasable"|"breaking"|"hidden"|"unknown-type"|"unparseable", detail: string}}
 */
export function classifyTitle(title, types) {
  const { parsed, type, breaking } = parseTitleType(title);
  if (!parsed) {
    return {
      releasable: false,
      type: null,
      titleClass: "unparseable",
      detail:
        "the title is not a conventional-commit subject (`type(scope): description`), " +
        "so release-please derives no release from it",
    };
  }
  // A breaking change cuts a major whatever its section visibility.
  if (breaking) {
    return {
      releasable: true,
      type,
      titleClass: "breaking",
      detail: `\`${type}!\` is a breaking change — release-please cuts a major release`,
    };
  }
  if (types.releasable.has(type)) {
    return {
      releasable: true,
      type,
      titleClass: "releasable",
      detail: `\`${type}\` has a visible changelog section`,
    };
  }
  if (types.hidden.has(type)) {
    return {
      releasable: false,
      type,
      titleClass: "hidden",
      detail: `\`${type}\` is configured \`hidden: true\`, so it cuts no release and never reaches the CHANGELOG`,
    };
  }
  return {
    releasable: false,
    type,
    titleClass: "unknown-type",
    detail: `\`${type}\` has no changelog section configured, so release-please derives no release from it`,
  };
}

// ---------------------------------------------------------------------------
// Diff → consumer-facing surface
// ---------------------------------------------------------------------------

/**
 * Normalise the npm `files` allowlist into path prefixes. Entries are compared
 * as literal path prefixes — this repo's allowlist is four plain directory /
 * file entries, and a glob entry would simply match nothing rather than
 * mis-classify anything.
 *
 * @param {string} pkgText
 * @returns {string[]}
 */
export function loadPublishedPaths(pkgText) {
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return [];
  }
  if (!Array.isArray(pkg?.files)) return [];
  return pkg.files
    .map((f) => String(f).replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((f) => f.length > 0 && !/[*?[\]]/.test(f));
}

/**
 * Classify one changed path as consumer-facing or internal.
 *
 * `readFile` is injectable so the classification of a reusable workflow can be
 * exercised without a filesystem. A workflow file that cannot be read is
 * treated as consumer-facing: `.github/workflows/` is where the product lives,
 * and the unreadable case is a DELETED workflow — the most consumer-breaking
 * edit there is.
 *
 * @param {string} path Repo-relative POSIX path.
 * @param {{publishedPaths: string[], readFile: (p: string) => string|null}} ctx
 * @returns {{consumerFacing: boolean, surface: string|null}}
 */
export function classifyFile(path, { publishedPaths = [], readFile = () => null } = {}) {
  const internal = { consumerFacing: false, surface: null };

  // This repo's own tests ship inside `scripts/`, but they are not a contract
  // any consumer depends on.
  if (/\.test\.mjs$/.test(path)) return internal;

  if (/^\.github\/actions\//.test(path)) {
    return { consumerFacing: true, surface: "composite action" };
  }

  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) {
    const body = readFile(path);
    if (body === null) {
      return { consumerFacing: true, surface: "reusable workflow (deleted or unreadable)" };
    }
    if (isReusableWorkflow(walkYaml(body))) {
      return { consumerFacing: true, surface: "reusable workflow" };
    }
    return internal;
  }

  for (const prefix of publishedPaths) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return { consumerFacing: true, surface: "published package file" };
    }
  }

  return internal;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Score a title against a changed-file list. Pure: every input is passed in,
 * so the suite drives it with no repository and no git.
 *
 * @param {Object} input
 * @param {string} input.title
 * @param {string[]} input.files Repo-relative changed paths.
 * @param {{releasable: Set<string>, hidden: Set<string>}|null} input.types
 * @param {string[]} [input.publishedPaths]
 * @param {(p: string) => string|null} [input.readFile]
 * @returns {{status: "ok"|"mismatch"|"skipped", reason?: string, title: string, type: string|null, titleClass: string, detail: string, surfaces: Array<{file: string, surface: string}>}}
 */
export function runCheck({ title, files, types, publishedPaths = [], readFile = () => null }) {
  const base = { title: String(title || ""), type: null, titleClass: "", detail: "", surfaces: [] };

  if (!base.title.trim()) {
    return { ...base, status: "skipped", reason: "no pull-request title in context" };
  }
  if (types === null || types === undefined) {
    return {
      ...base,
      status: "skipped",
      reason:
        "no changelog-sections in the release configuration — the hidden/releasable " +
        "split is unanswerable and this check will not guess it",
    };
  }
  if (!Array.isArray(files)) {
    return { ...base, status: "skipped", reason: "the changed-file list is unavailable" };
  }

  const verdict = classifyTitle(base.title, types);
  const surfaces = [];
  for (const file of files) {
    const { consumerFacing, surface } = classifyFile(file, { publishedPaths, readFile });
    if (consumerFacing) surfaces.push({ file, surface });
  }

  const result = {
    ...base,
    type: verdict.type,
    titleClass: verdict.titleClass,
    detail: verdict.detail,
    surfaces,
  };

  // The pair — and only the pair — is the finding.
  if (!verdict.releasable && surfaces.length > 0) return { ...result, status: "mismatch" };
  return { ...result, status: "ok" };
}

// ---------------------------------------------------------------------------
// Git seam
// ---------------------------------------------------------------------------

/**
 * List the paths a merge of `head` into `base` would change, or null when the
 * range cannot be resolved (a shallow clone, an unknown sha, no git at all).
 * Null degrades this check to a skip — never to a failure.
 *
 * @param {string} repoRoot
 * @param {string} base
 * @param {string} head
 * @returns {string[] | null}
 */
export function changedFiles(repoRoot, base, head) {
  if (!base || !head) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: node scripts/check-release-type.mjs " +
  "[--title <pr-title>] [--base <sha>] [--head <sha>] [--cwd <dir>] [--config <path>]";

/** Read a file relative to `root`, or null when it cannot be read. */
function reader(root) {
  return (p) => {
    try {
      return readFileSync(join(root, p), "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * Render a `mismatch` result into the three surfaces the finding is reported
 * on. Kept separate from {@link runCli} so the wording — which is the entire
 * product of an advisory check — is asserted directly by the suite instead of
 * through a git range the test would have to stage.
 *
 * @param {ReturnType<typeof runCheck>} result
 * @returns {{lines: string[], annotation: string, summary: string}}
 */
export function renderReport(result) {
  const label = result.type === null ? "an unparseable title" : `title type \`${result.type}\``;

  const lines = [
    `[release-type] ⚠️  ${label} cannot cut a release, but this change touches ` +
      `${result.surfaces.length} consumer-facing path(s):`,
    ...result.surfaces.map((s) => `     • ${s.file} [${s.surface}]`),
    `[release-type] ${result.detail}.`,
    "[release-type] Merges here are squash, so the pull-request title IS the release " +
      "type. Landing this as-is publishes the change to `main` and to no consumer. " +
      "Retitle to a releasing type (e.g. `feat:` / `fix:`) if consumers need it, or " +
      "keep the title and confirm the change is genuinely internal.",
    `[release-type] Advisory — this reports exit ${EXIT.mismatch}, which the CI step ` +
      "tolerates by name. The pull request is never failed.",
  ];

  // GitHub renders `%0A` as a newline inside a single-line workflow command.
  const annotation =
    "::warning title=Consumer-facing change under a non-releasing title::" +
    [
      `${label} cuts no release, but the diff touches the published surface:`,
      ...result.surfaces.map((s) => `• ${s.file} [${s.surface}]`),
      "Retitle to a releasing type if consumers need this change.",
    ].join("%0A");

  const summary = [
    "### ⚠️ Consumer-facing change under a non-releasing title",
    "",
    `**Title:** \`${result.title}\``,
    "",
    `${result.detail.charAt(0).toUpperCase()}${result.detail.slice(1)}.`,
    "",
    "**Consumer-facing paths in this diff:**",
    "",
    ...result.surfaces.map((s) => `- \`${s.file}\` — ${s.surface}`),
    "",
    "Merges here are squash, so the pull-request title is the release type.",
    "Retitle to a releasing type if consumers need this change — or keep the",
    "title and confirm the change is genuinely internal. This check is",
    "advisory and never fails the pull request.",
  ].join("\n");

  return { lines, annotation, summary };
}

/**
 * Append a markdown block to the GitHub job summary when one is configured.
 * Best-effort: a summary that cannot be written must never change the outcome
 * of an advisory check.
 */
function writeSummary(body) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${body}\n`, "utf8");
  } catch {
    /* advisory output only */
  }
}

/**
 * Run the check and return a POSIX exit code from {@link EXIT}. `log` / `err`
 * are injectable so the sibling node:test suite captures output without
 * touching the real streams.
 *
 * @param {string[]} argv
 * @param {{log?: Function, err?: Function}} [io]
 * @returns {number} One of {@link EXIT}.
 */
export function runCli(argv, { log = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`[release-type] ❌ ${e.message}`);
    err(USAGE);
    return EXIT.usage;
  }
  if (opts.help) {
    log(USAGE);
    return EXIT.ok;
  }

  const root = resolve(opts.cwd);
  const readFile = reader(root);
  const types = loadReleaseTypes(readFile(opts.config) ?? "");
  const publishedPaths = loadPublishedPaths(readFile("package.json") ?? "");

  const result = runCheck({
    title: opts.title,
    files: changedFiles(root, opts.base, opts.head),
    types,
    publishedPaths,
    readFile,
  });

  if (result.status === "skipped") {
    log(`[release-type] ⏭️  skipped — ${result.reason}.`);
    return EXIT.skipped;
  }

  if (result.status === "ok") {
    log(
      `[release-type] ✅ title type ${result.type === null ? "(unparseable)" : `\`${result.type}\``} ` +
        `— ${result.detail}; ${result.surfaces.length} consumer-facing path(s) touched.`
    );
    return EXIT.ok;
  }

  const report = renderReport(result);
  for (const line of report.lines) err(line);
  log(report.annotation);
  writeSummary(report.summary);

  return EXIT.mismatch;
}

// Only run when executed directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("check-release-type.mjs");
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
