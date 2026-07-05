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
  allConsumersErrored,
  buildReport,
  classifyNpmPin,
  classifyStaleLiterals,
  combineDrift,
  compareSemver,
  detectSurfaceSkew,
  extractNpmPlatformVersion,
  extractStaleLiterals,
  fetchConsumerPackageJson,
  hasDrift,
  isHolding,
  isWithinReleaseAgeWindow,
  parseDurationMs,
  parseSemver,
  pinDriftTokenProvided,
  renderReport,
  resolveLatestRelease,
  runCli,
} from "./check-pin-drift.mjs";
import { httpStatusOf, isNotFound } from "./lib/gh-json.mjs";

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
// extractStaleLiterals / classifyStaleLiterals (Story #110)
// ---------------------------------------------------------------------------

const PLAT = "dsj1984/mandrel-platform";

test("extractStaleLiterals finds platform refs in comments and run/echo strings", () => {
  const text = [
    "jobs:",
    "  deploy:",
    "    steps:",
    `      # pinned via ${PLAT}/.github/workflows/deploy-cloudflare.yml@${"c".repeat(40)}`,
    "      - name: summary",
    "        run: |",
    `          echo "deployed with ${PLAT}/.github/workflows/deploy-cloudflare.yml@v0.11.6"`,
  ].join("\n");
  const lits = extractStaleLiterals("ci.yml", text, PLAT);
  assert.equal(lits.length, 2);
  assert.equal(lits[0].kind, "comment");
  assert.equal(lits[0].ref, "c".repeat(40));
  assert.equal(lits[1].kind, "run");
  assert.equal(lits[1].ref, "v0.11.6");
});

test("extractStaleLiterals ignores uses: lines (owned by extractPlatformPins)", () => {
  const text = [
    "jobs:",
    "  q:",
    `    uses: ${PLAT}/.github/workflows/pr-quality.yml@${"a".repeat(40)}`,
    `    # uses: ${PLAT}/.github/workflows/pr-quality.yml@${"a".repeat(40)}`,
  ].join("\n");
  const lits = extractStaleLiterals("ci.yml", text, PLAT);
  // The bare `uses:` line is skipped; the commented `# uses:` line is a comment
  // literal (it is NOT a live uses directive), so it IS captured.
  assert.equal(lits.length, 1);
  assert.equal(lits[0].kind, "comment");
});

test("extractStaleLiterals returns nothing when no platform refs are present", () => {
  const text = "jobs:\n  q:\n    run: echo hello\n    # owner/other-repo/x.yml@abc";
  assert.deepEqual(extractStaleLiterals("ci.yml", text, PLAT), []);
});

test("classifyStaleLiterals flags a literal that drifts from the canonical pin", () => {
  const canonicalSha = "a".repeat(40);
  const staleSha = "c".repeat(40);
  const literals = [
    { file: "ci.yml", line: 9, target: PLAT, ref: staleSha, kind: "run" },
    { file: "ci.yml", line: 4, target: PLAT, ref: canonicalSha, kind: "comment" },
  ];
  const out = classifyStaleLiterals(literals, [canonicalSha]);
  assert.equal(out.hasStaleLiteral, true);
  assert.equal(out.staleLiterals.length, 1);
  assert.equal(out.staleLiterals[0].ref, staleSha);
  assert.equal(out.staleLiterals[0].reason, "stale");
});

test("classifyStaleLiterals matches the canonical pin case-insensitively", () => {
  const sha = "abc123" + "0".repeat(34);
  const literals = [
    { file: "ci.yml", line: 9, target: PLAT, ref: sha.toUpperCase(), kind: "run" },
  ];
  const out = classifyStaleLiterals(literals, [sha]);
  assert.equal(out.hasStaleLiteral, false);
  assert.equal(out.staleLiterals.length, 0);
});

test("classifyStaleLiterals reports an orphan literal when there is no canonical pin", () => {
  const literals = [
    { file: "ci.yml", line: 9, target: PLAT, ref: "v0.11.6", kind: "run" },
  ];
  const out = classifyStaleLiterals(literals, []);
  assert.equal(out.hasStaleLiteral, true);
  assert.equal(out.staleLiterals[0].reason, "orphan");
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

test("combineDrift suppresses lag/skew during the minimumReleaseAge hold", () => {
  const lagging = { drift: true, splitPinned: false };
  // Without the hold flag, lag is drift.
  assert.equal(combineDrift(lagging, { npmState: "lagging" }, false, false), true);
  // Within the hold window, the same lag/skew is suppressed.
  assert.equal(combineDrift(lagging, { npmState: "lagging" }, false, true), false);
  assert.equal(
    combineDrift({ drift: false, splitPinned: false }, { npmState: "current" }, true, true),
    false,
  );
});

test("combineDrift never suppresses a split pin, even within the hold window", () => {
  const split = { drift: true, splitPinned: true };
  assert.equal(combineDrift(split, { npmState: "current" }, false, true), true);
});

test("combineDrift flags a stale literal even inside the hold window (Story #110)", () => {
  const clean = { drift: false, splitPinned: false };
  // No other deviation, but a stale literal is present → drift, hold or not.
  assert.equal(
    combineDrift(clean, { npmState: "current" }, false, true, true),
    true,
  );
  // No stale literal and otherwise clean → not drift.
  assert.equal(
    combineDrift(clean, { npmState: "current" }, false, true, false),
    false,
  );
});

// ---------------------------------------------------------------------------
// parseDurationMs — Renovate-style minimumReleaseAge strings (Story #107)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

test("parseDurationMs parses days / hours / weeks / minutes", () => {
  assert.equal(parseDurationMs("3 days"), 3 * DAY_MS);
  assert.equal(parseDurationMs("1 day"), DAY_MS);
  assert.equal(parseDurationMs("36 hours"), 36 * 60 * 60 * 1000);
  assert.equal(parseDurationMs("1 week"), 7 * DAY_MS);
  assert.equal(parseDurationMs("90 minutes"), 90 * 60 * 1000);
});

test("parseDurationMs treats a bare number as days and rejects junk", () => {
  assert.equal(parseDurationMs(3), 3 * DAY_MS);
  assert.equal(parseDurationMs("0 days"), null);
  assert.equal(parseDurationMs("-2 days"), null);
  assert.equal(parseDurationMs("soon"), null);
  assert.equal(parseDurationMs(""), null);
  assert.equal(parseDurationMs(null), null);
  assert.equal(parseDurationMs("5 fortnights"), null);
});

// ---------------------------------------------------------------------------
// isWithinReleaseAgeWindow
// ---------------------------------------------------------------------------

test("isWithinReleaseAgeWindow is true for a release younger than the window", () => {
  const now = Date.parse("2026-06-30T00:00:00Z");
  const oneDayAgo = "2026-06-29T00:00:00Z";
  assert.equal(isWithinReleaseAgeWindow(oneDayAgo, 3 * DAY_MS, now), true);
});

test("isWithinReleaseAgeWindow is false once the release ages past the window", () => {
  const now = Date.parse("2026-06-30T00:00:00Z");
  const fourDaysAgo = "2026-06-26T00:00:00Z";
  assert.equal(isWithinReleaseAgeWindow(fourDaysAgo, 3 * DAY_MS, now), false);
});

test("isWithinReleaseAgeWindow fails safe (false) on missing inputs", () => {
  const now = Date.parse("2026-06-30T00:00:00Z");
  assert.equal(isWithinReleaseAgeWindow(null, 3 * DAY_MS, now), false);
  assert.equal(isWithinReleaseAgeWindow("2026-06-29T00:00:00Z", null, now), false);
  assert.equal(isWithinReleaseAgeWindow("not-a-date", 3 * DAY_MS, now), false);
  assert.equal(isWithinReleaseAgeWindow("2026-06-29T00:00:00Z", 0, now), false);
});

// ---------------------------------------------------------------------------
// isHolding
// ---------------------------------------------------------------------------

test("isHolding is true when lag would drift but the release is inside the window", () => {
  assert.equal(
    isHolding({ drift: true, splitPinned: false }, { npmState: "lagging" }, true, true),
    true,
  );
});

test("isHolding is false outside the window, for a clean consumer, or a split pin", () => {
  // Outside the window — the lag is real drift, not a hold.
  assert.equal(
    isHolding({ drift: true, splitPinned: false }, { npmState: "lagging" }, false, false),
    false,
  );
  // No deviation to suppress.
  assert.equal(
    isHolding({ drift: false, splitPinned: false }, { npmState: "current" }, false, true),
    false,
  );
  // A split pin is a real error regardless of the hold.
  assert.equal(
    isHolding({ drift: true, splitPinned: true }, { npmState: "current" }, false, true),
    false,
  );
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
 * Build an error shaped like the one `execFileSync('gh', …)` throws when
 * `gh api` exits non-zero: the HTTP status is carried in the `(HTTP <code>)`
 * marker `gh` writes to stderr. This is exactly what the fail-closed seam
 * (`httpStatusOf` / `isNotFound` in scripts/lib/gh-json.mjs) parses.
 *
 * @param {number} status  HTTP status code (e.g. 404, 500).
 * @param {string} [label]  Human label gh prints before the marker.
 * @returns {Error}
 */
function ghHttpError(status, label = "Error") {
  const err = new Error(`Command failed: gh api …\ngh: ${label} (HTTP ${status})`);
  // execFileSync surfaces the CLI's stderr on `.stderr`; the status parser
  // reads it there first.
  err.stderr = `gh: ${label} (HTTP ${status})\n`;
  return err;
}

/**
 * Build an injectable gh runner from a per-repo fixture map:
 *   { "owner/repo": { workflowSha, npm: string | null | "throw" } }
 * `npm: "throw"` simulates a 404 on the package.json fetch (the legitimate
 * "consumer has no package.json" case → treated as absent).
 */
function makeRunGh(fixtures) {
  return (args) => {
    const path = args[1];
    if (path === `repos/${PLATFORM}/releases/latest`) {
      // `publishedAt` is opt-in: existing fixtures omit it (so the
      // minimumReleaseAge window resolves to "not within", preserving legacy
      // behaviour); the hold-window tests pass it explicitly.
      return JSON.stringify({ tag_name: TAG, published_at: fixtures.__publishedAt });
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
        // A 404 on package.json is the "no npm config package" case → absent.
        if (cfg.npm === "throw") throw ghHttpError(404, "Not Found");
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

test("buildReport: a stale pin literal beyond uses: is drift (Story #110)", () => {
  const canonical = "a".repeat(40); // == LATEST_SHA, so uses: is current
  const stale = "c".repeat(40);
  const yaml = [
    "jobs:",
    "  deploy:",
    `    uses: ${PLATFORM}/.github/workflows/deploy-cloudflare.yml@${canonical}`,
    "  summary:",
    "    steps:",
    `      # legacy pin note: ${PLATFORM}/.github/workflows/deploy-cloudflare.yml@${stale}`,
    "      - run: |",
    `          echo "deployed ${PLATFORM}/.github/workflows/deploy-cloudflare.yml@${stale}"`,
  ].join("\n");
  const runGh = (args) => {
    const path = args[1];
    if (path === `repos/${PLATFORM}/releases/latest`) {
      return JSON.stringify({ tag_name: TAG });
    }
    if (path === `repos/${PLATFORM}/git/ref/tags/${TAG}`) {
      return JSON.stringify({ object: { sha: LATEST_SHA, type: "commit" } });
    }
    if (path === "repos/o/lit/contents/.github/workflows?ref=main") {
      return JSON.stringify([
        { type: "file", name: "ci.yml", encoding: "base64", content: b64(yaml) },
      ]);
    }
    if (path === "repos/o/lit/contents/package.json?ref=main") {
      return JSON.stringify({ encoding: "base64", content: b64(pkgJson("1.4.0")) });
    }
    throw new Error(`unexpected gh api path: ${path}`);
  };
  const report = buildReport(
    { platformRepo: PLATFORM, consumers: [{ name: "lit", repo: "o/lit", branch: "main" }] },
    runGh,
  );
  const r = byName(report, "lit");
  // The uses: pin and npm dep are both current — the ONLY deviation is the
  // stale echoed literal, which the uses:-only check would have missed.
  assert.equal(r.verdict.lagState, "current");
  assert.equal(r.npm.npmState, "current");
  assert.equal(r.hasStaleLiteral, true);
  assert.equal(r.staleLiterals.length, 2); // comment + echo, same stale SHA
  assert.equal(r.staleLiterals.every((l) => l.reason === "stale"), true);
  assert.equal(r.drift, true);
  const text = renderReport(report);
  assert.match(text, /stale pin literal/);
  assert.match(text, /STALE PIN LITERAL/);
});

test("fetchConsumerPackageJson returns null when the file is missing (404)", () => {
  const runGh = () => {
    throw ghHttpError(404, "Not Found");
  };
  assert.equal(fetchConsumerPackageJson("o/x", "main", runGh), null);
});

test("fetchConsumerPackageJson rethrows a non-404 error (fail closed)", () => {
  const runGh = () => {
    throw ghHttpError(500, "Server Error");
  };
  assert.throws(() => fetchConsumerPackageJson("o/x", "main", runGh), /HTTP 500/);
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

// ---------------------------------------------------------------------------
// Fail-closed on a non-404 gh error (Story #198) — the fail-open the strict
// gate must not have. Historically EVERY gh error was swallowed into an
// "absent" sentinel, so a 500/403/network blip read as "no drift" and
// `--strict` exited 0. The seam now surfaces the HTTP status: only a 404 is
// swallowed; every other error propagates to an `error` row.
// ---------------------------------------------------------------------------

const ERROR_CONFIG = {
  platformRepo: PLATFORM,
  consumers: [{ name: "flaky", repo: "o/flaky", branch: "main" }],
};

/**
 * A gh runner whose workflow-listing call fails. `status` selects the HTTP
 * code so a single helper drives both the 404 (swallow → absent) and non-404
 * (rethrow → error row) cases.
 */
function makeFailingRunGh(status) {
  return (args) => {
    const path = args[1];
    if (path === `repos/${PLATFORM}/releases/latest`) {
      return JSON.stringify({ tag_name: TAG });
    }
    if (path === `repos/${PLATFORM}/git/ref/tags/${TAG}`) {
      return JSON.stringify({ object: { sha: LATEST_SHA, type: "commit" } });
    }
    if (path === "repos/o/flaky/contents/.github/workflows?ref=main") {
      throw ghHttpError(status, status === 404 ? "Not Found" : "Server Error");
    }
    if (path === "repos/o/flaky/contents/package.json?ref=main") {
      return JSON.stringify({ encoding: "base64", content: b64(pkgJson("1.4.0")) });
    }
    throw new Error(`unexpected gh api path: ${path}`);
  };
}

test("httpStatusOf / isNotFound parse the HTTP status out of a gh error", () => {
  assert.equal(httpStatusOf(ghHttpError(404)), 404);
  assert.equal(httpStatusOf(ghHttpError(500)), 500);
  assert.equal(isNotFound(ghHttpError(404)), true);
  assert.equal(isNotFound(ghHttpError(500)), false);
  // A bare error with no parseable status is NOT a 404 → must fail closed.
  assert.equal(httpStatusOf(new Error("socket hang up")), null);
  assert.equal(isNotFound(new Error("socket hang up")), false);
});

test("buildReport: a non-404 gh error yields an `error` row (fail closed)", () => {
  const report = buildReport(ERROR_CONFIG, makeFailingRunGh(500));
  const r = byName(report, "flaky");
  assert.notEqual(r.error, undefined);
  assert.match(r.error, /HTTP 500/);
  assert.equal(r.drift, false); // drift itself is false…
  // …but hasDrift counts the error row, so the report is NOT clean.
  assert.equal(hasDrift(report), true);
});

test("buildReport: a 404-shaped gh error is classified no-pins, drift false", () => {
  const report = buildReport(ERROR_CONFIG, makeFailingRunGh(404));
  const r = byName(report, "flaky");
  assert.equal(r.error, undefined);
  assert.equal(r.verdict.lagState, "no-pins");
  assert.equal(r.drift, false);
  assert.equal(hasDrift(report), false);
});

test("resolveLatestRelease rethrows a non-404 error on releases/latest (fail closed)", () => {
  // A transient 5xx/403 on the platform's own release resolution must NOT be
  // swallowed into sha:null — that would classify the whole fleet as lagState
  // "unknown" (drift=false) and silently pass the strict gate.
  const runGh = (args) => {
    if (args[1] === `repos/${PLATFORM}/releases/latest`) {
      throw ghHttpError(500, "Server Error");
    }
    throw new Error(`unexpected gh api path: ${args[1]}`);
  };
  assert.throws(() => resolveLatestRelease(PLATFORM, runGh), /HTTP 500/);
});

test("resolveLatestRelease returns nulls on a 404 (repo has no release yet)", () => {
  const runGh = (args) => {
    if (args[1] === `repos/${PLATFORM}/releases/latest`) {
      throw ghHttpError(404, "Not Found");
    }
    throw new Error(`unexpected gh api path: ${args[1]}`);
  };
  assert.deepEqual(resolveLatestRelease(PLATFORM, runGh), {
    tag: null,
    sha: null,
    publishedAt: null,
  });
});

test("resolveLatestRelease rethrows a non-404 error on the tag→sha deref (fail closed)", () => {
  const runGh = (args) => {
    if (args[1] === `repos/${PLATFORM}/releases/latest`) {
      return JSON.stringify({ tag_name: TAG });
    }
    if (args[1] === `repos/${PLATFORM}/git/ref/tags/${TAG}`) {
      throw ghHttpError(503, "Service Unavailable");
    }
    throw new Error(`unexpected gh api path: ${args[1]}`);
  };
  assert.throws(() => resolveLatestRelease(PLATFORM, runGh), /HTTP 503/);
});

test("runCli --strict exits non-zero on a non-404 gh error (fail closed)", () => {
  cfgDir = mkdtempSync(join(tmpdir(), "pin-drift-failclosed-"));
  const p = join(cfgDir, "consumers.json");
  writeFileSync(p, JSON.stringify(ERROR_CONFIG));
  try {
    const code = runCli({
      argv: ["--config", p, "--strict"],
      runGh: makeFailingRunGh(500),
      stdout: capture(),
      stderr: capture(),
      summaryPath: undefined,
    });
    assert.equal(code, 1);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("runCli --strict exits 0 on a 404-shaped gh error (genuine absence)", () => {
  cfgDir = mkdtempSync(join(tmpdir(), "pin-drift-404-"));
  const p = join(cfgDir, "consumers.json");
  writeFileSync(p, JSON.stringify(ERROR_CONFIG));
  try {
    const code = runCli({
      argv: ["--config", p, "--strict"],
      runGh: makeFailingRunGh(404),
      stdout: capture(),
      stderr: capture(),
      summaryPath: undefined,
    });
    assert.equal(code, 0);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// minimumReleaseAge hold window — the false-positive guard (Story #107)
// ---------------------------------------------------------------------------

// A fresh release: the `skew` and `both-lag` consumers lag it, but the release
// is younger than the 3-day hold window, so Renovate has not bumped them yet.
const FRESH_RELEASE_AT = "2026-06-29T00:00:00Z"; // 1 day before NOW
const AGED_RELEASE_AT = "2026-06-25T00:00:00Z"; // 5 days before NOW
const NOW = Date.parse("2026-06-30T00:00:00Z");

const HOLD_CONFIG = { ...CONFIG, minimumReleaseAge: "3 days" };

test("buildReport: lag against a release inside the hold window is holding, not drift", () => {
  const runGh = makeRunGh({ ...FIXTURES, __publishedAt: FRESH_RELEASE_AT });
  const report = buildReport(HOLD_CONFIG, runGh, NOW);
  assert.equal(report.releaseAge.withinWindow, true);

  // npm lags but workflows are current → would be a surface skew, suppressed.
  const skew = byName(report, "skew");
  assert.equal(skew.surfaceSkew, true);
  assert.equal(skew.holding, true);
  assert.equal(skew.drift, false);

  // Both surfaces lag → would be drift, suppressed during the hold.
  const both = byName(report, "both-lag");
  assert.equal(both.holding, true);
  assert.equal(both.drift, false);

  // The aligned consumer is genuinely current — not holding.
  const aligned = byName(report, "aligned");
  assert.equal(aligned.holding, false);
  assert.equal(aligned.drift, false);

  // No consumer drifts during the hold → the dashboard does not page.
  assert.equal(hasDrift(report), false);
});

test("buildReport: the same lag against an aged release is real drift again", () => {
  const runGh = makeRunGh({ ...FIXTURES, __publishedAt: AGED_RELEASE_AT });
  const report = buildReport(HOLD_CONFIG, runGh, NOW);
  assert.equal(report.releaseAge.withinWindow, false);

  const skew = byName(report, "skew");
  assert.equal(skew.holding, false);
  assert.equal(skew.drift, true);

  const both = byName(report, "both-lag");
  assert.equal(both.holding, false);
  assert.equal(both.drift, true);

  assert.equal(hasDrift(report), true);
});

test("renderReport surfaces the holding banner + section during the hold", () => {
  const runGh = makeRunGh({ ...FIXTURES, __publishedAt: FRESH_RELEASE_AT });
  const report = buildReport(HOLD_CONFIG, runGh, NOW);
  const text = renderReport(report);
  assert.match(text, /minimumReleaseAge` hold active/);
  assert.match(text, /⏳ holding/);
  assert.match(text, /Holding \(minimumReleaseAge\)/);
  // Held consumers must NOT appear in a "Drift detected" section.
  assert.doesNotMatch(text, /Drift detected/);
});

test("runCli --strict does NOT exit 1 when the only deviation is a hold", () => {
  cfgDir = mkdtempSync(join(tmpdir(), "pin-drift-hold-"));
  const p = join(cfgDir, "consumers.json");
  writeFileSync(p, JSON.stringify(HOLD_CONFIG));
  try {
    const code = runCli({
      argv: ["--config", p, "--strict"],
      runGh: makeRunGh({ ...FIXTURES, __publishedAt: FRESH_RELEASE_AT }),
      stdout: capture(),
      stderr: capture(),
      summaryPath: undefined,
      nowMs: NOW, // release is 1 day old → inside the 3-day hold window.
    });
    assert.equal(code, 0);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("runCli --strict DOES exit 1 once the held release ages out", () => {
  cfgDir = mkdtempSync(join(tmpdir(), "pin-drift-aged-"));
  const p = join(cfgDir, "consumers.json");
  writeFileSync(p, JSON.stringify(HOLD_CONFIG));
  try {
    const code = runCli({
      argv: ["--config", p, "--strict"],
      runGh: makeRunGh({ ...FIXTURES, __publishedAt: AGED_RELEASE_AT }),
      stdout: capture(),
      stderr: capture(),
      summaryPath: undefined,
      nowMs: NOW, // release is 5 days old → past the 3-day hold window.
    });
    assert.equal(code, 1);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// M11 — provided-but-dead PIN_DRIFT_TOKEN (expired PAT) vs. not-yet-provisioned
// bootstrap. A dead credential can read NO consumer, so every row fails closed
// to an `error` row; that must hard-fail EVEN without --strict (the scheduled
// path can never pass --strict). The absent-token bootstrap — identical row
// shape but token unset — must keep its benign exit-0.
// (temp/audits/workflow-robustness-review-2026-07-05.md M11)
// ---------------------------------------------------------------------------

const DEAD_CRED_CONFIG = {
  platformRepo: PLATFORM,
  consumers: [
    { name: "c1", repo: "o/c1", branch: "main" },
    { name: "c2", repo: "o/c2", branch: "main" },
  ],
};

/**
 * A gh runner where the platform's own release resolution succeeds (that read
 * uses the built-in token, which CAN read this repo) but EVERY cross-repo
 * consumer workflow-listing call fails with a non-404 (auth/transport) — the
 * exact shape of a dead cross-repo PAT. Every consumer therefore becomes an
 * `error` row.
 */
function makeAllConsumersFailRunGh() {
  return (args) => {
    const path = args[1];
    if (path === `repos/${PLATFORM}/releases/latest`) {
      return JSON.stringify({ tag_name: TAG });
    }
    if (path === `repos/${PLATFORM}/git/ref/tags/${TAG}`) {
      return JSON.stringify({ object: { sha: LATEST_SHA, type: "commit" } });
    }
    if (/\/contents\/\.github\/workflows/.test(path)) {
      // 403/5xx (not 404) → fail-closed to an `error` row, mirroring an expired
      // PAT that can no longer read the private consumer repo.
      throw ghHttpError(403, "Forbidden");
    }
    throw new Error(`unexpected gh api path: ${path}`);
  };
}

test("pinDriftTokenProvided: non-empty ⇒ true, empty/absent ⇒ false", () => {
  assert.equal(pinDriftTokenProvided({ PIN_DRIFT_TOKEN: "ghp_live" }), true);
  assert.equal(pinDriftTokenProvided({ PIN_DRIFT_TOKEN: "" }), false);
  assert.equal(pinDriftTokenProvided({}), false);
});

test("allConsumersErrored: true only when every row errored and ≥1 consumer", () => {
  const report = buildReport(DEAD_CRED_CONFIG, makeAllConsumersFailRunGh());
  assert.equal(allConsumersErrored(report), true);
  // A single clean row flips it back to false — that is drift/partial, not a
  // dead credential.
  assert.equal(
    allConsumersErrored({ results: [{ error: "x" }, { drift: true }] }),
    false,
  );
  assert.equal(allConsumersErrored({ results: [] }), false);
});

test("runCli: PROVIDED-but-dead PIN_DRIFT_TOKEN (all rows error) exits 1 with ::error:: even without --strict", () => {
  cfgDir = mkdtempSync(join(tmpdir(), "pin-drift-dead-"));
  const p = join(cfgDir, "consumers.json");
  writeFileSync(p, JSON.stringify(DEAD_CRED_CONFIG));
  const stderr = capture();
  try {
    const code = runCli({
      argv: ["--config", p], // NOTE: no --strict.
      env: { PIN_DRIFT_TOKEN: "ghp_expired" },
      runGh: makeAllConsumersFailRunGh(),
      stdout: capture(),
      stderr,
      summaryPath: undefined,
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /::error::/);
    assert.match(stderr.text(), /credential is dead/);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("runCli: dead-credential also surfaces in the --json envelope (deadCredential:true)", () => {
  cfgDir = mkdtempSync(join(tmpdir(), "pin-drift-dead-json-"));
  const p = join(cfgDir, "consumers.json");
  writeFileSync(p, JSON.stringify(DEAD_CRED_CONFIG));
  const stdout = capture();
  try {
    const code = runCli({
      argv: ["--config", p, "--json"],
      env: { PIN_DRIFT_TOKEN: "ghp_expired" },
      runGh: makeAllConsumersFailRunGh(),
      stdout,
      stderr: capture(),
      summaryPath: undefined,
    });
    assert.equal(code, 1);
    const envelope = JSON.parse(stdout.text());
    assert.equal(envelope.deadCredential, true);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("runCli: ABSENT PIN_DRIFT_TOKEN bootstrap (all rows error, token unset) stays exit 0 — benign", () => {
  cfgDir = mkdtempSync(join(tmpdir(), "pin-drift-bootstrap-"));
  const p = join(cfgDir, "consumers.json");
  writeFileSync(p, JSON.stringify(DEAD_CRED_CONFIG));
  try {
    const code = runCli({
      argv: ["--config", p], // no --strict, no token.
      env: {}, // PIN_DRIFT_TOKEN absent → not-yet-provisioned bootstrap.
      runGh: makeAllConsumersFailRunGh(),
      stdout: capture(),
      stderr: capture(),
      summaryPath: undefined,
    });
    assert.equal(code, 0);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});
