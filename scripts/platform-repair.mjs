#!/usr/bin/env node
/**
 * platform-repair.mjs — scheduled platform-sync repair-PR loop (Story #113).
 *
 * Closes the detect→repair gap. `check-pin-drift.mjs` (Story #67/#107) *detects*
 * cross-consumer pin drift — split pins, release lag, npm lag, and npm/`uses:`
 * surface skew — and renders a dashboard, but drift was only ever *seen*, never
 * *fixed*: `platform-sync.mjs` (MP-14) repairs a consumer but is run by hand.
 * This script is the standing job that joins the two: it reads the detector's
 * verdict and, for every consumer carrying **repairable** drift, clones the
 * consumer, runs `platform-sync` to repair it, and opens (or updates) a single
 * idempotent **repair PR** against that consumer.
 *
 * DESIGN DECISION (settled, Story #113 / roadmap §4.2): auto-open repair PRs
 * rather than escalate pin-drift to a hard gate. A hard gate can red-line a
 * consumer's `main` for drift caused by a *fresh platform release* (the
 * consumer's Renovate hold has simply not fired yet — not the consumer's
 * fault), whereas a repair PR is self-healing and keeps the signal advisory.
 * `pin-drift.yml` is unchanged and stays advisory.
 *
 * REPAIRABLE vs. NOT:
 *   - REPAIRABLE → split pin, `uses:` lagging, npm lagging, surface skew. These
 *     are exactly the states `platform-sync --ref <latest>` rewrites: it pins
 *     every first-party `uses:` to the latest release SHA, reconciles the npm
 *     dep is out of scope for the sync (npm is bumped by Renovate), but the
 *     workflow-pin + extends + runbook surfaces are repaired in one pass.
 *   - NOT REPAIRABLE / SKIPPED → `holding` (inside the Renovate
 *     `minimumReleaseAge` window — repairing now races Renovate and would be
 *     reverted), `error` (the detector could not read the repo), `unknown`
 *     (floating tags / unresolved SHA — no deterministic target), and
 *     `current` (nothing to do). Skips are reported, never PR'd.
 *
 * IDEMPOTENCY: one repair PR per consumer, keyed off a stable head branch
 * (`mandrel-platform/pin-repair`). A re-run finds the existing open PR by head
 * branch and force-updates the branch + refreshes the PR body instead of
 * opening a duplicate. When the repaired tree is byte-identical to the existing
 * repair branch, nothing is pushed and the PR is left untouched.
 *
 * CROSS-REPO AUTH (least-privilege): opening a PR on a consumer needs write to
 * that consumer, which the platform's own `GITHUB_TOKEN` does NOT grant. The
 * scheduled workflow injects a fine-grained PAT / GitHub App token
 * (`PIN_REPAIR_TOKEN`) scoped to **Contents: write + Pull requests: write** on
 * the consumer repos ONLY. See docs/runbooks/pin-drift-dashboard.md § "Repair
 * loop token". When the token is absent the run completes read-only: it reports
 * the repairs it *would* open and exits 0 (advisory), never failing the job.
 *
 * Usage:
 *   node scripts/platform-repair.mjs                       # repair all drifting consumers
 *   node scripts/platform-repair.mjs --dry-run             # plan only; no clone, no push, no PR
 *   node scripts/platform-repair.mjs --config <path>       # alternate consumer registry
 *   node scripts/platform-repair.mjs --ref <release-ref>   # pin target (default: latest release tag)
 *   node scripts/platform-repair.mjs --json                # machine-readable envelope
 *   node scripts/platform-repair.mjs --dashboard-run-url <url>   # link in the PR body
 *
 * Exit codes:
 *   0 — report emitted (advisory by default, even when repairs were opened or
 *       would-be-opened). This job self-heals; it does not gate.
 *   1 — only on a fatal error (bad config, gh/git failure during a real
 *       mutation the operator must see).
 *
 * GitHub Actions: when GITHUB_STEP_SUMMARY is set, the human-readable report is
 * appended there so it renders on the job summary page.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReport, defaultGhRunner, isFullSha } from "./check-pin-drift.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The stable head branch every repair PR is opened from. Keying idempotency off
// a fixed branch name (rather than a generated one) is what guarantees a re-run
// updates the existing PR instead of opening a duplicate.
export const REPAIR_BRANCH = "mandrel-platform/pin-repair";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{
 *   config: string,
 *   ref: string | null,
 *   dryRun: boolean,
 *   json: boolean,
 *   dashboardRunUrl: string | null,
 * }}
 */
export function parseArgv(argv = []) {
  let config = "scripts/pin-drift-consumers.json";
  let ref = null;
  let dryRun = false;
  let json = false;
  let dashboardRunUrl = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--config" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      config = argv[++i];
    } else if (a === "--ref" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      ref = argv[++i];
    } else if (a === "--dashboard-run-url" && argv[i + 1]) {
      dashboardRunUrl = argv[++i];
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--json") {
      json = true;
    }
  }
  return { config, ref, dryRun, json, dashboardRunUrl };
}

// ---------------------------------------------------------------------------
// Pure helpers — repairability classification + PR-body rendering
// ---------------------------------------------------------------------------

/**
 * Decide whether a per-consumer detector result is REPAIRABLE by the
 * platform-sync loop. Repairable = the consumer has real drift the sync can
 * deterministically fix by pinning to the latest release SHA: a split pin, a
 * lagging `uses:` pin, a lagging npm dep, or a surface skew. NOT repairable:
 *
 *   - `holding`  → inside the Renovate minimumReleaseAge window; repairing now
 *                  races Renovate and would be reverted. Defer.
 *   - `error`    → the detector could not read the repo; nothing to repair.
 *   - no drift   → `drift` is false (current / no-pins / npm-absent-only).
 *   - unknown    → the consumer pins ONLY floating tags / unresolved SHAs, so
 *                  there is no deterministic SHA target to rewrite to. Surface
 *                  it as a skip, not a silent no-op.
 *
 * @param {{
 *   error?: string,
 *   drift?: boolean,
 *   holding?: boolean,
 *   verdict: { lagState: string, splitPinned?: boolean, pinnedSha?: string | null },
 *   npm?: { npmState?: string },
 *   surfaceSkew?: boolean,
 * }} result
 * @returns {{ repairable: boolean, reason: string }}
 */
export function classifyRepairability(result) {
  if (result.error) {
    return { repairable: false, reason: "error" };
  }
  if (result.holding === true) {
    return { repairable: false, reason: "holding" };
  }
  if (result.drift !== true) {
    return { repairable: false, reason: "no-drift" };
  }
  const v = result.verdict || {};
  // A consumer pinning ONLY floating refs (no resolvable SHA) and NOT split has
  // no deterministic pin to rewrite — `unknown` lag with no split. Split pins
  // are always repairable (sync collapses them to the single latest SHA).
  if (
    !v.splitPinned &&
    v.lagState === "unknown" &&
    (result.npm?.npmState ?? "absent") !== "lagging" &&
    result.surfaceSkew !== true
  ) {
    return { repairable: false, reason: "unknown-ref" };
  }
  return { repairable: true, reason: "drift" };
}

/**
 * Human-readable one-line drift descriptor for a consumer, for the PR body /
 * report. Names the specific drift classes the detector found.
 *
 * @param {{
 *   verdict: { lagState: string, splitPinned?: boolean, distinctRefs?: string[], pinnedSha?: string | null },
 *   npm?: { npmState?: string, version?: string | null },
 *   surfaceSkew?: boolean,
 * }} result
 * @returns {string[]}  one descriptor per detected drift class.
 */
export function describeDrift(result) {
  const out = [];
  const v = result.verdict || {};
  if (v.splitPinned) {
    const n = (v.distinctRefs || []).length;
    out.push(`**Split pin** — ${n} distinct platform refs across workflow chains.`);
  } else if (v.lagState === "lagging") {
    const short = v.pinnedSha ? v.pinnedSha.slice(0, 7) : "?";
    out.push(`**Release lag** — workflow \`uses:\` pins \`${short}\`, behind the latest release.`);
  }
  if (result.surfaceSkew === true) {
    out.push(
      `**Surface skew** — the npm \`mandrel-platform\` dependency (\`${result.npm?.version ?? "?"}\`) and the workflow \`uses:\` pins are on different releases.`,
    );
  } else if (result.npm?.npmState === "lagging") {
    out.push(`**npm lag** — \`mandrel-platform@${result.npm.version}\` is behind the latest release.`);
  }
  return out;
}

/**
 * Render the repair-PR body for one consumer. Explains what drifted (Acceptance
 * criterion 3) and links the pin-drift dashboard run that detected it. The body
 * is deterministic for a given (drift, ref, dashboard URL) so re-running the
 * loop on an unchanged drift state produces an identical body (idempotent
 * update is a no-op diff).
 *
 * @param {{
 *   name: string,
 *   repo: string,
 *   result: object,
 *   ref: string,
 *   targetSha: string | null,
 *   dashboardRunUrl: string | null,
 * }} args
 * @returns {string}
 */
export function renderRepairPrBody({ name, repo, result, ref, targetSha, dashboardRunUrl }) {
  const drift = describeDrift(result);
  const out = [];
  out.push("## 🔧 Automated mandrel-platform pin-drift repair");
  out.push("");
  out.push(
    `The cross-consumer **pin-drift dashboard** detected that \`${name}\` (\`${repo}\`) has drifted ` +
      `from the latest mandrel-platform release. This PR was opened automatically by the ` +
      `\`platform-sync\` repair loop to bring it back in sync.`,
  );
  out.push("");
  out.push("### What drifted");
  out.push("");
  if (drift.length === 0) {
    out.push("- (drift detail unavailable)");
  } else {
    for (const d of drift) out.push(`- ${d}`);
  }
  out.push("");
  out.push("### What this PR does");
  out.push("");
  const shaLabel = targetSha ? ` (\`${targetSha.slice(0, 7)}\`)` : "";
  out.push(
    `Runs \`platform-sync --ref ${ref}\`${shaLabel}: rewrites every first-party ` +
      "`uses:` pin to the single latest release SHA, materializes any missing runbook " +
      "reference stubs, and reconciles the Renovate / tsconfig `extends` chains to the " +
      "shared SSOT.",
  );
  out.push("");
  out.push("### Detection source");
  out.push("");
  if (dashboardRunUrl) {
    out.push(`- Pin-drift dashboard run: ${dashboardRunUrl}`);
  } else {
    out.push(
      "- Pin-drift dashboard (`.github/workflows/pin-drift.yml` in `dsj1984/mandrel-platform`).",
    );
  }
  out.push("");
  out.push("---");
  out.push("");
  out.push(
    "> This PR still goes through this repo's required CI before it can merge — the " +
      "repair loop opens it, it does **not** auto-merge it. `pin-drift.yml` remains " +
      "advisory; it does not gate `main`.",
  );
  out.push("");
  return out.join("\n");
}

const PR_TITLE = "chore: repair mandrel-platform pin drift";

// ---------------------------------------------------------------------------
// Git / gh / sync seams (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Default git runner. Shells out to `git` in `cwd`.
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
export function defaultGitRunner(args, { cwd } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Default platform-sync runner. Invokes platform-sync.mjs against a checked-out
 * consumer dir and parses its `--json` envelope.
 * @param {{ consumer: string, ref: string, sha?: string | null, templates?: string | null }} opts
 * @returns {object}  the platform-sync result envelope.
 */
export function defaultSyncRunner({ consumer, ref, sha, templates }) {
  const cli = join(__dirname, "platform-sync.mjs");
  const args = [cli, "--ref", ref, "--consumer", consumer, "--json"];
  if (sha) args.push("--sha", sha);
  if (templates) args.push("--templates", templates);
  const raw = execFileSync("node", args, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Per-consumer repair
// ---------------------------------------------------------------------------

/**
 * Find an existing open repair PR on a consumer (head = REPAIR_BRANCH). Returns
 * the PR number or null. Idempotency hinges on this probe.
 *
 * @param {string} repo  "owner/name".
 * @param {(args: string[]) => string} runGh
 * @returns {number | null}
 */
export function findOpenRepairPr(repo, runGh) {
  let out;
  try {
    out = runGh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      REPAIR_BRANCH,
      "--state",
      "open",
      "--json",
      "number",
    ]);
  } catch {
    return null;
  }
  let arr;
  try {
    arr = JSON.parse(out);
  } catch {
    return null;
  }
  if (Array.isArray(arr) && arr.length > 0 && Number.isInteger(arr[0].number)) {
    return arr[0].number;
  }
  return null;
}

/**
 * Repair one drifting consumer end-to-end: clone, run platform-sync, and open
 * or update the idempotent repair PR. Pure orchestration over injected seams,
 * so the whole flow is unit-testable offline.
 *
 * @param {{
 *   consumer: { name: string, repo: string, branch?: string },
 *   result: object,
 *   ref: string,
 *   targetSha: string | null,
 *   dashboardRunUrl: string | null,
 *   dryRun: boolean,
 *   token: string | null,
 *   templates: string | null,
 *   runGh: (args: string[]) => string,
 *   runGit: (args: string[], opts?: { cwd?: string }) => string,
 *   runSync: (opts: object) => object,
 *   workRoot: string,
 * }} args
 * @returns {{ name: string, repo: string, action: string, prNumber: number | null, changed: boolean, detail?: string }}
 */
export function repairConsumer({
  consumer,
  result,
  ref,
  targetSha,
  dashboardRunUrl,
  dryRun,
  token,
  templates,
  runGh,
  runGit,
  runSync,
  workRoot,
}) {
  const { name, repo } = consumer;
  const body = renderRepairPrBody({ name, repo, result, ref, targetSha, dashboardRunUrl });

  if (dryRun) {
    return { name, repo, action: "planned", prNumber: null, changed: true };
  }
  if (!token) {
    // No write token: report the repair we WOULD open, exit clean (advisory).
    return {
      name,
      repo,
      action: "skipped-no-token",
      prNumber: null,
      changed: false,
      detail: "PIN_REPAIR_TOKEN absent — repair planned but not opened (run is read-only).",
    };
  }

  const checkoutDir = join(workRoot, name);
  const authedUrl = `https://x-access-token:${token}@github.com/${repo}.git`;

  // 1. Shallow-clone the consumer's default branch (or pinned branch).
  const cloneArgs = ["clone", "--depth", "1"];
  if (consumer.branch) cloneArgs.push("--branch", consumer.branch);
  cloneArgs.push(authedUrl, checkoutDir);
  runGit(cloneArgs);

  // 2. Run platform-sync against the checkout.
  const sync = runSync({ consumer: checkoutDir, ref, sha: targetSha, templates });
  if (!sync.changed) {
    // Detector said drift, but the sync is a no-op (e.g. floating-tag-only pin
    // the sync does not rewrite). Nothing to PR.
    return { name, repo, action: "noop", prNumber: null, changed: false };
  }

  // 3. Stage + commit on the stable repair branch.
  runGit(["checkout", "-B", REPAIR_BRANCH], { cwd: checkoutDir });
  runGit(["add", "-A"], { cwd: checkoutDir });
  // No-op guard: if the tree matches the existing remote repair branch there is
  // nothing to commit. `git commit` exits non-zero on an empty index; treat
  // that as "already in sync on the repair branch".
  let committed = true;
  try {
    runGit(
      [
        "-c",
        "user.name=mandrel-platform[bot]",
        "-c",
        "user.email=mandrel-platform-bot@users.noreply.github.com",
        "commit",
        "-m",
        `${PR_TITLE} (${ref})`,
      ],
      { cwd: checkoutDir },
    );
  } catch {
    committed = false;
  }
  if (!committed) {
    return { name, repo, action: "noop", prNumber: null, changed: false };
  }

  // 4. Force-push the repair branch (idempotent: overwrites a stale repair
  //    branch from a prior run with the current repair state).
  runGit(["push", "--force", authedUrl, `HEAD:${REPAIR_BRANCH}`], { cwd: checkoutDir });

  // 5. Open or update the PR.
  const existing = findOpenRepairPr(repo, runGh);
  if (existing !== null) {
    runGh(["pr", "edit", String(existing), "--repo", repo, "--body", body, "--title", PR_TITLE]);
    return { name, repo, action: "updated", prNumber: existing, changed: true };
  }
  const base = consumer.branch || defaultBranchOf(repo, runGh);
  const createOut = runGh([
    "pr",
    "create",
    "--repo",
    repo,
    "--head",
    REPAIR_BRANCH,
    "--base",
    base,
    "--title",
    PR_TITLE,
    "--body",
    body,
  ]);
  const prNumber = parsePrNumberFromUrl(createOut);
  return { name, repo, action: "opened", prNumber, changed: true };
}

/**
 * Resolve a consumer's default branch via `gh`. Falls back to "main".
 * @param {string} repo
 * @param {(args: string[]) => string} runGh
 * @returns {string}
 */
export function defaultBranchOf(repo, runGh) {
  try {
    const out = runGh(["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
    const name = out.trim();
    return name || "main";
  } catch {
    return "main";
  }
}

/**
 * Extract the PR number from a `gh pr create` stdout (it prints the PR URL).
 * @param {string} out
 * @returns {number | null}
 */
export function parsePrNumberFromUrl(out) {
  const m = /\/pull\/(\d+)\s*$/.exec((out || "").trim());
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

const ACTION_LABEL = {
  opened: "🟢 PR opened",
  updated: "🔄 PR updated",
  planned: "📋 would open (dry-run)",
  "skipped-no-token": "🔑 no token — would open",
  noop: "➖ sync no-op",
  holding: "⏳ holding (deferred)",
  error: "⚠️ detector error",
  "no-drift": "✅ no drift",
  "unknown-ref": "❔ floating ref — manual",
};

/**
 * Render the human-readable repair report.
 * @param {{ ref: string, targetSha: string | null, dryRun: boolean, hasToken: boolean, rows: Array<object> }} report
 * @returns {string}
 */
export function renderRepairReport({ ref, targetSha, dryRun, hasToken, rows }) {
  const out = [];
  out.push("## platform-sync repair loop");
  out.push("");
  const shaLabel = targetSha ? ` (\`${targetSha.slice(0, 7)}\`)` : "";
  out.push(`Target ref: \`${ref}\`${shaLabel}`);
  out.push(`Mode: ${dryRun ? "dry-run (no mutations)" : hasToken ? "live" : "read-only (no PIN_REPAIR_TOKEN)"}`);
  out.push("");
  out.push("| Consumer | Repo | Outcome | PR |");
  out.push("| -------- | ---- | ------- | -- |");
  for (const r of rows) {
    const label = ACTION_LABEL[r.action] ?? r.action;
    const pr = r.prNumber ? `#${r.prNumber}` : "—";
    out.push(`| \`${r.name}\` | \`${r.repo}\` | ${label} | ${pr} |`);
  }
  out.push("");
  const repaired = rows.filter((r) => r.action === "opened" || r.action === "updated");
  const wouldRepair = rows.filter(
    (r) => r.action === "planned" || r.action === "skipped-no-token",
  );
  if (repaired.length > 0) {
    out.push(`### Repaired (${repaired.length})`);
    out.push("");
    for (const r of repaired) {
      out.push(`- \`${r.name}\` — ${ACTION_LABEL[r.action]}${r.prNumber ? ` (#${r.prNumber})` : ""}`);
    }
    out.push("");
  }
  if (wouldRepair.length > 0) {
    out.push(`### Would repair (${wouldRepair.length})`);
    out.push("");
    for (const r of wouldRepair) {
      out.push(`- \`${r.name}\`${r.detail ? ` — ${r.detail}` : ""}`);
    }
    out.push("");
  }
  if (repaired.length === 0 && wouldRepair.length === 0) {
    out.push("### ✅ No repairable drift — every consumer is in sync (or holding).");
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the repair plan + execute it.
 *
 * @param {{
 *   config: object,
 *   ref: string | null,
 *   dryRun: boolean,
 *   dashboardRunUrl: string | null,
 *   token: string | null,
 *   templates: string | null,
 *   runGh?: (args: string[]) => string,
 *   runGit?: (args: string[], opts?: { cwd?: string }) => string,
 *   runSync?: (opts: object) => object,
 *   workRoot?: string,
 *   nowMs?: number,
 * }} opts
 * @returns {{ ref: string, targetSha: string | null, dryRun: boolean, hasToken: boolean, rows: Array<object> }}
 */
export function runRepair({
  config,
  ref,
  dryRun,
  dashboardRunUrl,
  token,
  templates,
  runGh = defaultGhRunner,
  runGit = defaultGitRunner,
  runSync = defaultSyncRunner,
  workRoot,
  nowMs = Date.now(),
}) {
  // Reuse the detector to classify every consumer (single SSOT for drift).
  const report = buildReport(config, runGh, nowMs);
  const latestTag = report.latestRelease?.tag ?? null;
  const targetSha = report.latestRelease?.sha ?? null;
  // The pin target is the latest release tag (so the `# <ref>` annotation reads
  // as a release), pinned by its resolved SHA. An explicit --ref overrides.
  const effectiveRef = ref || latestTag || "main";

  const rows = [];
  // Only allocate a temp workdir when we'll actually clone.
  const needWork = !dryRun && token;
  const tmpRoot = needWork
    ? workRoot || mkdtempSync(join(tmpdir(), "platform-repair-"))
    : null;
  try {
    for (const r of report.results) {
      const consumer = { name: r.name, repo: r.repo, branch: r.branch !== "?" ? r.branch : undefined };
      const { repairable, reason } = classifyRepairability(r);
      if (!repairable) {
        rows.push({ name: r.name, repo: r.repo, action: reason, prNumber: null, changed: false });
        continue;
      }
      const row = repairConsumer({
        consumer,
        result: r,
        ref: effectiveRef,
        targetSha: isFullSha(targetSha || "") ? targetSha : null,
        dashboardRunUrl,
        dryRun,
        token,
        templates,
        runGh,
        runGit,
        runSync,
        workRoot: tmpRoot,
      });
      rows.push(row);
    }
  } finally {
    if (tmpRoot && !workRoot) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  return { ref: effectiveRef, targetSha, dryRun, hasToken: Boolean(token), rows };
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
 *   env?: Record<string, string | undefined>,
 *   runGh?: (args: string[]) => string,
 *   runGit?: (args: string[], opts?: { cwd?: string }) => string,
 *   runSync?: (opts: object) => object,
 *   summaryPath?: string | undefined,
 *   nowMs?: number,
 * }} [opts]
 * @returns {number} exit code
 */
export function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  runGh = defaultGhRunner,
  runGit = defaultGitRunner,
  runSync = defaultSyncRunner,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  nowMs = Date.now(),
} = {}) {
  const { config: configRel, ref, dryRun, json, dashboardRunUrl } = parseArgv(argv);
  const configPath = resolve(cwd, configRel);

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    stderr.write(
      `[platform-repair] ❌ failed to read config ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (!config.platformRepo || !Array.isArray(config.consumers)) {
    stderr.write("[platform-repair] ❌ config must define { platformRepo, consumers: [] }\n");
    return 1;
  }

  const token = env.PIN_REPAIR_TOKEN || null;
  // The dashboard run URL defaults to the live Actions run when invoked in CI.
  const runUrl =
    dashboardRunUrl ||
    (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null);

  let report;
  try {
    report = runRepair({
      config,
      ref,
      dryRun,
      dashboardRunUrl: runUrl,
      token,
      templates: null,
      runGh,
      runGit,
      runSync,
      nowMs,
    });
  } catch (err) {
    stderr.write(
      `[platform-repair] ❌ ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (json) {
    stdout.write(`${JSON.stringify({ kind: "platform-repair-report", ...report }, null, 2)}\n`);
  } else {
    const text = renderRepairReport(report);
    stdout.write(`${text}\n`);
    if (summaryPath) {
      try {
        appendFileSync(summaryPath, `${text}\n`);
      } catch (err) {
        stderr.write(
          `[platform-repair] ⚠ could not write job summary: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
  return 0;
}

// Direct-invocation guard (matches the repo's other scripts/*.mjs entry style).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  process.exit(runCli());
}
