#!/usr/bin/env node
/**
 * check-runner-health.mjs
 *
 * Scheduled runner-fleet health monitor for mandrel-platform (Story #258).
 *
 * All nine self-hosted runners across the fleet (domio, athportal, swarm-os)
 * are co-resident on ONE operator Mac (2026-07-03 runner audit, repo-ops
 * matrix §1a). If that host sleeps, reboots for an OS update, fills its disk,
 * or a launchd service dies, every consumer's CI and deploy-trigger jobs
 * silently queue ("waiting for a runner") with no alert — nothing watches the
 * fleet today. This script is the standing check that closes that gap.
 *
 * Modeled on `check-pin-drift.mjs` (same GitHub-hosted, config-driven,
 * `GITHUB_STEP_SUMMARY`-rendering shape via the `scripts/lib/gh-json.mjs`
 * seam) with two differences: it must run FREQUENTLY (not weekly) and it must
 * ALERT (not just render a dashboard), because the whole point is catching an
 * offline fleet fast.
 *
 * For each repo in `scripts/runner-fleet-consumers.json` it:
 *   1. Calls `GET /repos/{owner}/{repo}/actions/runners` and flags any runner
 *      whose `status !== "online"`.
 *   2. Flags a count shortfall: fewer online runners matching the expected
 *      `labels` set than `expectedCount`.
 *   3. Flags queue-staleness: a `queued`/`waiting` workflow run older than
 *      `staleQueuedMinutes` with no online runner matching its labels
 *      (a wedged fleet accepts jobs into the queue but never claims them).
 *   4. Renders a per-repo dashboard to `GITHUB_STEP_SUMMARY`.
 *
 * Alerting (Story #258 acceptance criteria — no external dependency,
 * on-ethos default):
 *   - The CLI exits non-zero when any repo is unhealthy, so GitHub's native
 *     failed-workflow notification fires.
 *   - `syncTrackingIssues` upserts a single deduped tracking issue per
 *     unhealthy repo (`Runner fleet: <repo> degraded`) in the mandrel-platform
 *     repo (this repo — the fleet's operator lives here, not in each
 *     consumer), and auto-closes it when health recovers.
 *
 * GitHub access is via the `gh` CLI (`gh api`), through the same injectable
 * `runGh` seam `check-pin-drift.mjs` uses (`scripts/lib/gh-json.mjs`), so the
 * whole pipeline is exercised offline in tests with canned responses.
 *
 * Usage:
 *   node scripts/check-runner-health.mjs
 *   node scripts/check-runner-health.mjs --config scripts/runner-fleet-consumers.json
 *   node scripts/check-runner-health.mjs --json          # machine-readable envelope
 *   node scripts/check-runner-health.mjs --no-issues      # skip the tracking-issue upsert (local/dry runs)
 *
 * Exit codes:
 *   0 — every repo healthy.
 *   1 — at least one repo unhealthy (offline runner, count shortfall, stale
 *       queued run, or a fetch error), OR a fatal error (bad config).
 *
 * GitHub Actions: when GITHUB_STEP_SUMMARY is set, the human-readable report
 * is also appended there so it renders on the job summary page.
 */

import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { defaultGhRunner, ghApiJson, isNotFound } from "./lib/gh-json.mjs";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ config: string, json: boolean, noIssues: boolean, trackingRepo: string | null }}
 */
export function parseArgv(argv = []) {
  let config = "scripts/runner-fleet-consumers.json";
  let json = false;
  let noIssues = false;
  let trackingRepo = null;
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
    } else if (a === "--no-issues") {
      noIssues = true;
    } else if (a === "--tracking-repo") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        trackingRepo = next;
        i += 1;
      }
    }
  }
  return { config, json, noIssues, trackingRepo };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit-style probing without GitHub access)
// ---------------------------------------------------------------------------

/**
 * Does a runner's label set satisfy the expected label roster? A runner
 * "matches" when every expected label is present among the runner's labels
 * (order-independent, extra labels on the runner are fine).
 *
 * @param {string[]} runnerLabels
 * @param {string[]} expectedLabels
 * @returns {boolean}
 */
export function runnerMatchesLabels(runnerLabels, expectedLabels) {
  const have = new Set((runnerLabels || []).map((l) => l.toLowerCase()));
  return (expectedLabels || []).every((l) => have.has(l.toLowerCase()));
}

/**
 * Classify one repo's live runner list against its expected roster.
 *
 * @param {Array<{ id: number, name: string, status: string, busy?: boolean, labels: Array<{ name: string }> }>} runners
 * @param {{ expectedCount: number, labels: string[] }} expected
 * @returns {{
 *   total: number,
 *   online: number,
 *   offline: Array<{ id: number, name: string, status: string }>,
 *   matchingOnline: number,
 *   shortfall: number,
 *   hasShortfall: boolean,
 *   hasOffline: boolean,
 * }}
 */
export function classifyRunners(runners, expected) {
  const list = Array.isArray(runners) ? runners : [];
  const offline = list
    .filter((r) => r.status !== "online")
    .map((r) => ({ id: r.id, name: r.name, status: r.status }));
  const online = list.filter((r) => r.status === "online");
  const matchingOnline = online.filter((r) =>
    runnerMatchesLabels(
      (r.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
      expected.labels,
    ),
  ).length;
  const expectedCount =
    typeof expected.expectedCount === "number" ? expected.expectedCount : 0;
  const shortfall = Math.max(0, expectedCount - matchingOnline);
  return {
    total: list.length,
    online: online.length,
    offline,
    matchingOnline,
    shortfall,
    hasShortfall: shortfall > 0,
    hasOffline: offline.length > 0,
  };
}

/**
 * Is a workflow run "stuck in queue"? True when its status is `queued` or
 * `waiting`, it is older than `staleMinutes`, and no online runner in
 * `onlineLabelSets` matches every one of its `labels` (i.e. nothing could ever
 * pick it up).
 *
 * @param {{ status: string, created_at: string, labels?: string[] }} run  A workflow run summary (labels resolved from its job requirements when available).
 * @param {string[][]} onlineLabelSets  Each online runner's label list.
 * @param {number} staleMinutes
 * @param {number} [nowMs]  Injectable current epoch ms (for tests).
 * @returns {boolean}
 */
export function isStaleQueuedRun(run, onlineLabelSets, staleMinutes, nowMs = Date.now()) {
  if (run.status !== "queued" && run.status !== "waiting") return false;
  const createdMs = Date.parse(run.created_at);
  if (Number.isNaN(createdMs)) return false;
  const ageMinutes = (nowMs - createdMs) / 60000;
  if (ageMinutes < staleMinutes) return false;
  const runLabels = Array.isArray(run.labels) ? run.labels : [];
  if (runLabels.length === 0) {
    // No label info to match against — can't assert "nothing could pick this
    // up" without over-claiming, so don't flag it as stale from labels alone.
    return false;
  }
  const anyOnlineMatches = onlineLabelSets.some((labels) =>
    runnerMatchesLabels(labels, runLabels),
  );
  return !anyOnlineMatches;
}

/**
 * Combine the three health signals into a single per-repo health verdict.
 *
 * @param {ReturnType<typeof classifyRunners>} runnerVerdict
 * @param {Array<object>} staleRuns
 * @returns {boolean} true when the repo is healthy (no offline, no shortfall, no stale queued runs).
 */
export function isRepoHealthy(runnerVerdict, staleRuns) {
  return (
    !runnerVerdict.hasOffline &&
    !runnerVerdict.hasShortfall &&
    (!Array.isArray(staleRuns) || staleRuns.length === 0)
  );
}

/**
 * Render the human-readable dashboard report.
 *
 * @param {{
 *   results: Array<{
 *     name: string,
 *     repo: string,
 *     error?: string,
 *     verdict?: ReturnType<typeof classifyRunners>,
 *     staleRuns?: Array<{ id: number, html_url?: string, created_at: string }>,
 *     healthy?: boolean,
 *   }>,
 * }} report
 * @returns {string}
 */
export function renderReport(report) {
  const out = [];
  out.push("## Runner-fleet health dashboard");
  out.push("");
  out.push(
    "All self-hosted runners are co-resident on one operator Mac — a wedged " +
      "host silently stalls every listed repo's CI with no other alert.",
  );
  out.push("");
  out.push("| Repo | Online / Expected | Offline | Stale queued | Status |");
  out.push("| ---- | ------------------ | ------- | ------------- | ------ |");

  const problemLines = [];
  for (const r of report.results) {
    if (r.error) {
      out.push(`| \`${r.name}\` | — | — | — | ⚠️ error |`);
      problemLines.push(`- \`${r.name}\` (${r.repo}): error — ${r.error}`);
      continue;
    }
    const v = r.verdict;
    const stale = Array.isArray(r.staleRuns) ? r.staleRuns : [];
    const healthy = r.healthy === true;
    const status = healthy ? "✅ healthy" : "❌ degraded";
    out.push(
      `| \`${r.name}\` | ${v.matchingOnline}/${v.matchingOnline + v.shortfall} | ${v.offline.length} | ${stale.length} | ${status} |`,
    );
    if (!healthy) {
      if (v.hasOffline) {
        const names = v.offline.map((o) => `\`${o.name}\` (${o.status})`).join(", ");
        problemLines.push(
          `- \`${r.name}\` (${r.repo}): OFFLINE runner(s) — ${names}.`,
        );
      }
      if (v.hasShortfall) {
        problemLines.push(
          `- \`${r.name}\` (${r.repo}): SHORTFALL — ${v.matchingOnline} online runner(s) matching labels, expected at least ${v.matchingOnline + v.shortfall}.`,
        );
      }
      if (stale.length > 0) {
        const runs = stale
          .map((run) => (run.html_url ? `[#${run.id}](${run.html_url})` : `#${run.id}`))
          .join(", ");
        problemLines.push(
          `- \`${r.name}\` (${r.repo}): STALE QUEUED RUN(S) — ${runs} queued with no matching online runner.`,
        );
      }
    }
  }

  out.push("");
  if (problemLines.length > 0) {
    out.push("### Degraded");
    out.push("");
    out.push(...problemLines);
    out.push("");
    out.push(
      "**Operator response:** wake/reboot the Mac, check disk space, and " +
        "restart the launchd runner services. See " +
        "`templates/runbooks/runner-fleet-health.md`.",
    );
  } else {
    out.push("### ✅ Fleet healthy");
    out.push("");
    out.push("Every configured repo has its expected online runner count and no stale queued runs.");
  }
  out.push("");
  return out.join("\n");
}

/**
 * Build the tracking-issue title for a degraded repo (Story #258). Kept as a
 * pure helper so the upsert search and the create/close paths agree on the
 * exact dedup key.
 *
 * @param {string} repoName
 * @returns {string}
 */
export function trackingIssueTitle(repoName) {
  return `Runner fleet: ${repoName} degraded`;
}

// ---------------------------------------------------------------------------
// GitHub access — runners + workflow runs + tracking-issue upsert.
// ---------------------------------------------------------------------------

/**
 * Fetch a repo's live self-hosted runner list.
 *
 * @param {string} repo    "owner/name".
 * @param {(args: string[]) => string} runGh
 * @returns {Array<{ id: number, name: string, status: string, busy?: boolean, labels: Array<{ name: string }> }>}
 */
export function fetchRunners(repo, runGh) {
  let obj;
  try {
    obj = ghApiJson(`repos/${repo}/actions/runners?per_page=100`, runGh);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return Array.isArray(obj?.runners) ? obj.runners : [];
}

/**
 * Fetch a repo's currently queued/waiting workflow runs (for stale-queue
 * detection). Returns [] on a 404 (repo unreadable, or genuinely no runs);
 * any other error propagates so the caller records an `error` row.
 *
 * @param {string} repo
 * @param {(args: string[]) => string} runGh
 * @returns {Array<{ id: number, status: string, created_at: string, html_url?: string, labels?: string[] }>}
 */
export function fetchQueuedRuns(repo, runGh) {
  let obj;
  try {
    obj = ghApiJson(
      `repos/${repo}/actions/runs?status=queued&per_page=50`,
      runGh,
    );
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const queued = Array.isArray(obj?.workflow_runs) ? obj.workflow_runs : [];
  let waitingObj;
  try {
    waitingObj = ghApiJson(
      `repos/${repo}/actions/runs?status=waiting&per_page=50`,
      runGh,
    );
  } catch (err) {
    if (isNotFound(err)) return queued;
    throw err;
  }
  const waiting = Array.isArray(waitingObj?.workflow_runs)
    ? waitingObj.workflow_runs
    : [];
  return [...queued, ...waiting];
}

/**
 * Search the tracking repo for an existing OPEN issue matching the degraded
 * repo's dedup title. Returns the issue number, or null when none exists.
 *
 * @param {string} trackingRepo  "owner/name" of the repo tracking issues live in.
 * @param {string} title
 * @param {(args: string[]) => string} runGh
 * @returns {number | null}
 */
export function findOpenTrackingIssue(trackingRepo, title, runGh) {
  const q = `repo:${trackingRepo} is:issue is:open in:title "${title}"`;
  let obj;
  try {
    obj = ghApiJson(`search/issues?q=${encodeURIComponent(q)}`, runGh);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const items = Array.isArray(obj?.items) ? obj.items : [];
  const exact = items.find((it) => it.title === title);
  return exact ? exact.number : null;
}

/**
 * Search the tracking repo for an existing OPEN issue and close it (recovery
 * path). No-op when none is open.
 *
 * @param {string} trackingRepo
 * @param {string} title
 * @param {(args: string[]) => string} runGh
 * @returns {{ action: "closed" | "noop", issue: number | null }}
 */
export function closeTrackingIssueIfOpen(trackingRepo, title, runGh) {
  const issue = findOpenTrackingIssue(trackingRepo, title, runGh);
  if (issue === null) return { action: "noop", issue: null };
  runGh([
    "api",
    "-X",
    "PATCH",
    `repos/${trackingRepo}/issues/${issue}`,
    "-f",
    "state=closed",
  ]);
  runGh([
    "api",
    `repos/${trackingRepo}/issues/${issue}/comments`,
    "-f",
    "body=✅ Runner fleet recovered — auto-closing. See the latest `runner-fleet-health.yml` run for the healthy dashboard.",
  ]);
  return { action: "closed", issue };
}

/**
 * Upsert the deduped tracking issue for a degraded repo: update the body on an
 * existing open issue, or create a new one.
 *
 * @param {string} trackingRepo
 * @param {string} repoName
 * @param {string} bodyMarkdown
 * @param {(args: string[]) => string} runGh
 * @returns {{ action: "created" | "updated", issue: number }}
 */
export function upsertTrackingIssue(trackingRepo, repoName, bodyMarkdown, runGh) {
  const title = trackingIssueTitle(repoName);
  const existing = findOpenTrackingIssue(trackingRepo, title, runGh);
  if (existing !== null) {
    runGh([
      "api",
      "-X",
      "PATCH",
      `repos/${trackingRepo}/issues/${existing}`,
      "-f",
      `body=${bodyMarkdown}`,
    ]);
    return { action: "updated", issue: existing };
  }
  const raw = runGh([
    "api",
    `repos/${trackingRepo}/issues`,
    "-X",
    "POST",
    "-f",
    `title=${title}`,
    "-f",
    `body=${bodyMarkdown}`,
    "-f",
    "labels[]=ops::runner-fleet",
  ]);
  const created = JSON.parse(raw);
  return { action: "created", issue: created.number };
}

/**
 * Sync tracking issues for the fleet: upsert one for every unhealthy repo,
 * auto-close the ones for repos that recovered.
 *
 * @param {{ results: Array<{ name: string, repo: string, healthy?: boolean, error?: string }> }} report
 * @param {string} trackingRepo
 * @param {(args: string[]) => string} runGh
 * @returns {Array<{ repo: string, action: string, issue: number | null }>}
 */
export function syncTrackingIssues(report, trackingRepo, runGh) {
  const actions = [];
  for (const r of report.results) {
    const title = trackingIssueTitle(r.name);
    if (r.error || r.healthy === false) {
      const body = [
        `Auto-filed by \`runner-fleet-health.yml\` (Story #258).`,
        "",
        r.error
          ? `Health check errored for \`${r.repo}\`: ${r.error}`
          : renderReport({ results: [r] }),
        "",
        "See `templates/runbooks/runner-fleet-health.md` for the operator response.",
      ].join("\n");
      const result = upsertTrackingIssue(trackingRepo, r.name, body, runGh);
      actions.push({ repo: r.name, ...result });
    } else {
      const result = closeTrackingIssueIfOpen(trackingRepo, title, runGh);
      actions.push({ repo: r.name, ...result });
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the full health report for the configured repos.
 *
 * @param {{
 *   repos: Array<{ name: string, repo: string, expectedCount: number, labels: string[], staleQueuedMinutes?: number }>,
 *   defaultStaleQueuedMinutes?: number,
 * }} config
 * @param {(args: string[]) => string} runGh
 * @param {number} [nowMs]
 * @returns {{ results: Array<object> }}
 */
export function buildReport(config, runGh, nowMs = Date.now()) {
  const defaultStale =
    typeof config.defaultStaleQueuedMinutes === "number"
      ? config.defaultStaleQueuedMinutes
      : 20;
  const results = [];
  for (const entry of config.repos) {
    try {
      const runners = fetchRunners(entry.repo, runGh);
      const verdict = classifyRunners(runners, entry);
      const onlineLabelSets = runners
        .filter((r) => r.status === "online")
        .map((r) => (r.labels || []).map((l) => (typeof l === "string" ? l : l.name)));
      const staleMinutes =
        typeof entry.staleQueuedMinutes === "number"
          ? entry.staleQueuedMinutes
          : defaultStale;
      const queuedRuns = fetchQueuedRuns(entry.repo, runGh);
      const staleRuns = queuedRuns.filter((run) =>
        isStaleQueuedRun(run, onlineLabelSets, staleMinutes, nowMs),
      );
      results.push({
        name: entry.name,
        repo: entry.repo,
        verdict,
        staleRuns,
        healthy: isRepoHealthy(verdict, staleRuns),
      });
    } catch (err) {
      results.push({
        name: entry.name,
        repo: entry.repo,
        error: err instanceof Error ? err.message : String(err),
        healthy: false,
      });
    }
  }
  return { results };
}

/**
 * @param {{ results: Array<{ error?: string, healthy?: boolean }> }} report
 * @returns {boolean} true when any repo is unhealthy or errored.
 */
export function hasUnhealthy(report) {
  return report.results.some((r) => r.error || r.healthy === false);
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
 *   nowMs?: number,
 *   trackingRepo?: string,
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
  nowMs = Date.now(),
  trackingRepo = process.env.GITHUB_REPOSITORY || "dsj1984/mandrel-platform",
} = {}) {
  const { config: configRel, json, noIssues, trackingRepo: cliTrackingRepo } =
    parseArgv(argv);
  const configPath = resolve(cwd, configRel);
  const effectiveTrackingRepo = cliTrackingRepo || trackingRepo;

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    stderr.write(
      `[runner-health] ❌ failed to read config ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (!Array.isArray(config.repos)) {
    stderr.write(`[runner-health] ❌ config must define { repos: [] }\n`);
    return 1;
  }

  const report = buildReport(config, runGh, nowMs);
  const unhealthy = hasUnhealthy(report);

  if (json) {
    stdout.write(
      `${JSON.stringify({ kind: "runner-fleet-health-report", unhealthy, ...report }, null, 2)}\n`,
    );
  } else {
    const text = renderReport(report);
    stdout.write(`${text}\n`);
    if (summaryPath) {
      try {
        appendFileSync(summaryPath, `${text}\n`);
      } catch (err) {
        stderr.write(
          `[runner-health] ⚠ could not write job summary: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  if (!noIssues) {
    try {
      syncTrackingIssues(report, effectiveTrackingRepo, runGh);
    } catch (err) {
      stderr.write(
        `[runner-health] ⚠ tracking-issue sync failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (unhealthy) {
    stderr.write(`[runner-health] ❌ fleet degraded\n`);
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
