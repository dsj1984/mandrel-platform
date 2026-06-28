#!/usr/bin/env node
/**
 * check-docs-staleness.mjs
 *
 * Flags retired-product references and known staleness patterns in documentation.
 *
 * Designed to be run in mandrel-platform consumers as a CI lint step, or from
 * the mandrel-platform repo itself against its own docs.
 *
 * Usage:
 *   node scripts/check-docs-staleness.mjs [options]
 *
 * Options:
 *   --dir <path>      Directory to scan (default: docs/)
 *   --warn-only       Exit 0 even when issues are found (print warnings, don't fail CI)
 *   --quiet           Suppress per-file output; only print summary
 *   --help            Print this help and exit
 *
 * Examples:
 *   node scripts/check-docs-staleness.mjs
 *   node scripts/check-docs-staleness.mjs --dir docs/ --warn-only
 *   node node_modules/mandrel-platform/scripts/check-docs-staleness.mjs --dir docs/
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: argv } = parseArgs({
  options: {
    dir: { type: 'string', default: 'docs' },
    'warn-only': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

if (argv.help) {
  console.log(`
check-docs-staleness.mjs — docs staleness lint for mandrel-platform consumers

Usage:
  node scripts/check-docs-staleness.mjs [options]

Options:
  --dir <path>      Directory to scan (default: docs/)
  --warn-only       Exit 0 even when issues are found
  --quiet           Suppress per-file output; only print summary
  --help            Print this help and exit
`);
  process.exit(0);
}

const SCAN_DIR = argv.dir ?? 'docs';
const WARN_ONLY = argv['warn-only'] ?? false;
const QUIET = argv.quiet ?? false;

// ---------------------------------------------------------------------------
// Staleness patterns
//
// Each rule has:
//   id          — unique identifier (used in suppression comments)
//   description — human-readable explanation shown in lint output
//   pattern     — regex to search for in file content
//   severity    — 'error' | 'warning'
//   fileGlob    — optional: only apply to files matching this regex
//
// Suppression: add `<!-- staleness-ignore: <id> -->` on the line above the
// flagged text to suppress a specific rule for that occurrence.
// ---------------------------------------------------------------------------

const RULES = [
  {
    id: 'pages-deploy-command',
    description: 'References `wrangler pages deploy` — may be stale if the project has migrated web to a Worker',
    pattern: /wrangler pages deploy/g,
    severity: 'error',
  },
  {
    id: 'pages-dev-url',
    description: 'References `*.pages.dev` URL — may be stale if the project has migrated off Cloudflare Pages',
    pattern: /[a-z0-9-]+\.pages\.dev/g,
    severity: 'error',
  },
  {
    id: 'pages-dashboard-link',
    description: 'References the Cloudflare Pages dashboard (`dash.cloudflare.com/pages`) — may be stale after Worker migration',
    pattern: /dash\.cloudflare\.com\/[a-z0-9]+\/pages/g,
    severity: 'error',
  },
  {
    id: 'pages-rollback',
    description: 'References `wrangler pages deployment rollback` — may be stale if the project has migrated web to a Worker',
    pattern: /wrangler pages deployment rollback/g,
    severity: 'warning',
  },
  {
    id: 'hardcoded-worker-name',
    description: 'Possible hardcoded project-specific worker name in a common runbook (expected only in project-local docs)',
    // Detects patterns like `my-app-staging` or `my-app-production` but not generic `<worker-name>`
    pattern: /--name\s+[a-z][a-z0-9-]+-(staging|production)\b(?!\s*>)/g,
    severity: 'warning',
    fileGlob: /docs\/runbooks\//,
  },
  {
    id: 'hardcoded-url',
    description: 'Possible hardcoded non-placeholder URL (use `<PLACEHOLDER>` style in common runbooks)',
    // Detects https:// URLs that are not placeholders (< >) and not github.com/cloudflare docs links
    pattern: /https:\/\/(?!github\.com|docs\.cloudflare\.com|api\.cloudflare\.com|uptime\.betterstack\.com)[a-z0-9][a-z0-9.-]+\.[a-z]{2,}\/[^\s)"'>]*/g,
    severity: 'warning',
    fileGlob: /docs\/runbooks\//,
  },
  {
    id: 'stale-github-runbooks-ref',
    description: 'References `.github/RUNBOOKS/` — this is the stale duplicate directory pattern; canonical runbooks live in `docs/runbooks/`',
    pattern: /\.github\/RUNBOOKS\//g,
    severity: 'error',
  },
  {
    id: 'quality-yml-ref',
    description: 'References `quality.yml` — verify this file exists in the project (swarm-os ships `ci.yml` instead)',
    pattern: /quality\.yml/g,
    severity: 'warning',
  },
  {
    id: 'expired-placeholder',
    description: 'Placeholder date that has passed (YYYY-MM-DD pattern in an expiry/todo context)',
    // Matches explicit expiry dates like "expires: 2025-01-01" that are in the past
    pattern: /expires[:\s]+202[0-4]-\d{2}-\d{2}/gi,
    severity: 'error',
  },
];

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md and .json files under dir.
 * @param {string} dir
 * @returns {string[]}
 */
function walkDir(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      results.push(...walkDir(fullPath));
    } else if (['.md', '.json'].includes(extname(entry))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Lint a single file
// ---------------------------------------------------------------------------

/**
 * @typedef {{ file: string, line: number, rule: typeof RULES[0], match: string }} Finding
 */

/**
 * Lint a file against all rules.
 * @param {string} filePath
 * @returns {Finding[]}
 */
function lintFile(filePath) {
  const findings = [];
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return findings;
  }

  const lines = content.split('\n');

  for (const rule of RULES) {
    // Skip if this rule has a fileGlob and the file doesn't match
    if (rule.fileGlob && !rule.fileGlob.test(filePath)) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prevLine = i > 0 ? lines[i - 1] : '';

      // Check for suppression comment on the preceding line
      if (prevLine.includes(`staleness-ignore: ${rule.id}`)) continue;

      // Reset regex state for global patterns
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        findings.push({
          file: filePath,
          line: i + 1,
          rule,
          match: match[0],
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const files = walkDir(SCAN_DIR);

if (files.length === 0) {
  console.log(`[docs-staleness] No files found under '${SCAN_DIR}' — nothing to check.`);
  process.exit(0);
}

/** @type {Finding[]} */
const allFindings = [];

for (const file of files) {
  const findings = lintFile(file);
  allFindings.push(...findings);
}

// Group findings by file for readable output
const byFile = new Map();
for (const finding of allFindings) {
  const key = finding.file;
  if (!byFile.has(key)) byFile.set(key, []);
  byFile.get(key).push(finding);
}

const errors = allFindings.filter((f) => f.rule.severity === 'error');
const warnings = allFindings.filter((f) => f.rule.severity === 'warning');

if (!QUIET) {
  for (const [file, findings] of byFile.entries()) {
    const relPath = relative(process.cwd(), file);
    for (const f of findings) {
      const sev = f.rule.severity === 'error' ? 'ERR ' : 'WARN';
      console.log(`[${sev}] ${relPath}:${f.line} — ${f.rule.id}: ${f.rule.description}`);
      console.log(`       matched: ${JSON.stringify(f.match)}`);
    }
  }
}

console.log(
  `\n[docs-staleness] Scanned ${files.length} file(s). ` +
  `Found ${errors.length} error(s), ${warnings.length} warning(s).`,
);

if (allFindings.length > 0) {
  console.log(`\nTo suppress a specific rule occurrence, add this comment on the line above:`);
  console.log(`  <!-- staleness-ignore: <rule-id> -->`);
  console.log(`\nAvailable rule IDs: ${RULES.map((r) => r.id).join(', ')}`);
}

if (errors.length > 0 && !WARN_ONLY) {
  process.exit(1);
}

process.exit(0);
