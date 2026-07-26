#!/usr/bin/env node
/**
 * check-docs-staleness.test.mjs — node:test suite for the docs-staleness lint
 * (Story #197).
 *
 * Focus: rule PRECISION — the two ways a staleness rule stops being useful.
 *
 * 1. Fail-open (`expired-placeholder` under-fires). The rule first hardcoded
 *    the years 2020–2024 (`/expires[:\s]+202[0-4]-\d{2}-\d{2}/i`), so an expiry
 *    that lapsed in 2025 or later sailed through. The fix broadens to any 20xx
 *    year and defers "is it actually in the past?" to `isExpiredDate`, so the
 *    rule stays correct as the calendar advances and never flags a still-valid
 *    future date. A second instance of the same class: the separator required
 *    `expires` to be followed directly by `:` or whitespace, which skipped the
 *    CVE allowlist's own JSON shape (`"expires": "…"`).
 * 2. Fail-noisy (`quality-yml-ref` over-fires). A plain substring match meant
 *    the platform's own `pr-quality.yml` matched, so 58 of 59 findings were
 *    false positives — enough to bury a real error in the same run.
 *
 * These tests exercise the date logic directly (`isExpiredDate`), the compiled
 * patterns, and end-to-end behaviour (`lintFile` against a real fixture file),
 * pinning "today" via a fixed clock so they are deterministic.
 *
 * Run: node --test scripts/check-docs-staleness.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RULES, lintFile, isExpiredDate } from './check-docs-staleness.mjs';

// ---------------------------------------------------------------------------
// isExpiredDate — the year fix, tested directly with a pinned clock.
// ---------------------------------------------------------------------------

// A fixed reference "today" so the tests never depend on the wall clock.
const NOW = new Date('2026-07-02T12:00:00Z');

test('isExpiredDate flags an expiry in the previously-hardcoded window (2020–2024)', () => {
  assert.equal(isExpiredDate('expires: 2020-01-01', NOW), true);
  assert.equal(isExpiredDate('expires: 2024-12-31', NOW), true);
});

test('isExpiredDate flags an expiry in a recent year OUTSIDE the old window (2025, 2026)', () => {
  // These are the exact dates the old 202[0-4] regex missed.
  assert.equal(isExpiredDate('expires: 2025-01-01', NOW), true);
  assert.equal(isExpiredDate('expires: 2025-12-31', NOW), true);
  assert.equal(isExpiredDate('expires: 2026-01-01', NOW), true);
  assert.equal(isExpiredDate('expires: 2026-07-01', NOW), true); // yesterday
});

test('isExpiredDate does NOT flag today or a future expiry', () => {
  assert.equal(isExpiredDate('expires: 2026-07-02', NOW), false); // today
  assert.equal(isExpiredDate('expires: 2026-07-03', NOW), false); // tomorrow
  assert.equal(isExpiredDate('expires: 2027-01-01', NOW), false);
  assert.equal(isExpiredDate('expires: 2099-01-01', NOW), false);
});

test('isExpiredDate returns false for malformed / dateless input', () => {
  assert.equal(isExpiredDate('expires: soon', NOW), false);
  assert.equal(isExpiredDate('', NOW), false);
});

// ---------------------------------------------------------------------------
// RULES wiring — the expired-placeholder pattern now matches any 20xx year.
// ---------------------------------------------------------------------------

test('expired-placeholder pattern matches any 20xx year (not just 2020–2024)', () => {
  const rule = RULES.find((r) => r.id === 'expired-placeholder');
  assert.ok(rule, 'expired-placeholder rule must exist');
  for (const line of [
    'expires: 2024-01-01',
    'expires: 2025-06-15',
    'expires: 2026-01-01',
    'expires: 2031-01-01',
  ]) {
    rule.pattern.lastIndex = 0;
    assert.ok(
      rule.pattern.test(line),
      `pattern should match "${line}"`,
    );
  }
  // A carve-out the fix must preserve: the rule is scoped to 20xx expiry dates.
  rule.pattern.lastIndex = 0;
  assert.equal(rule.pattern.test('expires: 1999-01-01'), false);
});

// ---------------------------------------------------------------------------
// lintFile — end-to-end against a real fixture file.
//
// lintFile's matchFilter uses the real `new Date()` clock, so the fixtures use
// a clearly-past year (2025) and a clearly-future year to stay deterministic
// for any run date at or after mid-2026 (this suite ships in 2026+).
// ---------------------------------------------------------------------------

function withTempDoc(contents, fn) {
  const root = mkdtempSync(join(tmpdir(), 'docs-staleness-'));
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    const file = join(root, 'docs', 'note.md');
    writeFileSync(file, contents);
    return fn(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('lintFile flags an expired 2025 placeholder (missed by the old 2020–2024 rule)', () => {
  withTempDoc('Token rotation.\nexpires: 2025-01-01\nEnd.\n', (file) => {
    const findings = lintFile(file);
    const expired = findings.filter((f) => f.rule.id === 'expired-placeholder');
    assert.equal(expired.length, 1);
    assert.match(expired[0].match, /2025-01-01/);
  });
});

test('lintFile does NOT flag a far-future placeholder', () => {
  withTempDoc('Long-lived.\nexpires: 2099-12-31\nDone.\n', (file) => {
    const findings = lintFile(file);
    const expired = findings.filter((f) => f.rule.id === 'expired-placeholder');
    assert.equal(expired.length, 0);
  });
});

test('lintFile honours the staleness-ignore suppression comment for the year rule', () => {
  withTempDoc(
    '<!-- staleness-ignore: expired-placeholder -->\nexpires: 2025-01-01\n',
    (file) => {
      const findings = lintFile(file);
      const expired = findings.filter((f) => f.rule.id === 'expired-placeholder');
      assert.equal(expired.length, 0);
    },
  );
});

// ---------------------------------------------------------------------------
// expired-placeholder — the JSON-quoted shape.
//
// Second fail-open of the same class as the 202[0-4] year window: the pattern
// required `expires` to be followed directly by `:` or whitespace, so the CVE
// allowlist's own JSON shape (`"expires": "2026-12-31"`, per audit-check.mjs)
// never matched — `expires"` is neither. Every documented allowlist entry was
// therefore invisible to the gate, including a lapsed one in
// docs/runbooks/dependency-update.md.
// ---------------------------------------------------------------------------

test('expired-placeholder matches the JSON-quoted allowlist shape', () => {
  const rule = RULES.find((r) => r.id === 'expired-placeholder');
  for (const line of [
    '  "expires": "2025-12-31",', // the CVE allowlist's real shape
    "  'expires': '2025-12-31',", // single-quoted (YAML/JS)
    '  expires: "2025-12-31"', // quoted value, bare key
  ]) {
    rule.pattern.lastIndex = 0;
    assert.ok(rule.pattern.test(line), `pattern should match ${JSON.stringify(line)}`);
  }
});

test('expired-placeholder still matches the unquoted shapes (no regression)', () => {
  const rule = RULES.find((r) => r.id === 'expired-placeholder');
  for (const line of [
    'expires: 2025-01-01',
    '# CVE-2022-3517 — expires 2025-06-01',
  ]) {
    rule.pattern.lastIndex = 0;
    assert.ok(rule.pattern.test(line), `pattern should match ${JSON.stringify(line)}`);
  }
});

test('lintFile flags a lapsed JSON-quoted expiry end-to-end', () => {
  withTempDoc('Allowlist entry.\n  "expires": "2025-12-31",\nEnd.\n', (file) => {
    const expired = lintFile(file).filter((f) => f.rule.id === 'expired-placeholder');
    assert.equal(expired.length, 1);
    assert.match(expired[0].match, /2025-12-31/);
  });
});

test('lintFile does NOT flag a future JSON-quoted expiry', () => {
  withTempDoc('Allowlist entry.\n  "expires": "2099-12-31",\nEnd.\n', (file) => {
    const expired = lintFile(file).filter((f) => f.rule.id === 'expired-placeholder');
    assert.equal(expired.length, 0);
  });
});

test('lintFile does NOT flag a placeholder expiry token', () => {
  // The runbooks intentionally use `<YYYY-MM-DD>` rather than a concrete date,
  // precisely so an example can never lapse into a finding.
  withTempDoc('Allowlist entry.\n  "expires": "<YYYY-MM-DD>",\nEnd.\n', (file) => {
    const expired = lintFile(file).filter((f) => f.rule.id === 'expired-placeholder');
    assert.equal(expired.length, 0);
  });
});

// ---------------------------------------------------------------------------
// quality-yml-ref — bare filename only.
//
// The pattern was a plain substring match, so the platform's own
// `pr-quality.yml` matched: 58 of 59 findings against mandrel-platform's docs
// were that false positive, burying a real `expired-placeholder` error. The
// assertion below is on the invariant (a `<prefix>-quality.yml` is a different
// file) rather than on the single `pr-` spelling that motivated it.
// ---------------------------------------------------------------------------

test('quality-yml-ref does NOT match a prefixed <prefix>-quality.yml', () => {
  const rule = RULES.find((r) => r.id === 'quality-yml-ref');
  assert.ok(rule, 'quality-yml-ref rule must exist');
  for (const line of [
    'uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@abc123',
    'the `pr-quality.yml` reusable workflow',
    'a consumer that names its caller `ci-quality.yml`',
    'see my_quality.yml for details',
  ]) {
    rule.pattern.lastIndex = 0;
    assert.equal(
      rule.pattern.test(line),
      false,
      `pattern must not match ${JSON.stringify(line)}`,
    );
  }
});

test('quality-yml-ref still matches a bare quality.yml reference', () => {
  const rule = RULES.find((r) => r.id === 'quality-yml-ref');
  for (const line of [
    "| athportal | `quality.yml` | `quality` |",
    'the quality.yml workflow was renamed',
    'quality.yml',
  ]) {
    rule.pattern.lastIndex = 0;
    assert.ok(rule.pattern.test(line), `pattern should match ${JSON.stringify(line)}`);
  }
});
