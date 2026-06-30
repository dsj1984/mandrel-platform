#!/usr/bin/env node
/**
 * check-pin-drift.test.mjs — node:test suite for the cross-consumer pin-drift
 * dashboard (Story #67, MP-12) and the npm-dimension extension that closes the
 * gap where a consumer's `mandrel-platform` npm dependency could lag the
 * workflow `uses:` pins undetected (npm at 0.11.3 while the workflows tracked
 * v0.11.6).
 *
 * The checker exposes pure helpers plus an injectable `runGh` seam, so the
 * whole pipeline is exercised offline with canned GitHub responses — no
 * network, no `gh` auth.
 *
 * Run: node scripts/check-pin-drift.test.mjs   (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildReport,
  classifyNpmPin,
  combineDrift,
  compareSemver,
  detectSurfaceSkew,
  extractNpmPlatformVersion,
  fetchConsumerPackageJson,
  hasDrift,
  parseSemver,
  renderReport,
  runCli,
} from "./check-pin-drift.mjs";

// ---------------------------------------------------------------------------
// parseSemver
// ---------------------------------------------------------------------------

test("parseSemver extracts the dotted triple from a release tag", () => {
  assert.equal(parseSemver("mandrel-platform-v0.11.7"), "0.11.7");
  assert.equal(parseSemver("v1.4.0"), "1.4.0");
});

test("parseSemver strips range prefixes from a dependency spec", () => {
  assert.equal(parseSemver("^0.11.7"), "0.11.7");
  assert.equal(parseSemver("~1.2.3"), "1.2.3");
  assert.equal(parseSemver(">=2.0.0"), "2.0.0");
  assert.equal(parseSemver("0.11.3"), "0.11.3");
});

test("parseSemver returns null for non-numeric specs and non-strings", () => {
  assert.equal(parseSemver("workspace:*"), null);
  assert.equal(parseSemver("latest"), null);
  assert.equal(parseSemver("github:owner/repo"), null);
  assert.equal(parseSemver(null), null);
  assert.equal(parseSemver(undefined), null);
});

// ---------------------------------------------------------------------------
// compareSemver — numeric, not lexical
// ---------------------------------------------------------------------------

test("compareSemver orders versions numerically", () => {
  assert.equal(compareSemver("0.11.3", "0.11.7"), -1);
  assert.equal(compareSemver("1.4.0", "1.4.0"), 0);
  assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
});

test("compareSemver compares each segment as a number, not a string", () => {
  // Lexical comparison would put "0.2.0" after "0.10.0"; numeric must not.
  assert.equal(compareSemver("0.2.0", "0.10.0"), -1);
  assert.equal(compareSemver("0.11.10", "0.11.9"), 1);
});

// ---------------------------------------------------------------------------
// extractNpmPlatformVersion
// ---------------------------------------------------------------------------

test("extractNpmPlatformVersion reads the dep from devDependencies", () => {
  const text = JSON.stringify({ devDependencies: { "mandrel-platform": "0.11.3" } });
  assert.equal(extractNpmPlatformVersion(text), "0.11.3");
});

test("extractNpmPlatformVersion prefers dependencies over devDependencies", () => {
  const text = JSON.stringify({
    dependencies: { "mandrel-platform": "1.0.0" },
    devDependencies: { "mandrel-platform": "2.0.0" },
  });
  assert.equal(extractNpmPlatformVersion(text), "1.0.0");
});

test("extractNpmPlatformVersion falls back to optional/peer deps", () => {
  const peer = JSON.stringify({ peerDependencies: { "mandrel-platform": "3.1.4" } });
  assert.equal(extractNpmPlatformVersion(peer), "3.1.4");
  const opt = JSON.stringify({ optionalDependencies: { "mandrel-platform": "5.0.0" } });
  assert.equal(extractNpmPlatformVersion(opt), "5.0.0");
});

test("extractNpmPlatformVersion honors a custom package name", () => {
  const text = JSON.stringify({ devDependencies: { "@scope/other": "9.9.9" } });
  assert.equal(extractNpmPlatformVersion(text, "@scope/other"), "9.9.9");
});

test("extractNpmPlatformVersion returns null when absent or malformed", () => {
  assert.equal(extractNpmPlatformVersion(JSON.stringify({ devDependencies: {} })), null);
  assert.equal(extractNpmPlatformVersion("{ not json"), null);
  assert.equal(extractNpmPlatformVersion("null"), null);
});

// ---------------------------------------------------------------------------
// classifyNpmPin
// ---------------------------------------------------------------------------

test("classifyNpmPin classifies current / lagging / ahead", () => {
  assert.deepEqual(classifyNpmPin("0.11.7", "0.11.7"), {
    rawSpec: "0.11.7",
    version: "0.11.7",
    npmState: "current",
  });
  assert.equal(classifyNpmPin("0.11.3", "0.11.7").npmState, "lagging");
  assert.equal(classifyNpmPin("1.0.0", "0.11.7").npmState, "ahead");
});

test("classifyNpmPin marks an absent dependency", () => {
  assert.deepEqual(classifyNpmPin(null, "0.11.7"), {
    rawSpec: null,
    version: null,
    npmState: "absent",
  });
});

test("classifyNpmPin is unknown for non-numeric specs or unknown latest", () => {
  assert.equal(classifyNpmPin("workspace:*", "0.11.7").npmState, "unknown");
  assert.equal(classifyNpmPin("0.11.7", null).npmState, "unknown");
});

// ---------------------------------------------------------------------------
// detectSurfaceSkew — the incident this guard exists for
// ---------------------------------------------------------------------------

test("detectSurfaceSkew flags uses-current but npm-lagging (and the reverse)", () => {
  assert.equal(detectSurfaceSkew("current", "lagging"), true);
  assert.equal(detectSurfaceSkew("lagging", "current"), true);
});

test("detectSurfaceSkew is false when both surfaces agree", () => {
  assert.equal(detectSurfaceSkew("current", "current"), false);
  assert.equal(detectSurfaceSkew("lagging", "lagging"), false);
});

test("detectSurfaceSkew is false when either surface is not comparable", () => {
  assert.equal(detectSurfaceSkew("current", "absent"), false);
  assert.equal(detectSurfaceSkew("current", "unknown"), false);
  assert.equal(detectSurfaceSkew("unknown", "lagging"), false);
  assert.equal(detectSurfaceSkew("no-pins", "lagging"), false);
});

// ---------------------------------------------------------------------------
// combineDrift
// ---------------------------------------------------------------------------

test("combineDrift folds uses-drift, npm-lag, and surface-skew", () => {
  const clean = { drift: false };
  assert.equal(combineDrift(clean, { npmState: "current" }, false), false);
  assert.equal(combineDrift(clean, { npmState: "absent" }, false), false);
  assert.equal(combineDrift(clean, { npmState: "ahead" }, false), false);
  assert.equal(combineDrift(clean, { npmState: "lagging" }, false), true);
  assert.equal(combineDrift(clean, { npmState: "current" }, true), true);
  assert.equal(combineDrift({ drift: true }, { npmState: "current" }, false), true);
});

// ---------------------------------------------------------------------------
// Integration: buildReport + renderReport with an injected gh runner
// ---------------------------------------------------------------------------

const PLATFORM = "dsj1984/mandrel-platform";
const TAG = "mandrel-platform-v1.4.0";
const LATEST_SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);

function b64(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(s, "utf-8").toString("base64");
}

function usesYaml(sha) {
  return ["jobs:", "  q:", `    uses: ${PLATFORM}/.github/workflows/pr-quality.yml@${sha}`].join(
    "\n",
  );
}

function pkgJson(version) {
  const devDependencies = version ? { "mandrel-platform": version } : {};
  return { name: "consumer", devDependencies };
}

/**
 * Build an injectable gh runner from a per-repo fixture map:
 *   { "owner/repo": { workflowSha, npm: string | null | "throw" } }
 */
function makeRunGh(fixtures) {
  return (args) => {
    const path = args[1];
    if (path === `repos/${PLATFORM}/releases/latest`) {
      return JSON.stringify({ tag_name: TAG });
    }
    if (path === `repos/${PLATFORM}/git/ref/tags/${TAG}`) {
      return JSON.stringify({ object: { sha: LATEST_SHA, type: "commit" } });
    }
    for (const [repo, cfg] of Object.entries(fixtures)) {
      if (path === `repos/${repo}/contents/.github/workflows?ref=main`) {
        return JSON.stringify([
          { type: "file", name: "ci.yml", encoding: "base64", content: b64(usesYaml(cfg.workflowSha)) },
        ]);
      }
      if (path === `repos/${repo}/contents/package.json?ref=main`) {
        if (cfg.npm === "throw") throw new Error("404 Not Found");
        return JSON.stringify({ encoding: "base64", content: b64(pkgJson(cfg.npm)) });
      }
    }
    throw new Error(`unexpected gh api path: ${path}`);
  };
}

const CONFIG = {
  platformRepo: PLATFORM,
  consumers: [
    { name: "aligned", repo: "o/aligned", branch: "main" },
    { name: "skew", repo: "o/skew", branch: "main" },
    { name: "both-lag", repo: "o/both-lag", branch: "main" },
    { name: "no-npm", repo: "o/no-npm", branch: "main" },
  ],
};

const FIXTURES = {
  "o/aligned": { workflowSha: LATEST_SHA, npm: "1.4.0" },
  "o/skew": { workflowSha: LATEST_SHA, npm: "1.3.0" },
  "o/both-lag": { workflowSha: OLD_SHA, npm: "1.3.0" },
  "o/no-npm": { workflowSha: LATEST_SHA, npm: null },
};

function byName(report, name) {
  return report.results.find((r) => r.name === name);
}

test("buildReport: aligned consumer is current with no drift", () => {
  const report = buildReport(CONFIG, makeRunGh(FIXTURES));
  assert.equal(report.latestVersion, "1.4.0");
  const r = byName(report, "aligned");
  assert.equal(r.verdict.lagState, "current");
  assert.equal(r.npm.npmState, "current");
  assert.equal(r.surfaceSkew, false);
  assert.equal(r.drift, false);
});

test("buildReport: npm lagging while workflows current is a surface skew", () => {
  const report = buildReport(CONFIG, makeRunGh(FIXTURES));
  const r = byName(report, "skew");
  assert.equal(r.verdict.lagState, "current");
  assert.equal(r.npm.npmState, "lagging");
  assert.equal(r.surfaceSkew, true);
  assert.equal(r.drift, true);
});

test("buildReport: both surfaces lagging is drift but not a skew", () => {
  const report = buildReport(CONFIG, makeRunGh(FIXTURES));
  const r = byName(report, "both-lag");
  assert.equal(r.verdict.lagState, "lagging");
  assert.equal(r.npm.npmState, "lagging");
  assert.equal(r.surfaceSkew, false);
  assert.equal(r.drift, true);
});

test("buildReport: a consumer without the npm dep is current, not drift", () => {
  const report = buildReport(CONFIG, makeRunGh(FIXTURES));
  const r = byName(report, "no-npm");
  assert.equal(r.npm.npmState, "absent");
  assert.equal(r.surfaceSkew, false);
  assert.equal(r.drift, false);
});

test("buildReport: an unreadable package.json is treated as absent, not an error", () => {
  const report = buildReport(
    { platformRepo: PLATFORM, consumers: [{ name: "c", repo: "o/c", branch: "main" }] },
    makeRunGh({ "o/c": { workflowSha: LATEST_SHA, npm: "throw" } }),
  );
  const r = byName(report, "c");
  assert.equal(r.error, undefined);
  assert.equal(r.npm.npmState, "absent");
  assert.equal(r.drift, false);
});

test("hasDrift is true when any consumer drifts", () => {
  const report = buildReport(CONFIG, makeRunGh(FIXTURES));
  assert.equal(hasDrift(report), true);
});

test("renderReport surfaces the npm columns and drift lines", () => {
  const report = buildReport(CONFIG, makeRunGh(FIXTURES));
  const text = renderReport(report);
  assert.match(text, /npm pin/);
  assert.match(text, /npm lag/);
  assert.match(text, /SURFACE SKEW/);
  assert.match(text, /npm\/uses skew/);
  // The aligned consumer renders its npm version in the table.
  assert.match(text, /`1\.4\.0`/);
});

test("fetchConsumerPackageJson returns null when the file is missing", () => {
  const runGh = () => {
    throw new Error("404");
  };
  assert.equal(fetchConsumerPackageJson("o/x", "main", runGh), null);
});

// ---------------------------------------------------------------------------
// CLI: --json, --strict, exit codes
// ---------------------------------------------------------------------------

let cfgDir;
function writeConfig() {
  cfgDir = mkdtempSync(join(tmpdir(), "pin-drift-test-"));
  const p = join(cfgDir, "consumers.json");
  writeFileSync(p, JSON.stringify(CONFIG));
  return p;
}

function capture() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join("") };
}

test("runCli --json emits a machine-readable envelope and exits 0 without --strict", () => {
  const configPath = writeConfig();
  const stdout = capture();
  const stderr = capture();
  try {
    const code = runCli({
      argv: ["--config", configPath, "--json"],
      runGh: makeRunGh(FIXTURES),
      stdout,
      stderr,
      summaryPath: undefined,
    });
    assert.equal(code, 0);
    const envelope = JSON.parse(stdout.text());
    assert.equal(envelope.kind, "pin-drift-report");
    assert.equal(envelope.drift, true);
    assert.equal(envelope.results.length, 4);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("runCli --strict exits 1 when drift is present", () => {
  const configPath = writeConfig();
  try {
    const code = runCli({
      argv: ["--config", configPath, "--strict"],
      runGh: makeRunGh(FIXTURES),
      stdout: capture(),
      stderr: capture(),
      summaryPath: undefined,
    });
    assert.equal(code, 1);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});
