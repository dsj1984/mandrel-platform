#!/usr/bin/env node
/**
 * check-destructive-migration.mjs
 *
 * Destructive-migration label guard (Story #111).
 *
 * Platformizes the destructive-migration guard that domio and athportal each
 * hand-rolled and that swarm-os was missing entirely. A PR that introduces a
 * destructive database migration (a `DROP`, an `ALTER ... DROP`, or a
 * destructive drizzle-kit operation in a changed migration file) is BLOCKED
 * unless a reviewer applies an explicit acknowledgement label
 * (default: `migration:destructive-ok`).
 *
 * This is the static, PR-time half of the contract: it inspects the *changed
 * migration files* for a destructive SQL/drizzle signal — it does NOT
 * introspect a live database. The override is an explicit, human-applied PR
 * label, so the destructive change still ships, but only with a deliberate
 * acknowledgement on the record.
 *
 * Detection is a best-of-breed UNION of the two local guards it generalizes:
 *   • `DROP TABLE` / `DROP COLUMN` / `DROP INDEX` / `DROP SCHEMA` / `DROP …`
 *   • `ALTER TABLE … DROP COLUMN` / `ALTER TABLE … DROP CONSTRAINT`
 *   • `TRUNCATE`
 *   • drizzle-kit destructive ops emitted into a migration:
 *       `.dropTable(` / `.dropColumn(` / `.dropIndex(` / `.dropConstraint(`
 *   • a drizzle journal/breakpoint marker paired with a `DROP` statement
 * Comment lines (`--`, `/* … *​/`, `//`) are stripped before matching so a
 * `DROP` mentioned only in a comment does not trip the guard.
 *
 * The guard only inspects files whose path matches a migration glob (default
 * `**​/migrations/**` and `**​/drizzle/**` plus a `*.sql` tail), so an
 * unrelated source file mentioning `DROP` in a string never blocks a PR.
 *
 * --------------------------------------------------------------------------
 * Usage (CLI — exit code is the gate):
 *   node scripts/check-destructive-migration.mjs \
 *     --changed-files <file-with-one-path-per-line> \
 *     [--label-present] \
 *     [--override-label <name>] \
 *     [--migration-glob '**​/migrations/**,**​/drizzle/**'] \
 *     [--repo-root <dir>]
 *
 *   • --changed-files   Path to a newline-delimited list of PR-changed files
 *                       (e.g. the output of `git diff --name-only base..head`).
 *                       Use `-` to read the list from stdin.
 *   • --label-present   Pass when the override acknowledgement label is on the
 *                       PR. Overrides a destructive finding (exit 0 with a
 *                       warning) instead of blocking.
 *   • --override-label  The acknowledgement label NAME to cite in messages and
 *                       the step summary (behaviour is still driven solely by
 *                       --label-present). Default `migration:destructive-ok`.
 *   • --migration-glob  Comma-separated migration path globs. Default
 *                       `**​/migrations/**,**​/drizzle/**`.
 *   • --repo-root       Root to resolve changed-file paths against. Default cwd.
 *
 * When `GITHUB_STEP_SUMMARY` is set (i.e. running inside a GitHub Actions
 * step) and a destructive finding exists, a markdown summary block (ALLOWED
 * via override / BLOCKED) is appended to that file — the same job-summary
 * surface the previous in-workflow bash implementation wrote.
 *
 * Exit codes:
 *   0 — no destructive migration in the changed set, OR a destructive
 *       migration is present AND the override label is applied.
 *   1 — a destructive migration is present and the override label is absent
 *       (the blocking case; the offending files + signals are named on stderr).
 *   2 — a usage / IO error (bad args, unreadable file).
 *
 * The label name is part of the documented contract — see
 * docs/reusable-workflows.md (`pr-quality.yml` → migration guard).
 */

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The override acknowledgement label. Documented in docs/reusable-workflows.md.
export const DEFAULT_OVERRIDE_LABEL = "migration:destructive-ok";

// Default migration path globs. A changed file must match one of these for the
// destructive-signal scan to even look at it.
export const DEFAULT_MIGRATION_GLOBS = ["**/migrations/**", "**/drizzle/**"];

// ---------------------------------------------------------------------------
// Pure helpers (exported for the self-test)
// ---------------------------------------------------------------------------

/**
 * Convert a restricted glob (supporting `**`, `*`, and literals) into a RegExp.
 * `**` matches across path separators; `*` matches within a single segment.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` → any chars including `/`. Consume an optional trailing slash so
        // `**/migrations/**` matches `migrations/x` (no leading dir) too.
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        // single `*` → any chars except `/`
        re += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Is `filePath` a migration file per the supplied globs? A `.sql` file is also
 * always treated as a migration candidate (drizzle/raw-SQL migrations land as
 * `*.sql`), so a bare `0007_drop_users.sql` is covered even outside a
 * `migrations/` directory.
 *
 * @param {string} filePath  Repo-relative path (forward slashes).
 * @param {string[]} globs
 * @returns {boolean}
 */
export function isMigrationFile(filePath, globs = DEFAULT_MIGRATION_GLOBS) {
  const norm = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.endsWith(".sql")) return true;
  return globs.some((g) => globToRegExp(g).test(norm));
}

/**
 * Strip SQL / JS comments from a single line so a `DROP` that appears only in a
 * comment does not trip the guard. Handles `--`, `//`, and a `/* … *​/` opened
 * and closed on the same line. (Multi-line block comments are rare in migration
 * files and conservatively left in — a false positive there is acknowledgeable
 * via the override label.)
 *
 * @param {string} line
 * @returns {string}
 */
export function stripComments(line) {
  let out = line.replace(/\/\*.*?\*\//g, " ");
  const dashIdx = out.indexOf("--");
  if (dashIdx !== -1) out = out.slice(0, dashIdx);
  const slashIdx = out.indexOf("//");
  if (slashIdx !== -1) out = out.slice(0, slashIdx);
  return out;
}

// The destructive-signal matchers. Each entry names the signal it detects so a
// block message can tell the reviewer exactly what tripped the guard. Order is
// most-specific-first only for readability; all are tested per line.
const DESTRUCTIVE_PATTERNS = [
  { signal: "ALTER TABLE … DROP", re: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i },
  {
    signal: "DROP statement",
    // DROP TABLE/COLUMN/INDEX/SCHEMA/CONSTRAINT/VIEW/DATABASE/TYPE …
    re: /\bDROP\s+(TABLE|COLUMN|INDEX|SCHEMA|CONSTRAINT|VIEW|DATABASE|TYPE|SEQUENCE|TRIGGER|FUNCTION)\b/i,
  },
  { signal: "TRUNCATE", re: /\bTRUNCATE\b/i },
  {
    signal: "drizzle destructive op",
    re: /\.(dropTable|dropColumn|dropIndex|dropConstraint|dropForeignKey|dropPrimaryKey|dropUnique)\s*\(/,
  },
];

/**
 * Scan a single migration file's text for destructive signals.
 *
 * @param {string} text
 * @returns {string[]}  De-duplicated list of signal names found (empty = clean).
 */
export function scanMigrationText(text) {
  const found = new Set();
  for (const rawLine of text.split("\n")) {
    const line = stripComments(rawLine);
    if (!line.trim()) continue;
    for (const { signal, re } of DESTRUCTIVE_PATTERNS) {
      if (re.test(line)) found.add(signal);
    }
  }
  return [...found];
}

/**
 * Core detection over a set of changed files. Pure: the caller supplies a
 * `readFile` seam so the self-test never touches the filesystem.
 *
 * @param {object} opts
 * @param {string[]} opts.changedFiles   Repo-relative changed paths.
 * @param {(path: string) => string} opts.readFile  Reads a file's text.
 * @param {string[]} [opts.globs]        Migration path globs.
 * @returns {{ destructive: boolean, findings: Array<{file: string, signals: string[]}> }}
 */
export function detectDestructiveMigrations({ changedFiles, readFile, globs = DEFAULT_MIGRATION_GLOBS }) {
  const findings = [];
  for (const file of changedFiles) {
    if (!isMigrationFile(file, globs)) continue;
    let text;
    try {
      text = readFile(file);
    } catch {
      // A deleted migration file shows up in the changed set but can't be read
      // at head. Deleting a migration file is itself a destructive signal, so
      // record it rather than silently passing.
      findings.push({ file, signals: ["deleted migration file"] });
      continue;
    }
    const signals = scanMigrationText(text);
    if (signals.length > 0) findings.push({ file, signals });
  }
  return { destructive: findings.length > 0, findings };
}

/**
 * Render the GitHub job-summary markdown block for a destructive finding —
 * the same summary surface the previous in-workflow bash implementation
 * appended to `GITHUB_STEP_SUMMARY`. Only called when findings exist.
 *
 * @param {object} opts
 * @param {Array<{file: string, signals: string[]}>} opts.findings
 * @param {boolean} opts.labelPresent
 * @param {string} opts.overrideLabel
 * @returns {string}  Markdown, trailing-newline-terminated.
 */
export function formatStepSummary({ findings, labelPresent, overrideLabel }) {
  const list = findings
    .map((f) => `  • ${f.file} → ${f.signals.join(", ")}`)
    .join("\n");
  if (labelPresent) {
    return (
      "### Destructive-migration guard — ALLOWED via override\n\n" +
      `Override label \`${overrideLabel}\` is present. Findings:\n\n` +
      `${list}\n`
    );
  }
  return (
    "### ❌ Destructive-migration guard — BLOCKED\n\n" +
    "A destructive migration was detected and the override label\n" +
    `\`${overrideLabel}\` is NOT applied. Findings:\n\n` +
    `${list}\n\n` +
    `A reviewer must apply the \`${overrideLabel}\` label to\n` +
    "acknowledge the destructive change, then re-run this check.\n"
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    changedFiles: null,
    labelPresent: false,
    overrideLabel: DEFAULT_OVERRIDE_LABEL,
    globs: DEFAULT_MIGRATION_GLOBS,
    repoRoot: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--changed-files" && argv[i + 1]) {
      opts.changedFiles = argv[++i];
    } else if (a === "--label-present") {
      opts.labelPresent = true;
    } else if (a === "--override-label" && argv[i + 1]) {
      opts.overrideLabel = argv[++i];
    } else if (a === "--migration-glob" && argv[i + 1]) {
      opts.globs = argv[++i]
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
    } else if (a === "--repo-root" && argv[i + 1]) {
      opts.repoRoot = resolve(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    }
  }
  return opts;
}

function readChangedList(source) {
  const raw =
    source === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(resolve(source), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "Usage: node scripts/check-destructive-migration.mjs --changed-files <path|-> " +
        "[--label-present] [--override-label <name>] [--migration-glob <csv>] " +
        "[--repo-root <dir>]\n"
    );
    process.exit(0);
  }
  if (!opts.changedFiles) {
    process.stderr.write(
      "[check-destructive-migration] ERROR: --changed-files <path|-> is required.\n"
    );
    process.exit(2);
  }

  let changedFiles;
  try {
    changedFiles = readChangedList(opts.changedFiles);
  } catch (err) {
    process.stderr.write(
      `[check-destructive-migration] ERROR: cannot read changed-files list: ${err.message}\n`
    );
    process.exit(2);
  }

  const { destructive, findings } = detectDestructiveMigrations({
    changedFiles,
    globs: opts.globs,
    readFile: (file) => readFileSync(resolve(opts.repoRoot, file), "utf8"),
  });

  if (!destructive) {
    process.stdout.write(
      "✅ No destructive migration detected in the changed files.\n"
    );
    process.exit(0);
  }

  const summary = findings
    .map((f) => `  • ${f.file} → ${f.signals.join(", ")}`)
    .join("\n");

  // Inside a GitHub Actions step, mirror the finding onto the job summary —
  // the same surface the previous in-workflow bash implementation wrote.
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        formatStepSummary({
          findings,
          labelPresent: opts.labelPresent,
          overrideLabel: opts.overrideLabel,
        })
      );
    } catch {
      // Best-effort: the exit code below is the gate, the summary is cosmetic.
    }
  }

  if (opts.labelPresent) {
    process.stdout.write(
      `⚠️ Destructive migration detected, but the override label ` +
        `'${opts.overrideLabel}' is applied — allowing.\n${summary}\n`
    );
    process.exit(0);
  }

  process.stderr.write(
    `❌ Destructive migration detected and the override label ` +
      `'${opts.overrideLabel}' is NOT applied — blocking.\n${summary}\n\n` +
      `To proceed, a reviewer must apply the '${opts.overrideLabel}' label ` +
      `to acknowledge the destructive change, then re-run this check.\n`
  );
  process.exit(1);
}

// Only run the CLI when invoked directly, not when imported by the self-test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
