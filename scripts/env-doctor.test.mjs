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
  KEY_SCHEMA,
  MANIFEST_SCHEMA,
  SLUG_MAPPED_SURFACES,
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
  resolveSurfaceEnvironment,
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

test("parseManifest normalizes the single-object residency.github to a one-entry array", () => {
  const m = parseManifest(singleWorkerManifest());
  // The authored shape is an object; the parsed shape is always an array, so
  // probeGitHub reads exactly one shape. `environments` defaults to all of
  // manifest.environments, the same treatment infisical.environments gets.
  assert.deepEqual(m.keys[0].residency.github, [
    { scope: "environment", kind: "var", environments: ["staging", "production"] },
  ]);
});

test("parseManifest accepts the array form and defaults environments per entry", () => {
  const raw = singleWorkerManifest();
  raw.keys[0].residency.github = [
    { scope: "repository", kind: "var" },
    { scope: "environment", kind: "var", environments: ["production"] },
  ];
  const m = parseManifest(raw);
  assert.deepEqual(m.keys[0].residency.github, [
    { scope: "repository", kind: "var", environments: ["staging", "production"] },
    { scope: "environment", kind: "var", environments: ["production"] },
  ]);
});

test("parseManifest rejects an residency.github environments slug outside manifest.environments", () => {
  const raw = singleWorkerManifest();
  raw.keys[0].residency.github = [{ scope: "environment", kind: "var", environments: ["preview"] }];
  assert.throws(() => parseManifest(raw), (err) => {
    assert.match(err.message, /absent from manifest.environments/);
    assert.match(err.message, /PUBLIC_SITE_URL/);
    return true;
  });
});

test("parseManifest rejects environments on a repository-scope entry rather than ignoring it", () => {
  // Silently ignoring it is how an author comes to believe they scoped
  // something they did not — the same fail-closed posture as an unknown shape.
  const raw = singleWorkerManifest();
  raw.keys[0].residency.github = [{ scope: "repository", kind: "var", environments: ["production"] }];
  assert.throws(() => parseManifest(raw), (err) => {
    assert.match(err.message, /meaningful only under scope "environment"/);
    assert.match(err.message, /PUBLIC_SITE_URL/);
    return true;
  });
});

test("parseManifest rejects a duplicate (scope, kind) pair and an empty residency.github array", () => {
  const dup = singleWorkerManifest();
  dup.keys[0].residency.github = [
    { scope: "environment", kind: "var" },
    { scope: "environment", kind: "var", environments: ["production"] },
  ];
  assert.throws(() => parseManifest(dup), (err) => {
    assert.match(err.message, /repeats the \(scope, kind\) pair "environment\/var"/);
    assert.match(err.message, /PUBLIC_SITE_URL/);
    return true;
  });

  const empty = singleWorkerManifest();
  empty.keys[0].residency.github = [];
  assert.throws(() => parseManifest(empty), /must not be an empty array/);
});

test("parseManifest still rejects a malformed scope and kind under both authored shapes", () => {
  const objForm = singleWorkerManifest();
  objForm.keys[0].residency.github = { scope: "org", kind: "var" };
  assert.throws(() => parseManifest(objForm), /\.scope must be "environment" or "repository"/);

  const arrForm = singleWorkerManifest();
  arrForm.keys[0].residency.github = [{ scope: "repository", kind: "file" }];
  assert.throws(() => parseManifest(arrForm), /residency\.github\[0\]\.kind must be "secret" or "var"/);
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

// ---------------------------------------------------------------------------
// GitHub residency — dual scope and per-environment presence (Story #459)
// ---------------------------------------------------------------------------

/**
 * A manifest with no workers and no local residency, so the offline arm over an
 * empty repo root contributes no findings and every finding under test comes
 * from the GitHub probe.
 */
function githubOnlyManifest(github) {
  return parseManifest({
    environments: ["staging", "production"],
    keys: [{ name: "SHARED_TOKEN", kind: "secret", sensitivity: "secret", residency: { local: null, github } }],
  });
}

/** Mock the two GitHub probe calls from a `{repository, staging, production}` map. */
function githubProbe(present) {
  const at = (slot) => ({ secret: [], var: [], ...(present[slot] ?? {}) });
  return {
    repositoryNames: async () => at("repository"),
    environmentNames: async (environment) => at(environment),
  };
}

async function githubFindings({ manifest, present, environments = ["staging", "production"] }) {
  const root = makeRepo({});
  try {
    const report = await runDoctor({ manifest, repoRoot: root, environments, github: githubProbe(present) });
    return report.findings.filter((f) => f.surface === "github");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const DUAL_SCOPE = [
  { scope: "repository", kind: "secret" },
  { scope: "environment", kind: "secret" },
];

test("a dual-scope key present at both scopes reports no finding", async () => {
  const findings = await githubFindings({
    manifest: githubOnlyManifest(DUAL_SCOPE),
    present: {
      repository: { secret: ["SHARED_TOKEN"] },
      staging: { secret: ["SHARED_TOKEN"] },
      production: { secret: ["SHARED_TOKEN"] },
    },
  });
  assert.deepEqual(findings, []);
});

test("a dual-scope key absent from one scope reports a missing naming that scope only", async () => {
  const findings = await githubFindings({
    manifest: githubOnlyManifest(DUAL_SCOPE),
    present: {
      repository: { secret: [] },
      staging: { secret: ["SHARED_TOKEN"] },
      production: { secret: ["SHARED_TOKEN"] },
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "missing");
  assert.equal(findings[0].key, "SHARED_TOKEN");
  assert.equal(findings[0].environment, null);
  assert.match(findings[0].detail, /repository secrets/);
});

test("a dual-scope key absent from one environment reports a missing naming that environment only", async () => {
  const findings = await githubFindings({
    manifest: githubOnlyManifest(DUAL_SCOPE),
    present: {
      repository: { secret: ["SHARED_TOKEN"] },
      staging: { secret: [] },
      production: { secret: ["SHARED_TOKEN"] },
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "missing");
  assert.equal(findings[0].environment, "staging");
});

test("an environments-scoped entry reports no missing for an environment it never names", async () => {
  // The motivating case: a production-only analytics token whose staging
  // counterpart is meant to resolve empty. That is design, not drift.
  const manifest = githubOnlyManifest([{ scope: "environment", kind: "secret", environments: ["production"] }]);
  assert.deepEqual(
    await githubFindings({ manifest, present: { production: { secret: ["SHARED_TOKEN"] } } }),
    []
  );

  const missing = await githubFindings({ manifest, present: {} });
  assert.equal(missing.length, 1, "production still fails when it lacks the key");
  assert.equal(missing[0].kind, "missing");
  assert.equal(missing[0].environment, "production");
});

test("a key declared only at environment scope is not a repository-level orphan", async () => {
  const findings = await githubFindings({
    manifest: githubOnlyManifest([{ scope: "environment", kind: "secret" }]),
    present: {
      repository: { secret: ["SHARED_TOKEN"] },
      staging: { secret: ["SHARED_TOKEN"] },
      production: { secret: ["SHARED_TOKEN"] },
    },
  });
  assert.deepEqual(findings, []);
});

test("suppression is cross-scope only — an undeclared name still orphans", async () => {
  // The half that keeps --strict-orphans worth enabling: nothing about the
  // suppression hides a name the manifest never declared anywhere.
  const findings = await githubFindings({
    manifest: githubOnlyManifest([{ scope: "environment", kind: "secret" }]),
    present: {
      repository: { secret: ["SHARED_TOKEN", "UNDECLARED_TOKEN"] },
      staging: { secret: ["SHARED_TOKEN"] },
      production: { secret: ["SHARED_TOKEN"] },
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "orphan");
  assert.equal(findings[0].key, "UNDECLARED_TOKEN");
  assert.equal(findings[0].environment, null);
});

test("suppression does not cross kind — a secret declared, a variable present, still orphans", async () => {
  const findings = await githubFindings({
    manifest: githubOnlyManifest([{ scope: "environment", kind: "secret" }]),
    present: {
      repository: { var: ["SHARED_TOKEN"] },
      staging: { secret: ["SHARED_TOKEN"] },
      production: { secret: ["SHARED_TOKEN"] },
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "orphan");
  assert.match(findings[0].detail, /repository vars/);
});

test("suppression does not cross environment — a production-only key found in staging orphans", async () => {
  // Undeclared presence in the wrong environment is the most interesting thing
  // this surface can find, so the cross-scope rule must not reach it.
  const findings = await githubFindings({
    manifest: githubOnlyManifest([{ scope: "environment", kind: "secret", environments: ["production"] }]),
    present: {
      staging: { secret: ["SHARED_TOKEN"] },
      production: { secret: ["SHARED_TOKEN"] },
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "orphan");
  assert.equal(findings[0].environment, "staging");
});

test("the single-object residency.github form yields exactly the findings it did before", async () => {
  // The regression case, over the unchanged existing fixture: both keys are
  // authored as single objects at environment scope, so a repo-level probe
  // holding neither must produce two per-environment missings and nothing else.
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging", "production"],
      github: githubProbe({
        staging: { var: ["PUBLIC_SITE_URL"], secret: ["TURSO_AUTH_TOKEN"] },
        production: { var: ["PUBLIC_SITE_URL"] },
      }),
    });
    const gh = report.findings.filter((f) => f.surface === "github");
    assert.equal(gh.length, 1);
    assert.deepEqual(
      { kind: gh[0].kind, key: gh[0].key, environment: gh[0].environment },
      { kind: "missing", key: "TURSO_AUTH_TOKEN", environment: "production" }
    );
    assert.equal(report.surfaces.find((s) => s.surface === "github").status, "checked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declaredElsewhere suppresses only orphans, never a missing", async () => {
  // The new argument is opt-in and orphan-only, so the cloudflare and infisical
  // call sites that omit it cannot change behaviour.
  const suppressed = reconcileNames({
    expected: ["A"],
    present: ["B"],
    surface: "github",
    environment: null,
    declaredElsewhere: ["A", "B"],
  });
  assert.deepEqual(
    suppressed.map((f) => [f.kind, f.key]),
    [["missing", "A"]]
  );
  assert.deepEqual(reconcileNames({ expected: [], present: ["B"], surface: "github", environment: null }), [
    {
      severity: "orphan",
      kind: "orphan",
      key: "B",
      surface: "github",
      environment: null,
      detail: "present in github but declared by no manifest key",
    },
  ]);
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
// Infisical environment slugs and folder residency (Story #464)
// ---------------------------------------------------------------------------

/**
 * A manifest with no local residency and no GitHub residency, so every finding
 * under test comes from the Infisical probe. One Worker is kept so the
 * Cloudflare surface can be asserted to keep the DEPLOY name while Infisical
 * is asked for the mapped slug.
 */
function infisicalOnlyManifest(infisical, { environmentSlugs, keys } = {}) {
  return parseManifest({
    environments: ["staging", "production"],
    ...(environmentSlugs ? { environmentSlugs } : {}),
    workers: { site: { scriptName: "acme-site-{env}" } },
    keys:
      keys ??
      [
        {
          name: "SHARED_TOKEN",
          kind: "secret",
          sensitivity: "secret",
          residency: { local: null, github: null, cloudflare: null },
          infisical,
        },
      ],
  });
}

/**
 * Run the Infisical probe against a `{ "<environment-slug><folder>": [names] }`
 * map, recording every (environment, folder) pair the client was asked for.
 * The map is keyed by the slug the CLIENT sees, which is the whole point: a
 * remapped environment must be looked up under its store slug.
 */
async function infisicalRun({ manifest, present, environments = ["staging", "production"], cloudflare = null }) {
  const root = makeRepo({});
  const asked = [];
  try {
    const report = await runDoctor({
      manifest,
      repoRoot: root,
      environments,
      cloudflare,
      infisical: {
        listNames: async ({ environment, folder }) => {
          asked.push(`${environment}${folder}`);
          return present[`${environment}${folder}`] ?? [];
        },
        listValues: async () => new Map(),
      },
    });
    return { asked, findings: report.findings.filter((f) => f.surface === "infisical"), report };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a remapped Infisical slug is probed at the slug while Cloudflare keeps the deploy name", async () => {
  // The motivating case: deploy environments are staging/production, but the
  // Infisical project's slugs are staging/prod. Before this, `production`
  // reached Infisical verbatim and 404'd the whole surface into `error`.
  const scripts = [];
  const { asked } = await infisicalRun({
    manifest: infisicalOnlyManifest(
      { folder: "/shared" },
      { environmentSlugs: { infisical: { production: "prod" } } }
    ),
    present: { "staging/shared": ["SHARED_TOKEN"], "prod/shared": ["SHARED_TOKEN"] },
    cloudflare: {
      secretNames: async (scriptName) => {
        scripts.push(scriptName);
        return [];
      },
    },
  });

  assert.deepEqual(asked, ["staging/shared", "prod/shared"]);
  assert.ok(!asked.some((a) => a.startsWith("production")), "the deploy name must not reach Infisical");
  // The Cloudflare surface resolves {env} from the DEPLOY name, unmapped —
  // which is why it needs no slug map of its own.
  assert.deepEqual(scripts, []);
});

test("a manifest declaring a Cloudflare secret still resolves {env} from the unmapped deploy name", async () => {
  const scripts = [];
  await infisicalRun({
    manifest: infisicalOnlyManifest(undefined, {
      environmentSlugs: { infisical: { production: "prod" } },
      keys: [
        {
          name: "SHARED_TOKEN",
          kind: "secret",
          sensitivity: "secret",
          residency: { local: null, github: null, cloudflare: { workers: ["site"], kind: "secret" } },
          infisical: { folder: "/shared" },
        },
      ],
    }),
    present: {},
    cloudflare: {
      secretNames: async (scriptName) => {
        scripts.push(scriptName);
        return ["SHARED_TOKEN"];
      },
    },
  });
  assert.deepEqual(scripts, ["acme-site-staging", "acme-site-production"]);
});

test("environmentSlugs rejects a surface that is not slug-mapped, and names it", () => {
  assert.throws(
    () =>
      infisicalOnlyManifest({ folder: "/" }, { environmentSlugs: { cloudflare: { production: "prod" } } }),
    (err) => {
      assert.match(err.message, /"cloudflare" is not a slug-mapped surface/);
      assert.match(err.message, /infisical/);
      // The message must say WHY, or the author re-files the same request.
      assert.match(err.message, /scriptName/);
      return true;
    }
  );
});

test("environmentSlugs rejects an unmapped environment and a slug that is not a non-empty string", () => {
  assert.throws(
    () => infisicalOnlyManifest({ folder: "/" }, { environmentSlugs: { infisical: { preview: "prev" } } }),
    /maps "preview", absent from manifest.environments/
  );
  assert.throws(
    () => infisicalOnlyManifest({ folder: "/" }, { environmentSlugs: { infisical: { production: "" } } }),
    /must be a non-empty slug string/
  );
  assert.throws(
    () => infisicalOnlyManifest({ folder: "/" }, { environmentSlugs: { infisical: { production: 7 } } }),
    /must be a non-empty slug string/
  );
  assert.throws(
    () => infisicalOnlyManifest({ folder: "/" }, { environmentSlugs: { infisical: ["prod"] } }),
    /must be an object mapping environment -> slug/
  );
});

test("with no environmentSlugs every environment resolves to itself", async () => {
  const manifest = infisicalOnlyManifest({ folder: "/shared" });
  // The container is normalized to a total-but-empty map, so no caller has to
  // distinguish "absent" from "empty".
  assert.deepEqual(manifest.environmentSlugs, { infisical: {} });
  assert.equal(resolveSurfaceEnvironment(manifest, "infisical", "production"), "production");
  const { asked } = await infisicalRun({ manifest, present: { "staging/shared": ["SHARED_TOKEN"] } });
  assert.deepEqual(asked, ["staging/shared", "production/shared"]);
});

test("parseManifest normalizes the single-object infisical form to a one-entry folders array", () => {
  // The pre-#464 authored shape, parsed: one shape reaches probeInfisical, the
  // same treatment residency.github received in #459.
  const m = infisicalOnlyManifest({ folder: "/shared", environments: ["production"] });
  assert.deepEqual(m.keys[0].infisical, { folders: [{ folder: "/shared", environments: ["production"] }] });

  const defaulted = infisicalOnlyManifest({ folder: "/shared" });
  assert.deepEqual(defaulted.keys[0].infisical, {
    folders: [{ folder: "/shared", environments: ["staging", "production"] }],
  });
});

test("the folders array accepts bare paths and per-entry environments", () => {
  const m = infisicalOnlyManifest({
    folders: ["/shared", { folder: "/github", environments: ["staging"] }],
  });
  assert.deepEqual(m.keys[0].infisical, {
    folders: [
      { folder: "/shared", environments: ["staging", "production"] },
      { folder: "/github", environments: ["staging"] },
    ],
  });
});

test("a key resident in two folders and present in both reports no finding", async () => {
  // The folder-import case: /cloudflare imports /shared, so the value is
  // genuinely readable through both. Both statements are true.
  const { findings } = await infisicalRun({
    manifest: infisicalOnlyManifest({ folders: ["/shared", "/cloudflare"] }),
    present: {
      "staging/shared": ["SHARED_TOKEN"],
      "staging/cloudflare": ["SHARED_TOKEN"],
      "production/shared": ["SHARED_TOKEN"],
      "production/cloudflare": ["SHARED_TOKEN"],
    },
  });
  assert.deepEqual(findings, []);
});

test("a misplacement across two declared folders is reported ONCE, as the missing", async () => {
  // Declared in /shared, actually resident in /cloudflare. Before #464 this
  // was two findings for one fact — a missing AND an orphan — and the orphan
  // was unsuppressable by an exception, so --strict-orphans could never go
  // green on a manifest that was merely imprecise about placement.
  const { findings } = await infisicalRun({
    manifest: infisicalOnlyManifest({ folders: ["/shared", "/cloudflare"] }),
    present: {
      "staging/cloudflare": ["SHARED_TOKEN"],
      "production/cloudflare": ["SHARED_TOKEN"],
    },
    environments: ["staging"],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "missing");
  assert.equal(findings[0].key, "SHARED_TOKEN");
  assert.match(findings[0].detail, /folder \/shared/);
  assert.equal(
    findings.filter((f) => f.kind === "orphan").length,
    0,
    "the sibling declared folder must not also orphan the same key"
  );
});

test("suppression does not cross environment — a staging-only key found in production orphans", async () => {
  // SHARED_TOKEN is declared in /github for staging only. Finding it in
  // /shared in production is undeclared presence in that environment, which
  // is the most interesting thing this surface can report.
  const { findings } = await infisicalRun({
    manifest: infisicalOnlyManifest({
      folders: [{ folder: "/github", environments: ["staging"] }, { folder: "/shared", environments: ["staging"] }],
    }),
    present: {
      "staging/github": ["SHARED_TOKEN"],
      "staging/shared": ["SHARED_TOKEN"],
      "production/shared": ["SHARED_TOKEN"],
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "orphan");
  assert.equal(findings[0].environment, "production");
});

test("a per-environment folder entry reports no missing for an environment it never names", async () => {
  const { findings } = await infisicalRun({
    manifest: infisicalOnlyManifest({ folders: [{ folder: "/operator", environments: ["production"] }] }),
    present: { "production/operator": ["SHARED_TOKEN"] },
  });
  assert.deepEqual(findings, []);
});

test("infisical folder residency fails closed on every malformed shape", () => {
  const bad = (infisical) => () => infisicalOnlyManifest(infisical);
  assert.throws(bad({ folders: [] }), /folders must be a non-empty array/);
  assert.throws(bad({ folders: ["/shared", "/shared"] }), /repeats the folder "\/shared"/);
  assert.throws(bad({ folders: [{ folder: "/s", environments: ["preview"] }] }), /absent from manifest.environments/);
  assert.throws(bad({ folder: "/s", folders: ["/t"] }), /declares both "folder" and "folders"/);
  assert.throws(bad({ folders: ["/s"], environments: ["staging"] }), /meaningful only beside a single "folder"/);
  assert.throws(bad({}), /must declare "folder" or "folders"/);
  assert.throws(bad({ folders: [""] }), /must be a non-empty folder path string/);
  assert.throws(bad({ folders: [42] }), /must be a folder path string or \{folder, environments\}/);
  assert.throws(bad("nope"), /must be "unmanaged", \{folder, environments\} or \{folders: \[\.\.\.\]\}/);
  // Unchanged from before #464: the single-object form's own env validation.
  assert.throws(bad({ folder: "/s", environments: ["preview"] }), /absent from manifest.environments/);
});

test("a multi-folder key with a shape earns ONE verdict per environment, not one per folder", async () => {
  // A key resident in two folders is READ twice, but it is one value — so
  // scoring it per folder would re-introduce double-reporting in the shape
  // stage, the very defect #464 removes from the residency stage.
  const root = makeRepo({});
  try {
    const manifest = infisicalOnlyManifest(undefined, {
      keys: [
        {
          name: "SHARED_TOKEN",
          kind: "var",
          sensitivity: "public",
          residency: { local: null, github: null, cloudflare: null },
          infisical: { folders: ["/shared", "/cloudflare"] },
          shape: "url",
        },
      ],
    });
    const report = await runDoctor({
      manifest,
      repoRoot: root,
      environments: ["staging"],
      infisical: {
        listNames: async () => ["SHARED_TOKEN"],
        listValues: async () => new Map([["SHARED_TOKEN", "example.test"]]),
      },
    });
    const shapeFails = report.findings.filter((f) => f.kind === "shape-fail");
    assert.equal(shapeFails.length, 1, "one value, one verdict");
    assert.equal(shapeFails[0].key, "SHARED_TOKEN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cloudflare Worker residency — per-environment presence (Story #483)
// ---------------------------------------------------------------------------

/**
 * A manifest whose workers carry no `config` and whose keys have no local,
 * GitHub or Infisical residency, so the offline arm over an empty repo root
 * contributes nothing and every finding under test comes from the Cloudflare
 * probe.
 */
function cloudflareOnlyManifest({ workers, keys, environments = ["staging", "production"] }) {
  return parseManifest({
    environments,
    workers: Object.fromEntries(workers.map((id) => [id, { scriptName: `swarm-${id}-{env}` }])),
    keys: keys.map((k) => ({
      kind: "secret",
      sensitivity: "secret",
      residency: { local: null, github: null, cloudflare: { workers: k.workers, kind: "secret" } },
      infisical: "unmanaged",
      ...k,
      workers: undefined,
    })),
  });
}

/** Mock `secretNames` from a `{"<worker>-<env>": [names]}` map. */
function cloudflareProbe(present) {
  return {
    secretNames: async (scriptName) => {
      const key = scriptName.replace(/^swarm-/, "");
      return present[key] ?? [];
    },
  };
}

async function cloudflareFindings({ manifest, present, environments = ["staging", "production"] }) {
  const root = makeRepo({});
  try {
    const report = await runDoctor({
      manifest,
      repoRoot: root,
      environments,
      cloudflare: cloudflareProbe(present),
    });
    return report.findings.filter((f) => f.surface === "cloudflare");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a bare worker id still means every environment — every manifest in existence says it that way", () => {
  const manifest = cloudflareOnlyManifest({
    workers: ["api"],
    keys: [{ name: "SHARED_TOKEN", workers: ["api"] }],
  });
  assert.deepEqual(manifest.keys[0].residency.cloudflare.workers, [
    { worker: "api", environments: ["staging", "production"] },
  ]);
});

test("the object form narrows one entry while a bare sibling keeps defaulting to every environment", () => {
  const manifest = cloudflareOnlyManifest({
    workers: ["staff", "api"],
    keys: [{ name: "SHARED_TOKEN", workers: [{ worker: "staff", environments: ["production"] }, "api"] }],
  });
  assert.deepEqual(manifest.keys[0].residency.cloudflare.workers, [
    { worker: "staff", environments: ["production"] },
    { worker: "api", environments: ["staging", "production"] },
  ]);
});

test("a production-only key present only in production reports NOTHING — the defect #481 filed", async () => {
  const findings = await cloudflareFindings({
    manifest: cloudflareOnlyManifest({
      workers: ["staff"],
      keys: [{ name: "PEER_DATABASE_URL", workers: [{ worker: "staff", environments: ["production"] }] }],
    }),
    present: { "staff-production": ["PEER_DATABASE_URL"] },
  });
  assert.deepEqual(findings, []);
});

test("cloudflare suppression does not cross environment — a production-only key in staging orphans", async () => {
  const findings = await cloudflareFindings({
    manifest: cloudflareOnlyManifest({
      workers: ["staff"],
      keys: [{ name: "PEER_DATABASE_URL", workers: [{ worker: "staff", environments: ["production"] }] }],
    }),
    present: { "staff-production": ["PEER_DATABASE_URL"], "staff-staging": ["PEER_DATABASE_URL"] },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "orphan");
  assert.equal(findings[0].key, "PEER_DATABASE_URL");
  assert.equal(findings[0].environment, "staging");
});

test("a narrowed entry still reports a REAL absence in the environment it does name", async () => {
  const findings = await cloudflareFindings({
    manifest: cloudflareOnlyManifest({
      workers: ["staff"],
      keys: [{ name: "PEER_DATABASE_URL", workers: [{ worker: "staff", environments: ["production"] }] }],
    }),
    present: {},
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "missing");
  assert.equal(findings[0].environment, "production");
});

test("cloudflare worker residency fails closed on every malformed shape", () => {
  const bad = (workers) => () =>
    cloudflareOnlyManifest({ workers: ["api", "staff"], keys: [{ name: "SHARED_TOKEN", workers }] });

  assert.throws(bad([]), /must be a non-empty array of worker ids/);
  assert.throws(bad([42]), /must be a worker id string or \{worker, environments\}/);
  assert.throws(bad(["nope"]), /references unknown worker id "nope"/);
  assert.throws(bad([{ worker: "nope", environments: ["staging"] }]), /references unknown worker id "nope"/);
  assert.throws(bad(["api", "api"]), /repeats the worker "api"/);
  assert.throws(bad(["api", { worker: "api", environments: ["staging"] }]), /repeats the worker "api"/);
  assert.throws(bad([{ worker: "api", environments: ["preview"] }]), /absent from manifest.environments/);
  assert.throws(bad([{ worker: "api", environments: [] }]), /must not be empty/);
  assert.throws(bad([{ worker: "api", environments: "staging" }]), /must be an array of environment slugs/);
});

test("a worker deployed to one environment by design does not 404-fail in the other", async () => {
  // The narrowing's second consequence: probing a worker in an environment it
  // expects nothing in must not turn that worker's deliberate absence into a
  // finding, or the false failure comes back one layer down.
  const root = makeRepo({});
  try {
    const report = await runDoctor({
      manifest: cloudflareOnlyManifest({
        workers: ["staff"],
        keys: [{ name: "PEER_DATABASE_URL", workers: [{ worker: "staff", environments: ["production"] }] }],
      }),
      repoRoot: root,
      environments: ["staging", "production"],
      cloudflare: {
        secretNames: async (scriptName) => {
          if (scriptName === "swarm-staff-staging") {
            const err = new Error("not found");
            err.httpStatus = 404;
            throw err;
          }
          return ["PEER_DATABASE_URL"];
        },
      },
    });
    assert.deepEqual(
      report.findings.filter((f) => f.surface === "cloudflare"),
      []
    );
    assert.equal(report.surfaces.find((s) => s.surface === "cloudflare").status, "checked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the six single-environment keys from #481 report zero failures on a correct manifest", async () => {
  // The consumer evidence that filed the gap, reconstructed: ten false
  // `missing` findings across six keys whose single-environment placement is
  // deliberate. Every one of them must now be silent.
  const production = ["production"];
  const staging = ["staging"];
  const manifest = cloudflareOnlyManifest({
    workers: ["staff", "api", "web"],
    keys: [
      { name: "PEER_DATABASE_URL", workers: [{ worker: "staff", environments: production }] },
      { name: "PEER_TURSO_AUTH_TOKEN", workers: [{ worker: "staff", environments: production }] },
      { name: "SENTRY_WEBHOOK_SIGNING_SECRET", workers: [{ worker: "api", environments: production }] },
      { name: "GITHUB_INTAKE_TOKEN", workers: [{ worker: "api", environments: production }] },
      {
        name: "EMAIL_RECIPIENT_ALLOWLIST",
        workers: ["api", "web", "staff"].map((worker) => ({ worker, environments: staging })),
      },
      {
        name: "SMS_RECIPIENT_ALLOWLIST",
        workers: ["api", "web", "staff"].map((worker) => ({ worker, environments: staging })),
      },
    ],
  });
  const findings = await cloudflareFindings({
    manifest,
    present: {
      "staff-production": ["PEER_DATABASE_URL", "PEER_TURSO_AUTH_TOKEN"],
      "api-production": ["SENTRY_WEBHOOK_SIGNING_SECRET", "GITHUB_INTAKE_TOKEN"],
      "api-staging": ["EMAIL_RECIPIENT_ALLOWLIST", "SMS_RECIPIENT_ALLOWLIST"],
      "web-staging": ["EMAIL_RECIPIENT_ALLOWLIST", "SMS_RECIPIENT_ALLOWLIST"],
      "staff-staging": ["EMAIL_RECIPIENT_ALLOWLIST", "SMS_RECIPIENT_ALLOWLIST"],
    },
  });
  assert.deepEqual(findings, []);
});

test("KEY_SCHEMA names the per-environment worker entry so the script and the docs cannot drift", () => {
  assert.match(KEY_SCHEMA.residency, /worker, environments/);
});

test("a var-residency key is unaffected by the environment axis at the wrangler [vars] check", () => {
  // The wrangler check has no environment axis — it reports `environment: null`
  // and `parseWranglerVars` flattens `[env.X.vars]` into one set — so a var
  // declared for ONE environment stays expected in that worker's config.
  const root = makeRepo({ wrangler: '[env.staging.vars]\nSTAGING_ONLY_FLAG = "1"\n' });
  try {
    const manifest = parseManifest({
      environments: ["staging", "production"],
      workers: { web: { config: "wrangler.toml", scriptName: "swarm-web-{env}" } },
      keys: [
        {
          name: "STAGING_ONLY_FLAG",
          kind: "var",
          sensitivity: "public",
          residency: {
            local: null,
            github: null,
            cloudflare: { workers: [{ worker: "web", environments: ["staging"] }], kind: "var" },
          },
          infisical: "unmanaged",
        },
      ],
    });
    const findings = runOfflineChecks({ manifest, repoRoot: root }).findings.filter(
      (f) => f.surface === "wrangler"
    );
    assert.deepEqual(findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MANIFEST_SCHEMA and KEY_SCHEMA describe the slug container and the folders array", () => {
  assert.ok(Object.hasOwn(MANIFEST_SCHEMA, "environmentSlugs"));
  assert.match(MANIFEST_SCHEMA.environmentSlugs, /infisical/);
  assert.match(KEY_SCHEMA.infisical, /folders/);
  assert.deepEqual(SLUG_MAPPED_SURFACES, ["infisical"]);
});

test("the documented manifest schema block names the new shapes", () => {
  // The script exports the schema so the doc and the code describe one shape;
  // this asserts the DOC kept its half of that bargain.
  const doc = readFileSync(join(HERE, "..", "docs", "reusable-workflows.md"), "utf8");
  assert.match(doc, /"environmentSlugs"/);
  assert.match(doc, /"folders"/);
});

test("the docs carry a Cloudflare per-environment residency section beside its two siblings", () => {
  // Same bargain as the test above, for the third surface to take the
  // treatment: the doc must describe the entry form the script now accepts.
  const doc = readFileSync(join(HERE, "..", "docs", "reusable-workflows.md"), "utf8");
  // `includes` + a message, not `assert.match`: a regex miss here dumps the
  // whole 250KB document into the failure output and buries the reason.
  assert.ok(
    doc.includes("#### Cloudflare Worker residency: per-environment presence"),
    "docs/reusable-workflows.md must carry the Cloudflare per-environment residency section"
  );
  assert.ok(doc.includes('"worker": "staff"'), "the manifest-schema block must show the object entry form");
});

test("no secret VALUE reaches stdout or stderr through the remapped-slug, multi-folder path", async () => {
  // The values-safety guarantee, re-asserted over the shapes #464 adds: a
  // remapped environment slug and a key resident in two folders. Same
  // low-entropy dictionary canaries as the sibling leak test, for the same
  // reason (a key-shaped fixture is a true positive for gitleaks).
  const INJECTED = {
    PUBLIC_SITE_URL: "example.test/no-scheme-here",
    TURSO_AUTH_TOKEN: "second-canary-that-must-never-be-printed",
  };
  const requested = [];

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url.startsWith("/api/v1/auth/universal-auth/login")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accessToken: "mock-token", expiresIn: 3600, tokenType: "Bearer" }));
      return;
    }
    if (req.url.startsWith("/api/v4/secrets")) {
      const params = new URL(req.url, "http://localhost").searchParams;
      requested.push(`${params.get("environment")}${params.get("secretPath")}`);
      const withValues = params.get("viewSecretValue") === "true";
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

  const raw = singleWorkerManifest();
  raw.environmentSlugs = { infisical: { production: "prod" } };
  for (const key of raw.keys) key.infisical = { folders: ["/", "/shared"] };

  const root = makeRepo(CONSISTENT_REPO);
  const manifestPath = join(root, "env.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(raw));

  try {
    const run = await runCli(
      [
        "--manifest", manifestPath,
        "--repo-root", root,
        "--environments", "production",
        "--infisical-project", "proj-1",
        "--infisical-site", site,
        "--json",
      ],
      { env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "sec", ENV_DRIFT_GITHUB_TOKEN: "", CLOUDFLARE_API_TOKEN: "" } }
    );

    // End-to-end proof that the slug reaches the wire through the real CLI:
    // every request names `prod`, never the `production` deploy name.
    assert.ok(requested.length > 0, "the mock store should have been asked for something");
    assert.deepEqual([...new Set(requested.map((r) => r.split("/")[0]))], ["prod"]);

    const captured = run.stdout + run.stderr;
    assert.ok(captured.includes("PUBLIC_SITE_URL"), "the failing key's NAME should be reported");
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
  for (const input of ["manifest:", "environments:", "exceptions:", "infisical-site:", "runner:"]) {
    assert.ok(wf.includes(input), `env-drift.yml should declare the ${input} input`);
  }
  for (const secret of [
    "INFISICAL_TOKEN:",
    "INFISICAL_CLIENT_ID:",
    "INFISICAL_CLIENT_SECRET:",
    "INFISICAL_PROJECT_ID:",
    "ENV_DRIFT_GITHUB_TOKEN:",
    "CLOUDFLARE_API_TOKEN:",
    "CLOUDFLARE_ACCOUNT_ID:",
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
  // A template that passes a token but not its id reproduces the defect in
  // every repo that copies it.
  assert.match(tpl, /CLOUDFLARE_ACCOUNT_ID:/);
  assert.match(tpl, /INFISICAL_PROJECT_ID:/);
});

test("env-drift.yml FORWARDS the identifiers, rather than declaring and dropping them", () => {
  // Declaring a secret is not passing it. #454 was exactly this gap: the
  // secrets existed on the boundary and never reached the doctor's process.
  const wf = readFileSync(join(HERE, "..", ".github", "workflows", "env-drift.yml"), "utf8");
  const step = wf.slice(wf.indexOf("- name: Check environment drift"));
  assert.ok(step.length > 0, "the drift step should exist");
  for (const [name, expression] of [
    ["CLOUDFLARE_ACCOUNT_ID", "secrets.CLOUDFLARE_ACCOUNT_ID"],
    ["INFISICAL_PROJECT_ID", "secrets.INFISICAL_PROJECT_ID"],
    ["INFISICAL_SITE_URL", "inputs.infisical-site"],
  ]) {
    assert.ok(
      step.includes(`${name}: \${{ ${expression} }}`),
      `the drift step should map ${name} from ${expression}`,
    );
  }
});

test("every env-drift secret and input stays optional — a required one breaks existing callers", () => {
  // A `workflow_call` secret added as `required: true` fails every caller that
  // does not yet pass it, at workflow-compile time, before any job runs.
  const wf = readFileSync(join(HERE, "..", ".github", "workflows", "env-drift.yml"), "utf8");
  // Anchor on the real keys at column 0, not on the header prose — which
  // discusses `permissions:` long before the block itself.
  const start = wf.search(/^on:$/m);
  const end = wf.search(/^permissions:$/m);
  assert.ok(start >= 0 && end > start, "should locate the workflow_call block");
  const callBlock = wf.slice(start, end);
  // `manifest` is the one required input, and it predates this Story.
  const required = callBlock.match(/required: true/g) || [];
  assert.equal(required.length, 1, "manifest should be the ONLY required input or secret");
  assert.match(callBlock.slice(0, callBlock.indexOf("required: true")), /manifest:/);
});

// ---------------------------------------------------------------------------
// Why a surface is unchecked — credential vs identifier vs offline (Story #455)
//
// The reusable workflow could never check Cloudflare or Infisical, because it
// had no way to pass the account/project id each client needs ALONGSIDE its
// credential. What hid that for a release was the notice: every unchecked
// surface blamed a missing credential, including the ones whose credential had
// been supplied and whose identifier had not.
// ---------------------------------------------------------------------------

test("a credential AND its identifier yields a live client for every surface", () => {
  const opts = { repo: "o/r", cloudflareAccount: "acct", infisicalProject: "proj" };
  const clients = buildClients(opts, {
    ENV_DRIFT_GITHUB_TOKEN: "tok",
    CLOUDFLARE_API_TOKEN: "cf",
    INFISICAL_TOKEN: "inf",
  });
  for (const surface of ["github", "cloudflare", "infisical"]) {
    assert.ok(clients[surface], `${surface} should have a client when both halves are supplied`);
    assert.equal(clients.unavailability[surface], undefined, `${surface} should record no unavailability reason`);
  }
});

test("with the Cloudflare token AND account id, the Cloudflare surface is checked", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging"],
      cloudflare: { secretNames: async () => ["TURSO_AUTH_TOKEN"] },
    });
    const cf = report.surfaces.find((s) => s.surface === "cloudflare");
    assert.equal(cf.status, "checked");
    assert.equal(report.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with an Infisical credential AND project id, the Infisical surface is checked", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging"],
      infisical: {
        listNames: async () => ["PUBLIC_SITE_URL", "TURSO_AUTH_TOKEN"],
        listValues: async () => new Map([["PUBLIC_SITE_URL", "https://example.test"]]),
      },
    });
    const inf = report.surfaces.find((s) => s.surface === "infisical");
    assert.equal(inf.status, "checked");
    assert.equal(report.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a supplied credential with a missing identifier blames the IDENTIFIER, not the credential", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    // Exactly the shape the reusable workflow produced: every credential set,
    // no identifier reachable.
    const clients = buildClients(
      { repo: null, cloudflareAccount: null, infisicalProject: null },
      { ENV_DRIFT_GITHUB_TOKEN: "tok", CLOUDFLARE_API_TOKEN: "cf", INFISICAL_TOKEN: "inf" },
    );
    assert.equal(clients.github, null);
    assert.equal(clients.cloudflare, null);
    assert.equal(clients.infisical, null);

    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging"],
      ...clients,
    });
    const byName = Object.fromEntries(report.surfaces.map((s) => [s.surface, s]));

    assert.equal(byName.github.status, "unchecked");
    assert.match(byName.github.notice, /GITHUB_REPOSITORY/);
    assert.match(byName.cloudflare.notice, /CLOUDFLARE_ACCOUNT_ID/);
    assert.match(byName.infisical.notice, /INFISICAL_PROJECT_ID/);

    // The regression itself: none of the three may claim its credential was absent.
    for (const surface of ["github", "cloudflare", "infisical"]) {
      assert.doesNotMatch(
        byName[surface].notice,
        /no (GitHub token|Cloudflare API token|Infisical credential) supplied/,
        `${surface} blamed the credential that WAS supplied: ${byName[surface].notice}`,
      );
    }
    assert.equal(report.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an identifier arriving as the empty string is absent, not supplied", () => {
  // An unset `secrets.X` / `inputs.x` interpolates to "" rather than to
  // nothing, so every identifier check must be a truthiness test.
  const clients = buildClients(
    { repo: "", cloudflareAccount: "", infisicalProject: "" },
    { ENV_DRIFT_GITHUB_TOKEN: "tok", CLOUDFLARE_API_TOKEN: "cf", INFISICAL_TOKEN: "inf" },
  );
  assert.equal(clients.cloudflare, null);
  assert.equal(clients.infisical, null);
  assert.match(clients.unavailability.cloudflare, /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(clients.unavailability.infisical, /INFISICAL_PROJECT_ID/);
});

test("an empty INFISICAL_SITE_URL falls back to the default rather than becoming the site", () => {
  // `??` would let "" win here and aim every Infisical probe at a host that
  // does not resolve — the failure would surface as an `error`, not a config
  // mistake.
  const prior = process.env.INFISICAL_SITE_URL;
  process.env.INFISICAL_SITE_URL = "";
  try {
    assert.equal(parseCliArgs(["--manifest", "m.json"]).infisicalSite, "https://app.infisical.com");
  } finally {
    if (prior === undefined) delete process.env.INFISICAL_SITE_URL;
    else process.env.INFISICAL_SITE_URL = prior;
  }
});

test("an offline run reports its live surfaces as skipped-because-offline, blaming no credential", async () => {
  const root = makeRepo(CONSISTENT_REPO);
  try {
    const report = await runDoctor({
      manifest: parseManifest(singleWorkerManifest()),
      repoRoot: root,
      environments: ["staging"],
      offline: true,
    });
    const byName = Object.fromEntries(report.surfaces.map((s) => [s.surface, s]));
    for (const surface of ["github", "cloudflare", "infisical"]) {
      assert.equal(byName[surface].status, "unchecked", `${surface} should be visibly skipped, not omitted`);
      assert.match(byName[surface].notice, /offline mode/);
      assert.doesNotMatch(byName[surface].notice, /supplied/);
    }
    assert.equal(report.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: the reusable workflow's env shape reaches the identifiers without any flag", async () => {
  // The whole workflow-side fix is naming these in the step `env:` block —
  // the flags already default from exactly these variables, and routing them
  // through argv instead would put them in the process table.
  const root = makeRepo(CONSISTENT_REPO);
  const manifestPath = join(root, "env.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(singleWorkerManifest()));
  try {
    const run = await runCli(["--manifest", manifestPath, "--repo-root", root, "--environments", "staging"], {
      env: {
        CLOUDFLARE_API_TOKEN: "cf",
        CLOUDFLARE_ACCOUNT_ID: "",
        INFISICAL_TOKEN: "inf",
        INFISICAL_PROJECT_ID: "",
        ENV_DRIFT_GITHUB_TOKEN: "",
      },
    });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /cloudflare: unchecked — no Cloudflare account id supplied/);
    assert.match(run.stdout, /infisical: unchecked — no Infisical project id supplied/);
    // The GitHub credential really is absent here, so that surface keeps the
    // credential wording — the two causes stay distinguishable in one run.
    assert.match(run.stdout, /github: unchecked — no GitHub token supplied/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
