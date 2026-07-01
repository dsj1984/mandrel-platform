#!/usr/bin/env node
/**
 * check-repo-settings.mjs
 *
 * GitHub-side repo-settings drift dashboard (Story #171).
 *
 * The 2026-07-01 settings-level audit (repo-ops consumers matrix §3a, roadmap
 * §2.1) found real divergence in GitHub repo settings the platform shipped no
 * contract for: default Actions workflow token permissions, merge-method
 * allow-list, squash-commit source, auto-merge, and whether Actions can
 * approve pull requests. `config/repo-settings.schema.json` /
 * `docs/runbooks/repo-settings.json` encode the decided fleet baseline; this
 * script reads each consumer's LIVE settings over the GitHub API
 * (`gh api repos/{owner}/{repo}`) and reports drift against that baseline.
 *
 * Mirrors the shape of `check-pin-drift.mjs`: data-driven consumer registry
 * (reuses `scripts/pin-drift-consumers.json` — same fleet, no second registry
 * to keep in sync), an injectable `runGh` seam for offline testing, pure
 * exported classifier functions, `--json` / `--strict` flags, and
 * `GITHUB_STEP_SUMMARY` integration.
 *
 * Non-blocking by design (standing decision #10 — drift is repaired via
 * auto-repair PRs / a dashboard, never a hard gate): the default exit code is
 * 0 even when drift is found. `--strict` is an explicit opt-in for a one-off
 * enforcement run; the scheduled dashboard invocation never passes it.
 *
 * Usage:
 *   node scripts/check-repo-settings.mjs
 *   node scripts/check-repo-settings.mjs --config scripts/pin-drift-consumers.json
 *   node scripts/check-repo-settings.mjs --baseline docs/runbooks/repo-settings.json
 *   node scripts/check-repo-settings.mjs --json      # machine-readable envelope
 *   node scripts/check-repo-settings.mjs --strict     # exit 1 on any drift
 *
 * Exit codes:
 *   0 — report emitted. Without --strict this is the default even when drift
 *       is present (report, don't block).
 *   1 — with --strict: at least one consumer drifts from the baseline.
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
 * @returns {{ config: string, baseline: string, json: boolean, strict: boolean }}
 */
export function parseArgv(argv = []) {
  let config = "scripts/pin-drift-consumers.json";
  let baseline = "docs/runbooks/repo-settings.json";
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
    } else if (a === "--baseline") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        baseline = next;
        i += 1;
      }
    } else if (a === "--json") {
      json = true;
    } else if (a === "--strict") {
      strict = true;
    }
  }
  return { config, baseline, json, strict };
}

// ---------------------------------------------------------------------------
// Baseline dimensions
// ---------------------------------------------------------------------------

/**
 * The baseline keys this checker understands, mapped to how to read the
 * equivalent field off `gh api repos/{owner}/{repo}` (repo settings) or
 * `gh api repos/{owner}/{repo}/actions/permissions/workflow` (Actions
 * workflow-permissions, a separate endpoint GitHub does not fold into the
 * main repo payload).
 */
const REPO_FIELDS = [
  "allowSquashMerge",
  "allowMergeCommit",
  "allowRebaseMerge",
  "squashMergeCommitTitle",
  "squashMergeCommitMessage",
  "deleteBranchOnMerge",
  "allowAutoMerge",
];
const ACTIONS_FIELDS = ["actionsDefaultWorkflowPermissions", "actionsCanApprovePullRequestReviews"];

const REPO_FIELD_TO_API_KEY = {
  allowSquashMerge: "allow_squash_merge",
  allowMergeCommit: "allow_merge_commit",
  allowRebaseMerge: "allow_rebase_merge",
  squashMergeCommitTitle: "squash_merge_commit_title",
  squashMergeCommitMessage: "squash_merge_commit_message",
  deleteBranchOnMerge: "delete_branch_on_merge",
  allowAutoMerge: "allow_auto_merge",
};

const ACTIONS_FIELD_TO_API_KEY = {
  actionsDefaultWorkflowPermissions: "default_workflow_permissions",
  actionsCanApprovePullRequestReviews: "can_approve_pull_request_reviews",
};

/**
 * Map a live `gh api repos/{owner}/{repo}` payload to the baseline's field
 * shape (camelCase, only the dimensions this contract governs).
 *
 * @param {Record<string, unknown>} repoPayload
 * @returns {Record<string, unknown>}
 */
export function mapRepoSettings(repoPayload) {
  const out = {};
  for (const field of REPO_FIELDS) {
    out[field] = repoPayload[REPO_FIELD_TO_API_KEY[field]];
  }
  return out;
}

/**
 * Map a live `gh api repos/{owner}/{repo}/actions/permissions/workflow`
 * payload to the baseline's field shape.
 *
 * @param {Record<string, unknown>} actionsPayload
 * @returns {Record<string, unknown>}
 */
export function mapActionsSettings(actionsPayload) {
  const out = {};
  for (const field of ACTIONS_FIELDS) {
    out[field] = actionsPayload[ACTIONS_FIELD_TO_API_KEY[field]];
  }
  return out;
}

/**
 * Diff a consumer's live settings against the baseline for every dimension
 * the baseline declares (unknown/extra baseline keys are ignored so the
 * schema can grow without breaking this classifier).
 *
 * @param {Record<string, unknown>} live
 * @param {Record<string, unknown>} baseline
 * @returns {{ drifted: boolean, mismatches: Array<{ field: string, expected: unknown, actual: unknown }> }}
 */
export function diffSettings(live, baseline) {
  const mismatches = [];
  for (const field of [...REPO_FIELDS, ...ACTIONS_FIELDS]) {
    if (!(field in baseline)) continue;
    const expected = baseline[field];
    const actual = live[field];
    if (actual !== expected) {
      mismatches.push({ field, expected, actual });
    }
  }
  return { drifted: mismatches.length > 0, mismatches };
}

// ---------------------------------------------------------------------------
// GitHub access
// ---------------------------------------------------------------------------

/**
 * Run `gh api <path>` and parse the JSON response.
 *
 * @param {string} apiPath
 * @param {(args: string[]) => string} runGh
 * @returns {unknown}
 */
function ghApiJson(apiPath, runGh) {
  const raw = runGh(["api", apiPath, "-H", "Accept: application/vnd.github+json"]);
  return JSON.parse(raw);
}

/**
 * Default gh runner — shells out to the `gh` CLI. Same shape as
 * check-pin-drift.mjs's defaultGhRunner so both scripts share test doubles.
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
 * Fetch one consumer's live settings across both endpoints and map them to
 * the baseline's field shape.
 *
 * @param {string} repo  "owner/repo".
 * @param {(args: string[]) => string} runGh
 * @returns {Record<string, unknown>}
 */
export function fetchConsumerSettings(repo, runGh) {
  const repoPayload = ghApiJson(`repos/${repo}`, runGh);
  const actionsPayload = ghApiJson(`repos/${repo}/actions/permissions/workflow`, runGh);
  return { ...mapRepoSettings(repoPayload), ...mapActionsSettings(actionsPayload) };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the full drift report for the configured consumers against the
 * given baseline.
 *
 * @param {{ consumers: Array<{ name: string, repo: string, branch?: string }> }} config
 * @param {Record<string, unknown>} baseline
 * @param {(args: string[]) => string} runGh
 * @returns {{ baseline: Record<string, unknown>, consumers: Array<object> }}
 */
export function buildReport(config, baseline, runGh) {
  const consumers = config.consumers.map((consumer) => {
    try {
      const live = fetchConsumerSettings(consumer.repo, runGh);
      const { drifted, mismatches } = diffSettings(live, baseline);
      return { name: consumer.name, repo: consumer.repo, status: drifted ? "drift" : "current", live, mismatches };
    } catch (err) {
      return {
        name: consumer.name,
        repo: consumer.repo,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  return { baseline, consumers };
}

/**
 * @param {ReturnType<typeof buildReport>} report
 * @returns {boolean}
 */
export function hasDrift(report) {
  return report.consumers.some((c) => c.status === "drift");
}

/**
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string}
 */
export function renderReport(report) {
  const lines = [];
  lines.push("## Repo-Settings Baseline Dashboard");
  lines.push("");
  lines.push(
    "Non-blocking by design (standing decision #10) — drift is reported here, never a hard gate on a consumer's `main`.",
  );
  lines.push("");
  lines.push("| Consumer | Status | Detail |");
  lines.push("| -------- | ------ | ------ |");
  for (const c of report.consumers) {
    if (c.status === "current") {
      lines.push(`| ${c.name} | ✅ current | matches baseline |`);
    } else if (c.status === "error") {
      lines.push(`| ${c.name} | ⚠️ error | ${c.error} |`);
    } else {
      const detail = c.mismatches
        .map((m) => `${m.field}: expected \`${m.expected}\`, got \`${m.actual}\``)
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
  const { config: configRel, baseline: baselineRel, json, strict } = parseArgv(argv);
  const configPath = resolve(cwd, configRel);
  const baselinePath = resolve(cwd, baselineRel);

  let config;
  let baseline;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    stderr.write(
      `[repo-settings] ❌ failed to read config ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
  } catch (err) {
    stderr.write(
      `[repo-settings] ❌ failed to read baseline ${baselinePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (!Array.isArray(config.consumers)) {
    stderr.write(`[repo-settings] ❌ config must define { consumers: [] }\n`);
    return 1;
  }

  const report = buildReport(config, baseline, runGh);
  const drift = hasDrift(report);

  if (json) {
    stdout.write(`${JSON.stringify({ kind: "repo-settings-report", drift, ...report }, null, 2)}\n`);
  } else {
    const text = renderReport(report);
    stdout.write(`${text}\n`);
    if (summaryPath) {
      try {
        appendFileSync(summaryPath, `${text}\n`);
      } catch (err) {
        stderr.write(
          `[repo-settings] ⚠ could not write job summary: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  if (strict && drift) {
    stderr.write(`[repo-settings] ❌ drift detected (--strict)\n`);
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
