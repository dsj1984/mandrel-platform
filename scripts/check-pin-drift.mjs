#!/usr/bin/env node
/**
 * check-pin-drift.mjs
 *
 * Cross-consumer pin-drift dashboard for mandrel-platform (Story #67, MP-12).
 *
 * The split-pin / release-lag state across the three consumers (domio,
 * athportal, swarm-os) went undetected and undocumented: every consumer
 * pinned `pr-quality.yml@<shaA>` and `deploy-cloudflare.yml@<shaB>` — two
 * different release SHAs per repo, neither on the current platform release,
 * with no automated drift detection. This script is
 * the standing check that surfaces it automatically.
 *
 * For each consumer in `scripts/pin-drift-consumers.json` it:
 *   1. Enumerates every workflow file under `.github/workflows/` (over the
 *      GitHub contents API, against the consumer's default branch unless the
 *      entry pins a `branch`).
 *   2. Extracts every `uses:` ref that points at the platform repo
 *      (`<platformRepo>/...@<ref>`) — reusable workflows AND composite
 *      actions across ALL chains.
 *   3. Asserts the consumer pins a SINGLE platform SHA across all of those
 *      refs (a "split pin" is more than one distinct SHA in one consumer).
 *   4. Flags lag: compares the pinned SHA against the latest platform release
 *      commit. A consumer is `current` when its single pin equals the latest
 *      release SHA, `lagging` when it pins an older release/SHA, and
 *      `unknown` when the pinned SHA can't be matched to a release.
 *   5. Reads the consumer's `package.json` and extracts its
 *      `mandrel-platform` npm dependency version (the platform also ships as
 *      an npm config package: tsconfig.base.json, biome.base.json, the
 *      Renovate preset). It compares that version to the latest release's
 *      version and flags an `npm` verdict (`current` / `lagging` / `ahead` /
 *      `absent` / `unknown`), plus a **surface skew** when the npm pin and the
 *      workflow `uses:` pin disagree about being current — the exact
 *      split-pin class the `uses:`-only check missed (npm lagged at 0.11.3
 *      while the workflows tracked v0.11.6).
 *   6. Couples the two surfaces against the supply-chain hold (Story #107).
 *      Renovate's shared preset gates every bump behind a `minimumReleaseAge`
 *      (3 days). For the first ~3 days after a platform release, EVERY consumer
 *      legitimately lags the new tag — Renovate has not raised the bump PR yet.
 *      Flagging that transient window as drift would page on every release, so
 *      the checker reads the latest release's `published_at`, compares it to the
 *      `minimumReleaseAge` window (configurable in pin-drift-consumers.json,
 *      default `3 days`), and **suppresses lag/skew that is fully explained by
 *      the hold**: a consumer whose only deviation is "not yet on a release
 *      younger than the window" is reported as `holding` (informational), not
 *      `drift`. Lag against a release OLDER than the window — or a split pin —
 *      still drifts. This is the permanent close of the swarm-os three-way
 *      split: npm `0.11.3` / workflows `@v0.11.6` / latest `v0.11.7` could not
 *      be distinguished from a fresh-release hold before this coupling existed.
 *
 *   7. Lints **stale pin literals beyond `uses:` lines** (Story #110). A
 *      platform-ref SHA/tag can live in a **comment** or a **`run:`/echo step
 *      string** (e.g. a deploy-summary line that echoes a hand-maintained
 *      `deploy-cloudflare.yml@<sha>` literal) and drift independently of the
 *      real `uses:` pin — the `uses:`-only scan never saw it. The checker now
 *      also extracts every loose platform-ref literal and flags any whose ref
 *      no longer matches the consumer's canonical `uses:` pin (`stale`), or
 *      that has no canonical pin to track at all (`orphan`). A stale literal is
 *      a real configuration error and is never suppressed by the
 *      `minimumReleaseAge` hold. The fix is to adopt the resolved-ref step
 *      summary `deploy-cloudflare.yml` now emits (its `github.job_workflow_sha`
 *      single source of truth) rather than maintaining the literal by hand.
 *
 * Data-driven: a new consumer is one object in pin-drift-consumers.json.
 *
 * GitHub access is via the `gh` CLI (`gh api`), so the script inherits the
 * caller's auth (a `GH_TOKEN`/`GITHUB_TOKEN` in CI, or `gh auth` locally).
 * No secrets are read or printed by this script.
 *
 * Usage:
 *   node scripts/check-pin-drift.mjs
 *   node scripts/check-pin-drift.mjs --config scripts/pin-drift-consumers.json
 *   node scripts/check-pin-drift.mjs --json            # machine-readable envelope
 *   node scripts/check-pin-drift.mjs --strict          # exit 1 on any drift
 *
 * Exit codes:
 *   0 — report emitted. Without --strict this is the default even when drift
 *       is present (the dashboard reports; it does not block by default).
 *   1 — with --strict: at least one consumer is split-pinned or lagging.
 *       Without --strict: only on a fatal error (bad config, gh failure).
 *
 * GitHub Actions: when GITHUB_STEP_SUMMARY is set, the human-readable report
 * is also appended there so it renders on the job summary page.
 */

import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  defaultGhRunner,
  ghApiJson,
  isNotFound,
} from "./lib/gh-json.mjs";
import {
  compareSemver,
  parseDurationMs,
  parseSemver,
} from "./lib/semver-duration.mjs";

// Re-export the extracted seams so existing importers (platform-repair.mjs,
// the test suite) keep their `check-pin-drift.mjs` import paths. The canonical
// homes are scripts/lib/gh-json.mjs and scripts/lib/semver-duration.mjs
// (Story #198).
export { compareSemver, parseDurationMs, parseSemver, defaultGhRunner };

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ config: string, json: boolean, strict: boolean }}
 */
export function parseArgv(argv = []) {
  let config = "scripts/pin-drift-consumers.json";
  let json = false;
  let strict = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--config") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        config = next;
        i += 1;
      }
    } else if (a === "--json") {
      json = true;
    } else if (a === "--strict") {
      strict = true;
    }
  }
  return { config, json, strict };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit-style probing without GitHub access)
// ---------------------------------------------------------------------------

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Is `ref` a full 40-char hex commit SHA?
 * @param {string} ref
 * @returns {boolean}
 */
export function isFullSha(ref) {
  return SHA_RE.test(ref);
}

/**
 * Extract every `uses:` ref that targets the platform repo from one workflow
 * file's text. Matches both reusable-workflow refs
 * (`<platformRepo>/.github/workflows/x.yml@<ref>`) and composite-action refs
 * (`<platformRepo>/.github/actions/y@<ref>`).
 *
 * @param {string} file       Display label for the file (path in the repo).
 * @param {string} text       File contents.
 * @param {string} platformRepo  e.g. "dsj1984/mandrel-platform".
 * @returns {Array<{ file: string, line: number, target: string, ref: string | null }>}
 */
export function extractPlatformPins(file, text, platformRepo) {
  const pins = [];
  const lines = text.split(/\r?\n/);
  const usesRe = /^\s*(?:-\s*)?uses:\s*['"]?([^'"#\s]+)['"]?/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = usesRe.exec(lines[i]);
    if (!m) continue;
    const value = m[1];
    // Only platform-repo refs: `<platformRepo>` or `<platformRepo>/<subpath>`.
    if (value !== platformRepo && !value.startsWith(`${platformRepo}/`)) {
      continue;
    }
    const atIndex = value.indexOf("@");
    const target = atIndex === -1 ? value : value.slice(0, atIndex);
    const ref = atIndex === -1 ? null : value.slice(atIndex + 1);
    pins.push({ file, line: i + 1, target, ref });
  }
  return pins;
}

/**
 * Extract every **non-`uses:`** platform-repo ref literal from one workflow
 * file's text (Story #110). The `uses:`-only extractor above misses a stale
 * SHA/tag that lives in a **comment** or a **`run:`/echo step string** — e.g. a
 * deploy-summary line that echoes a hand-maintained
 * `deploy-cloudflare.yml@<sha>` literal. Those literals drift independently of
 * the real `uses:` pin and the `uses:`-only check never sees them.
 *
 * This scans every line, matches any `<platformRepo>/<subpath>@<ref>` token
 * (with `ref` a 40-hex SHA or a non-whitespace tag), and SKIPS lines that are a
 * `uses:` directive (those are owned by `extractPlatformPins`). The result is
 * the set of "loose" platform-ref literals a consumer carries outside its
 * canonical pin surface.
 *
 * @param {string} file       Display label for the file (path in the repo).
 * @param {string} text       File contents.
 * @param {string} platformRepo  e.g. "dsj1984/mandrel-platform".
 * @returns {Array<{ file: string, line: number, target: string, ref: string, kind: 'comment' | 'run' }>}
 */
export function extractStaleLiterals(file, text, platformRepo) {
  const literals = [];
  const lines = text.split(/\r?\n/);
  // `<platformRepo>/<subpath>@<ref>` where ref is a 40-hex SHA or a tag token.
  // The subpath is required (a bare `<repo>@<ref>` is not a workflow/action
  // literal we care about here) and the ref stops at whitespace/quote/comment.
  const escapedRepo = platformRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const litRe = new RegExp(
    `${escapedRepo}/[^\\s'"@]+@([0-9a-fA-F]{40}|[A-Za-z0-9._/-]+)`,
    "g",
  );
  const usesRe = /^\s*(?:-\s*)?uses:\s*/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // `uses:` lines are owned by extractPlatformPins — never double-count them.
    if (usesRe.test(line)) continue;
    const commentIndex = line.indexOf("#");
    let match;
    litRe.lastIndex = 0;
    while ((match = litRe.exec(line)) !== null) {
      const ref = match[1];
      const col = match.index;
      // A literal inside a `#` comment is a comment-kind literal; otherwise it
      // lives in a run:/echo/string body.
      const kind =
        commentIndex !== -1 && col > commentIndex ? "comment" : "run";
      literals.push({ file, line: i + 1, target: platformRepo, ref, kind });
    }
  }
  return literals;
}

/**
 * Classify a consumer's loose platform-ref literals against its canonical
 * `uses:` pin (Story #110). A literal is **stale** when it pins a ref the
 * canonical `uses:` surface no longer pins — most commonly a hand-maintained
 * echoed SHA in a deploy-summary string that lags the real pin. The canonical
 * set is the consumer's distinct `uses:` refs (SHAs and tags); a literal whose
 * ref is absent from that set is flagged.
 *
 * When the consumer has no canonical `uses:` pin to compare against (no
 * platform `uses:` at all), every loose literal is reported as `orphan` — a
 * platform-ref literal with no owning pin is itself a maintenance hazard.
 *
 * @param {Array<{ file: string, line: number, target: string, ref: string, kind: string }>} literals
 * @param {string[]} canonicalRefs  Distinct refs from the consumer's `uses:` pins.
 * @returns {{
 *   staleLiterals: Array<{ file: string, line: number, ref: string, kind: string, reason: 'stale' | 'orphan' }>,
 *   hasStaleLiteral: boolean,
 * }}
 */
export function classifyStaleLiterals(literals, canonicalRefs) {
  const canonical = new Set(canonicalRefs.map((r) => r.toLowerCase()));
  const staleLiterals = [];
  for (const lit of literals) {
    const refLower = lit.ref.toLowerCase();
    if (canonical.has(refLower)) continue; // matches the live pin — fine.
    staleLiterals.push({
      file: lit.file,
      line: lit.line,
      ref: lit.ref,
      kind: lit.kind,
      reason: canonical.size === 0 ? "orphan" : "stale",
    });
  }
  return { staleLiterals, hasStaleLiteral: staleLiterals.length > 0 };
}

/**
 * Classify one consumer's pin set into a drift verdict.
 *
 * @param {Array<{ file: string, line: number, target: string, ref: string | null }>} pins
 * @param {string | null} latestReleaseSha  40-char SHA of the latest platform release commit, or null if unknown.
 * @returns {{
 *   pinCount: number,
 *   distinctRefs: string[],
 *   splitPinned: boolean,
 *   floatingRefs: string[],
 *   pinnedSha: string | null,
 *   lagState: 'current' | 'lagging' | 'unknown' | 'no-pins',
 *   drift: boolean,
 * }}
 */
export function classifyConsumer(pins, latestReleaseSha) {
  const refs = pins.map((p) => p.ref).filter((r) => r !== null);
  const distinctRefs = [...new Set(refs)];
  const floatingRefs = distinctRefs.filter((r) => !isFullSha(r));

  if (pins.length === 0) {
    return {
      pinCount: 0,
      distinctRefs: [],
      splitPinned: false,
      floatingRefs: [],
      pinnedSha: null,
      lagState: "no-pins",
      drift: false,
    };
  }

  const distinctShas = distinctRefs.filter((r) => isFullSha(r));
  // "Split pin" = more than one distinct platform ref across all chains
  // (multiple SHAs, or a mix of SHA + floating tag/branch).
  const splitPinned = distinctRefs.length > 1;
  const pinnedSha =
    distinctShas.length === 1 && floatingRefs.length === 0
      ? distinctShas[0].toLowerCase()
      : null;

  let lagState;
  if (floatingRefs.length > 0 && distinctShas.length === 0) {
    // Pinned only to floating refs (tags/branches) — can't verify lag by SHA.
    lagState = "unknown";
  } else if (pinnedSha === null) {
    // Split or mixed — lag is moot until the split is resolved.
    lagState = "unknown";
  } else if (latestReleaseSha === null) {
    lagState = "unknown";
  } else if (pinnedSha === latestReleaseSha.toLowerCase()) {
    lagState = "current";
  } else {
    lagState = "lagging";
  }

  const drift = splitPinned || lagState === "lagging";

  return {
    pinCount: pins.length,
    distinctRefs,
    splitPinned,
    floatingRefs,
    pinnedSha,
    lagState,
    drift,
  };
}

/**
 * Is the latest platform release still inside the `minimumReleaseAge` hold
 * window? During this window Renovate has not yet raised the bump PR, so EVERY
 * consumer legitimately lags the new tag — that transient lag must NOT be
 * scored as drift (Story #107). Returns false (the safe default — "treat lag as
 * real drift") whenever the window or the publish timestamp can't be resolved.
 *
 * @param {string | null} publishedAt   Latest release `published_at` (ISO 8601), or null.
 * @param {number | null} windowMs       `minimumReleaseAge` in ms (see parseDurationMs), or null.
 * @param {number} [nowMs]               Current epoch ms (injectable for tests).
 * @returns {boolean}
 */
export function isWithinReleaseAgeWindow(
  publishedAt,
  windowMs,
  nowMs = Date.now(),
) {
  if (!publishedAt || typeof windowMs !== "number" || windowMs <= 0) {
    return false;
  }
  const publishedMs = Date.parse(publishedAt);
  if (Number.isNaN(publishedMs)) return false;
  const ageMs = nowMs - publishedMs;
  // A negative age (clock skew / future-dated release) counts as "fresh".
  return ageMs < windowMs;
}

/**
 * Extract the consumer's `mandrel-platform` npm dependency spec from a
 * package.json text blob. Scans `dependencies`, `devDependencies`,
 * `optionalDependencies`, and `peerDependencies` in that order. Returns the
 * raw spec string (e.g. `"0.11.3"`, `"^0.11.7"`, `"workspace:*"`) or null when
 * the package isn't depended on (or the JSON is unreadable).
 *
 * @param {string} text       package.json contents.
 * @param {string} [pkgName]  Dependency name to look for.
 * @returns {string | null}
 */
export function extractNpmPlatformVersion(text, pkgName = "mandrel-platform") {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== "object") return null;
  const fields = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  for (const field of fields) {
    const deps = pkg[field];
    if (deps && typeof deps === "object" && typeof deps[pkgName] === "string") {
      return deps[pkgName];
    }
  }
  return null;
}

/**
 * Classify the consumer's npm pin against the latest platform release version.
 *
 * @param {string | null} spec           Raw `mandrel-platform` dependency spec, or null if absent.
 * @param {string | null} latestVersion  Latest release version (`x.y.z`), or null if unknown.
 * @returns {{
 *   rawSpec: string | null,
 *   version: string | null,
 *   npmState: 'absent' | 'current' | 'lagging' | 'ahead' | 'unknown',
 * }}
 */
export function classifyNpmPin(spec, latestVersion) {
  if (spec === null || spec === undefined) {
    return { rawSpec: null, version: null, npmState: "absent" };
  }
  const version = parseSemver(spec);
  if (version === null) {
    // Non-numeric spec (workspace:*, dist-tag, git URL) — can't compare by SHA.
    return { rawSpec: spec, version: null, npmState: "unknown" };
  }
  const latest = parseSemver(latestVersion);
  if (latest === null) {
    return { rawSpec: spec, version, npmState: "unknown" };
  }
  const cmp = compareSemver(version, latest);
  const npmState = cmp === 0 ? "current" : cmp < 0 ? "lagging" : "ahead";
  return { rawSpec: spec, version, npmState };
}

/**
 * Detect a surface skew: the npm pin and the workflow `uses:` pin disagree
 * about being current. This is the split-pin class the `uses:`-only check
 * missed — e.g. workflows on the latest release while the npm config package
 * lags an older one (or vice versa). Only meaningful when BOTH surfaces
 * resolve to a comparable currency state.
 *
 * @param {'current' | 'lagging' | 'unknown' | 'no-pins'} usesLagState
 * @param {'absent' | 'current' | 'lagging' | 'ahead' | 'unknown'} npmState
 * @returns {boolean}
 */
export function detectSurfaceSkew(usesLagState, npmState) {
  const usesKnown = usesLagState === "current" || usesLagState === "lagging";
  const npmKnown = npmState === "current" || npmState === "lagging";
  if (!usesKnown || !npmKnown) return false;
  return (usesLagState === "current") !== (npmState === "current");
}

/**
 * Combine the workflow-pin verdict, the npm verdict, and the surface-skew flag
 * into a single per-consumer drift boolean. `npm ahead` and `npm absent` are
 * informational, not drift; `npm lagging` and any surface skew are.
 *
 * When `holding` is true (the latest release is still inside the
 * `minimumReleaseAge` hold window — Story #107), lag/skew that is fully
 * explained by the hold is suppressed: Renovate has not raised the bump PR yet,
 * so a one-release-behind consumer is **expected**, not drift. A **split pin**
 * is a real configuration error regardless of the window, so it is never
 * suppressed by the hold.
 *
 * A **stale pin literal** (Story #110) — a platform-ref SHA/tag echoed in a
 * comment or `run:`/echo string that no longer matches the canonical `uses:`
 * pin — is a real configuration error like a split pin: it is **never**
 * suppressed by the `minimumReleaseAge` hold, because the literal lags the
 * consumer's OWN pin, not the platform release.
 *
 * @param {{ drift: boolean, splitPinned?: boolean }} verdict
 * @param {{ npmState: string }} npm
 * @param {boolean} surfaceSkew
 * @param {boolean} [holding]  Latest release is inside the minimumReleaseAge window.
 * @param {boolean} [hasStaleLiteral]  A platform-ref literal lags the canonical pin.
 * @returns {boolean}
 */
export function combineDrift(
  verdict,
  npm,
  surfaceSkew,
  holding = false,
  hasStaleLiteral = false,
) {
  // A stale pin literal is its own configuration error — never hold-suppressed.
  if (hasStaleLiteral) return true;
  const rawDrift =
    verdict.drift || npm.npmState === "lagging" || surfaceSkew;
  if (!rawDrift) return false;
  if (holding && !verdict.splitPinned) {
    // The only deviation is lag/skew against a release younger than the hold
    // window — transient and expected. Not drift.
    return false;
  }
  return true;
}

/**
 * Decide whether a consumer's lag/skew is being SUPPRESSED by the
 * `minimumReleaseAge` hold (i.e. it would otherwise drift, but the latest
 * release is too young for Renovate to have bumped it yet). Drives the
 * `holding` status in the dashboard so the suppression is visible rather than
 * silent (Story #107). A split pin is never "holding" — it is a real error.
 *
 * @param {{ drift: boolean, splitPinned?: boolean }} verdict
 * @param {{ npmState: string }} npm
 * @param {boolean} surfaceSkew
 * @param {boolean} withinWindow  Latest release is inside the minimumReleaseAge window.
 * @returns {boolean}
 */
export function isHolding(verdict, npm, surfaceSkew, withinWindow) {
  if (!withinWindow || verdict.splitPinned) return false;
  const wouldDrift =
    verdict.drift || npm.npmState === "lagging" || surfaceSkew;
  return wouldDrift;
}

/**
 * Render the human-readable dashboard report.
 *
 * @param {{
 *   platformRepo: string,
 *   latestRelease: { tag: string | null, sha: string | null, publishedAt?: string | null },
 *   releaseAge?: { windowMs: number | null, withinWindow: boolean },
 *   results: Array<{
 *     name: string,
 *     repo: string,
 *     branch: string,
 *     error?: string,
 *     pins: Array<{ file: string, line: number, target: string, ref: string | null }>,
 *     verdict: ReturnType<typeof classifyConsumer>,
 *     npm?: ReturnType<typeof classifyNpmPin>,
 *     surfaceSkew?: boolean,
 *     holding?: boolean,
 *     drift?: boolean,
 *   }>,
 * }} report
 * @returns {string}
 */
export function renderReport(report) {
  const { platformRepo, latestRelease, results } = report;
  const releaseAge = report.releaseAge ?? { windowMs: null, withinWindow: false };
  const latestVersion = parseSemver(latestRelease.tag);
  const out = [];
  out.push("## Cross-consumer pin-drift dashboard");
  out.push("");
  out.push(`Platform: \`${platformRepo}\``);
  const relLabel =
    latestRelease.tag && latestRelease.sha
      ? `\`${latestRelease.tag}\` (\`${latestRelease.sha.slice(0, 7)}\`)`
      : "unknown";
  out.push(`Latest release: ${relLabel}`);
  if (releaseAge.withinWindow) {
    out.push("");
    out.push(
      "> ⏳ **Renovate `minimumReleaseAge` hold active.** The latest release is " +
        "younger than the supply-chain hold window, so consumers that lag it by " +
        "one release are **expected** — Renovate has not raised the bump PR yet. " +
        "These are reported as `holding`, not drift.",
    );
  }
  out.push("");
  out.push("| Consumer | Pins | uses SHA | uses lag | npm pin | npm lag | Status |");
  out.push("| -------- | ---- | -------- | -------- | ------- | ------- | ------ |");

  const driftLines = [];
  const holdingLines = [];
  for (const r of results) {
    if (r.error) {
      out.push(`| \`${r.name}\` | — | — | — | — | — | ⚠️ error |`);
      driftLines.push(`- \`${r.name}\` (${r.repo}): error — ${r.error}`);
      continue;
    }
    const v = r.verdict;
    const npm = r.npm ?? { rawSpec: null, version: null, npmState: "absent" };
    const surfaceSkew = r.surfaceSkew === true;
    const holding = r.holding === true;
    const staleLiterals = Array.isArray(r.staleLiterals) ? r.staleLiterals : [];
    const hasStaleLiteral = r.hasStaleLiteral === true;
    const shaLabel = v.pinnedSha
      ? `\`${v.pinnedSha.slice(0, 7)}\``
      : v.splitPinned
        ? `split (${v.distinctRefs.length})`
        : v.floatingRefs.length > 0
          ? v.floatingRefs.map((f) => `\`@${f}\``).join(", ")
          : "—";
    const lagLabel =
      v.lagState === "current"
        ? "current"
        : v.lagState === "lagging"
          ? "lagging"
          : v.lagState === "no-pins"
            ? "no pins"
            : "unknown";
    const npmLabel = npm.version
      ? `\`${npm.version}\``
      : npm.rawSpec
        ? `\`${npm.rawSpec}\``
        : "—";
    const npmLagLabel = npm.npmState === "absent" ? "—" : npm.npmState;
    let status;
    if (
      v.lagState === "no-pins" &&
      npm.npmState === "absent" &&
      !hasStaleLiteral
    )
      status = "➖ no platform refs";
    else if (v.splitPinned) status = "❌ split pin";
    else if (hasStaleLiteral) status = "❌ stale pin literal";
    else if (holding) status = "⏳ holding";
    else if (surfaceSkew) status = "❌ npm/uses skew";
    else if (v.lagState === "lagging" || npm.npmState === "lagging")
      status = "⚠️ lagging";
    else if (
      (v.lagState === "current" || v.lagState === "no-pins") &&
      (npm.npmState === "current" || npm.npmState === "absent")
    )
      status = "✅ current";
    else status = "❔ unknown";
    out.push(
      `| \`${r.name}\` | ${v.pinCount} | ${shaLabel} | ${lagLabel} | ${npmLabel} | ${npmLagLabel} | ${status} |`,
    );

    // A held consumer's lag/skew is suppressed by the minimumReleaseAge window
    // (Story #107): record it under "holding" (informational), never "drift".
    if (holding) {
      holdingLines.push(
        `- \`${r.name}\` (${r.repo}): HOLDING — lags the latest release, but it is younger than the \`minimumReleaseAge\` hold window. Renovate has not raised the bump PR yet; this is expected, not drift.`,
      );
      continue;
    }

    if (v.splitPinned) {
      const refList = v.distinctRefs
        .map((ref) => {
          const where = r.pins
            .filter((p) => p.ref === ref)
            .map((p) => `${p.file}:${p.line}`)
            .join(", ");
          const short = isFullSha(ref) ? ref.slice(0, 7) : ref;
          return `    - \`${short}\` ← ${where}`;
        })
        .join("\n");
      driftLines.push(
        `- \`${r.name}\` (${r.repo}): SPLIT PIN — ${v.distinctRefs.length} distinct platform refs across chains:\n${refList}`,
      );
    } else if (v.lagState === "lagging") {
      driftLines.push(
        `- \`${r.name}\` (${r.repo}): LAGGING — pins \`${v.pinnedSha.slice(0, 7)}\`, latest release is \`${(latestRelease.sha || "?").slice(0, 7)}\` (${latestRelease.tag || "?"}).`,
      );
    }

    if (hasStaleLiteral) {
      const litList = staleLiterals
        .map((lit) => {
          const short = isFullSha(lit.ref) ? lit.ref.slice(0, 7) : lit.ref;
          const why =
            lit.reason === "orphan"
              ? "no canonical `uses:` pin to track"
              : "does not match the canonical `uses:` pin";
          return `    - \`${short}\` ← ${lit.file}:${lit.line} (${lit.kind}; ${why})`;
        })
        .join("\n");
      driftLines.push(
        `- \`${r.name}\` (${r.repo}): STALE PIN LITERAL — ${staleLiterals.length} platform-ref literal(s) outside \`uses:\` (comment / \`run:\` / echo string) drift from the canonical pin:\n${litList}`,
      );
    }

    if (surfaceSkew) {
      driftLines.push(
        `- \`${r.name}\` (${r.repo}): SURFACE SKEW — workflow \`uses:\` pins are ${lagLabel} but the npm \`mandrel-platform\` dependency (\`${npm.version ?? npm.rawSpec}\`) is ${npm.npmState}. The npm config package and the workflow pins are on different releases.`,
      );
    } else if (npm.npmState === "lagging") {
      driftLines.push(
        `- \`${r.name}\` (${r.repo}): NPM LAGGING — depends on \`mandrel-platform@${npm.version}\`, latest release is \`${latestVersion ?? "?"}\` (${latestRelease.tag || "?"}).`,
      );
    }
  }

  out.push("");
  if (driftLines.length > 0) {
    out.push("### Drift detected");
    out.push("");
    out.push(...driftLines);
  } else {
    out.push("### ✅ No drift");
    out.push("");
    out.push(
      "Every consumer pins a single platform SHA on the latest release, and its npm `mandrel-platform` dependency is on the matching version.",
    );
  }

  if (holdingLines.length > 0) {
    out.push("");
    out.push("### ⏳ Holding (minimumReleaseAge)");
    out.push("");
    out.push(
      "These consumers lag the latest release but it is younger than the " +
        "`minimumReleaseAge` hold window — Renovate has not bumped them yet. " +
        "Expected, not drift; they should converge once the hold expires.",
    );
    out.push("");
    out.push(...holdingLines);
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub access — the injectable `gh` seam lives in scripts/lib/gh-json.mjs
// (Story #198). `ghApiJson` surfaces the HTTP status on any error; the
// per-consumer fetchers below swallow ONLY a 404 into an "absent" sentinel and
// rethrow every other error so the strict gate fails CLOSED.
// ---------------------------------------------------------------------------

/**
 * Resolve the latest platform release tag, the commit SHA that tag points at,
 * and the release `published_at` timestamp (used to evaluate the
 * `minimumReleaseAge` hold window — Story #107). Falls back gracefully to
 * { tag: null, sha: null, publishedAt: null } when the platform has no
 * published release.
 *
 * @param {string} platformRepo
 * @param {(args: string[]) => string} runGh
 * @returns {{ tag: string | null, sha: string | null, publishedAt: string | null }}
 */
export function resolveLatestRelease(platformRepo, runGh) {
  let release;
  try {
    release = ghApiJson(`repos/${platformRepo}/releases/latest`, runGh);
  } catch (err) {
    // A genuine 404 means the platform repo has no published release yet — a
    // legitimate "no lag baseline" state, so return nulls. Every other error
    // (5xx / 403 rate-limit / transport) must propagate so the strict gate
    // fails CLOSED rather than silently classifying the whole fleet as
    // lagState "unknown" (drift=false). Mirrors the per-consumer fetchers'
    // fail-closed contract in scripts/lib/gh-json.mjs.
    if (isNotFound(err)) return { tag: null, sha: null, publishedAt: null };
    throw err;
  }
  const tag = release && typeof release.tag_name === "string" ? release.tag_name : null;
  const publishedAt =
    release && typeof release.published_at === "string"
      ? release.published_at
      : null;
  if (!tag) return { tag: null, sha: null, publishedAt };
  // Resolve the tag to its commit SHA. Tags may be lightweight (object is the
  // commit) or annotated (object is the tag, deref to .object.sha).
  try {
    const refObj = ghApiJson(
      `repos/${platformRepo}/git/ref/tags/${encodeURIComponent(tag)}`,
      runGh,
    );
    let sha = refObj?.object?.sha ?? null;
    if (refObj?.object?.type === "tag" && sha) {
      const tagObj = ghApiJson(`repos/${platformRepo}/git/tags/${sha}`, runGh);
      sha = tagObj?.object?.sha ?? sha;
    }
    return { tag, sha: sha ? sha.toLowerCase() : null, publishedAt };
  } catch (err) {
    // Same fail-closed contract as the release fetch above: a 404 (tag
    // vanished) degrades to sha:null, but a transient/auth error propagates
    // so the strict gate fails closed instead of suppressing lag detection.
    if (isNotFound(err)) return { tag, sha: null, publishedAt };
    throw err;
  }
}

/**
 * Recursively list workflow files in a consumer's `.github/workflows/` dir and
 * return [{ path, text }]. Uses the git trees API to enumerate, then the
 * contents API to fetch each file. Returns [] when the dir is absent.
 *
 * @param {string} repo    "owner/name".
 * @param {string} branch  Branch / ref to read.
 * @param {(args: string[]) => string} runGh
 * @returns {Array<{ path: string, text: string }>}
 */
export function fetchConsumerWorkflows(repo, branch, runGh) {
  let listing;
  try {
    listing = ghApiJson(
      `repos/${repo}/contents/.github/workflows?ref=${encodeURIComponent(branch)}`,
      runGh,
    );
  } catch (err) {
    // A 404 genuinely means the consumer has no `.github/workflows/` dir —
    // return "no files". Any OTHER error (403 / 429 / 5xx / transport) must
    // fail CLOSED: rethrow so buildReport records an `error` row for this
    // consumer instead of silently reading it as "no pins → no drift".
    if (isNotFound(err)) return [];
    throw err;
  }
  if (!Array.isArray(listing)) return [];
  const files = [];
  for (const entry of listing) {
    if (entry.type !== "file" || !/\.ya?ml$/i.test(entry.name)) continue;
    // entry.content is base64 for the contents endpoint, but the dir listing
    // omits it — fetch the blob via its git sha for an explicit decode.
    let text = "";
    if (typeof entry.content === "string" && entry.encoding === "base64") {
      text = Buffer.from(entry.content, "base64").toString("utf-8");
    } else {
      try {
        const blob = ghApiJson(`repos/${repo}/git/blobs/${entry.sha}`, runGh);
        if (blob?.encoding === "base64" && typeof blob.content === "string") {
          text = Buffer.from(blob.content, "base64").toString("utf-8");
        }
      } catch (err) {
        // Same fail-closed rule for the per-file blob fetch: a missing blob
        // (404) yields empty text; any other failure propagates.
        if (!isNotFound(err)) throw err;
        text = "";
      }
    }
    files.push({ path: `.github/workflows/${entry.name}`, text });
  }
  return files;
}

/**
 * Fetch a consumer's root `package.json` text over the GitHub contents API.
 * Returns null when the file is absent or unreadable (a consumer that adopts
 * the platform workflows but not the npm config package legitimately has no
 * `mandrel-platform` dependency). The existing `Contents: read` token scope
 * already covers this — no additional permission is required.
 *
 * @param {string} repo    "owner/name".
 * @param {string} branch  Branch / ref to read.
 * @param {(args: string[]) => string} runGh
 * @returns {string | null}
 */
export function fetchConsumerPackageJson(repo, branch, runGh) {
  let obj;
  try {
    obj = ghApiJson(
      `repos/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`,
      runGh,
    );
  } catch (err) {
    // A 404 is the legitimate "no package.json / doesn't adopt the npm config
    // package" case → treat as absent (null). Any OTHER error must fail
    // CLOSED: rethrow so buildReport records an `error` row rather than
    // silently reading the consumer as "npm absent → no drift".
    if (isNotFound(err)) return null;
    throw err;
  }
  if (obj && obj.encoding === "base64" && typeof obj.content === "string") {
    return Buffer.from(obj.content, "base64").toString("utf-8");
  }
  return null;
}

/**
 * Resolve a consumer's effective branch: the entry's `branch` if set, else the
 * repo's default branch.
 *
 * @param {{ repo: string, branch?: string }} consumer
 * @param {(args: string[]) => string} runGh
 * @returns {string}
 */
export function resolveBranch(consumer, runGh) {
  if (consumer.branch) return consumer.branch;
  try {
    const repoMeta = ghApiJson(`repos/${consumer.repo}`, runGh);
    return repoMeta?.default_branch || "main";
  } catch (err) {
    // A 404 means the repo (or our access to it) is genuinely gone — fall back
    // to "main" as before. Any OTHER error (403 / 429 / 5xx / transport) must
    // fail CLOSED: rethrow so buildReport records an `error` row instead of
    // guessing a branch and silently reporting "no drift".
    if (isNotFound(err)) return "main";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the full drift report for the configured consumers.
 *
 * @param {{
 *   platformRepo: string,
 *   consumers: Array<{ name: string, repo: string, branch?: string }>,
 *   minimumReleaseAge?: string | number,
 * }} config
 * @param {(args: string[]) => string} runGh
 * @param {number} [nowMs]  Injectable current epoch ms (for tests).
 * @returns {ReturnType<typeof renderReport> extends string ? object : never}
 */
export function buildReport(config, runGh, nowMs = Date.now()) {
  const platformRepo = config.platformRepo;
  const platformPkg = config.platformPackage || "mandrel-platform";
  const latestRelease = resolveLatestRelease(platformRepo, runGh);
  const latestVersion = parseSemver(latestRelease.tag);
  // The hold window defaults to the shared Renovate preset's `3 days`
  // (default.json) so the dashboard's notion of "transient" matches the gate
  // that actually defers the bump. Overridable per-config.
  const windowMs = parseDurationMs(config.minimumReleaseAge ?? "3 days");
  const withinWindow = isWithinReleaseAgeWindow(
    latestRelease.publishedAt,
    windowMs,
    nowMs,
  );
  const results = [];
  for (const consumer of config.consumers) {
    try {
      const branch = resolveBranch(consumer, runGh);
      const files = fetchConsumerWorkflows(consumer.repo, branch, runGh);
      const pins = [];
      const looseLiterals = [];
      for (const f of files) {
        pins.push(...extractPlatformPins(f.path, f.text, platformRepo));
        looseLiterals.push(
          ...extractStaleLiterals(f.path, f.text, platformRepo),
        );
      }
      const verdict = classifyConsumer(pins, latestRelease.sha);
      const literalVerdict = classifyStaleLiterals(
        looseLiterals,
        verdict.distinctRefs,
      );
      const pkgText = fetchConsumerPackageJson(consumer.repo, branch, runGh);
      const npmSpec =
        pkgText === null ? null : extractNpmPlatformVersion(pkgText, platformPkg);
      const npm = classifyNpmPin(npmSpec, latestVersion);
      const surfaceSkew = detectSurfaceSkew(verdict.lagState, npm.npmState);
      // A stale literal is a real error, so a consumer carrying one is never
      // "holding" — surface it as drift even inside the release-age window.
      const holding =
        !literalVerdict.hasStaleLiteral &&
        isHolding(verdict, npm, surfaceSkew, withinWindow);
      results.push({
        name: consumer.name,
        repo: consumer.repo,
        branch,
        pins,
        verdict,
        npm,
        surfaceSkew,
        staleLiterals: literalVerdict.staleLiterals,
        hasStaleLiteral: literalVerdict.hasStaleLiteral,
        holding,
        drift: combineDrift(
          verdict,
          npm,
          surfaceSkew,
          withinWindow,
          literalVerdict.hasStaleLiteral,
        ),
      });
    } catch (err) {
      const verdict = classifyConsumer([], latestRelease.sha);
      const npm = classifyNpmPin(null, latestVersion);
      results.push({
        name: consumer.name,
        repo: consumer.repo,
        branch: consumer.branch || "?",
        error: err instanceof Error ? err.message : String(err),
        pins: [],
        verdict,
        npm,
        surfaceSkew: false,
        staleLiterals: [],
        hasStaleLiteral: false,
        holding: false,
        drift: false,
      });
    }
  }
  return {
    platformRepo,
    latestRelease,
    latestVersion,
    releaseAge: { windowMs, withinWindow },
    results,
  };
}

/**
 * @param {object} report
 * @returns {boolean} true when any consumer has drift or an error.
 */
export function hasDrift(report) {
  return report.results.some((r) => r.error || r.drift);
}

/**
 * Is EVERY configured consumer an `error` row (M11)? This is the signature of a
 * dead cross-repo credential: a PIN_DRIFT_TOKEN that was *provided* but has
 * expired (fine-grained PATs always expire) can no longer read ANY consumer, so
 * every `fetchConsumerWorkflows` call fails closed to an `error` row. Contrast
 * the not-yet-provisioned bootstrap case: there the token is *absent*, the run
 * legitimately can't read the private consumers, and that benign state must keep
 * its current exit-0 behavior. The caller distinguishes the two by whether the
 * token was provided (see `runCli`'s `tokenProvided`); this predicate only
 * answers "did every row error", which — given a provided token — means the
 * credential died rather than "no drift".
 *
 * Requires at least one consumer (an empty registry is vacuously not a
 * dead-credential signal).
 *
 * @param {{ results: Array<{ error?: string }> }} report
 * @returns {boolean}
 */
export function allConsumersErrored(report) {
  const results = Array.isArray(report.results) ? report.results : [];
  return results.length > 0 && results.every((r) => Boolean(r.error));
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/**
 * Whether the cross-repo `PIN_DRIFT_TOKEN` was PROVIDED (non-empty) to the run
 * (M11). The scheduled/dispatch workflow reads consumers over the `gh` CLI with
 * `GH_TOKEN: ${{ secrets.PIN_DRIFT_TOKEN || github.token }}` — the built-in
 * `github.token` fallback can only read THIS repo, so cross-repo reads fail
 * closed to `error` rows both when the token is absent (bootstrap) AND when it
 * is provided-but-dead (expired PAT). This env var is the only signal that
 * distinguishes the two: the workflow sets it to the raw secret so an empty
 * value ⇒ absent (bootstrap, benign) and a non-empty value ⇒ provided (a
 * total error sweep then means the credential died).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function pinDriftTokenProvided(env) {
  return typeof env.PIN_DRIFT_TOKEN === "string" && env.PIN_DRIFT_TOKEN.length > 0;
}

/**
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   env?: Record<string, string | undefined>,
 *   runGh?: (args: string[]) => string,
 *   summaryPath?: string | undefined,
 *   tokenProvided?: boolean,
 *   nowMs?: number,
 * }} [opts]
 * @returns {number} exit code
 */
export function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  runGh = defaultGhRunner,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  tokenProvided = pinDriftTokenProvided(env),
  nowMs = Date.now(),
} = {}) {
  const { config: configRel, json, strict } = parseArgv(argv);
  const configPath = resolve(cwd, configRel);

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    stderr.write(
      `[pin-drift] ❌ failed to read config ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (!config.platformRepo || !Array.isArray(config.consumers)) {
    stderr.write(
      `[pin-drift] ❌ config must define { platformRepo: string, consumers: [] }\n`,
    );
    return 1;
  }

  const report = buildReport(config, runGh, nowMs);
  const drift = hasDrift(report);
  // M11: a PROVIDED-but-dead PIN_DRIFT_TOKEN (expired PAT) can no longer read
  // ANY consumer, so every row fails closed to `error`. That is a credential
  // failure, NOT the benign not-yet-provisioned bootstrap (token absent) — fail
  // the run unconditionally (even without --strict, which the scheduled path
  // can never pass) so the death is loud instead of a green no-op. The absent-
  // token bootstrap keeps its current behavior: tokenProvided is false, so this
  // branch never fires and the run exits per the drift/--strict rules below.
  const deadCredential = tokenProvided && allConsumersErrored(report);

  if (json) {
    stdout.write(
      `${JSON.stringify({ kind: "pin-drift-report", drift, deadCredential, ...report }, null, 2)}\n`,
    );
  } else {
    const text = renderReport(report);
    stdout.write(`${text}\n`);
    if (summaryPath) {
      try {
        appendFileSync(summaryPath, `${text}\n`);
      } catch (err) {
        stderr.write(
          `[pin-drift] ⚠ could not write job summary: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  if (deadCredential) {
    stderr.write(
      "::error::[pin-drift] PIN_DRIFT_TOKEN was provided but every cross-repo " +
        "consumer read errored — the credential is dead (likely an expired " +
        "fine-grained PAT), not a not-yet-provisioned bootstrap. Rotate the " +
        "token. See docs/runbooks/pin-drift-dashboard.md.\n",
    );
    return 1;
  }

  if (strict && drift) {
    stderr.write(`[pin-drift] ❌ drift detected (--strict)\n`);
    return 1;
  }
  return 0;
}

// Direct-invocation guard (matches the repo's other scripts/*.mjs entry style).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  process.exit(runCli());
}
