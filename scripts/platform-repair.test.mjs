#!/usr/bin/env node
/**
 * platform-repair.test.mjs — node:test suite for the scheduled platform-sync
 * repair-PR loop (Story #113).
 *
 * The loop reuses the detector (`check-pin-drift.mjs`) for drift classification
 * and shells out to `git` / `gh` / `platform-sync.mjs` only through injectable
 * seams, so the whole detect→repair pipeline is exercised offline with canned
 * GitHub responses — no network, no `gh` auth, no clones.
 *
 * Coverage:
 *   1. classifyRepairability — split/lagging/skew repairable; holding/error/
 *      no-drift/floating-only skipped.
 *   2. renderRepairPrBody — explains what drifted AND links the dashboard run.
 *   3. findOpenRepairPr / parsePrNumberFromUrl — idempotency primitives.
 *   4. runRepair (full pipeline) — opens a PR for a drifting consumer, UPDATES
 *      the existing PR on re-run (no duplicate), defers `holding`, and is
 *      read-only without a token + non-mutating under --dry-run.
 *
 * Run: node scripts/platform-repair.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  REPAIR_BRANCH,
  classifyRepairability,
  describeDrift,
  findOpenRepairPr,
  parseArgv,
  parsePrNumberFromUrl,
  renderRepairPrBody,
  renderRepairReport,
  runCli,
  runRepair,
} from "./platform-repair.mjs";

// ---------------------------------------------------------------------------
// parseArgv
// ---------------------------------------------------------------------------

test("parseArgv reads ref, dry-run, config, dashboard url, json", () => {
  const o = parseArgv([
    "--ref",
    "mandrel-platform-v1.2.3",
    "--dry-run",
    "--config",
    "alt.json",
    "--dashboard-run-url",
    "https://example/run/9",
    "--json",
  ]);
  assert.equal(o.ref, "mandrel-platform-v1.2.3");
  assert.equal(o.dryRun, true);
  assert.equal(o.config, "alt.json");
  assert.equal(o.dashboardRunUrl, "https://example/run/9");
  assert.equal(o.json, true);
});

test("parseArgv defaults", () => {
  const o = parseArgv([]);
  assert.equal(o.ref, null);
  assert.equal(o.dryRun, false);
  assert.equal(o.config, "scripts/pin-drift-consumers.json");
});

// ---------------------------------------------------------------------------
// classifyRepairability
// ---------------------------------------------------------------------------

test("classifyRepairability: split pin is repairable", () => {
  const r = classifyRepairability({
    drift: true,
    verdict: { splitPinned: true, lagState: "unknown", distinctRefs: ["a", "b"] },
  });
  assert.equal(r.repairable, true);
  assert.equal(r.reason, "drift");
});

test("classifyRepairability: lagging uses pin is repairable", () => {
  const r = classifyRepairability({
    drift: true,
    verdict: { splitPinned: false, lagState: "lagging", pinnedSha: "f".repeat(40) },
  });
  assert.equal(r.repairable, true);
});

test("classifyRepairability: surface skew is repairable", () => {
  const r = classifyRepairability({
    drift: true,
    verdict: { splitPinned: false, lagState: "current" },
    npm: { npmState: "lagging" },
    surfaceSkew: true,
  });
  assert.equal(r.repairable, true);
});

test("classifyRepairability: holding is deferred, not repaired", () => {
  const r = classifyRepairability({
    drift: false,
    holding: true,
    verdict: { lagState: "lagging" },
  });
  assert.equal(r.repairable, false);
  assert.equal(r.reason, "holding");
});

test("classifyRepairability: detector error is not repairable", () => {
  const r = classifyRepairability({ error: "boom", verdict: { lagState: "no-pins" } });
  assert.equal(r.repairable, false);
  assert.equal(r.reason, "error");
});

test("classifyRepairability: no drift is skipped", () => {
  const r = classifyRepairability({ drift: false, verdict: { lagState: "current" } });
  assert.equal(r.repairable, false);
  assert.equal(r.reason, "no-drift");
});

test("classifyRepairability: floating-ref-only (unknown, not split) is not auto-repairable", () => {
  const r = classifyRepairability({
    drift: true,
    verdict: { splitPinned: false, lagState: "unknown" },
    npm: { npmState: "absent" },
    surfaceSkew: false,
  });
  assert.equal(r.repairable, false);
  assert.equal(r.reason, "unknown-ref");
});

// ---------------------------------------------------------------------------
// describeDrift + renderRepairPrBody (Acceptance: body explains drift + links run)
// ---------------------------------------------------------------------------

test("describeDrift names split pin + surface skew", () => {
  const lines = describeDrift({
    verdict: { splitPinned: true, distinctRefs: ["a", "b", "c"] },
    npm: { npmState: "lagging", version: "0.11.3" },
    surfaceSkew: true,
  });
  assert.ok(lines.some((l) => l.includes("Split pin")));
  assert.ok(lines.some((l) => l.includes("Surface skew")));
});

test("renderRepairPrBody explains what drifted and links the dashboard run", () => {
  const body = renderRepairPrBody({
    name: "domio",
    repo: "dsj1984/domio",
    result: {
      verdict: { splitPinned: false, lagState: "lagging", pinnedSha: "a".repeat(40) },
      npm: { npmState: "current", version: "1.2.3" },
      surfaceSkew: false,
    },
    ref: "mandrel-platform-v1.2.3",
    targetSha: "b".repeat(40),
    dashboardRunUrl: "https://github.com/dsj1984/mandrel-platform/actions/runs/42",
  });
  // Criterion: body explains what drifted.
  assert.ok(body.includes("Release lag"), "names the drift class");
  assert.ok(body.includes("What drifted"));
  // Criterion: body links the pin-drift dashboard run.
  assert.ok(
    body.includes("https://github.com/dsj1984/mandrel-platform/actions/runs/42"),
    "links the dashboard run",
  );
  // Advisory posture: PR goes through consumer CI, no auto-merge.
  assert.ok(body.includes("advisory"));
  assert.ok(body.includes("mandrel-platform-v1.2.3"));
});

test("renderRepairPrBody falls back to the dashboard workflow when no run url", () => {
  const body = renderRepairPrBody({
    name: "x",
    repo: "o/x",
    result: { verdict: { splitPinned: true, distinctRefs: ["a", "b"] } },
    ref: "v1",
    targetSha: null,
    dashboardRunUrl: null,
  });
  assert.ok(body.includes("pin-drift.yml"));
});

// ---------------------------------------------------------------------------
// idempotency primitives
// ---------------------------------------------------------------------------

test("parsePrNumberFromUrl extracts the number from gh pr create output", () => {
  assert.equal(parsePrNumberFromUrl("https://github.com/o/r/pull/77\n"), 77);
  assert.equal(parsePrNumberFromUrl("no url here"), null);
});

test("findOpenRepairPr returns the open PR number for the repair head branch", () => {
  const runGh = (args) => {
    assert.deepEqual(
      args.slice(0, 8),
      ["pr", "list", "--repo", "o/r", "--head", REPAIR_BRANCH, "--state", "open"],
    );
    return JSON.stringify([{ number: 12 }]);
  };
  assert.equal(findOpenRepairPr("o/r", runGh), 12);
});

test("findOpenRepairPr returns null when no open repair PR exists", () => {
  assert.equal(findOpenRepairPr("o/r", () => "[]"), null);
});

// ---------------------------------------------------------------------------
// Full pipeline (runRepair) with injected seams
// ---------------------------------------------------------------------------

const PLATFORM_REPO = "dsj1984/mandrel-platform";
const LATEST_SHA = "b".repeat(40);
const STALE_SHA = "a".repeat(40);

/**
 * Build an injectable `gh` runner that answers the detector's API calls plus the
 * repair loop's PR list/create/edit. `openPrs` maps repo → existing open repair
 * PR number (or undefined for none). Records create/edit calls in `calls`.
 */
function makeGh({ consumerWorkflow, npmVersion, openPrs = {}, calls }) {
  return (args) => {
    const path = args[1];
    // ---- detector (check-pin-drift) API surface ----
    if (args[0] === "api") {
      if (path === `repos/${PLATFORM_REPO}/releases/latest`) {
        return JSON.stringify({
          tag_name: "mandrel-platform-v1.2.3",
          published_at: "2020-01-01T00:00:00Z", // ancient → past the hold window
        });
      }
      if (path === `repos/${PLATFORM_REPO}/git/ref/tags/mandrel-platform-v1.2.3`) {
        return JSON.stringify({ object: { sha: LATEST_SHA, type: "commit" } });
      }
      if (/\/contents\/\.github\/workflows/.test(path)) {
        return JSON.stringify([
          { type: "file", name: "ci.yml", content: Buffer.from(consumerWorkflow).toString("base64"), encoding: "base64" },
        ]);
      }
      if (/\/contents\/package\.json/.test(path)) {
        const pkg = JSON.stringify({ devDependencies: { "mandrel-platform": npmVersion } });
        return JSON.stringify({ encoding: "base64", content: Buffer.from(pkg).toString("base64") });
      }
      if (/^repos\/[^/]+\/[^/]+$/.test(path)) {
        return JSON.stringify({ default_branch: "main" });
      }
      throw new Error(`unexpected gh api path: ${path}`);
    }
    // ---- repair loop PR surface ----
    if (args[0] === "pr" && args[1] === "list") {
      const repo = args[args.indexOf("--repo") + 1];
      const n = openPrs[repo];
      return JSON.stringify(n ? [{ number: n }] : []);
    }
    if (args[0] === "pr" && args[1] === "create") {
      calls.push({ kind: "create", args });
      const repo = args[args.indexOf("--repo") + 1];
      return `https://github.com/${repo}/pull/101\n`;
    }
    if (args[0] === "pr" && args[1] === "edit") {
      calls.push({ kind: "edit", args });
      return "";
    }
    if (args[0] === "repo" && args[1] === "view") {
      return "main\n";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

const noopGit = () => "";

/** A minimal write-sink that records everything written, for stdout/stderr. */
function capture() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join("") };
}

function laggingConfig() {
  return {
    platformRepo: PLATFORM_REPO,
    minimumReleaseAge: "3 days",
    consumers: [{ name: "domio", repo: "dsj1984/domio" }],
  };
}

// A consumer workflow pinning the STALE platform SHA → lagging drift.
const STALE_WORKFLOW = [
  "jobs:",
  "  q:",
  "    steps:",
  `      - uses: ${PLATFORM_REPO}/.github/workflows/pr-quality.yml@${STALE_SHA}`,
].join("\n");

test("runRepair opens a repair PR for a lagging consumer (live, token present)", () => {
  const calls = [];
  const runGh = makeGh({ consumerWorkflow: STALE_WORKFLOW, npmVersion: "1.2.3", calls });
  const report = runRepair({
    config: laggingConfig(),
    ref: null,
    dryRun: false,
    dashboardRunUrl: "https://example/run/5",
    token: "ghp_fake",
    templates: null,
    runGh,
    runGit: noopGit,
    runSync: () => ({ changed: true, pins: [{ file: ".github/workflows/ci.yml" }] }),
    workRoot: "/tmp/does-not-matter", // noopGit never touches disk
  });
  const row = report.rows.find((r) => r.name === "domio");
  assert.equal(row.action, "opened");
  assert.equal(row.prNumber, 101);
  assert.equal(calls.filter((c) => c.kind === "create").length, 1);
  // The created PR body links the dashboard run.
  const createCall = calls.find((c) => c.kind === "create");
  const body = createCall.args[createCall.args.indexOf("--body") + 1];
  assert.ok(body.includes("https://example/run/5"));
  assert.ok(body.includes("Release lag"));
});

test("runRepair UPDATES an existing repair PR instead of opening a duplicate (idempotent)", () => {
  const calls = [];
  const runGh = makeGh({
    consumerWorkflow: STALE_WORKFLOW,
    npmVersion: "1.2.3",
    openPrs: { "dsj1984/domio": 55 },
    calls,
  });
  const report = runRepair({
    config: laggingConfig(),
    ref: null,
    dryRun: false,
    dashboardRunUrl: null,
    token: "ghp_fake",
    templates: null,
    runGh,
    runGit: noopGit,
    runSync: () => ({ changed: true, pins: [{ file: "x" }] }),
    workRoot: "/tmp/x",
  });
  const row = report.rows.find((r) => r.name === "domio");
  assert.equal(row.action, "updated");
  assert.equal(row.prNumber, 55);
  assert.equal(calls.filter((c) => c.kind === "create").length, 0, "no duplicate PR created");
  assert.equal(calls.filter((c) => c.kind === "edit").length, 1, "existing PR edited");
});

test("runRepair is read-only without a token (reports would-open, no git/gh mutation)", () => {
  const calls = [];
  const runGh = makeGh({ consumerWorkflow: STALE_WORKFLOW, npmVersion: "1.2.3", calls });
  let gitCalled = false;
  const report = runRepair({
    config: laggingConfig(),
    ref: null,
    dryRun: false,
    dashboardRunUrl: null,
    token: null,
    templates: null,
    runGh,
    runGit: () => {
      gitCalled = true;
      return "";
    },
    runSync: () => {
      throw new Error("sync must not run without a token");
    },
  });
  const row = report.rows.find((r) => r.name === "domio");
  assert.equal(row.action, "skipped-no-token");
  assert.equal(gitCalled, false);
  assert.equal(report.hasToken, false);
  assert.equal(calls.filter((c) => c.kind === "create").length, 0);
});

test("runRepair --dry-run plans without cloning, syncing, or opening a PR", () => {
  const calls = [];
  const runGh = makeGh({ consumerWorkflow: STALE_WORKFLOW, npmVersion: "1.2.3", calls });
  let mutated = false;
  const report = runRepair({
    config: laggingConfig(),
    ref: null,
    dryRun: true,
    dashboardRunUrl: null,
    token: "ghp_fake",
    templates: null,
    runGh,
    runGit: () => {
      mutated = true;
      return "";
    },
    runSync: () => {
      mutated = true;
      return { changed: true };
    },
  });
  const row = report.rows.find((r) => r.name === "domio");
  assert.equal(row.action, "planned");
  assert.equal(mutated, false, "dry-run must not clone or sync");
  assert.equal(calls.filter((c) => c.kind === "create").length, 0);
});

test("runRepair defers a holding consumer (fresh release inside the hold window)", () => {
  // published_at is "now" → inside the 3-day window → holding, not drift.
  const runGh = (args) => {
    const path = args[1];
    if (path === `repos/${PLATFORM_REPO}/releases/latest`) {
      return JSON.stringify({
        tag_name: "mandrel-platform-v1.2.3",
        published_at: new Date().toISOString(),
      });
    }
    if (path === `repos/${PLATFORM_REPO}/git/ref/tags/mandrel-platform-v1.2.3`) {
      return JSON.stringify({ object: { sha: LATEST_SHA, type: "commit" } });
    }
    if (/\/contents\/\.github\/workflows/.test(path)) {
      return JSON.stringify([
        { type: "file", name: "ci.yml", content: Buffer.from(STALE_WORKFLOW).toString("base64"), encoding: "base64" },
      ]);
    }
    if (/\/contents\/package\.json/.test(path)) {
      const pkg = JSON.stringify({ devDependencies: { "mandrel-platform": "1.2.3" } });
      return JSON.stringify({ encoding: "base64", content: Buffer.from(pkg).toString("base64") });
    }
    if (/^repos\/[^/]+\/[^/]+$/.test(path)) return JSON.stringify({ default_branch: "main" });
    throw new Error(`unexpected: ${path}`);
  };
  const report = runRepair({
    config: laggingConfig(),
    ref: null,
    dryRun: false,
    dashboardRunUrl: null,
    token: "ghp_fake",
    templates: null,
    runGh,
    runGit: () => {
      throw new Error("must not clone a holding consumer");
    },
    runSync: () => {
      throw new Error("must not sync a holding consumer");
    },
  });
  const row = report.rows.find((r) => r.name === "domio");
  assert.equal(row.action, "holding");
});

// ---------------------------------------------------------------------------
// renderRepairReport
// ---------------------------------------------------------------------------

test("renderRepairReport tabulates outcomes and a repaired section", () => {
  const text = renderRepairReport({
    ref: "mandrel-platform-v1.2.3",
    targetSha: LATEST_SHA,
    dryRun: false,
    hasToken: true,
    rows: [
      { name: "domio", repo: "dsj1984/domio", action: "opened", prNumber: 101 },
      { name: "athportal", repo: "dsj1984/athportal", action: "holding", prNumber: null },
    ],
  });
  assert.ok(text.includes("platform-sync repair loop"));
  assert.ok(text.includes("domio"));
  assert.ok(text.includes("Repaired (1)"));
  assert.ok(text.includes("#101"));
});

// ---------------------------------------------------------------------------
// M11 — provided-but-dead read credential vs. not-yet-provisioned bootstrap.
// The repair loop reads consumers with the SAME cross-repo PAT the dashboard
// uses (PIN_DRIFT_TOKEN → GH_TOKEN). When that PAT is provided-but-dead every
// detector row errors → every consumer classifies `error`/repairable-false,
// which otherwise renders a reassuring green "no repairable drift". runCli must
// hard-fail on that when the token was provided, and stay exit-0 when it was
// absent (bootstrap). Mirrors scripts/check-runner-health.mjs error-row
// handling. (temp/audits/workflow-robustness-review-2026-07-05.md M11)
// ---------------------------------------------------------------------------

/**
 * A gh runner where the platform's own release resolution succeeds but EVERY
 * cross-repo consumer read fails non-404 (auth/transport) — the shape of a dead
 * cross-repo PAT. No PR surface is reached because every consumer errors out
 * before repair.
 */
function makeAllConsumersFailGh() {
  return (args) => {
    const path = args[1];
    if (args[0] !== "api") {
      throw new Error(`unexpected non-api gh call under dead credential: ${args.join(" ")}`);
    }
    if (path === `repos/${PLATFORM_REPO}/releases/latest`) {
      return JSON.stringify({ tag_name: "mandrel-platform-v1.2.3", published_at: "2020-01-01T00:00:00Z" });
    }
    if (path === `repos/${PLATFORM_REPO}/git/ref/tags/mandrel-platform-v1.2.3`) {
      return JSON.stringify({ object: { sha: LATEST_SHA, type: "commit" } });
    }
    if (/\/contents\/\.github\/workflows/.test(path)) {
      // 403 (not 404) → fail-closed error row, mirroring an expired PAT.
      const err = new Error("gh: Forbidden (HTTP 403)");
      err.stderr = "gh: Forbidden (HTTP 403)\n";
      throw err;
    }
    if (/^repos\/[^/]+\/[^/]+$/.test(path)) {
      return JSON.stringify({ default_branch: "main" });
    }
    throw new Error(`unexpected gh api path: ${path}`);
  };
}

function deadCredConfigFile() {
  const dir = mkdtempSync(join(tmpdir(), "platform-repair-dead-"));
  const p = join(dir, "consumers.json");
  writeFileSync(
    p,
    JSON.stringify({
      platformRepo: PLATFORM_REPO,
      consumers: [
        { name: "domio", repo: "dsj1984/domio" },
        { name: "athportal", repo: "dsj1984/athportal" },
      ],
    }),
  );
  return { dir, p };
}

test("runCli: PROVIDED-but-dead PIN_DRIFT_TOKEN (every consumer read errors) exits 1 with ::error::", () => {
  const { dir, p } = deadCredConfigFile();
  const stderr = capture();
  try {
    const code = runCli({
      argv: ["--config", p],
      env: { PIN_DRIFT_TOKEN: "ghp_expired" },
      runGh: makeAllConsumersFailGh(),
      runGit: noopGit,
      runSync: () => {
        throw new Error("must not sync under a dead credential");
      },
      stdout: capture(),
      stderr,
      summaryPath: undefined,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /::error::/);
    assert.match(stderr.text(), /credential is dead/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli: ABSENT PIN_DRIFT_TOKEN bootstrap (every consumer read errors, token unset) stays exit 0", () => {
  const { dir, p } = deadCredConfigFile();
  try {
    const code = runCli({
      argv: ["--config", p],
      env: {}, // PIN_DRIFT_TOKEN absent → not-yet-provisioned bootstrap.
      runGh: makeAllConsumersFailGh(),
      runGit: noopGit,
      runSync: () => {
        throw new Error("must not sync during bootstrap");
      },
      stdout: capture(),
      stderr: capture(),
      summaryPath: undefined,
    });
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
