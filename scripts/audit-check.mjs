#!/usr/bin/env node
/**
 * audit-check.mjs
 *
 * CVE gate for the mandrel-platform npm package.
 *
 * Policy (athportal/swarm-os stricter variant):
 *   Block ALL unsuppressed High and Critical vulnerabilities in the
 *   production dependency graph. A self-expiring allowlist lets teams
 *   record known, accepted CVEs with a required expiry date — entries
 *   whose expiry has passed are treated as un-suppressed and will cause
 *   the script to exit non-zero.
 *
 * Package managers (Story #475):
 *   The audit runs under whichever manager the COMMITTED LOCKFILE names —
 *   `pnpm-lock.yaml` → pnpm, `package-lock.json` → npm — not what
 *   `packageManager` or `engines` declares, because the lockfile is what the
 *   audit reads and metadata can disagree with it. Neither lockfile, or both,
 *   is a loud configuration error: this gate's output is a claim about a
 *   specific dependency graph, and guessing which graph would make that claim
 *   unfalsifiable.
 *
 * Fail-closed contract:
 *   A report counts as clean only when its schema was POSITIVELY RECOGNIZED
 *   and found nothing blocking. A report that parsed but matches neither known
 *   schema fails the gate on ANY audit exit code, including zero.
 *
 *   That last clause is load-bearing. The two managers report differently — a
 *   legacy `advisories` map (pnpm / npm v6) versus npm v7+, which nests
 *   advisories under `vulnerabilities` — and the earlier contract passed an
 *   unrecognized report whenever the audit exited zero. Since `npm audit`
 *   exits zero when clean, that branch would have reported an npm graph clean
 *   without reading a single advisory, and kept doing so as highs landed.
 *
 * Unbounded-override lint (Story #365):
 *   A dependency override REWRITES a transitive dependent's declared range.
 *   Written as a bare lower bound (`">=1.2.3"`, `"*"`, `"x.x.x"`) or as a
 *   non-registry specifier (`"github:owner/repo"`, `"workspace:*"`) it is
 *   open-ended, so
 *   the committed lockfile becomes the only pin and any fresh resolution
 *   re-picks the newest release — which can cross a major. Nothing else in the
 *   toolchain lints for that, so this gate names each such override and its
 *   bound before it runs the audit.
 *
 * Usage:
 *   node scripts/audit-check.mjs
 *   node scripts/audit-check.mjs --allowlist path/to/allowlist.json
 *   node scripts/audit-check.mjs --package-json path/to/package.json
 *
 * Exit codes:
 *   0 — no blocking vulnerabilities (all High/Critical suppressed with
 *       valid, non-expired allowlist entries, or none found) and every
 *       dependency override carries an upper bound
 *   1 — one or more unsuppressed High/Critical CVEs, expired allowlist
 *       entries were encountered, an override was unbounded, the package
 *       manager could not be determined from a lockfile, or the audit report
 *       matched no known schema
 *
 * Allowlist format (JSON):
 *   [
 *     {
 *       "id": "GHSA-xxxx-xxxx-xxxx",  // GitHub Advisory ID or CVE ID
 *       "reason": "No fix available; mitigated by X",
 *       "expires": "2026-12-31"        // REQUIRED — strictly YYYY-MM-DD
 *     }
 *   ]
 *
 * `expires` is validated, not merely read: it must be exactly `YYYY-MM-DD` and
 * a real calendar date. Anything else (a `<YYYY-MM-DD>` placeholder, a
 * `12/31/2026`, an impossible `2026-02-30`) is a hard configuration error that
 * exits 1 — it is NEVER treated as a distant future date, which would suppress
 * the advisory forever.
 *
 * The allowlist file path defaults to `audit-allowlist.json` in the
 * directory from which this script is invoked (i.e. the project root).
 * Override with `--allowlist <path>`.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Pure core (unit-testable — no process.exit, no filesystem, no child process)
// ---------------------------------------------------------------------------

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/**
 * @typedef {{ id: string; reason?: string; expires: string }} AllowlistEntry
 */

/**
 * Strictly parse a `YYYY-MM-DD` calendar date, returning UTC midnight in ms —
 * or `null` when the value is not exactly that.
 *
 * Deliberately strict, because this validates a *config field* that decides
 * whether a High/Critical CVE stays suppressed. Anything unparseable must be
 * rejected outright rather than coerced, so:
 *
 *   - The regex is anchored. A value that merely CONTAINS a date is not a date,
 *     which is what rejects `<YYYY-MM-DD>`, `expires 2026-01-01`, `12/31/2026`
 *     and `2026-01-01T00:00:00Z`.
 *   - The result is round-tripped. `Date.UTC` silently rolls overflow over
 *     (`2026-13-45` → 2027-01-14, `2026-02-30` → 2026-03-02) and never returns
 *     NaN for it, so comparing the parsed instant's calendar fields back
 *     against the input is the only way to reject an impossible date.
 *
 * One consequence of the round-trip, noted rather than worked around: years
 * 0–99 are rejected, because `Date.UTC` maps them into 1900–1999 (legacy
 * two-digit-year behaviour) and so fail the comparison. No real expiry lands
 * there, and rejecting is the fail-closed direction.
 *
 * @param {unknown} value
 * @returns {number|null} UTC ms at midnight, or null when not a valid date
 */
export function parseIsoDateUtc(value) {
  if (typeof value !== "string") {
    return null;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    return null;
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);

  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }

  return ms;
}

/**
 * Partition allowlist entries into the active (non-expired) suppression set
 * and the list of expired entries, relative to `today` (a `YYYY-MM-DD`
 * string).
 *
 * Entries that are unusable — missing/non-string `id`, or an `expires` that is
 * not a valid `YYYY-MM-DD` calendar date — are surfaced in `invalid` with the
 * specific `problem`, so the caller can fail closed and name what is wrong.
 * Treating `expires` as an opaque string was a fail-OPEN: the comparison was
 * lexicographic, and every non-date value a caller might plausibly write
 * (`<YYYY-MM-DD>` copy-pasted from the runbook, `not-a-date`, a typo) sorts
 * ABOVE a real `20xx-..-..` date and so read as "not yet expired" — turning a
 * malformed field into a permanent, silent CVE suppression.
 *
 * @param {AllowlistEntry[]} allowlist
 * @param {string} today `YYYY-MM-DD`
 * @returns {{ suppressed: Set<string>; expired: AllowlistEntry[]; invalid: Array<{ entry: unknown; problem: string }> }}
 */
export function partitionAllowlist(allowlist, today) {
  /** @type {Set<string>} */
  const suppressed = new Set();
  /** @type {AllowlistEntry[]} */
  const expired = [];
  /** @type {Array<{ entry: unknown; problem: string }>} */
  const invalid = [];

  const todayMs = parseIsoDateUtc(today);
  if (todayMs === null) {
    // Caller bug, not user data: `today` is derived from the system clock via
    // toISOString(). Throwing beats any fallback, both of which would silently
    // mis-classify every entry.
    throw new Error(
      `partitionAllowlist: "today" must be a YYYY-MM-DD date, got ${JSON.stringify(today)}.`,
    );
  }

  for (const entry of allowlist) {
    if (!entry || typeof entry !== "object") {
      invalid.push({ entry, problem: "entry is not an object" });
      continue;
    }

    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      invalid.push({ entry, problem: 'missing or non-string "id"' });
      continue;
    }

    const expiresMs = parseIsoDateUtc(entry.expires);
    if (expiresMs === null) {
      invalid.push({
        entry,
        problem:
          entry.expires === undefined || entry.expires === null
            ? 'missing required "expires"'
            : `"expires" is not a valid YYYY-MM-DD date: ${JSON.stringify(entry.expires)}`,
      });
      continue;
    }

    if (expiresMs < todayMs) {
      expired.push(entry);
    } else {
      suppressed.add(entry.id);
    }
  }

  return { suppressed, expired, invalid };
}

/**
 * Fields a package.json can express dependency overrides through. All three
 * are checked, because a repo that has migrated package managers routinely
 * carries more than one and an unbounded bound is equally open-ended in any
 * of them.
 */
const OVERRIDE_FIELDS = ["overrides", "resolutions", "pnpm.overrides"];

/**
 * Specifier prefixes that are not registry semver ranges at all: a git ref, a
 * workspace sibling, a local path, a tarball URL. Each re-resolves to whatever
 * that source holds at install time — `github:owner/repo` tracks the default
 * branch, `workspace:*` tracks the sibling's current version — so none of them
 * expresses an upper bound and none can be judged bounded. Before Story #375
 * they all fell through to the catch-all and were reported bounded.
 */
const NON_SEMVER_PROTOCOLS = [
  "bitbucket:",
  "file:",
  "gist:",
  "git+",
  "git:",
  "github:",
  "gitlab:",
  "http:",
  "https:",
  "link:",
  "portal:",
  "workspace:",
];

/**
 * Is `value` a wildcard that pins nothing — `*`, a dist-tag, or a dotted
 * wildcard such as `x.x.x`, `x.x` or `*.*.*`?
 *
 * The MAJOR position is the whole test, because npm reads `x.x.x` and `x.x` as
 * exactly `*` (any version). A wildcard below the major — `1.2.x`, `1.*` —
 * stays inside major 1 and is genuinely bounded, so only a wildcard in the
 * first position is open-ended. Story #375: the enumerated regex this replaces
 * listed `*`, `x` and `*.*.*` but not the dotted `x` forms, which is how the
 * exact shape the lint exists to catch read as bounded.
 *
 * Deliberately answers for a SINGLE bare token only. A compound range spells
 * its own upper bound out (`x.x <2.0.0`, `x.x.x - 2.0.0`) and is judged on
 * that by the caller; reading the first dot-segment of the whole string would
 * call such a range unbounded purely on its lower end.
 *
 * @param {string} value trimmed specifier
 * @returns {boolean}
 */
function isWildcardSpec(value) {
  if (/\s/.test(value)) {
    return false;
  }

  if (/^(latest|next)$/i.test(value)) {
    return true;
  }

  return /^[*xX]$/.test(value.split(".")[0]);
}

/**
 * Strip a leading range operator from a single bare token.
 *
 * `isWildcardSpec` reads the major position, which a leading operator shifts
 * out of view: `^x.x.x` splits to `^x`, matches nothing, and reads as a real
 * version. An operator applied to "any version" is still any version, so the
 * operator has to come off before the major position can be judged.
 *
 * @param {string} term single bare token
 * @returns {string}
 */
function stripRangeOperator(term) {
  return term.replace(/^(?:[<>]=?|[\^~=])+/, "");
}

/**
 * Does this single bare token carry a real upper bound?
 *
 * A wildcard pins nothing, and a bare lower bound (`>=1.0.0`) is open above by
 * construction. Anything else — an exact pin, a caret/tilde range, an `x`-style
 * partial with a fixed major, an explicit `<` cap — closes the range.
 *
 * @param {string} term single bare token
 * @returns {boolean}
 */
function termCarriesUpperBound(term) {
  if (isWildcardSpec(stripRangeOperator(term))) {
    return false;
  }

  return !/^>=?/.test(term);
}

/**
 * Is this override specifier bounded above?
 *
 * An override REWRITES a transitive dependent's declared range, so whatever is
 * written here is the only thing standing between the tree and the next
 * release of that package. A bare lower bound (`>=1.2.3`, `>1.2.3`, `*`,
 * `x.x.x`, `latest`) leaves the committed lockfile as the sole pin: the moment
 * anything re-resolves — a fresh install, a lockfile-less CI leg, a
 * dependent's own bump — the newest release wins and can cross a major. That
 * is how a major jump silently emptied a consumer's test suite.
 *
 * Bounded means the specifier can never cross a major on its own: an exact
 * pin, a caret/tilde range, an `x`-style partial whose major is fixed
 * (`1.2.x`), or a compound range carrying an explicit upper bound
 * (`>=1.2.3 <2`).
 *
 * @param {string} spec
 * @returns {boolean}
 */
export function isBoundedOverride(spec) {
  if (typeof spec !== "string") {
    return false;
  }

  const value = spec.trim();
  if (value === "") {
    return false;
  }

  // `npm:other-pkg@<range>` and `pkg@<range>` alias forms are judged on the
  // range they carry, not on the alias target.
  if (value.startsWith("npm:")) {
    const aliasMatch = /^npm:(?:@[^/]+\/)?[^@\s]+@(.+)$/.exec(value);
    return aliasMatch ? isBoundedOverride(aliasMatch[1]) : false;
  }

  // A non-registry specifier resolves outside semver entirely. Only the
  // explicit `#semver:<range>` fragment a git URL may carry is a real range,
  // and it is judged on its own merits exactly as an `npm:` alias is.
  const lower = value.toLowerCase();
  if (NON_SEMVER_PROTOCOLS.some((protocol) => lower.startsWith(protocol))) {
    const semverFragment = /#semver:(.+)$/.exec(value);
    return semverFragment ? isBoundedOverride(semverFragment[1]) : false;
  }

  // A `||` union is only as bounded as its loosest arm.
  if (value.includes("||")) {
    return value.split("||").every((arm) => isBoundedOverride(arm));
  }

  // Wildcards and dist-tags pin nothing at all — including behind a leading
  // range operator, which shifts the major position out of view.
  if (isWildcardSpec(stripRangeOperator(value))) {
    return false;
  }

  // A hyphen range is bounded by its right-hand side alone: `x.x.x - 2.0.0`
  // caps at 2.0.0 however loose its lower end is, and `x.x - x.x` caps at
  // nothing however much it is spelled like a range.
  //
  // A real hyphen range takes plain versions on both sides. A comparator on
  // either end (`>=1.0.0 - 2.0.0`) is malformed, so reading its right-hand
  // side as the cap would answer a range npm never agreed to parse — that one
  // is left to the compound logic below, which keeps failing closed on it.
  const hyphenRange = /^(.+?)\s+-\s+(.+)$/.exec(value);
  if (hyphenRange) {
    const lowerEnd = hyphenRange[1].trim();
    const upperEnd = hyphenRange[2].trim();
    if (!/^[<>]/.test(lowerEnd) && !/^[<>]/.test(upperEnd)) {
      return termCarriesUpperBound(upperEnd);
    }
  }

  // An explicit upper bound anywhere in a space-separated compound closes it.
  if (/[<]/.test(value)) {
    return true;
  }

  // Otherwise a compound is only as bounded as its terms: when every one of
  // them is a wildcard or a bare lower bound, nothing caps the range and the
  // range-like spelling is the only thing suggesting otherwise.
  if (/\s/.test(value) && !value.split(/\s+/).some(termCarriesUpperBound)) {
    return false;
  }

  // A bare lower bound is the unbounded shape this check exists to name.
  if (/^[>]=?/.test(value)) {
    return false;
  }

  return true;
}

/**
 * Report every override in `pkgJson` expressed as an unbounded lower bound.
 *
 * Pure and package-manager agnostic: the caller supplies the parsed
 * package.json, so this is unit-testable without a fixture tree.
 *
 * @param {unknown} pkgJson parsed package.json
 * @returns {Array<{ field: string; package: string; bound: string }>}
 */
export function findUnboundedOverrides(pkgJson) {
  /** @type {Array<{ field: string; package: string; bound: string }>} */
  const findings = [];

  if (pkgJson === null || typeof pkgJson !== "object") {
    return findings;
  }

  for (const field of OVERRIDE_FIELDS) {
    /** @type {unknown} */
    let node = pkgJson;
    for (const segment of field.split(".")) {
      node =
        node !== null && typeof node === "object"
          ? /** @type {Record<string, unknown>} */ (node)[segment]
          : undefined;
    }

    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      continue;
    }

    for (const [name, spec] of Object.entries(
      /** @type {Record<string, unknown>} */ (node),
    )) {
      // A nested override object scopes a bound to one dependent; recurse so a
      // nested unbounded bound is named too, keyed by its full path.
      if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
        for (const nested of findUnboundedOverrides({ overrides: spec })) {
          findings.push({
            field,
            package: `${name}.${nested.package}`,
            bound: nested.bound,
          });
        }
        continue;
      }

      const bound = typeof spec === "string" ? spec : String(spec);
      if (!isBoundedOverride(bound)) {
        findings.push({ field, package: name, bound });
      }
    }
  }

  return findings;
}

/**
 * Lockfiles this gate knows how to audit, in the order they are probed.
 *
 * The lockfile — not `packageManager`, not `engines` — is the discriminator,
 * because it is the thing the audit actually reads. A repo can declare one
 * manager in metadata and commit the other's lockfile (this one does), and it
 * is the lockfile that decides whether an audit can run at all.
 */
const LOCKFILES = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "package-lock.json", manager: "npm" },
];

/**
 * Resolve which package manager's audit to run for the project rooted at
 * `projectDir`.
 *
 * Returns `{ manager }` on a clean read, or `{ error }` naming what is wrong.
 * Both ambiguity (two lockfiles) and absence (none) are errors rather than a
 * best guess: this gate's whole output is a claim about a specific dependency
 * graph, and guessing which graph would make that claim unfalsifiable.
 *
 * `existsSyncImpl` is injectable so the decision is unit-testable without
 * materializing a fixture tree per case.
 *
 * @param {string} projectDir directory holding the audited package.json
 * @param {{ existsSyncImpl?: (p: string) => boolean }} [deps]
 * @returns {{ manager: "pnpm" | "npm"; error?: undefined } | { manager?: undefined; error: string }}
 */
export function detectPackageManager(projectDir, { existsSyncImpl = existsSync } = {}) {
  const found = LOCKFILES.filter(({ file }) =>
    existsSyncImpl(resolve(projectDir, file)),
  );

  if (found.length === 1) {
    return { manager: /** @type {"pnpm" | "npm"} */ (found[0].manager) };
  }

  if (found.length === 0) {
    return {
      error:
        `No lockfile found in ${projectDir}. Expected one of: ` +
        `${LOCKFILES.map(({ file }) => file).join(", ")}. The audit reads the ` +
        `lockfile, so without one there is no dependency graph to prove.`,
    };
  }

  return {
    error:
      `Ambiguous lockfiles in ${projectDir}: ${found.map(({ file }) => file).join(" and ")}. ` +
      `Remove the one that is not authoritative — this gate will not guess ` +
      `which dependency graph its verdict is about.`,
  };
}

/**
 * The GHSA id embedded in an advisory URL, or `null`.
 *
 * npm's report never exposes a bare `ghsa_id`; the only place the id appears
 * is the advisory `url` (`https://github.com/advisories/GHSA-xxxx-xxxx-xxxx`),
 * and the allowlist matches on that id. The URL is parsed and its LAST PATH
 * SEGMENT tested against an anchored literal — never pattern-matched as a
 * whole string, which would match a GHSA-shaped substring anywhere in a
 * caller-controlled URL, host included.
 *
 * @param {unknown} url
 * @returns {string|null}
 */
export function ghsaIdFromUrl(url) {
  if (typeof url !== "string" || url === "") {
    return null;
  }

  let segment;
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    segment = segments[segments.length - 1];
  } catch {
    return null;
  }

  if (typeof segment !== "string") {
    return null;
  }

  return /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i.test(segment)
    ? segment.toUpperCase()
    : null;
}

/**
 * @typedef {{ ids: string[]; severity: string; title: string; url: string }} NormalizedAdvisory
 */

/**
 * Normalize the legacy (npm v6 / pnpm) `advisories` map.
 *
 * @param {Record<string, unknown>} report
 * @returns {NormalizedAdvisory[]}
 */
function normalizeLegacyReport(report) {
  /** @type {NormalizedAdvisory[]} */
  const out = [];
  const advisories = /** @type {Record<string, unknown>} */ (report.advisories);

  for (const advisory of Object.values(advisories)) {
    if (advisory === null || typeof advisory !== "object" || !("severity" in advisory)) {
      continue;
    }
    const adv = /** @type {Record<string, unknown>} */ (advisory);
    const ghsaId = String(adv["ghsa_id"] ?? "");
    const cveIds = Array.isArray(adv["cve"]) ? adv["cve"].map((c) => String(c)) : [];

    out.push({
      ids: [ghsaId, ...cveIds].filter(Boolean),
      severity: String(adv["severity"] ?? "").toLowerCase(),
      title: String(adv["title"] ?? "(no title)"),
      url: String(adv["url"] ?? ""),
    });
  }

  return out;
}

/**
 * Normalize an npm v7+ (`auditReportVersion` 2) report.
 *
 * Advisories are not a top-level map here: they are nested in
 * `vulnerabilities[<pkg>].via[]`, where an entry is either a STRING (the name
 * of another vulnerable package, for a transitive chain) or an advisory
 * object. Only the objects carry an advisory; the strings are edges and are
 * skipped, so a transitive chain is counted once at its source rather than
 * once per hop.
 *
 * @param {Record<string, unknown>} report
 * @returns {NormalizedAdvisory[]}
 */
function normalizeNpmReport(report) {
  /** @type {Map<string, NormalizedAdvisory>} */
  const bySource = new Map();
  const vulnerabilities = /** @type {Record<string, unknown>} */ (report.vulnerabilities);

  for (const entry of Object.values(vulnerabilities)) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const via = /** @type {Record<string, unknown>} */ (entry)["via"];
    if (!Array.isArray(via)) {
      continue;
    }

    for (const item of via) {
      if (item === null || typeof item !== "object") {
        continue; // a string edge in a transitive chain, not an advisory
      }
      const adv = /** @type {Record<string, unknown>} */ (item);
      const url = String(adv["url"] ?? "");
      const ghsaId = ghsaIdFromUrl(url);
      const source = adv["source"] === undefined ? "" : String(adv["source"]);
      const cveIds = Array.isArray(adv["cve"]) ? adv["cve"].map((c) => String(c)) : [];
      const ids = [ghsaId ?? "", ...cveIds].filter(Boolean);

      // Key on the advisory's own identity so one advisory reachable through
      // several packages is reported once.
      const key = ghsaId ?? source ?? url;
      if (key === "" || bySource.has(key)) {
        continue;
      }

      bySource.set(key, {
        ids,
        severity: String(adv["severity"] ?? "").toLowerCase(),
        title: String(adv["title"] ?? "(no title)"),
        url,
      });
    }
  }

  return [...bySource.values()];
}

/**
 * Positively identify a parsed audit report and normalize its advisories.
 *
 * **Recognition is positive, and that is the load-bearing property.** A report
 * counts as clean only when a schema was RECOGNIZED and found nothing
 * blocking; a report that parsed but matches nothing returns
 * `{ schema: null }` and the caller fails closed on it regardless of the audit
 * process's exit code. The alternative — treating "no advisories key" as "no
 * advisories" — is how an npm report (which keeps them under
 * `vulnerabilities`) would read as clean without ever being inspected.
 *
 * @param {unknown} report
 * @returns {{ schema: "legacy" | "npm" | null; advisories: NormalizedAdvisory[] }}
 */
export function recognizeReport(report) {
  if (report === null || typeof report !== "object") {
    return { schema: null, advisories: [] };
  }

  const obj = /** @type {Record<string, unknown>} */ (report);

  if (obj.advisories !== null && typeof obj.advisories === "object") {
    return { schema: "legacy", advisories: normalizeLegacyReport(obj) };
  }

  if (obj.vulnerabilities !== null && typeof obj.vulnerabilities === "object") {
    return { schema: "npm", advisories: normalizeNpmReport(obj) };
  }

  return { schema: null, advisories: [] };
}

/**
 * True when `report` has the recognizable legacy (npm v6 / pnpm) shape: an
 * object with an `advisories` object.
 *
 * Retained as the narrow legacy-shape predicate it always was. It is NOT the
 * fail-closed discriminator any more — `recognizeReport` is, because a report
 * this returns `false` for may still be a perfectly readable npm report.
 *
 * @param {unknown} report
 * @returns {boolean}
 */
export function isInterpretableReport(report) {
  return recognizeReport(report).schema === "legacy";
}

/**
 * Extract the blocking (unsuppressed High/Critical) advisories from a report
 * in EITHER schema. An advisory is suppressed when any of its ids (GHSA or
 * CVE) is present in `suppressed`.
 *
 * An unrecognized report yields an empty array here; callers MUST gate on
 * `recognizeReport(...).schema` rather than on emptiness, which is exactly the
 * fail-open trap `evaluateReport` closes.
 *
 * @param {unknown} report
 * @param {Set<string>} suppressed active (non-expired) suppressed ids
 * @returns {Array<{ id: string; severity: string; title: string; url: string }>}
 */
export function extractBlockingAdvisories(report, suppressed) {
  /** @type {Array<{ id: string; severity: string; title: string; url: string }>} */
  const blocking = [];

  for (const advisory of recognizeReport(report).advisories) {
    if (!BLOCKING_SEVERITIES.has(advisory.severity)) {
      continue;
    }
    if (advisory.ids.some((id) => suppressed.has(id))) {
      continue;
    }
    blocking.push({
      id: advisory.ids[0] ?? "(unknown)",
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
    });
  }

  return blocking;
}

/**
 * Pure evaluation of a parsed audit report against the active suppression set
 * and the audit process's exit code. This is the fail-closed decision core,
 * lifted out of the CLI so it is unit-testable without spawning a package
 * manager.
 *
 * An unrecognized report fails closed on ANY exit code, including zero. It
 * used to pass on a zero exit — the branch that would have let an npm report
 * (advisories under `vulnerabilities`, exit 0 when clean) report clean without
 * being read at all.
 *
 * `_auditExitCode` is retained but no longer consulted, and deliberately so on
 * both counts. It is retained because this function is exported from a
 * published package, so dropping the parameter would break an importer's call.
 * It is not consulted because the decision no longer has anything to ask it:
 * an unrecognized report fails closed whatever the exit code, and a recognized
 * one is judged on the advisories it actually contains. Do not reintroduce
 * "exit code 0 means clean" — that is precisely the branch this Story removed,
 * and `npm audit` exits 0 whenever it finds nothing, including when the gate
 * never understood the report it was handed.
 *
 * @param {unknown} report parsed audit JSON (or `null`)
 * @param {number} _auditExitCode audit process exit code (unused — see above)
 * @param {Set<string>} suppressed active (non-expired) suppressed ids
 * @returns {{ exitCode: number; reason: "clean" | "uninterpretable-failclosed" | "unsuppressed"; schema: "legacy" | "npm" | null; blocking: Array<{ id: string; severity: string; title: string; url: string }> }}
 */
export function evaluateReport(report, _auditExitCode, suppressed) {
  const { schema } = recognizeReport(report);

  if (schema === null) {
    return {
      exitCode: 1,
      reason: "uninterpretable-failclosed",
      schema,
      blocking: [],
    };
  }

  const blocking = extractBlockingAdvisories(report, suppressed);
  if (blocking.length === 0) {
    return { exitCode: 0, reason: "clean", schema, blocking };
  }
  return { exitCode: 1, reason: "unsuppressed", schema, blocking };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse the CLI argv (minus `node` and the script path) into options.
 *
 * @param {string[]} argv
 * @param {string} [cwd]
 * @returns {{ allowlistPath: string; packageJsonPath: string }}
 */
export function parseArgs(argv, cwd = process.cwd()) {
  let allowlistPath = null;
  let packageJsonPath = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allowlist" && argv[i + 1]) {
      allowlistPath = resolve(cwd, argv[i + 1]);
      i++;
    } else if (argv[i] === "--package-json" && argv[i + 1]) {
      packageJsonPath = resolve(cwd, argv[i + 1]);
      i++;
    }
  }

  if (allowlistPath === null) {
    allowlistPath = resolve(cwd, "audit-allowlist.json");
  }
  if (packageJsonPath === null) {
    packageJsonPath = resolve(cwd, "package.json");
  }

  return { allowlistPath, packageJsonPath };
}

/**
 * Load and JSON-parse the allowlist file. Returns `[]` when the file is
 * absent. Throws with a descriptive message on parse failure or when the
 * top-level value is not an array — the CLI turns these into exit 1.
 *
 * @param {string} allowlistPath
 * @returns {AllowlistEntry[]}
 */
export function loadAllowlist(allowlistPath) {
  if (!existsSync(allowlistPath)) {
    return [];
  }

  const raw = readFileSync(allowlistPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Allowlist at ${allowlistPath} must be a JSON array.`);
  }

  return parsed;
}

/**
 * Gate a package.json on unbounded dependency overrides. Returns the process
 * exit code (0 clean, 1 blocking) and prints what is wrong and how to fix it.
 *
 * Split out of `runCli` so BOTH outcomes are executable in a test: the clean
 * path returns here without ever reaching the audit, which needs a real
 * lockfile and a network. A missing package.json is not this gate's business —
 * the audit is what proves the graph.
 *
 * @param {string} packageJsonPath
 * @returns {number}
 */
export function lintOverrides(packageJsonPath) {
  if (!existsSync(packageJsonPath)) {
    return 0;
  }

  /** @type {unknown} */
  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (err) {
    console.error(
      `[audit-check] ERROR: could not parse ${packageJsonPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  const unbounded = findUnboundedOverrides(pkgJson);
  if (unbounded.length === 0) {
    return 0;
  }

  console.error(
    `[audit-check] ${unbounded.length} unbounded dependency override(s) in ${packageJsonPath}:`,
  );
  for (const finding of unbounded) {
    console.error(
      `  - ${finding.field}.${finding.package}: "${finding.bound}" has no upper bound`,
    );
  }
  console.error(
    "\n[audit-check] An override rewrites a dependent's range, so a bare lower bound leaves " +
      "the lockfile as the only pin and lets a fresh resolution cross a major. Give each " +
      'bound an upper limit — "^1.2.3", "~1.2.3", or ">=1.2.3 <2.0.0". Exit 1.',
  );
  return 1;
}

/**
 * Audit invocation per manager. Both are restricted to the PRODUCTION graph:
 * this gate's claim is about what ships, and a dev-only advisory would make it
 * unactionable noise. `--omit=dev` is npm's documented spelling of that.
 */
const AUDIT_COMMANDS = {
  pnpm: "pnpm audit --prod --json",
  npm: "npm audit --omit=dev --json",
};

/**
 * Run the detected manager's audit, returning raw stdout and exit code. Both
 * managers exit non-zero when vulnerabilities are found; the JSON is wanted
 * regardless of the exit code.
 *
 * @param {"pnpm" | "npm"} manager
 * @returns {{ command: string; output: string; exitCode: number }}
 */
function runAudit(manager) {
  const command = AUDIT_COMMANDS[manager];
  try {
    const output = execSync(`${command} 2>/dev/null`, { encoding: "utf8" });
    return { command, output, exitCode: 0 };
  } catch (err) {
    const execError = /** @type {{ stdout?: string; status?: number }} */ (err);
    return {
      command,
      output: execError.stdout ?? "",
      exitCode: execError.status ?? 1,
    };
  }
}

/**
 * CLI entrypoint. Returns the process exit code (0 clean, 1 blocking).
 *
 * @param {string[]} argv argv minus `node` and the script path
 * @returns {number}
 */
export function runCli(argv) {
  const { allowlistPath, packageJsonPath } = parseArgs(argv);

  // --- Lint dependency overrides -------------------------------------------
  //
  // Runs BEFORE the audit: an unbounded override is a standing invitation for
  // the next resolution to cross a major, and nothing else in the toolchain
  // looks for one.
  const overrideExit = lintOverrides(packageJsonPath);
  if (overrideExit !== 0) {
    return overrideExit;
  }

  // --- Load & validate the allowlist ---------------------------------------

  /** @type {AllowlistEntry[]} */
  let allowlist;
  try {
    allowlist = loadAllowlist(allowlistPath);
  } catch (err) {
    console.error(
      `[audit-check] ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { suppressed, expired, invalid } = partitionAllowlist(allowlist, today);

  if (invalid.length > 0) {
    console.error("[audit-check] INVALID allowlist entries detected:");
    for (const { entry, problem } of invalid) {
      const id =
        entry && typeof entry === "object" && typeof entry.id === "string"
          ? entry.id
          : "<no id>";
      console.error(`  - ${id}: ${problem}`);
    }
    console.error(
      "[audit-check] An entry whose expiry cannot be read is never suppressed. " +
        'Fix each entry to carry a non-empty "id" and an "expires" of the form ' +
        "YYYY-MM-DD. Exit 1.",
    );
    return 1;
  }

  if (expired.length > 0) {
    console.error("[audit-check] EXPIRED allowlist entries detected:");
    for (const entry of expired) {
      console.error(
        `  - ${entry.id} (expired ${entry.expires}): ${entry.reason ?? "no reason recorded"}`,
      );
    }
    console.error(
      "[audit-check] Renew or remove expired entries to proceed. Exit 1.",
    );
    return 1;
  }

  // --- Run the detected manager's audit (production graph only) ------------

  // --- Detect the package manager ------------------------------------------
  //
  // From the committed lockfile, not from `packageManager` / `engines`: the
  // lockfile is what the audit reads, and metadata can disagree with it.
  const detected = detectPackageManager(dirname(packageJsonPath));
  if (detected.error) {
    console.error(`[audit-check] ERROR: ${detected.error}`);
    return 1;
  }
  const manager = detected.manager;

  console.log(
    `[audit-check] Detected ${manager} from its lockfile; running ${AUDIT_COMMANDS[manager]} ...`,
  );
  const {
    command: auditCommand,
    output: auditOutput,
    exitCode: auditExitCode,
  } = runAudit(manager);

  // --- Parse audit JSON ----------------------------------------------------

  /** @type {unknown} */
  let report;
  try {
    report = JSON.parse(auditOutput);
  } catch {
    if (auditExitCode === 0) {
      // No JSON and a clean exit means nothing to audit — clean.
      console.log("[audit-check] No vulnerabilities found. Exit 0.");
      return 0;
    }
    console.error(
      `[audit-check] ERROR: ${auditCommand} produced non-JSON output (exit code ` +
        auditExitCode +
        ").",
    );
    console.error(auditOutput.slice(0, 2000));
    return 1;
  }

  // --- Evaluate: fail closed on an uninterpretable report + non-zero exit --
  //
  // The report parsed as JSON. If it matches NEITHER known schema — a legacy
  // `advisories` map or an npm `vulnerabilities` map — the gate cannot prove
  // the graph is clean, so it fails closed no matter what the audit exited
  // with. An empty-but-recognized report is the genuine clean case and passes.
  const { exitCode, reason, schema, blocking } = evaluateReport(
    report,
    auditExitCode,
    suppressed,
  );

  if (reason === "uninterpretable-failclosed") {
    console.error(
      `[audit-check] ERROR: ${auditCommand} (exit ${auditExitCode}) produced a ` +
        "report matching no known audit schema — neither a legacy `advisories` " +
        "map nor an npm `vulnerabilities` map. Failing closed: a report that " +
        "cannot be read cannot show the graph is clean.",
    );
    console.error(auditOutput.slice(0, 2000));
    return exitCode;
  }

  if (blocking.length === 0) {
    console.log(
      `[audit-check] No unsuppressed High/Critical vulnerabilities in the prod graph ` +
        `(${manager}, ${schema} schema). Exit 0.`,
    );
    return exitCode;
  }

  console.error(
    `[audit-check] ${blocking.length} unsuppressed High/Critical CVE(s) found in prod dependency graph:`,
  );

  for (const vuln of blocking) {
    console.error(
      `  [${vuln.severity.toUpperCase()}] ${vuln.id}: ${vuln.title}`,
    );
    if (vuln.url) {
      console.error(`    → ${vuln.url}`);
    }
  }

  console.error(
    "\n[audit-check] To suppress a known/accepted CVE, add a dated entry to audit-allowlist.json:",
  );
  console.error(
    JSON.stringify(
      [
        {
          id: blocking[0]?.id ?? "GHSA-xxxx-xxxx-xxxx",
          reason: "Describe why this is accepted and any mitigations in place",
          expires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        },
      ],
      null,
      2,
    ),
  );

  console.error("\n[audit-check] Exit 1.");
  return 1;
}

// ---------------------------------------------------------------------------
// Direct-invocation guard (skipped when imported by the test suite)
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("audit-check.mjs");

if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
