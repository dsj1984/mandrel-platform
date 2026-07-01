#!/usr/bin/env node
/**
 * check-wrangler-baseline.mjs
 *
 * Wrangler configuration baseline gate (Story #177, roadmap §2a.3).
 *
 * Four wrangler invariants were "kept by convention" across the fleet with no
 * automated enforcement (repo-ops consumers matrix §2/§7): the `env.*`
 * named-Environment split, `logpush: true` per Worker, an Analytics Engine
 * binding, and a `compatibility_date` staleness policy (Renovate's preset
 * bumps the date whenever `wrangler` itself is bumped, but nothing flags a
 * `compatibility_date` that has gone stale on its own). This script asserts
 * all four against a consumer's own `wrangler.toml` / `wrangler.jsonc`.
 *
 * Designed to run in mandrel-platform consumers as a CI lint step (wired into
 * the `pr-quality` reusable workflow's `lint` tier — see
 * `.github/workflows/pr-quality.yml`), or standalone from this repo against a
 * given file. Mirrors `check-docs-staleness.mjs`'s consumer-runnable framing:
 * a project with no wrangler config at all is a no-op pass (not every
 * consumer is a Cloudflare Worker).
 *
 * Exceptions: a Worker that legitimately opts out of one invariant declares
 * it explicitly via a top-level `mandrel` block (see `docs/reusable-workflows.md`)
 * rather than silently failing to match — e.g.:
 *
 *   // wrangler.jsonc
 *   "mandrel": {
 *     "wranglerBaselineExceptions": {
 *       "analytics-engine": "no telemetry sink for this static-asset Worker"
 *     }
 *   }
 *
 * or, in wrangler.toml:
 *
 *   [mandrel.wranglerBaselineExceptions]
 *   analytics-engine = "no telemetry sink for this static-asset Worker"
 *
 * A declared exception suppresses that one rule's finding but is echoed back
 * in the report so it stays visible (declared, not silent).
 *
 * Usage:
 *   node scripts/check-wrangler-baseline.mjs [options]
 *
 * Options:
 *   --file <path>         Path to the wrangler config (default: auto-detect
 *                         wrangler.jsonc then wrangler.toml at repo root).
 *   --max-age-days <n>    Staleness window for compatibility_date (default: 90).
 *   --warn-only           Exit 0 even when violations are found (advisory).
 *   --json                Emit a machine-readable envelope instead of text.
 *   --help                Print this help and exit.
 *
 * Exit codes:
 *   0 — no config found (no-op pass), all rules pass, or --warn-only.
 *   1 — at least one un-excepted rule violation (without --warn-only).
 *
 * Advisory rollout (acceptance criteria): the `pr-quality` wiring defaults
 * `wrangler-baseline-fail-on-violation: false` (the tier reports but never
 * blocks) until the fleet is clean; flip the caller default to `true` once
 * every consumer is green.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ file: string | null, maxAgeDays: number, warnOnly: boolean, json: boolean, help: boolean }}
 */
export function parseArgv(argv = []) {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: 'string' },
      'max-age-days': { type: 'string', default: '90' },
      'warn-only': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: false,
  });
  const maxAgeDays = Number.parseInt(values['max-age-days'], 10);
  return {
    file: values.file ?? null,
    maxAgeDays: Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 90,
    warnOnly: values['warn-only'] === true,
    json: values.json === true,
    help: values.help === true,
  };
}

const HELP_TEXT = `
check-wrangler-baseline.mjs — wrangler config baseline gate for mandrel-platform consumers

Usage:
  node scripts/check-wrangler-baseline.mjs [options]

Options:
  --file <path>         Path to the wrangler config (default: auto-detect
                         wrangler.jsonc then wrangler.toml at repo root)
  --max-age-days <n>    Staleness window for compatibility_date (default: 90)
  --warn-only           Exit 0 even when violations are found
  --json                Emit a machine-readable envelope
  --help                Print this help and exit

Rules:
  env-split          At least one named [env.*] / "env": { ... } block exists.
  logpush            Top-level (or per-audited-env) logpush = true.
  analytics-engine   At least one Analytics Engine binding
                     ([[analytics_engine_datasets]] / "analytics_engine_datasets").
  compat-date-stale  compatibility_date is within --max-age-days of today.

Exceptions: declare a rule opt-out in a top-level "mandrel.wranglerBaselineExceptions"
block (see docs/reusable-workflows.md) rather than silently failing to match.
`;

// ---------------------------------------------------------------------------
// Config discovery
// ---------------------------------------------------------------------------

const DEFAULT_CANDIDATES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/**
 * Locate the wrangler config file to check. Returns null when none exists
 * (a consumer with no wrangler config at all is a legitimate no-op, not
 * every mandrel-platform consumer is a Cloudflare Worker).
 *
 * @param {string | null} explicitFile
 * @param {string} cwd
 * @returns {string | null} absolute path, or null.
 */
export function resolveConfigPath(explicitFile, cwd = process.cwd()) {
  if (explicitFile) {
    const abs = resolve(cwd, explicitFile);
    return existsSync(abs) ? abs : null;
  }
  for (const candidate of DEFAULT_CANDIDATES) {
    const abs = resolve(cwd, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsers — no TOML/JSONC dependency in this package, so both parsers are
// hand-rolled and scoped to exactly what this gate needs (flat/nested key
// lookups and named-table detection), matching the existing repo convention
// (see platform-sync.mjs's parseJsonc for the same tolerant-JSON approach).
// ---------------------------------------------------------------------------

/**
 * Parse JSON tolerating `//` line comments and block comments (jsonc).
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return JSON.parse(stripped);
}

/**
 * Minimal TOML parser scoped to wrangler.toml's shape: `key = value` pairs,
 * `[section]` / `[section.sub]` tables, and `[[array.of.tables]]`. Produces a
 * plain object mirroring wrangler's JSON config shape closely enough for this
 * gate's rules (env.* detection, logpush booleans, analytics_engine_datasets
 * array-of-tables, compatibility_date string). Does NOT aim to be a general
 * TOML parser — inline arrays/tables and multi-line strings are out of scope
 * (wrangler.toml in the wild does not use them for these fields).
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseWranglerToml(text) {
  const root = {};
  let current = root;
  let currentArrayTableKey = null;

  const getOrCreatePath = (obj, path) => {
    let node = obj;
    for (const key of path) {
      if (typeof node[key] !== 'object' || node[key] === null || Array.isArray(node[key])) {
        node[key] = node[key] && typeof node[key] === 'object' ? node[key] : {};
      }
      node = node[key];
    }
    return node;
  };

  const coerceValue = (raw) => {
    const v = raw.trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  };

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    // Strip trailing comments (naive: a `#` outside quotes). Good enough for
    // wrangler.toml's simple key/value + table-header shape.
    let line = rawLine;
    const commentIdx = line.indexOf('#');
    if (commentIdx !== -1) {
      const before = line.slice(0, commentIdx);
      // Only strip when the `#` isn't inside a quoted string.
      const quoteCount = (before.match(/"/g) || []).length + (before.match(/'/g) || []).length;
      if (quoteCount % 2 === 0) line = before;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    const arrayTableMatch = /^\[\[([^\]]+)\]\]$/.exec(trimmed);
    if (arrayTableMatch) {
      const path = arrayTableMatch[1].split('.').map((p) => p.trim());
      const parentPath = path.slice(0, -1);
      const leafKey = path[path.length - 1];
      const parent = getOrCreatePath(root, parentPath);
      if (!Array.isArray(parent[leafKey])) parent[leafKey] = [];
      const entry = {};
      parent[leafKey].push(entry);
      current = entry;
      currentArrayTableKey = arrayTableMatch[1];
      continue;
    }

    const tableMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (tableMatch) {
      const path = tableMatch[1].split('.').map((p) => p.trim());
      current = getOrCreatePath(root, path);
      currentArrayTableKey = null;
      continue;
    }

    const kvMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      current[key] = coerceValue(rawValue);
    }
  }
  void currentArrayTableKey; // retained for readability of the state machine
  return root;
}

/**
 * Parse a wrangler config file by extension.
 * @param {string} filePath
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseWranglerConfig(filePath, text) {
  return filePath.endsWith('.toml') ? parseWranglerToml(text) : parseJsonc(text);
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

/**
 * Read declared per-consumer exceptions from `mandrel.wranglerBaselineExceptions`.
 * @param {Record<string, any>} config
 * @returns {Record<string, string>} ruleId -> reason.
 */
export function readExceptions(config) {
  const exceptions = config?.mandrel?.wranglerBaselineExceptions;
  if (!exceptions || typeof exceptions !== 'object') return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(exceptions)) {
    if (typeof v === 'string' && v.trim().length > 0) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules — each returns { id, pass, message } (pass ignores exceptions; the
// caller reconciles pass/exception into the final verdict).
// ---------------------------------------------------------------------------

/**
 * Does the config declare at least one named Environment (`[env.<name>]` in
 * TOML, or `"env": { "<name>": {...} }` in JSON)?
 * @param {Record<string, any>} config
 * @returns {{ id: string, pass: boolean, message: string }}
 */
export function checkEnvSplit(config) {
  const env = config.env;
  const names = env && typeof env === 'object' ? Object.keys(env) : [];
  const pass = names.length > 0;
  return {
    id: 'env-split',
    pass,
    message: pass
      ? `named Environment split present: ${names.join(', ')}`
      : 'no [env.*] / "env" named-Environment split found',
  };
}

/**
 * Is `logpush` enabled, either at top level or on every named environment
 * present in the config? A Worker with named environments and a top-level
 * `logpush = true` inherits it per wrangler's env-inheritance rules, so a
 * top-level `true` satisfies the rule regardless of per-env overrides that
 * don't explicitly disable it.
 * @param {Record<string, any>} config
 * @returns {{ id: string, pass: boolean, message: string }}
 */
export function checkLogpush(config) {
  if (config.logpush === true) {
    return { id: 'logpush', pass: true, message: 'logpush = true at top level' };
  }
  const env = config.env && typeof config.env === 'object' ? config.env : {};
  const envNames = Object.keys(env);
  if (envNames.length > 0 && envNames.every((name) => env[name]?.logpush === true)) {
    return {
      id: 'logpush',
      pass: true,
      message: `logpush = true on every named environment (${envNames.join(', ')})`,
    };
  }
  return {
    id: 'logpush',
    pass: false,
    message: 'logpush is not enabled at top level or on every named environment',
  };
}

/**
 * Is at least one Analytics Engine binding declared, at top level or on any
 * named environment?
 * @param {Record<string, any>} config
 * @returns {{ id: string, pass: boolean, message: string }}
 */
export function checkAnalyticsEngine(config) {
  const hasBinding = (obj) => Array.isArray(obj?.analytics_engine_datasets) && obj.analytics_engine_datasets.length > 0;
  if (hasBinding(config)) {
    return { id: 'analytics-engine', pass: true, message: 'analytics_engine_datasets binding present at top level' };
  }
  const env = config.env && typeof config.env === 'object' ? config.env : {};
  const envWithBinding = Object.keys(env).find((name) => hasBinding(env[name]));
  if (envWithBinding) {
    return {
      id: 'analytics-engine',
      pass: true,
      message: `analytics_engine_datasets binding present on env.${envWithBinding}`,
    };
  }
  return {
    id: 'analytics-engine',
    pass: false,
    message: 'no analytics_engine_datasets binding found (top level or any named environment)',
  };
}

/**
 * Is `compatibility_date` present and within the staleness policy window?
 * @param {Record<string, any>} config
 * @param {number} maxAgeDays
 * @param {Date} [now]
 * @returns {{ id: string, pass: boolean, message: string }}
 */
export function checkCompatibilityDate(config, maxAgeDays, now = new Date()) {
  const raw = config.compatibility_date;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { id: 'compat-date-stale', pass: false, message: 'compatibility_date is missing or not in YYYY-MM-DD form' };
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { id: 'compat-date-stale', pass: false, message: `compatibility_date "${raw}" is not a valid calendar date` };
  }
  const ageMs = now.getTime() - parsed.getTime();
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const pass = ageDays <= maxAgeDays;
  return {
    id: 'compat-date-stale',
    pass,
    message: pass
      ? `compatibility_date ${raw} is ${ageDays} day(s) old (within the ${maxAgeDays}-day policy window)`
      : `compatibility_date ${raw} is ${ageDays} day(s) old, exceeding the ${maxAgeDays}-day policy window`,
  };
}

const ALL_RULES = [checkEnvSplit, checkLogpush, checkAnalyticsEngine, checkCompatibilityDate];

/**
 * Run every rule against the config and reconcile with declared exceptions.
 * @param {Record<string, any>} config
 * @param {number} maxAgeDays
 * @param {Date} [now]
 * @returns {{
 *   findings: Array<{ id: string, pass: boolean, message: string, excepted: boolean, exceptionReason: string | null }>,
 *   violations: Array<{ id: string, message: string }>,
 *   exceptions: Array<{ id: string, reason: string }>,
 * }}
 */
export function evaluateBaseline(config, maxAgeDays, now = new Date()) {
  const exceptions = readExceptions(config);
  const findings = ALL_RULES.map((rule) => {
    const result = rule === checkCompatibilityDate ? rule(config, maxAgeDays, now) : rule(config);
    const exceptionReason = exceptions[result.id] ?? null;
    return { ...result, excepted: !result.pass && exceptionReason !== null, exceptionReason };
  });
  const violations = findings.filter((f) => !f.pass && !f.excepted).map((f) => ({ id: f.id, message: f.message }));
  const declaredExceptions = findings
    .filter((f) => f.excepted)
    .map((f) => ({ id: f.id, reason: /** @type {string} */ (f.exceptionReason) }));
  return { findings, violations, exceptions: declaredExceptions };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<typeof evaluateBaseline>} report
 * @param {string} configLabel
 * @returns {string}
 */
export function renderReport(report, configLabel) {
  const lines = [`[wrangler-baseline] Checked ${configLabel}`];
  for (const f of report.findings) {
    if (f.pass) {
      lines.push(`  ✅ ${f.id}: ${f.message}`);
    } else if (f.excepted) {
      lines.push(`  ⚠️  ${f.id}: EXCEPTED — ${f.exceptionReason} (would otherwise fail: ${f.message})`);
    } else {
      lines.push(`  ❌ ${f.id}: ${f.message}`);
    }
  }
  lines.push('');
  if (report.violations.length === 0) {
    lines.push('[wrangler-baseline] ✅ All baseline rules satisfied (or explicitly excepted).');
  } else {
    lines.push(
      `[wrangler-baseline] ❌ ${report.violations.length} violation(s). Declare a legitimate opt-out via ` +
        '"mandrel.wranglerBaselineExceptions" (see docs/reusable-workflows.md) rather than leaving it unmet silently.',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   now?: Date,
 * }} [opts]
 * @returns {number} exit code
 */
export function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  now = new Date(),
} = {}) {
  const { file, maxAgeDays, warnOnly, json, help } = parseArgv(argv);

  if (help) {
    stdout.write(HELP_TEXT);
    return 0;
  }

  const configPath = resolveConfigPath(file, cwd);
  if (!configPath) {
    if (json) {
      stdout.write(`${JSON.stringify({ kind: 'wrangler-baseline-report', found: false, violations: [] })}\n`);
    } else {
      stdout.write('[wrangler-baseline] No wrangler.toml / wrangler.jsonc found — nothing to check.\n');
    }
    return 0;
  }

  let config;
  try {
    const text = readFileSync(configPath, 'utf-8');
    config = parseWranglerConfig(configPath, text);
  } catch (err) {
    stderr.write(`[wrangler-baseline] ❌ failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const report = evaluateBaseline(config, maxAgeDays, now);

  if (json) {
    stdout.write(`${JSON.stringify({ kind: 'wrangler-baseline-report', found: true, file: configPath, ...report }, null, 2)}\n`);
  } else {
    stdout.write(`${renderReport(report, configPath)}\n`);
  }

  if (report.violations.length > 0 && !warnOnly) {
    return 1;
  }
  return 0;
}

// Direct-invocation guard (matches the repo's other scripts/*.mjs entry style).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  process.exit(runCli());
}
