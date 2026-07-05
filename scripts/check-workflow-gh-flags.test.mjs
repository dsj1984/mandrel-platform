import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseContinuations,
  splitSegments,
  lintSegment,
  lintFile,
} from './check-workflow-gh-flags.mjs';

test('collapseContinuations joins backslash-continued lines and keeps start line', () => {
  const src = ['a=1', 'state="$(gh api --slurp x \\', '  --jq y \\', '  || echo none)"', 'b=2'].join(
    '\n',
  );
  const logical = collapseContinuations(src);
  const joined = logical.find((l) => l.text.includes('gh api'));
  assert.equal(joined.line, 2, 'start line is the first line of the command');
  assert.match(joined.text, /gh api --slurp x\s+--jq y\s+\|\| echo none/);
});

test('lintSegment flags gh --slurp with --jq (the 0.25.0 regression)', () => {
  const v = lintSegment('gh api --paginate --slurp "repos/x/commits/y/status" --jq \'.a\'');
  assert.equal(v.length, 1);
  assert.match(v[0], /slurp-with-jq/);
});

test('lintSegment flags gh --slurp with --template / -t', () => {
  assert.equal(lintSegment('gh api --slurp x --template "{{.a}}"').length, 1);
  assert.equal(lintSegment('gh api --slurp x -t "{{.a}}"').length, 1);
});

test('lintSegment does NOT flag the SUPPORTED pattern (slurp piped to standalone jq)', () => {
  // The pipe splits this into two segments upstream; each segment alone is clean.
  assert.equal(lintSegment('gh api --paginate --slurp "…/status"').length, 0);
  assert.equal(lintSegment(" jq -r '[.[].statuses[]] | first.state'").length, 0);
});

test('lintSegment ignores non-gh commands and plain gh usage', () => {
  assert.equal(lintSegment('jq --slurp --jq nonsense').length, 0, 'not a gh command');
  assert.equal(lintSegment('gh api "repos/x" --jq .a').length, 0, 'jq without slurp is fine');
  assert.equal(lintSegment('gh api --slurp x').length, 0, 'slurp without jq is fine');
});

test('splitSegments separates a gh|jq pipe so the supported pattern is not flagged end-to-end', () => {
  const cmd =
    'state="$(gh api --paginate --slurp "repos/x/commits/y/status" | jq -r \'.a\' || echo none)"';
  const segs = splitSegments(cmd);
  const flagged = segs.flatMap((s) => lintSegment(s));
  assert.equal(flagged.length, 0, 'gh segment has slurp-no-jq; jq segment is not gh');
});

test('lintFile flags the invalid combo across continuation lines', () => {
  const src = [
    'jobs:',
    '  x:',
    '    steps:',
    '      - run: |',
    '          state="$(gh api --slurp "u" \\',
    "            --jq '.a' \\",
    '            || echo none)"',
  ].join('\n');
  const findings = lintFile('.github/workflows/fake.yml', src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5, 'points at the line the gh command starts on');
  assert.match(findings[0].rule, /slurp-with-jq/);
});

test('lintFile ignores COMMENTS that merely document the invalid combo (false-positive guard)', () => {
  // A step comment describing the rule — must NOT be flagged (regression: this
  // exact false positive failed CI on the guard's own PR).
  const src = [
    '      # Catches gh flag combos like --slurp with --jq that fail at runtime.',
    '      - name: Lint gh CLI flag combinations',
    '        run: node scripts/check-workflow-gh-flags.mjs',
  ].join('\n');
  assert.deepEqual(lintFile('.github/workflows/ci.yml', src), []);
});

test('lintFile is clean for the corrected release-please pattern', () => {
  const src = [
    '      - run: |',
    '          state="$(gh api --paginate --slurp "u" 2>/dev/null \\',
    "            | jq -r '[.[].statuses[]] | first.state' \\",
    '            || echo none)"',
  ].join('\n');
  assert.deepEqual(lintFile('.github/workflows/ok.yml', src), []);
});
