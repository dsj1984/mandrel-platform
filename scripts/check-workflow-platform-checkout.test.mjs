/**
 * Tests for check-workflow-platform-checkout.mjs (Story #415).
 *
 * The lint exists because the defect class it guards is invisible to every
 * other gate: an empty `ref:` is valid YAML, valid actionlint, and green in CI
 * — it goes wrong only at runtime, on a consumer. So these tests assert both
 * directions: each violation shape IS caught, and each legitimate shape is
 * NOT, because a lint that over-fires on a sound pattern gets suppressed and
 * then guards nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintWorkflow, parseWorkflow, sparseEntries, stepGuard } from './check-workflow-platform-checkout.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A fail-closed resolve step, as the real workflows carry it. */
const RESOLVE = (id, cond) =>
  `      - name: Resolve platform ref
${cond ? `        if: ${cond}\n` : ''}        id: ${id}
        shell: bash
        env:
          PLATFORM_SHA: \${{ job.workflow_sha }}
        run: |
          set -euo pipefail
          if [[ ! "\${PLATFORM_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
            echo "::error::unresolved"
            exit 1
          fi
          echo "sha=\${PLATFORM_SHA}" >> "$GITHUB_OUTPUT"
`;

/** A platform checkout consuming a resolve step's output. */
const CHECKOUT = ({ ref = '${{ steps.platform-ref.outputs.sha }}', cond = null, sparse = ['scripts'] }) =>
  `      - name: Checkout platform
${cond ? `        if: ${cond}\n` : ''}        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          repository: dsj1984/mandrel-platform
          ref: ${ref}
          sparse-checkout: |
${sparse.map((s) => `            ${s}`).join('\n')}
          sparse-checkout-cone-mode: false
          path: _platform
          persist-credentials: false
`;

const workflow = (steps) => `name: t
on:
  workflow_call:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps}`;

const rules = (findings) => findings.map((f) => f.rule).sort();

// ---------------------------------------------------------------------------
// The clean shape
// ---------------------------------------------------------------------------

test('a pinned, fail-closed, module-graph-complete checkout is clean', () => {
  const src = workflow(RESOLVE('platform-ref', null) + '\n' + CHECKOUT({}));
  assert.deepEqual(lintWorkflow('t.yml', src), []);
});

// ---------------------------------------------------------------------------
// Rule 1 — dead-token
// ---------------------------------------------------------------------------

test('the dead job_workflow_sha token is flagged anywhere in the file', () => {
  const src = workflow(
    RESOLVE('platform-ref', null) + '\n' + CHECKOUT({}),
  ).replace('name: t', '# note: job_workflow_sha used to live here\nname: t');
  const found = lintWorkflow('t.yml', src);
  assert.deepEqual(rules(found), ['dead-token']);
  assert.match(found[0].detail, /OIDC token claim/);
});

test('the dead token is flagged even inside a live ref expression', () => {
  const src = workflow(CHECKOUT({ ref: '${{ fromJSON(toJSON(github)).job_workflow_sha }}' }));
  assert.ok(rules(lintWorkflow('t.yml', src)).includes('dead-token'));
});

// ---------------------------------------------------------------------------
// Rule 2 — resolved-ref
// ---------------------------------------------------------------------------

test('a raw context expression as ref: is rejected', () => {
  // The exact shape that shipped the outage — note it is otherwise valid YAML.
  const src = workflow(CHECKOUT({ ref: '${{ github.sha }}' }));
  const found = lintWorkflow('t.yml', src);
  assert.ok(rules(found).includes('resolved-ref'));
  assert.match(found.find((f) => f.rule === 'resolved-ref').detail, /silently use the default branch/);
});

test('a platform checkout with no ref: at all is rejected', () => {
  const src = workflow(
    `      - name: Checkout platform
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          repository: dsj1984/mandrel-platform
          path: _platform
`,
  );
  const found = lintWorkflow('t.yml', src);
  assert.ok(rules(found).includes('resolved-ref'));
  assert.match(found[0].detail, /no `ref:` at all/);
});

test('a checkout of some OTHER repository is not this lint’s business', () => {
  const src = workflow(
    `      - name: Checkout elsewhere
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          repository: someone/else
          ref: \${{ github.sha }}
`,
  );
  assert.deepEqual(lintWorkflow('t.yml', src), []);
});

// ---------------------------------------------------------------------------
// Rule 3 — fail-closed
// ---------------------------------------------------------------------------

test('a resolve step that does not assert 40-hex is rejected', () => {
  const weak = `      - name: Resolve platform ref
        id: platform-ref
        shell: bash
        env:
          PLATFORM_SHA: \${{ job.workflow_sha }}
        run: echo "sha=\${PLATFORM_SHA}" >> "$GITHUB_OUTPUT"
`;
  const found = lintWorkflow('t.yml', workflow(weak + '\n' + CHECKOUT({})));
  assert.ok(rules(found).includes('fail-closed'));
  assert.match(found.find((f) => f.rule === 'fail-closed').detail, /never fall back to the default branch/);
});

test('a ref: pointing at a step id that resolves nothing is rejected', () => {
  const src = workflow(CHECKOUT({ ref: '${{ steps.nope.outputs.sha }}' }));
  const found = lintWorkflow('t.yml', src);
  assert.ok(rules(found).includes('fail-closed'));
});

test('a step reading job.workflow_sha for output but carrying no id is rejected', () => {
  const noId = `      - name: Resolve platform ref
        shell: bash
        env:
          PLATFORM_SHA: \${{ job.workflow_sha }}
        run: |
          if [[ ! "\${PLATFORM_SHA}" =~ ^[0-9a-f]{40}$ ]]; then exit 1; fi
          echo "sha=\${PLATFORM_SHA}" >> "$GITHUB_OUTPUT"
`;
  const found = lintWorkflow('t.yml', workflow(noId));
  assert.ok(rules(found).includes('fail-closed'));
  assert.match(found[0].detail, /no `id:`/);
});

test('reading job.workflow_sha for a job summary is not a resolve step', () => {
  // deploy-summary echoes the resolved SHA without exporting it; requiring an
  // `id:` there would be noise, so this must NOT fire.
  const summary = `      - name: Emit resolved platform-ref summary
        shell: bash
        run: echo "| SHA | \\\`\${SHA}\\\` |" >> "$GITHUB_STEP_SUMMARY"
        env:
          SHA: \${{ job.workflow_sha }}
`;
  assert.deepEqual(lintWorkflow('t.yml', workflow(summary)), []);
});

// ---------------------------------------------------------------------------
// Rule 4 — guard-parity
// ---------------------------------------------------------------------------

test('a guarded resolve step paired with a differently-guarded checkout is rejected', () => {
  const src = workflow(
    RESOLVE('platform-ref', "${{ inputs.a }}") + '\n' + CHECKOUT({ cond: '${{ inputs.b }}' }),
  );
  const found = lintWorkflow('t.yml', src);
  assert.ok(rules(found).includes('guard-parity'));
  assert.match(found.find((f) => f.rule === 'guard-parity').detail, /or leave itself unguarded/);
});

test('matching guards on resolve and checkout are clean', () => {
  const src = workflow(
    RESOLVE('platform-ref', '${{ inputs.a }}') + '\n' + CHECKOUT({ cond: '${{ inputs.a }}' }),
  );
  assert.deepEqual(lintWorkflow('t.yml', src), []);
});

test('an UNGUARDED resolve step covers any guarded checkout', () => {
  // The security tier's real shape: one unconditional resolve serving three
  // checkouts with three different `if:` guards. It always runs, so its output
  // is always populated — flagging it would be a false positive.
  const src = workflow(
    RESOLVE('platform-ref', null) +
      '\n' +
      CHECKOUT({ cond: '${{ inputs.enable-sast }}' }) +
      '\n' +
      CHECKOUT({ cond: "${{ inputs.enable-sast && inputs.semgrep-config == 'vendored' }}" }),
  );
  assert.deepEqual(lintWorkflow('t.yml', src), []);
});

// ---------------------------------------------------------------------------
// Rule 5 — module-graph
// ---------------------------------------------------------------------------

test('a sparse list naming a .mjs script but not scripts/lib/ is rejected', () => {
  // Exactly the uptime-apply shape that took every consumer red.
  const src = workflow(
    RESOLVE('platform-ref', null) +
      '\n' +
      CHECKOUT({ sparse: ['scripts/apply-uptime-monitors.mjs', '.nvmrc'] }),
  );
  const found = lintWorkflow('t.yml', src);
  assert.deepEqual(rules(found), ['module-graph']);
  assert.match(found[0].detail, /scripts\/apply-uptime-monitors\.mjs/);
});

test('adding scripts/lib/ to the same list clears it', () => {
  const src = workflow(
    RESOLVE('platform-ref', null) +
      '\n' +
      CHECKOUT({ sparse: ['scripts/apply-uptime-monitors.mjs', 'scripts/lib/', '.nvmrc'] }),
  );
  assert.deepEqual(lintWorkflow('t.yml', src), []);
});

test('a bare `scripts` entry already covers the whole tree', () => {
  const src = workflow(RESOLVE('platform-ref', null) + '\n' + CHECKOUT({ sparse: ['scripts'] }));
  assert.deepEqual(lintWorkflow('t.yml', src), []);
});

test('a non-.mjs sparse list needs no module graph', () => {
  const src = workflow(
    RESOLVE('platform-ref', null) + '\n' + CHECKOUT({ sparse: ['scripts/resolve-diff-range.sh'] }),
  );
  assert.deepEqual(lintWorkflow('t.yml', src), []);
});

// ---------------------------------------------------------------------------
// Parsing seams
// ---------------------------------------------------------------------------

test('YAML aliases are resolved to the step they stand for', () => {
  // pr-quality.yml reuses `&checkout-range` across five jobs; without anchor
  // expansion the aliasing jobs would look like they had no checkout at all
  // and the lint would pass them vacuously.
  const src = `name: t
on:
  workflow_call:
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - &co
        name: Checkout platform
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          repository: dsj1984/mandrel-platform
          ref: \${{ github.sha }}
  b:
    runs-on: ubuntu-latest
    steps:
      - *co
`;
  const { jobs } = parseWorkflow(src);
  assert.equal(jobs.size, 2);
  const found = lintWorkflow('t.yml', src);
  // Both the anchor site and the alias site are reported, at their own lines.
  assert.deepEqual(rules(found), ['resolved-ref', 'resolved-ref']);
  assert.notEqual(found[0].line, found[1].line);
});

test('sparseEntries reads a block scalar and stops at the next key', () => {
  const text = `      - name: x
        with:
          sparse-checkout: |
            scripts/a.mjs
            scripts/lib/
          sparse-checkout-cone-mode: false
          path: _p
`;
  assert.deepEqual(sparseEntries(text), ['scripts/a.mjs', 'scripts/lib/']);
});

test('stepGuard ignores commented-out if: lines', () => {
  assert.equal(stepGuard('      - name: x\n        # if: ${{ never }}\n        run: true\n'), null);
  assert.equal(stepGuard('      - name: x\n        if: ${{ inputs.a }}\n'), '${{ inputs.a }}');
});

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

test('every shipped workflow passes the lint', () => {
  const findings = [];
  for (const dir of ['.github/workflows', 'templates/workflows']) {
    const abs = join(REPO, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
      findings.push(...lintWorkflow(join(dir, name), readFileSync(join(abs, name), 'utf8')));
    }
  }
  assert.deepEqual(
    findings,
    [],
    `platform-checkout violations:\n${findings.map((f) => `${f.path}:${f.line} [${f.rule}] ${f.detail}`).join('\n')}`,
  );
});

test('every platform checkout in the shipped workflows is actually pinned', () => {
  // Belt-and-braces over the rule engine: assert the resolved shape directly,
  // so a future refactor of the lint cannot quietly stop covering the tree.
  const dir = join(REPO, '.github/workflows');
  let checkouts = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.yml')) continue;
    const src = readFileSync(join(dir, name), 'utf8');
    assert.ok(!src.includes('job_workflow_sha'), `${name} still names the dead OIDC claim`);
    const { jobs } = parseWorkflow(src);
    for (const job of jobs.values()) {
      for (const step of job.steps) {
        if (!step.text.includes('repository: dsj1984/mandrel-platform')) continue;
        checkouts += 1;
        assert.match(
          step.text,
          /ref: \$\{\{ steps\.[A-Za-z0-9_-]+\.outputs\.sha \}\}/,
          `${name}:${step.line} platform checkout is not pinned to a resolve step`,
        );
      }
    }
  }
  assert.ok(checkouts >= 10, `expected the known platform checkouts, saw ${checkouts}`);
});
