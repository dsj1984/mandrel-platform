#!/usr/bin/env node
/**
 * check-playwright-browser-install.test.mjs — regression guard for the e2e
 * tier's Playwright browser install (Story #396).
 *
 * The bug this pins: the install step was gated on
 * `steps.playwright-cache.outputs.cache-hit != 'true'`. `actions/cache` sets
 * `cache-hit: true` on an EXACT key match and says nothing about what the
 * restored tree actually contains, so the gate treats "an entry exists under
 * this key" as proof the binaries are present. A cache saved partially — or
 * saved before a Playwright patch added a browser variant under the same
 * version key — therefore skips the only step that would repair it, and every
 * scenario dies in milliseconds at `browserType.launch`.
 *
 * It could not self-heal in either direction: the hit kept skipping the
 * repair, and Actions cache entries are IMMUTABLE under a key (`actions/cache`
 * skips its post-job save on an exact hit), so the bad entry was never
 * overwritten. Hence the two halves of the fix this file guards:
 *
 *   1. The install runs unconditionally, so a bad restore costs a re-download
 *      rather than the run. This is not a new cost — the pre-fix hit path
 *      already ran `playwright install-deps`, so the same OS-dependency step
 *      ran on BOTH branches; collapsing them adds only a browser-manifest
 *      verify.
 *   2. A caller-settable salt is folded into the cache key, so an operator can
 *      stop paying that repair on every run by moving to a fresh key — without
 *      hand-deleting caches through the GitHub API.
 *
 * Asserting the key by string-matching its spelling would pin the text rather
 * than the contract. The property that actually matters is RELATIONAL: the
 * default salt must leave the key byte-for-byte identical to the pre-fix one
 * (or every consumer's warm cache is silently invalidated by the upgrade), and
 * distinct salts must produce distinct keys (or the escape hatch does not
 * escape). So this extracts the real key template and resolves it under
 * several salt values, the same read-then-execute approach as
 * check-toolchain-cache-default.test.mjs.
 *
 * Run: node --test scripts/check-playwright-browser-install.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const QUALITY = ".github/workflows/pr-quality.yml";
const SALT_INPUT = "playwright-cache-salt";

/**
 * The fixed literal the resolve step falls back to (Story #400).
 *
 * It must stay a CONSTANT. A host- or run-derived fallback (`$GITHUB_SHA`, a
 * date) satisfies "the step no longer fails" while minting a new cache key on
 * every run — permanently defeating the ~460 MiB cache the step exists to
 * label, which is a worse outcome than the abort it replaced.
 */
const SENTINEL = "unresolved";

/** The exact key template the tier carried before Story #396. */
const PRE_FIX_KEY = "playwright-${{ runner.os }}-${{ steps.pw-version.outputs.version }}";
const PRE_FIX_RESTORE_KEY = "playwright-${{ runner.os }}-";

const text = readFileSync(QUALITY, "utf8");

/**
 * The workflow with whole-line `#` comments removed.
 *
 * The guard is about what the workflow DOES, not what it says: the tier
 * carries a comment naming the very expression this file forbids, so that a
 * future reader is told not to reintroduce it. Scanning raw text would let
 * that warning fail the check it exists to support. Only leading-`#` lines are
 * dropped — never a mid-line `#`, which could sit inside a quoted value.
 */
const code = text
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * The `steps:` block of the named job, sliced by indentation.
 *
 * Scans lines rather than building a `new RegExp` around the job name: a
 * dynamically-constructed regex is a SAST finding (ReDoS surface) and buys
 * nothing here, since the block boundary is just indentation.
 */
function jobBlock(name, source = code) {
  const lines = source.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `${QUALITY}: job \`${name}\` not found`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      out.push(lines[i]);
      continue;
    }
    // Dedent to the job-name level or beyond → the block ended.
    if (lines[i].match(/^(\s*)/)[1].length <= 2) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/**
 * The `- name: <step>` … block for one step of a job, sliced by indentation.
 *
 * `source` defaults to the comment-stripped text — right for asserting what the
 * workflow DOES. Pass the raw `text` when the block is going to be EXECUTED, so
 * the guard runs the same script the runner does rather than a stripped
 * paraphrase of it.
 */
function stepBlock(job, stepName, source = code) {
  const lines = jobBlock(job, source).split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.notEqual(start, -1, `${QUALITY}: step \`${stepName}\` not found in job \`${job}\``);
  const indent = lines[start].match(/^(\s*)/)[1].length;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const width = lines[i].match(/^(\s*)/)[1].length;
    // A sibling list item (or a dedent) at the same indent ends this step.
    if (width <= indent) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** The literal `default:` of the named workflow_call input. */
function inputDefault(name) {
  const lines = code.split("\n");
  const start = lines.indexOf(`      ${name}:`);
  assert.notEqual(start, -1, `${QUALITY}: workflow_call input \`${name}\` not found`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (lines[i].match(/^(\s*)/)[1].length <= 6) break;
    const d = lines[i].match(/^\s*default:\s*(.+)$/);
    if (d) return d[1].trim();
  }
  return assert.fail(`${QUALITY}: input \`${name}\` has no default`);
}

/** The `key:` / `restore-keys:` templates of the cache step. */
function cacheKeys() {
  const block = stepBlock("e2e", "Cache Playwright browsers");
  const key = block.match(/^\s*key:\s*(.+)$/m);
  assert.ok(key, `${QUALITY}: the cache step has no \`key:\``);
  const restore = block.match(/^\s*restore-keys:\s*\|\s*\n\s*(.+)$/m);
  assert.ok(restore, `${QUALITY}: the cache step has no \`restore-keys:\``);
  return { key: key[1].trim(), restoreKey: restore[1].trim() };
}

/**
 * Resolve a key template for one salt value, leaving every other `${{ … }}`
 * placeholder untouched so the result is directly comparable to the pre-fix
 * literal. Split/join rather than a constructed regex, for the SAST reason
 * above.
 */
function resolveSalt(template, salt) {
  return template
    .split(`\${{ inputs.${SALT_INPUT} }}`)
    .join(salt)
    .split(`\${{ inputs['${SALT_INPUT}'] }}`)
    .join(salt);
}

/**
 * The dedented body of a step's `run: |` block, taken from the RAW workflow
 * text so the guard executes what the runner executes.
 *
 * This is only sound while the block holds no `${{ }}` expression — the runner
 * substitutes those before bash ever sees them, and there is no substituting
 * them here. A dedicated test below pins that precondition rather than leaving
 * it as a silent assumption.
 */
function runScript(job, stepName) {
  const lines = stepBlock(job, stepName, text).split("\n");
  const start = lines.findIndex((l) => l.trim() === "run: |");
  assert.notEqual(start, -1, `${QUALITY}: step \`${stepName}\` has no \`run: |\` block`);
  const body = lines.slice(start + 1);
  assert.ok(body.length > 0, `${QUALITY}: step \`${stepName}\` has an empty \`run:\` block`);
  const indent = body[0].match(/^(\s*)/)[1].length;
  return body.map((l) => l.slice(indent)).join("\n");
}

/**
 * Run a script under the runner's own shell invocation, in a throwaway cwd.
 *
 * GitHub executes `shell: bash` as `bash --noprofile --norc -eo pipefail
 * {0}` — the `-e` is the whole reason the pre-fix step could kill the tier, so
 * the guard reproduces the flags exactly. `cwd` is passed to `spawnSync` and
 * `process.chdir` is never called: this file's later tests read
 * `docs/reusable-workflows.md` by a RELATIVE path, and a leaked cwd would fail
 * them for a reason that has nothing to do with the change under test.
 */
function runInDir(script, cwd) {
  const outPath = join(cwd, "github-output");
  writeFileSync(outPath, "");
  const scriptPath = join(cwd, "step.sh");
  writeFileSync(scriptPath, script);
  const res = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", scriptPath], {
    cwd,
    env: { ...process.env, GITHUB_OUTPUT: outPath },
    encoding: "utf8",
  });
  const outputs = new Map();
  for (const line of readFileSync(outPath, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) outputs.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return { status: res.status, stderr: res.stderr, outputs };
}

/** A temp directory, removed however the callback exits. */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pw-version-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Plant a resolvable `@playwright/test` under `dir`.
 *
 * The `exports` map matters: the real package restricts subpath access and
 * lists `"./package.json"` explicitly. Without it here, a resolution strategy
 * that is ILLEGAL against the real package would still pass this guard.
 */
function plantPlaywright(dir, version) {
  const pkgDir = join(dir, "node_modules", "@playwright", "test");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@playwright/test",
      version,
      exports: { "./package.json": "./package.json" },
    }),
  );
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

test("no step gates on the Playwright cache-hit output", () => {
  // AC-1, the defect itself. `cache-hit` is true whenever an entry EXISTS
  // under the key — it is not a statement about the entry's contents, so no
  // step may treat it as one.
  assert.doesNotMatch(
    code,
    /steps\.playwright-cache\.outputs\.cache-hit/,
    "a cache-hit gate is back: a partial cache would again be fatal rather than repaired",
  );
});

test("the browser install runs unconditionally with --with-deps", () => {
  // AC-1. Unconditional is the whole fix — an `if:` of ANY shape here
  // reintroduces a path where a bad restore is never repaired.
  const block = stepBlock("e2e", "Install Playwright browsers");
  assert.match(block, /run:\s*pnpm exec playwright install --with-deps/);
  assert.doesNotMatch(
    block,
    /^\s*if:/m,
    "the install step must carry no condition — see this file's header",
  );
});

test("the cache-hit-only OS-dependency step is gone", () => {
  // AC-1. Its only reason to exist was the hit branch; leaving it behind
  // would run `install-deps` twice on every run.
  assert.doesNotMatch(
    jobBlock("e2e"),
    /- name: Install browser OS dependencies/,
    "the split OS-dependency step is redundant once the install is unconditional",
  );
});

test(`the ${SALT_INPUT} input exists with a literal default`, () => {
  // AC-2. A `workflow_call` default may not hold an expression: GitHub
  // resolves defaults during interface validation, before any context exists,
  // and check-workflow-portability.mjs Rule 2 rejects it outright.
  const value = inputDefault(SALT_INPUT);
  assert.doesNotMatch(value, /\$\{\{/, "a workflow_call default may not hold an expression");
  assert.equal(value, "''");
});

test("the cache key interpolates the salt input", () => {
  // AC-2. Declared-but-unread is the failure mode that makes the escape hatch
  // silently inert.
  const { key } = cacheKeys();
  assert.match(key, /inputs\./, "the key does not read any input");
  assert.notEqual(
    resolveSalt(key, "probe"),
    key,
    `the key does not interpolate \`inputs.${SALT_INPUT}\``,
  );
});

test("the default salt leaves the cache key byte-for-byte unchanged", () => {
  // AC-3 — the compatibility contract. If this drifts, every consumer's warm
  // ~460 MiB cache is silently orphaned the moment they adopt the release,
  // which is a worse outage than the bug being fixed.
  const { key, restoreKey } = cacheKeys();
  assert.equal(resolveSalt(key, ""), PRE_FIX_KEY);
  assert.equal(resolveSalt(restoreKey, ""), PRE_FIX_RESTORE_KEY);
});

test("distinct salts produce distinct cache keys", () => {
  // AC-4 — the escape hatch actually escapes. A salt that collapses into the
  // same key (interpolated into a comment, or into a segment the key does not
  // use) would leave the operator back at deleting caches by hand.
  const { key } = cacheKeys();
  const base = resolveSalt(key, "");
  const bumped = resolveSalt(key, "-v2");
  const bumpedAgain = resolveSalt(key, "-v3");
  assert.notEqual(bumped, base, "a non-empty salt must not resolve to the default key");
  assert.notEqual(bumpedAgain, bumped, "two different salts must not collide");
});

test("the salt does not disturb the restore-keys prefix", () => {
  // A deliberate asymmetry, not an oversight: the prefix fallback must keep
  // matching older entries so a salt bump still gets a WARM start. The
  // unconditional install then fills whatever the old entry was missing, and
  // because a prefix (non-exact) restore leaves `cache-hit` false, the
  // post-job save writes a complete tree under the NEW key. That is what
  // completes the escape — one run, no manual cache deletion.
  const { restoreKey } = cacheKeys();
  assert.equal(
    resolveSalt(restoreKey, "-v2"),
    PRE_FIX_RESTORE_KEY,
    "restore-keys must stay salt-free so a bumped key still warm-starts",
  );
});

test("the documented input row states the default and the escape semantics", () => {
  // AC-6. The row is the consumer-facing contract for a knob whose entire
  // purpose is manual operator use — undocumented, it may as well not exist.
  const docs = readFileSync("docs/reusable-workflows.md", "utf8");
  const rows = docs
    .split("\n")
    .filter((l) => l.startsWith(`| \`${SALT_INPUT}\``) && /\|\s*string\s*\|/.test(l));
  assert.equal(rows.length, 1, "expected exactly one documented input row");
  assert.match(rows[0], /`''`/, "row does not state the empty-string default");
  assert.match(rows[0], /cache/i, "row does not explain what the salt affects");
});

// ---------------------------------------------------------------------------
// Version resolution (Story #400)
//
// The pre-fix step ran `node -e "…require('./node_modules/@playwright/test/…')"`
// as a bare `VAR=$(…)` assignment. Under `bash -eo pipefail` that propagates
// the substitution's exit status, so on a consumer whose ROOT node_modules
// lacks the package — pnpm's isolated layout only symlinks a root DIRECT
// dependency, so a workspace-owned Playwright has no such path — `set -e`
// killed the step and took the whole e2e tier with it. A step that exists only
// to LABEL a cache key must never be able to do that.
// ---------------------------------------------------------------------------

test("version resolution uses a bare specifier, not a hardcoded root path", () => {
  const block = stepBlock("e2e", "Resolve Playwright version");
  assert.doesNotMatch(
    block,
    /\.\/node_modules\/@playwright\/test/,
    "a hardcoded root path is back: a workspace-owned Playwright would not resolve",
  );
  assert.match(
    block,
    /require\((['"])@playwright\/test\/package\.json\1\)/,
    "resolution must go through the bare specifier, which walks node_modules",
  );
});

test("the resolve step's run block holds no workflow expression", () => {
  // The precondition for executing this step in the tests below: the runner
  // substitutes `${{ }}` before bash sees it, and nothing substitutes it here.
  // Threading an input into the block would leave the guard asserting against
  // a string that never runs.
  assert.doesNotMatch(
    runScript("e2e", "Resolve Playwright version"),
    /\$\{\{/,
    "keep the run block expression-free so the guard executes the runner's text",
  );
});

test("the sentinel is assigned as a fixed literal", () => {
  // Invariant 2 (see SENTINEL above). Assert the SHAPE of the assignment, not
  // merely that the step stopped failing — `PW_VERSION=$(date +%F)` would pass
  // a stability check across two runs in the same second and still rekey the
  // cache on every push.
  const script = runScript("e2e", "Resolve Playwright version");
  const assignments = script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#") && l.includes(`=${SENTINEL}`));
  assert.equal(assignments.length, 1, `expected exactly one \`=${SENTINEL}\` assignment`);
  const [assignment] = assignments;
  assert.match(assignment, /^[A-Za-z_][A-Za-z0-9_]*=unresolved$/, "the sentinel must be a literal");
  assert.ok(!assignment.includes("$("), "the sentinel must not be command-substituted");
  assert.ok(!assignment.includes("${"), "the sentinel must not be parameter-expanded");
});

test("an unresolvable @playwright/test yields the sentinel instead of failing the tier", () => {
  // The defect itself. A temp dir has no `node_modules` anywhere up its tree,
  // which is exactly the consumer shape that lost the tier.
  const script = runScript("e2e", "Resolve Playwright version");
  withTempDir((dir) => {
    const { status, outputs, stderr } = runInDir(script, dir);
    assert.equal(status, 0, `the step must not fail the tier; stderr:\n${stderr}`);
    assert.equal(outputs.get("version"), SENTINEL);
  });
});

test("the sentinel is stable across runs, so the cache key does not churn", () => {
  // Invariant 2 again, from the outside: a value that varies run to run mints a
  // fresh key every time and permanently defeats the cache.
  const script = runScript("e2e", "Resolve Playwright version");
  const read = () => withTempDir((dir) => runInDir(script, dir).outputs.get("version"));
  const first = read();
  // Pin the value, not just its stability: two runs that both emit NOTHING are
  // trivially equal, which would let a step that never writes the output pass.
  assert.equal(first, SENTINEL);
  assert.equal(read(), first);
});

test("a resolvable @playwright/test produces the pre-fix cache key exactly", () => {
  // The compatibility contract, end to end: what the step actually emits, fed
  // through the real key template at the default salt, must equal the key
  // consumers' warm caches already sit under.
  const script = runScript("e2e", "Resolve Playwright version");
  const version = "1.61.1";
  const resolved = withTempDir((dir) => {
    plantPlaywright(dir, version);
    const { status, outputs, stderr } = runInDir(script, dir);
    assert.equal(status, 0, `stderr:\n${stderr}`);
    return outputs.get("version");
  });
  assert.equal(resolved, version, "the step must report the resolved package's version");

  const { key } = cacheKeys();
  const withVersion = resolveSalt(key, "")
    .split("${{ steps.pw-version.outputs.version }}")
    .join(resolved);
  assert.equal(withVersion, `playwright-\${{ runner.os }}-${version}`);
});
