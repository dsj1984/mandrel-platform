#!/usr/bin/env node
/**
 * check-workflow-portability.mjs
 *
 * Cross-repo portability lint for reusable workflows and composite actions.
 *
 * GitHub validates a reusable workflow's / composite action's interface only
 * when it is *called from another repo* — never when its own repo runs CI on
 * it. That blind spot has shipped five consecutive consumer-facing breakages
 * from this repo (the #24 → #29 → #30 → #32 → #35 chain on the athportal /
 * domio Story worktrees), each a silent "workflow file issue / 0 jobs" or a
 * "Set up job" load failure that no in-repo check could catch.
 *
 * This lint closes the blind spot by statically asserting the invariants that
 * GitHub only enforces at cross-repo call / action-load time:
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
 *      `action.yml` input `default:` and `description:` values — a composite
 *      default is never expression-evaluated (passed through as a literal),
 *      and a `${{ }}` in a composite description throws "Unrecognized
 *      named-value" at action-load time ("Set up job"). (Caused #32 / #35.)
 *
 *   3. INTERNAL SHA PINS must point to a CLEAN manifest. A reusable workflow
 *      that pins a first-party action by `owner/repo/path@<sha>` is validated
 *      here against the manifest AT THAT SHA — not just the working-tree copy.
 *      A pin left lagging on a pre-fix commit re-introduces a footgun the
 *      working tree already fixed: this is exactly #35, where pr-quality.yml
 *      kept pinning setup-toolchain@<pre-fix-sha> after the description was
 *      cleaned in the working tree, so every consumer job died at "Set up
 *      job". Requires git history (run CI checkout with fetch-depth: 0); the
 *      check degrades to a skipped NOTE when the pinned blob is unreachable.
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
 *   node scripts/check-workflow-portability.mjs --no-pin-check   # skip Rule 3
 *
 * Exit codes:
 *   0 — every reusable workflow and composite action is cross-repo portable
 *   1 — one or more portability violations detected (each named in stderr)
 *
 * Consumer adoption:
 *   Copy this script into your project's `scripts/` directory, then wire it
 *   into your CI alongside check-required-contexts.mjs. Use fetch-depth: 0 on
 *   the checkout so Rule 3 can resolve pinned blobs:
 *
 *   - uses: actions/checkout@<sha>
 *     with: { fetch-depth: 0 }
 *   - name: Lint workflow portability
 *     run: node scripts/check-workflow-portability.mjs
 *
 *   It is dependency-free (no YAML parser) so it copies cleanly into any repo.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, relative, basename } from "node:path";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let workflowsDir = null;
let actionsDir = null;
let pinCheck = true;

for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--workflows-dir" || args[i] === "-w") && args[i + 1]) {
    workflowsDir = args[++i];
  } else if ((args[i] === "--actions-dir" || args[i] === "-a") && args[i + 1]) {
    actionsDir = args[++i];
  } else if (args[i] === "--no-pin-check") {
    pinCheck = false;
  } else if (args[i] === "--help" || args[i] === "-h") {
    process.stdout.write(
      "Usage: node scripts/check-workflow-portability.mjs [--workflows-dir <dir>] [--actions-dir <dir>] [--no-pin-check]\n"
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
// Content checks (reused for both working-tree files and pinned blobs)
// ---------------------------------------------------------------------------

/** Reusable-workflow checks (Rules 1 & 2). Returns [{line, message}]. */
function checkWorkflowContent(content) {
  const violations = [];
  const records = walkYaml(content);

  const isReusable = records.some(
    (r) => r.path.join(".") === "on.workflow_call" || r.path.join(".").startsWith("on.workflow_call.")
  );
  if (!isReusable) return violations;

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
    const isInputMeta = /^on\.workflow_call\.inputs\.[^.]+\.(description|default)$/.test(p);
    const isSecretMeta = /^on\.workflow_call\.secrets\.[^.]+\.description$/.test(p);
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

  return violations;
}

/** Composite-action checks (Rules 3/4 of the original; manifest cleanliness). */
function checkActionContent(content) {
  const violations = [];
  const records = walkYaml(content);

  for (const r of records) {
    const p = r.path.join(".");
    if (/^inputs\.[^.]+\.(default|description)$/.test(p) && EXPR.test(r.value)) {
      const field = r.path[r.path.length - 1];
      const name = r.path[r.path.length - 2];
      violations.push({
        line: r.lineNo,
        message:
          `\`\${{ }}\` expression in action input \`${name}.${field}\` — ` +
          `composite ${field}s are not expression-evaluated; \`${field}\` ` +
          `throws "Unrecognized named-value" at action-load time. Move ` +
          `runtime expressions into \`runs.steps[].with\`, or write it as ` +
          `plain text.`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Internal SHA-pin guard (Rule 3) — validate the PINNED manifest, not just
// the working tree. Catches a self-reference that lags a fix (e.g. #35).
// ---------------------------------------------------------------------------

let gitAvailable = null;
function isGitRepo() {
  if (gitAvailable !== null) return gitAvailable;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

/** `git show <sha>:<path>` → file content, or null if unreachable. */
function gitShow(sha, path) {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Collect internal (same-repo, full-SHA-pinned) `uses:` references from a
 * workflow/action file. "Internal" is detected structurally: the sub-path
 * after `owner/repo/` exists in the local working tree. External refs
 * (actions/checkout, pnpm/action-setup, …) resolve to no local path and are
 * skipped — so the heuristic needs no knowledge of this repo's own slug.
 */
function collectInternalPins(content) {
  const pins = [];
  content.split("\n").forEach((raw, idx) => {
    const m = raw.match(
      /uses:\s*['"]?[\w.-]+\/[\w.-]+\/([^@\s'"]+)@([0-9a-fA-F]{40})/
    );
    if (!m) return;
    const subpath = m[1];
    const sha = m[2];
    const local = join(repoRoot, subpath);
    if (!existsSync(local)) return; // external ref → skip
    pins.push({ subpath, sha, line: idx + 1 });
  });
  return pins;
}

/** Resolve a pinned ref's manifest path + kind ('action' | 'workflow'). */
function resolvePinnedManifest(subpath) {
  const local = join(repoRoot, subpath);
  let st;
  try {
    st = statSync(local);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    for (const name of ["action.yml", "action.yaml"]) {
      if (existsSync(join(local, name))) return { path: `${subpath}/${name}`, kind: "action" };
    }
    return null;
  }
  if (/\.ya?ml$/.test(subpath)) {
    const kind = basename(subpath).startsWith("action.") ? "action" : "workflow";
    return { path: subpath, kind };
  }
  return null;
}

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
// Per-file lint
// ---------------------------------------------------------------------------

const pinSkips = [];

function lintFile(filePath) {
  const violations = [];
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    return [{ line: 0, message: `cannot read file: ${err.message}` }];
  }

  const isWorkflow = filePath.startsWith(resolvedWorkflowsDir);
  const isAction =
    basename(filePath) === "action.yml" || basename(filePath) === "action.yaml";

  // Rules 1 & 2 (workflows) and the manifest checks (actions) on the live file.
  if (isWorkflow) violations.push(...checkWorkflowContent(content));
  if (isAction) violations.push(...checkActionContent(content));

  // Rule 3: validate internal SHA-pinned references against their pinned blob.
  if (pinCheck && isGitRepo()) {
    for (const pin of collectInternalPins(content)) {
      const manifest = resolvePinnedManifest(pin.subpath);
      if (!manifest) continue;
      const pinned = gitShow(pin.sha, manifest.path);
      if (pinned === null) {
        pinSkips.push(
          `${relative(repoRoot, filePath)}:${pin.line} — pinned ${pin.subpath}@${pin.sha.slice(0, 7)} ` +
          `(blob unreachable; run checkout with fetch-depth: 0 to enable Rule 3)`
        );
        continue;
      }
      const pinnedViolations =
        manifest.kind === "action"
          ? checkActionContent(pinned)
          : checkWorkflowContent(pinned);
      for (const v of pinnedViolations) {
        violations.push({
          line: pin.line,
          message:
            `internal pin \`${pin.subpath}@${pin.sha.slice(0, 7)}\` points to a ` +
            `manifest with a portability defect (${manifest.path}:${v.line}) — ` +
            `${v.message} Bump the pin to a commit whose manifest is clean.`,
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
  `[check-workflow-portability] Actions  : ${relative(repoRoot, resolvedActionsDir)}/ (${actionFiles.length})\n` +
  `[check-workflow-portability] Pin check: ${pinCheck ? (isGitRepo() ? "on" : "on (git unavailable — skipped)") : "off"}\n`
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

if (pinSkips.length > 0) {
  process.stdout.write(
    `\n[check-workflow-portability] ⚠️  ${pinSkips.length} internal pin(s) could not be verified (Rule 3 skipped):\n`
  );
  for (const s of pinSkips) process.stdout.write(`     ${s}\n`);
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
