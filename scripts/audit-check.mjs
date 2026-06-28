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
 * Usage:
 *   node scripts/audit-check.mjs
 *   node scripts/audit-check.mjs --allowlist path/to/allowlist.json
 *
 * Exit codes:
 *   0 — no blocking vulnerabilities (all High/Critical suppressed with
 *       valid, non-expired allowlist entries, or none found)
 *   1 — one or more unsuppressed High/Critical CVEs, or expired allowlist
 *       entries were encountered
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
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let allowlistPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--allowlist" && args[i + 1]) {
    allowlistPath = resolve(process.cwd(), args[i + 1]);
    i++;
  }
}

if (allowlistPath === null) {
  allowlistPath = resolve(process.cwd(), "audit-allowlist.json");
}

// ---------------------------------------------------------------------------
// Allowlist loading and validation
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string; reason: string; expires: string }} AllowlistEntry
 */

/** @type {AllowlistEntry[]} */
let allowlist = [];

if (existsSync(allowlistPath)) {
  try {
    const raw = readFileSync(allowlistPath, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      console.error(
        `[audit-check] ERROR: Allowlist at ${allowlistPath} must be a JSON array.`,
      );
      process.exit(1);
    }

    allowlist = parsed;
  } catch (err) {
    console.error(
      `[audit-check] ERROR: Failed to parse allowlist at ${allowlistPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

/** @type {Set<string>} Active (non-expired) suppressed advisory IDs */
const suppressed = new Set();
/** @type {AllowlistEntry[]} */
const expiredEntries = [];

for (const entry of allowlist) {
  if (!entry.id || !entry.expires) {
    console.error(
      `[audit-check] ERROR: Allowlist entry missing required "id" or "expires" field: ${JSON.stringify(entry)}`,
    );
    process.exit(1);
  }

  if (entry.expires < today) {
    expiredEntries.push(entry);
  } else {
    suppressed.add(entry.id);
  }
}

if (expiredEntries.length > 0) {
  console.error("[audit-check] EXPIRED allowlist entries detected:");
  for (const entry of expiredEntries) {
    console.error(
      `  - ${entry.id} (expired ${entry.expires}): ${entry.reason ?? "no reason recorded"}`,
    );
  }
  console.error(
    "[audit-check] Renew or remove expired entries to proceed. Exit 1.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run pnpm audit (production graph only)
// ---------------------------------------------------------------------------

console.log("[audit-check] Running pnpm audit --prod --json ...");

let auditOutput = "";
let auditExitCode = 0;

try {
  auditOutput = execSync("pnpm audit --prod --json 2>/dev/null", {
    encoding: "utf8",
  });
} catch (err) {
  // pnpm audit exits non-zero when vulnerabilities are found.
  // We want the JSON regardless of the exit code.
  const execError = /** @type {{ stdout?: string; status?: number }} */ (err);
  auditOutput = execError.stdout ?? "";
  auditExitCode = execError.status ?? 1;
}

// ---------------------------------------------------------------------------
// Parse audit JSON
// ---------------------------------------------------------------------------

/** @type {unknown} */
let report;

try {
  report = JSON.parse(auditOutput);
} catch {
  if (auditExitCode === 0) {
    // No JSON means nothing to audit — clean.
    console.log("[audit-check] No vulnerabilities found. Exit 0.");
    process.exit(0);
  }
  console.error(
    "[audit-check] ERROR: pnpm audit produced non-JSON output (exit code " +
      auditExitCode +
      ").",
  );
  console.error(auditOutput.slice(0, 2000));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Extract advisories
// ---------------------------------------------------------------------------

/**
 * pnpm audit --json shape:
 *   {
 *     "advisories": {
 *       "<id>": {
 *         "ghsa_id": "GHSA-xxxx",
 *         "cve": ["CVE-xxxx"],
 *         "severity": "high" | "critical" | "moderate" | "low" | "info",
 *         "title": "...",
 *         "url": "...",
 *         ...
 *       }
 *     },
 *     "metadata": { ... }
 *   }
 */

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/** @type {Array<{ id: string; severity: string; title: string; url: string }>} */
const blocking = [];

if (
  report !== null &&
  typeof report === "object" &&
  "advisories" in report &&
  report.advisories !== null &&
  typeof report.advisories === "object"
) {
  const advisories = /** @type {Record<string, unknown>} */ (
    report.advisories
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
}

// ---------------------------------------------------------------------------
// Report and exit
// ---------------------------------------------------------------------------

if (blocking.length === 0) {
  console.log(
    `[audit-check] No unsuppressed High/Critical vulnerabilities in the prod graph. Exit 0.`,
  );
  process.exit(0);
}

console.error(
  `[audit-check] ${blocking.length} unsuppressed High/Critical CVE(s) found in prod dependency graph:`,
);

for (const vuln of blocking) {
  console.error(`  [${vuln.severity.toUpperCase()}] ${vuln.id}: ${vuln.title}`);
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
process.exit(1);
