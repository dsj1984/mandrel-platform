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
 * Fail-closed contract:
 *   When `pnpm audit` exits non-zero AND the report it produced cannot be
 *   interpreted as a recognizable advisories document, the gate exits
 *   non-zero. A non-zero audit exit is a signal that something is wrong;
 *   an uninterpretable report means the gate cannot prove the graph is
 *   clean, so it must fail closed rather than wave the build through.
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
 *       entries were encountered, an override was unbounded, or the audit
 *       report was uninterpretable while pnpm audit exited non-zero
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
import { resolve } from "node:path";

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
 * @param {string} value trimmed specifier
 * @returns {boolean}
 */
function isWildcardSpec(value) {
  if (/^(latest|next)$/i.test(value)) {
    return true;
  }

  return /^[*xX]$/.test(value.split(".")[0]);
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

  // Wildcards and dist-tags pin nothing at all.
  if (isWildcardSpec(value)) {
    return false;
  }

  // An explicit upper bound anywhere in a compound range closes it.
  if (/[<]/.test(value)) {
    return true;
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
 * True when `report` has the recognizable pnpm-audit shape: an object with
 * an `advisories` object. This is the discriminator the fail-closed contract
 * hangs on — a parsed-but-unrecognizable report (e.g. an error envelope) is
 * NOT interpretable.
 *
 * @param {unknown} report
 * @returns {boolean}
 */
export function isInterpretableReport(report) {
  return (
    report !== null &&
    typeof report === "object" &&
    "advisories" in report &&
    /** @type {Record<string, unknown>} */ (report).advisories !== null &&
    typeof (/** @type {Record<string, unknown>} */ (report).advisories) ===
      "object"
  );
}

/**
 * Extract the blocking (unsuppressed High/Critical) advisories from an
 * interpretable pnpm-audit report. An advisory is suppressed when any of its
 * ids (GHSA id or CVE ids) is present in `suppressed`.
 *
 * Callers MUST gate this behind `isInterpretableReport` — an
 * uninterpretable report yields an empty array here, which is exactly the
 * fail-open trap the CLI guards against separately.
 *
 * @param {unknown} report
 * @param {Set<string>} suppressed active (non-expired) suppressed ids
 * @returns {Array<{ id: string; severity: string; title: string; url: string }>}
 */
export function extractBlockingAdvisories(report, suppressed) {
  /** @type {Array<{ id: string; severity: string; title: string; url: string }>} */
  const blocking = [];

  if (!isInterpretableReport(report)) {
    return blocking;
  }

  const advisories = /** @type {Record<string, unknown>} */ (
    /** @type {Record<string, unknown>} */ (report).advisories
  );

  for (const [, advisory] of Object.entries(advisories)) {
    if (
      advisory === null ||
      typeof advisory !== "object" ||
      !("severity" in advisory)
    ) {
      continue;
    }

    const adv = /** @type {Record<string, unknown>} */ (advisory);
    const severity = String(adv["severity"] ?? "").toLowerCase();

    if (!BLOCKING_SEVERITIES.has(severity)) {
      continue;
    }

    // Collect all IDs this advisory is known by for allowlist matching.
    const ghsaId = String(adv["ghsa_id"] ?? "");
    const cveIds = Array.isArray(adv["cve"])
      ? adv["cve"].map((c) => String(c))
      : [];
    const allIds = [ghsaId, ...cveIds].filter(Boolean);

    const isSuppressed = allIds.some((id) => suppressed.has(id));

    if (!isSuppressed) {
      blocking.push({
        id: ghsaId || cveIds[0] || "(unknown)",
        severity,
        title: String(adv["title"] ?? "(no title)"),
        url: String(adv["url"] ?? ""),
      });
    }
  }

  return blocking;
}

/**
 * Pure evaluation of a parsed audit report against the active suppression
 * set and the pnpm-audit exit code. This is the fail-closed decision core,
 * lifted out of the CLI so it is unit-testable without spawning pnpm.
 *
 * @param {unknown} report parsed audit JSON (or `null`)
 * @param {number} auditExitCode pnpm audit exit code
 * @param {Set<string>} suppressed active (non-expired) suppressed ids
 * @returns {{ exitCode: number; reason: "clean" | "uninterpretable-failclosed" | "unsuppressed" | "clean-no-advisories"; blocking: Array<{ id: string; severity: string; title: string; url: string }> }}
 */
export function evaluateReport(report, auditExitCode, suppressed) {
  if (!isInterpretableReport(report)) {
    if (auditExitCode !== 0) {
      return {
        exitCode: 1,
        reason: "uninterpretable-failclosed",
        blocking: [],
      };
    }
    return { exitCode: 0, reason: "clean-no-advisories", blocking: [] };
  }

  const blocking = extractBlockingAdvisories(report, suppressed);
  if (blocking.length === 0) {
    return { exitCode: 0, reason: "clean", blocking };
  }
  return { exitCode: 1, reason: "unsuppressed", blocking };
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
 * path returns here without ever reaching `pnpm audit`, which needs a real
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
 * Run `pnpm audit --prod --json`, returning the raw stdout and exit code.
 * pnpm audit exits non-zero when vulnerabilities are found; we want the JSON
 * regardless of the exit code.
 *
 * @returns {{ output: string; exitCode: number }}
 */
function runPnpmAudit() {
  try {
    const output = execSync("pnpm audit --prod --json 2>/dev/null", {
      encoding: "utf8",
    });
    return { output, exitCode: 0 };
  } catch (err) {
    const execError = /** @type {{ stdout?: string; status?: number }} */ (err);
    return { output: execError.stdout ?? "", exitCode: execError.status ?? 1 };
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

  // --- Run pnpm audit (production graph only) ------------------------------

  console.log("[audit-check] Running pnpm audit --prod --json ...");
  const { output: auditOutput, exitCode: auditExitCode } = runPnpmAudit();

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
      "[audit-check] ERROR: pnpm audit produced non-JSON output (exit code " +
        auditExitCode +
        ").",
    );
    console.error(auditOutput.slice(0, 2000));
    return 1;
  }

  // --- Evaluate: fail closed on an uninterpretable report + non-zero exit --
  //
  // The report parsed as JSON. If it lacks a recognizable `advisories` shape
  // (e.g. an error envelope) AND pnpm audit exited non-zero, we cannot prove
  // the graph is clean — fail closed. A zero exit with no advisories key is
  // the genuine "clean, nothing to report" case and passes.
  const { exitCode, reason, blocking } = evaluateReport(
    report,
    auditExitCode,
    suppressed,
  );

  if (reason === "uninterpretable-failclosed") {
    console.error(
      "[audit-check] ERROR: pnpm audit exited non-zero (" +
        auditExitCode +
        ") and produced a report without a recognizable `advisories` shape. Failing closed.",
    );
    console.error(auditOutput.slice(0, 2000));
    return exitCode;
  }

  if (reason === "clean-no-advisories") {
    console.log("[audit-check] No vulnerabilities found. Exit 0.");
    return exitCode;
  }

  if (blocking.length === 0) {
    console.log(
      `[audit-check] No unsuppressed High/Critical vulnerabilities in the prod graph. Exit 0.`,
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
