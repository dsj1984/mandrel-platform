#!/usr/bin/env node
/**
 * check-docs-staleness.test.mjs — node:test suite for the docs-staleness lint
 * (Story #197).
 *
 * Focus: the `expired-placeholder` rule. The rule previously hardcoded the
 * years 2020–2024 (`/expires[:\s]+202[0-4]-\d{2}-\d{2}/i`), so an expiry that
 * lapsed in 2025, 2026, or any later year sailed through the gate — a
 * fail-open. The fix broadens the pattern to any 20xx year and defers the
 * "is it actually in the past?" decision to `isExpiredDate`, so the rule stays
 * correct as the calendar advances and never flags a still-valid future date.
 *
 * These tests exercise the year fix directly (`isExpiredDate`) and end-to-end
 * (`lintFile` against a real fixture file), pinning "today" via a fixed clock
 * so they are deterministic.
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
