#!/usr/bin/env node
/**
 * stryker-base-config.test.mjs — regression guard for the shared Stryker base
 * config's bail and timeout shape.
 *
 * The bug this pins: with Stryker's default bail (`disableBail: false`), the
 * vitest runner can mark a mutant Survived having completed zero tests — the
 * mutant carries a non-empty covering-test list while its completed-test count
 * is zero. A consumer measured 92 of 345 mutants flipping verdict between two
 * identical runs, and a recorded score of 53.5% against a real 72.29%. A
 * committed baseline taken under bail is therefore a floor under a number
 * nothing measured: the gate is not merely noisy, it is wrong in the direction
 * that hides surviving mutants.
 *
 * Disabling bail is not free — every mutant now runs its full covering set, so
 * the run lengthens. The timeouts in this same base config must move with it,
 * or the suite trades a wrong number for a silent overrun, and an overrun that
 * preserves the prior result and exits clean is the same failure wearing a
 * different mask. That coupling is why bail and the timeouts are asserted
 * together here rather than in two independent tests: re-tightening either half
 * alone reintroduces the defect.
 *
 * This repository ships the config but runs no mutation suite of its own, so
 * the contract is asserted by shape. The run-to-run stability it buys is
 * observable only in a consumer.
 *
 * The delivery half is asserted end-to-end rather than by shape: the suite
 * imports the base through its published package specifier — the same
 * resolution a consumer's `stryker.config.mjs` performs — and checks the
 * settings that arrive. Stryker has no `extends` option (adjudicated against
 * @stryker-mutator/core and @stryker-mutator/api 9.6.1), so the spread import
 * is the only mechanism that delivers anything at all, and it is the only one
 * documented.
 *
 * Run: node --test scripts/stryker-base-config.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const CONFIG_PATH = "config/stryker.base.json";
const PACKAGE_PATH = "package.json";

/**
 * The specifier a consumer's `stryker.config.mjs` imports. Node resolves it
 * through this package's own `exports` map (self-reference), so importing it
 * here exercises the same resolution a consumer gets rather than a stand-in
 * for it.
 */
const PACKAGE_SPECIFIER = "mandrel-platform/stryker.base.json";

/** Stryker's own defaults, per https://stryker-mutator.io/docs/stryker-js/configuration. */
const STRYKER_DEFAULTS = Object.freeze({
  timeoutMS: 5000,
  timeoutFactor: 1.5,
  dryRunTimeoutMinutes: 5,
});

/**
 * The timeout floor this config carried *before* bail was disabled. Bail
 * cut every mutant's run short, so 60s absolute was survivable; without it the
 * covering set runs to completion and the budget has to grow. Asserting
 * strictly above the old value is what makes "raised alongside the bail
 * change" mechanically checkable rather than a claim in a commit message.
 */
const PRE_CHANGE_TIMEOUT_MS = 60000;

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

test("base config disables bail so every mutant runs its full covering set", () => {
  const config = readConfig();

  assert.equal(
    config.disableBail,
    true,
    `${CONFIG_PATH} must set "disableBail": true. Stryker defaults it to false, ` +
      "and under bail the runner can score a mutant Survived having completed " +
      "zero of its covering tests.",
  );
});

test("timeouts are raised above both Stryker's defaults and the pre-change floor", async (t) => {
  const config = readConfig();

  await t.test("timeoutMS clears the pre-bail-change floor", () => {
    assert.equal(
      typeof config.timeoutMS,
      "number",
      `${CONFIG_PATH} must pin "timeoutMS" explicitly, not inherit it.`,
    );
    assert.ok(
      config.timeoutMS > PRE_CHANGE_TIMEOUT_MS,
      `"timeoutMS" is ${config.timeoutMS}; it must exceed the pre-change ` +
        `${PRE_CHANGE_TIMEOUT_MS} because disabling bail lengthens every mutant's run.`,
    );
  });

  await t.test("timeoutFactor is pinned above Stryker's default", () => {
    assert.equal(
      typeof config.timeoutFactor,
      "number",
      `${CONFIG_PATH} must pin "timeoutFactor" explicitly, not inherit it.`,
    );
    assert.ok(
      config.timeoutFactor > STRYKER_DEFAULTS.timeoutFactor,
      `"timeoutFactor" is ${config.timeoutFactor}; it must exceed Stryker's ` +
        `${STRYKER_DEFAULTS.timeoutFactor} default so a full covering set is not ` +
        "clipped as a false Timeout.",
    );
  });

  await t.test("dryRunTimeoutMinutes is pinned above Stryker's default", () => {
    assert.equal(
      typeof config.dryRunTimeoutMinutes,
      "number",
      `${CONFIG_PATH} must pin "dryRunTimeoutMinutes" explicitly, not inherit it.`,
    );
    assert.ok(
      config.dryRunTimeoutMinutes > STRYKER_DEFAULTS.dryRunTimeoutMinutes,
      `"dryRunTimeoutMinutes" is ${config.dryRunTimeoutMinutes}; it must exceed ` +
        `Stryker's ${STRYKER_DEFAULTS.dryRunTimeoutMinutes}-minute default.`,
    );
  });
});

test("a Timeout is not silently absorbed into the score", () => {
  const config = readConfig();

  // `ignoreStatic` legitimately drops static mutants from the denominator.
  // Nothing else may: an option that reclassifies or suppresses a timed-out or
  // errored mutant would let a run that overran still report the prior number
  // and exit clean — the exact failure disabling bail is meant to end.
  assert.equal(
    Object.hasOwn(config, "maxTestRunnerReuse"),
    false,
    'Do not pin "maxTestRunnerReuse" in the shared base; it masks runner-level ' +
      "instability that the timeout budget is supposed to surface.",
  );
  assert.notEqual(
    config.allowEmpty,
    true,
    '"allowEmpty" must stay false/absent: a dry run that executed no tests must ' +
      "fail loudly rather than score an empty suite.",
  );
});

test("the documented spread-import mechanism delivers the bail-free settings", async () => {
  // This is the consumer's own resolution path, not a proxy for it: the
  // specifier below is resolved through the published `exports` map by Node,
  // exactly as `stryker.config.mjs` in a consuming repo resolves it. Asserting
  // the exports-map *string* instead would pass while the file it points at
  // carried the wrong values, or while the entry was absent from `files` — the
  // two ways the recipe can be documented correctly and still deliver nothing.
  const { default: base } = await import(PACKAGE_SPECIFIER, {
    with: { type: "json" },
  });

  assert.equal(
    base.disableBail,
    true,
    `Importing "${PACKAGE_SPECIFIER}" must yield "disableBail": true. A consumer ` +
      "spreading this object into stryker.config.mjs gets whatever this " +
      "resolves to, so a broken export or a stale published file silently " +
      "restores bail.",
  );
  assert.ok(
    base.timeoutMS > PRE_CHANGE_TIMEOUT_MS,
    `Importing "${PACKAGE_SPECIFIER}" must also carry the raised timeout budget ` +
      `that bail-free runs need; got timeoutMS ${base.timeoutMS}.`,
  );

  // The exports map must reach *this* file, or the assertions in the rest of
  // this suite are guarding a config no consumer receives.
  assert.deepEqual(
    base,
    readConfig(),
    `"${PACKAGE_SPECIFIER}" must resolve to ${CONFIG_PATH} — the file every ` +
      "other test here asserts.",
  );
});

test("the config declares no `extends`, which Stryker does not support", () => {
  const config = readConfig();

  // Adjudicated against @stryker-mutator/core 9.6.1 and @stryker-mutator/api
  // 9.6.1: the config reader loads exactly one config file and deep-merges CLI
  // arguments over it — there is no extends resolution step anywhere in it —
  // and `extends` is absent from the 45 top-level properties in the published
  // stryker-core.json schema. A base that advertises an `extends` recipe sends
  // consumers down a path where the settings below arrive not at all.
  assert.equal(
    Object.hasOwn(config, "extends"),
    false,
    `${CONFIG_PATH} must not declare "extends". Stryker has no such option; ` +
      "the supported mechanism is importing this file by its package " +
      "specifier and spreading it (see the README).",
  );
});

test("annotations use the `_comment` suffix Stryker's validator exempts", () => {
  const config = readConfig();

  // Stryker warns "Unknown stryker config option \"<key>\"" for any top-level
  // key that is neither in its schema nor suffixed `_comment`. A prefix-named
  // key like `_comment_disableBail` fails that suffix check, so documenting
  // the base costs every consumer a warning on every run.
  const STRYKER_OPTIONS = new Set([
    "$schema",
    "packageManager",
    "reporters",
    "coverageAnalysis",
    "ignoreStatic",
    "cleanTempDir",
    "disableBail",
    "timeoutMS",
    "timeoutFactor",
    "dryRunTimeoutMinutes",
    "thresholds",
  ]);

  const wouldWarn = Object.keys(config).filter(
    (key) => !STRYKER_OPTIONS.has(key) && !key.endsWith("_comment"),
  );

  assert.deepEqual(
    wouldWarn,
    [],
    `${CONFIG_PATH} keys ${JSON.stringify(wouldWarn)} are neither pinned Stryker ` +
      'options nor suffixed "_comment", so Stryker reports each as an unknown ' +
      "config option in every consumer run. Rename annotations to " +
      "`<topic>_comment`.",
  );
});

test("every pinned Stryker option is still exported to consumers", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));

  // The import test above proves resolution works *here*, where Node's
  // self-reference falls back to the local file. Publication is what carries it
  // to a consumer, and that needs both the exports entry and the files
  // allowlist.
  assert.equal(
    pkg.exports["./stryker.base.json"],
    `./${CONFIG_PATH}`,
    "The ./stryker.base.json export must point at the file this test asserts, " +
      "or consumers import a config nothing guards.",
  );
  assert.ok(
    pkg.files.includes("config/"),
    'The "files" allowlist must publish config/, or the export resolves to a ' +
      "file absent from the tarball.",
  );
});
