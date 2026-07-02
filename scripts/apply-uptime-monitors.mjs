#!/usr/bin/env node
/**
 * apply-uptime-monitors.mjs
 *
 * Shared Better Stack uptime-monitor schema + apply unit (Story #180).
 *
 * Post-convergence triplication (2026-07-01 audit): domio, athportal, and
 * swarm-os each carried their own `uptime-apply.yml` + Better Stack IaC
 * (`infra/uptime/`). swarm-os's implementation (Story #163) was the
 * newest/cleanest and is the seed donor here per standing decision #4
 * (best-of-breed seeding) — generalized into a platform-owned shared unit so
 * `.github/workflows/uptime-apply.yml` (and any future caller) has one
 * script to invoke instead of re-deriving the Better Stack monitor-CRUD calls
 * per repo.
 *
 * What it does: reads a small JSON monitor-config file (one entry per HTTP
 * probe: url + optional alert email + optional check interval), diffs it
 * against Better Stack's live monitor list (GET /api/v2/monitors), and
 * creates/updates monitors to converge live state to the desired config.
 * Never deletes a monitor that isn't in the config — this is an additive
 * apply, mirroring the "preserve graceful degradation" acceptance criterion:
 * a monitor an operator created by hand in the Better Stack UI is left alone.
 *
 * Graceful degradation: with no `BETTERSTACK_API_TOKEN` (env or --token),
 * the script prints a skip notice and exits 0 — never fails a caller that
 * hasn't provisioned Better Stack yet. This mirrors the frozen-secret
 * skip-with-notice posture the other reusable workflows already use for
 * their optional secret sub-steps.
 *
 * --------------------------------------------------------------------------
 * Usage (CLI):
 *   node scripts/apply-uptime-monitors.mjs --config <path> [--dry-run] [--apply]
 *     [--token <token>] [--alert-email <email>]
 *
 *   • --config       Path to a JSON monitor-config file. See
 *                     `MONITOR_CONFIG_SCHEMA` below for the shape.
 *   • --dry-run      Compute and print the plan (create/update/unchanged);
 *                     issue no writes. Default when neither --dry-run nor
 *                     --apply is passed.
 *   • --apply        Issue the create/update calls against the Better Stack
 *                     API. Mutually exclusive with --dry-run (last one wins
 *                     if both are passed).
 *   • --token        Better Stack API token. Defaults to
 *                     $BETTERSTACK_API_TOKEN. Missing token → skip-with-
 *                     notice, exit 0.
 *   • --alert-email  Default alert-contact email applied to any monitor
 *                     entry that does not set its own `alertEmail`. Defaults
 *                     to $UPTIME_ALERT_EMAIL.
 *
 * Exit codes:
 *   0 — plan computed / applied successfully, OR skip-with-notice (no token).
 *   1 — a usage or API error (bad config, Better Stack request failed).
 *
 * The config schema and API surface are the documented contract — see
 * docs/reusable-workflows.md (`uptime-apply.yml`).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Monitor config schema (pure validation — no I/O)
// ---------------------------------------------------------------------------

/**
 * A monitor config file is either a bare array of monitor entries, or an
 * object with a `monitors` array (mirrors the OSV allow-list file's
 * "bare array or wrapped object" tolerance in pr-quality.yml's contract).
 *
 * Each entry:
 *   {
 *     "url": "https://api.example.com/health",   // required, http(s) URL
 *     "name": "api",                              // optional, defaults to url's host
 *     "alertEmail": "oncall@example.com",         // optional, falls back to --alert-email
 *     "checkFrequency": 30                        // optional, seconds, default 30
 *   }
 *
 * @param {unknown} raw  Parsed JSON.
 * @returns {{ monitors: Array<{url:string, name:string, alertEmail:string|null, checkFrequency:number}> }}
 * @throws {Error} with a message naming the offending index/field on invalid input.
 */
export function parseMonitorConfig(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.monitors) ? raw.monitors : null;
  if (!list) {
    throw new Error(
      "monitor config must be a JSON array of monitor entries, or an object with a `monitors` array."
    );
  }
  return {
    monitors: list.map((entry, i) => validateMonitorEntry(entry, i)),
  };
}

function validateMonitorEntry(entry, index) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`monitor config entry [${index}] must be an object.`);
  }
  if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) {
    throw new Error(`monitor config entry [${index}] is missing a valid http(s) "url".`);
  }
  let host;
  try {
    host = new URL(entry.url).host;
  } catch {
    throw new Error(`monitor config entry [${index}] has an unparsable "url": ${entry.url}`);
  }
  if (entry.name !== undefined && typeof entry.name !== "string") {
    throw new Error(`monitor config entry [${index}] "name" must be a string when present.`);
  }
  if (entry.alertEmail !== undefined && typeof entry.alertEmail !== "string") {
    throw new Error(`monitor config entry [${index}] "alertEmail" must be a string when present.`);
  }
  if (entry.checkFrequency !== undefined && !(Number.isInteger(entry.checkFrequency) && entry.checkFrequency > 0)) {
    throw new Error(`monitor config entry [${index}] "checkFrequency" must be a positive integer (seconds) when present.`);
  }
  return {
    url: entry.url,
    name: entry.name ?? host,
    alertEmail: entry.alertEmail ?? null,
    checkFrequency: entry.checkFrequency ?? DEFAULT_CHECK_FREQUENCY_SECONDS,
  };
}

export const DEFAULT_CHECK_FREQUENCY_SECONDS = 30;
export const BETTERSTACK_API_BASE = "https://uptime.betterstack.com/api/v2";

// ---------------------------------------------------------------------------
// Diff — pure, no I/O. Compares desired monitor entries to Better Stack's
// live monitor list (already normalized to {id, url, name} by the caller).
// ---------------------------------------------------------------------------

/**
 * @param {Array<{url:string,name:string,alertEmail:string|null,checkFrequency:number}>} desired
 * @param {Array<{id:string,url:string}>} live
 * @returns {{
 *   toCreate: typeof desired,
 *   toUpdate: Array<{id:string, entry: typeof desired[number]}>,
 *   unchanged: string[]
 * }}
 */
export function diffMonitors(desired, live) {
  const liveByUrl = new Map(live.map((m) => [normalizeUrl(m.url), m]));
  const toCreate = [];
  const toUpdate = [];
  const unchanged = [];
  for (const entry of desired) {
    const match = liveByUrl.get(normalizeUrl(entry.url));
    if (!match) {
      toCreate.push(entry);
    } else if (monitorNeedsUpdate(match, entry)) {
      toUpdate.push({ id: match.id, entry });
    } else {
      unchanged.push(entry.url);
    }
  }
  return { toCreate, toUpdate, unchanged };
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "").toLowerCase();
}

function monitorNeedsUpdate(live, desired) {
  if (live.name !== undefined && live.name !== desired.name) return true;
  if (live.checkFrequency !== undefined && live.checkFrequency !== desired.checkFrequency) return true;
  if (live.alertEmail !== undefined && desired.alertEmail !== null && live.alertEmail !== desired.alertEmail) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Better Stack API client — injectable fetch seam for offline testing.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {{
 *   listMonitors: () => Promise<Array<{id:string,url:string,name?:string,checkFrequency?:number,alertEmail?:string}>>,
 *   createMonitor: (entry: object) => Promise<{id:string}>,
 *   updateMonitor: (id:string, entry: object) => Promise<{id:string}>
 * }}
 */
export function createBetterStackClient({ token, fetchImpl = fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  async function request(path, init) {
    const res = await fetchImpl(`${BETTERSTACK_API_BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Better Stack API ${init?.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText} ${body}`);
    }
    return res.json();
  }

  return {
    async listMonitors() {
      const page = await request("/monitors");
      return (page.data ?? []).map((m) => ({
        id: m.id,
        url: m.attributes?.url ?? "",
        name: m.attributes?.pronounceable_name,
        checkFrequency: m.attributes?.check_frequency,
        alertEmail: m.attributes?.email,
      }));
    },
    async createMonitor(entry) {
      const body = toBetterStackPayload(entry);
      const res = await request("/monitors", { method: "POST", body: JSON.stringify(body) });
      return { id: res.data?.id };
    },
    async updateMonitor(id, entry) {
      const body = toBetterStackPayload(entry);
      const res = await request(`/monitors/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      return { id: res.data?.id ?? id };
    },
  };
}

function toBetterStackPayload(entry) {
  return {
    monitor_type: "status",
    url: entry.url,
    pronounceable_name: entry.name,
    check_frequency: entry.checkFrequency,
    ...(entry.alertEmail ? { email: entry.alertEmail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Orchestration — apply the desired config against a client, honoring
// dry-run. Pure aside from the injected client.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {{monitors: Array}} opts.config
 * @param {ReturnType<typeof createBetterStackClient>} opts.client
 * @param {boolean} opts.dryRun
 * @param {string|null} [opts.defaultAlertEmail]
 * @returns {Promise<{created: string[], updated: string[], unchanged: string[], dryRun: boolean}>}
 */
export async function applyMonitorConfig({ config, client, dryRun, defaultAlertEmail = null }) {
  const desired = config.monitors.map((m) => ({
    ...m,
    alertEmail: m.alertEmail ?? defaultAlertEmail,
  }));
  const live = await client.listMonitors();
  const { toCreate, toUpdate, unchanged } = diffMonitors(desired, live);

  if (dryRun) {
    return {
      created: toCreate.map((m) => m.url),
      updated: toUpdate.map((m) => m.entry.url),
      unchanged,
      dryRun: true,
    };
  }

  const created = [];
  for (const entry of toCreate) {
    await client.createMonitor(entry);
    created.push(entry.url);
  }
  const updated = [];
  for (const { id, entry } of toUpdate) {
    await client.updateMonitor(id, entry);
    updated.push(entry.url);
  }
  return { created, updated, unchanged, dryRun: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    config: null,
    dryRun: true,
    token: process.env.BETTERSTACK_API_TOKEN ?? null,
    alertEmail: process.env.UPTIME_ALERT_EMAIL ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" && argv[i + 1]) {
      opts.config = argv[++i];
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--apply") {
      opts.dryRun = false;
    } else if (a === "--token" && argv[i + 1]) {
      opts.token = argv[++i];
    } else if (a === "--alert-email" && argv[i + 1]) {
      opts.alertEmail = argv[++i];
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "Usage: node scripts/apply-uptime-monitors.mjs --config <path> [--dry-run|--apply] " +
        "[--token <token>] [--alert-email <email>]\n"
    );
    process.exit(0);
  }
  if (!opts.config) {
    process.stderr.write("[apply-uptime-monitors] ERROR: --config <path> is required.\n");
    process.exit(1);
  }

  // Graceful degradation: no token → skip-with-notice, exit 0. Preserves the
  // pre-existing per-consumer behaviour when Better Stack secrets are not
  // yet provisioned (acceptance criterion — see docs/reusable-workflows.md).
  if (!opts.token) {
    process.stdout.write(
      "⏭️  apply-uptime-monitors: BETTERSTACK_API_TOKEN not provided — skipping uptime-monitor apply (Better Stack not provisioned for this consumer yet).\n"
    );
    process.exit(0);
  }

  let config;
  try {
    const raw = JSON.parse(readFileSync(resolve(opts.config), "utf8"));
    config = parseMonitorConfig(raw);
  } catch (err) {
    process.stderr.write(`[apply-uptime-monitors] ERROR: invalid monitor config: ${err.message}\n`);
    process.exit(1);
  }

  const client = createBetterStackClient({ token: opts.token });

  try {
    const result = await applyMonitorConfig({
      config,
      client,
      dryRun: opts.dryRun,
      defaultAlertEmail: opts.alertEmail,
    });
    const verb = result.dryRun ? "would create" : "created";
    const verbUpdate = result.dryRun ? "would update" : "updated";
    process.stdout.write(
      `${result.dryRun ? "🔍 [dry-run] " : "✅ "}${result.created.length} monitor(s) ${verb}, ` +
        `${result.updated.length} ${verbUpdate}, ${result.unchanged.length} unchanged.\n`
    );
    if (result.created.length) process.stdout.write(`  create: ${result.created.join(", ")}\n`);
    if (result.updated.length) process.stdout.write(`  update: ${result.updated.join(", ")}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[apply-uptime-monitors] ERROR: ${err.message}\n`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly, not when imported by the self-test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
