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
  resolveFailedFile,
  defaultDeriveSubdomain,
  writeRollbackState,
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
// extractSubdomain — parses the Cloudflare REST subdomain response (M14)
// ---------------------------------------------------------------------------

test("extractSubdomain reads result.name from the REST subdomain response", () => {
  assert.equal(
    extractSubdomain('{"success":true,"errors":[],"messages":[],"result":{"name":"dsj1984"}}'),
    "dsj1984"
  );
});

test("extractSubdomain strips a trailing .workers.dev when the API echoes the host", () => {
  assert.equal(extractSubdomain('{"success":true,"result":{"name":"dsj1984.workers.dev"}}'), "dsj1984");
});

test("extractSubdomain returns null for unsuccessful, malformed, or missing bodies", () => {
  assert.equal(extractSubdomain('{"success":false,"result":null}'), null);
  assert.equal(extractSubdomain('{"result":{"name":""}}'), null);
  assert.equal(extractSubdomain('{"result":{"name":42}}'), null);
  assert.equal(extractSubdomain('{"result":{}}'), null);
  assert.equal(extractSubdomain('{"result":"dsj1984"}'), null);
  assert.equal(extractSubdomain("<html>not json</html>"), null);
  assert.equal(extractSubdomain(""), null);
});

// ---------------------------------------------------------------------------
// defaultDeriveSubdomain — the REST GET /accounts/{id}/workers/subdomain call
// ---------------------------------------------------------------------------

test("defaultDeriveSubdomain calls the workers/subdomain endpoint with a bearer token", async () => {
  let seenUrl;
  let seenOptions;
  const fetchImpl = async (url, options) => {
    seenUrl = url;
    seenOptions = options;
    return { ok: true, text: async () => '{"success":true,"result":{"name":"dsj1984"}}' };
  };
  const slug = await defaultDeriveSubdomain({ accountId: "acct-123", apiToken: "tok-abc" }, fetchImpl);
  assert.equal(slug, "dsj1984");
  assert.equal(
    seenUrl,
    "https://api.cloudflare.com/client/v4/accounts/acct-123/workers/subdomain"
  );
  assert.equal(seenOptions.method, "GET");
  assert.equal(seenOptions.headers.Authorization, "Bearer tok-abc");
});

test("defaultDeriveSubdomain returns null without creds, on non-2xx, and on network error", async () => {
  assert.equal(await defaultDeriveSubdomain({ accountId: "", apiToken: "tok" }, async () => ({})), null);
  assert.equal(await defaultDeriveSubdomain({ accountId: "a", apiToken: "" }, async () => ({})), null);
  assert.equal(
    await defaultDeriveSubdomain({ accountId: "a", apiToken: "t" }, async () => ({ ok: false, text: async () => "" })),
    null
  );
  assert.equal(
    await defaultDeriveSubdomain({ accountId: "a", apiToken: "t" }, async () => {
      throw new Error("ECONNRESET");
    }),
    null
  );
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
    { log, deriveSubdomain: async () => null, probe: async () => ({ status: 200, body: "{}" }) }
  );
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.failedWorkers, []);
  assert.ok(lines.some((l) => l.includes("Could not derive workers.dev subdomain")));
});

test("runSmoke derives the subdomain via the REST endpoint when not provided", async () => {
  const { log } = collectLogs();
  const probed = [];
  let seenCreds;
  const result = await runSmoke(
    {
      DEPLOYED_WORKERS: "api",
      SMOKE_PATHS: "/health",
      CLOUDFLARE_ACCOUNT_ID: "acct-123",
      CLOUDFLARE_API_TOKEN: "tok-abc",
    },
    {
      log,
      deriveSubdomain: async (creds) => {
        seenCreds = creds;
        return "dsj1984";
      },
      probe: async (url) => {
        probed.push(url);
        return { status: 200, body: "{}" };
      },
    }
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(probed, ["https://api.dsj1984.workers.dev/health"]);
  // The REST creds are threaded through from the environment.
  assert.deepEqual(seenCreds, { accountId: "acct-123", apiToken: "tok-abc" });
});

// ---------------------------------------------------------------------------
// resolveFailedFile — rollback-list path resolution (CWE-377 hardening)
// ---------------------------------------------------------------------------

test("resolveFailedFile honours an explicit SMOKE_FAILED_FILE verbatim (no mkdtemp)", () => {
  let mkdtempCalls = 0;
  const path = resolveFailedFile({ SMOKE_FAILED_FILE: "/tmp/smoke-failed-workers.txt" }, () => {
    mkdtempCalls++;
    return "/should/not/be/used";
  });
  assert.equal(path, "/tmp/smoke-failed-workers.txt");
  assert.equal(mkdtempCalls, 0);
});

test("resolveFailedFile trims a whitespace-only SMOKE_FAILED_FILE and falls back to mkdtemp", () => {
  const seen = [];
  const path = resolveFailedFile({ SMOKE_FAILED_FILE: "   " }, (prefix) => {
    seen.push(prefix);
    return "/var/folders/xyz/deploy-boot-smoke-Abc123";
  });
  // Fell through to the private-temp-dir branch, not the predictable path.
  assert.equal(seen.length, 1);
  assert.equal(path, "/var/folders/xyz/deploy-boot-smoke-Abc123/smoke-failed-workers.txt");
});

test("resolveFailedFile creates a private temp dir when SMOKE_FAILED_FILE is unset", () => {
  const seen = [];
  const path = resolveFailedFile({}, (prefix) => {
    seen.push(prefix);
    return "/var/folders/xyz/deploy-boot-smoke-Zzz999";
  });
  // The mkdtemp prefix is scoped under the OS temp dir and carries our label,
  // and the returned path lives INSIDE the freshly-created dir — never the
  // fixed, world-writable /tmp/smoke-failed-workers.txt.
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes("deploy-boot-smoke-"), "mkdtemp prefix carries the script label");
  assert.equal(path, "/var/folders/xyz/deploy-boot-smoke-Zzz999/smoke-failed-workers.txt");
  assert.notEqual(path, "/tmp/smoke-failed-workers.txt");
});

// ---------------------------------------------------------------------------
// writeRollbackState — the shared terminal writer (crash-path fix, M2)
// ---------------------------------------------------------------------------

test("writeRollbackState writes the sorted list and the smoke_failed flag", () => {
  const writes = [];
  const appends = [];
  writeRollbackState("/tmp/failed.txt", ["api", "worker-cron"], {
    githubEnv: "/tmp/gh-env",
    writeFile: (path, data) => writes.push({ path, data }),
    appendFile: (path, data) => appends.push({ path, data }),
  });
  assert.deepEqual(writes, [{ path: "/tmp/failed.txt", data: "api\nworker-cron\n" }]);
  assert.deepEqual(appends, [{ path: "/tmp/gh-env", data: "smoke_failed=true\n" }]);
});

test("writeRollbackState is a no-op for an empty worker list", () => {
  let wrote = false;
  let appended = false;
  writeRollbackState("/tmp/failed.txt", [], {
    githubEnv: "/tmp/gh-env",
    writeFile: () => {
      wrote = true;
    },
    appendFile: () => {
      appended = true;
    },
  });
  assert.equal(wrote, false);
  assert.equal(appended, false);
});

test("writeRollbackState skips the GITHUB_ENV append when githubEnv is unset (still writes the list)", () => {
  const writes = [];
  let appended = false;
  writeRollbackState("/tmp/failed.txt", ["api"], {
    writeFile: (path, data) => writes.push({ path, data }),
    appendFile: () => {
      appended = true;
    },
  });
  assert.deepEqual(writes, [{ path: "/tmp/failed.txt", data: "api\n" }]);
  assert.equal(appended, false);
});

// ---------------------------------------------------------------------------
// Crash-path terminal write (M2): runSmoke throwing must still mark every
// deployed worker for rollback. main() catches and calls writeRollbackState
// with uniqueSorted(parseCsv(DEPLOYED_WORKERS)); this asserts the exact
// derivation main() feeds the writer on the crash path.
// ---------------------------------------------------------------------------

test("crash-path derives the full deployed-worker rollback set (uniqueSorted + parseCsv)", () => {
  // Mirrors main()'s catch block: on an unhandled error, EVERY deployed
  // worker is marked (no per-worker attribution survives a crash).
  const deployed = uniqueSorted(parseCsv("worker-cron, api ,worker-cron"));
  const writes = [];
  const appends = [];
  writeRollbackState("/tmp/failed.txt", deployed, {
    githubEnv: "/tmp/gh-env",
    writeFile: (path, data) => writes.push({ path, data }),
    appendFile: (path, data) => appends.push({ path, data }),
  });
  assert.deepEqual(writes, [{ path: "/tmp/failed.txt", data: "api\nworker-cron\n" }]);
  assert.deepEqual(appends, [{ path: "/tmp/gh-env", data: "smoke_failed=true\n" }]);
});
