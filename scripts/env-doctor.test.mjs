#!/usr/bin/env node
/**
 * env-doctor.test.mjs — node:test suite for the shared env/secrets residency
 * doctor (Story #451).
 *
 * Pure helpers (manifest validation, the shape vocabulary, reconciliation,
 * exceptions, the exit contract) are exercised directly. The surfaces are
 * exercised through injected clients, so no test touches the network.
 *
 * Three assertions run the REAL CLI as a subprocess, because they are about
 * the process and cannot be observed in-process:
 *
 *   • the values-safety guarantee — a local HTTP server stands in for
 *     Infisical, and the test greps the full captured stdout+stderr of the run
 *     for every injected fixture value;
 *   • the pnpm-symlink entry guard — invoked through a symlink, the script
 *     must still run (Story #407: the naive guards exit 0 having done nothing);
 *   • the offline arm's exit codes.
 *
 * Run: node --test scripts/env-doctor.test.mjs
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  MANIFEST_SCHEMA,
  SHAPE_NAMES,
  SHAPE_VOCABULARY,
  applyExceptions,
  buildClients,
  checkShape,
  collectWorkflowReferences,
  computeExitCode,
  isAbsentStatus,
  parseCliArgs,
  parseDotenv,
  parseExceptions,
  parseManifest,
  parseWranglerVars,
  reconcileNames,
  redactUrl,
  renderReport,
  resolveScriptName,
  runDoctor,
  runOfflineChecks,
} from "./env-doctor.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "env-doctor.mjs");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function singleWorkerManifest() {
  return {
    environments: ["staging", "production"],
    workers: { site: { config: "wrangler.toml", scriptName: "acme-site-{env}" } },
    keys: [
      {
        name: "PUBLIC_SITE_URL",
        kind: "var",
        sensitivity: "public",
        residency: { local: "var", github: { scope: "environment", kind: "var" }, cloudflare: { workers: ["site"], kind: "var" } },
        infisical: { folder: "/", environments: ["staging", "production"] },
        shape: "url",
      },
      {
        name: "TURSO_AUTH_TOKEN",
        kind: "secret",
        sensitivity: "secret",
        residency: { local: "secret", github: { scope: "environment", kind: "secret" }, cloudflare: { workers: ["site"], kind: "secret" } },
        infisical: { folder: "/", environments: ["staging", "production"] },
      },
    ],
  };
}

function eightWorkerManifest() {
  const ids = ["api", "auth", "billing", "ingest", "jobs", "notify", "search", "web"];
  const workers = {};
  for (const id of ids) workers[id] = { scriptName: `swarm-${id}-{env}` };
  return {
    environments: ["staging", "production"],
    workers,
    keys: [
      {
        name: "SHARED_SIGNING_KEY",
        kind: "secret",
        sensitivity: "secret",
        residency: { local: "secret", github: null, cloudflare: { workers: ids, kind: "secret" } },
        infisical: { folder: "/shared", environments: ["staging", "production"] },
      },
    ],
  };
}

/** Create a throwaway repo root with the offline arm's inputs. */
function makeRepo({ workflow, envExample, wrangler }) {
  const root = mkdtempSync(join(tmpdir(), "env-doctor-repo-"));
  if (workflow !== undefined) {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), workflow);
  }
  if (envExample !== undefined) writeFileSync(join(root, ".env.example"), envExample);
  if (wrangler !== undefined) writeFileSync(join(root, "wrangler.toml"), wrangler);
  return root;
}

const CONSISTENT_REPO = {
  workflow: [
    "name: ci",
    "on: [push]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "        env:",
    "          TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}",
    "          SITE: ${{ vars.PUBLIC_SITE_URL }}",
    "          GH: ${{ secrets.GITHUB_TOKEN }}",
    "",
  ].join("\n"),
  envExample: "PUBLIC_SITE_URL=https://example.test\nTURSO_AUTH_TOKEN=\n",
  wrangler: '[vars]\nPUBLIC_SITE_URL = "https://example.test"\n',
};

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

test("parseManifest accepts a single-Worker manifest and normalizes it", () => {
  const m = parseManifest(singleWorkerManifest());
  assert.deepEqual(m.environments, ["staging", "production"]);
  assert.equal(m.keys.length, 2);
  assert.equal(m.keys[0].shape, "url");
  assert.equal(m.keys[1].shape, null);
  assert.equal(m.workers.site.scriptName, "acme-site-{env}");
});

test("parseManifest accepts an eight-Worker manifest under the same schema", () => {
  const m = parseManifest(eightWorkerManifest());
  assert.equal(Object.keys(m.workers).length, 8);
  assert.equal(m.keys[0].residency.cloudflare.workers.length, 8);
});

test("MANIFEST_SCHEMA is exported so the docs describe exactly one shape", () => {
  assert.ok(Object.hasOwn(MANIFEST_SCHEMA, "environments"));
  assert.ok(Object.hasOwn(MANIFEST_SCHEMA, "keys"));
});

test("parseManifest rejects an unknown shape and names it alongside the vocabulary", () => {
  const raw = singleWorkerManifest();
  raw.keys[0].shape = "phone-number";
  assert.throws(() => parseManifest(raw), (err) => {
    assert.match(err.message, /phone-number/);
    assert.match(err.message, /Supported shapes/);
    for (const name of SHAPE_NAMES) assert.ok(err.message.includes(name), `vocabulary should list ${name}`);
    return true;
  });
});

test("parseManifest rejects a cloudflare residency naming an unknown worker id", () => {
  const raw = singleWorkerManifest();
  raw.keys[0].residency.cloudflare.workers = ["nope"];
  assert.throws(() => parseManifest(raw), /unknown worker id "nope"/);
});

test("parseManifest rejects a duplicate key name and an infisical env outside the manifest", () => {
  const dup = singleWorkerManifest();
  dup.keys.push({ ...dup.keys[0] });
  assert.throws(() => parseManifest(dup), /declared more than once/);

  const badEnv = singleWorkerManifest();
  badEnv.keys[0].infisical.environments = ["preview"];
  assert.throws(() => parseManifest(badEnv), /absent from manifest.environments/);
});

test("resolveScriptName substitutes {env} per environment", () => {
  assert.equal(resolveScriptName("acme-site-{env}", "staging"), "acme-site-staging");
  assert.equal(resolveScriptName("acme-site-{env}", "production"), "acme-site-production");
  assert.equal(resolveScriptName("no-placeholder", "staging"), "no-placeholder");
});

// ---------------------------------------------------------------------------
// Shape vocabulary
// ---------------------------------------------------------------------------

test("the shape vocabulary is closed, and every entry is a literal anchored RegExp", () => {
  for (const [name, re] of Object.entries(SHAPE_VOCABULARY)) {
    assert.ok(re instanceof RegExp, `${name} must be a RegExp`);
    assert.ok(re.source.startsWith("^"), `${name} must be anchored at the start`);
    assert.ok(re.source.endsWith("$"), `${name} must be anchored at the end`);
  }
});

test("the engine constructs no RegExp from a non-literal — Semgrep blocks it, and so does this", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const code = source.replace(/^\s*\*.*$/gm, "");
  assert.ok(!/new RegExp\(/.test(code), "env-doctor.mjs must not call new RegExp()");
});

test("checkShape catches a scheme-less url and passes a well-formed one", () => {
  assert.equal(checkShape({ value: "example.test/path", shape: "url" }).ok, false);
  assert.equal(checkShape({ value: "https://example.test/path", shape: "url" }).ok, true);
  assert.equal(checkShape({ value: "http://example.test", shape: "https-url" }).ok, false);
});

test("checkShape's verdict never carries the value it inspected", () => {
  const secret = "sk-live-DO-NOT-LEAK-12345";
  const verdict = checkShape({ value: secret, shape: "url" });
  assert.equal(verdict.ok, false);
  assert.ok(!JSON.stringify(verdict).includes(secret), "verdict must not embed the value");
});

test("checkShape flags a value still holding its placeholder marker", () => {
  const verdict = checkShape({ value: "https://CHANGEME.example", shape: "url", placeholderPattern: "changeme" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /placeholder marker/);
});

test("the vocabulary covers the documented shapes", () => {
  assert.equal(checkShape({ value: "+14155550123", shape: "e164" }).ok, true);
  assert.equal(checkShape({ value: "4155550123", shape: "e164" }).ok, false);
  assert.equal(checkShape({ value: "   ", shape: "non-empty" }).ok, false);
  assert.equal(checkShape({ value: "42", shape: "integer" }).ok, true);
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

test("parseDotenv reads names, strips quotes and skips comments", () => {
  const parsed = parseDotenv('# c\nA=1\nexport B="two"\nC=\nnot-a-line\n');
  assert.deepEqual(Object.keys(parsed).sort(), ["A", "B", "C"]);
  assert.equal(parsed.B, "two");
});

test("parseWranglerVars reads TOML [vars] and [env.X.vars]", () => {
  const names = parseWranglerVars('[vars]\nA = "1"\n\n[env.production.vars]\nB = "2"\n\n[other]\nC = "3"\n', "wrangler.toml");
  assert.deepEqual(names, ["A", "B"]);
});

test("parseWranglerVars reads JSONC vars including per-environment blocks", () => {
  const text = '// comment\n{"vars": {"A": "1"}, "env": {"production": {"vars": {"B": "2"}}}}';
  assert.deepEqual(parseWranglerVars(text, "wrangler.jsonc"), ["A", "B"]);
});

test("collectWorkflowReferences finds secrets.* and vars.* anywhere in the text", () => {
  const refs = collectWorkflowReferences("${{ secrets.ALPHA }} and ${{ vars.BETA }} and secrets.GAMMA");
  assert.deepEqual(refs.secrets, ["ALPHA", "GAMMA"]);
  assert.deepEqual(refs.vars, ["BETA"]);
});

test("redactUrl drops the query string before a URL reaches a log line", () => {
  assert.equal(redactUrl("https://x.test/api/v4/secrets?projectId=p&environment=e"), "https://x.test/api/v4/secrets?…");
  assert.equal(redactUrl("https://x.test/api"), "https://x.test/api");
});

// ---------------------------------------------------------------------------
// Offline arm
// ---------------------------------------------------------------------------

test("runOfflineChecks is clean on a consistent repo", () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const { findings } = runOfflineChecks({ manifest: parseManifest(singleWorkerManifest()), repoRoot: root });
    assert.deepEqual(findings, [], `expected no findings, got ${JSON.stringify(findings, null, 2)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runOfflineChecks flags a workflow secrets.X reference no manifest key declares", () => {
  const root = makeRepo({
    ...CONSISTENT_REPO,
    workflow: `${CONSISTENT_REPO.workflow}          EXTRA: \${{ secrets.UNDECLARED_KEY }}\n`,
  });
  try {
    const { findings } = runOfflineChecks({ manifest: parseManifest(singleWorkerManifest()), repoRoot: root });
    const hit = findings.find((f) => f.key === "UNDECLARED_KEY");
    assert.ok(hit, "UNDECLARED_KEY should be reported");
    assert.equal(hit.kind, "undeclared-reference");
    assert.equal(hit.severity, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runOfflineChecks exempts the GitHub built-in token from the manifest requirement", () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const { findings } = runOfflineChecks({ manifest: parseManifest(singleWorkerManifest()), repoRoot: root });
    assert.ok(!findings.some((f) => f.key === "GITHUB_TOKEN"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runOfflineChecks reports a wrangler [vars] key the manifest never declares as an orphan", () => {
  const root = makeRepo({ ...CONSISTENT_REPO, wrangler: `${CONSISTENT_REPO.wrangler}STRAY_VAR = "x"\n` });
  try {
    const { findings } = runOfflineChecks({ manifest: parseManifest(singleWorkerManifest()), repoRoot: root });
    const hit = findings.find((f) => f.key === "STRAY_VAR");
    assert.ok(hit);
    assert.equal(hit.severity, "orphan");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reconciliation, exceptions, exit contract
// ---------------------------------------------------------------------------

test("reconcileNames reports both directions", () => {
  const findings = reconcileNames({ expected: ["A", "B"], present: ["B", "C"], surface: "github", environment: "staging" });
  assert.deepEqual(
    findings.map((f) => [f.key, f.severity]),
    [["A", "fail"], ["C", "orphan"]]
  );
});

test("an orphan alone exits 0, and 1 under --strict-orphans", () => {
  const findings = [{ severity: "orphan", key: "X", surface: "github" }];
  const surfaces = [{ surface: "github", status: "checked" }];
  assert.equal(computeExitCode({ findings, expired: [], surfaces, strictOrphans: false }), 0);
  assert.equal(computeExitCode({ findings, expired: [], surfaces, strictOrphans: true }), 1);
});

test("an unchecked surface never fails the run, but an errored surface always does", () => {
  assert.equal(
    computeExitCode({ findings: [], expired: [], surfaces: [{ surface: "github", status: "unchecked" }], strictOrphans: false }),
    0
  );
  assert.equal(
    computeExitCode({ findings: [], expired: [], surfaces: [{ surface: "github", status: "error" }], strictOrphans: false }),
    1
  );
});

test("parseExceptions requires a revisit-date on every entry", () => {
  assert.throws(() => parseExceptions([{ key: "A" }]), /revisit-date/);
  assert.throws(() => parseExceptions([{ key: "A", "revisit-date": "soon" }]), /revisit-date/);
  const ok = parseExceptions({ exceptions: [{ key: "A", "revisit-date": "2027-01-01", reason: "pending rotation" }] });
  assert.equal(ok[0].revisitDate, "2027-01-01");
});

test("a future exception suppresses its finding and is listed; a past one fails the run", () => {
  const findings = [{ severity: "fail", kind: "missing", key: "A", surface: "github", environment: "staging" }];
  const now = new Date("2026-09-07T00:00:00Z");

  const future = applyExceptions({
    findings,
    exceptions: parseExceptions([{ key: "A", "revisit-date": "2027-01-01", reason: "deferred" }]),
    now,
  });
  assert.equal(future.findings.length, 0);
  assert.equal(future.suppressed.length, 1);
  assert.equal(future.expired.length, 0);
  assert.equal(computeExitCode({ findings: future.findings, expired: future.expired, surfaces: [], strictOrphans: false }), 0);

  const past = applyExceptions({
    findings,
    exceptions: parseExceptions([{ key: "A", "revisit-date": "2026-01-01" }]),
    now,
  });
  assert.equal(past.expired.length, 1);
  assert.equal(computeExitCode({ findings: past.findings, expired: past.expired, surfaces: [], strictOrphans: false }), 1);
});

test("renderReport lists a suppressed exception and its revisit date in the summary", () => {
  const findings = [{ severity: "fail", kind: "missing", key: "A", surface: "github", environment: "staging" }];
  const applied = applyExceptions({
    findings,
    exceptions: parseExceptions([{ key: "A", "revisit-date": "2027-01-01", reason: "deferred pending rotation" }]),
    now: new Date("2026-09-07T00:00:00Z"),
  });
  const text = renderReport({ ...applied, surfaces: [], strictOrphans: false, environments: ["staging"] });
  assert.match(text, /Suppressed by an active exception/);
  assert.match(text, /A \[github\/staging\] — revisit 2027-01-01: deferred pending rotation/);
  assert.match(text, /1 suppressed/);
});

test("renderReport calls out an expired exception as run-failing", () => {
  const applied = applyExceptions({
    findings: [],
    exceptions: parseExceptions([{ key: "B", "revisit-date": "2026-01-01" }]),
    now: new Date("2026-09-07T00:00:00Z"),
  });
  const text = renderReport({ ...applied, surfaces: [], strictOrphans: false, environments: ["staging"] });
  assert.match(text, /EXPIRED exceptions \(these fail the run\)/);
  assert.match(text, /B — revisit-date 2026-01-01 has passed/);
});

test("isAbsentStatus is true only for a 404", () => {
  assert.equal(isAbsentStatus({ httpStatus: 404 }), true);
  assert.equal(isAbsentStatus({ httpStatus: 401 }), false);
  assert.equal(isAbsentStatus({ httpStatus: 500 }), false);
  assert.equal(isAbsentStatus(new Error("network down")), false);
});

// ---------------------------------------------------------------------------
// runDoctor — the fail-closed contract
// ---------------------------------------------------------------------------

test("with no credentials, every live surface is unchecked, the offline arm still runs, and the run exits 0", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging", "production"],
    });
    assert.equal(report.exitCode, 0);
    const byName = Object.fromEntries(report.surfaces.map((s) => [s.surface, s]));
    assert.equal(byName.offline.status, "checked");
    for (const surface of ["github", "cloudflare", "infisical"]) {
      assert.equal(byName[surface].status, "unchecked", `${surface} should be unchecked`);
      assert.ok(byName[surface].notice, `${surface} should carry a notice`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-404 probe failure becomes an error surface and exits 1 — never 'no drift'", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const unauthorized = () => {
      const err = new Error("GET https://api.github.com/… failed: 401 Unauthorized");
      err.httpStatus = 401;
      throw err;
    };
    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging"],
      github: { repositoryNames: unauthorized, environmentNames: unauthorized },
    });
    const gh = report.surfaces.find((s) => s.surface === "github");
    assert.equal(gh.status, "error");
    assert.notEqual(gh.status, "unchecked");
    assert.match(gh.notice, /NOT degraded/);
    assert.equal(report.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Cloudflare probe resolves {env} in scriptName once per environment", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  const asked = [];
  try {
    await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging", "production"],
      cloudflare: {
        secretNames: async (scriptName) => {
          asked.push(scriptName);
          return ["TURSO_AUTH_TOKEN"];
        },
      },
    });
    assert.deepEqual(asked, ["acme-site-staging", "acme-site-production"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Cloudflare probe fans {env} across all eight Workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-doctor-eight-"));
  const asked = [];
  try {
    await runDoctor({
      manifest: parseManifest(eightWorkerManifest()),
      repoRoot: root,
      environments: ["staging", "production"],
      cloudflare: {
        secretNames: async (scriptName) => {
          asked.push(scriptName);
          return ["SHARED_SIGNING_KEY"];
        },
      },
    });
    assert.equal(asked.length, 16);
    assert.ok(asked.includes("swarm-billing-staging"));
    assert.ok(asked.includes("swarm-web-production"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 404 Worker is a reported failure, not a silent pass", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging"],
      cloudflare: {
        secretNames: async () => {
          const err = new Error("not found");
          err.httpStatus = 404;
          throw err;
        },
      },
    });
    const hit = report.findings.find((f) => f.surface === "cloudflare");
    assert.match(hit.detail, /does not exist \(404\)/);
    assert.equal(report.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the residency probe asks Infisical for names only; the shape stage is the sole value reader", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  let valueReads = 0;
  try {
    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging"],
      infisical: {
        listNames: async () => ["PUBLIC_SITE_URL", "TURSO_AUTH_TOKEN"],
        listValues: async () => {
          valueReads += 1;
          return new Map([["PUBLIC_SITE_URL", "https://example.test"]]);
        },
      },
    });
    assert.equal(report.exitCode, 0);
    // One value read, for the one environment that has a shaped key —
    // TURSO_AUTH_TOKEN declares no shape and is never valued.
    assert.equal(valueReads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scheme-less url value is reported shape-fail and exits 1", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging"],
      infisical: {
        listNames: async () => ["PUBLIC_SITE_URL", "TURSO_AUTH_TOKEN"],
        listValues: async () => new Map([["PUBLIC_SITE_URL", "example.test"]]),
      },
    });
    const hit = report.findings.find((f) => f.kind === "shape-fail");
    assert.ok(hit, "expected a shape-fail finding");
    assert.equal(hit.key, "PUBLIC_SITE_URL");
    assert.equal(report.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test("parseCliArgs rejects an unknown flag rather than ignoring a typo", () => {
  assert.throws(() => parseCliArgs(["--manifset", "x.json"]), /unknown argument/);
  const opts = parseCliArgs(["--manifest", "m.json", "--offline", "--strict-orphans"]);
  assert.equal(opts.manifest, "m.json");
  assert.equal(opts.offline, true);
  assert.equal(opts.strictOrphans, true);
});

test("buildClients yields null for every surface whose credential is absent", () => {
  const clients = buildClients({ repo: "o/r", cloudflareAccount: "acct", infisicalProject: "proj" }, {});
  assert.equal(clients.github, null);
  assert.equal(clients.cloudflare, null);
  assert.equal(clients.infisical, null);
});

test("buildClients accepts EITHER a pre-issued Infisical token or universal-auth credentials", () => {
  const opts = { repo: "o/r", cloudflareAccount: "acct", infisicalProject: "proj" };
  assert.ok(buildClients(opts, { INFISICAL_TOKEN: "t" }).infisical);
  assert.ok(buildClients(opts, { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "sec" }).infisical);
  assert.equal(buildClients(opts, { INFISICAL_CLIENT_ID: "id" }).infisical, null);
});

// ---------------------------------------------------------------------------
// Subprocess assertions
// ---------------------------------------------------------------------------

/** Run the real CLI, returning {code, stdout, stderr} without throwing. */
async function runCli(args, { cwd, env } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("CLI --offline exits 0 on a consistent fixture", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  const manifestPath = join(root, "env.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(singleWorkerManifest()));
  try {
    const run = await runCli(["--manifest", manifestPath, "--repo-root", root, "--offline"]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /No drift found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI --offline exits non-zero when a workflow references a secret the manifest omits", async () => {
  const root = makeRepo({
    ...CONSISTENT_REPO,
    workflow: `${CONSISTENT_REPO.workflow}          EXTRA: \${{ secrets.UNDECLARED_KEY }}\n`,
  });
  const manifestPath = join(root, "env.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(singleWorkerManifest()));
  try {
    const run = await runCli(["--manifest", manifestPath, "--repo-root", root, "--offline"]);
    assert.equal(run.code, 1);
    assert.match(run.stdout, /UNDECLARED_KEY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI with no credentials prints one ::notice per unchecked surface and exits 0", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  const manifestPath = join(root, "env.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(singleWorkerManifest()));
  try {
    const run = await runCli(["--manifest", manifestPath, "--repo-root", root, "--environments", "staging,production"], {
      env: {
        ENV_DRIFT_GITHUB_TOKEN: "",
        CLOUDFLARE_API_TOKEN: "",
        INFISICAL_TOKEN: "",
        INFISICAL_CLIENT_ID: "",
        INFISICAL_CLIENT_SECRET: "",
      },
    });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const notices = run.stdout.split("\n").filter((l) => l.startsWith("::notice title=env-doctor surface unchecked::"));
    assert.equal(notices.length, 3, `expected one notice per absent surface, got:\n${run.stdout}`);
    assert.match(run.stdout, /offline: checked/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI is still invoked through a symlinked path — the pnpm store shape (Story #407)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-doctor-symlink-"));
  const link = join(dir, "env-doctor.mjs");
  try {
    symlinkSync(SCRIPT, link);
    const { stdout } = await execFileAsync(process.execPath, [link, "--help"]);
    assert.match(stdout, /Usage: node scripts\/env-doctor\.mjs/, "the entry guard must fire through a symlink");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no secret VALUE reaches stdout or stderr on a real run against a mock Infisical", async () => {
  // Every value the mock server will hand out. The assertion below greps the
  // full captured output for each one — this is the values-safety guarantee.
  //
  // Both canaries are deliberately LOW-entropy dictionary phrases rather than
  // realistic key material. A realistic-looking token here is a true positive
  // for gitleaks' `generic-api-key` rule (it reads entropy next to a
  // secret-shaped name), and the honest fix is a fixture that is not
  // key-shaped — not an allowlist entry, which would carve a standing hole in
  // the secret scan to accommodate a test. Uniqueness is what the grep needs,
  // and a distinctive phrase supplies it just as well as entropy does.
  const INJECTED = {
    PUBLIC_SITE_URL: "example.test/no-scheme-here",
    TURSO_AUTH_TOKEN: "canary-value-that-must-never-be-printed",
  };

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url.startsWith("/api/v1/auth/universal-auth/login")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accessToken: "mock-token", expiresIn: 3600, tokenType: "Bearer" }));
      return;
    }
    if (req.url.startsWith("/api/v4/secrets")) {
      const withValues = new URL(req.url, "http://localhost").searchParams.get("viewSecretValue") === "true";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          secrets: Object.entries(INJECTED).map(([secretKey, secretValue]) => ({
            secretKey,
            ...(withValues ? { secretValue } : {}),
          })),
        })
      );
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const site = `http://127.0.0.1:${server.address().port}`;

  const root = makeRepo(CONSISTENT_REPO);
  const manifestPath = join(root, "env.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(singleWorkerManifest()));

  try {
    const run = await runCli(
      [
        "--manifest",
        manifestPath,
        "--repo-root",
        root,
        "--environments",
        "staging",
        "--infisical-project",
        "proj-1",
        "--infisical-site",
        site,
        "--json",
      ],
      { env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "sec", ENV_DRIFT_GITHUB_TOKEN: "", CLOUDFLARE_API_TOKEN: "" } }
    );

    // The scheme-less PUBLIC_SITE_URL must be caught...
    assert.equal(run.code, 1, `expected a shape failure to fail the run:\n${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /shape-fail/);

    // The reported finding names the KEY — that is the whole diagnostic value
    // of the shape stage, and it is safe because a name is not a value.
    const captured = run.stdout + run.stderr;
    assert.ok(captured.includes("PUBLIC_SITE_URL"), "the failing key's NAME should be reported");

    // ...and not one injected value may appear anywhere in the output. Both
    // keys are checked, including TURSO_AUTH_TOKEN, whose value the mock
    // served on the same values-bearing response that produced the verdict
    // above — so a leak of it would be a leak of a value the doctor read but
    // had no finding for, the easiest kind to ship unnoticed.
    for (const [name, value] of Object.entries(INJECTED)) {
      assert.ok(!captured.includes(value), `the VALUE of ${name} leaked into the doctor's output`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Shipped workflow shape
// ---------------------------------------------------------------------------

test("env-drift.yml declares the documented contract and asserts its own platform SHA", () => {
  const wf = readFileSync(join(HERE, "..", ".github", "workflows", "env-drift.yml"), "utf8");
  assert.match(wf, /^on:\n\s+workflow_call:/m);
  for (const input of ["manifest:", "environments:", "exceptions:", "runner:"]) {
    assert.ok(wf.includes(input), `env-drift.yml should declare the ${input} input`);
  }
  for (const secret of [
    "INFISICAL_TOKEN:",
    "INFISICAL_CLIENT_ID:",
    "INFISICAL_CLIENT_SECRET:",
    "ENV_DRIFT_GITHUB_TOKEN:",
    "CLOUDFLARE_API_TOKEN:",
  ]) {
    assert.ok(wf.includes(secret), `env-drift.yml should declare the ${secret} secret`);
  }
  // Story #415: an unresolvable platform ref silently runs main.
  assert.match(wf, /job\.workflow_sha/);
  assert.match(wf, /\^\[0-9a-f\]\{40\}\$/);
  // The sparse-checkout list is exhaustive, so the module graph must be named.
  assert.match(wf, /scripts\/env-doctor\.mjs/);
  assert.match(wf, /scripts\/lib\//);
  // Skip-with-notice is the script's job; a job-level `if:` renders as neither
  // pass nor fail, which is the signal this workflow must never emit.
  assert.ok(!/^\s{4}if:/m.test(wf), "env-drift.yml must not gate its job with `if:`");
});

test("the caller template is thin and pins the platform by SHA", () => {
  const tpl = readFileSync(join(HERE, "..", "templates", "workflows", "env-drift.yml"), "utf8");
  assert.match(tpl, /uses: dsj1984\/mandrel-platform\/\.github\/workflows\/env-drift\.yml@<MANDREL_PLATFORM_SHA>/);
  assert.match(tpl, /manifest:/);
});
