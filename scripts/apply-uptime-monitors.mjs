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
 *   • --alert-email  DEPRECATED and ignored (defaults to $UPTIME_ALERT_EMAIL).
 *                     Better Stack's monitor `email` field is a boolean
 *                     ("Send e-mail alerts."), not a recipient — recipients
 *                     resolve from the team roster and the escalation policy.
 *                     Accepted only so an existing caller does not break; use
 *                     a monitor entry's `policyId` to control who is alerted.
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
 *     "emailAlerts": true,                        // optional, boolean, default true
 *     "policyId": "12345",                        // optional, Better Stack escalation policy
 *     "checkFrequency": 30                        // optional, seconds, default 30
 *   }
 *
 * `emailAlerts` maps to Better Stack's `email` field, which the Monitors API
 * types as a **boolean** ("Send e-mail alerts.") — it is a switch, not a
 * recipient. Recipients resolve from the Better Stack team roster and the
 * escalation policy named by `policyId` (`policy_id`), never from a
 * per-monitor address. The retired `alertEmail` field is still accepted and
 * type-checked so an existing config keeps parsing, but it is inert: it is
 * reported in `deprecations[]` and never reaches the API payload.
 *
 * @param {unknown} raw  Parsed JSON.
 * @returns {{
 *   monitors: Array<{url:string, name:string, emailAlerts:boolean, policyId:string|null, checkFrequency:number}>,
 *   deprecations: string[]
 * }}
 * @throws {Error} with a message naming the offending index/field on invalid input.
 */
export function parseMonitorConfig(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.monitors) ? raw.monitors : null;
  if (!list) {
    throw new Error(
      "monitor config must be a JSON array of monitor entries, or an object with a `monitors` array."
    );
  }
  const deprecations = [];
  const monitors = list.map((entry, i) => {
    if (entry && typeof entry === "object" && entry.alertEmail !== undefined) {
      deprecations.push(
        `monitor config entry [${i}] sets "alertEmail" — that field is ignored. ` +
          `Better Stack types the monitor's \`email\` field as a boolean (an on/off switch), not a recipient. ` +
          `Use "emailAlerts" to toggle e-mail alerts and "policyId" to choose the escalation policy that decides who is alerted.`
      );
    }
    return validateMonitorEntry(entry, i);
  });
  return { monitors, deprecations };
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
  if (entry.emailAlerts !== undefined && typeof entry.emailAlerts !== "boolean") {
    throw new Error(`monitor config entry [${index}] "emailAlerts" must be a boolean when present.`);
  }
  if (entry.policyId !== undefined && typeof entry.policyId !== "string") {
    throw new Error(`monitor config entry [${index}] "policyId" must be a string when present.`);
  }
  if (entry.checkFrequency !== undefined && !(Number.isInteger(entry.checkFrequency) && entry.checkFrequency > 0)) {
    throw new Error(`monitor config entry [${index}] "checkFrequency" must be a positive integer (seconds) when present.`);
  }
  return {
    url: entry.url,
    name: entry.name ?? host,
    emailAlerts: entry.emailAlerts ?? true,
    policyId: entry.policyId ?? null,
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
  // Both sides are booleans: the live read-back maps Better Stack's boolean
  // `email` attribute, and `emailAlerts` normalizes to a boolean at parse.
  // Comparing a boolean against a configured address (the pre-#403 shape)
  // read as drift on every beat and issued a redundant PATCH per monitor
  // per apply.
  if (live.emailAlerts !== undefined && live.emailAlerts !== desired.emailAlerts) return true;
  if (live.policyId !== undefined && desired.policyId !== null && live.policyId !== desired.policyId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Better Stack API client — injectable fetch seam for offline testing.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.apiBase]  Override the Better Stack API base URL.
 *   Defaults to BETTERSTACK_API_BASE. Exists so a local/offline consumer-
 *   caller simulation (see apply-uptime-monitors.test.mjs) can point the
 *   real CLI at an in-process HTTP server instead of the live API — never
 *   set this in a production caller.
 * @returns {{
 *   listMonitors: () => Promise<Array<{id:string,url:string,name?:string,checkFrequency?:number,alertEmail?:string}>>,
 *   createMonitor: (entry: object) => Promise<{id:string}>,
 *   updateMonitor: (id:string, entry: object) => Promise<{id:string}>
 * }}
 */
export function createBetterStackClient({ token, fetchImpl = fetch, apiBase = BETTERSTACK_API_BASE }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  async function request(path, init) {
    const res = await fetchImpl(`${apiBase}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
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
        emailAlerts: m.attributes?.email,
        policyId: m.attributes?.policy_id,
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
    // `email` is a boolean in Better Stack's Monitors API ("Send e-mail
    // alerts.") — always send the switch, never an address. `policy_id` is
    // the field that actually determines who is alerted.
    email: entry.emailAlerts,
    ...(entry.policyId ? { policy_id: entry.policyId } : {}),
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
 * @returns {Promise<{created: string[], updated: string[], unchanged: string[], dryRun: boolean}>}
 */
export async function applyMonitorConfig({ config, client, dryRun }) {
  const desired = config.monitors;
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

  // Announced before the token check on purpose: "secret provisioned, token
  // absent" is exactly the state that produced a permanently-green apply a
  // consumer believed was routing alerts, so that run is the one that most
  // needs to hear the address is inert (refs #403).
  if (opts.alertEmail) {
    process.stdout.write(
      "::warning title=UPTIME_ALERT_EMAIL is ignored::Better Stack resolves alert recipients from the team roster " +
        "and escalation policy, not from a per-monitor address. Set a monitor's `policyId` instead, and drop this secret from your caller.\n"
    );
    process.stderr.write(
      "[apply-uptime-monitors] DEPRECATED: --alert-email / $UPTIME_ALERT_EMAIL is ignored — Better Stack's monitor " +
        "`email` field is a boolean switch, not a recipient. Use a monitor entry's `policyId` (escalation policy) to " +
        "control who is alerted, and `emailAlerts` to toggle e-mail alerts.\n"
    );
  }

  // Graceful degradation: no token → skip-with-notice, exit 0. Preserves the
  // pre-existing per-consumer behaviour when Better Stack secrets are not
  // yet provisioned (acceptance criterion — see docs/reusable-workflows.md).
  if (!opts.token) {
    // Annotation-level, not stdout-only: a consumer can otherwise sit on a
    // permanently-green `uptime-apply` for weeks with zero live monitors and
    // never notice the apply is inert (refs #403).
    process.stdout.write(
      "::warning title=Uptime monitors not applied::BETTERSTACK_API_TOKEN is not provisioned — " +
        "this uptime-apply run created and updated nothing. Provision the secret to activate uptime monitoring.\n"
    );
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

  for (const notice of config.deprecations) {
    process.stderr.write(`[apply-uptime-monitors] DEPRECATED: ${notice}\n`);
  }

  // Test-only escape hatch: point the CLI at a local/offline server instead
  // of the live Better Stack API. Never set in a production caller — see
  // createBetterStackClient's apiBase docblock.
  const apiBaseOverride = process.env.BETTERSTACK_API_BASE_OVERRIDE || undefined;
  const client = createBetterStackClient({
    token: opts.token,
    ...(apiBaseOverride ? { apiBase: apiBaseOverride } : {}),
  });

  try {
    const result = await applyMonitorConfig({
      config,
      client,
      dryRun: opts.dryRun,
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
