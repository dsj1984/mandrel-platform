#!/usr/bin/env node
/**
 * check-workflow-portability.mjs
 *
 * Cross-repo portability lint for reusable workflows and composite actions.
 *
 * GitHub validates a reusable workflow's `workflow_call` interface (and a
 * composite action's interface) only when it is *called from another repo* —
 * never when its own repo runs CI on it. That blind spot has shipped four
 * consecutive consumer-facing breakages from this repo (see the #24 → #29 →
 * #30 → #32 chain on the athportal Story #2006 worktree), each a silent
 * "workflow file issue / 0 jobs started" that no in-repo check could catch.
 *
 * This lint closes the blind spot by statically asserting the two invariants
 * that GitHub only enforces at cross-repo call time:
 *
 *   1. RELATIVE `uses:` PATHS (e.g. `uses: ./.github/actions/foo`) are
 *      PROHIBITED inside a reusable workflow. A cross-repo caller checks out
 *      ITS OWN repo, so `./` resolves to the wrong tree and validation fails
 *      with 0 jobs. Reusable workflows MUST reference first-party actions by
 *      absolute `owner/repo/path@ref` form. (Caused #30 / v0.2.3.)
 *
 *   2. `${{ }}` EXPRESSIONS in `workflow_call` input/secret `description:` or
 *      input `default:` fields are PROHIBITED. GitHub evaluates these during
 *      interface validation, where contexts like `runner.*` do not yet exist,
 *      so the call fails silently. The SAME footgun applies to composite
 *      `action.yml` input `default:` values — a composite default is never
 *      expression-evaluated, so `${{ }}` is passed through as a literal string.
 *      (Caused #32 / v0.2.4 and #30's setup-toolchain default regression.)
 *
 * What this lint deliberately does NOT flag: `${{ }}` in `runs.steps[].with`
 * (e.g. `dest: ${{ inputs['pnpm-dest'] || format('{0}/pnpm', runner.temp) }}`)
 * is a VALID runtime expression. The lint only inspects `description` and
 * `default` leaves *inside input/secret-definition blocks*, so legitimate
 * runtime expressions in step bodies are never touched.
 *
 * Usage:
 *   node scripts/check-workflow-portability.mjs
 *   node scripts/check-workflow-portability.mjs --workflows-dir .github/workflows
 *   node scripts/check-workflow-portability.mjs --actions-dir .github/actions
 *
 * Exit codes:
 *   0 — every reusable workflow and composite action is cross-repo portable
 *   1 — one or more portability violations detected (each named in stderr)
 *
 * Consumer adoption:
 *   Copy this script into your project's `scripts/` directory, then wire it
 *   into your CI alongside check-required-contexts.mjs:
 *
 *   - name: Lint workflow portability
 *     run: node scripts/check-workflow-portability.mjs
 *
 *   It is dependency-free (no YAML parser) so it copies cleanly into any repo.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let workflowsDir = null;
let actionsDir = null;

for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--workflows-dir" || args[i] === "-w") && args[i + 1]) {
    workflowsDir = args[++i];
  } else if ((args[i] === "--actions-dir" || args[i] === "-a") && args[i + 1]) {
    actionsDir = args[++i];
  } else if (args[i] === "--help" || args[i] === "-h") {
    process.stdout.write(
      "Usage: node scripts/check-workflow-portability.mjs [--workflows-dir <dir>] [--actions-dir <dir>]\n"
    );
    process.exit(0);
  }
}

const repoRoot = process.cwd();
const resolvedWorkflowsDir = workflowsDir
  ? resolve(workflowsDir)
  : resolve(repoRoot, ".github/workflows");
const resolvedActionsDir = actionsDir
  ? resolve(actionsDir)
  : resolve(repoRoot, ".github/actions");

// ---------------------------------------------------------------------------
// Minimal indentation-aware YAML walk (dependency-free)
//
// We do NOT need a full YAML parser — only the path-qualified `description`
// and `default` scalar leaves (with their folded multi-line values) and a
// flat line scan for `uses:`. The walk yields one record per mapping key:
//
//   { path: [...ancestorKeys, key], value, lineNo }
//
// where `value` is the inline scalar, the gathered block-scalar body, or ""
// for a parent mapping. Quotes are stripped from keys so `"on":` === `on`.
// ---------------------------------------------------------------------------

function walkYaml(content) {
  const lines = content.split("\n");
  const stack = []; // [{ indent, key }]
  const records = [];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];

    // Blank and comment-only lines carry no structure.
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) {
      i++;
      continue;
    }

    const indent = raw.match(/^(\s*)/)[1].length;
    const trimmed = raw.slice(indent);

    // Match a mapping key, optionally introduced by a sequence dash.
    const m = trimmed.match(/^(-\s+)?(["']?[A-Za-z0-9_.\-]+["']?):(\s*)(.*)$/);
    if (!m) {
      i++;
      continue;
    }

    const key = m[2].replace(/^["']|["']$/g, "");
    const after = m[4];

    // Unwind to the enclosing mapping for this indentation.
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const path = stack.map((s) => s.key).concat(key);

    // Block scalar (`>`, `|`, with optional chomp/indent indicators): gather
    // the deeper-indented body so `${{` inside a folded description is seen.
    if (/^[|>][+-]?\d*\s*$/.test(after)) {
      let value = "";
      let j = i + 1;
      while (j < lines.length) {
        const cont = lines[j];
        if (/^\s*$/.test(cont)) {
          value += "\n";
          j++;
          continue;
        }
        const contIndent = cont.match(/^(\s*)/)[1].length;
        if (contIndent <= indent) break;
        value += cont.trim() + "\n";
        j++;
      }
      records.push({ path, value, lineNo: i + 1 });
      i = j;
      continue;
    }

    if (after === "") {
      // Parent mapping (or empty/sequence container): becomes context.
      stack.push({ indent, key });
      records.push({ path, value: "", lineNo: i + 1 });
      i++;
      continue;
    }

    // Inline scalar leaf.
    records.push({ path, value: after, lineNo: i + 1 });
    i++;
  }

  return records;
}

const EXPR = /\$\{\{/;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function listWorkflowFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => join(dir, f));
}

function listActionFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      found.push(...listActionFiles(full));
    } else if (entry === "action.yml" || entry === "action.yaml") {
      found.push(full);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Lint rules
// ---------------------------------------------------------------------------

/** Collect violations for a single file. Returns an array of {line, message}. */
function lintFile(filePath) {
  const violations = [];
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    return [{ line: 0, message: `cannot read file: ${err.message}` }];
  }

  const records = walkYaml(content);
  const isWorkflow = filePath.startsWith(resolvedWorkflowsDir);
  const isAction =
    basename(filePath) === "action.yml" || basename(filePath) === "action.yaml";

  if (isWorkflow) {
    const isReusable = records.some(
      (r) => r.path.join(".") === "on.workflow_call" || r.path.join(".").startsWith("on.workflow_call.")
    );
    if (!isReusable) return violations; // ordinary workflow — nothing to enforce

    // Rule 1: no relative `uses:` anywhere in a reusable workflow.
    content.split("\n").forEach((raw, idx) => {
      if (/^\s*uses:\s*['"]?\.\//.test(raw)) {
        violations.push({
          line: idx + 1,
          message:
            `relative \`uses: ./\` path in a reusable workflow — a cross-repo ` +
            `caller resolves \`./\` against its own checkout. Use absolute ` +
            `\`owner/repo/path@ref\` form.`,
        });
      }
    });

    // Rule 2: no `${{ }}` in workflow_call input/secret description or default.
    for (const r of records) {
      const p = r.path.join(".");
      const isInputMeta =
        /^on\.workflow_call\.inputs\.[^.]+\.(description|default)$/.test(p);
      const isSecretMeta =
        /^on\.workflow_call\.secrets\.[^.]+\.description$/.test(p);
      if ((isInputMeta || isSecretMeta) && EXPR.test(r.value)) {
        const field = r.path[r.path.length - 1];
        const name = r.path[r.path.length - 2];
        violations.push({
          line: r.lineNo,
          message:
            `\`\${{ }}\` expression in workflow_call \`${name}.${field}\` — ` +
            `GitHub evaluates this during interface validation (where ` +
            `runner.*/secrets.* do not exist), failing every cross-repo call. ` +
            `Write it as plain text.`,
        });
      }
    }
  }

  if (isAction) {
    // Rule 3/4: no `${{ }}` in composite-action input default or description.
    // A composite default is never expression-evaluated (the literal string is
    // passed through); a description expression is misleading and needless.
    for (const r of records) {
      const p = r.path.join(".");
      if (/^inputs\.[^.]+\.(default|description)$/.test(p) && EXPR.test(r.value)) {
        const field = r.path[r.path.length - 1];
        const name = r.path[r.path.length - 2];
        violations.push({
          line: r.lineNo,
          message:
            `\`\${{ }}\` expression in action input \`${name}.${field}\` — ` +
            `composite ${field}s are not expression-evaluated; the literal ` +
            `string is used as-is. Move runtime expressions into ` +
            `\`runs.steps[].with\`, or write the ${field} as plain text.`,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const workflowFiles = listWorkflowFiles(resolvedWorkflowsDir);
const actionFiles = listActionFiles(resolvedActionsDir);
const allFiles = [...workflowFiles, ...actionFiles];

process.stdout.write(
  `[check-workflow-portability] Workflows: ${relative(repoRoot, resolvedWorkflowsDir)}/ (${workflowFiles.length})\n` +
  `[check-workflow-portability] Actions  : ${relative(repoRoot, resolvedActionsDir)}/ (${actionFiles.length})\n`
);

if (allFiles.length === 0) {
  process.stdout.write(
    `[check-workflow-portability] No workflow or action files found — nothing to lint.\n`
  );
  process.exit(0);
}

let total = 0;
for (const file of allFiles) {
  const violations = lintFile(file);
  if (violations.length === 0) continue;
  total += violations.length;
  const rel = relative(repoRoot, file);
  process.stderr.write(`\n[check-workflow-portability] ❌ ${rel}\n`);
  for (const v of violations) {
    process.stderr.write(`     ${rel}:${v.line} — ${v.message}\n`);
  }
}

if (total > 0) {
  process.stderr.write(
    `\n[check-workflow-portability] ${total} portability violation${total === 1 ? "" : "s"} detected.\n` +
    `   These fail only when a CONSUMER repo calls the workflow/action, which is\n` +
    `   exactly why in-repo CI never caught them before. Fix each above.\n\n`
  );
  process.exit(1);
}

process.stdout.write(
  `[check-workflow-portability] ✅ All reusable workflows and composite actions are cross-repo portable.\n`
);
process.exit(0);
