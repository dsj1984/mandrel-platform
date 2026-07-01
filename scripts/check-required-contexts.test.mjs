#!/usr/bin/env node
/**
 * check-required-contexts.test.mjs — node:test suite for the canonical
 * CI-caller-naming lint added to check-required-contexts.mjs (Story #173).
 *
 * The pre-existing phantom-context checker is exercised end-to-end via the
 * CLI (see docs/reusable-workflows.md § "Canonical caller naming" for the
 * target shape this lint nudges consumers toward). This suite covers the
 * three pure functions the naming lint adds: `extractWorkflowName`,
 * `extractJobIds` (pre-existing, re-exercised for the new call sites), and
 * `warnOnNonCanonicalCallerNaming` — all offline, no filesystem beyond a
 * scratch temp dir for the workflows-dir fixture.
 *
 * Run: node scripts/check-required-contexts.test.mjs  (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANONICAL_CALLER,
  extractJobIds,
  extractWorkflowName,
  warnOnNonCanonicalCallerNaming,
} from "./check-required-contexts.mjs";

// ── extractWorkflowName ─────────────────────────────────────────────────────

test("extractWorkflowName: reads the top-level `name:` key", () => {
  const yaml = `name: CI\n\non:\n  pull_request:\n    branches: [main]\n\njobs:\n  ci:\n    runs-on: ubuntu-latest\n`;
  assert.equal(extractWorkflowName(yaml), "CI");
});

test("extractWorkflowName: strips surrounding quotes", () => {
  assert.equal(extractWorkflowName('name: "CI (PR)"\non:\n'), "CI (PR)");
  assert.equal(extractWorkflowName("name: 'quality'\non:\n"), "quality");
});

test("extractWorkflowName: returns null when no top-level name: is present", () => {
  const yaml = `on:\n  push:\n    branches: [main]\njobs:\n  build:\n    name: Build\n`;
  assert.equal(extractWorkflowName(yaml), null);
});

test("extractWorkflowName: does not mistake a job-level name: for the workflow name", () => {
  const yaml = `on:\n  push:\njobs:\n  build:\n    name: Build job display name\n`;
  assert.equal(extractWorkflowName(yaml), null);
});

// ── extractJobIds (pre-existing behaviour, re-exercised for the new caller) ─

test("extractJobIds: finds the canonical `ci` job id", () => {
  const yaml = `name: CI\non:\n  pull_request:\njobs:\n  ci:\n    uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@sha\n  ci-required:\n    needs: [ci]\n`;
  const ids = extractJobIds(yaml);
  assert.ok(ids.has("ci"));
  assert.ok(ids.has("ci-required"));
});

// ── warnOnNonCanonicalCallerNaming ──────────────────────────────────────────

function withTempWorkflowsDir(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "check-required-contexts-test-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, "utf8");
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("warnOnNonCanonicalCallerNaming: no warnings for the fully canonical shape", () => {
  withTempWorkflowsDir(
    {
      "ci.yml": `name: CI\non:\n  pull_request:\njobs:\n  ci:\n    uses: dsj1984/mandrel-platform/.github/workflows/pr-quality.yml@sha\n  ci-required:\n    needs: [ci]\n`,
    },
    (dir) => {
      const workflowFiles = ["ci.yml"];
      const workflowJobMap = new Map([["ci.yml", extractJobIds(
        `name: CI\non:\n  pull_request:\njobs:\n  ci:\n    uses: x\n  ci-required:\n    needs: [ci]\n`
      )]]);
      const warnings = warnOnNonCanonicalCallerNaming(workflowFiles, workflowJobMap, dir);
      assert.deepEqual(warnings, []);
    }
  );
});

test("warnOnNonCanonicalCallerNaming: warns (does not throw) when the caller file is missing", () => {
  withTempWorkflowsDir({ "quality.yml": "name: quality\non:\njobs:\n  quality:\n" }, (dir) => {
    const workflowFiles = ["quality.yml"];
    const workflowJobMap = new Map([["quality.yml", new Set(["quality"])]]);
    const warnings = warnOnNonCanonicalCallerNaming(workflowFiles, workflowJobMap, dir);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`no "${CANONICAL_CALLER.file}" file found`));
  });
});

test("warnOnNonCanonicalCallerNaming: warns on a non-canonical display name (athportal shape)", () => {
  withTempWorkflowsDir(
    { "ci.yml": `name: quality\non:\njobs:\n  ci:\n    uses: x\n` },
    (dir) => {
      const workflowFiles = ["ci.yml"];
      const workflowJobMap = new Map([["ci.yml", new Set(["ci"])]]);
      const warnings = warnOnNonCanonicalCallerNaming(workflowFiles, workflowJobMap, dir);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /display name is "quality"/);
    }
  );
});

test("warnOnNonCanonicalCallerNaming: warns on a non-canonical job id (swarm-os shape)", () => {
  withTempWorkflowsDir(
    { "ci.yml": `name: CI\non:\njobs:\n  quality:\n    uses: x\n  ci-required:\n    needs: [quality]\n` },
    (dir) => {
      const workflowFiles = ["ci.yml"];
      const workflowJobMap = new Map([["ci.yml", new Set(["quality", "ci-required"])]]);
      const warnings = warnOnNonCanonicalCallerNaming(workflowFiles, workflowJobMap, dir);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /has no "ci" job id/);
    }
  );
});

test("warnOnNonCanonicalCallerNaming: warns on both display name and job id together", () => {
  withTempWorkflowsDir(
    { "ci.yml": `name: CI (PR)\non:\njobs:\n  build:\n    uses: x\n` },
    (dir) => {
      const workflowFiles = ["ci.yml"];
      const workflowJobMap = new Map([["ci.yml", new Set(["build"])]]);
      const warnings = warnOnNonCanonicalCallerNaming(workflowFiles, workflowJobMap, dir);
      assert.equal(warnings.length, 2);
    }
  );
});
