#!/usr/bin/env node
/**
 * check-setup-toolchain-store.test.mjs — regression guard for where the pnpm
 * store lives (setup-toolchain).
 *
 * The bug this pins: pnpm derives its default store from PNPM_HOME, which
 * `pnpm/action-setup` sets to `dest` — so the store lands inside the shim dir
 * that the action's own "Clean stale pnpm install dir" step removes at the top
 * of every job. With `cache: 'false'` that left a self-hosted runner with no
 * cache at all (none from GitHub by design, none on disk in fact), re-fetching
 * the whole dependency graph every time. It looks like a warm store right up
 * until a registry blip fails the install (Beestera/swarm-os#1174).
 *
 * Reading the YAML is not enough: what decides the outcome is a shell branch,
 * and the failure mode is silent — a resolution bug just hands pnpm no flag and
 * quietly restores the old behaviour. So this extracts the real `run:` body and
 * executes it against a stub `pnpm` that echoes its argv, the same
 * read-then-execute approach as `check-osv-scan-mode.test.mjs`.
 *
 * Run: node --test scripts/check-setup-toolchain-store.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ACTION = ".github/actions/setup-toolchain/action.yml";
const WORKFLOW = ".github/workflows/pr-quality.yml";

// Minimal indentation-based extraction (dependency-free, mirrors
// check-osv-scan-mode.test.mjs / check-affected-mode.test.mjs).
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
const installScript = runScript(stepByName(actionText, "Install dependencies"));

/**
 * Run the extracted install body with a stub `pnpm` on PATH and return what the
 * stub saw. `TRUST_LOCKFILE` defaults to the action's own default so a case only
 * states the variables it is about.
 */
function runInstall(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-toolchain-store-"));
  try {
    const stub = path.join(dir, "pnpm");
    writeFileSync(stub, '#!/bin/sh\necho "PNPM_ARGV: $*"\n');
    chmodSync(stub, 0o755);
    const script = path.join(dir, "install.sh");
    writeFileSync(script, installScript);
    return execFileSync("bash", [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        TRUST_LOCKFILE: "false",
        STORE_DIR_INPUT: "",
        ...env,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cache 'false' puts the store in the tool cache, outside the pre-cleaned shim dir", () => {
  const out = runInstall({ CACHE_ENABLED: "false", TOOL_CACHE: "/opt/hostedtoolcache" });
  assert.match(out, /--store-dir \/opt\/hostedtoolcache\/pnpm-store/);
  assert.match(out, /--frozen-lockfile/);
});

test("cache 'true' leaves the store alone — setup-node resolves it to decide what to cache", () => {
  const out = runInstall({ CACHE_ENABLED: "true", TOOL_CACHE: "/opt/hostedtoolcache" });
  assert.doesNotMatch(out, /--store-dir/);
});

test("an explicit store-dir input wins, whether caching is on or off", () => {
  for (const CACHE_ENABLED of ["false", "true"]) {
    const out = runInstall({
      CACHE_ENABLED,
      STORE_DIR_INPUT: "/mnt/fast/store",
      TOOL_CACHE: "/opt/hostedtoolcache",
    });
    assert.match(out, /--store-dir \/mnt\/fast\/store/, `cache: '${CACHE_ENABLED}'`);
  }
});

test("no tool cache resolved falls back to pnpm's default rather than passing an empty path", () => {
  const out = runInstall({ CACHE_ENABLED: "false", TOOL_CACHE: "" });
  assert.doesNotMatch(out, /--store-dir/);
});

test("trust-lockfile composes with the store flag instead of replacing it", () => {
  const out = runInstall({
    CACHE_ENABLED: "false",
    TOOL_CACHE: "/opt/hostedtoolcache",
    TRUST_LOCKFILE: "true",
  });
  assert.match(out, /--trust-lockfile/);
  assert.match(out, /--store-dir \/opt\/hostedtoolcache\/pnpm-store/);
});

test("a store path containing a space stays one argument", () => {
  // The reason the script uses positional parameters rather than string
  // concatenation. Also why it cannot use a bash array: this runs on macOS
  // bash 3.2, where "${arr[@]}" under `set -u` errors on an empty array.
  const out = runInstall({ CACHE_ENABLED: "false", STORE_DIR_INPUT: "/mnt/my store" });
  assert.match(out, /--store-dir \/mnt\/my store/);
});

test("the store never resolves inside the directory the pre-clean removes", () => {
  // The whole point. PNPM_DEST is what "Clean stale pnpm install dir" deletes;
  // a store under it is a store that cannot survive a job.
  const out = runInstall({ CACHE_ENABLED: "false", TOOL_CACHE: "/opt/hostedtoolcache" });
  const argv = out.match(/PNPM_ARGV: (.*)/)?.[1] ?? "";
  const storeDir = argv.match(/--store-dir (\S+)/)?.[1] ?? "";
  assert.notEqual(storeDir, "", "expected a --store-dir with caching disabled");
  assert.ok(
    !storeDir.includes("/pnpm/store") && !storeDir.includes("_temp"),
    `store must not live under the pnpm shim dest; got ${storeDir}`,
  );
});

test("pr-quality threads toolchain-store-dir to the shared setup-toolchain anchor", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(
    workflow,
    /^ {6}toolchain-store-dir:$/m,
    "workflow_call input toolchain-store-dir is missing",
  );
  assert.match(
    workflow,
    /store-dir: \$\{\{ inputs\.toolchain-store-dir \}\}/,
    "the setup-toolchain anchor does not pass store-dir through",
  );
  // One anchor, aliased by the other jobs: threading it once must reach them all.
  const aliases = workflow.match(/^ {6}- \*setup-toolchain$/gm) ?? [];
  assert.ok(aliases.length > 0, "expected the setup-toolchain anchor to be aliased");
});
