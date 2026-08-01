#!/usr/bin/env node
/**
 * yaml-step.test.mjs — node:test suite for the shared YAML step extractor
 * (Story #377).
 *
 * These two helpers decide WHICH BYTES five other suites execute, so they are
 * the one piece of test infrastructure in this repository that needs tests of
 * its own: a silent mis-extraction hands every caller a different script than
 * the one under review, and every caller still reports green.
 *
 * The cases below are therefore about the boundaries — where a step block
 * ends, where a block scalar ends, and what happens when the lookup misses —
 * not about the happy path the callers already cover.
 *
 * Run: node --test scripts/lib/yaml-step.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { stepByName, runScript } from "./yaml-step.mjs";

/**
 * A workflow fragment with the shapes that matter: two sibling steps, a nested
 * `with:` mapping, a `run: |` block scalar containing a blank line and its own
 * deeper indentation, and a following job key at a shallower indent.
 */
const WORKFLOW = [
  "jobs:",
  "  build:",
  "    steps:",
  "      - name: Checkout",
  "        uses: actions/checkout@v4",
  "        with:",
  "          fetch-depth: 0",
  "",
  "      - name: Run the thing",
  "        env:",
  "          MODE: strict",
  "        run: |",
  "          set -eu",
  '          if [ "$MODE" = strict ]; then',
  '            echo "strict"',
  "          fi",
  "",
  '          echo "done"',
  "",
  "      - name: After",
  '        run: echo "after"',
  "",
  "  publish:",
  "    steps:",
  "      - name: Checkout",
  "        uses: actions/checkout@v4",
].join("\n");

// ---------------------------------------------------------------------------
// stepByName
// ---------------------------------------------------------------------------

test("stepByName returns the step from its bullet to the next sibling bullet", () => {
  const block = stepByName(WORKFLOW, "Run the thing");

  assert.match(block, /^\s+- name: Run the thing$/m);
  assert.match(block, /MODE: strict/, "the step's own nested mapping is included");
  assert.doesNotMatch(block, /name: After/, "the following sibling step is not included");
  assert.doesNotMatch(block, /name: Checkout/, "the preceding sibling step is not included");
});

test("stepByName keeps a nested mapping and stops at the following dedent", () => {
  // `Checkout` under `publish:` is the LAST step in the document, so its block
  // is terminated by end-of-input rather than by a sibling — the case a reader
  // that requires a following bullet silently returns nothing for.
  const block = stepByName(WORKFLOW, "After");

  assert.match(block, /- name: After/);
  assert.match(block, /run: echo "after"/);
  assert.doesNotMatch(block, /publish:/, "the next job key is below the bullet indent");
});

test("stepByName matches on a substring of the name, first occurrence wins", () => {
  const block = stepByName(WORKFLOW, "Checkout");

  assert.match(block, /fetch-depth: 0/, "the build job's Checkout is the first match");
});

test("stepByName throws naming the step when no step name contains the needle", () => {
  assert.throws(
    () => stepByName(WORKFLOW, "Deploy to production"),
    /step "Deploy to production" not found/,
    "a lookup miss must fail loudly rather than degrade to an empty block"
  );
});

test("stepByName throws when a matching name has no opening bullet above it", () => {
  const noBullet = ["runs:", "  steps:", "    name: Orphan", "    run: echo hi"].join("\n");

  assert.throws(() => stepByName(noBullet, "Orphan"), /opening bullet for step "Orphan" not found/);
});

// ---------------------------------------------------------------------------
// runScript
// ---------------------------------------------------------------------------

test("runScript dedents a `run: |` block scalar and preserves its inner shape", () => {
  const body = runScript(stepByName(WORKFLOW, "Run the thing"));

  assert.equal(
    body,
    [
      "set -eu",
      'if [ "$MODE" = strict ]; then',
      '  echo "strict"',
      "fi",
      "",
      'echo "done"',
      // The blank line separating this step from the next survives as a
      // trailing newline. Harmless in a shell script, and dropping it would
      // shift every line number after it out of sync with the workflow.
      "",
    ].join("\n")
  );
});

test("runScript keeps blank lines rather than collapsing them", () => {
  // Line numbers in the extracted script must still line up with the workflow,
  // otherwise a `bash -x` trace of the executed body is unreadable against the
  // source it came from.
  const body = runScript(stepByName(WORKFLOW, "Run the thing"));

  assert.equal(body.split("\n")[4], "", "the blank line inside the scalar survives");
});

test("runScript stops at the end of the block scalar, not the end of the step", () => {
  const trailingKeys = [
    "      - name: Scoped",
    "        run: |",
    '          echo "body"',
    "        shell: bash",
    "        continue-on-error: true",
  ].join("\n");

  assert.equal(runScript(stepByName(trailingKeys, "Scoped")), 'echo "body"');
});

test("runScript throws when the step has no `run: |` block scalar", () => {
  // A single-line `run:` is a different shape; extracting it as a block scalar
  // would hand the caller an empty script that passes every assertion made
  // against it.
  assert.throws(
    () => runScript(stepByName(WORKFLOW, "After")),
    /`run: \|` block not found/,
    "a single-line `run:` is not a block scalar"
  );
  assert.throws(() => runScript(stepByName(WORKFLOW, "Checkout")), /`run: \|` block not found/);
});
