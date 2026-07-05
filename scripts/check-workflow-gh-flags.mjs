#!/usr/bin/env node
/**
 * check-workflow-gh-flags.mjs — static lint for known-invalid `gh` CLI flag
 * combinations inside GitHub Actions workflows.
 *
 * WHY THIS EXISTS
 * ---------------
 * A `gh api` invocation is valid shell and passes `actionlint` /
 * `shellcheck`, yet can still be rejected by the `gh` CLI at RUNTIME because a
 * flag combination is unsupported. That failure surfaces only when the step
 * runs — for the release pipeline, that means "at release time", the worst
 * possible moment. Release 0.25.0 wedged its `await-smoke` gate for exactly
 * this reason:
 *
 *     gh api --paginate --slurp "…/status" --jq '…'
 *     → the `--slurp` option is not supported with `--jq` or `--template`
 *
 * Every poll attempt failed instantly, `|| echo none` swallowed it, and the
 * gate timed out on EVERY release even though smoke was green. No unit test,
 * acceptance critic, epic-audit, or code-review caught it because none
 * exercised the real `gh` CLI. This lint shifts that class of failure LEFT
 * into `ci-required` so an invalid `gh` invocation fails a PR, not a release.
 *
 * RULES (extensible — add more as new `gh` incompatibilities are discovered):
 *   1. slurp-with-jq — `gh` rejects `--slurp` together with `--jq` or
 *      `--template`. The supported pattern is `gh api --slurp … | jq …`
 *      (pipe to a STANDALONE jq), so this lint splits on shell pipes and only
 *      flags a single `gh` command segment that carries BOTH flags.
 *
 * SCOPE: `.github/workflows/*.yml` + `templates/workflows/*.yml`.
 * Exit 0 when clean, 1 when any violation is found (prints file:line).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIRS = ['.github/workflows', 'templates/workflows'];

/**
 * Collapse shell line-continuations (`\` + newline) so a multi-line `gh`
 * invocation becomes one logical line, WITHOUT losing the original line number
 * of where the command started. Returns an array of
 * `{ line, text }` logical commands (1-indexed `line`).
 */
export function collapseContinuations(source) {
  const rawLines = source.split('\n');
  const logical = [];
  let buf = null;
  let startLine = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const continues = /\\\s*$/.test(line);
    const stripped = line.replace(/\\\s*$/, '');
    if (buf === null) {
      startLine = i + 1;
      buf = stripped;
    } else {
      buf += ' ' + stripped.trim();
    }
    if (!continues) {
      logical.push({ line: startLine, text: buf });
      buf = null;
    }
  }
  if (buf !== null) logical.push({ line: startLine, text: buf });
  return logical;
}

/**
 * Split a logical shell line into command segments on the separators that
 * terminate one simple command and start another: pipe, `;`, `&&`, `||`,
 * and command-substitution boundaries. A `gh api --slurp … | jq …` therefore
 * becomes two segments — the `gh` part (no `--jq`) and the `jq` part — so the
 * SUPPORTED pattern is never flagged.
 */
export function splitSegments(text) {
  // Split on |, ||, ;, &&, and the `$(` / `)` / backtick substitution edges.
  return text.split(/\|\||&&|[|;`]|\$\(|\)/);
}

/** Return an array of rule-violation strings for one segment (may be empty). */
export function lintSegment(segment) {
  const violations = [];
  const isGh = /(^|\s)gh(\s|$)/.test(segment);
  if (!isGh) return violations;

  // Rule 1 — slurp-with-jq/template.
  const hasSlurp = /(^|\s)--slurp(\s|=|$)/.test(segment);
  const hasJq = /(^|\s)--jq(\s|=|$)/.test(segment);
  const hasTemplate = /(^|\s)(--template|-t)(\s|=|$)/.test(segment);
  if (hasSlurp && (hasJq || hasTemplate)) {
    violations.push(
      `slurp-with-jq: \`gh\` rejects --slurp together with ${
        hasJq ? '--jq' : '--template'
      }. Pipe --slurp's output to a STANDALONE jq instead: \`gh api --slurp … | jq …\`.`,
    );
  }
  return violations;
}

/** Lint a single workflow file. Returns an array of finding objects. */
export function lintFile(path, source) {
  const findings = [];
  for (const { line, text } of collapseContinuations(source)) {
    for (const segment of splitSegments(text)) {
      for (const rule of lintSegment(segment)) {
        findings.push({ path, line, rule });
      }
    }
  }
  return findings;
}

function collectWorkflowFiles() {
  const files = [];
  for (const dir of WORKFLOW_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.yml') || name.endsWith('.yaml')) {
        files.push(join(dir, name));
      }
    }
  }
  return files.sort();
}

function main() {
  const files = collectWorkflowFiles();
  const findings = [];
  for (const f of files) {
    findings.push(...lintFile(f, readFileSync(f, 'utf8')));
  }

  if (findings.length === 0) {
    console.log(
      `[check-workflow-gh-flags] ✓ ${files.length} workflow file(s) — no invalid gh flag combinations.`,
    );
    return 0;
  }

  console.error(
    `[check-workflow-gh-flags] ✗ ${findings.length} invalid gh flag combination(s):\n`,
  );
  for (const { path, line, rule } of findings) {
    console.error(`  ${path}:${line} — ${rule}`);
  }
  console.error(
    '\nThese pass actionlint/shellcheck but fail the `gh` CLI at RUNTIME. Fix before merge.',
  );
  return 1;
}

// Run only as a CLI, not when imported by the test suite.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
