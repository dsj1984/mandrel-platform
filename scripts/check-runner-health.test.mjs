#!/usr/bin/env node
/**
 * check-runner-health.test.mjs — node:test suite for the scheduled
 * runner-fleet health monitor (Story #258).
 *
 * The checker exposes pure helpers plus an injectable `runGh` seam, so the
 * whole pipeline is exercised offline with canned GitHub responses — no
 * network, no `gh` auth.
 *
 * Run: node scripts/check-runner-health.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildReport,
  classifyRunners,
  closeTrackingIssueIfOpen,
  fetchQueuedRuns,
  fetchRunners,
  findOpenTrackingIssue,
  hasUnhealthy,
  isRepoHealthy,
  isStaleQueuedRun,
  parseArgv,
  renderReport,
  runCli,
  runnerMatchesLabels,
  syncTrackingIssues,
  trackingIssueTitle,
  upsertTrackingIssue,
} from "./check-runner-health.mjs";

// ---------------------------------------------------------------------------
// parseArgv
// ---------------------------------------------------------------------------

test("parseArgv defaults to the fleet consumer config", () => {
  const opts = parseArgv([]);
  assert.equal(opts.config, "scripts/runner-fleet-consumers.json");
  assert.equal(opts.json, false);
  assert.equal(opts.noIssues, false);
  assert.equal(opts.trackingRepo, null);
});

test("parseArgv parses --config, --json, --no-issues, --tracking-repo", () => {
  const opts = parseArgv([
    "--config",
    "custom.json",
    "--json",
    "--no-issues",
    "--tracking-repo",
    "acme/ops",
  ]);
  assert.equal(opts.config, "custom.json");
  assert.equal(opts.json, true);
  assert.equal(opts.noIssues, true);
  assert.equal(opts.trackingRepo, "acme/ops");
});

// ---------------------------------------------------------------------------
// runnerMatchesLabels
// ---------------------------------------------------------------------------

test("runnerMatchesLabels is case-insensitive and order-independent", () => {
  assert.equal(
    runnerMatchesLabels(["Self-Hosted", "macOS", "ARM64", "domio-runner"], [
      "self-hosted",
      "arm64",
    ]),
    true,
  );
});

test("runnerMatchesLabels fails when an expected label is missing", () => {
  assert.equal(
    runnerMatchesLabels(["self-hosted", "macOS"], ["self-hosted", "ARM64"]),
    false,
  );
});

// ---------------------------------------------------------------------------
// classifyRunners
// ---------------------------------------------------------------------------

const EXPECTED = { expectedCount: 3, labels: ["self-hosted", "macOS", "ARM64", "domio-runner"] };

test("classifyRunners reports a fully healthy fleet", () => {
  const runners = [1, 2, 3].map((n) => ({
    id: n,
    name: `domio-runner-${n}`,
    status: "online",
    labels: [{ name: "self-hosted" }, { name: "macOS" }, { name: "ARM64" }, { name: "domio-runner" }],
  }));
  const v = classifyRunners(runners, EXPECTED);
  assert.equal(v.total, 3);
  assert.equal(v.online, 3);
  assert.equal(v.matchingOnline, 3);
  assert.equal(v.shortfall, 0);
  assert.equal(v.hasShortfall, false);
  assert.equal(v.hasOffline, false);
});

test("classifyRunners flags an offline runner", () => {
  const runners = [
    { id: 1, name: "domio-runner-1", status: "online", labels: [{ name: "self-hosted" }, { name: "macOS" }, { name: "ARM64" }, { name: "domio-runner" }] },
    { id: 2, name: "domio-runner-2", status: "offline", labels: [{ name: "self-hosted" }, { name: "macOS" }, { name: "ARM64" }, { name: "domio-runner" }] },
  ];
  const v = classifyRunners(runners, EXPECTED);
  assert.equal(v.hasOffline, true);
  assert.equal(v.offline.length, 1);
  assert.equal(v.offline[0].name, "domio-runner-2");
  assert.equal(v.matchingOnline, 1);
  assert.equal(v.hasShortfall, true);
  assert.equal(v.shortfall, 2);
});

test("classifyRunners flags a count shortfall even with all-online but wrong labels", () => {
  const runners = [
    { id: 1, name: "other-runner", status: "online", labels: [{ name: "self-hosted" }, { name: "linux" }] },
  ];
  const v = classifyRunners(runners, EXPECTED);
  assert.equal(v.hasOffline, false);
  assert.equal(v.matchingOnline, 0);
  assert.equal(v.hasShortfall, true);
  assert.equal(v.shortfall, 3);
});

test("classifyRunners handles an empty runner list", () => {
  const v = classifyRunners([], EXPECTED);
  assert.equal(v.total, 0);
  assert.equal(v.hasShortfall, true);
  assert.equal(v.shortfall, 3);
});

// ---------------------------------------------------------------------------
// isStaleQueuedRun
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-07-03T12:00:00Z");

test("isStaleQueuedRun flags an old queued run with no matching online runner", () => {
  const run = {
    status: "queued",
    created_at: "2026-07-03T11:00:00Z", // 60 min ago
    labels: ["self-hosted", "macOS", "ARM64", "domio-runner"],
  };
  assert.equal(isStaleQueuedRun(run, [], 20, NOW), true);
});

test("isStaleQueuedRun does not flag a recently queued run", () => {
  const run = {
    status: "queued",
    created_at: "2026-07-03T11:55:00Z", // 5 min ago
    labels: ["self-hosted", "macOS", "ARM64", "domio-runner"],
  };
  assert.equal(isStaleQueuedRun(run, [], 20, NOW), false);
});

test("isStaleQueuedRun does not flag when a matching online runner exists", () => {
  const run = {
    status: "queued",
    created_at: "2026-07-03T11:00:00Z",
    labels: ["self-hosted", "macOS", "ARM64", "domio-runner"],
  };
  const onlineLabelSets = [["self-hosted", "macOS", "ARM64", "domio-runner"]];
  assert.equal(isStaleQueuedRun(run, onlineLabelSets, 20, NOW), false);
});

test("isStaleQueuedRun ignores non-queued/waiting runs", () => {
  const run = { status: "completed", created_at: "2026-07-03T09:00:00Z" };
  assert.equal(isStaleQueuedRun(run, [], 20, NOW), false);
});

test("isStaleQueuedRun does not flag when no label info is available", () => {
  const run = { status: "queued", created_at: "2026-07-03T09:00:00Z", labels: [] };
  assert.equal(isStaleQueuedRun(run, [], 20, NOW), false);
});

// ---------------------------------------------------------------------------
// isRepoHealthy
// ---------------------------------------------------------------------------

test("isRepoHealthy is true only with no offline/shortfall/stale", () => {
  const healthyVerdict = { hasOffline: false, hasShortfall: false };
  assert.equal(isRepoHealthy(healthyVerdict, []), true);
  assert.equal(isRepoHealthy({ ...healthyVerdict, hasOffline: true }, []), false);
  assert.equal(isRepoHealthy({ ...healthyVerdict, hasShortfall: true }, []), false);
  assert.equal(isRepoHealthy(healthyVerdict, [{ id: 1 }]), false);
});

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

test("renderReport renders a healthy fleet with no Degraded section", () => {
  const report = {
    results: [
      {
        name: "domio",
        repo: "dsj1984/domio",
        verdict: { matchingOnline: 3, shortfall: 0, offline: [], hasOffline: false, hasShortfall: false },
        staleRuns: [],
        healthy: true,
      },
    ],
  };
  const text = renderReport(report);
  assert.match(text, /✅ healthy/);
  assert.match(text, /✅ Fleet healthy/);
  assert.doesNotMatch(text, /### Degraded/);
});

test("renderReport surfaces offline / shortfall / stale-run detail lines", () => {
  const report = {
    results: [
      {
        name: "domio",
        repo: "dsj1984/domio",
        verdict: {
          matchingOnline: 1,
          shortfall: 2,
          offline: [{ id: 2, name: "domio-runner-2", status: "offline" }],
          hasOffline: true,
          hasShortfall: true,
        },
        staleRuns: [{ id: 42, html_url: "https://github.com/dsj1984/domio/actions/runs/42", created_at: "x" }],
        healthy: false,
      },
    ],
  };
  const text = renderReport(report);
  assert.match(text, /❌ degraded/);
  assert.match(text, /OFFLINE runner\(s\)/);
  assert.match(text, /SHORTFALL/);
  assert.match(text, /STALE QUEUED RUN/);
  assert.match(text, /### Degraded/);
  assert.match(text, /templates\/runbooks\/runner-fleet-health\.md/);
});

test("renderReport surfaces a fetch error row", () => {
  const report = { results: [{ name: "domio", repo: "dsj1984/domio", error: "boom" }] };
  const text = renderReport(report);
  assert.match(text, /⚠️ error/);
  assert.match(text, /error — boom/);
});

// ---------------------------------------------------------------------------
// trackingIssueTitle
// ---------------------------------------------------------------------------

test("trackingIssueTitle is the exact dedup key", () => {
  assert.equal(trackingIssueTitle("domio"), "Runner fleet: domio degraded");
});

// ---------------------------------------------------------------------------
// fetchRunners / fetchQueuedRuns (injectable runGh)
// ---------------------------------------------------------------------------

test("fetchRunners returns the runners array from the API response", () => {
  const runGh = () =>
    JSON.stringify({ total_count: 1, runners: [{ id: 1, name: "r1", status: "online", labels: [] }] });
  const runners = fetchRunners("dsj1984/domio", runGh);
  assert.equal(runners.length, 1);
  assert.equal(runners[0].name, "r1");
});

test("fetchRunners returns [] on a 404", () => {
  const runGh = () => {
    const err = new Error("gh: Not Found (HTTP 404)");
    throw err;
  };
  assert.deepEqual(fetchRunners("dsj1984/domio", runGh), []);
});

test("fetchRunners propagates a non-404 error", () => {
  const runGh = () => {
    throw new Error("gh: Forbidden (HTTP 403)");
  };
  assert.throws(() => fetchRunners("dsj1984/domio", runGh));
});

test("fetchQueuedRuns merges queued and waiting runs", () => {
  const runGh = (args) => {
    const path = args[1];
    if (path.includes("status=queued")) {
      return JSON.stringify({ workflow_runs: [{ id: 1, status: "queued", created_at: "x" }] });
    }
    if (path.includes("status=waiting")) {
      return JSON.stringify({ workflow_runs: [{ id: 2, status: "waiting", created_at: "y" }] });
    }
    throw new Error(`unexpected path ${path}`);
  };
  const runs = fetchQueuedRuns("dsj1984/domio", runGh);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.id).sort(), [1, 2]);
});

test("fetchQueuedRuns returns [] on a 404", () => {
  const runGh = () => {
    throw new Error("gh: Not Found (HTTP 404)");
  };
  assert.deepEqual(fetchQueuedRuns("dsj1984/domio", runGh), []);
});

// ---------------------------------------------------------------------------
// Tracking-issue upsert / close
// ---------------------------------------------------------------------------

test("findOpenTrackingIssue returns the exact-title match's number", () => {
  const runGh = () =>
    JSON.stringify({ items: [{ number: 7, title: "Runner fleet: domio degraded" }] });
  const n = findOpenTrackingIssue("dsj1984/mandrel-platform", "Runner fleet: domio degraded", runGh);
  assert.equal(n, 7);
});

test("findOpenTrackingIssue returns null when no exact-title match exists", () => {
  const runGh = () => JSON.stringify({ items: [] });
  const n = findOpenTrackingIssue("dsj1984/mandrel-platform", "Runner fleet: domio degraded", runGh);
  assert.equal(n, null);
});

test("upsertTrackingIssue creates a new issue when none is open", () => {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args[1] === "search/issues?q=repo%3Adsj1984%2Fmandrel-platform%20is%3Aissue%20is%3Aopen%20in%3Atitle%20%22Runner%20fleet%3A%20domio%20degraded%22") {
      return JSON.stringify({ items: [] });
    }
    if (args.includes("repos/dsj1984/mandrel-platform/issues") && args.includes("-X") === false) {
      return JSON.stringify({ number: 99 });
    }
    return JSON.stringify({ number: 99 });
  };
  const result = upsertTrackingIssue("dsj1984/mandrel-platform", "domio", "body text", runGh);
  assert.equal(result.action, "created");
  assert.equal(result.issue, 99);
});

test("upsertTrackingIssue updates the existing open issue's body", () => {
  const runGh = (args) => {
    if (args[1] && args[1].startsWith("search/issues")) {
      return JSON.stringify({ items: [{ number: 5, title: "Runner fleet: domio degraded" }] });
    }
    return "";
  };
  const result = upsertTrackingIssue("dsj1984/mandrel-platform", "domio", "body text", runGh);
  assert.equal(result.action, "updated");
  assert.equal(result.issue, 5);
});

test("closeTrackingIssueIfOpen closes an open issue and no-ops when none exists", () => {
  let closed = false;
  const runGhWithOpen = (args) => {
    if (args[1] && args[1].startsWith("search/issues")) {
      return JSON.stringify({ items: [{ number: 5, title: "Runner fleet: domio degraded" }] });
    }
    if (args.includes("-X") && args.includes("PATCH")) {
      closed = true;
      return "";
    }
    return "";
  };
  const result = closeTrackingIssueIfOpen("dsj1984/mandrel-platform", "Runner fleet: domio degraded", runGhWithOpen);
  assert.equal(result.action, "closed");
  assert.equal(result.issue, 5);
  assert.equal(closed, true);

  const runGhNoOpen = () => JSON.stringify({ items: [] });
  const noop = closeTrackingIssueIfOpen("dsj1984/mandrel-platform", "Runner fleet: domio degraded", runGhNoOpen);
  assert.equal(noop.action, "noop");
  assert.equal(noop.issue, null);
});

test("syncTrackingIssues upserts for unhealthy repos and closes for recovered ones", () => {
  const report = {
    results: [
      {
        name: "domio",
        repo: "dsj1984/domio",
        healthy: false,
        verdict: { matchingOnline: 1, shortfall: 2, offline: [], hasOffline: false, hasShortfall: true },
        staleRuns: [],
      },
      { name: "athportal", repo: "dsj1984/athportal", healthy: true },
    ],
  };
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args[1] && args[1].startsWith("search/issues")) {
      return JSON.stringify({ items: [] });
    }
    if (args.includes("repos/dsj1984/mandrel-platform/issues")) {
      return JSON.stringify({ number: 11 });
    }
    return "";
  };
  const actions = syncTrackingIssues(report, "dsj1984/mandrel-platform", runGh);
  assert.equal(actions.length, 2);
  const domioAction = actions.find((a) => a.repo === "domio");
  const athportalAction = actions.find((a) => a.repo === "athportal");
  assert.equal(domioAction.action, "created");
  assert.equal(athportalAction.action, "noop");
});

// ---------------------------------------------------------------------------
// buildReport / hasUnhealthy
// ---------------------------------------------------------------------------

const CONFIG = {
  defaultStaleQueuedMinutes: 20,
  repos: [
    { name: "domio", repo: "dsj1984/domio", expectedCount: 2, labels: ["self-hosted", "domio-runner"] },
  ],
};

test("buildReport marks a repo healthy when runners are all online and matching", () => {
  const runGh = (args) => {
    const path = args[1];
    if (path.includes("actions/runners")) {
      return JSON.stringify({
        runners: [
          { id: 1, name: "r1", status: "online", labels: [{ name: "self-hosted" }, { name: "domio-runner" }] },
          { id: 2, name: "r2", status: "online", labels: [{ name: "self-hosted" }, { name: "domio-runner" }] },
        ],
      });
    }
    if (path.includes("actions/runs")) {
      return JSON.stringify({ workflow_runs: [] });
    }
    throw new Error(`unexpected ${path}`);
  };
  const report = buildReport(CONFIG, runGh, NOW);
  assert.equal(report.results[0].healthy, true);
  assert.equal(hasUnhealthy(report), false);
});

test("buildReport marks a repo unhealthy and records a fetch error as unhealthy", () => {
  const runGh = (args) => {
    const path = args[1];
    if (path.includes("actions/runners")) throw new Error("gh: Service Unavailable (HTTP 503)");
    return "{}";
  };
  const report = buildReport(CONFIG, runGh, NOW);
  assert.equal(report.results[0].error !== undefined, true);
  assert.equal(hasUnhealthy(report), true);
});

// ---------------------------------------------------------------------------
// runCli (end-to-end against a temp config + injected runGh)
// ---------------------------------------------------------------------------

test("runCli exits 0 for a healthy fleet and 1 for a degraded one", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-health-cli-"));
  try {
    const configPath = join(dir, "runner-fleet-consumers.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultStaleQueuedMinutes: 20,
        repos: [
          { name: "domio", repo: "dsj1984/domio", expectedCount: 2, labels: ["self-hosted", "domio-runner"] },
        ],
      }),
    );
    const stdout = { buf: "", write(s) { this.buf += s; } };
    const stderr = { buf: "", write(s) { this.buf += s; } };
    const healthyRunGh = (args) => {
      const path = args[1];
      if (path.includes("actions/runners")) {
        return JSON.stringify({
          runners: [
            { id: 1, name: "r1", status: "online", labels: [{ name: "self-hosted" }, { name: "domio-runner" }] },
            { id: 2, name: "r2", status: "online", labels: [{ name: "self-hosted" }, { name: "domio-runner" }] },
          ],
        });
      }
      if (path.includes("actions/runs")) return JSON.stringify({ workflow_runs: [] });
      throw new Error(`unexpected ${path}`);
    };
    const code = runCli({
      argv: ["--config", configPath, "--no-issues"],
      cwd: process.cwd(),
      stdout,
      stderr,
      runGh: healthyRunGh,
      summaryPath: undefined,
      nowMs: NOW,
    });
    assert.equal(code, 0);
    assert.match(stdout.buf, /Fleet healthy|Runner-fleet health dashboard/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli returns 1 on a bad config path", () => {
  const stdout = { buf: "", write(s) { this.buf += s; } };
  const stderr = { buf: "", write(s) { this.buf += s; } };
  const code = runCli({
    argv: ["--config", "scripts/does-not-exist.json"],
    cwd: process.cwd(),
    stdout,
    stderr,
    runGh: () => "{}",
  });
  assert.equal(code, 1);
  assert.match(stderr.buf, /failed to read config/);
});
