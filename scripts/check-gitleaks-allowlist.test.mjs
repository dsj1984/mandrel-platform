#!/usr/bin/env node
/**
 * check-gitleaks-allowlist.test.mjs — the secret-scan tier's escape hatch
 * (Story #365).
 *
 * The failure this closes: the secret scan exposed no seam for suppressing a
 * known false positive, so ordinary prose matching the generic-secret
 * heuristic blocked a docs-only pull request with no option but rewording the
 * source or turning the tier off. A required check needs an escape that is not
 * disabling it.
 *
 * Reading the YAML is not enough: what decides the outcome is a shell branch,
 * and the failure mode is silent — a caller-supplied config that quietly
 * REPLACES the default ruleset would turn one suppression into a tier-wide
 * opt-out that still reports green. So this extracts the real `run:` body and
 * executes it against a stub gitleaks that echoes its argv, the same
 * read-then-execute approach as check-setup-toolchain-store.test.mjs.
 *
 * Run: node --test scripts/check-gitleaks-allowlist.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ACTION = ".github/actions/gitleaks-scan/action.yml";

// Minimal indentation-based extraction (dependency-free, mirrors
// check-setup-toolchain-store.test.mjs / check-osv-scan-mode.test.mjs).
// ---------------------------------------------------------------------------

function stepByName(text, name) {
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

/** The dedented body of a step's `run: |` block scalar. */
function runScript(stepBlock) {
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

const actionText = readFileSync(ACTION, "utf8");
const scanScript = runScript(stepByName(actionText, "Run gitleaks scan"));

/**
 * Run the extracted scan body against a stub gitleaks that echoes its argv and
 * exits `leakExit` (non-zero = a finding). Returns `{ status, output }` rather
 * than throwing, because a non-zero exit IS the assertion in the blocking
 * cases.
 */
function runScan({ files = {}, leakExit = 0, ...env } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gitleaks-allowlist-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), contents);
    }
    const stub = path.join(dir, "gitleaks-stub");
    writeFileSync(stub, `#!/bin/sh\necho "GITLEAKS_ARGV: $*"\nexit ${leakExit}\n`);
    chmodSync(stub, 0o755);
    const script = path.join(dir, "scan.sh");
    writeFileSync(script, scanScript);

    try {
      const output = execFileSync("bash", [script], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          GITLEAKS_BIN: stub,
          SCAN_MODE: "dir",
          LOG_OPTS: "",
          REDACT: "100",
          VERBOSE: "false",
          REPORT_FORMAT: "",
          REPORT_PATH: "",
          NON_BLOCKING: "false",
          CONFIG_PATH: "",
          ALLOW_RULE_REPLACEMENT: "false",
          ...env,
        },
      });
      return { status: 0, output };
    } catch (err) {
      return {
        status: err.status ?? 1,
        output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXTENDING_CONFIG = ['[extend]', 'useDefault = true', '', '[[rules]]', 'id = "x"'].join("\n");

test("no config-path leaves the scan byte-for-byte as it was", () => {
  const { status, output } = runScan();
  assert.equal(status, 0);
  assert.doesNotMatch(output, /--config/);
  assert.match(output, /--redact=100/);
});

test("AC-7: a caller-supplied allowlist config is passed to gitleaks as --config", () => {
  const { status, output } = runScan({
    files: { ".gitleaks.toml": EXTENDING_CONFIG },
    CONFIG_PATH: ".gitleaks.toml",
  });
  assert.equal(status, 0);
  assert.match(output, /--config \.gitleaks\.toml/);
  // The tier is still on: redaction and the scan itself are unchanged.
  assert.match(output, /--redact=100/);
});

test("AC-7: the suppression seam works without disabling the tier or rewording the source", () => {
  // The docs-only PR case: a config that allowlists the one false positive,
  // scanned in the same blocking mode, with the source untouched.
  const { status, output } = runScan({
    files: {
      ".gitleaks.toml": [
        "[extend]",
        "useDefault = true",
        "",
        "[[allowlists]]",
        'description = "prose in docs/reusable-workflows.md"',
        'paths = ["docs/reusable-workflows\\\\.md"]',
      ].join("\n"),
    },
    CONFIG_PATH: ".gitleaks.toml",
  });
  assert.equal(status, 0);
  assert.match(output, /--config \.gitleaks\.toml/);
  assert.doesNotMatch(output, /non-blocking/);
});

test("AC-8: with a config in place, any other finding still fails the step", () => {
  // The load-bearing half. An allowlist narrows one rule; it must not turn the
  // gate into a reporter. A leak (stub exit 1) fails the step exactly as it
  // does with no config at all.
  const withConfig = runScan({
    files: { ".gitleaks.toml": EXTENDING_CONFIG },
    CONFIG_PATH: ".gitleaks.toml",
    leakExit: 1,
  });
  assert.notEqual(withConfig.status, 0, "a finding must still fail the step");

  const withoutConfig = runScan({ leakExit: 1 });
  assert.equal(withConfig.status, withoutConfig.status);
});

test("AC-8: a config that replaces the default ruleset is rejected", () => {
  // Without this guard, `--config` is a supported way to delete every rule and
  // still report green — a tier-wide opt-out wearing an allowlist's clothes.
  const { status, output } = runScan({
    files: { ".gitleaks.toml": '[[rules]]\nid = "only-mine"\n' },
    CONFIG_PATH: ".gitleaks.toml",
  });
  assert.equal(status, 1);
  assert.match(output, /must extend the default ruleset/);
  assert.match(output, /useDefault = true/);
  assert.doesNotMatch(output, /GITLEAKS_ARGV/, "gitleaks must not run on a rejected config");
});

test("a deliberate full rule-set replacement is possible, but only explicitly", () => {
  const { status, output } = runScan({
    files: { ".gitleaks.toml": '[[rules]]\nid = "only-mine"\n' },
    CONFIG_PATH: ".gitleaks.toml",
    ALLOW_RULE_REPLACEMENT: "true",
  });
  assert.equal(status, 0);
  assert.match(output, /--config \.gitleaks\.toml/);
});

test("a config-path that does not exist is a hard error, not a silently-skipped flag", () => {
  const { status, output } = runScan({ CONFIG_PATH: "nope.toml" });
  assert.equal(status, 1);
  assert.match(output, /does not exist in the checkout/);
  assert.doesNotMatch(output, /GITLEAKS_ARGV/);
});

test("the action declares both inputs with the non-breaking empty/false defaults", () => {
  // A consumer that passes neither input must be unaffected — the whole reason
  // the defaults are '' and 'false'.
  assert.match(actionText, /^ {2}config-path:$/m);
  assert.match(actionText, /^ {2}allow-default-rule-replacement:$/m);
  // Cross-repo portability contract: no `${{ }}` in input descriptions or
  // defaults (scripts/check-workflow-portability.mjs).
  const inputsBlock = actionText.slice(
    actionText.indexOf("\ninputs:"),
    actionText.indexOf("\nruns:"),
  );
  assert.doesNotMatch(inputsBlock, /\$\{\{/);
});
