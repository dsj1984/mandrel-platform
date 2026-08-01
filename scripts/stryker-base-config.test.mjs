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
 * Run: node --test scripts/stryker-base-config.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const CONFIG_PATH = "config/stryker.base.json";
const PACKAGE_PATH = "package.json";

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

test("the config stays reachable to consumers by specifier", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));

  // The shape above only protects the fleet while every consumer keeps
  // resolving this file through the exports map rather than a copied fork.
  assert.equal(
    pkg.exports["./stryker.base.json"],
    `./${CONFIG_PATH}`,
    "The ./stryker.base.json export must point at the file this test asserts, " +
      "or consumers extend a config nothing guards.",
  );
});
