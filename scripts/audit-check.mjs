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
 * Usage:
 *   node scripts/audit-check.mjs
 *   node scripts/audit-check.mjs --allowlist path/to/allowlist.json
 *
 * Exit codes:
 *   0 — no blocking vulnerabilities (all High/Critical suppressed with
 *       valid, non-expired allowlist entries, or none found)
 *   1 — one or more unsuppressed High/Critical CVEs, expired allowlist
 *       entries were encountered, or the audit report was uninterpretable
 *       while pnpm audit exited non-zero
 *
 * Allowlist format (JSON):
 *   [
 *     {
 *       "id": "GHSA-xxxx-xxxx-xxxx",  // GitHub Advisory ID or CVE ID
 *       "reason": "No fix available; mitigated by X",
 *       "expires": "2026-12-31"        // ISO 8601 date — REQUIRED
 *     }
 *   ]
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
 * Partition allowlist entries into the active (non-expired) suppression set
 * and the list of expired entries, relative to `today` (a `YYYY-MM-DD`
 * string). Entries missing a required `id` or `expires` field are surfaced
 * in `invalid` so the caller can fail closed on a malformed allowlist.
 *
 * @param {AllowlistEntry[]} allowlist
 * @param {string} today `YYYY-MM-DD`
 * @returns {{ suppressed: Set<string>; expired: AllowlistEntry[]; invalid: AllowlistEntry[] }}
 */
export function partitionAllowlist(allowlist, today) {
  /** @type {Set<string>} */
  const suppressed = new Set();
  /** @type {AllowlistEntry[]} */
  const expired = [];
  /** @type {AllowlistEntry[]} */
  const invalid = [];

  for (const entry of allowlist) {
    if (!entry || !entry.id || !entry.expires) {
      invalid.push(entry);
      continue;
    }

    if (entry.expires < today) {
      expired.push(entry);
    } else {
      suppressed.add(entry.id);
    }
  }

  return { suppressed, expired, invalid };
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
 * @returns {{ allowlistPath: string }}
 */
export function parseArgs(argv, cwd = process.cwd()) {
  let allowlistPath = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allowlist" && argv[i + 1]) {
      allowlistPath = resolve(cwd, argv[i + 1]);
      i++;
    }
  }

  if (allowlistPath === null) {
    allowlistPath = resolve(cwd, "audit-allowlist.json");
  }

  return { allowlistPath };
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
  const { allowlistPath } = parseArgs(argv);

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
    for (const entry of invalid) {
      console.error(
        `[audit-check] ERROR: Allowlist entry missing required "id" or "expires" field: ${JSON.stringify(entry)}`,
      );
    }
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
