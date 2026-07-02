#!/usr/bin/env node
/**
 * check-workflow-portability.test.mjs — node:test suite for the cross-repo
 * portability lint (Story #199).
 *
 * This is the "equivalent self-test" the Story's acceptance criteria call for.
 * It exercises the two blind spots the Story closes, plus the surrounding
 * behavior so the fixes are pinned against regression:
 *
 *   1. Rule 1 now catches the sequence/list form `- uses: ./…` (previously the
 *      leading `- ` slipped past the mapping-only regex), so a local action
 *      referenced inside a workflow_call workflow IS flagged.
 *   2. `on: workflow_call` declared INLINE (bare scalar or flow sequence) is
 *      detected as reusable, so Rules 1 & 2 actually run on it — the former
 *      mapping-only `on.workflow_call` check silently skipped these.
 *
 * Pure exported helpers keep the whole suite offline — no temp dirs, no git.
 *
 * Run: node --test scripts/check-workflow-portability.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  walkYaml,
  isReusableWorkflow,
  checkWorkflowContent,
  checkActionContent,
  parseArgs,
} from "./check-workflow-portability.mjs";

// ---------------------------------------------------------------------------
// isReusableWorkflow — inline vs mapping workflow_call detection
// ---------------------------------------------------------------------------

test("isReusableWorkflow: mapping form (on: > workflow_call:) is reusable", () => {
  const yaml = ["on:", "  workflow_call:", "    inputs:", "      foo:", "        type: string", ""].join("\n");
  assert.equal(isReusableWorkflow(walkYaml(yaml)), true);
});

test("isReusableWorkflow: inline scalar form (on: workflow_call) is reusable", () => {
  const yaml = ["name: reusable", "on: workflow_call", "jobs: {}", ""].join("\n");
  assert.equal(isReusableWorkflow(walkYaml(yaml)), true);
});

test("isReusableWorkflow: inline flow-sequence form (on: [workflow_call]) is reusable", () => {
  const yaml = ["on: [workflow_call]", "jobs: {}", ""].join("\n");
  assert.equal(isReusableWorkflow(walkYaml(yaml)), true);
});

test("isReusableWorkflow: mixed inline flow-sequence (on: [push, workflow_call]) is reusable", () => {
  const yaml = ["on: [push, workflow_call]", "jobs: {}", ""].join("\n");
  assert.equal(isReusableWorkflow(walkYaml(yaml)), true);
});

test("isReusableWorkflow: a plain push-triggered workflow is NOT reusable", () => {
  const yaml = ["on:", "  push:", "    branches: [main]", "jobs: {}", ""].join("\n");
  assert.equal(isReusableWorkflow(walkYaml(yaml)), false);
});

test("isReusableWorkflow: inline scalar `on: push` is NOT reusable (no false positive)", () => {
  const yaml = ["on: push", "jobs: {}", ""].join("\n");
  assert.equal(isReusableWorkflow(walkYaml(yaml)), false);
});

// ---------------------------------------------------------------------------
// Rule 1 — relative `uses: ./…`, both mapping and sequence forms
// ---------------------------------------------------------------------------

test("Rule 1: sequence form `- uses: ./…` inside a workflow_call workflow IS flagged", () => {
  const yaml = [
    "on:",
    "  workflow_call:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: ./.github/actions/foo",
    "",
  ].join("\n");
  const violations = checkWorkflowContent(yaml);
  assert.equal(violations.length, 1, "expected exactly one Rule 1 violation");
  assert.match(violations[0].message, /relative `uses: \.\/` path/);
});

test("Rule 1: mapping form `uses: ./…` is still flagged (no regression)", () => {
  const yaml = [
    "on:",
    "  workflow_call:",
    "jobs:",
    "  build:",
    "    uses: ./.github/workflows/reused.yml",
    "",
  ].join("\n");
  const violations = checkWorkflowContent(yaml);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /relative `uses: \.\/` path/);
});

test("Rule 1: sequence-form relative `uses` combined with INLINE workflow_call IS flagged", () => {
  // Combines both fixes: inline reusable detection + sequence-form catch.
  const yaml = [
    "name: reusable-inline",
    "on: workflow_call",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: ./.github/actions/foo",
    "",
  ].join("\n");
  const violations = checkWorkflowContent(yaml);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /relative `uses: \.\/` path/);
});

test("Rule 1: absolute owner/repo `uses` in a reusable workflow is NOT flagged", () => {
  const yaml = [
    "on: workflow_call",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
  ].join("\n");
  assert.deepEqual(checkWorkflowContent(yaml), []);
});

test("Rule 1: relative `uses` in a NON-reusable workflow is NOT flagged", () => {
  // `./` is portable when the workflow only runs in its own repo.
  const yaml = [
    "on:",
    "  push:",
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: ./.github/actions/foo",
    "",
  ].join("\n");
  assert.deepEqual(checkWorkflowContent(yaml), []);
});

// ---------------------------------------------------------------------------
// Rule 2 — ${{ }} in workflow_call input/secret meta runs on inline form too
// ---------------------------------------------------------------------------

test("Rule 2: still fires on the mapping workflow_call form", () => {
  const yaml = [
    "on:",
    "  workflow_call:",
    "    inputs:",
    "      name:",
    "        description: ${{ runner.os }}",
    "",
  ].join("\n");
  const violations = checkWorkflowContent(yaml);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /expression in workflow_call/);
});

// ---------------------------------------------------------------------------
// checkActionContent — untouched by this Story, guarded against regression
// ---------------------------------------------------------------------------

test("checkActionContent: flags ${{ }} in a composite input default", () => {
  const yaml = [
    "inputs:",
    "  dest:",
    "    default: ${{ runner.temp }}",
    "",
  ].join("\n");
  const violations = checkActionContent(yaml);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /expression in action input/);
});

// ---------------------------------------------------------------------------
// parseArgs — pure option parsing
// ---------------------------------------------------------------------------

test("parseArgs: defaults are pin-check on, no dir overrides, no help", () => {
  assert.deepEqual(parseArgs([]), {
    workflowsDir: null,
    actionsDir: null,
    pinCheck: true,
    help: false,
  });
});

test("parseArgs: --no-pin-check, dir overrides, and --help are parsed", () => {
  assert.deepEqual(parseArgs(["-w", "wf", "--actions-dir", "act", "--no-pin-check", "--help"]), {
    workflowsDir: "wf",
    actionsDir: "act",
    pinCheck: false,
    help: true,
  });
});
