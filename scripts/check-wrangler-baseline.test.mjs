#!/usr/bin/env node
/**
 * check-wrangler-baseline.test.mjs — node:test suite for the Story #177
 * wrangler configuration baseline gate.
 *
 * Exercises the pure rule/parser functions directly and the full
 * `runCli` pipeline against real temp files (wrangler.toml AND
 * wrangler.jsonc) so both config formats are covered end to end.
 *
 * Run: node scripts/check-wrangler-baseline.test.mjs   (or `node --test scripts/`)
 */

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import {
  parseArgv,
  resolveConfigPath,
  parseJsonc,
  parseWranglerToml,
  parseWranglerConfig,
  readExceptions,
  checkEnvSplit,
  checkLogpush,
  checkAnalyticsEngine,
  checkCompatibilityDate,
  evaluateBaseline,
  renderReport,
  runCli,
} from './check-wrangler-baseline.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wrangler-baseline-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseArgv
// ---------------------------------------------------------------------------

test('parseArgv defaults maxAgeDays to 90 and flags to false', () => {
  const parsed = parseArgv([]);
  assert.deepEqual(parsed, { file: null, maxAgeDays: 90, warnOnly: false, json: false, help: false });
});

test('parseArgv reads --file, --max-age-days, --warn-only, --json, --help', () => {
  const parsed = parseArgv(['--file', 'custom.toml', '--max-age-days', '30', '--warn-only', '--json', '--help']);
  assert.deepEqual(parsed, { file: 'custom.toml', maxAgeDays: 30, warnOnly: true, json: true, help: true });
});

test('parseArgv falls back to 90 on a non-numeric --max-age-days', () => {
  const parsed = parseArgv(['--max-age-days', 'nope']);
  assert.equal(parsed.maxAgeDays, 90);
});

// ---------------------------------------------------------------------------
// resolveConfigPath
// ---------------------------------------------------------------------------

test('resolveConfigPath returns null when no config exists', () => {
  assert.equal(resolveConfigPath(null, tmpDir), null);
});

test('resolveConfigPath auto-detects wrangler.jsonc over wrangler.toml', () => {
  writeFileSync(join(tmpDir, 'wrangler.toml'), 'name = "x"\n');
  writeFileSync(join(tmpDir, 'wrangler.jsonc'), '{"name": "x"}\n');
  assert.equal(resolveConfigPath(null, tmpDir), join(tmpDir, 'wrangler.jsonc'));
});

test('resolveConfigPath falls back to wrangler.toml when no jsonc/json present', () => {
  writeFileSync(join(tmpDir, 'wrangler.toml'), 'name = "x"\n');
  assert.equal(resolveConfigPath(null, tmpDir), join(tmpDir, 'wrangler.toml'));
});

test('resolveConfigPath honors an explicit --file and returns null if missing', () => {
  const explicit = join(tmpDir, 'custom.jsonc');
  assert.equal(resolveConfigPath(explicit, tmpDir), null);
  writeFileSync(explicit, '{}');
  assert.equal(resolveConfigPath(explicit, tmpDir), explicit);
});

// ---------------------------------------------------------------------------
// parseJsonc / parseWranglerToml / parseWranglerConfig
// ---------------------------------------------------------------------------

test('parseJsonc strips // and block comments', () => {
  const text = `{
    // top comment
    "name": "x", /* inline */
    "logpush": true
  }`;
  assert.deepEqual(parseJsonc(text), { name: 'x', logpush: true });
});

test('parseWranglerToml parses top-level keys, booleans, and strings', () => {
  const text = `
name = "my-worker"
logpush = true
compatibility_date = "2026-01-01"
`;
  const parsed = parseWranglerToml(text);
  assert.equal(parsed.name, 'my-worker');
  assert.equal(parsed.logpush, true);
  assert.equal(parsed.compatibility_date, '2026-01-01');
});

test('parseWranglerToml parses [env.<name>] tables as nested objects', () => {
  const text = `
name = "my-worker"

[env.staging]
logpush = true

[env.production]
logpush = false
`;
  const parsed = parseWranglerToml(text);
  assert.deepEqual(Object.keys(parsed.env), ['staging', 'production']);
  assert.equal(parsed.env.staging.logpush, true);
  assert.equal(parsed.env.production.logpush, false);
});

test('parseWranglerToml parses [[analytics_engine_datasets]] as an array of tables', () => {
  const text = `
name = "my-worker"

[[analytics_engine_datasets]]
binding = "AE"
dataset = "events"
`;
  const parsed = parseWranglerToml(text);
  assert.ok(Array.isArray(parsed.analytics_engine_datasets));
  assert.equal(parsed.analytics_engine_datasets.length, 1);
  assert.equal(parsed.analytics_engine_datasets[0].binding, 'AE');
});

test('parseWranglerToml parses [[env.production.analytics_engine_datasets]] nested under an env table', () => {
  const text = `
[[env.production.analytics_engine_datasets]]
binding = "AE"
dataset = "events"
`;
  const parsed = parseWranglerToml(text);
  assert.ok(Array.isArray(parsed.env.production.analytics_engine_datasets));
  assert.equal(parsed.env.production.analytics_engine_datasets[0].dataset, 'events');
});

test('parseWranglerToml strips trailing # comments outside quotes', () => {
  const text = `compatibility_date = "2026-01-01" # bumped by renovate\n`;
  assert.equal(parseWranglerToml(text).compatibility_date, '2026-01-01');
});

test('parseWranglerToml parses a [mandrel.wranglerBaselineExceptions] table', () => {
  const text = `
[mandrel.wranglerBaselineExceptions]
analyticsEngine = "no telemetry sink for this static-asset Worker"
`;
  const parsed = parseWranglerToml(text);
  assert.equal(
    parsed.mandrel.wranglerBaselineExceptions.analyticsEngine,
    'no telemetry sink for this static-asset Worker',
  );
});

test('parseWranglerConfig dispatches by extension', () => {
  assert.deepEqual(parseWranglerConfig('wrangler.jsonc', '{"a":1}'), { a: 1 });
  assert.deepEqual(parseWranglerConfig('wrangler.toml', 'a = 1\n'), { a: 1 });
});

// ---------------------------------------------------------------------------
// readExceptions
// ---------------------------------------------------------------------------

test('readExceptions returns {} when no mandrel block is present', () => {
  assert.deepEqual(readExceptions({}), {});
});

test('readExceptions reads string-valued exceptions and ignores non-strings', () => {
  const config = {
    mandrel: {
      wranglerBaselineExceptions: {
        logpush: 'no log sink budget for this Worker',
        analyticsEngine: 42,
      },
    },
  };
  assert.deepEqual(readExceptions(config), { logpush: 'no log sink budget for this Worker' });
});

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

test('checkEnvSplit fails with no env block', () => {
  assert.equal(checkEnvSplit({}).pass, false);
});

test('checkEnvSplit passes with at least one named environment', () => {
  assert.equal(checkEnvSplit({ env: { staging: {} } }).pass, true);
});

test('checkLogpush passes on a top-level logpush = true', () => {
  assert.equal(checkLogpush({ logpush: true }).pass, true);
});

test('checkLogpush passes when every named env sets logpush = true', () => {
  const config = { env: { staging: { logpush: true }, production: { logpush: true } } };
  assert.equal(checkLogpush(config).pass, true);
});

test('checkLogpush fails when only some named envs set logpush', () => {
  const config = { env: { staging: { logpush: true }, production: {} } };
  assert.equal(checkLogpush(config).pass, false);
});

test('checkLogpush fails with no logpush anywhere', () => {
  assert.equal(checkLogpush({}).pass, false);
});

test('checkAnalyticsEngine passes with a top-level binding', () => {
  const config = { analytics_engine_datasets: [{ binding: 'AE' }] };
  assert.equal(checkAnalyticsEngine(config).pass, true);
});

test('checkAnalyticsEngine passes with a binding on a named environment', () => {
  const config = { env: { production: { analytics_engine_datasets: [{ binding: 'AE' }] } } };
  assert.equal(checkAnalyticsEngine(config).pass, true);
});

test('checkAnalyticsEngine fails with no binding anywhere', () => {
  assert.equal(checkAnalyticsEngine({}).pass, false);
});

test('checkCompatibilityDate passes within the policy window', () => {
  const now = new Date('2026-07-01T00:00:00Z');
  const result = checkCompatibilityDate({ compatibility_date: '2026-06-01' }, 90, now);
  assert.equal(result.pass, true);
});

test('checkCompatibilityDate fails beyond the policy window', () => {
  const now = new Date('2026-07-01T00:00:00Z');
  const result = checkCompatibilityDate({ compatibility_date: '2025-01-01' }, 90, now);
  assert.equal(result.pass, false);
});

test('checkCompatibilityDate fails when the field is missing', () => {
  assert.equal(checkCompatibilityDate({}, 90).pass, false);
});

test('checkCompatibilityDate fails on a malformed date string', () => {
  assert.equal(checkCompatibilityDate({ compatibility_date: 'not-a-date' }, 90).pass, false);
});

// ---------------------------------------------------------------------------
// evaluateBaseline (exception reconciliation)
// ---------------------------------------------------------------------------

test('evaluateBaseline reports zero violations for a fully-compliant config', () => {
  const now = new Date('2026-07-01T00:00:00Z');
  const config = {
    env: { production: {} },
    logpush: true,
    analytics_engine_datasets: [{ binding: 'AE' }],
    compatibility_date: '2026-06-01',
  };
  const report = evaluateBaseline(config, 90, now);
  assert.deepEqual(report.violations, []);
  assert.equal(report.findings.every((f) => f.pass), true);
});

test('evaluateBaseline reports every failing rule as a violation with no exceptions declared', () => {
  const report = evaluateBaseline({}, 90, new Date('2026-07-01T00:00:00Z'));
  const ids = report.violations.map((v) => v.id).sort();
  assert.deepEqual(ids, ['analytics-engine', 'compat-date-stale', 'env-split', 'logpush']);
});

test('evaluateBaseline suppresses a violation with a declared exception, but still reports it', () => {
  const config = {
    env: { production: {} },
    logpush: true,
    compatibility_date: '2026-06-01',
    mandrel: {
      wranglerBaselineExceptions: {
        'analytics-engine': 'no telemetry sink for this static-asset Worker',
      },
    },
  };
  const report = evaluateBaseline(config, 90, new Date('2026-07-01T00:00:00Z'));
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.exceptions, [
    { id: 'analytics-engine', reason: 'no telemetry sink for this static-asset Worker' },
  ]);
  const aeFinding = report.findings.find((f) => f.id === 'analytics-engine');
  assert.equal(aeFinding.excepted, true);
});

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

test('renderReport prints a pass line for a clean config', () => {
  const report = evaluateBaseline(
    {
      env: { production: {} },
      logpush: true,
      analytics_engine_datasets: [{ binding: 'AE' }],
      compatibility_date: '2026-06-01',
    },
    90,
    new Date('2026-07-01T00:00:00Z'),
  );
  const text = renderReport(report, 'wrangler.toml');
  assert.match(text, /All baseline rules satisfied/);
});

test('renderReport prints a failure summary and points at the exception mechanism', () => {
  const report = evaluateBaseline({}, 90, new Date('2026-07-01T00:00:00Z'));
  const text = renderReport(report, 'wrangler.toml');
  assert.match(text, /violation\(s\)/);
  assert.match(text, /wranglerBaselineExceptions/);
});

// ---------------------------------------------------------------------------
// runCli — end to end against real temp files, both formats
// ---------------------------------------------------------------------------

function noopStreams() {
  let out = '';
  let err = '';
  return { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, get out() { return out; }, get err() { return err; } };
}

test('runCli exits 0 with a no-op message when no wrangler config exists', () => {
  const streams = noopStreams();
  const exit = runCli({ argv: [], cwd: tmpDir, stdout: streams.stdout, stderr: streams.stderr });
  assert.equal(exit, 0);
  assert.match(streams.out, /No wrangler\.toml/);
});

test('runCli exits 1 on a violating wrangler.toml (strict/default mode)', () => {
  writeFileSync(join(tmpDir, 'wrangler.toml'), 'name = "x"\n');
  const streams = noopStreams();
  const exit = runCli({ argv: [], cwd: tmpDir, stdout: streams.stdout, stderr: streams.stderr, now: new Date('2026-07-01T00:00:00Z') });
  assert.equal(exit, 1);
  assert.match(streams.out, /❌/);
});

test('runCli exits 0 on a violating config with --warn-only (advisory rollout)', () => {
  writeFileSync(join(tmpDir, 'wrangler.toml'), 'name = "x"\n');
  const streams = noopStreams();
  const exit = runCli({
    argv: ['--warn-only'],
    cwd: tmpDir,
    stdout: streams.stdout,
    stderr: streams.stderr,
    now: new Date('2026-07-01T00:00:00Z'),
  });
  assert.equal(exit, 0);
  assert.match(streams.out, /❌/);
});

test('runCli exits 0 on a fully-compliant wrangler.jsonc', () => {
  const jsonc = `{
    // named environment split
    "env": { "production": {} },
    "logpush": true,
    "analytics_engine_datasets": [{ "binding": "AE", "dataset": "events" }],
    "compatibility_date": "2026-06-15"
  }`;
  writeFileSync(join(tmpDir, 'wrangler.jsonc'), jsonc);
  const streams = noopStreams();
  const exit = runCli({ argv: [], cwd: tmpDir, stdout: streams.stdout, stderr: streams.stderr, now: new Date('2026-07-01T00:00:00Z') });
  assert.equal(exit, 0);
  assert.match(streams.out, /All baseline rules satisfied/);
});

test('runCli exits 0 on a fully-compliant wrangler.toml', () => {
  const toml = `
name = "my-worker"
logpush = true
compatibility_date = "2026-06-15"

[env.production]

[[analytics_engine_datasets]]
binding = "AE"
dataset = "events"
`;
  writeFileSync(join(tmpDir, 'wrangler.toml'), toml);
  const streams = noopStreams();
  const exit = runCli({ argv: [], cwd: tmpDir, stdout: streams.stdout, stderr: streams.stderr, now: new Date('2026-07-01T00:00:00Z') });
  assert.equal(exit, 0);
});

test('runCli --json emits a machine-readable envelope', () => {
  writeFileSync(join(tmpDir, 'wrangler.toml'), 'name = "x"\n');
  const streams = noopStreams();
  const exit = runCli({
    argv: ['--json', '--warn-only'],
    cwd: tmpDir,
    stdout: streams.stdout,
    stderr: streams.stderr,
    now: new Date('2026-07-01T00:00:00Z'),
  });
  assert.equal(exit, 0);
  const parsed = JSON.parse(streams.out);
  assert.equal(parsed.kind, 'wrangler-baseline-report');
  assert.equal(parsed.found, true);
  assert.ok(parsed.violations.length > 0);
});

test('runCli --json reports found:false when no config exists', () => {
  const streams = noopStreams();
  const exit = runCli({ argv: ['--json'], cwd: tmpDir, stdout: streams.stdout, stderr: streams.stderr });
  assert.equal(exit, 0);
  const parsed = JSON.parse(streams.out);
  assert.equal(parsed.found, false);
});

test('runCli --file honors an explicit path outside the default candidates', () => {
  writeFileSync(join(tmpDir, 'custom-wrangler.jsonc'), '{"logpush": true}');
  const streams = noopStreams();
  const exit = runCli({
    argv: ['--file', 'custom-wrangler.jsonc', '--warn-only'],
    cwd: tmpDir,
    stdout: streams.stdout,
    stderr: streams.stderr,
    now: new Date('2026-07-01T00:00:00Z'),
  });
  assert.equal(exit, 0);
  assert.match(streams.out, /custom-wrangler\.jsonc/);
});

test('runCli exits 1 with a parse error on malformed JSON', () => {
  writeFileSync(join(tmpDir, 'wrangler.jsonc'), '{ not valid json');
  const streams = noopStreams();
  const exit = runCli({ argv: [], cwd: tmpDir, stdout: streams.stdout, stderr: streams.stderr });
  assert.equal(exit, 1);
  assert.match(streams.err, /failed to parse/);
});

test('runCli --help prints usage and exits 0 without touching the filesystem', () => {
  const streams = noopStreams();
  const exit = runCli({ argv: ['--help'], cwd: tmpDir, stdout: streams.stdout, stderr: streams.stderr });
  assert.equal(exit, 0);
  assert.match(streams.out, /check-wrangler-baseline\.mjs/);
});

// ---------------------------------------------------------------------------
// JSONC tolerance — trailing commas, and string contents left alone (#407)
// ---------------------------------------------------------------------------

test('parseJsonc tolerates trailing commas in objects and arrays', () => {
  const text = `{
  "name": "web",
  "analytics_engine_datasets": [
    { "binding": "AE", "dataset": "events", },
  ],
}`;
  assert.deepEqual(parseJsonc(text), {
    name: 'web',
    analytics_engine_datasets: [{ binding: 'AE', dataset: 'events' }],
  });
});

test('parseJsonc tolerates a trailing comma separated by a comment', () => {
  const text = '{ "a": [1, 2, /* done */ ], }';
  assert.deepEqual(parseJsonc(text), { a: [1, 2] });
});

test('parseJsonc leaves string contents byte-identical', () => {
  // Each of these would be corrupted by a regex-based comment/comma stripper:
  // `,}` and `,]` look like trailing commas, and `//` looks like a comment
  // even when it is not preceded by a scheme colon.
  const text = JSON.stringify({
    braces: 'a,} b,] c',
    slashes: 'a//b',
    url: 'https://example.com/x',
    block: 'a/*b*/c',
  });
  assert.deepEqual(parseJsonc(text), {
    braces: 'a,} b,] c',
    slashes: 'a//b',
    url: 'https://example.com/x',
    block: 'a/*b*/c',
  });
});

test('parseJsonc still strips real comments outside strings', () => {
  const text = `{
  // line comment
  "logpush": true, /* block */
  "name": "x"
}`;
  assert.deepEqual(parseJsonc(text), { logpush: true, name: 'x' });
});

test('parseJsonc reports parse-error positions against the original offsets', () => {
  // Comments and trailing commas are blanked in place, never deleted, so a
  // position in the error message still points at the operator's file.
  const text = '{\n  // a comment\n  "a": 1\n  "b": 2\n}';
  assert.throws(
    () => parseJsonc(text),
    (err) => /position (2[0-9]|3[0-9])/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Advisory mode is a promise about exit codes, not about findings (#407)
// ---------------------------------------------------------------------------

test('runCli exits 0 on an unparseable config with --warn-only', () => {
  writeFileSync(join(tmpDir, 'wrangler.jsonc'), '{ not valid json');
  const streams = noopStreams();
  const exit = runCli({
    argv: ['--warn-only'],
    cwd: tmpDir,
    stdout: streams.stdout,
    stderr: streams.stderr,
  });
  assert.equal(exit, 0, 'advisory mode must never hard-fail on config content');
  assert.match(streams.err, /failed to parse/);
});

test('runCli --json emits a parseError envelope instead of dying silently', () => {
  writeFileSync(join(tmpDir, 'wrangler.jsonc'), '{ not valid json');
  const streams = noopStreams();
  const exit = runCli({
    argv: ['--json', '--warn-only'],
    cwd: tmpDir,
    stdout: streams.stdout,
    stderr: streams.stderr,
  });
  assert.equal(exit, 0);
  const envelope = JSON.parse(streams.out);
  assert.equal(envelope.kind, 'wrangler-baseline-report');
  assert.equal(envelope.found, true);
  assert.ok(envelope.parseError, 'the envelope names why the config was unusable');
});

test('runCli reads a trailing-comma wrangler.jsonc end to end', () => {
  writeFileSync(
    join(tmpDir, 'wrangler.jsonc'),
    `{
  "compatibility_date": "2026-06-15",
  "logpush": true,
  "env": { "production": { "logpush": true, }, },
  "analytics_engine_datasets": [{ "binding": "AE", "dataset": "events", },],
}`,
  );
  const streams = noopStreams();
  const exit = runCli({
    argv: [],
    cwd: tmpDir,
    stdout: streams.stdout,
    stderr: streams.stderr,
    now: new Date('2026-07-01T00:00:00Z'),
  });
  assert.equal(exit, 0, streams.out + streams.err);
});

// ---------------------------------------------------------------------------
// The consumer end state reported in #406 (Turborepo + declared exception)
// ---------------------------------------------------------------------------

test('runCli renders a declared exception as EXCEPTED while still reporting a real violation', () => {
  // domio's shape: the Worker config lives outside the repo root, uses
  // trailing commas throughout, declares an analytics-engine opt-out, and has
  // a genuinely stale compatibility_date.
  mkdirSync(join(tmpDir, 'apps', 'web'), { recursive: true });
  writeFileSync(
    join(tmpDir, 'apps', 'web', 'wrangler.jsonc'),
    `{
  // Worker config for the web app
  "name": "web",
  "compatibility_date": "2025-01-01",
  "logpush": true,
  "env": { "production": { "logpush": true, }, },
  "mandrel": {
    "wranglerBaselineExceptions": {
      "analytics-engine": "no telemetry sink for this static-asset Worker",
    },
  },
}`,
  );
  const streams = noopStreams();
  const exit = runCli({
    argv: ['--file', 'apps/web/wrangler.jsonc', '--json'],
    cwd: tmpDir,
    stdout: streams.stdout,
    stderr: streams.stderr,
    now: new Date('2026-08-29T00:00:00Z'),
  });

  const envelope = JSON.parse(streams.out);
  const analytics = envelope.findings.find((f) => f.id === 'analytics-engine');
  assert.equal(analytics.excepted, true, 'the declared opt-out is honoured');
  assert.ok(
    !envelope.violations.some((v) => v.id === 'analytics-engine'),
    'an excepted rule is absent from violations',
  );
  assert.ok(
    envelope.violations.some((v) => v.id === 'compat-date-stale'),
    'a genuine staleness violation is still reported',
  );
  assert.equal(exit, 1, 'a real un-excepted violation still fails in blocking mode');
});

// ---------------------------------------------------------------------------
// Direct-invocation guard — spawned as a SUBPROCESS through a symlink (#407)
//
// Every other test here imports runCli, which is exactly why the guard bug
// survived: the guard line only runs when the file is the process entry point.
// These cases spawn it the way a pnpm consumer's CI does.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Spawn the CLI at `scriptPath` with `cwd`, returning the child result.
 *
 * @param {string} scriptPath Path to invoke (possibly through a symlink).
 * @param {string[]} args CLI args.
 * @param {string} cwd Working directory for the child.
 */
function runScript(scriptPath, args, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf-8',
  });
}

test('the CLI runs when invoked through a pnpm-style symlinked node_modules', () => {
  // node_modules/mandrel-platform -> <repo root>, the shape pnpm installs.
  const nodeModules = join(tmpDir, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(REPO_ROOT, join(nodeModules, 'mandrel-platform'), 'dir');
  writeFileSync(join(tmpDir, 'wrangler.json'), '{"compatibility_date": "2020-01-01"}');

  const linked = join(
    nodeModules,
    'mandrel-platform',
    'scripts',
    'check-wrangler-baseline.mjs',
  );
  const result = runScript(linked, ['--max-age-days', '90'], tmpDir);

  assert.notEqual(
    result.stdout.trim(),
    '',
    'a symlinked invocation must produce output, not a silent pass',
  );
  assert.match(result.stdout, /wrangler-baseline/);
  assert.equal(result.status, 1, 'a violating config exits non-zero in blocking mode');
});

test('a symlinked invocation honours --warn-only rather than exiting silently', () => {
  const nodeModules = join(tmpDir, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(REPO_ROOT, join(nodeModules, 'mandrel-platform'), 'dir');
  writeFileSync(join(tmpDir, 'wrangler.json'), '{"compatibility_date": "2020-01-01"}');

  const linked = join(
    nodeModules,
    'mandrel-platform',
    'scripts',
    'check-wrangler-baseline.mjs',
  );
  const result = runScript(linked, ['--max-age-days', '90', '--warn-only'], tmpDir);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /violation/i, 'advisory mode still reports the findings');
});

test('the CLI still runs when invoked through its real path', () => {
  writeFileSync(join(tmpDir, 'wrangler.json'), '{"compatibility_date": "2020-01-01"}');
  const direct = join(REPO_ROOT, 'scripts', 'check-wrangler-baseline.mjs');
  const result = runScript(direct, ['--max-age-days', '90'], tmpDir);
  assert.match(result.stdout, /wrangler-baseline/);
  assert.equal(result.status, 1);
});

test('importing the module does not execute the CLI', () => {
  // The guard must be false when the entry point is some other script.
  const probe = join(tmpDir, 'probe.mjs');
  const target = join(REPO_ROOT, 'scripts', 'check-wrangler-baseline.mjs');
  writeFileSync(
    probe,
    `await import(${JSON.stringify(pathToFileURL(target).href)});\nconsole.log('IMPORT-OK');\n`,
  );
  writeFileSync(join(tmpDir, 'wrangler.json'), '{"compatibility_date": "2020-01-01"}');
  const result = runScript(probe, [], tmpDir);
  assert.equal(result.status, 0, 'an import must not exit(1) via the CLI');
  assert.match(result.stdout, /IMPORT-OK/);
  assert.doesNotMatch(result.stdout, /wrangler-baseline/);
});
