#!/usr/bin/env node
/**
 * check-environments-isolation-audit.test.mjs — behavioural guard for the
 * environments isolation audit's verdicts (Story #367).
 *
 * The bug this pins: reading an environment's `deployment_branch_policy`
 * requires repo Administration: read, which the default GITHUB_TOKEN cannot be
 * granted. Without it GitHub omits the field from the response entirely — and
 * the audit read that absence as "this environment has NO deployment branch
 * policy" and failed with a security finding it had never observed. A check
 * that reports the insecure conclusion when the truth is that it could not look
 * is a check operators learn to wave through, which is why no consumer in the
 * fleet had it enabled.
 *
 * Absent-because-unreadable and absent-because-unset are different states and
 * must produce different outcomes. Reading the YAML cannot prove that: what
 * decides the verdict is a shell branch over a `jq` probe. So this extracts the
 * real `run:` body and executes it against a stub `gh` serving fixture
 * responses — the same read-then-execute approach as
 * check-setup-toolchain-store.test.mjs / check-osv-scan-mode.test.mjs.
 *
 * Run: node --test scripts/check-environments-isolation-audit.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ACTION = ".github/actions/environments-isolation-audit/action.yml";
const REPO = "acme/widgets";

// Minimal indentation-based extraction (dependency-free, mirrors
// check-setup-toolchain-store.test.mjs).
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

const auditScript = runScript(stepByName(readFileSync(ACTION, "utf8"), "Audit deployment branch policies"));

/**
 * Run the extracted audit body against a stub `gh` that serves `responses`
 * keyed by API path. A path with no fixture makes the stub exit non-zero with
 * no output — exactly how `gh api` behaves on a 404 or a permission failure.
 *
 * @param {object} opts
 * @param {Record<string, unknown>} opts.responses  API path → JSON body.
 * @param {string} [opts.environments]              ENVIRONMENTS_CSV.
 * @param {string} [opts.allowedBranch]             ALLOWED_BRANCH.
 * @returns {{ code: number, output: string }}  `output` is stdout+stderr;
 *   GitHub's `::error::` annotations are written to stdout.
 */
function runAudit({ responses, environments = "staging", allowedBranch = "main" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "env-isolation-audit-"));
  try {
    const fixtures = path.join(dir, "fixtures");
    mkdirSync(fixtures);
    for (const [apiPath, body] of Object.entries(responses)) {
      writeFileSync(path.join(fixtures, apiPath.replace(/\//g, "_") + ".json"), JSON.stringify(body));
    }
    const stub = path.join(dir, "gh");
    writeFileSync(
      stub,
      "#!/bin/sh\n" +
        'f="$FIXTURE_DIR/$(printf %s "$2" | tr / _).json"\n' +
        'if [ -f "$f" ]; then cat "$f"; exit 0; fi\n' +
        'echo "gh: Not Found (HTTP 404)" >&2\n' +
        "exit 1\n"
    );
    chmodSync(stub, 0o755);
    const script = path.join(dir, "audit.sh");
    writeFileSync(script, auditScript);
    const env = {
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      FIXTURE_DIR: fixtures,
      GITHUB_REPOSITORY: REPO,
      AUDIT_REPO: "",
      ENVIRONMENTS_CSV: environments,
      ALLOWED_BRANCH: allowedBranch,
    };
    try {
      const stdout = execFileSync("bash", [script], { cwd: dir, encoding: "utf8", env });
      return { code: 0, output: stdout };
    } catch (err) {
      return { code: err.status, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ENV_API = `repos/${REPO}/environments/staging`;
const POLICIES_API = `${ENV_API}/deployment-branch-policies`;

// ── the canonical posture still passes ─────────────────────────────────────

test("an environment restricted to the allowed branch passes", () => {
  const res = runAudit({
    responses: {
      [ENV_API]: {
        name: "staging",
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      },
      [POLICIES_API]: { total_count: 1, branch_policies: [{ name: "main" }] },
    },
  });
  assert.equal(res.code, 0, res.output);
  assert.match(res.output, /restricts deploys to 'main'/);
});

// ── unreadable ≠ unset (the Story #367 split) ──────────────────────────────

test("a policy field the token cannot read is reported as unreadable, not as absent", () => {
  // What GitHub actually returns without Administration: read — the key is
  // simply not in the response.
  const res = runAudit({ responses: { [ENV_API]: { name: "staging", id: 1 } } });
  assert.equal(res.code, 1);
  assert.match(res.output, /UNREADABLE/);
  assert.match(res.output, /Administration: read/);
  assert.doesNotMatch(
    res.output,
    /has NO deployment branch policy/,
    "the audit must not assert a conclusion it never observed"
  );
});

test("a genuinely unset policy still fails as a real finding", () => {
  const res = runAudit({
    responses: { [ENV_API]: { name: "staging", deployment_branch_policy: null } },
  });
  assert.equal(res.code, 1);
  assert.match(res.output, /has NO deployment branch policy/);
  assert.doesNotMatch(res.output, /UNREADABLE/, "a null field is observed, not unreadable");
});

test("the two absent-policy states produce different messages", () => {
  const unreadable = runAudit({ responses: { [ENV_API]: { name: "staging" } } }).output;
  const unset = runAudit({
    responses: { [ENV_API]: { name: "staging", deployment_branch_policy: null } },
  }).output;
  assert.notEqual(unreadable, unset);
});

test("an unreadable read is summarised as not-a-verdict at the end of the run", () => {
  const res = runAudit({ responses: { [ENV_API]: { name: "staging" } } });
  assert.match(res.output, /are NOT policy verdicts/);
});

test("unreadable named branch policies are not reported as ZERO policies", () => {
  // The policy field reads fine; the follow-up policies call fails.
  const res = runAudit({
    responses: {
      [ENV_API]: {
        name: "staging",
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      },
    },
  });
  assert.equal(res.code, 1);
  assert.match(res.output, /named branch policies UNREADABLE/);
  assert.doesNotMatch(res.output, /ZERO named policies/);
});

// ── every other finding is unchanged ───────────────────────────────────────

test("protected-branches-only still fails with its own message", () => {
  const res = runAudit({
    responses: {
      [ENV_API]: {
        name: "staging",
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
    },
  });
  assert.equal(res.code, 1);
  assert.match(res.output, /protected branches only/);
  assert.doesNotMatch(res.output, /UNREADABLE/);
});

test("zero named policies, a wildcard, and a wrong branch each still fail", () => {
  const custom = {
    name: "staging",
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const zero = runAudit({
    responses: { [ENV_API]: custom, [POLICIES_API]: { total_count: 0, branch_policies: [] } },
  });
  assert.equal(zero.code, 1);
  assert.match(zero.output, /ZERO named policies/);

  const wildcard = runAudit({
    responses: {
      [ENV_API]: custom,
      [POLICIES_API]: { total_count: 1, branch_policies: [{ name: "release/*" }] },
    },
  });
  assert.equal(wildcard.code, 1);
  assert.match(wildcard.output, /wildcard branch policy/);

  const wrongBranch = runAudit({
    responses: {
      [ENV_API]: custom,
      [POLICIES_API]: { total_count: 1, branch_policies: [{ name: "develop" }] },
    },
  });
  assert.equal(wrongBranch.code, 1);
  assert.match(wrongBranch.output, /allows branch 'develop', not 'main'/);
});

test("a missing environment still fails with the does-not-exist message", () => {
  const res = runAudit({ responses: {} });
  assert.equal(res.code, 1);
  assert.match(res.output, /does not exist on/);
});
