/**
 * scripts/lib/yaml-step.mjs
 *
 * The single indentation-based YAML step extractor shared by the workflow and
 * composite-action test suites under `scripts/` (Story #377).
 *
 * ## Why this is a shared module and not five copies
 *
 * Several suites in this repository do not merely READ a workflow — they pull
 * the real `run:` body out of a named step and execute it against a stubbed
 * binary, because what decides the outcome is a shell branch rather than the
 * YAML around it. That read-then-execute pattern needs exactly two helpers,
 * and they had been copy-pasted verbatim into five test files
 * (check-affected-mode, check-environments-isolation-audit,
 * check-gitleaks-allowlist, check-osv-scan-mode, check-setup-toolchain-store).
 *
 * The duplication was not cosmetic. These helpers decide WHICH BYTES each
 * suite executes, so a copy that drifts and silently extracts the wrong block
 * asserts against different text and still reports green — the same
 * runs-but-verifies-nothing failure the suites themselves exist to prevent.
 * One definition means a drift is a change to one file that every caller sees.
 *
 * ## Deliberately dependency-free, and deliberately test-only
 *
 * There is no YAML parser in this repository's dependency graph, by design:
 * the guardrail scripts consumers copy into their CI must run on a bare Node
 * runtime with no package install. So this is a line-oriented indentation
 * reader, not a parser. It handles the two shapes the suites actually use — a
 * `- name:`-keyed step block, and a `run: |` block scalar — and nothing else.
 *
 * Both helpers `assert` internally rather than returning a sentinel: a step
 * name that no longer resolves is a test-authoring fault that must fail loudly
 * at the point of extraction, not silently degrade into an empty script that
 * passes every downstream assertion. That is why this module imports
 * `node:assert/strict`, which is acceptable here because this is a TEST-ONLY
 * lib module — nothing under `scripts/*.mjs` that runs in CI imports it.
 */

import assert from "node:assert/strict";

/**
 * Extract the text of a single step, keyed by a substring of its `name:`.
 *
 * A step spans from its `- ` bullet to the next sibling bullet at the same
 * indent (or to the first dedent below it), so nested `with:` / `env:` mappings
 * come along and a following step never does.
 *
 * @param {string} text  Workflow or composite-action YAML.
 * @param {string} name  A substring of the target step's `name:` value.
 * @returns {string} The step block, newline-joined, including its `- ` bullet.
 * @throws {assert.AssertionError} When no step name contains `name`.
 */
export function stepByName(text, name) {
  const lines = text.split("\n");
  const nameIdx = lines.findIndex((l) => /^\s+(- )?name:\s/.test(l) && l.includes(name));
  assert.notEqual(nameIdx, -1, `step "${name}" not found`);
  let start = -1;
  for (let i = nameIdx; i >= 0; i--) {
    if (/^\s*-\s/.test(lines[i])) {
      start = i;
      break;
    }
  }
  assert.notEqual(start, -1, `opening bullet for step "${name}" not found`);
  const bulletIndent = lines[start].match(/^(\s*)/)[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (indent < bulletIndent) {
      end = i;
      break;
    }
    if (indent === bulletIndent && /^\s*-\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * The dedented body of a step's `run: |` block scalar.
 *
 * Blank lines are preserved as empty lines rather than skipped, so line numbers
 * inside the extracted script still line up with the workflow — which is what
 * makes a `bash -x` trace of the executed body readable against the source.
 *
 * @param {string} stepBlock  A step block, typically from {@link stepByName}.
 * @returns {string} The `run:` body with the block-scalar indent removed.
 * @throws {assert.AssertionError} When the step has no `run: |` block scalar.
 */
export function runScript(stepBlock) {
  const lines = stepBlock.split("\n");
  const start = lines.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l));
  assert.notEqual(start, -1, "`run: |` block not found");
  const runIndent = lines[start].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) {
      body.push("");
      continue;
    }
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (indent <= runIndent) break;
    body.push(lines[i].slice(runIndent + 2));
  }
  return body.join("\n");
}
