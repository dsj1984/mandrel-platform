#!/usr/bin/env node
/**
 * args.test.mjs — node:test suite for the shared argv parser
 * (`scripts/lib/args.mjs`, Story #203).
 *
 * Covers the two flag shapes the pin tooling uses (string-with-value and
 * boolean-present), alias resolution, default seeding, and both unknown-flag
 * policies (throw for the strict ratchet, ignore for the lenient portability
 * CLI). Pure — no I/O, fully offline.
 *
 * Run: node --test scripts/lib/args.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFlags } from "./args.mjs";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("parseFlags seeds each flag's declared default when absent", () => {
  const opts = parseFlags([], {
    flags: {
      "--dir": { type: "string", dest: "dir", default: ".github/workflows" },
      "--flag": { type: "boolean", dest: "flag", default: false },
    },
  });
  assert.deepEqual(opts, { dir: ".github/workflows", flag: false });
});

test("parseFlags leaves dest undefined when a flag has no default", () => {
  const opts = parseFlags([], {
    flags: { "--dir": { type: "string", dest: "dir" } },
  });
  assert.equal("dir" in opts, true);
  assert.equal(opts.dir, undefined);
});

// ---------------------------------------------------------------------------
// String flags
// ---------------------------------------------------------------------------

test("parseFlags reads a string flag's value from the next slot", () => {
  const opts = parseFlags(["--dir", "wf"], {
    flags: { "--dir": { type: "string", dest: "dir", default: null } },
  });
  assert.equal(opts.dir, "wf");
});

test("parseFlags throws when a string flag is missing its value", () => {
  assert.throws(
    () =>
      parseFlags(["--dir"], {
        flags: { "--dir": { type: "string", dest: "dir" } },
      }),
    /missing value for "--dir"/
  );
});

test("parseFlags treats a following --flag as a missing value, not the value", () => {
  assert.throws(
    () =>
      parseFlags(["--dir", "--other"], {
        flags: {
          "--dir": { type: "string", dest: "dir" },
          "--other": { type: "boolean", dest: "other" },
        },
      }),
    /missing value for "--dir"/
  );
});

// ---------------------------------------------------------------------------
// Boolean flags
// ---------------------------------------------------------------------------

test("parseFlags sets a boolean flag to its configured value when present", () => {
  const opts = parseFlags(["--no-pin-check"], {
    flags: {
      "--no-pin-check": { type: "boolean", dest: "pinCheck", value: false, default: true },
    },
  });
  assert.equal(opts.pinCheck, false);
});

test("parseFlags defaults a boolean present-value to true", () => {
  const opts = parseFlags(["--help"], {
    flags: { "--help": { type: "boolean", dest: "help", default: false } },
  });
  assert.equal(opts.help, true);
});

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

test("parseFlags resolves an alias to its canonical flag", () => {
  const opts = parseFlags(["-w", "wf", "-h"], {
    flags: {
      "--workflows-dir": { type: "string", dest: "workflowsDir", default: null },
      "--help": { type: "boolean", dest: "help", default: false },
    },
    aliases: { "-w": "--workflows-dir", "-h": "--help" },
  });
  assert.equal(opts.workflowsDir, "wf");
  assert.equal(opts.help, true);
});

// ---------------------------------------------------------------------------
// Unknown-flag policy
// ---------------------------------------------------------------------------

test("parseFlags throws on an unknown flag by default", () => {
  assert.throws(
    () => parseFlags(["--nope"], { flags: {} }),
    /unknown argument "--nope"/
  );
});

test("parseFlags ignores unknown args when onUnknown is 'ignore'", () => {
  const opts = parseFlags(["--nope", "--dir", "wf", "stray"], {
    flags: { "--dir": { type: "string", dest: "dir", default: null } },
    onUnknown: "ignore",
  });
  assert.equal(opts.dir, "wf");
});

// ---------------------------------------------------------------------------
// Realistic combined spec (mirrors check-action-pins.mjs)
// ---------------------------------------------------------------------------

test("parseFlags handles a full mixed spec end-to-end", () => {
  const spec = {
    flags: {
      "--workflows-dir": { type: "string", dest: "workflowsDir", default: ".github/workflows" },
      "--actions-dir": { type: "string", dest: "actionsDir", default: ".github/actions" },
      "--first-party-owner": { type: "string", dest: "firstPartyOwner", default: "dsj1984/mandrel-platform" },
      "--no-single-pin": { type: "boolean", dest: "singlePin", value: false, default: true },
    },
    onUnknown: "throw",
  };
  const opts = parseFlags(
    ["--first-party-owner", "x/y", "--workflows-dir", "wf", "--no-single-pin"],
    spec
  );
  assert.equal(opts.firstPartyOwner, "x/y");
  assert.equal(opts.workflowsDir, "wf");
  assert.equal(opts.actionsDir, ".github/actions");
  assert.equal(opts.singlePin, false);
});
