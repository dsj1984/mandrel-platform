#!/usr/bin/env node
/**
 * check-workflow-platform-checkout.mjs — static lint for the side-checkouts a
 * reusable workflow makes of THIS repository.
 *
 * WHY THIS EXISTS
 * ---------------
 * A reusable workflow that runs `scripts/*.mjs` has to fetch them from
 * mandrel-platform itself, pinned to the exact commit the caller's
 * `uses: …@<ref>` pin resolved to. Two silent failure modes made that pin
 * decorative for the whole life of the mechanism (Story #415):
 *
 *   1. The `ref:` expression read `job_workflow_sha` off the `github` context.
 *      That is an OIDC token CLAIM, not a context property, so it evaluated to
 *      the EMPTY STRING — with or without the `fromJSON(toJSON(github))`
 *      escape hatch that was added to silence actionlint. `actions/checkout`
 *      omits an empty input and falls back to the default branch, so every
 *      consumer ran platform scripts from `main` regardless of what it pinned.
 *      Nothing was red: the wrong code simply ran.
 *
 *   2. `sparse-checkout-cone-mode: false` makes a sparse list EXHAUSTIVE. A
 *      list naming `scripts/foo.mjs` and nothing else fetches that one file —
 *      not the `scripts/lib/` helpers it imports. The first time a listed
 *      script grew a `./lib/*` import, every consumer went red instantly with
 *      ERR_MODULE_NOT_FOUND, with no consumer-side change to revert.
 *
 * Both are invisible to actionlint, shellcheck and every unit test, because
 * both are about what a correct-looking workflow RESOLVES TO at runtime. This
 * lint shifts them left into `ci-required`.
 *
 * RULES
 *   1. dead-token   — the string `job_workflow_sha` must not appear anywhere in
 *      a workflow file, comments included, so it cannot be copied forward.
 *   2. resolved-ref — a checkout of `dsj1984/mandrel-platform` must take its
 *      `ref:` from a step output (`steps.<id>.outputs.sha`), never from a raw
 *      context expression that can silently evaluate to empty.
 *   3. fail-closed  — that step must exist in the same job, read
 *      `job.workflow_sha`, and assert a 40-hex value before emitting it.
 *   4. guard-parity — the resolve step must run whenever the checkout does: it
 *      is either unguarded (so it always runs, covering every checkout in the
 *      job) or carries the checkout's exact `if:`. If the two can diverge, the
 *      resolve step skips while the checkout runs, and `actions/checkout` gets
 *      an empty ref again — the original bug, exactly.
 *   5. module-graph — a sparse list naming a `scripts/*.mjs` file must also
 *      name `scripts/lib/`, so a script arrives with its module graph.
 *
 * SCOPE: `.github/workflows/*.yml` + `templates/workflows/*.yml`.
 * Exit 0 when clean, 1 when any violation is found (prints file:line).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { isDirectInvocation } from './lib/entry-guard.mjs';

const WORKFLOW_DIRS = ['.github/workflows', 'templates/workflows'];

/** The repository a platform side-checkout targets. */
const PLATFORM_REPO = 'dsj1984/mandrel-platform';

/**
 * Split a workflow into steps, resolving YAML anchors so an aliased step
 * (`- *checkout-range`) is analyzed as the step it stands for. Anchors are
 * document-global in YAML, so they are collected over the whole file before
 * any job is walked.
 *
 * Returns `{ anchors, jobs }` where `jobs` is a Map of job name →
 * `{ line, steps: [{ line, text, aliasOf }] }`. `line` is always the line in
 * the ORIGINAL file, so a finding points at real source even when the step
 * came in through an alias.
 */
export function parseWorkflow(source) {
  const lines = source.split('\n');
  const isStepStart = (l) => /^ {6}- /.test(l);

  // Pass 1 — anchor definitions (`      - &name`).
  const anchors = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^ {6}- &([A-Za-z0-9_-]+)\s*$/);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && !isStepStart(lines[j]); j += 1) body.push(lines[j]);
    anchors.set(m[1], body.join('\n'));
  }

  // Pass 2 — jobs and their steps. Only 2-space keys UNDER the top-level
  // `jobs:` mapping are jobs — `on:` has 2-space children too (`workflow_call:`),
  // and treating one as a job would invent a step-less job the rules then walk.
  const jobs = new Map();
  let currentJob = null;
  let inSteps = false;
  let inJobs = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      currentJob = null;
      inSteps = false;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch) {
      currentJob = { name: jobMatch[1], line: i + 1, steps: [] };
      jobs.set(`${jobMatch[1]}@${i + 1}`, currentJob);
      inSteps = false;
      continue;
    }
    if (!currentJob) continue;
    if (/^ {4}steps:\s*$/.test(line)) {
      inSteps = true;
      continue;
    }
    if (!inSteps || !isStepStart(line)) continue;

    const alias = line.match(/^ {6}- \*([A-Za-z0-9_-]+)\s*$/);
    if (alias) {
      currentJob.steps.push({
        line: i + 1,
        text: anchors.get(alias[1]) ?? '',
        aliasOf: alias[1],
      });
      continue;
    }
    const body = [line];
    for (let j = i + 1; j < lines.length && !isStepStart(lines[j]); j += 1) {
      if (/^ {0,4}\S/.test(lines[j]) && lines[j].trim() !== '') break;
      body.push(lines[j]);
    }
    currentJob.steps.push({ line: i + 1, text: body.join('\n'), aliasOf: null });
  }
  return { anchors, jobs };
}

/** Strip YAML comment lines so prose never satisfies (or trips) a rule. */
function withoutComments(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** The `if:` guard of a step, or `null`. Normalized for comparison. */
export function stepGuard(text) {
  const m = withoutComments(text).match(/^\s*if:\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

/** The entries of a step's `sparse-checkout:` block scalar. */
export function sparseEntries(text) {
  const lines = withoutComments(text).split('\n');
  const start = lines.findIndex((l) => /^\s*sparse-checkout:\s*\|\s*$/.test(l));
  if (start === -1) return null;
  const indent = lines[start].match(/^\s*/)[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    if (lines[i].match(/^\s*/)[0].length <= indent) break;
    out.push(lines[i].trim());
  }
  return out;
}

/** True when a step is an `actions/checkout` of the platform repo. */
function isPlatformCheckout(text) {
  const body = withoutComments(text);
  return /uses:\s*actions\/checkout@/.test(body) && body.includes(`repository: ${PLATFORM_REPO}`);
}

/**
 * A resolve step: reads `job.workflow_sha` AND exports it to `$GITHUB_OUTPUT`
 * for a later checkout to consume. Reading the value for some other purpose —
 * `deploy-summary` echoes it into the job summary — is not a resolve step and
 * needs no `id:`.
 */
function resolveStepId(text) {
  const body = withoutComments(text);
  if (!body.includes('job.workflow_sha') || !body.includes('GITHUB_OUTPUT')) return null;
  const m = body.match(/^\s*id:\s*([A-Za-z0-9_-]+)\s*$/m);
  return m ? m[1] : '';
}

/** Does a resolve step actually fail closed on a non-40-hex value? */
function assertsFullSha(text) {
  const body = withoutComments(text);
  return /\[0-9a-f\]\{40\}/.test(body) && /exit 1/.test(body);
}

export function lintWorkflow(path, source) {
  const findings = [];
  const add = (line, rule, detail) => findings.push({ path, line, rule, detail });

  // Rule 1 — the dead token, anywhere in the file including comments.
  source.split('\n').forEach((line, i) => {
    if (line.includes('job_workflow_sha')) {
      add(
        i + 1,
        'dead-token',
        '`job_workflow_sha` is an OIDC token claim, not a github-context property — it always evaluates to the empty string. Use the `job` context (`job.workflow_sha`).',
      );
    }
  });

  const { jobs } = parseWorkflow(source);
  for (const job of jobs.values()) {
    const resolvers = new Map();
    for (const step of job.steps) {
      const id = resolveStepId(step.text);
      if (id === null) continue;
      if (id === '') {
        add(step.line, 'fail-closed', 'a step reading `job.workflow_sha` has no `id:`, so no checkout can consume it.');
        continue;
      }
      resolvers.set(id, step);
      if (!assertsFullSha(step.text)) {
        add(
          step.line,
          'fail-closed',
          `resolve step \`${id}\` must assert the value matches ^[0-9a-f]{40}$ and \`exit 1\` otherwise — an unresolved ref must stop the job, never fall back to the default branch.`,
        );
      }
    }

    for (const step of job.steps) {
      if (!isPlatformCheckout(step.text)) continue;
      const body = withoutComments(step.text);
      const ref = body.match(/^\s*ref:\s*(.+?)\s*$/m);

      // Rule 2 — the ref must come from a resolve step's output.
      const viaStep = ref && ref[1].match(/\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.sha\s*\}\}/);
      if (!viaStep) {
        add(
          step.line,
          'resolved-ref',
          `platform checkout must set \`ref: \${{ steps.<id>.outputs.sha }}\` from a fail-closed resolve step; found ${ref ? `\`${ref[1]}\`` : 'no `ref:` at all'}. An empty ref makes actions/checkout silently use the default branch.`,
        );
      } else {
        const resolver = resolvers.get(viaStep[1]);
        if (!resolver) {
          add(
            step.line,
            'fail-closed',
            `\`ref:\` reads \`steps.${viaStep[1]}.outputs.sha\` but no step in this job resolves \`job.workflow_sha\` under that id.`,
          );
        } else if (
          stepGuard(resolver.text) !== null &&
          stepGuard(resolver.text) !== stepGuard(step.text)
        ) {
          // Rule 4 — the resolve step must run WHENEVER the checkout runs. An
          // UNGUARDED resolve step always does, so it safely covers any number
          // of differently-guarded checkouts in the same job. A guarded one
          // only covers a checkout carrying the identical guard: if the two
          // conditions can diverge, the resolve step skips while the checkout
          // runs, `steps.<id>.outputs.sha` is empty, and actions/checkout is
          // back to silently using the default branch — the original bug.
          add(
            step.line,
            'guard-parity',
            `checkout \`if:\` (${stepGuard(step.text) ?? 'none'}) differs from resolve step \`${viaStep[1]}\` \`if:\` (${stepGuard(resolver.text)}). A guarded resolve step must carry the checkout's exact guard, or leave itself unguarded so it always runs.`,
          );
        }
      }

      // Rule 5 — a script travels with its module graph.
      const entries = sparseEntries(step.text);
      if (!entries) continue;
      const coversAll = entries.some((e) => e === 'scripts' || e === 'scripts/');
      const hasLib = entries.some((e) => e === 'scripts/lib' || e === 'scripts/lib/');
      const scriptEntry = entries.find((e) => /^scripts\/[^/]+\.mjs$/.test(e));
      if (scriptEntry && !coversAll && !hasLib) {
        add(
          step.line,
          'module-graph',
          `sparse-checkout lists \`${scriptEntry}\` but not \`scripts/lib/\`, and \`sparse-checkout-cone-mode: false\` makes the list exhaustive — the script's \`./lib/*\` imports would not be fetched.`,
        );
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
      if (name.endsWith('.yml') || name.endsWith('.yaml')) files.push(join(dir, name));
    }
  }
  return files.sort();
}

function main() {
  const files = collectWorkflowFiles();
  const findings = [];
  for (const f of files) findings.push(...lintWorkflow(f, readFileSync(f, 'utf8')));

  if (findings.length === 0) {
    console.log(
      `[check-workflow-platform-checkout] ✓ ${files.length} workflow file(s) — every mandrel-platform side-checkout is pinned, fail-closed, and ships its module graph.`,
    );
    return 0;
  }

  console.error(
    `[check-workflow-platform-checkout] ✗ ${findings.length} platform-checkout violation(s):\n`,
  );
  for (const { path, line, rule, detail } of findings) {
    console.error(`  ${path}:${line} — [${rule}] ${detail}`);
  }
  console.error(
    '\nThese pass actionlint and every unit test, and go wrong only at RUNTIME — on consumers, not here. Fix before merge.',
  );
  return 1;
}

if (isDirectInvocation(import.meta.url)) {
  process.exit(main());
}
