#!/usr/bin/env node
/**
 * check-first-party-pin-freshness.mjs
 *
 * First-party self-pin freshness guard (Story #354).
 *
 * This repo publishes its own composite actions and reusable workflows and
 * then CALLS them by absolute `owner/repo/subpath@<sha>` reference — the same
 * form a consumer uses. That self-pin is the ONLY thing that decides which
 * revision of the action actually runs. Fixing an action file in the working
 * tree therefore changes nothing at runtime until every call site is
 * repointed, and nothing in the repo detected that gap:
 *
 *   • `check-action-pins.mjs` enforces only the single-pin invariant — that
 *     every call site for a subpath agrees. A fleet of call sites agreeing on
 *     ONE STALE sha is perfectly green. (At the time it also EXEMPTED
 *     first-party refs from the SHA ratchet entirely; that exemption was
 *     retired by the Story #354 audit — see the `unpinnedRefs` note below.)
 *   • `check-workflow-portability.mjs` Rule 3 does read the manifest at the
 *     pinned SHA, but re-runs only its own Rules 1–2 against it (relative
 *     `uses:`, `${{ }}` in input descriptions/defaults). A BEHAVIOURAL lag —
 *     e.g. `mktemp -d` → `${RUNNER_TEMP}` — is invisible to it.
 *
 * That blind spot shipped issue #352: PR #345 scoped the gitleaks/osv
 * extraction dirs to `${RUNNER_TEMP}`, no call site was repointed, and every
 * consumer on a self-hosted fleet kept leaking ~164 MB per run into the
 * host-shared temp root on the latest release.
 *
 * ## Why the comparison is the DIRECTORY, not the manifest (Story #379)
 *
 * The first cut of this checker compared only `action.yml`, which is
 * structurally unable to protect a composite action whose behaviour lives in a
 * sibling script — the majority of this repo's action surface. Story #365
 * rewrote `.github/actions/osv-scan/osv-report-gate.mjs` (+189/-12) without
 * touching `action.yml`, so this guard reported `osv-scan` fresh while both
 * call sites ran a 689-line gate against 866 lines on `main`. The comparison
 * is therefore the whole subpath tree — every file `git ls-tree -r <sha> --
 * <subpath>` names, plus every tracked working-tree file under it, so an added
 * or removed sibling is drift too.
 *
 * ## Why a subpath can have COMPANIONS (Story #389)
 *
 * The subpaths this checker knows are exactly the ones named on `uses:` lines,
 * which reopens the same blind spot one level up the moment an action's
 * behaviour moves into a SIBLING DIRECTORY. Story #389 reduced
 * `.github/actions/osv-track-issue` to a thin preset that executes
 * `.github/actions/track-issue/track-issue.mjs` — nothing `uses:` the generic
 * action, so a rewrite of that shared core would leave every `osv-track-issue`
 * pin reading fresh while the pinned SHA runs the old state machine.
 *
 * `COMPANION_SUBPATHS` closes it: a subpath's companions are folded into the
 * tree comparison and into the drift cache key, so an edit confined to the
 * shared core marks every call site of every dependent preset stale. The map
 * is deliberately explicit rather than inferred — a heuristic over `run:`
 * bodies would both miss indirection and invent false drift.
 *
 * This checker closes it by classifying every first-party SHA pin into one of
 * two failure classes — deliberately kept distinct, because their remedies
 * differ:
 *
 *   • `stale`       — the SUBPATH TREE at the pinned SHA differs from the
 *                     working-tree copy — any file under it, not just the
 *                     manifest. The fix is to BUMP the pin to a commit
 *                     carrying the current tree.
 *   • `unreachable` — the pinned SHA is not an ancestor of the checked-out
 *                     ref. Typically a pre-squash branch commit: content-
 *                     identical to `main` today, resolvable only until GitHub
 *                     garbage-collects it, after which every consumer fails at
 *                     action-load time. The fix is to RE-PIN to the squashed
 *                     commit on `main`.
 *
 * A first-party ref that is NOT a 40-hex SHA has no freshness answer at all —
 * a branch or tag names a revision that can move after this check runs — so it
 * is collected into `unpinnedRefs` and merely REPORTED. Enforcing the SHA
 * shape belongs upstream of freshness, in `check-action-pins.mjs`, which
 * ratchets first-party refs alongside third-party ones and runs in the
 * PR-gating `ci.yml` where this check deliberately does not (see below). The
 * note here is the backstop for a consumer that adopted only this script.
 *
 * Requires full git history — run the checkout with `fetch-depth: 0`. A
 * shallow clone cannot answer either question and is refused loudly rather
 * than reported as a wall of false `unreachable` findings.
 *
 * ## Where this runs, and why not on PRs
 *
 * Wired onto push-to-`main` and the `pin-drift.yml` schedule; deliberately
 * ABSENT from the PR-gating `ci.yml`. A PR that edits a composite action
 * cannot pin its own not-yet-existing merge commit, so a PR-time gate would
 * be unsatisfiable on exactly the changes it exists to protect. A red `main`
 * is instead the signal to open the follow-up bump PR — the land-then-bump
 * sequence documented in docs/reusable-workflows.md.
 *
 * Usage:
 *   node scripts/check-first-party-pin-freshness.mjs
 *   node scripts/check-first-party-pin-freshness.mjs --cwd /path/to/repo
 *   node scripts/check-first-party-pin-freshness.mjs --ref origin/main
 *   node scripts/check-first-party-pin-freshness.mjs --first-party-owner my-org/my-repo
 *
 * Exit codes:
 *   0 — every first-party pin resolves to a fresh, reachable manifest.
 *   1 — one or more `stale` / `unreachable` pins (each named in stderr with
 *       file, line, subpath and SHA), or the history needed to decide is
 *       unavailable.
 *
 * Consumer adoption:
 *   Copy this script into your project's `scripts/` directory alongside
 *   `scripts/lib/{args,uses-pins,walk}.mjs` (its only dependencies — no YAML
 *   parser), then run it on push to your default branch:
 *
 *     - uses: actions/checkout@<sha>
 *       with: { fetch-depth: 0 }
 *     - run: node scripts/check-first-party-pin-freshness.mjs --first-party-owner <owner/repo>
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, relative, basename } from "node:path";

import { parseFlags } from "./lib/args.mjs";
import {
  DEFAULT_FIRST_PARTY_OWNER,
  parseUsesLine,
  classifyUses,
  isSha40,
} from "./lib/uses-pins.mjs";
import { listWorkflowFiles, listActionFiles } from "./lib/walk.mjs";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Parse the CLI argv slice (everything AFTER `node script.mjs`) into an
 * options object. Throws on an unknown flag so a typo fails loudly rather than
 * silently disabling half the check.
 *
 * @param {string[]} argv
 * @returns {{workflowsDir: string, actionsDir: string, firstPartyOwner: string, cwd: string, ref: string, help: boolean}}
 */
export function parseArgs(argv) {
  return parseFlags(argv, {
    flags: {
      "--workflows-dir": { type: "string", dest: "workflowsDir", default: ".github/workflows" },
      "--actions-dir": { type: "string", dest: "actionsDir", default: ".github/actions" },
      "--first-party-owner": {
        type: "string",
        dest: "firstPartyOwner",
        default: DEFAULT_FIRST_PARTY_OWNER,
      },
      "--cwd": { type: "string", dest: "cwd", default: process.cwd() },
      "--ref": { type: "string", dest: "ref", default: "HEAD" },
      "--help": { type: "boolean", dest: "help", value: true, default: false },
    },
    aliases: { "-h": "--help" },
    onUnknown: "throw",
  });
}

// ---------------------------------------------------------------------------
// Pin collection (pure text)
// ---------------------------------------------------------------------------

/**
 * Scan a file's TEXT for first-party `uses:` references and split them into
 * the SHA-pinned refs this checker classifies and the non-SHA refs it can only
 * note. Third-party, local (`./path`) and `docker://` references are dropped
 * here and can therefore never reach the report.
 *
 * A bare `owner/repo@ref` self-reference is skipped: with no subpath there is
 * no manifest to resolve. Whole-line `#` comments never match (the doc-example
 * `uses:` lines every action.yml carries in its header are comments).
 *
 * @param {string} content
 * @param {string} displayFile Path as it should appear in the report.
 * @param {string} [firstPartyOwner]
 * @returns {{pins: Array<{file: string, line: number, subpath: string, sha: string}>, unpinnedRefs: Array<{file: string, line: number, subpath: string, ref: string}>}}
 */
export function collectPinnedRefs(
  content,
  displayFile,
  firstPartyOwner = DEFAULT_FIRST_PARTY_OWNER
) {
  const pins = [];
  const unpinnedRefs = [];
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const bareRef = parseUsesLine(lines[i]);
    if (bareRef === null) continue;
    const cls = classifyUses(bareRef, firstPartyOwner);
    if (cls.kind !== "first-party") continue;
    if (!cls.subpath) continue; // bare owner/repo self-ref — no manifest to resolve
    const record = { file: displayFile, line: i + 1, subpath: cls.subpath };
    if (isSha40(cls.ref)) pins.push({ ...record, sha: cls.ref });
    else unpinnedRefs.push({ ...record, ref: cls.ref });
  }
  return { pins, unpinnedRefs };
}

/**
 * Resolve the manifest a `uses:` subpath points at, relative to a repo root.
 * A directory subpath resolves to its `action.yml` / `action.yaml`; a `.yml` /
 * `.yaml` subpath resolves to itself. Returns null when the subpath does not
 * exist in the working tree or holds no manifest.
 *
 * @param {string} repoRoot
 * @param {string} subpath
 * @returns {{path: string, kind: "action" | "workflow"} | null}
 */
export function resolveManifest(repoRoot, subpath) {
  const local = join(repoRoot, subpath);
  let st;
  try {
    st = statSync(local);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    for (const name of ["action.yml", "action.yaml"]) {
      if (existsSync(join(local, name))) return { path: `${subpath}/${name}`, kind: "action" };
    }
    return null;
  }
  if (/\.ya?ml$/.test(subpath)) {
    return { path: subpath, kind: basename(subpath).startsWith("action.") ? "action" : "workflow" };
  }
  return null;
}

/**
 * Compare two manifest bodies for equality, tolerating line-ending drift so a
 * CRLF working tree on Windows does not report every pin as stale.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function manifestsMatch(a, b) {
  const norm = (s) => String(s).replace(/\r\n/g, "\n");
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Git seam
// ---------------------------------------------------------------------------

/**
 * Build the narrow git interface `runCheck` needs, bound to a repo root. Every
 * method is failure-tolerant: a missing object or an unreadable path answers
 * "no" rather than throwing, so a broken pin is reported as a finding instead
 * of crashing the lint.
 *
 * @param {string} repoRoot
 */
export function createGit(repoRoot) {
  const run = (args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });

  return {
    /** True when `repoRoot` sits inside a git work tree. */
    isRepo() {
      try {
        run(["rev-parse", "--is-inside-work-tree"]);
        return true;
      } catch {
        return false;
      }
    },
    /** True when the clone is shallow (history truncated — cannot decide). */
    isShallow() {
      try {
        return run(["rev-parse", "--is-shallow-repository"]).trim() === "true";
      } catch {
        return false;
      }
    },
    /** Abbreviated SHA of a ref, or null when it does not resolve. */
    resolveRef(ref) {
      try {
        return run(["rev-parse", ref]).trim();
      } catch {
        return null;
      }
    },
    /** True when `sha` is an ancestor of (or equal to) `ref`. */
    isAncestor(sha, ref) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", sha, ref], {
          cwd: repoRoot,
          stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
      } catch {
        // Exit 1 = not an ancestor; exit 128 = unknown object. Both mean the
        // pin is not reachable from the checked-out ref.
        return false;
      }
    },
    /** `git show <sha>:<path>` → content, or null when unresolvable. */
    show(sha, path) {
      try {
        return run(["show", `${sha}:${path}`]);
      } catch {
        return null;
      }
    },
    /**
     * Repo-relative paths of every blob a subpath covers AT `sha`. A directory
     * subpath yields its whole tree; a file subpath yields just itself. `-z`
     * so a path with a space or a quote survives intact.
     */
    lsTree(sha, subpath) {
      try {
        return run(["ls-tree", "-r", "--name-only", "-z", sha, "--", subpath])
          .split("\0")
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    /**
     * Repo-relative paths of every TRACKED working-tree file under a subpath.
     * Tracked, not on-disk: an ignored build artefact or a stray `.DS_Store`
     * inside an action directory is not something a consumer ever runs.
     */
    lsFiles(subpath) {
      try {
        return run(["ls-files", "-z", "--", subpath]).split("\0").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Subpath tree comparison
// ---------------------------------------------------------------------------

/**
 * Subpaths whose runtime behaviour lives partly in ANOTHER directory that no
 * `uses:` line names. Each key's companions are compared alongside it, so an
 * edit confined to a shared core still marks the dependent pins stale.
 *
 * Keep this map in step with any preset/core split under `.github/actions/`:
 * an entry omitted here is a pin that reads fresh while running old code.
 *
 * @type {Record<string, string[]>}
 */
export const COMPANION_SUBPATHS = {
  // Story #389 — the preset executes ../track-issue/track-issue.mjs.
  ".github/actions/osv-track-issue": [".github/actions/track-issue"],
};

/**
 * Companion subpaths for a `uses:` subpath (empty when it stands alone).
 * Trailing slashes are tolerated so `foo/` and `foo` resolve identically.
 *
 * @param {string} subpath
 * @param {Record<string, string[]>} [map]
 * @returns {string[]}
 */
export function companionsFor(subpath, map = COMPANION_SUBPATHS) {
  return map[String(subpath).replace(/\/+$/, "")] || [];
}

/** How each drift kind reads in the report. */
const DRIFT_PHRASE = {
  differs: "differs from the working-tree copy",
  added: "is absent at the pinned SHA (added since)",
  removed: "is gone from the working tree (removed since)",
  unreadable: "is tracked but unreadable in the working tree",
};

/**
 * Compare every file a `uses:` subpath covers at `sha` against the working
 * tree, and return one record per drifting path (empty when the tree matches).
 *
 * The union of both sides is walked, so a sibling script ADDED or REMOVED
 * since the pinned revision is drift just as much as one whose bytes changed —
 * all three change what the pinned revision actually executes.
 *
 * `companions` extends the comparison to directories the subpath EXECUTES but
 * no `uses:` line names (Story #389). They are compared identically: a shared
 * core that differs at the pinned SHA is exactly as inert as a sibling script.
 *
 * @param {{lsTree: Function, lsFiles: Function, show: Function}} git
 * @param {string} repoRoot
 * @param {string} sha
 * @param {string} subpath
 * @param {string[]} [companions]
 * @returns {Array<{path: string, kind: "differs" | "added" | "removed" | "unreadable"}>}
 */
export function diffSubpathAtSha(git, repoRoot, sha, subpath, companions = []) {
  const roots = [subpath, ...companions];
  const pinned = new Set(roots.flatMap((root) => git.lsTree(sha, root)));
  const working = new Set(roots.flatMap((root) => git.lsFiles(root)));
  const drift = [];

  for (const path of [...new Set([...pinned, ...working])].sort()) {
    if (!working.has(path)) {
      drift.push({ path, kind: "removed" });
      continue;
    }
    if (!pinned.has(path)) {
      drift.push({ path, kind: "added" });
      continue;
    }
    let workingBody;
    try {
      workingBody = readFileSync(join(repoRoot, path), "utf8");
    } catch {
      drift.push({ path, kind: "unreadable" });
      continue;
    }
    const pinnedBody = git.show(sha, path);
    if (pinnedBody === null || !manifestsMatch(pinnedBody, workingBody)) {
      drift.push({ path, kind: "differs" });
    }
  }

  return drift;
}

/**
 * Render a drift list as the one-line `reason` a finding carries. Action
 * directories hold a handful of files, so every drifting path is named rather
 * than summarised — the operator needs to know WHICH file is inert.
 *
 * @param {string} subpath
 * @param {ReturnType<typeof diffSubpathAtSha>} drift
 * @param {string[]} [companions]
 * @returns {string}
 */
export function describeDrift(subpath, drift, companions = []) {
  const detail = drift.map((d) => `${d.path} ${DRIFT_PHRASE[d.kind]}`).join("; ");
  const scope =
    companions.length > 0
      ? `${subpath} (and the shared code it executes: ${companions.join(", ")})`
      : subpath;
  return (
    `${drift.length} file(s) under ${scope} lag the pinned SHA — the pinned ` +
    `revision is what actually runs: ${detail}`
  );
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Classify every first-party SHA pin under the repo's workflow and action
 * trees. Returns a structured result; formatting and the exit code live in
 * {@link runCli}.
 *
 * `git` is injectable so a caller can drive the classification against a
 * substitute history; it defaults to the real git bound to `opts.cwd`.
 *
 * `opts.companions` overrides {@link COMPANION_SUBPATHS} — injectable so a
 * fixture can exercise the shared-core relationship without depending on this
 * repo's own action layout.
 *
 * @param {{cwd?: string, workflowsDir?: string, actionsDir?: string, firstPartyOwner?: string, ref?: string, companions?: Record<string, string[]>}} opts
 * @param {ReturnType<typeof createGit>} [git]
 * @returns {{ok: boolean, fatal: string|null, stale: object[], unreachable: object[], unpinnedRefs: object[], scanned: number, files: string[], headSha: string|null}}
 */
export function runCheck(opts = {}, git = createGit(resolve(opts.cwd || process.cwd()))) {
  const repoRoot = resolve(opts.cwd || process.cwd());
  const ref = opts.ref || "HEAD";
  const firstPartyOwner = opts.firstPartyOwner || DEFAULT_FIRST_PARTY_OWNER;
  const wfDir = resolve(repoRoot, opts.workflowsDir || ".github/workflows");
  const acDir = resolve(repoRoot, opts.actionsDir || ".github/actions");

  const empty = {
    ok: false,
    fatal: null,
    stale: [],
    unreachable: [],
    unpinnedRefs: [],
    scanned: 0,
    files: [],
    headSha: null,
  };

  if (!git.isRepo()) {
    return {
      ...empty,
      fatal:
        "not a git repository — this check resolves each pinned manifest from " +
        "git history and cannot run without it",
    };
  }
  if (git.isShallow()) {
    return {
      ...empty,
      fatal:
        "shallow clone — pinned manifests and ancestry are unresolvable. Run " +
        "the checkout with `fetch-depth: 0`",
    };
  }
  const headSha = git.resolveRef(ref);
  if (headSha === null) {
    return { ...empty, fatal: `ref "${ref}" does not resolve in this repository` };
  }

  const files = [...listWorkflowFiles(wfDir), ...listActionFiles(acDir)];
  const stale = [];
  const unreachable = [];
  const unpinnedRefs = [];
  let scanned = 0;

  // Every call site for a subpath must move together, so the same
  // (sha, subpath) pair is compared repeatedly — `setup-toolchain` alone has
  // five. Resolve each tree once. The companions are part of the key: two
  // subpaths sharing a core must not collide, and a companion map override
  // must not read a cache entry computed without it.
  const companionMap = opts.companions || COMPANION_SUBPATHS;
  const driftCache = new Map();
  const driftFor = (sha, subpath, companions) => {
    const key = `${sha}:${[subpath, ...companions].join(",")}`;
    if (!driftCache.has(key)) {
      driftCache.set(key, diffSubpathAtSha(git, repoRoot, sha, subpath, companions));
    }
    return driftCache.get(key);
  };

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const display = relative(repoRoot, file) || file;
    const collected = collectPinnedRefs(content, display, firstPartyOwner);
    unpinnedRefs.push(...collected.unpinnedRefs);

    for (const pin of collected.pins) {
      scanned++;

      // Reachability first: an unknown or off-branch object cannot be compared
      // in the first place, and its remedy (re-pin to the squashed commit)
      // differs from a bump.
      if (!git.isAncestor(pin.sha, ref)) {
        unreachable.push({
          ...pin,
          reason:
            `pinned SHA is not an ancestor of ${ref} — a dangling or pre-squash ` +
            `branch commit that breaks every consumer once it is garbage-collected`,
        });
        continue;
      }

      const manifest = resolveManifest(repoRoot, pin.subpath);
      if (manifest === null) {
        stale.push({
          ...pin,
          reason: `no manifest at ${pin.subpath} in the working tree — the pin references a path that no longer exists`,
        });
        continue;
      }

      if (git.show(pin.sha, manifest.path) === null) {
        stale.push({
          ...pin,
          reason: `${manifest.path} does not exist at the pinned SHA — the pin predates the manifest`,
        });
        continue;
      }

      const companions = companionsFor(pin.subpath, companionMap);
      const drift = driftFor(pin.sha, pin.subpath, companions);
      if (drift.length > 0) {
        stale.push({
          ...pin,
          manifest: manifest.path,
          reason: describeDrift(pin.subpath, drift, companions),
        });
      }
    }
  }

  return {
    ok: stale.length === 0 && unreachable.length === 0,
    fatal: null,
    stale,
    unreachable,
    unpinnedRefs,
    scanned,
    files,
    headSha,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: node scripts/check-first-party-pin-freshness.mjs " +
  "[--cwd <dir>] [--ref <git-ref>] [--workflows-dir <dir>] [--actions-dir <dir>] " +
  "[--first-party-owner <owner/repo>]";

/**
 * Format one finding as a two-line report entry naming the referencing file,
 * the line, the subpath and the full pinned SHA (the four facts needed to act
 * on it without re-deriving anything).
 */
function formatFinding(f, cls) {
  return (
    `  • ${f.file}:${f.line} — ${f.subpath}@${f.sha} [${cls}]\n` +
    `      ${f.reason}`
  );
}

/**
 * Run the check and return a POSIX exit code. `log` / `err` are injectable so
 * the sibling node:test suite can capture output without touching the real
 * streams.
 *
 * @param {string[]} argv
 * @param {{log?: Function, err?: Function}} [io]
 * @returns {number}
 */
export function runCli(argv, { log = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`[pin-freshness] ❌ ${e.message}`);
    err(USAGE);
    return 1;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }

  const result = runCheck(opts);

  if (result.fatal !== null) {
    err(`[pin-freshness] ❌ ${result.fatal}.`);
    return 1;
  }

  if (result.unreachable.length > 0) {
    err(
      `[pin-freshness] ❌ ${result.unreachable.length} unreachable first-party pin(s) — ` +
        `not an ancestor of ${opts.ref}:`
    );
    for (const f of result.unreachable) err(formatFinding(f, "unreachable"));
    err(
      "[pin-freshness] Re-pin each to the squashed commit on the default branch. " +
        "These resolve today only because the pre-squash commit has not been " +
        "garbage-collected yet."
    );
  }

  if (result.stale.length > 0) {
    err(
      `[pin-freshness] ❌ ${result.stale.length} stale first-party pin(s) — ` +
        `the pinned revision lags the working tree:`
    );
    for (const f of result.stale) err(formatFinding(f, "stale"));
    err(
      "[pin-freshness] Bump each pin to a commit on the default branch whose " +
        "action directory matches the working-tree copy. Every call site for a " +
        "given subpath must move together (check-action-pins.mjs enforces the " +
        "single-pin invariant per subpath)."
    );
  }

  if (!result.ok) {
    err(
      "[pin-freshness] A first-party fix that no call site pins is inert: the " +
        "pinned revision is what runs. See docs/reusable-workflows.md " +
        "(First-party self-pin freshness) for the land-then-bump sequence."
    );
    return 1;
  }

  if (result.unpinnedRefs.length > 0) {
    log(
      `[pin-freshness] ℹ️  ${result.unpinnedRefs.length} first-party ref(s) are not SHA-pinned ` +
        `(freshness undecidable — reported, not failed):`
    );
    for (const u of result.unpinnedRefs) {
      log(`     ${u.file}:${u.line} — ${u.subpath}@${u.ref}`);
    }
  }

  log(
    `[pin-freshness] ✅ all ${result.scanned} first-party pin(s) resolve to an action ` +
      `directory matching the working tree and reachable from ${opts.ref} ` +
      `(${result.headSha.slice(0, 7)}); ${result.files.length} file(s) scanned.`
  );
  return 0;
}

// Only run when executed directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]).endsWith("check-first-party-pin-freshness.mjs");
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
