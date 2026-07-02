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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
