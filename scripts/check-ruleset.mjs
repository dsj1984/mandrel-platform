#!/usr/bin/env node
/**
 * check-ruleset.mjs
 *
 * Live branch-ruleset drift dashboard (Story #178).
 *
 * The platform ships `config/main-protection.schema.json` +
 * `docs/runbooks/main-protection.json` (the decided main-branch protection
 * contract: required status checks, no bypass actors, linear history,
 * force-push/deletion blocked) plus a setup runbook — but nothing detects a
 * LIVE ruleset drifting from that contract after initial setup. A silent
 * ruleset edit (an actor added to `bypass_actors`, `strict` status checks
 * turned off, force-pushes re-enabled) would go unnoticed today. The
 * 2026-07-01 audit found exactly this risk class at the repo-settings layer
 * (Story #171, `check-repo-settings.mjs`); this script is the same detector
 * for the branch-ruleset layer.
 *
 * Mirrors the shape of `check-repo-settings.mjs` / `check-pin-drift.mjs`:
 * data-driven consumer registry (reuses `scripts/pin-drift-consumers.json` —
 * same fleet, no second registry to keep in sync), an injectable `runGh`
 * seam for offline testing, pure exported classifier functions, `--json` /
 * `--strict` flags, and `GITHUB_STEP_SUMMARY` integration.
 *
 * Reads each consumer's LIVE rulesets via the GitHub Rulesets API
 * (`gh api repos/{owner}/{repo}/rulesets` for the list, then
 * `gh api repos/{owner}/{repo}/rulesets/{id}` per ruleset for full rule
 * detail — the list endpoint omits `rules`/`bypass_actors`) and diffs the
 * ruleset targeting `refs/heads/<branch>` against
 * `docs/runbooks/main-protection.json`:
 *
 *   - `pull_request`  rule present         → PR required to merge.
 *   - `bypass_actors` empty                → no bypass actor exempts the rule.
 *   - `required_status_checks` rule        → contexts match `requiredStatusChecks`
 *                                             and `strict_required_status_checks_policy`
 *                                             is true (branch must be up to date).
 *   - `required_linear_history` rule       → present iff `requireLinearHistory`.
 *   - `non_fast_forward` rule (force-push) → present iff `!allowForcePushes`.
 *   - `deletion` rule                      → present iff `!allowDeletions`.
 *
 * Non-blocking by design (standing decision #10 — same posture as
 * `check-repo-settings.mjs` and `check-pin-drift.mjs`): the default exit
 * code is 0 even when drift is found. `--strict` is an explicit opt-in for a
 * one-off enforcement run; the scheduled dashboard invocation never passes
 * it.
 *
 * Out of scope (see the Story): auto-fixing rulesets. This script reports
 * drift and points at the setup runbook — it never mutates a live ruleset.
 *
 * Usage:
 *   node scripts/check-ruleset.mjs
 *   node scripts/check-ruleset.mjs --config scripts/pin-drift-consumers.json
 *   node scripts/check-ruleset.mjs --contract docs/runbooks/main-protection.json
 *   node scripts/check-ruleset.mjs --json      # machine-readable envelope
 *   node scripts/check-ruleset.mjs --strict     # exit 1 on any drift
 *
 * Exit codes:
 *   0 — report emitted. Without --strict this is the default even when drift
 *       is present (report, don't block).
 *   1 — with --strict: at least one consumer drifts from the contract.
 *       Without --strict: only on a fatal error (bad config, gh failure).
 */

import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ config: string, contract: string, json: boolean, strict: boolean }}
 */
export function parseArgv(argv = []) {
  let config = "scripts/pin-drift-consumers.json";
  let contract = "docs/runbooks/main-protection.json";
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
    } else if (a === "--contract") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        contract = next;
        i += 1;
      }
    } else if (a === "--json") {
      json = true;
    } else if (a === "--strict") {
      strict = true;
    }
  }
  return { config, contract, json, strict };
}

// ---------------------------------------------------------------------------
// Ruleset shape mapping
// ---------------------------------------------------------------------------

/**
 * Pick the ruleset (from a consumer's full `GET /rulesets/{id}` list) that
 * targets the contract's protected branch — `refs/heads/<branch>` in the
 * ruleset's `conditions.ref_name.include` list — and is `active`. Disabled
 * ("evaluate") rulesets are ignored: they exist but do not enforce, so a
 * contract check against them would be misleading.
 *
 * @param {Array<Record<string, unknown>>} rulesets  Full ruleset objects (post-detail-fetch).
 * @param {string} branch
 * @returns {Record<string, unknown> | null}
 */
export function findBranchRuleset(rulesets, branch) {
  const targetRef = `refs/heads/${branch}`;
  const match = rulesets.find((rs) => {
    if (rs.enforcement !== "active") return false;
    const include = rs.conditions?.ref_name?.include ?? [];
    return include.includes(targetRef) || include.includes("~DEFAULT_BRANCH");
  });
  return match ?? null;
}

/**
 * Map a full ruleset object's `rules[]` array into the contract's field
 * shape, so it can be diffed the same way `check-repo-settings.mjs` diffs
 * camelCase settings fields against the baseline.
 *
 * @param {Record<string, unknown>} ruleset
 * @returns {{
 *   pullRequestRequired: boolean,
 *   bypassActorsEmpty: boolean,
 *   requiredStatusChecks: string[],
 *   strictRequiredStatusChecksPolicy: boolean,
 *   requireLinearHistory: boolean,
 *   allowForcePushes: boolean,
 *   allowDeletions: boolean,
 * }}
 */
export function mapRulesetToContract(ruleset) {
  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const byType = Object.fromEntries(rules.map((r) => [r.type, r]));

  const statusCheckRule = byType.required_status_checks;
  const statusChecks = (statusCheckRule?.parameters?.required_status_checks ?? []).map((c) => c.context);

  const bypassActors = Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [];

  return {
    pullRequestRequired: Boolean(byType.pull_request),
    bypassActorsEmpty: bypassActors.length === 0,
    requiredStatusChecks: statusChecks,
    strictRequiredStatusChecksPolicy: Boolean(statusCheckRule?.parameters?.strict_required_status_checks_policy),
    // GitHub models "force pushes blocked" as the presence of the
    // `non_fast_forward` rule, and "deletions blocked" as the presence of
    // the `deletion` rule — both are "rule present == restriction active",
    // the inverse of the contract's `allow*` booleans.
    allowForcePushes: !byType.non_fast_forward,
    allowDeletions: !byType.deletion,
    requireLinearHistory: Boolean(byType.required_linear_history),
  };
}

/**
 * Diff a mapped live ruleset against the main-protection contract. Unknown
 * contract keys (`$schema`, `branch`, `aggregatorJob`, `upstreamJobs`,
 * `enforceAdmins`, `_note`) are ignored — this checker only asserts the
 * dimensions a ruleset can actually encode.
 *
 * `requiredStatusChecks` is compared as a set (order-independent) since
 * GitHub does not guarantee array ordering on the API response.
 *
 * @param {ReturnType<typeof mapRulesetToContract>} live
 * @param {Record<string, unknown>} contract
 * @returns {{ drifted: boolean, mismatches: Array<{ field: string, expected: unknown, actual: unknown }> }}
 */
export function diffRuleset(live, contract) {
  const mismatches = [];

  if (contract.requiredStatusChecks !== undefined) {
    const expected = [...contract.requiredStatusChecks].sort();
    const actual = [...(live.requiredStatusChecks ?? [])].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      mismatches.push({
        field: "requiredStatusChecks",
        expected: contract.requiredStatusChecks,
        actual: live.requiredStatusChecks,
      });
    }
  }

  if (live.pullRequestRequired !== true) {
    mismatches.push({ field: "pullRequestRequired", expected: true, actual: live.pullRequestRequired });
  }

  if (live.bypassActorsEmpty !== true) {
    mismatches.push({ field: "bypassActorsEmpty", expected: true, actual: live.bypassActorsEmpty });
  }

  if (live.strictRequiredStatusChecksPolicy !== true) {
    mismatches.push({
      field: "strictRequiredStatusChecksPolicy",
      expected: true,
      actual: live.strictRequiredStatusChecksPolicy,
    });
  }

  const boolFields = [
    ["requireLinearHistory", contract.requireLinearHistory],
    ["allowForcePushes", contract.allowForcePushes],
    ["allowDeletions", contract.allowDeletions],
  ];
  for (const [field, expected] of boolFields) {
    if (expected === undefined) continue;
    if (live[field] !== expected) {
      mismatches.push({ field, expected, actual: live[field] });
    }
  }

  return { drifted: mismatches.length > 0, mismatches };
}

// ---------------------------------------------------------------------------
// GitHub access
// ---------------------------------------------------------------------------

function ghApiJson(apiPath, runGh) {
  const raw = runGh(["api", apiPath, "-H", "Accept: application/vnd.github+json"]);
  return JSON.parse(raw);
}

/**
 * Default gh runner — shells out to the `gh` CLI. Same shape as
 * check-repo-settings.mjs's defaultGhRunner so all three checkers share test
 * doubles.
 *
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
 * Fetch a consumer's rulesets: list, then hydrate each with the detail
 * endpoint (the list response omits `rules`/`bypass_actors`), then pick the
 * one targeting `branch`.
 *
 * @param {string} repo  "owner/repo".
 * @param {string} branch
 * @param {(args: string[]) => string} runGh
 * @returns {Record<string, unknown> | null}
 */
export function fetchBranchRuleset(repo, branch, runGh) {
  const list = ghApiJson(`repos/${repo}/rulesets`, runGh);
  const detailed = (Array.isArray(list) ? list : []).map((rs) => ghApiJson(`repos/${repo}/rulesets/${rs.id}`, runGh));
  return findBranchRuleset(detailed, branch);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the full drift report for the configured consumers against the
 * given contract.
 *
 * @param {{ consumers: Array<{ name: string, repo: string, branch?: string }> }} config
 * @param {Record<string, unknown>} contract
 * @param {(args: string[]) => string} runGh
 * @returns {{ contract: Record<string, unknown>, consumers: Array<object> }}
 */
export function buildReport(config, contract, runGh) {
  const branch = contract.branch ?? "main";
  const consumers = config.consumers.map((consumer) => {
    const consumerBranch = consumer.branch ?? branch;
    try {
      const ruleset = fetchBranchRuleset(consumer.repo, consumerBranch, runGh);
      if (!ruleset) {
        return {
          name: consumer.name,
          repo: consumer.repo,
          status: "missing",
          error: `no active ruleset targets refs/heads/${consumerBranch}`,
        };
      }
      const live = mapRulesetToContract(ruleset);
      const { drifted, mismatches } = diffRuleset(live, contract);
      return {
        name: consumer.name,
        repo: consumer.repo,
        status: drifted ? "drift" : "current",
        rulesetId: ruleset.id,
        rulesetName: ruleset.name,
        live,
        mismatches,
      };
    } catch (err) {
      return {
        name: consumer.name,
        repo: consumer.repo,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  return { contract, consumers };
}

/**
 * @param {ReturnType<typeof buildReport>} report
 * @returns {boolean}
 */
export function hasDrift(report) {
  return report.consumers.some((c) => c.status === "drift" || c.status === "missing");
}

/**
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string}
 */
export function renderReport(report) {
  const lines = [];
  lines.push("## Branch-Ruleset Drift Dashboard");
  lines.push("");
  lines.push(
    "Non-blocking by design (standing decision #10) — drift is reported here, never a hard gate on a consumer's `main`.",
  );
  lines.push("");
  lines.push("| Consumer | Status | Detail |");
  lines.push("| -------- | ------ | ------ |");
  for (const c of report.consumers) {
    if (c.status === "current") {
      lines.push(`| ${c.name} | ✅ current | matches the main-protection contract |`);
    } else if (c.status === "missing") {
      lines.push(`| ${c.name} | ⚠️ missing | ${c.error} |`);
    } else if (c.status === "error") {
      lines.push(`| ${c.name} | ⚠️ error | ${c.error} |`);
    } else {
      const detail = c.mismatches
        .map((m) => `${m.field}: expected \`${JSON.stringify(m.expected)}\`, got \`${JSON.stringify(m.actual)}\``)
        .join("; ");
      lines.push(`| ${c.name} | ❌ drift | ${detail} |`);
    }
  }
  return lines.join("\n");
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
  const { config: configRel, contract: contractRel, json, strict } = parseArgv(argv);
  const configPath = resolve(cwd, configRel);
  const contractPath = resolve(cwd, contractRel);

  let config;
  let contract;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    stderr.write(
      `[ruleset] ❌ failed to read config ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  try {
    contract = JSON.parse(readFileSync(contractPath, "utf-8"));
  } catch (err) {
    stderr.write(
      `[ruleset] ❌ failed to read contract ${contractPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (!Array.isArray(config.consumers)) {
    stderr.write(`[ruleset] ❌ config must define { consumers: [] }\n`);
    return 1;
  }

  const report = buildReport(config, contract, runGh);
  const drift = hasDrift(report);

  if (json) {
    stdout.write(`${JSON.stringify({ kind: "ruleset-report", drift, ...report }, null, 2)}\n`);
  } else {
    const text = renderReport(report);
    stdout.write(`${text}\n`);
    if (summaryPath) {
      try {
        appendFileSync(summaryPath, `${text}\n`);
      } catch (err) {
        stderr.write(`[ruleset] ⚠ could not write job summary: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  if (strict && drift) {
    stderr.write(`[ruleset] ❌ drift detected (--strict)\n`);
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
