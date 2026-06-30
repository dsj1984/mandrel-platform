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
 * with no automated drift detection (roadmap.md §4.2 / §4.3). This script is
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
import { execFileSync } from "node:child_process";

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
 * Extract a comparable `x.y.z` semver core from a release tag or version spec.
 * The platform tags releases as `mandrel-platform-v<semver>`; consumer specs
 * may carry a range prefix (`^0.11.3`, `~0.11.3`). Returns the dotted triple
 * or null when no numeric semver core is present (`workspace:*`, `latest`, a
 * git URL).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseSemver(value) {
  if (typeof value !== "string") return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/**
 * Compare two `x.y.z` semver cores. Returns -1 when a < b, 0 when equal, 1
 * when a > b. Inputs MUST already be normalized dotted triples (see
 * `parseSemver`).
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
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
 * @param {{ drift: boolean }} verdict
 * @param {{ npmState: string }} npm
 * @param {boolean} surfaceSkew
 * @returns {boolean}
 */
export function combineDrift(verdict, npm, surfaceSkew) {
  return verdict.drift || npm.npmState === "lagging" || surfaceSkew;
}

/**
 * Render the human-readable dashboard report.
 *
 * @param {{
 *   platformRepo: string,
 *   latestRelease: { tag: string | null, sha: string | null },
 *   results: Array<{
 *     name: string,
 *     repo: string,
 *     branch: string,
 *     error?: string,
 *     pins: Array<{ file: string, line: number, target: string, ref: string | null }>,
 *     verdict: ReturnType<typeof classifyConsumer>,
 *     npm?: ReturnType<typeof classifyNpmPin>,
 *     surfaceSkew?: boolean,
 *     drift?: boolean,
 *   }>,
 * }} report
 * @returns {string}
 */
export function renderReport(report) {
  const { platformRepo, latestRelease, results } = report;
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
  out.push("");
  out.push("| Consumer | Pins | uses SHA | uses lag | npm pin | npm lag | Status |");
  out.push("| -------- | ---- | -------- | -------- | ------- | ------- | ------ |");

  const driftLines = [];
  for (const r of results) {
    if (r.error) {
      out.push(`| \`${r.name}\` | — | — | — | — | — | ⚠️ error |`);
      driftLines.push(`- \`${r.name}\` (${r.repo}): error — ${r.error}`);
      continue;
    }
    const v = r.verdict;
    const npm = r.npm ?? { rawSpec: null, version: null, npmState: "absent" };
    const surfaceSkew = r.surfaceSkew === true;
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
    if (v.lagState === "no-pins" && npm.npmState === "absent")
      status = "➖ no platform refs";
    else if (v.splitPinned) status = "❌ split pin";
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
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub access (via gh CLI) — thin, injectable seam for testing
// ---------------------------------------------------------------------------

/**
 * Run `gh api <path>` and parse the JSON response.
 *
 * @param {string} apiPath  e.g. "repos/owner/repo/releases/latest".
 * @param {(args: string[]) => string} runGh  Injectable runner (default execFileSync gh).
 * @returns {unknown}
 */
function ghApiJson(apiPath, runGh) {
  const raw = runGh(["api", apiPath, "-H", "Accept: application/vnd.github+json"]);
  return JSON.parse(raw);
}

/**
 * Default gh runner — shells out to the `gh` CLI.
 * @param {string[]} args
 * @returns {string}
 */
export function defaultGhRunner(args) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Resolve the latest platform release tag + the commit SHA that tag points at.
 * Falls back gracefully to { tag: null, sha: null } when the platform has no
 * published release.
 *
 * @param {string} platformRepo
 * @param {(args: string[]) => string} runGh
 * @returns {{ tag: string | null, sha: string | null }}
 */
export function resolveLatestRelease(platformRepo, runGh) {
  let release;
  try {
    release = ghApiJson(`repos/${platformRepo}/releases/latest`, runGh);
  } catch {
    return { tag: null, sha: null };
  }
  const tag = release && typeof release.tag_name === "string" ? release.tag_name : null;
  if (!tag) return { tag: null, sha: null };
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
    return { tag, sha: sha ? sha.toLowerCase() : null };
  } catch {
    return { tag, sha: null };
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
  } catch {
    return [];
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
      } catch {
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
  } catch {
    return null;
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
  } catch {
    return "main";
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the full drift report for the configured consumers.
 *
 * @param {{ platformRepo: string, consumers: Array<{ name: string, repo: string, branch?: string }> }} config
 * @param {(args: string[]) => string} runGh
 * @returns {ReturnType<typeof renderReport> extends string ? object : never}
 */
export function buildReport(config, runGh) {
  const platformRepo = config.platformRepo;
  const platformPkg = config.platformPackage || "mandrel-platform";
  const latestRelease = resolveLatestRelease(platformRepo, runGh);
  const latestVersion = parseSemver(latestRelease.tag);
  const results = [];
  for (const consumer of config.consumers) {
    try {
      const branch = resolveBranch(consumer, runGh);
      const files = fetchConsumerWorkflows(consumer.repo, branch, runGh);
      const pins = [];
      for (const f of files) {
        pins.push(...extractPlatformPins(f.path, f.text, platformRepo));
      }
      const verdict = classifyConsumer(pins, latestRelease.sha);
      const pkgText = fetchConsumerPackageJson(consumer.repo, branch, runGh);
      const npmSpec =
        pkgText === null ? null : extractNpmPlatformVersion(pkgText, platformPkg);
      const npm = classifyNpmPin(npmSpec, latestVersion);
      const surfaceSkew = detectSurfaceSkew(verdict.lagState, npm.npmState);
      results.push({
        name: consumer.name,
        repo: consumer.repo,
        branch,
        pins,
        verdict,
        npm,
        surfaceSkew,
        drift: combineDrift(verdict, npm, surfaceSkew),
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
        drift: false,
      });
    }
  }
  return { platformRepo, latestRelease, latestVersion, results };
}

/**
 * @param {object} report
 * @returns {boolean} true when any consumer has drift or an error.
 */
export function hasDrift(report) {
  return report.results.some((r) => r.error || r.drift);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   runGh?: (args: string[]) => string,
 *   summaryPath?: string | undefined,
 * }} [opts]
 * @returns {number} exit code
 */
export function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  runGh = defaultGhRunner,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
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

  const report = buildReport(config, runGh);
  const drift = hasDrift(report);

  if (json) {
    stdout.write(`${JSON.stringify({ kind: "pin-drift-report", drift, ...report }, null, 2)}\n`);
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
