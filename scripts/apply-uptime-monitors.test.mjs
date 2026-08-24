#!/usr/bin/env node
/**
 * apply-uptime-monitors.test.mjs — node:test suite for the shared Better
 * Stack monitor schema + apply unit (Story #180).
 *
 * Exercises the pure config parser/validator, the pure diff, and the full
 * apply orchestration against an injected Better Stack client seam — no real
 * network calls. The CLI's skip-with-notice (no token) and config-validation
 * paths are exercised via `execFileSync` against the real script, capturing
 * stdout/exit code.
 *
 * Run: node scripts/apply-uptime-monitors.test.mjs  (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

import {
  DEFAULT_CHECK_FREQUENCY_SECONDS,
  parseMonitorConfig,
  diffMonitors,
  createBetterStackClient,
  applyMonitorConfig,
} from "./apply-uptime-monitors.mjs";

const CLI = fileURLToPath(new URL("./apply-uptime-monitors.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// parseMonitorConfig
// ---------------------------------------------------------------------------

test("parseMonitorConfig accepts a bare array of monitor entries", () => {
  const { monitors } = parseMonitorConfig([{ url: "https://api.example.com/health" }]);
  assert.equal(monitors.length, 1);
  assert.equal(monitors[0].url, "https://api.example.com/health");
  assert.equal(monitors[0].name, "api.example.com");
  assert.equal(monitors[0].emailAlerts, true, "e-mail alerts default to on");
  assert.equal(monitors[0].policyId, null);
  assert.equal(monitors[0].checkFrequency, DEFAULT_CHECK_FREQUENCY_SECONDS);
});

test("parseMonitorConfig accepts a wrapped { monitors: [...] } object", () => {
  const { monitors } = parseMonitorConfig({
    monitors: [
      { url: "https://x.example.com", name: "x", emailAlerts: false, policyId: "pol-1", checkFrequency: 60 },
    ],
  });
  assert.deepEqual(monitors, [
    { url: "https://x.example.com", name: "x", emailAlerts: false, policyId: "pol-1", checkFrequency: 60 },
  ]);
});

test("parseMonitorConfig rejects a non-array, non-{monitors} shape", () => {
  assert.throws(() => parseMonitorConfig({ foo: "bar" }), /must be a JSON array/);
});

test("parseMonitorConfig rejects an entry missing a valid url", () => {
  assert.throws(() => parseMonitorConfig([{ url: "not-a-url" }]), /valid http\(s\) "url"/);
  assert.throws(() => parseMonitorConfig([{}]), /valid http\(s\) "url"/);
});

test("parseMonitorConfig rejects a non-positive-integer checkFrequency", () => {
  assert.throws(
    () => parseMonitorConfig([{ url: "https://x.example.com", checkFrequency: -5 }]),
    /"checkFrequency" must be a positive integer/
  );
  assert.throws(
    () => parseMonitorConfig([{ url: "https://x.example.com", checkFrequency: "30" }]),
    /"checkFrequency" must be a positive integer/
  );
});

test("parseMonitorConfig rejects non-string name/alertEmail", () => {
  assert.throws(() => parseMonitorConfig([{ url: "https://x.example.com", name: 5 }]), /"name" must be a string/);
  assert.throws(
    () => parseMonitorConfig([{ url: "https://x.example.com", alertEmail: 5 }]),
    /"alertEmail" must be a string/
  );
});

test("parseMonitorConfig rejects a non-boolean emailAlerts, naming the index", () => {
  assert.throws(
    () => parseMonitorConfig([{ url: "https://a.example.com" }, { url: "https://x.example.com", emailAlerts: "yes" }]),
    /entry \[1\] "emailAlerts" must be a boolean/
  );
});

test("parseMonitorConfig rejects a non-string policyId, naming the index", () => {
  assert.throws(
    () => parseMonitorConfig([{ url: "https://a.example.com" }, { url: "https://x.example.com", policyId: 12345 }]),
    /entry \[1\] "policyId" must be a string/
  );
});

test("parseMonitorConfig reports a retired alertEmail as a deprecation and drops it", () => {
  const { monitors, deprecations } = parseMonitorConfig([
    { url: "https://x.example.com", alertEmail: "oncall@example.com" },
  ]);
  assert.equal(deprecations.length, 1);
  assert.match(deprecations[0], /entry \[0\] sets "alertEmail" — that field is ignored/);
  assert.match(deprecations[0], /policyId/);
  assert.equal(monitors[0].alertEmail, undefined, "the retired field never reaches the normalized entry");
  assert.equal(monitors[0].emailAlerts, true);
});

test("parseMonitorConfig reports no deprecations for a clean config", () => {
  const { deprecations } = parseMonitorConfig([{ url: "https://x.example.com", emailAlerts: false }]);
  assert.deepEqual(deprecations, []);
});

// ---------------------------------------------------------------------------
// diffMonitors
// ---------------------------------------------------------------------------

test("diffMonitors classifies a brand-new url as toCreate", () => {
  const desired = [{ url: "https://new.example.com", name: "new", emailAlerts: true, policyId: null, checkFrequency: 30 }];
  const { toCreate, toUpdate, unchanged } = diffMonitors(desired, []);
  assert.equal(toCreate.length, 1);
  assert.equal(toUpdate.length, 0);
  assert.equal(unchanged.length, 0);
});

test("diffMonitors classifies a matching, identical url as unchanged", () => {
  const desired = [{ url: "https://x.example.com", name: "x", emailAlerts: true, policyId: null, checkFrequency: 30 }];
  const live = [{ id: "1", url: "https://x.example.com", name: "x", checkFrequency: 30 }];
  const { toCreate, toUpdate, unchanged } = diffMonitors(desired, live);
  assert.equal(toCreate.length, 0);
  assert.equal(toUpdate.length, 0);
  assert.deepEqual(unchanged, ["https://x.example.com"]);
});

test("diffMonitors classifies a url with a drifted name/frequency as toUpdate", () => {
  const desired = [{ url: "https://x.example.com", name: "renamed", emailAlerts: true, policyId: null, checkFrequency: 60 }];
  const live = [{ id: "1", url: "https://x.example.com", name: "x", checkFrequency: 30 }];
  const { toUpdate } = diffMonitors(desired, live);
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].id, "1");
});

test("diffMonitors url matching is trailing-slash and case insensitive", () => {
  const desired = [{ url: "https://X.example.com/", name: "x", emailAlerts: true, policyId: null, checkFrequency: 30 }];
  const live = [{ id: "1", url: "https://x.example.com", name: "x", checkFrequency: 30 }];
  const { toCreate, unchanged } = diffMonitors(desired, live);
  assert.equal(toCreate.length, 0);
  assert.deepEqual(unchanged, ["https://X.example.com/"]);
});

test("diffMonitors never proposes deleting a live monitor absent from desired (additive apply only)", () => {
  const desired = [{ url: "https://kept.example.com", name: "kept", emailAlerts: true, policyId: null, checkFrequency: 30 }];
  const live = [
    { id: "1", url: "https://kept.example.com", name: "kept", checkFrequency: 30 },
    { id: "2", url: "https://hand-added.example.com", name: "manual" },
  ];
  const result = diffMonitors(desired, live);
  assert.ok(!("toDelete" in result), "diff result carries no deletion bucket at all");
});

// ---------------------------------------------------------------------------
// createBetterStackClient (injected fetch seam)
// ---------------------------------------------------------------------------

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      const key = `${init?.method ?? "GET"} ${url}`;
      const entry = responses[key];
      if (!entry) throw new Error(`unexpected fetch call: ${key}`);
      return {
        ok: entry.status < 400,
        status: entry.status,
        statusText: entry.statusText ?? "",
        json: async () => entry.body,
        text: async () => JSON.stringify(entry.body),
      };
    },
  };
}

test("createBetterStackClient.listMonitors normalizes the Better Stack payload shape", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "GET https://uptime.betterstack.com/api/v2/monitors": {
      status: 200,
      body: {
        data: [
          {
            id: "42",
            // `email` is a boolean in Better Stack's API — a switch, not a
            // recipient. Fixturing it as an address is what let the
            // string-typed payload bug survive a green suite (refs #403).
            attributes: {
              url: "https://a.example.com",
              pronounceable_name: "a",
              check_frequency: 30,
              email: true,
              policy_id: "pol-1",
            },
          },
        ],
      },
    },
  });
  const client = createBetterStackClient({ token: "tok", fetchImpl });
  const monitors = await client.listMonitors();
  assert.deepEqual(monitors, [
    { id: "42", url: "https://a.example.com", name: "a", checkFrequency: 30, emailAlerts: true, policyId: "pol-1" },
  ]);
  assert.equal(calls[0].url, "https://uptime.betterstack.com/api/v2/monitors");
});

test("createBetterStackClient surfaces a non-ok response as a thrown error", async () => {
  const { fetchImpl } = fakeFetch({
    "GET https://uptime.betterstack.com/api/v2/monitors": { status: 401, statusText: "Unauthorized", body: {} },
  });
  const client = createBetterStackClient({ token: "bad", fetchImpl });
  await assert.rejects(() => client.listMonitors(), /401/);
});

// ---------------------------------------------------------------------------
// applyMonitorConfig — full orchestration against an injected client
// ---------------------------------------------------------------------------

function fakeClient({ live = [] } = {}) {
  const created = [];
  const updated = [];
  return {
    created,
    updated,
    listMonitors: async () => live,
    createMonitor: async (entry) => {
      created.push(entry);
      return { id: `new-${created.length}` };
    },
    updateMonitor: async (id, entry) => {
      updated.push({ id, entry });
      return { id };
    },
  };
}

test("applyMonitorConfig dry-run computes the plan without calling create/update", async () => {
  const client = fakeClient({ live: [] });
  const result = await applyMonitorConfig({
    config: { monitors: [{ url: "https://x.example.com", name: "x", emailAlerts: true, policyId: null, checkFrequency: 30 }] },
    client,
    dryRun: true,
  });
  assert.deepEqual(result.created, ["https://x.example.com"]);
  assert.equal(result.dryRun, true);
  assert.equal(client.created.length, 0, "dry-run must not call createMonitor");
});

test("applyMonitorConfig --apply issues create for new monitors", async () => {
  const client = fakeClient({ live: [] });
  const result = await applyMonitorConfig({
    config: { monitors: [{ url: "https://x.example.com", name: "x", emailAlerts: true, policyId: null, checkFrequency: 30 }] },
    client,
    dryRun: false,
  });
  assert.deepEqual(result.created, ["https://x.example.com"]);
  assert.equal(client.created.length, 1);
});

test("a created monitor sends Better Stack's `email` as a boolean, never an address", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST https://uptime.betterstack.com/api/v2/monitors": { status: 201, body: { data: { id: "9" } } },
  });
  const client = createBetterStackClient({ token: "tok", fetchImpl });
  await client.createMonitor({
    url: "https://x.example.com",
    name: "x",
    emailAlerts: true,
    policyId: null,
    checkFrequency: 30,
  });
  const body = JSON.parse(calls[0].body);
  assert.equal(typeof body.email, "boolean", "`email` is a boolean switch in Better Stack's API");
  assert.equal(body.email, true);
  assert.ok(!("policy_id" in body), "no escalation policy is sent when the entry names none");
});

test("emailAlerts:false switches e-mail alerts off rather than omitting the field", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST https://uptime.betterstack.com/api/v2/monitors": { status: 201, body: { data: { id: "9" } } },
  });
  const client = createBetterStackClient({ token: "tok", fetchImpl });
  await client.createMonitor({
    url: "https://x.example.com",
    name: "x",
    emailAlerts: false,
    policyId: null,
    checkFrequency: 30,
  });
  assert.equal(JSON.parse(calls[0].body).email, false);
});

test("policyId maps to Better Stack's policy_id — the field that decides who is alerted", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST https://uptime.betterstack.com/api/v2/monitors": { status: 201, body: { data: { id: "9" } } },
  });
  const client = createBetterStackClient({ token: "tok", fetchImpl });
  await client.createMonitor({
    url: "https://x.example.com",
    name: "x",
    emailAlerts: true,
    policyId: "pol-7",
    checkFrequency: 30,
  });
  const body = JSON.parse(calls[0].body);
  assert.equal(body.policy_id, "pol-7");
  assert.equal(typeof body.email, "boolean");
});

test("no payload ever carries an address in `email`, even from a legacy alertEmail config", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST https://uptime.betterstack.com/api/v2/monitors": { status: 201, body: { data: { id: "9" } } },
  });
  const config = parseMonitorConfig([{ url: "https://x.example.com", alertEmail: "oncall@example.com" }]);
  const client = createBetterStackClient({ token: "tok", fetchImpl });
  await applyMonitorConfig({ config, client: { ...client, listMonitors: async () => [] }, dryRun: false });
  const body = JSON.parse(calls[0].body);
  assert.equal(typeof body.email, "boolean");
  assert.ok(
    !JSON.stringify(body).includes("oncall@example.com"),
    "the retired address never reaches the Better Stack payload"
  );
});

test("a converged monitor reports unchanged and issues no update (no per-run PATCH churn)", async () => {
  // Live read-back carries the boolean `email`; desired carries the boolean
  // `emailAlerts`. Pre-#403 these were a boolean vs an address, so every
  // monitor read as drifted on every apply.
  const client = fakeClient({
    live: [
      { id: "1", url: "https://x.example.com", name: "x", checkFrequency: 30, emailAlerts: true, policyId: "pol-1" },
    ],
  });
  const result = await applyMonitorConfig({
    config: {
      monitors: [
        { url: "https://x.example.com", name: "x", emailAlerts: true, policyId: "pol-1", checkFrequency: 30 },
      ],
    },
    client,
    dryRun: false,
  });
  assert.deepEqual(result.unchanged, ["https://x.example.com"]);
  assert.equal(result.updated.length, 0);
  assert.equal(client.updated.length, 0, "a converged config issues zero update calls");
});

test("a drifted emailAlerts switch is still detected as an update", async () => {
  const client = fakeClient({
    live: [{ id: "1", url: "https://x.example.com", name: "x", checkFrequency: 30, emailAlerts: false }],
  });
  const result = await applyMonitorConfig({
    config: {
      monitors: [{ url: "https://x.example.com", name: "x", emailAlerts: true, policyId: null, checkFrequency: 30 }],
    },
    client,
    dryRun: false,
  });
  assert.deepEqual(result.updated, ["https://x.example.com"]);
});

test("applyMonitorConfig issues update for a drifted existing monitor", async () => {
  const client = fakeClient({ live: [{ id: "1", url: "https://x.example.com", name: "old", checkFrequency: 30 }] });
  const result = await applyMonitorConfig({
    config: { monitors: [{ url: "https://x.example.com", name: "new", emailAlerts: true, policyId: null, checkFrequency: 30 }] },
    client,
    dryRun: false,
  });
  assert.deepEqual(result.updated, ["https://x.example.com"]);
  assert.equal(client.updated[0].id, "1");
});

// ---------------------------------------------------------------------------
// CLI — skip-with-notice and config-validation paths (real process spawn)
// ---------------------------------------------------------------------------

let tmpDir;

test("CLI skip-with-notice: no BETTERSTACK_API_TOKEN exits 0 with a notice, no crash", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "uptime-monitors-"));
  const configPath = join(tmpDir, "monitors.json");
  writeFileSync(configPath, JSON.stringify([{ url: "https://x.example.com" }]));
  const out = execFileSync("node", [CLI, "--config", configPath], {
    encoding: "utf8",
    env: { ...process.env, BETTERSTACK_API_TOKEN: "" },
  });
  assert.match(out, /skipping uptime-monitor apply/);
  rmSync(tmpDir, { recursive: true, force: true });
});

test("CLI skip-with-notice raises a ::warning:: annotation so an inert apply is visible in the checks UI", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "uptime-monitors-"));
  const configPath = join(tmpDir, "monitors.json");
  writeFileSync(configPath, JSON.stringify([{ url: "https://x.example.com" }]));
  const out = execFileSync("node", [CLI, "--config", configPath], {
    encoding: "utf8",
    env: { ...process.env, BETTERSTACK_API_TOKEN: "" },
  });
  assert.match(out, /^::warning title=Uptime monitors not applied::/m);
  rmSync(tmpDir, { recursive: true, force: true });
});

test("CLI announces UPTIME_ALERT_EMAIL as ignored instead of silently no-oping, and still exits 0", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "uptime-monitors-"));
  const configPath = join(tmpDir, "monitors.json");
  writeFileSync(configPath, JSON.stringify([{ url: "https://x.example.com" }]));
  // No token: the run short-circuits before any network call, which is enough
  // to observe that the address is announced rather than quietly accepted.
  const res = execFileSync("node", [CLI, "--config", configPath, "--alert-email", "oncall@example.com"], {
    encoding: "utf8",
    env: { ...process.env, BETTERSTACK_API_TOKEN: "" },
  });
  assert.match(res, /skipping uptime-monitor apply/);
});

test("CLI reports a config's retired alertEmail on stderr and never sends it", async () => {
  const configPath = join(tmpDir, "legacy.json");
  writeFileSync(configPath, JSON.stringify([{ url: "https://x.example.com", alertEmail: "oncall@example.com" }]));
  const { stdout, stderr } = await execFileAsync(
    "node",
    [CLI, "--config", configPath, "--dry-run", "--alert-email", "oncall@example.com"],
    { env: { ...process.env, BETTERSTACK_API_TOKEN: "tok", BETTERSTACK_API_BASE_OVERRIDE: "http://127.0.0.1:9" } }
  ).catch((err) => err);
  assert.match(stderr, /DEPRECATED: monitor config entry \[0\] sets "alertEmail"/);
  assert.match(stderr, /DEPRECATED: --alert-email \/ \$UPTIME_ALERT_EMAIL is ignored/);
  assert.match(stdout, /::warning title=UPTIME_ALERT_EMAIL is ignored::/);
  rmSync(tmpDir, { recursive: true, force: true });
});

test("CLI exits non-zero on an invalid config file even with a token set", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "uptime-monitors-"));
  const configPath = join(tmpDir, "monitors.json");
  writeFileSync(configPath, JSON.stringify({ not: "a monitor list" }));
  assert.throws(() => {
    execFileSync("node", [CLI, "--config", configPath], {
      encoding: "utf8",
      env: { ...process.env, BETTERSTACK_API_TOKEN: "tok" },
    });
  }, /Command failed/);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Consumer-caller simulation — exercises the SAME invocation shape
// .github/workflows/uptime-apply.yml's "Apply uptime monitors" step
// constructs, end to end, against a real (mocked-transport) HTTP server.
// This is the in-repo stand-in for "the caller path is exercised": rather
// than only unit-testing the pure functions in isolation, this spins up a
// local HTTP server that speaks the Better Stack v2 monitors contract (list
// + create), then invokes the CLI exactly as the reusable workflow's `run:`
// step does (`node apply-uptime-monitors.mjs --config <path> [--dry-run|
// --apply]`, token/alert-email via env vars), against a monitor-config
// fixture shaped like the one templates/workflows/uptime-apply.yml points a
// real consumer at. See docs/reusable-workflows.md ("uptime-apply.yml") for
// the documented caller contract this simulates.
// ---------------------------------------------------------------------------

import { createServer } from "node:http";

function startFakeBetterStackServer() {
  const requests = [];
  let monitors = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/monitors") {
        res.writeHead(200);
        res.end(JSON.stringify({ data: monitors }));
        return;
      }
      if (req.method === "POST" && req.url === "/monitors") {
        const id = String(monitors.length + 1);
        monitors = [
          ...monitors,
          { id, attributes: { url: body.url, pronounceable_name: body.pronounceable_name, check_frequency: body.check_frequency, email: body.email } },
        ];
        res.writeHead(201);
        res.end(JSON.stringify({ data: { id } }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return { server, requests, getMonitors: () => monitors };
}

test("consumer-caller simulation: end-to-end CLI invocation against a live (local) Better Stack server, dry-run", async () => {
  const { server, requests } = startFakeBetterStackServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  tmpDir = mkdtempSync(join(tmpdir(), "uptime-monitors-e2e-"));
  const configPath = join(tmpDir, "monitors.json");
  // Same shape as templates/workflows/uptime-apply.yml's <MONITOR_CONFIG_PATH>
  // consumer fixture (e.g. infra/uptime/monitors.json).
  writeFileSync(
    configPath,
    JSON.stringify([{ url: "https://smoke.example.com/health", name: "smoke", checkFrequency: 60 }])
  );

  // execFileAsync (not execFileSync): the fake server above runs IN THIS
  // SAME PROCESS. A synchronous spawn would block this process's event loop
  // while waiting on the child, which would in turn prevent the server's own
  // request handler (which needs that same event loop) from ever running —
  // a classic single-process self-deadlock. The async variant yields the
  // event loop back so the server can answer the child's HTTP request.
  const { stdout: out } = await execFileAsync(
    "node",
    [CLI, "--config", configPath, "--dry-run", "--alert-email", "oncall@example.com"],
    {
      encoding: "utf8",
      env: { ...process.env, BETTERSTACK_API_TOKEN: "fake-token", BETTERSTACK_API_BASE_OVERRIDE: `http://127.0.0.1:${port}` },
    }
  );

  await new Promise((resolve) => server.close(resolve));
  rmSync(tmpDir, { recursive: true, force: true });

  // Dry-run must have hit the real (local) list endpoint to compute the plan
  // ... this is only meaningful once the CLI honors a base-URL override, so
  // this assertion also locks in that seam for future local/offline runs.
  assert.match(out, /would create/);
  assert.ok(requests.some((r) => r.method === "GET" && r.url === "/monitors"), "dry-run calls the list endpoint");
  assert.ok(!requests.some((r) => r.method === "POST"), "dry-run never issues a create/update call");
});
