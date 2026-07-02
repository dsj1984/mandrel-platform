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
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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
  assert.equal(monitors[0].alertEmail, null);
  assert.equal(monitors[0].checkFrequency, DEFAULT_CHECK_FREQUENCY_SECONDS);
});

test("parseMonitorConfig accepts a wrapped { monitors: [...] } object", () => {
  const { monitors } = parseMonitorConfig({
    monitors: [{ url: "https://x.example.com", name: "x", alertEmail: "a@b.com", checkFrequency: 60 }],
  });
  assert.deepEqual(monitors, [
    { url: "https://x.example.com", name: "x", alertEmail: "a@b.com", checkFrequency: 60 },
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

// ---------------------------------------------------------------------------
// diffMonitors
// ---------------------------------------------------------------------------

test("diffMonitors classifies a brand-new url as toCreate", () => {
  const desired = [{ url: "https://new.example.com", name: "new", alertEmail: null, checkFrequency: 30 }];
  const { toCreate, toUpdate, unchanged } = diffMonitors(desired, []);
  assert.equal(toCreate.length, 1);
  assert.equal(toUpdate.length, 0);
  assert.equal(unchanged.length, 0);
});

test("diffMonitors classifies a matching, identical url as unchanged", () => {
  const desired = [{ url: "https://x.example.com", name: "x", alertEmail: null, checkFrequency: 30 }];
  const live = [{ id: "1", url: "https://x.example.com", name: "x", checkFrequency: 30 }];
  const { toCreate, toUpdate, unchanged } = diffMonitors(desired, live);
  assert.equal(toCreate.length, 0);
  assert.equal(toUpdate.length, 0);
  assert.deepEqual(unchanged, ["https://x.example.com"]);
});

test("diffMonitors classifies a url with a drifted name/frequency as toUpdate", () => {
  const desired = [{ url: "https://x.example.com", name: "renamed", alertEmail: null, checkFrequency: 60 }];
  const live = [{ id: "1", url: "https://x.example.com", name: "x", checkFrequency: 30 }];
  const { toUpdate } = diffMonitors(desired, live);
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].id, "1");
});

test("diffMonitors url matching is trailing-slash and case insensitive", () => {
  const desired = [{ url: "https://X.example.com/", name: "x", alertEmail: null, checkFrequency: 30 }];
  const live = [{ id: "1", url: "https://x.example.com", name: "x", checkFrequency: 30 }];
  const { toCreate, unchanged } = diffMonitors(desired, live);
  assert.equal(toCreate.length, 0);
  assert.deepEqual(unchanged, ["https://X.example.com/"]);
});

test("diffMonitors never proposes deleting a live monitor absent from desired (additive apply only)", () => {
  const desired = [{ url: "https://kept.example.com", name: "kept", alertEmail: null, checkFrequency: 30 }];
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
            attributes: { url: "https://a.example.com", pronounceable_name: "a", check_frequency: 30, email: "a@b.com" },
          },
        ],
      },
    },
  });
  const client = createBetterStackClient({ token: "tok", fetchImpl });
  const monitors = await client.listMonitors();
  assert.deepEqual(monitors, [
    { id: "42", url: "https://a.example.com", name: "a", checkFrequency: 30, alertEmail: "a@b.com" },
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
    config: { monitors: [{ url: "https://x.example.com", name: "x", alertEmail: null, checkFrequency: 30 }] },
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
    config: { monitors: [{ url: "https://x.example.com", name: "x", alertEmail: null, checkFrequency: 30 }] },
    client,
    dryRun: false,
  });
  assert.deepEqual(result.created, ["https://x.example.com"]);
  assert.equal(client.created.length, 1);
});

test("applyMonitorConfig falls back to defaultAlertEmail when an entry sets none", async () => {
  const client = fakeClient({ live: [] });
  await applyMonitorConfig({
    config: { monitors: [{ url: "https://x.example.com", name: "x", alertEmail: null, checkFrequency: 30 }] },
    client,
    dryRun: false,
    defaultAlertEmail: "oncall@example.com",
  });
  assert.equal(client.created[0].alertEmail, "oncall@example.com");
});

test("applyMonitorConfig issues update for a drifted existing monitor", async () => {
  const client = fakeClient({ live: [{ id: "1", url: "https://x.example.com", name: "old", checkFrequency: 30 }] });
  const result = await applyMonitorConfig({
    config: { monitors: [{ url: "https://x.example.com", name: "new", alertEmail: null, checkFrequency: 30 }] },
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
