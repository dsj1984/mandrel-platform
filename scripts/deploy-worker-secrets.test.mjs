import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCsv,
  parseSecretNames,
  resolveSecretValue,
  provisionWorkerSecrets,
} from "./deploy-worker-secrets.mjs";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("parseCsv trims entries and drops empties", () => {
  assert.deepEqual(parseCsv(" api , worker-cron ,, "), ["api", "worker-cron"]);
  assert.deepEqual(parseCsv(undefined), []);
});

test("parseSecretNames trims, skips blanks, and skips '#' comment lines", () => {
  const raw = ["# deploy-critical only", "TURSO_AUTH_TOKEN", "", "  UPSTREAM_API_KEY  ", "   # trailing note"].join("\n");
  assert.deepEqual(parseSecretNames(raw), ["TURSO_AUTH_TOKEN", "UPSTREAM_API_KEY"]);
  assert.deepEqual(parseSecretNames(""), []);
});

test("resolveSecretValue returns the value only for present, non-empty string entries", () => {
  const ctx = { A: "value", B: "", C: 42 };
  assert.equal(resolveSecretValue(ctx, "A"), "value");
  assert.equal(resolveSecretValue(ctx, "B"), null);
  assert.equal(resolveSecretValue(ctx, "C"), null);
  assert.equal(resolveSecretValue(ctx, "MISSING"), null);
  assert.equal(resolveSecretValue(null, "A"), null);
});

// ---------------------------------------------------------------------------
// provisionWorkerSecrets — orchestration with an injected wrangler runner
// ---------------------------------------------------------------------------

function collect() {
  const lines = [];
  const calls = [];
  return {
    lines,
    calls,
    log: (line) => lines.push(line),
    runWrangler: (args, stdinValue) => {
      calls.push({ args, stdinValue });
      return 0;
    },
  };
}

const BASE_ENV = {
  DEPLOY_ENV: "production",
  DEPLOYED_WORKERS: "api,worker-cron",
  WORKER_SECRETS: "TURSO_AUTH_TOKEN",
  SECRETS_CONTEXT: JSON.stringify({ TURSO_AUTH_TOKEN: "s3cret" }),
};

test("provisions each name onto each worker via versions secret put, then promotes with versions deploy -y", () => {
  const { log, runWrangler, calls } = collect();
  const code = provisionWorkerSecrets(BASE_ENV, { log, runWrangler });
  assert.equal(code, 0);

  assert.deepEqual(
    calls.map((c) => c.args.slice(0, 3).join(" ")),
    [
      "versions secret put", // api
      "versions deploy --name", // api promote
      "versions secret put", // worker-cron
      "versions deploy --name", // worker-cron promote
    ]
  );

  // put: value travels over stdin, never in argv.
  const put = calls[0];
  assert.deepEqual(put.args, ["versions", "secret", "put", "TURSO_AUTH_TOKEN", "--name", "api", "--env", "production"]);
  assert.equal(put.stdinValue, "s3cret");

  // promote: non-interactive -y, message names the Story.
  const promote = calls[1];
  assert.ok(promote.args.includes("-y"));
  assert.ok(promote.args.includes("--message"));
  assert.equal(promote.stdinValue, undefined);
});

test("secret values never appear in log output", () => {
  const { log, runWrangler, lines } = collect();
  provisionWorkerSecrets(BASE_ENV, { log, runWrangler });
  assert.ok(lines.every((l) => !l.includes("s3cret")));
});

test("zero resolved names is a notice + exit 0 (nothing to provision)", () => {
  const { log, runWrangler, calls, lines } = collect();
  const code = provisionWorkerSecrets(
    { ...BASE_ENV, WORKER_SECRETS: "\n# only comments\n\n" },
    { log, runWrangler }
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.ok(lines.some((l) => l.includes("resolved to zero names")));
});

test("a listed name absent (or empty) in the inherited context is a hard error", () => {
  const { log, runWrangler, lines } = collect();
  const code = provisionWorkerSecrets(
    { ...BASE_ENV, WORKER_SECRETS: "MISSING_SECRET" },
    { log, runWrangler }
  );
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes("'MISSING_SECRET' is not present (or empty)")));
});

test("malformed SECRETS_CONTEXT JSON is a hard error", () => {
  const { log, runWrangler } = collect();
  const code = provisionWorkerSecrets({ ...BASE_ENV, SECRETS_CONTEXT: "{not json" }, { log, runWrangler });
  assert.equal(code, 1);
});

test("a failing wrangler versions secret put aborts with exit 1", () => {
  const { log } = collect();
  const code = provisionWorkerSecrets(BASE_ENV, {
    log,
    runWrangler: (args) => (args[1] === "secret" ? 1 : 0),
  });
  assert.equal(code, 1);
});

test("a failing wrangler versions deploy aborts with exit 1", () => {
  const { log } = collect();
  const code = provisionWorkerSecrets(BASE_ENV, {
    log,
    runWrangler: (args) => (args[0] === "versions" && args[1] === "deploy" ? 1 : 0),
  });
  assert.equal(code, 1);
});
