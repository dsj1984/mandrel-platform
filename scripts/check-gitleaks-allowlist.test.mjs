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

import { stepByName, runScript } from "./lib/yaml-step.mjs";

const ACTION = ".github/actions/gitleaks-scan/action.yml";
const WORKFLOW = ".github/workflows/pr-quality.yml";

const actionText = readFileSync(ACTION, "utf8");
const workflowText = readFileSync(WORKFLOW, "utf8");
const scanScript = runScript(stepByName(actionText, "Run gitleaks scan"));

/**
 * The definition block of a single `workflow_call` input, keyed by name: every
 * line indented under the `      <name>:` key. Asserts rather than returning a
 * sentinel, so a renamed input fails at the point of extraction instead of
 * silently passing an empty block to every downstream matcher.
 */
function workflowInput(name) {
  const lines = workflowText.split("\n");
  const start = lines.indexOf(`      ${name}:`);
  assert.notEqual(start, -1, `workflow_call input "${name}" is not declared`);
  const body = [];
  for (let i = start + 1; i < lines.length && /^ {8,}\S/.test(lines[i]); i++) {
    body.push(lines[i]);
  }
  return body.join("\n");
}

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

test("AC-8: useDefault must sit in [extend], not merely appear in the file", () => {
  // The guard's one remaining bypass if it were a bare grep: gitleaks reads
  // useDefault only from the [extend] table, so the same line under [[rules]]
  // is inert — a rule-replacing config that reads as if it extended.
  const { status, output } = runScan({
    files: {
      ".gitleaks.toml": ["[[rules]]", 'id = "only-mine"', "useDefault = true"].join("\n"),
    },
    CONFIG_PATH: ".gitleaks.toml",
  });
  assert.equal(status, 1);
  assert.match(output, /must extend the default ruleset/);
  assert.doesNotMatch(output, /GITLEAKS_ARGV/, "gitleaks must not run on a rejected config");
});

test("AC-7: [extend] is still honoured when other tables follow it", () => {
  const { status, output } = runScan({
    files: {
      ".gitleaks.toml": [
        "[extend]",
        "useDefault = true",
        "",
        "[[allowlists]]",
        'description = "prose"',
      ].join("\n"),
    },
    CONFIG_PATH: ".gitleaks.toml",
  });
  assert.equal(status, 0);
  assert.match(output, /--config \.gitleaks\.toml/);
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

test("AC-3: a repo-root .gitleaks.toml is validated instead of silently auto-discovered", () => {
  // gitleaks reads a repo-root .gitleaks.toml on its own whenever --config is
  // absent. Left alone, that is a second, UNVALIDATED way into the scan — the
  // useDefault guard never runs. The file is adopted as config-path instead.
  const { status, output } = runScan({
    files: { ".gitleaks.toml": EXTENDING_CONFIG },
  });
  assert.equal(status, 0);
  assert.match(output, /--config \.gitleaks\.toml/);
});

test("AC-3: a rule-replacing repo-root .gitleaks.toml is rejected, naming config-path", () => {
  // The bypass this closes. Auto-discovery would have applied this config —
  // which deletes every default rule — and reported green.
  const { status, output } = runScan({
    files: { ".gitleaks.toml": '[[rules]]\nid = "only-mine"\n' },
  });
  assert.equal(status, 1);
  assert.match(output, /must extend the default ruleset/);
  assert.match(output, /config-path/);
  assert.doesNotMatch(output, /GITLEAKS_ARGV/, "gitleaks must not run on a rejected config");
});

// Not AC-3 evidence: this passes with the discovery branch reverted, because
// nothing ever routed a root file when config-path was set. It is a regression
// guard for one plausible mis-write of that branch — omitting its `[ -z
// "$CONFIG_PATH" ]` condition — and should not be read as proving AC-3.
test("an explicit config-path still wins over a repo-root .gitleaks.toml", () => {
  const { status, output } = runScan({
    files: { ".gitleaks.toml": EXTENDING_CONFIG, "custom.toml": EXTENDING_CONFIG },
    CONFIG_PATH: "custom.toml",
  });
  assert.equal(status, 0);
  assert.match(output, /--config custom\.toml/);
  assert.doesNotMatch(output, /--config \.gitleaks\.toml/);
});

test("AC-3: a deliberate rule-replacing root config still opts in explicitly", () => {
  const { status, output } = runScan({
    files: { ".gitleaks.toml": '[[rules]]\nid = "only-mine"\n' },
    ALLOW_RULE_REPLACEMENT: "true",
  });
  assert.equal(status, 0);
  assert.match(output, /--config \.gitleaks\.toml/);
});

test("AC-1: pr-quality.yml declares both allowlist inputs with unchanged-behaviour defaults", () => {
  // pr-quality.yml is compile-time resolved for every consumer, so a caller
  // that passes neither input must get byte-identical behaviour: '' and
  // 'false' are exactly the composite's own defaults.
  const configPath = workflowInput("secret-scan-config-path");
  assert.match(configPath, /^ {8}type: string$/m);
  assert.match(configPath, /^ {8}default: ''$/m);

  const allowReplacement = workflowInput("secret-scan-allow-default-rule-replacement");
  assert.match(allowReplacement, /^ {8}type: string$/m);
  assert.match(allowReplacement, /^ {8}default: 'false'$/m);

  // Cross-repo portability contract (scripts/check-workflow-portability.mjs):
  // no `${{ }}` in a workflow_call input description or default — GitHub
  // resolves those during interface validation, before any context exists.
  assert.doesNotMatch(configPath, /\$\{\{/);
  assert.doesNotMatch(allowReplacement, /\$\{\{/);
});

test("AC-2: both caller inputs reach the gitleaks composite's own inputs", () => {
  // The whole point of the Story: an input a consumer can set has to arrive at
  // the composite, or the documented escape from a false positive is
  // unreachable and `enable-security: false` stays the only exit.
  const step = stepByName(workflowText, "Secret scan (pinned gitleaks, blocking)");
  assert.match(step, /^\s+config-path: \$\{\{ inputs\.secret-scan-config-path \}\}$/m);
  assert.match(
    step,
    /^\s+allow-default-rule-replacement: \$\{\{ inputs\.secret-scan-allow-default-rule-replacement \}\}$/m,
  );
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
