#!/usr/bin/env node
/**
 * check-action-pins.mjs
 *
 * Action-pin ratchet (Story #112).
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
 *   • FIRST-PARTY self-references — `dsj1984/mandrel-platform/...@<ref>` — are
 *     EXEMPT from this ratchet. They are this repo's OWN reusable workflows /
 *     composite actions, governed by the cross-repo portability lint's pin-lag
 *     guard (`check-workflow-portability.mjs`, Rule 3), and they carry a
 *     release-tag shape at publish time. The first-party owner is overridable
 *     via `--first-party-owner` for a fork.
 *
 *   • LOCAL `./path` references and `docker://image` references are EXEMPT —
 *     a local path has no upstream tag to move, and a docker ref is pinned by
 *     its own digest convention, out of scope for this action-tag ratchet.
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
 *
 * Exit codes:
 *   0 — every third-party `uses:` is pinned to a full 40-char commit SHA.
 *   1 — one or more third-party actions are not SHA-pinned (each named in
 *       stderr with file:line).
 *
 * Consumer adoption:
 *   Copy this script into your project's `scripts/` directory and wire it into
 *   your CI alongside check-required-contexts.mjs / check-workflow-portability.mjs:
 *
 *     - name: Lint third-party action pins
 *       run: node scripts/check-action-pins.mjs --first-party-owner <owner/repo>
 *
 *   It is dependency-free (no YAML parser) so it copies cleanly into any repo.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Pure helpers (exported for the sibling node:test suite)
// ---------------------------------------------------------------------------

const DEFAULT_FIRST_PARTY_OWNER = "dsj1984/mandrel-platform";

/** A full git commit SHA is exactly 40 lowercase/uppercase hex characters. */
const SHA40_RE = /^[0-9a-fA-F]{40}$/;

/**
 * Parse the CLI argv (array AFTER `node script.mjs`) into an options object.
 * Throws on an unknown flag or a flag missing its value so the lint fails
 * loudly rather than silently mis-reading its own configuration.
 */
export function parseArgs(argv) {
  const opts = {
    workflowsDir: ".github/workflows",
    actionsDir: ".github/actions",
    firstPartyOwner: DEFAULT_FIRST_PARTY_OWNER,
    cwd: process.cwd(),
  };
  const takeValue = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`missing value for "${flag}"`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--workflows-dir":
        opts.workflowsDir = takeValue(i, arg);
        i++;
        break;
      case "--actions-dir":
        opts.actionsDir = takeValue(i, arg);
        i++;
        break;
      case "--first-party-owner":
        opts.firstPartyOwner = takeValue(i, arg);
        i++;
        break;
      case "--cwd":
        opts.cwd = takeValue(i, arg);
        i++;
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }
  return opts;
}

/**
 * Strip a trailing `# comment` (the conventional `# v4.2.2` tag note) and
 * surrounding whitespace/quotes from a raw `uses:` value, returning the bare
 * action reference. A `#` inside the ref itself is not valid GitHub syntax,
 * so splitting on the first ` #` is safe.
 */
export function stripUsesValue(raw) {
  let v = String(raw).trim();
  // Drop a trailing comment: the first '#' that is preceded by whitespace (or
  // at the start) begins a comment. GitHub action refs never contain '#'.
  const hashIdx = v.search(/\s#/);
  if (hashIdx !== -1) v = v.slice(0, hashIdx);
  v = v.trim();
  // Unwrap matched surrounding quotes.
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/**
 * Classify a bare `uses:` reference. Returns one of:
 *   { kind: 'local' }            — `./path` or `../path` (exempt)
 *   { kind: 'docker' }           — `docker://image` (exempt)
 *   { kind: 'first-party', owner, ref } — the configured first-party owner (exempt)
 *   { kind: 'third-party', owner, ref } — external action (MUST be SHA-pinned)
 *   { kind: 'unparseable' }      — not a recognizable `uses:` reference
 */
export function classifyUses(bareRef, firstPartyOwner = DEFAULT_FIRST_PARTY_OWNER) {
  const ref = String(bareRef).trim();
  if (ref === "") return { kind: "unparseable" };
  if (ref.startsWith("./") || ref.startsWith("../")) return { kind: "local" };
  if (ref.startsWith("docker://")) return { kind: "docker" };

  // owner/repo[/subpath]@gitref. The git ref is everything after the LAST '@'
  // (an action subpath never contains '@'; the ref does not either).
  const atIdx = ref.lastIndexOf("@");
  if (atIdx === -1) {
    // No `@ref` at all — not a pinnable external reference (e.g. a malformed
    // entry). Treat as unparseable so the caller can flag it explicitly.
    return { kind: "unparseable", ownerRepoPath: ref };
  }
  const ownerRepoPath = ref.slice(0, atIdx);
  const gitRef = ref.slice(atIdx + 1);
  const segments = ownerRepoPath.split("/");
  if (segments.length < 2) return { kind: "unparseable", ownerRepoPath, ref: gitRef };

  const ownerRepo = `${segments[0]}/${segments[1]}`;
  if (ownerRepo.toLowerCase() === String(firstPartyOwner).toLowerCase()) {
    return { kind: "first-party", owner: ownerRepo, ref: gitRef };
  }
  return { kind: "third-party", owner: ownerRepo, ref: gitRef };
}

/** True when a git ref is a full 40-character commit SHA. */
export function isSha40(gitRef) {
  return SHA40_RE.test(String(gitRef).trim());
}

/**
 * Scan a single file's TEXT for `uses:` step keys and evaluate each third-party
 * reference. Returns { violations: [...], scanned: <count> }. A violation is
 * `{ file, line, ref, owner, reason }`. `file` is left as passed-in (the
 * caller supplies a display path).
 *
 * Only lines whose first non-space token is `uses:` (a YAML mapping key) are
 * inspected — `uses:` appearing inside a comment or a `run:` heredoc never
 * starts a YAML key at column-leading position, so this avoids false hits on
 * documentation examples embedded in `#` comments (those are indented past a
 * leading `#`).
 */
export function scanContent(content, displayFile, firstPartyOwner = DEFAULT_FIRST_PARTY_OWNER) {
  const violations = [];
  let scanned = 0;
  const lines = String(content).split(/\r?\n/);
  // Matches a YAML `uses:` mapping key: optional leading whitespace, an
  // optional leading `- ` (sequence item), then `uses:` and the value.
  const usesRe = /^\s*(?:-\s+)?uses:\s*(\S.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Skip whole-line comments outright (defensive; the regex below also
    // won't match a leading '#').
    if (/^\s*#/.test(raw)) continue;
    const m = raw.match(usesRe);
    if (!m) continue;
    const bareRef = stripUsesValue(m[1]);
    const cls = classifyUses(bareRef, firstPartyOwner);
    if (cls.kind !== "third-party") continue; // local/docker/first-party/unparseable → exempt
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
  return { violations, scanned };
}

// ---------------------------------------------------------------------------
// Filesystem walking
// ---------------------------------------------------------------------------

/** List `*.yml` / `*.yaml` files directly under a workflows dir (non-recursive). */
export function listWorkflowFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Recursively list composite `action.yml` / `action.yaml` files under a dir. */
export function listActionFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (/^action\.ya?ml$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full lint against the resolved option set. Returns
 * `{ ok, violations, scanned, files }`. Pure with respect to stdout — the CLI
 * wrapper formats and prints.
 */
export function runLint(opts) {
  const cwd = opts.cwd || process.cwd();
  const wfDir = resolve(cwd, opts.workflowsDir);
  const acDir = resolve(cwd, opts.actionsDir);
  const files = [...listWorkflowFiles(wfDir), ...listActionFiles(acDir)];

  const violations = [];
  let scanned = 0;
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
    scanned += res.scanned;
  }
  return { ok: violations.length === 0, violations, scanned, files };
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

  if (!result.ok) {
    err(`[action-pins] ❌ ${result.violations.length} unpinned third-party action(s):`);
    for (const v of result.violations) {
      err(`  • ${v.file}:${v.line} — ${v.reason}`);
    }
    err(
      "[action-pins] Pin every third-party action to a full 40-char commit SHA " +
        "(keep the `# vX.Y.Z` tag note as a comment). A mutable tag can be " +
        "force-moved to a malicious commit after review."
    );
    return 1;
  }

  log(
    `[action-pins] ✅ all ${result.scanned} third-party action reference(s) are SHA-pinned ` +
      `(${result.files.length} file(s) scanned).`
  );
  return 0;
}

// Only run when executed directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("check-action-pins.mjs");
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
