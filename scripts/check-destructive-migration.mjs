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
 * ONE carve-out, and only one (Story #367): a `DROP INDEX <name>` whose index
 * the SAME migration file recreates LATER in the file (`CREATE [UNIQUE] INDEX
 * <name>`) is **lossless** and does not trip the guard. Narrowing a partial
 * index cannot be expressed any other way on SQLite — it is necessarily a drop
 * followed immediately by a create — so an ordinary, reversible migration was
 * demanding a human acknowledgement label. The carve-out is deliberately
 * narrow and fails closed: a drop with no matching recreate, a recreate that
 * appears BEFORE the drop (the index is still gone at the end of the
 * migration), a recreate in a different file, an unparseable index name, and
 * every non-INDEX drop all still block. No table, column, constraint, or
 * TRUNCATE detection is relaxed.
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
 * and closed on the same line. A multi-line block comment's residue is left in
 * DELIBERATELY on this side: it can only cause a false positive, which the
 * override label acknowledges. It is `maskNonExecutable` — applied only to the
 * text the RECREATE scan reads — that must be exact, because there the same
 * residue would cause a false NEGATIVE.
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

// The destructive-signal matchers evaluated per line. `DROP <object>` is NOT
// in this list — it is scanned over the whole file so a `DROP INDEX` can be
// paired with a later recreate (see scanDropStatements below). Each entry names
// the signal it detects so a block message can tell the reviewer exactly what
// tripped the guard.
const DESTRUCTIVE_PATTERNS = [
  { signal: "ALTER TABLE … DROP", re: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i },
  { signal: "TRUNCATE", re: /\bTRUNCATE\b/i },
  {
    signal: "drizzle destructive op",
    re: /\.(dropTable|dropColumn|dropIndex|dropConstraint|dropForeignKey|dropPrimaryKey|dropUnique)\s*\(/,
  },
];

// One identifier segment: bare, or quoted with "…", `…`, or […].
const IDENT_SEGMENT_SOURCE = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';

// A possibly schema-qualified identifier — every segment may be quoted
// independently (`"public"."idx_x"`).
const IDENT_SOURCE = `${IDENT_SEGMENT_SOURCE}(?:\\.${IDENT_SEGMENT_SOURCE})*`;

// `DROP TABLE/COLUMN/INDEX/SCHEMA/CONSTRAINT/VIEW/DATABASE/TYPE …`. Scanned
// globally so every occurrence is judged, not just the first on a line.
const DROP_OBJECT_SOURCE =
  "\\bDROP\\s+(TABLE|COLUMN|INDEX|SCHEMA|CONSTRAINT|VIEW|DATABASE|TYPE|SEQUENCE|TRIGGER|FUNCTION)\\b";

// The dropped index NAMES, anchored at the `DROP` that already matched.
// Tolerates postgres' `CONCURRENTLY` and the `IF EXISTS` guard, and captures
// the WHOLE comma-separated list — `DROP INDEX a, b;` is valid postgres, and
// excusing it on the strength of the first name alone would let `b` be dropped
// with no recreate and no acknowledgement.
const DROP_INDEX_LIST_RE = new RegExp(
  `^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${IDENT_SOURCE}(?:\\s*,\\s*${IDENT_SOURCE})*)`,
  "i"
);

/**
 * The normalized names a `DROP INDEX` statement targets, or `null` when the
 * statement's name list cannot be parsed (which fails closed at the call site).
 *
 * @param {string} tail  Text starting at the matched `DROP`.
 * @returns {string[]|null}
 */
export function parseDroppedIndexNames(tail) {
  const m = DROP_INDEX_LIST_RE.exec(tail);
  if (!m) return null;
  // Re-match identifiers rather than splitting on "," so a quoted name that
  // itself contains a comma stays one identifier.
  const names = m[1].match(new RegExp(IDENT_SOURCE, "g"));
  if (!names || names.length === 0) return null;
  return names.map(normalizeIndexName);
}

// `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] <name>`.
const CREATE_INDEX_SOURCE =
  `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT_SOURCE})`;

/**
 * Normalize an index identifier for comparison: unquote, drop any schema
 * qualifier, and lowercase (SQL identifiers are case-insensitive unquoted).
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeIndexName(raw) {
  const unquoted = raw.replace(/["`[\]]/g, "");
  const segments = unquoted.split(".");
  return segments[segments.length - 1].toLowerCase();
}

// A postgres dollar-quote delimiter: `$$` or `$tag$`.
const DOLLAR_QUOTE_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Blank out the spans of `text` that cannot execute — multi-line `/* … *​/`
 * block comments, single-quoted SQL string literals, and postgres
 * dollar-quoted bodies (`$$ … $$` / `$tag$ … $tag$`, which is how a function
 * body reaches the server as a literal) — preserving LENGTH so offsets stay
 * comparable with the unmasked text.
 *
 * The two scans are deliberately asymmetric, and both directions fail closed:
 * the DROP scan reads text with only per-line comments stripped (detect as much
 * as possible), while the RECREATE scan reads this masked text (excuse as
 * little as possible). Without it, a `CREATE INDEX idx_a …` that never runs —
 * commented out as a rollback note, or quoted inside an INSERT — would excuse a
 * real `DROP INDEX idx_a`, and the index would be gone at the end of the
 * migration with no acknowledgement. An unterminated quote masks the remainder
 * of the file, which withdraws excuses rather than granting them.
 *
 * @param {string} text
 * @returns {string}  Same length as `text`.
 */
export function maskNonExecutable(text) {
  const chars = text.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (chars[k] !== "\n") chars[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (text[i] === "$") {
      const tag = DOLLAR_QUOTE_RE.exec(text.slice(i))?.[0];
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        const end = close === -1 ? text.length : close + tag.length;
        blank(i, end);
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (text[i] === "'") {
      let k = i + 1;
      while (k < text.length) {
        // '' is an escaped quote inside a SQL string literal, not a close.
        if (text[k] === "'" && text[k + 1] === "'") {
          k += 2;
          continue;
        }
        if (text[k] === "'") {
          k++;
          break;
        }
        k++;
      }
      blank(i, k);
      i = k;
      continue;
    }
    i++;
  }
  return chars.join("");
}

/**
 * Every index this text (re)creates, with the offset at which the CREATE
 * appears. Offsets are what make the pairing order-sensitive: only a create
 * that lands AFTER the drop leaves the index in place at the end of the
 * migration.
 *
 * @param {string} text  Comment-stripped migration text.
 * @returns {Array<{name: string, index: number}>}
 */
export function collectCreatedIndexes(text) {
  const re = new RegExp(CREATE_INDEX_SOURCE, "gi");
  const created = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    created.push({ name: normalizeIndexName(m[1]), index: m.index });
  }
  return created;
}

/**
 * Scan comment-stripped migration text for `DROP <object>` statements, pairing
 * a `DROP INDEX` with a later recreate of the same index in the same text.
 *
 * @param {string} cleanText
 * @returns {{ destructiveDrops: number, recreatedIndexes: string[] }}
 *   `destructiveDrops` counts the drops that still trip the guard;
 *   `recreatedIndexes` names the index drops excused as lossless.
 */
export function scanDropStatements(cleanText) {
  // Only an executable CREATE counts as a recreate — see maskNonExecutable.
  const created = collectCreatedIndexes(maskNonExecutable(cleanText));
  const re = new RegExp(DROP_OBJECT_SOURCE, "gi");
  let destructiveDrops = 0;
  const recreatedIndexes = [];
  let m;
  while ((m = re.exec(cleanText)) !== null) {
    if (m[1].toUpperCase() === "INDEX") {
      const names = parseDroppedIndexNames(cleanText.slice(m.index));
      // An unparseable name list fails closed — counted as destructive below.
      // EVERY name in the list must be recreated after the drop; one excused
      // name never excuses its neighbours.
      if (
        names &&
        names.every((name) => created.some((c) => c.name === name && c.index > m.index))
      ) {
        recreatedIndexes.push(...names);
        continue;
      }
    }
    destructiveDrops++;
  }
  return { destructiveDrops, recreatedIndexes };
}

/**
 * Scan a single migration file's text for destructive signals.
 *
 * @param {string} text
 * @returns {string[]}  De-duplicated list of signal names found (empty = clean).
 */
export function scanMigrationText(text) {
  const found = new Set();
  const cleanLines = text.split("\n").map((line) => stripComments(line));
  for (const line of cleanLines) {
    if (!line.trim()) continue;
    for (const { signal, re } of DESTRUCTIVE_PATTERNS) {
      if (re.test(line)) found.add(signal);
    }
  }
  const { destructiveDrops } = scanDropStatements(cleanLines.join("\n"));
  if (destructiveDrops > 0) found.add("DROP statement");
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
