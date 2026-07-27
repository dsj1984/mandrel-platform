#!/usr/bin/env node
/**
 * check-action-pins.mjs
 *
 * Action-pin ratchet (Story #112) + intra-repo single-pin invariant (#203).
 *
 * Third-party GitHub Actions referenced by `uses:` in this repo's workflows
 * and composite actions are SHA-pinned by convention — but until now NOTHING
 * ENFORCED it. A single `uses: owner/repo@v4` that slipped past review would
 * silently re-introduce mutable-tag risk: the tag can be force-moved to a
 * malicious commit after review, and because the shared `pr-quality.yml` is
 * inherited by every consumer, a tag-pinned regression has 3× blast radius
 * across all three consumer repos (the threat this Story closes alongside the
 * harden-runner egress baseline).
 *
 * This lint is the ratchet: it walks every workflow file under
 * `.github/workflows/` and every composite `action.yml` under
 * `.github/actions/`, extracts each `uses:` reference, and FAILS if any
 * THIRD-PARTY action is pinned to anything other than a full 40-character
 * commit SHA. It runs in mandrel-platform's own `ci-required` (ci.yml), so a
 * non-SHA third-party pin can never reach `main`.
 *
 * Classification — what MUST be a 40-hex SHA, and what is exempt:
 *
 *   • THIRD-PARTY `owner/repo[/subpath]@ref` → MUST be a 40-char hex SHA.
 *     (e.g. `actions/checkout`, `step-security/harden-runner`,
 *     `pnpm/action-setup`.) A non-SHA ref (a tag like `v4`, a branch, a short
 *     SHA) FAILS the lint.
 *
 *   • FIRST-PARTY self-references — `dsj1984/mandrel-platform/...@<ref>` — MUST
 *     ALSO be a 40-char hex SHA, and are reported as their own violation class.
 *     They were exempt until Story #354's audit: the exemption's stated
 *     justification was that `check-workflow-portability.mjs` Rule 3 governs
 *     them, but Rule 3's `collectInternalPins` skips any ref that is not
 *     already a 40-hex SHA (`if (!isSha40(cls.ref)) return`), so a
 *     branch-pinned self-reference was validated by NOTHING. The two other
 *     first-party guards had the same hole — the single-pin invariant below
 *     compares whatever refs it finds without requiring a SHA, and
 *     `check-first-party-pin-freshness.mjs` files a non-SHA ref under an
 *     informational `unpinnedRefs` note that never fails. So
 *     `…/gitleaks-scan@main` was green on all three.
 *
 *     A moving self-ref is the same supply-chain risk the third-party ratchet
 *     exists to close, with a wider blast radius: `pr-quality.yml` is inherited
 *     by every consumer. It is also invisible to `platform-sync.mjs`, whose
 *     rewrite regex matches `@[0-9a-fA-F]{40}` only — a branch-pinned consumer
 *     workflow is silently skipped on every platform bump.
 *
 *     The land-then-bump flow is unaffected: it always pins full SHAs (see
 *     docs/reusable-workflows.md § First-party self-pin freshness). The
 *     first-party owner is overridable via `--first-party-owner` for a fork,
 *     and first-party refs remain subject to the single-pin invariant below.
 *
 *   • LOCAL `./path` references and `docker://image` references are EXEMPT —
 *     a local path has no upstream tag to move, and a docker ref is pinned by
 *     its own digest convention, out of scope for this action-tag ratchet.
 *
 * Single-pin invariant (Story #203): across `.github/workflows/`, two
 * first-party `uses:` refs to the SAME subpath MUST carry the SAME SHA. Two
 * workflows pinning `owner/repo/.github/actions/foo` at different commits is a
 * silent split-brain — one workflow runs the fixed action, the other the
 * stale one. This lint fails when that drift is present. Disable with
 * `--no-single-pin` (e.g. mid-migration).
 *
 * The reference is read from the `uses:` value with any trailing `# comment`
 * (the conventional `# v4.2.2` tag annotation) stripped first, so the human
 * tag note alongside the SHA never confuses the parse.
 *
 * Usage:
 *   node scripts/check-action-pins.mjs
 *   node scripts/check-action-pins.mjs --workflows-dir .github/workflows
 *   node scripts/check-action-pins.mjs --actions-dir .github/actions
 *   node scripts/check-action-pins.mjs --first-party-owner my-org/my-repo
 *   node scripts/check-action-pins.mjs --no-single-pin
 *
 * Exit codes:
 *   0 — every third-party `uses:` is SHA-pinned and the single-pin invariant holds.
 *   1 — one or more third-party actions are not SHA-pinned, or a first-party
 *       subpath is pinned to two different SHAs (each named in stderr with
 *       file:line).
 *
 * Consumer adoption:
 *   Copy this script into your project's `scripts/` directory and wire it into
 *   your CI alongside check-required-contexts.mjs / check-workflow-portability.mjs:
 *
 *     - name: Lint third-party action pins
 *       run: node scripts/check-action-pins.mjs --first-party-owner <owner/repo>
 *
 *   It depends only on the sibling `scripts/lib/` helpers (no YAML parser), so
 *   copy `scripts/lib/{args,uses-pins,walk}.mjs` alongside it.
 */

import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

import { parseFlags } from "./lib/args.mjs";
import {
  DEFAULT_FIRST_PARTY_OWNER,
  stripUsesValue,
  parseUsesLine,
  classifyUses,
  isSha40,
  findSinglePinViolations,
} from "./lib/uses-pins.mjs";
import { listWorkflowFiles, listActionFiles } from "./lib/walk.mjs";

// Re-export the shared primitives so the sibling test suite (and any external
// consumer that imports from this script) keeps its existing import surface.
export {
  stripUsesValue,
  classifyUses,
  isSha40,
  listWorkflowFiles,
  listActionFiles,
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Parse the CLI argv (array AFTER `node script.mjs`) into an options object.
 * Throws on an unknown flag or a flag missing its value so the lint fails
 * loudly rather than silently mis-reading its own configuration.
 */
export function parseArgs(argv) {
  return parseFlags(argv, {
    flags: {
      "--workflows-dir": { type: "string", dest: "workflowsDir", default: ".github/workflows" },
      "--actions-dir": { type: "string", dest: "actionsDir", default: ".github/actions" },
      "--first-party-owner": { type: "string", dest: "firstPartyOwner", default: DEFAULT_FIRST_PARTY_OWNER },
      "--cwd": { type: "string", dest: "cwd", default: process.cwd() },
      "--no-single-pin": { type: "boolean", dest: "singlePin", value: false, default: true },
    },
    onUnknown: "throw",
  });
}

// ---------------------------------------------------------------------------
// Content scan
// ---------------------------------------------------------------------------

/**
 * Scan a single file's TEXT for `uses:` step keys and evaluate every REMOTE
 * reference against the 40-hex SHA ratchet. Returns
 * `{ violations, scanned, firstPartyViolations, firstPartyScanned }` — the two
 * owner classes are counted and reported separately because their remediation
 * differs (bump a vendored third-party pin vs. re-pin one of this repo's own
 * call sites, which must move at every call site together to keep the
 * single-pin invariant). A violation is `{ file, line, ref, owner, reason }`;
 * `file` is left as passed-in (the caller supplies a display path).
 *
 * LOCAL (`./path`) and `docker://` references stay exempt: a local path has no
 * upstream ref that can move, and a docker ref carries its own digest
 * convention.
 *
 * Only lines whose first non-space token is `uses:` (a YAML mapping key) are
 * inspected — `uses:` appearing inside a comment or a `run:` heredoc never
 * starts a YAML key at column-leading position, so this avoids false hits on
 * documentation examples embedded in `#` comments (those are indented past a
 * leading `#`).
 */
export function scanContent(content, displayFile, firstPartyOwner = DEFAULT_FIRST_PARTY_OWNER) {
  const violations = [];
  const firstPartyViolations = [];
  let scanned = 0;
  let firstPartyScanned = 0;
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const bareRef = parseUsesLine(lines[i]);
    if (bareRef === null) continue;
    const cls = classifyUses(bareRef, firstPartyOwner);

    // First-party self-references (Story #354 audit). A bare `owner/repo@ref`
    // carrying no subpath is ratcheted too: the hazard is the MOVING REF, and
    // it moves whether or not the reference names a subpath.
    if (cls.kind === "first-party") {
      firstPartyScanned++;
      if (!isSha40(cls.ref)) {
        firstPartyViolations.push({
          file: displayFile,
          line: i + 1,
          ref: bareRef,
          owner: cls.owner,
          reason: `first-party self-reference "${cls.owner}" is pinned to "${cls.ref}", not a full 40-char commit SHA`,
        });
      }
      continue;
    }

    if (cls.kind !== "third-party") continue; // local/docker/unparseable → exempt
    scanned++;
    if (!isSha40(cls.ref)) {
      violations.push({
        file: displayFile,
        line: i + 1,
        ref: bareRef,
        owner: cls.owner,
        reason: `third-party action "${cls.owner}" is pinned to "${cls.ref}", not a full 40-char commit SHA`,
      });
    }
  }
  return { violations, scanned, firstPartyViolations, firstPartyScanned };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full lint against the resolved option set. Returns
 * `{ ok, violations, scanned, files, singlePinViolations }`. Pure with respect
 * to stdout — the CLI wrapper formats and prints. `singlePinViolations` is
 * populated only when `opts.singlePin` is not `false`, and reflects the
 * intra-repo single-pin invariant across the workflow files only.
 */
export function runLint(opts) {
  const cwd = opts.cwd || process.cwd();
  const wfDir = resolve(cwd, opts.workflowsDir);
  const acDir = resolve(cwd, opts.actionsDir);
  const workflowFiles = listWorkflowFiles(wfDir);
  const files = [...workflowFiles, ...listActionFiles(acDir)];

  const violations = [];
  const firstPartyViolations = [];
  let scanned = 0;
  let firstPartyScanned = 0;
  // Keep the raw workflow-file contents for the single-pin pass so we read
  // each file from disk once.
  const workflowRecords = [];
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const display = relative(cwd, file) || file;
    const res = scanContent(content, display, opts.firstPartyOwner);
    violations.push(...res.violations);
    firstPartyViolations.push(...res.firstPartyViolations);
    scanned += res.scanned;
    firstPartyScanned += res.firstPartyScanned;
    if (workflowFiles.includes(file)) {
      workflowRecords.push({ file: display, content });
    }
  }

  const singlePin = opts.singlePin !== false;
  const singlePinViolations = singlePin
    ? findSinglePinViolations(workflowRecords, opts.firstPartyOwner)
    : [];

  return {
    ok:
      violations.length === 0 &&
      firstPartyViolations.length === 0 &&
      singlePinViolations.length === 0,
    violations,
    firstPartyViolations,
    scanned,
    firstPartyScanned,
    files,
    singlePinViolations,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (skipped under `node --test` import)
// ---------------------------------------------------------------------------

export function runCli(argv, { log = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`[action-pins] ❌ ${e.message}`);
    return 1;
  }

  const result = runLint(opts);

  let failed = false;

  if (result.violations.length > 0) {
    failed = true;
    err(`[action-pins] ❌ ${result.violations.length} unpinned third-party action(s):`);
    for (const v of result.violations) {
      err(`  • ${v.file}:${v.line} — ${v.reason}`);
    }
    err(
      "[action-pins] Pin every third-party action to a full 40-char commit SHA " +
        "(keep the `# vX.Y.Z` tag note as a comment). A mutable tag can be " +
        "force-moved to a malicious commit after review."
    );
  }

  if (result.firstPartyViolations.length > 0) {
    failed = true;
    err(
      `[action-pins] ❌ ${result.firstPartyViolations.length} first-party self-reference(s) pinned to a moving ref:`
    );
    for (const v of result.firstPartyViolations) {
      err(`  • ${v.file}:${v.line} — ${v.reason}`);
    }
    err(
      "[action-pins] Pin every first-party `uses:` to a full 40-char commit SHA " +
        "too (keep the `# vX.Y.Z` tag note as a comment). A branch or tag ref " +
        "means the revision that runs can change with no diff here — and " +
        "`pr-quality.yml` is inherited by every consumer. It is also invisible " +
        "to platform-sync.mjs, whose rewrite matches 40-hex SHAs only, so it " +
        "would be skipped on every platform bump."
    );
  }

  if (result.singlePinViolations.length > 0) {
    failed = true;
    err(
      `[action-pins] ❌ ${result.singlePinViolations.length} first-party subpath(s) pinned to different SHAs (single-pin invariant):`
    );
    for (const v of result.singlePinViolations) {
      err(`  • ${v.target} is pinned to ${v.shas.length} distinct refs:`);
      for (const occ of v.occurrences) {
        err(`      ${occ.file}:${occ.line} — @${occ.ref}`);
      }
    }
    err(
      "[action-pins] Every first-party `uses:` to the same subpath across " +
        ".github/workflows/ must carry the SAME SHA — otherwise one workflow " +
        "runs the fixed action and another the stale one."
    );
  }

  if (failed) return 1;

  log(
    `[action-pins] ✅ all ${result.scanned} third-party and ${result.firstPartyScanned} ` +
      `first-party action reference(s) are SHA-pinned ` +
      `(${result.files.length} file(s) scanned); first-party single-pin invariant holds.`
  );
  return 0;
}

// Only run when executed directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("check-action-pins.mjs");
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
