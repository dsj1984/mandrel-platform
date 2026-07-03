#!/usr/bin/env node
/**
 * check-destructive-migration.test.mjs — node:test suite for the platformized
 * destructive-migration label guard (Story #111).
 *
 * The guard's detection core (`detectDestructiveMigrations`) takes an injected
 * `readFile` seam, so the whole signal-detection pipeline is exercised offline
 * with in-memory fixtures — no filesystem, no `git`, no `gh`. This is the
 * "validated via self-test" half of the Story's acceptance contract; the
 * cross-repo smoke (pr-quality.yml consumed by the smoke repo) is the
 * end-to-end half.
 *
 * Run: node scripts/check-destructive-migration.test.mjs  (or `node --test scripts/`)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_MIGRATION_GLOBS,
  DEFAULT_OVERRIDE_LABEL,
  detectDestructiveMigrations,
  formatStepSummary,
  globToRegExp,
  isMigrationFile,
  parseArgs,
  scanMigrationText,
  stripComments,
} from "./check-destructive-migration.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-destructive-migration.mjs");

// Build a readFile seam from an in-memory { path: text } map.
function fakeReader(files) {
  return (path) => {
    if (!(path in files)) {
      const err = new Error(`ENOENT: ${path}`);
      err.code = "ENOENT";
      throw err;
    }
    return files[path];
  };
}

// ── globToRegExp / isMigrationFile ─────────────────────────────────────────

test("globToRegExp: `**` crosses path separators, `*` does not", () => {
  assert.ok(globToRegExp("**/migrations/**").test("apps/db/migrations/0001.sql"));
  assert.ok(globToRegExp("**/migrations/**").test("migrations/0001.sql"));
  assert.ok(!globToRegExp("*.sql").test("db/x.sql")); // single * stays in-segment
  assert.ok(globToRegExp("*.sql").test("x.sql"));
});

test("isMigrationFile: matches migration globs and any .sql tail", () => {
  assert.ok(isMigrationFile("apps/api/migrations/0007_drop.ts"));
  assert.ok(isMigrationFile("drizzle/0001_init.sql"));
  assert.ok(isMigrationFile("0007_drop_users.sql")); // bare .sql counts
  assert.ok(!isMigrationFile("src/services/user.ts"));
  assert.ok(!isMigrationFile("README.md"));
});

test("isMigrationFile: honours a custom glob set", () => {
  const globs = ["**/db/changes/**"];
  assert.ok(isMigrationFile("pkg/db/changes/x.ts", globs));
  assert.ok(!isMigrationFile("pkg/migrations/x.ts", globs)); // default glob not in set
});

// ── stripComments ──────────────────────────────────────────────────────────

test("stripComments: removes -- , // and inline /* */ comments", () => {
  assert.equal(stripComments("CREATE TABLE x; -- DROP TABLE y").trim(), "CREATE TABLE x;");
  assert.equal(stripComments("ok(); // DROP TABLE y").trim(), "ok();");
  assert.equal(stripComments("a /* DROP TABLE y */ b").replace(/\s+/g, " ").trim(), "a b");
});

// ── scanMigrationText: the destructive signal union ────────────────────────

test("scanMigrationText: detects DROP TABLE / COLUMN / INDEX / etc.", () => {
  assert.deepEqual(scanMigrationText("DROP TABLE users;"), ["DROP statement"]);
  assert.deepEqual(scanMigrationText("drop  column email"), ["DROP statement"]);
  assert.deepEqual(scanMigrationText("DROP INDEX idx_users_email;"), ["DROP statement"]);
});

test("scanMigrationText: detects ALTER TABLE … DROP", () => {
  const signals = scanMigrationText("ALTER TABLE users DROP COLUMN legacy_id;");
  assert.ok(signals.includes("ALTER TABLE … DROP"));
});

test("scanMigrationText: detects TRUNCATE", () => {
  assert.deepEqual(scanMigrationText("TRUNCATE audit_log;"), ["TRUNCATE"]);
});

test("scanMigrationText: detects drizzle destructive ops", () => {
  assert.deepEqual(
    scanMigrationText("await db.schema.dropColumn('users', 'legacy');"),
    ["drizzle destructive op"]
  );
  assert.deepEqual(
    scanMigrationText("table.dropConstraint('fk_x')"),
    ["drizzle destructive op"]
  );
});

test("scanMigrationText: clean migration yields no signals", () => {
  assert.deepEqual(
    scanMigrationText("CREATE TABLE users (id INTEGER PRIMARY KEY);\nADD COLUMN email TEXT;"),
    []
  );
});

test("scanMigrationText: a DROP only in a comment does NOT trip the guard", () => {
  assert.deepEqual(scanMigrationText("-- DROP TABLE users; (rolled back)"), []);
  assert.deepEqual(scanMigrationText("// dropTable('users')"), []);
});

test("scanMigrationText: de-duplicates repeated signals", () => {
  const signals = scanMigrationText("DROP TABLE a;\nDROP TABLE b;");
  assert.deepEqual(signals, ["DROP statement"]);
});

// ── detectDestructiveMigrations: end-to-end over a changed set ─────────────

test("detect: flags a destructive migration file", () => {
  const files = { "db/migrations/0007_drop.sql": "DROP TABLE users;" };
  const res = detectDestructiveMigrations({
    changedFiles: Object.keys(files),
    readFile: fakeReader(files),
  });
  assert.equal(res.destructive, true);
  assert.equal(res.findings.length, 1);
  assert.deepEqual(res.findings[0].signals, ["DROP statement"]);
});

test("detect: ignores non-migration files even if they mention DROP", () => {
  const files = {
    "src/sql-builder.ts": "const q = 'DROP TABLE foo';",
    "docs/notes.md": "We will DROP COLUMN later.",
  };
  const res = detectDestructiveMigrations({
    changedFiles: Object.keys(files),
    readFile: fakeReader(files),
  });
  assert.equal(res.destructive, false);
  assert.deepEqual(res.findings, []);
});

test("detect: clean migration passes", () => {
  const files = { "db/migrations/0008_add.sql": "ALTER TABLE users ADD COLUMN nickname TEXT;" };
  const res = detectDestructiveMigrations({
    changedFiles: Object.keys(files),
    readFile: fakeReader(files),
  });
  assert.equal(res.destructive, false);
});

test("detect: a deleted migration file is itself a destructive signal", () => {
  const res = detectDestructiveMigrations({
    changedFiles: ["db/migrations/0005_old.sql"],
    readFile: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(res.destructive, true);
  assert.deepEqual(res.findings[0].signals, ["deleted migration file"]);
});

test("detect: mixed set reports only the destructive migration", () => {
  const files = {
    "db/migrations/0009_add.sql": "ALTER TABLE x ADD COLUMN y TEXT;",
    "db/migrations/0010_drop.sql": "ALTER TABLE x DROP COLUMN z;",
    "src/app.ts": "doStuff();",
  };
  const res = detectDestructiveMigrations({
    changedFiles: Object.keys(files),
    readFile: fakeReader(files),
  });
  assert.equal(res.destructive, true);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].file, "db/migrations/0010_drop.sql");
});

// ── Contract constants ─────────────────────────────────────────────────────

test("override label and default globs are the documented contract values", () => {
  assert.equal(DEFAULT_OVERRIDE_LABEL, "migration:destructive-ok");
  assert.deepEqual(DEFAULT_MIGRATION_GLOBS, ["**/migrations/**", "**/drizzle/**"]);
});

// ── parseArgs: the CLI surface pr-quality.yml drives ───────────────────────

test("parseArgs: defaults", () => {
  const opts = parseArgs([]);
  assert.equal(opts.changedFiles, null);
  assert.equal(opts.labelPresent, false);
  assert.equal(opts.overrideLabel, DEFAULT_OVERRIDE_LABEL);
  assert.deepEqual(opts.globs, DEFAULT_MIGRATION_GLOBS);
});

test("parseArgs: --override-label, --label-present, --migration-glob, --changed-files", () => {
  const opts = parseArgs([
    "--changed-files", "-",
    "--label-present",
    "--override-label", "db:drop-ok",
    "--migration-glob", "**/db/changes/**, **/sql/**",
  ]);
  assert.equal(opts.changedFiles, "-");
  assert.equal(opts.labelPresent, true);
  assert.equal(opts.overrideLabel, "db:drop-ok");
  assert.deepEqual(opts.globs, ["**/db/changes/**", "**/sql/**"]);
});

// ── formatStepSummary: the job-summary block parity contract ────────────────

test("formatStepSummary: blocked shape names the override label and findings", () => {
  const md = formatStepSummary({
    findings: [{ file: "db/migrations/0010_drop.sql", signals: ["DROP statement"] }],
    labelPresent: false,
    overrideLabel: "migration:destructive-ok",
  });
  assert.ok(md.includes("### ❌ Destructive-migration guard — BLOCKED"));
  assert.ok(md.includes("`migration:destructive-ok`"));
  assert.ok(md.includes("db/migrations/0010_drop.sql → DROP statement"));
});

test("formatStepSummary: allowed shape reports the finding without blocking language", () => {
  const md = formatStepSummary({
    findings: [{ file: "db/migrations/0010_drop.sql", signals: ["TRUNCATE"] }],
    labelPresent: true,
    overrideLabel: "db:drop-ok",
  });
  assert.ok(md.includes("### Destructive-migration guard — ALLOWED via override"));
  assert.ok(md.includes("`db:drop-ok`"));
  assert.ok(!md.includes("BLOCKED"));
});

// ── CLI end-to-end: exit codes are the gate (behavioural-parity proof) ──────

function runCli(args, { input = "", env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      input,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("CLI: destructive migration without the label blocks (exit 1)", () => {
  const root = mkdtempSync(join(tmpdir(), "destmig-"));
  try {
    mkdirSync(join(root, "db", "migrations"), { recursive: true });
    writeFileSync(join(root, "db", "migrations", "0010_drop.sql"), "DROP TABLE users;\n");
    const res = runCli(
      ["--changed-files", "-", "--repo-root", root, "--override-label", "db:drop-ok"],
      { input: "db/migrations/0010_drop.sql\n" }
    );
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes("'db:drop-ok' is NOT applied — blocking"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: the override label downgrades the block to a warning (exit 0)", () => {
  const root = mkdtempSync(join(tmpdir(), "destmig-"));
  try {
    mkdirSync(join(root, "db", "migrations"), { recursive: true });
    writeFileSync(join(root, "db", "migrations", "0010_drop.sql"), "DROP TABLE users;\n");
    const res = runCli(
      ["--changed-files", "-", "--repo-root", root, "--label-present"],
      { input: "db/migrations/0010_drop.sql\n" }
    );
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes(`'${DEFAULT_OVERRIDE_LABEL}' is applied — allowing`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: comment-only DROP does not trip the guard (exit 0)", () => {
  const root = mkdtempSync(join(tmpdir(), "destmig-"));
  try {
    mkdirSync(join(root, "db", "migrations"), { recursive: true });
    writeFileSync(
      join(root, "db", "migrations", "0011_note.sql"),
      "-- DROP TABLE users; (rolled back)\nALTER TABLE users ADD COLUMN nickname TEXT;\n"
    );
    const res = runCli(["--changed-files", "-", "--repo-root", root], {
      input: "db/migrations/0011_note.sql\n",
    });
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes("No destructive migration detected"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: missing --changed-files is a usage error (exit 2)", () => {
  const res = runCli([]);
  assert.equal(res.code, 2);
  assert.ok(res.stderr.includes("--changed-files"));
});

test("CLI: a finding writes the GITHUB_STEP_SUMMARY block when the env var is set", () => {
  const root = mkdtempSync(join(tmpdir(), "destmig-"));
  try {
    mkdirSync(join(root, "db", "migrations"), { recursive: true });
    writeFileSync(join(root, "db", "migrations", "0010_drop.sql"), "TRUNCATE audit_log;\n");
    const summaryFile = join(root, "step-summary.md");
    const res = runCli(
      ["--changed-files", "-", "--repo-root", root],
      { input: "db/migrations/0010_drop.sql\n", env: { GITHUB_STEP_SUMMARY: summaryFile } }
    );
    assert.equal(res.code, 1);
    const summary = readFileSync(summaryFile, "utf8");
    assert.ok(summary.includes("### ❌ Destructive-migration guard — BLOCKED"));
    assert.ok(summary.includes("TRUNCATE"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
