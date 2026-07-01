#!/usr/bin/env node
/**
 * platform-sync.test.mjs — node:test suite for the MP-14 adoption CLI.
 *
 * Exercises the four acceptance behaviours against a synthetic consumer dir
 * built under a temp root, in offline mode (`--sha` skips the network):
 *
 *   1. workflow SHA pinning (first-party rewritten, external untouched, the
 *      `# <ref>` annotation refreshed),
 *   2. runbook reference-stub materialization (link-only, local-copy warning),
 *   3. renovate / tsconfig `extends` reconciliation (SSOT prepended, consumer
 *      overrides preserved),
 *   4. idempotency + `--dry-run` non-mutation.
 *
 * Run: node scripts/platform-sync.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "platform-sync.mjs");
const SHA = "a".repeat(40);
const REF = "mandrel-platform-v9.9.9";

let consumer;

function run(extraArgs) {
  return execFileSync(
    "node",
    [CLI, "--ref", REF, "--sha", SHA, "--consumer", consumer, "--json", ...extraArgs],
    { encoding: "utf8" }
  );
}

function seedConsumer() {
  mkdirSync(join(consumer, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(consumer, ".github", "workflows", "ci.yml"),
    [
      "name: CI",
      "jobs:",
      "  q:",
      "    steps:",
      `      - uses: dsj1984/mandrel-platform/.github/actions/setup-toolchain@${"1".repeat(40)} # stale`,
      `      - uses: actions/checkout@${"2".repeat(40)} # external`,
      "",
    ].join("\n")
  );
  writeFileSync(join(consumer, "renovate.json"), JSON.stringify({ extends: ["config:base"] }, null, 2));
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { outDir: "dist" } }, null, 2)
  );
}

beforeEach(() => {
  consumer = mkdtempSync(join(tmpdir(), "platform-sync-test-"));
  seedConsumer();
});

afterEach(() => {
  rmSync(consumer, { recursive: true, force: true });
});

test("--dry-run does not mutate any file", () => {
  const before = readFileSync(join(consumer, ".github", "workflows", "ci.yml"), "utf8");
  const out = JSON.parse(run(["--dry-run"]));
  assert.equal(out.dryRun, true);
  assert.equal(out.changed, true);
  const after = readFileSync(join(consumer, ".github", "workflows", "ci.yml"), "utf8");
  assert.equal(after, before, "ci.yml must be untouched in dry-run");
  assert.ok(!existsSync(join(consumer, "docs", "runbooks", "observability.md")));
  assert.ok(!existsSync(join(consumer, ".github", "workflows", "deploy-staging.yml")));
});

test("apply pins first-party SHAs, leaves external actions untouched", () => {
  const out = JSON.parse(run([]));
  assert.equal(out.changed, true);
  assert.equal(out.pins.length, 1);
  const ci = readFileSync(join(consumer, ".github", "workflows", "ci.yml"), "utf8");
  assert.ok(ci.includes(`setup-toolchain@${SHA} # ${REF}`), "first-party pin rewritten + annotated");
  assert.ok(ci.includes(`actions/checkout@${"2".repeat(40)} # external`), "external action untouched");
});

test("apply materializes runbook reference stubs (link, don't copy)", () => {
  run([]);
  const stub = join(consumer, "docs", "runbooks", "deploy-promotion.md");
  assert.ok(existsSync(stub));
  const body = readFileSync(stub, "utf8");
  assert.ok(body.includes("Thin local stub"), "materialized stub is a reference, not a copy");
  assert.ok(
    body.includes("github.com/dsj1984/mandrel-platform"),
    "stub links back to the canonical runbook"
  );
});

test("apply reconciles renovate + tsconfig extends, preserving consumer entries", () => {
  run([]);
  const renovate = JSON.parse(readFileSync(join(consumer, "renovate.json"), "utf8"));
  assert.deepEqual(renovate.extends, ["github>dsj1984/mandrel-platform", "config:base"]);
  const tsconfig = JSON.parse(readFileSync(join(consumer, "tsconfig.json"), "utf8"));
  assert.equal(tsconfig.extends, "mandrel-platform/tsconfig.base.json");
  assert.equal(tsconfig.compilerOptions.outDir, "dist", "consumer overrides preserved");
});

test("re-running is idempotent (changed: false on the second pass)", () => {
  run([]);
  const second = JSON.parse(run([]));
  assert.equal(second.changed, false, "second sync reports no changes");
  assert.equal(second.pins.length, 0);
});

test("a full local-copy runbook is flagged, not overwritten", () => {
  const dest = join(consumer, "docs", "runbooks");
  mkdirSync(dest, { recursive: true });
  const localCopy = "# Local copy, no stub marker\n\nfull process re-authored here\n";
  writeFileSync(join(dest, "observability.md"), localCopy);
  const out = JSON.parse(run([]));
  assert.ok(
    out.runbooks.localCopies.some((f) => f.endsWith("observability.md")),
    "local copy surfaced as a warning"
  );
  assert.equal(
    readFileSync(join(dest, "observability.md"), "utf8"),
    localCopy,
    "operator's local copy is never clobbered"
  );
});

test("an existing reference stub is skipped idempotently", () => {
  run([]); // materialize stubs
  const out = JSON.parse(run([])); // second pass
  assert.ok(out.runbooks.skipped.length >= 8, "already-present stubs are skipped, not re-created");
  assert.equal(out.runbooks.created.length, 0);
});

test("apply materializes the canonical deploy-staging.yml workflow caller template", () => {
  const out = JSON.parse(run([]));
  const stub = join(consumer, ".github", "workflows", "deploy-staging.yml");
  assert.ok(existsSync(stub));
  assert.ok(
    out.workflowStubs.created.some((f) => f.endsWith("deploy-staging.yml")),
    "deploy-staging.yml reported as created"
  );
  const body = readFileSync(stub, "utf8");
  assert.ok(
    body.includes("Canonical staging-deploy caller template"),
    "materialized workflow carries the template marker"
  );
  assert.ok(
    body.includes("dsj1984/mandrel-platform/.github/workflows/deploy-cloudflare.yml"),
    "template calls the shared deploy-cloudflare.yml reusable workflow"
  );
});

test("workflow caller template materialization is idempotent", () => {
  run([]); // materialize
  const out = JSON.parse(run([])); // second pass
  assert.ok(
    out.workflowStubs.skipped.some((f) => f.endsWith("deploy-staging.yml")),
    "already-materialized template is skipped, not re-created"
  );
  assert.equal(out.workflowStubs.created.length, 0);
});

test("a hand-authored deploy-staging.yml is flagged, not overwritten", () => {
  const destDir = join(consumer, ".github", "workflows");
  mkdirSync(destDir, { recursive: true });
  const handAuthored = "name: deploy-staging\n# fully custom, no template marker\njobs: {}\n";
  writeFileSync(join(destDir, "deploy-staging.yml"), handAuthored);
  const out = JSON.parse(run([]));
  assert.ok(
    out.workflowStubs.localCopies.some((f) => f.endsWith("deploy-staging.yml")),
    "hand-authored caller surfaced as a warning"
  );
  assert.equal(
    readFileSync(join(destDir, "deploy-staging.yml"), "utf8"),
    handAuthored,
    "operator's hand-authored caller is never clobbered"
  );
});
