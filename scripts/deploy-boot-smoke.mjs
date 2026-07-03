#!/usr/bin/env node
/**
 * deploy-boot-smoke.mjs
 *
 * Boot-smoke probe for the shared `deploy-cloudflare.yml` workflow
 * (Story #231). Extracted from the workflow's former ~140-line inline bash so
 * the probe is unit-testable and reviewed as code, not as a YAML diff. The
 * workflow sparse-checks this script out of dsj1984/mandrel-platform at
 * `github.job_workflow_sha` — the exact commit the caller's
 * `deploy-cloudflare.yml@<ref>` pin resolved to — so the script version
 * always travels in lockstep with the workflow pin (same model as
 * `uptime-apply.yml` → `apply-uptime-monitors.mjs`).
 *
 * What it does (mirrors the inline predecessor, with one deliberate fix):
 *
 *   • Consumer-supplied `smoke-command` (SMOKE_COMMAND set): runs it once via
 *     `bash -c` with WORKERS (deployed csv) + SMOKE_BASE_URL exported. A
 *     non-zero exit fails the run and marks every deployed worker for
 *     rollback.
 *   • Built-in probe: requests each smoke path against each target with a
 *     15s timeout and up to 3 retries (5s apart) on transient failures,
 *     failing on any non-200 final status.
 *   • Opt-in `verify-commit-sha` (VERIFY_COMMIT_SHA=true): parses the health
 *     response body as JSON and asserts its TOP-LEVEL `version` field equals
 *     the deployed commit SHA (EXPECTED_SHA). This replaces the former
 *     grep/sed extraction, which could match a `"version"` key nested
 *     anywhere in the body.
 *
 * The smoke_base_url duplication fix (Story #231): the inline predecessor
 * probed `${SMOKE_BASE_URL}${path}` once **per worker**, so with a shared
 * base URL and N workers every path was requested N times and a failure was
 * misattributed to whichever worker's loop iteration hit it. With
 * SMOKE_BASE_URL set the probe now requests each path exactly ONCE — and
 * because a shared-host failure cannot be attributed to an individual
 * worker, it explicitly marks ALL deployed workers for rollback.
 *
 * Rollback contract (unchanged): failed worker names are written (sorted,
 * de-duplicated, one per line) to SMOKE_FAILED_FILE — overwriting any stale
 * file from a previous run on a reused runner — and `smoke_failed=true` is
 * appended to $GITHUB_ENV so the workflow's `Rollback failed workers` step
 * fires. Exit code 1 on any smoke failure.
 *
 * Wrangler: the workers.dev subdomain derivation shells out to the
 * consumer's lockfile-pinned `pnpm exec wrangler whoami` (installed by
 * setup-toolchain, preflighted via its `require-wrangler` input). This
 * script never fetches a registry-latest wrangler.
 *
 * Environment contract (all read from process.env):
 *   DEPLOYED_WORKERS       csv of deployed worker names (required)
 *   SMOKE_COMMAND          consumer-supplied probe command (optional)
 *   SMOKE_BASE_URL         shared base URL override (optional, no trailing /)
 *   SMOKE_PATHS            csv of probe paths (default "/health")
 *   WORKERS_DEV_SUBDOMAIN  explicit workers.dev slug (optional)
 *   VERIFY_COMMIT_SHA      'true' to assert the health JSON version field
 *   EXPECTED_SHA           the SHA verify-commit-sha asserts (github.sha)
 *   SMOKE_FAILED_FILE      rollback-list path (default /tmp/smoke-failed-workers.txt)
 *   GITHUB_ENV             GitHub Actions env file (smoke_failed=true flag)
 *
 * Exit codes:
 *   0 — every probe passed.
 *   1 — a probe failed (rollback list written), or the probe target could
 *       not be resolved (no subdomain derivable — no rollback list).
 */

import { writeFileSync, appendFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Split a csv into trimmed, non-empty entries. */
export function parseCsv(csv) {
  return String(csv ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse SMOKE_PATHS into normalized paths (leading slash enforced). */
export function parseSmokePaths(csv) {
  return parseCsv(csv).map((p) => (p.startsWith("/") ? p : `/${p}`));
}

/**
 * Extract the workers.dev account subdomain slug from `wrangler whoami`
 * output (the first `<slug>.workers.dev` token). Returns null when absent.
 */
export function extractSubdomain(whoamiOutput) {
  const m = String(whoamiOutput ?? "").match(/([A-Za-z0-9-]+)\.workers\.dev/);
  return m ? m[1] : null;
}

/**
 * Parse a health response body and return its TOP-LEVEL `version` field as a
 * string, or null when the body is not JSON, not an object, or the field is
 * missing / not a non-empty string. Deliberately never matches a `version`
 * key nested inside a sub-object (the grep-era false positive).
 */
export function parseVersionField(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const version = parsed.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

/**
 * Build the probe plan: one entry per URL to request, each carrying the
 * worker names a failure of that URL attributes to the rollback list.
 *
 *   • SMOKE_BASE_URL set   → each path probed ONCE against the shared base;
 *                            a failure attributes to ALL deployed workers
 *                            (shared host — per-worker attribution is
 *                            impossible, so roll back everything deployed).
 *   • workers.dev (default) → each path probed per worker against
 *                            https://<worker>.<subdomain>.workers.dev; a
 *                            failure attributes to that worker only.
 */
export function buildProbePlan({ workers, paths, smokeBaseUrl, subdomain }) {
  if (smokeBaseUrl) {
    const base = smokeBaseUrl.replace(/\/+$/, "");
    return paths.map((p) => ({
      url: `${base}${p}`,
      label: `shared base (${workers.join(", ")})`,
      attributedWorkers: [...workers],
    }));
  }
  const plan = [];
  for (const worker of workers) {
    for (const p of paths) {
      plan.push({
        url: `https://${worker}.${subdomain}.workers.dev${p}`,
        label: worker,
        attributedWorkers: [worker],
      });
    }
  }
  return plan;
}

/** De-duplicate + sort a worker list for the rollback file (mirrors `sort -u`). */
export function uniqueSorted(names) {
  return [...new Set(names)].sort();
}

// HTTP status codes curl's `--retry` treats as transient; the inline
// predecessor used `curl --retry 3 --retry-delay 5`.
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Probe one URL: GET with a 15s timeout, retrying transient failures
 * (network error or a TRANSIENT_STATUS response) up to `retries` times with
 * `retryDelayMs` between attempts. Returns { status, body } for the final
 * attempt; a network failure on the final attempt returns
 * { status: 0, body: "" } (the inline predecessor's `curl || echo 000`).
 */
export async function probeUrl(url, { fetchImpl = fetch, retries = 3, retryDelayMs = 5000, timeoutMs = 15000, sleep = defaultSleep } = {}) {
  let last = { status: 0, body: "" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    try {
      // redirect: "manual" — parity with the inline predecessor's plain curl
      // (no -L): a 301/302 from a health endpoint is a non-200 smoke FAILURE,
      // never silently followed to whatever the redirect target returns.
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
      last = { status: res.status, body: await res.text() };
    } catch {
      last = { status: 0, body: "" };
      continue; // network failure → transient, retry
    }
    if (!TRANSIENT_STATUS.has(last.status)) return last;
  }
  return last;
}

function defaultSleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// ---------------------------------------------------------------------------
// Probe execution (deps injectable for the test suite)
// ---------------------------------------------------------------------------

/**
 * Run the full smoke pass. Returns { exitCode, failedWorkers } and performs
 * no process.exit of its own so the test suite can drive it directly.
 */
export async function runSmoke(env, deps = {}) {
  const {
    log = (line) => process.stdout.write(`${line}\n`),
    probe = probeUrl,
    runShell = defaultRunShell,
    whoami = defaultWhoami,
  } = deps;

  const workers = parseCsv(env.DEPLOYED_WORKERS);
  const smokeCommand = env.SMOKE_COMMAND ?? "";
  const smokeBaseUrl = (env.SMOKE_BASE_URL ?? "").trim();
  const verifySha = env.VERIFY_COMMIT_SHA === "true";
  const expectedSha = env.EXPECTED_SHA ?? "";

  // ----- Consumer-supplied smoke replaces the built-in probe -----
  if (smokeCommand) {
    log("::group::Running consumer smoke-command");
    const code = runShell(smokeCommand, {
      WORKERS: env.DEPLOYED_WORKERS ?? "",
      SMOKE_BASE_URL: smokeBaseUrl,
    });
    if (code !== 0) {
      log("::error::Consumer smoke-command FAILED. Triggering rollback.");
      log("::endgroup::");
      return { exitCode: 1, failedWorkers: uniqueSorted(workers) };
    }
    log("✅ consumer smoke-command passed");
    log("::endgroup::");
    return { exitCode: 0, failedWorkers: [] };
  }

  // ----- Built-in probe -----
  // Resolve the workers.dev subdomain slug. NEVER the account ID (a UUID) —
  // workers.dev subdomains are keyed by the account name/slug. Prefer the
  // explicit input, else derive from `wrangler whoami`.
  let subdomain = (env.WORKERS_DEV_SUBDOMAIN ?? "").trim();
  if (!subdomain && !smokeBaseUrl) {
    log("::group::Deriving workers.dev subdomain from wrangler whoami");
    subdomain = extractSubdomain(whoami());
    if (!subdomain) {
      log(
        "::error::Could not derive workers.dev subdomain from 'wrangler whoami'. " +
          "Pass workers_dev_subdomain or smoke_base_url explicitly."
      );
      log("::endgroup::");
      // No rollback list: the target could not be resolved, so nothing was
      // probed (mirrors the inline predecessor, which exited before any
      // failed-worker was recorded).
      return { exitCode: 1, failedWorkers: [] };
    }
    log(`::notice::Derived workers.dev subdomain: ${subdomain}`);
    log("::endgroup::");
  }

  const paths = parseSmokePaths(env.SMOKE_PATHS ?? "/health");
  const plan = buildProbePlan({ workers, paths, smokeBaseUrl, subdomain });
  const failed = [];

  for (const entry of plan) {
    log(`::group::Smoke-testing ${entry.label} → ${entry.url}`);
    const { status, body } = await probe(entry.url);
    log(`HTTP status: ${status}`);

    if (status !== 200) {
      log(
        `::error::Smoke check FAILED for ${entry.label} at ${entry.url} (HTTP ${status}). Triggering rollback.`
      );
      failed.push(...entry.attributedWorkers);
      log("::endgroup::");
      continue;
    }
    log(`✅ ${entry.label} smoke check passed at ${entry.url} (HTTP 200)`);

    // ----- verify-commit-sha (Story #176, opt-in) -----
    // Assert the deployed worker's health response reports the SHA this run
    // deployed. Contract: docs/runbooks/post-deploy-smoke.md
    // #3-health-endpoint-contract — a JSON body whose top-level "version"
    // field is env.GIT_COMMIT_SHA. A mismatch or unparsable field fails the
    // smoke check and triggers the same auto-rollback as an HTTP failure.
    if (verifySha) {
      const deployedSha = parseVersionField(body);
      if (deployedSha === null) {
        log(
          `::error::verify-commit-sha FAILED for ${entry.label} at ${entry.url} — response has no parsable top-level "version" field. Triggering rollback.`
        );
        failed.push(...entry.attributedWorkers);
      } else if (deployedSha !== expectedSha) {
        log(
          `::error::verify-commit-sha FAILED for ${entry.label} — deployed SHA '${deployedSha}' does not match expected SHA '${expectedSha}'. Triggering rollback.`
        );
        failed.push(...entry.attributedWorkers);
      } else {
        log(`✅ ${entry.label} reports expected commit SHA: ${deployedSha}`);
      }
    }
    log("::endgroup::");
  }

  if (failed.length > 0) {
    return { exitCode: 1, failedWorkers: uniqueSorted(failed) };
  }
  return { exitCode: 0, failedWorkers: [] };
}

function defaultRunShell(command, extraEnv) {
  const res = spawnSync("bash", ["-c", command], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  return res.status ?? 1;
}

function defaultWhoami() {
  // Consumer lockfile-pinned wrangler (`pnpm exec wrangler`), installed and
  // preflighted by setup-toolchain (require-wrangler). Failure tolerated —
  // an empty output falls through to the "could not derive" error above.
  try {
    return execFileSync("pnpm", ["exec", "wrangler", "whoami"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  const failedFile = process.env.SMOKE_FAILED_FILE || "/tmp/smoke-failed-workers.txt";
  const { exitCode, failedWorkers } = await runSmoke(process.env);

  if (failedWorkers.length > 0) {
    // Overwrite (never append): a reused self-hosted runner may carry a
    // stale list from a previous run, and rolling back workers this run
    // never deployed would widen the blast radius.
    writeFileSync(failedFile, `${failedWorkers.join("\n")}\n`);
    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV, "smoke_failed=true\n");
    }
  }
  process.exit(exitCode);
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("deploy-boot-smoke.mjs");
if (invokedDirectly) {
  await main();
}
