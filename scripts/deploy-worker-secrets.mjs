#!/usr/bin/env node
/**
 * deploy-worker-secrets.mjs
 *
 * In-pipeline worker-secrets provisioning for the shared
 * `deploy-cloudflare.yml` workflow (Story #170; extracted from inline bash in
 * Story #231). The workflow sparse-checks this script out of
 * dsj1984/mandrel-platform at `github.job_workflow_sha` — the exact commit
 * the caller's `deploy-cloudflare.yml@<ref>` pin resolved to — so the script
 * version always travels in lockstep with the workflow pin (same model as
 * `uptime-apply.yml` → `apply-uptime-monitors.mjs`).
 *
 * What it does (behaviour-identical to the inline predecessor): for each
 * secret NAME the consumer enumerates in the `worker-secrets` input, resolve
 * the value from the INHERITED secrets context (SECRETS_CONTEXT, the
 * `toJSON(secrets)` payload) and write it onto every deployed worker via the
 * VERSIONS secret API — `pnpm exec wrangler versions secret put`, which is
 * immune to Cloudflare error 10215 even when a prior rollback left the
 * Worker at active ≠ latest-uploaded — then promote the resulting version to
 * 100% traffic (`wrangler versions deploy … -y`) so the just-written secrets
 * are the ACTIVE version boot-smoke probes and any active/latest split
 * self-heals.
 *
 * Secret hygiene: values are passed to wrangler over STDIN and are never
 * echoed, interpolated into argv, or logged — only secret NAMES appear in
 * output (GitHub additionally redacts inherited secret values in logs).
 *
 * Environment contract (all read from process.env):
 *   DEPLOY_ENV        Cloudflare --env label (required)
 *   DEPLOYED_WORKERS  csv of deployed worker names (required)
 *   WORKER_SECRETS    newline-separated secret NAMES; blank lines and '#'
 *                     comment lines ignored (required — the workflow step is
 *                     skipped entirely when the input is empty)
 *   SECRETS_CONTEXT   JSON object of the inherited secrets context (required)
 *
 * Exit codes:
 *   0 — every named secret provisioned onto every deployed worker (or the
 *       name list resolved to zero entries — notice printed, nothing to do).
 *   1 — a named secret is absent/empty in the inherited context, a wrangler
 *       invocation failed, or the environment contract is violated.
 */

import { execFileSync } from "node:child_process";

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

/**
 * Parse the newline-separated worker-secrets NAME list: trim each line, skip
 * blanks and leading-'#' comment lines (so a consumer can annotate the list).
 */
export function parseSecretNames(raw) {
  return String(raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Resolve one secret value from the inherited secrets context JSON. Returns
 * the non-empty string value, or null when the name is absent or empty.
 */
export function resolveSecretValue(secretsContext, name) {
  const value = secretsContext?.[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Provisioning loop (deps injectable for the test suite)
// ---------------------------------------------------------------------------

/**
 * Run the full provisioning pass. Returns an exit code and performs no
 * process.exit of its own so the test suite can drive it directly.
 */
export function provisionWorkerSecrets(env, deps = {}) {
  const {
    log = (line) => process.stdout.write(`${line}\n`),
    runWrangler = defaultRunWrangler,
  } = deps;

  const deployEnv = env.DEPLOY_ENV ?? "";
  const workers = parseCsv(env.DEPLOYED_WORKERS);
  const names = parseSecretNames(env.WORKER_SECRETS);

  if (names.length === 0) {
    log("::notice::worker-secrets was set but resolved to zero names — nothing to provision.");
    return 0;
  }

  let secretsContext;
  try {
    secretsContext = JSON.parse(env.SECRETS_CONTEXT ?? "");
  } catch {
    log("::error::worker-secrets: SECRETS_CONTEXT is not valid JSON — cannot resolve secret values.");
    return 1;
  }

  for (const worker of workers) {
    for (const name of names) {
      // A missing / empty inherited secret is a hard error — a
      // deploy-critical secret the consumer explicitly listed must exist.
      const value = resolveSecretValue(secretsContext, name);
      if (value === null) {
        log(
          `::error::worker-secrets: '${name}' is not present (or empty) in the inherited secrets — forward it via 'secrets: inherit' before listing it in worker-secrets.`
        );
        return 1;
      }

      log(`::group::Provisioning ${name} onto ${worker} (versions secret API)`);
      // `wrangler versions secret put` reads the value from stdin (same
      // non-interactive path as `wrangler secret put`) and creates a NEW
      // version WITHOUT deploying it. This write is immune to error 10215
      // even when active ≠ latest-uploaded.
      const putCode = runWrangler(
        ["versions", "secret", "put", name, "--name", worker, "--env", deployEnv],
        value
      );
      if (putCode !== 0) {
        log(`::error::worker-secrets: 'wrangler versions secret put ${name}' failed for worker '${worker}'.`);
        log("::endgroup::");
        return 1;
      }
      log("::endgroup::");
    }

    log(`::group::Promoting latest version of ${worker} to 100% (self-heal active=latest)`);
    // Deploy the latest-uploaded version (the one carrying the secrets just
    // written) at 100% traffic, non-interactively. This both makes the
    // current secret values the ACTIVE version boot-smoke probes and
    // realigns active = latest so no residual 10215-inducing split remains.
    // `-y` selects the non-interactive default (latest @ 100%).
    const deployCode = runWrangler([
      "versions",
      "deploy",
      "--name",
      worker,
      "--env",
      deployEnv,
      "--message",
      "In-pipeline worker-secrets provisioning (Story #170)",
      "-y",
    ]);
    if (deployCode !== 0) {
      log(`::error::worker-secrets: 'wrangler versions deploy' failed for worker '${worker}'.`);
      log("::endgroup::");
      return 1;
    }
    log("::endgroup::");
  }

  return 0;
}

/**
 * Spawn the consumer's lockfile-pinned wrangler (`pnpm exec wrangler …`,
 * installed and preflighted by setup-toolchain's require-wrangler). When
 * `stdinValue` is provided it is piped over stdin and never appears in argv.
 */
function defaultRunWrangler(args, stdinValue) {
  try {
    execFileSync("pnpm", ["exec", "wrangler", ...args], {
      stdio: [stdinValue === undefined ? "ignore" : "pipe", "inherit", "inherit"],
      input: stdinValue,
    });
    return 0;
  } catch {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("deploy-worker-secrets.mjs");
if (invokedDirectly) {
  process.exit(provisionWorkerSecrets(process.env));
}
