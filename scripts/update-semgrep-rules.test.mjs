#!/usr/bin/env node
/**
 * update-semgrep-rules.test.mjs — node:test suite for the SAST ruleset
 * vendoring script that backs `pr-quality.yml`'s `semgrep-config: 'vendored'`
 * default (Story #132).
 *
 * The pure pieces — language filtering and deterministic sort — are
 * exercised offline via an injected `resolve` function, so the suite never
 * shells out to `pip`/`semgrep` or calls the live registry. The actual
 * network-dependent resolution path (`resolveRegistryRules`) is a deliberate
 * operator action (`node scripts/update-semgrep-rules.mjs`), not something
 * CI re-runs on every PR — see the module doc in update-semgrep-rules.mjs.
 *
 * Run: node scripts/update-semgrep-rules.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildVendoredRuleset } from "./update-semgrep-rules.mjs";

function rule(id, languages) {
  return { id, languages, message: "m", severity: "ERROR", metadata: {} };
}

const FIXTURE_RULES = [
  rule("python.eval.exec-injection", ["python"]),
  rule("yaml.github-actions.security.secrets-inherit.secrets-inherit", ["yaml"]),
  rule("package_managers.pnpm.pnpm-trust-policy.pnpm-trust-policy", ["yaml"]),
  rule("javascript.lang.security.audit.detect-eval-with-expression", ["js", "ts"]),
  rule("java.lang.security.audit.crypto.weak-hash", ["java"]),
  rule("generic.secrets.security.detected-generic-secret", ["generic"]),
  rule("go.lang.security.audit.net.use-tls", ["go"]),
  rule("dockerfile.security.missing-user.missing-user", ["dockerfile"]),
];

test("buildVendoredRuleset keeps only in-scope-language rules", () => {
  const result = buildVendoredRuleset({
    resolve: () => FIXTURE_RULES,
  });
  const ids = result.rules.map((r) => r.id);
  assert.ok(ids.includes("yaml.github-actions.security.secrets-inherit.secrets-inherit"));
  assert.ok(ids.includes("package_managers.pnpm.pnpm-trust-policy.pnpm-trust-policy"));
  assert.ok(ids.includes("javascript.lang.security.audit.detect-eval-with-expression"));
  assert.ok(ids.includes("generic.secrets.security.detected-generic-secret"));
  assert.ok(ids.includes("dockerfile.security.missing-user.missing-user"));
  assert.ok(!ids.includes("python.eval.exec-injection"));
  assert.ok(!ids.includes("java.lang.security.audit.crypto.weak-hash"));
  assert.ok(!ids.includes("go.lang.security.audit.net.use-tls"));
});

test("buildVendoredRuleset reports drop/total counts", () => {
  const result = buildVendoredRuleset({ resolve: () => FIXTURE_RULES });
  assert.equal(result.totalCount, FIXTURE_RULES.length);
  assert.equal(result.rules.length, 5);
  assert.equal(result.droppedCount, FIXTURE_RULES.length - 5);
});

test("buildVendoredRuleset sorts kept rules by id (deterministic, low-diff-noise)", () => {
  const result = buildVendoredRuleset({ resolve: () => FIXTURE_RULES });
  const ids = result.rules.map((r) => r.id);
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(ids, sorted);
});

test("buildVendoredRuleset is empty when the resolver returns no rules", () => {
  const result = buildVendoredRuleset({ resolve: () => [] });
  assert.deepEqual(result.rules, []);
  assert.equal(result.totalCount, 0);
  assert.equal(result.droppedCount, 0);
});

test("buildVendoredRuleset keeps a multi-language rule if ANY language is in scope", () => {
  const multi = rule("polyglot.security.catch-all", [
    "bash",
    "c",
    "csharp",
    "go",
    "java",
    "js",
    "json",
    "kotlin",
    "lua",
    "ocaml",
    "php",
    "python",
    "ruby",
    "rust",
    "scala",
    "ts",
    "yaml",
  ]);
  const result = buildVendoredRuleset({ resolve: () => [multi] });
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].id, "polyglot.security.catch-all");
});

test("buildVendoredRuleset drops a rule with no languages array", () => {
  const malformed = { id: "no-langs-rule", message: "m", severity: "ERROR", metadata: {} };
  const result = buildVendoredRuleset({ resolve: () => [malformed] });
  assert.deepEqual(result.rules, []);
  assert.equal(result.droppedCount, 1);
});

test("buildVendoredRuleset drops the explicitly excluded Slack-webhook rule (push-protection carve-out)", () => {
  const slackWebhookRule = rule(
    "generic.secrets.security.detected-slack-webhook.detected-slack-webhook",
    ["generic"]
  );
  const result = buildVendoredRuleset({
    resolve: () => [...FIXTURE_RULES, slackWebhookRule],
  });
  const ids = result.rules.map((r) => r.id);
  assert.ok(
    !ids.includes("generic.secrets.security.detected-slack-webhook.detected-slack-webhook"),
    "the Slack-webhook rule must be excluded — its body embeds a credential-shaped placeholder " +
      "literal that trips GitHub push protection (Story #132); gitleaks already covers this class"
  );
});

test("the committed .semgrep/rules.json vendored file is well-formed and non-empty", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const vendoredPath = join(repoRoot, ".semgrep", "rules.json");
  const raw = readFileSync(vendoredPath, "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.rules));
  assert.ok(parsed.rules.length > 0);
  for (const r of parsed.rules) {
    assert.equal(typeof r.id, "string");
    assert.ok(Array.isArray(r.languages));
  }
  const ids = parsed.rules.map((r) => r.id);
  assert.ok(
    ids.includes("yaml.github-actions.security.secrets-inherit.secrets-inherit"),
    "secrets-inherit rule must be present in the vendored set (Story #132 AC)"
  );
  assert.ok(
    ids.includes(
      "package_managers.pnpm.pnpm-block-exotic-sub-dependencies.pnpm-block-exotic-sub-dependencies"
    ),
    "pnpm blockExoticSubdeps rule must remain in force (Story #132 AC)"
  );
  assert.ok(
    ids.includes("package_managers.pnpm.pnpm-trust-policy.pnpm-trust-policy"),
    "pnpm trustPolicy rule must remain in force (Story #132 AC)"
  );
});
