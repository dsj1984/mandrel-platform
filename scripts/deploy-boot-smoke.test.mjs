import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCsv,
  parseSmokePaths,
  extractSubdomain,
  parseVersionField,
  buildProbePlan,
  uniqueSorted,
  probeUrl,
  runSmoke,
} from "./deploy-boot-smoke.mjs";

// ---------------------------------------------------------------------------
// parseCsv / parseSmokePaths
// ---------------------------------------------------------------------------

test("parseCsv trims entries and drops empties", () => {
  assert.deepEqual(parseCsv(" api , worker-cron ,, "), ["api", "worker-cron"]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv(undefined), []);
});

test("parseSmokePaths enforces a leading slash", () => {
  assert.deepEqual(parseSmokePaths("/,/portal,api/health"), ["/", "/portal", "/api/health"]);
  assert.deepEqual(parseSmokePaths("/health"), ["/health"]);
});

// ---------------------------------------------------------------------------
// extractSubdomain
// ---------------------------------------------------------------------------

test("extractSubdomain finds the first workers.dev slug in whoami output", () => {
  const whoami = [
    "Getting User settings...",
    "👋 You are logged in!",
    "┌──────────────┬──────────────────────────┐",
    "│ Account Name │ dsj1984's Account        │",
    "│ Subdomain    │ dsj1984.workers.dev      │",
    "└──────────────┴──────────────────────────┘",
  ].join("\n");
  assert.equal(extractSubdomain(whoami), "dsj1984");
});

test("extractSubdomain returns null when no slug is present", () => {
  assert.equal(extractSubdomain("no subdomain here"), null);
  assert.equal(extractSubdomain(""), null);
});

// ---------------------------------------------------------------------------
// parseVersionField — the jq/JSON.parse replacement for grep-for-"version"
// ---------------------------------------------------------------------------

test("parseVersionField reads the top-level version string", () => {
  assert.equal(parseVersionField('{"status":"ok","version":"abc123"}'), "abc123");
});

test("parseVersionField rejects non-JSON, non-object, and missing/empty fields", () => {
  assert.equal(parseVersionField("<html>hi</html>"), null);
  assert.equal(parseVersionField('"version"'), null);
  assert.equal(parseVersionField('["version"]'), null);
  assert.equal(parseVersionField("null"), null);
  assert.equal(parseVersionField('{"status":"ok"}'), null);
  assert.equal(parseVersionField('{"version":""}'), null);
  assert.equal(parseVersionField('{"version":42}'), null);
});

test("parseVersionField never matches a nested version key (grep-era false positive)", () => {
  // The old grep/sed extraction would have matched deps.version here.
  assert.equal(parseVersionField('{"status":"ok","deps":{"version":"9.9.9"}}'), null);
});

// ---------------------------------------------------------------------------
// buildProbePlan — the smoke_base_url duplication fix
// ---------------------------------------------------------------------------

test("buildProbePlan with a shared base URL probes each path exactly once, attributing all workers", () => {
  const plan = buildProbePlan({
    workers: ["api", "worker-cron"],
    paths: ["/", "/health"],
    smokeBaseUrl: "https://godomio.com/",
    subdomain: "",
  });
  assert.equal(plan.length, 2); // one per PATH, not workers × paths
  assert.deepEqual(
    plan.map((e) => e.url),
    ["https://godomio.com/", "https://godomio.com/health"]
  );
  for (const entry of plan) {
    assert.deepEqual(entry.attributedWorkers, ["api", "worker-cron"]);
  }
});

test("buildProbePlan without a base URL probes workers × paths on workers.dev, attributing per worker", () => {
  const plan = buildProbePlan({
    workers: ["api", "worker-cron"],
    paths: ["/health"],
    smokeBaseUrl: "",
    subdomain: "dsj1984",
  });
  assert.deepEqual(
    plan.map((e) => e.url),
    [
      "https://api.dsj1984.workers.dev/health",
      "https://worker-cron.dsj1984.workers.dev/health",
    ]
  );
  assert.deepEqual(plan[0].attributedWorkers, ["api"]);
  assert.deepEqual(plan[1].attributedWorkers, ["worker-cron"]);
});

test("uniqueSorted de-duplicates and sorts (mirrors sort -u)", () => {
  assert.deepEqual(uniqueSorted(["b", "a", "b"]), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// probeUrl — retry semantics
// ---------------------------------------------------------------------------

test("probeUrl returns the first non-transient response without retrying", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { status: 200, text: async () => "ok" };
  };
  const res = await probeUrl("https://x.example/health", { fetchImpl, sleep: async () => {} });
  assert.equal(res.status, 200);
  assert.equal(res.body, "ok");
  assert.equal(calls, 1);
});

test("probeUrl never follows redirects (curl-without--L parity: a 302 is a failure)", async () => {
  let seenOptions;
  const fetchImpl = async (url, options) => {
    seenOptions = options;
    return { status: 302, text: async () => "" };
  };
  const res = await probeUrl("https://x.example/health", { fetchImpl, sleep: async () => {} });
  assert.equal(seenOptions.redirect, "manual");
  assert.equal(res.status, 302); // surfaces as non-200 → smoke failure
});

test("probeUrl does not retry a non-200 non-transient status (e.g. 404)", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { status: 404, text: async () => "nope" };
  };
  const res = await probeUrl("https://x.example/health", { fetchImpl, sleep: async () => {} });
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
});

test("probeUrl retries transient statuses and network errors up to the retry budget", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNRESET");
    if (calls === 2) return { status: 503, text: async () => "" };
    return { status: 200, text: async () => "ok" };
  };
  const res = await probeUrl("https://x.example/health", { fetchImpl, sleep: async () => {} });
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
});

test("probeUrl reports status 0 when every attempt fails at the network layer", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new Error("timeout");
  };
  const res = await probeUrl("https://x.example/health", { fetchImpl, retries: 2, sleep: async () => {} });
  assert.equal(res.status, 0);
  assert.equal(calls, 3); // initial + 2 retries
});

// ---------------------------------------------------------------------------
// runSmoke — end-to-end orchestration with injected deps
// ---------------------------------------------------------------------------

function collectLogs() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test("runSmoke passes when every probe returns 200", async () => {
  const { log } = collectLogs();
  const result = await runSmoke(
    { DEPLOYED_WORKERS: "api,worker-cron", SMOKE_PATHS: "/health", WORKERS_DEV_SUBDOMAIN: "dsj1984" },
    { log, probe: async () => ({ status: 200, body: "{}" }) }
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.failedWorkers, []);
});

test("runSmoke attributes a workers.dev probe failure to that worker only", async () => {
  const { log } = collectLogs();
  const result = await runSmoke(
    { DEPLOYED_WORKERS: "api,worker-cron", SMOKE_PATHS: "/health", WORKERS_DEV_SUBDOMAIN: "dsj1984" },
    {
      log,
      probe: async (url) =>
        url.startsWith("https://api.") ? { status: 500, body: "" } : { status: 200, body: "{}" },
    }
  );
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.failedWorkers, ["api"]);
});

test("runSmoke with a shared base URL probes each path once and rolls back ALL deployed workers on failure", async () => {
  const { log } = collectLogs();
  const probed = [];
  const result = await runSmoke(
    {
      DEPLOYED_WORKERS: "api,worker-cron",
      SMOKE_PATHS: "/,/health",
      SMOKE_BASE_URL: "https://godomio.com",
    },
    {
      log,
      probe: async (url) => {
        probed.push(url);
        return url.endsWith("/health") ? { status: 502, body: "" } : { status: 200, body: "{}" };
      },
    }
  );
  // Each path requested exactly once — not once per worker.
  assert.deepEqual(probed, ["https://godomio.com/", "https://godomio.com/health"]);
  assert.equal(result.exitCode, 1);
  // Shared-host failure → explicit rollback of everything deployed.
  assert.deepEqual(result.failedWorkers, ["api", "worker-cron"]);
});

test("runSmoke verify-commit-sha passes on a matching top-level version", async () => {
  const { log } = collectLogs();
  const result = await runSmoke(
    {
      DEPLOYED_WORKERS: "api",
      SMOKE_PATHS: "/health",
      WORKERS_DEV_SUBDOMAIN: "dsj1984",
      VERIFY_COMMIT_SHA: "true",
      EXPECTED_SHA: "deadbeef",
    },
    { log, probe: async () => ({ status: 200, body: '{"status":"ok","version":"deadbeef"}' }) }
  );
  assert.equal(result.exitCode, 0);
});

test("runSmoke verify-commit-sha fails on mismatch and on unparsable version", async () => {
  const { log } = collectLogs();
  const mismatch = await runSmoke(
    {
      DEPLOYED_WORKERS: "api",
      SMOKE_PATHS: "/health",
      WORKERS_DEV_SUBDOMAIN: "dsj1984",
      VERIFY_COMMIT_SHA: "true",
      EXPECTED_SHA: "deadbeef",
    },
    { log, probe: async () => ({ status: 200, body: '{"version":"cafef00d"}' }) }
  );
  assert.equal(mismatch.exitCode, 1);
  assert.deepEqual(mismatch.failedWorkers, ["api"]);

  const unparsable = await runSmoke(
    {
      DEPLOYED_WORKERS: "api",
      SMOKE_PATHS: "/health",
      WORKERS_DEV_SUBDOMAIN: "dsj1984",
      VERIFY_COMMIT_SHA: "true",
      EXPECTED_SHA: "deadbeef",
    },
    { log, probe: async () => ({ status: 200, body: "<html>ok</html>" }) }
  );
  assert.equal(unparsable.exitCode, 1);
  assert.deepEqual(unparsable.failedWorkers, ["api"]);
});

test("runSmoke runs a consumer smoke-command with WORKERS + SMOKE_BASE_URL exported", async () => {
  const { log } = collectLogs();
  let seen;
  const result = await runSmoke(
    {
      DEPLOYED_WORKERS: "api,worker-cron",
      SMOKE_COMMAND: "./my-smoke.sh",
      SMOKE_BASE_URL: "https://godomio.com",
    },
    {
      log,
      runShell: (cmd, env) => {
        seen = { cmd, env };
        return 0;
      },
    }
  );
  assert.equal(result.exitCode, 0);
  assert.equal(seen.cmd, "./my-smoke.sh");
  assert.equal(seen.env.WORKERS, "api,worker-cron");
  assert.equal(seen.env.SMOKE_BASE_URL, "https://godomio.com");
});

test("runSmoke marks every deployed worker for rollback when the consumer smoke-command fails", async () => {
  const { log } = collectLogs();
  const result = await runSmoke(
    { DEPLOYED_WORKERS: "b-worker,a-worker", SMOKE_COMMAND: "exit 1" },
    { log, runShell: () => 1 }
  );
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.failedWorkers, ["a-worker", "b-worker"]);
});

test("runSmoke fails without a rollback list when no subdomain is derivable", async () => {
  const { log, lines } = collectLogs();
  const result = await runSmoke(
    { DEPLOYED_WORKERS: "api", SMOKE_PATHS: "/health" },
    { log, whoami: () => "not logged in", probe: async () => ({ status: 200, body: "{}" }) }
  );
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.failedWorkers, []);
  assert.ok(lines.some((l) => l.includes("Could not derive workers.dev subdomain")));
});

test("runSmoke derives the subdomain from whoami output when not provided", async () => {
  const { log } = collectLogs();
  const probed = [];
  const result = await runSmoke(
    { DEPLOYED_WORKERS: "api", SMOKE_PATHS: "/health" },
    {
      log,
      whoami: () => "│ Subdomain │ dsj1984.workers.dev │",
      probe: async (url) => {
        probed.push(url);
        return { status: 200, body: "{}" };
      },
    }
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(probed, ["https://api.dsj1984.workers.dev/health"]);
});
