#!/usr/bin/env node
/**
 * check-semgrep-lockfile.test.mjs — guards the SAST toolchain lockfile
 * (Story #477).
 *
 * What this pins, and why each part earned a test:
 *
 * 1. **The advisories stay gone.** The lockfile carried protobuf 4.25.9
 *    (CVE-2026-0994, CVSS 8.2) and setuptools 80.9.0 (GHSA-h35f-9h28-mq5c).
 *    Neither could be fixed in place: every protobuf 4.x is affected, and
 *    semgrep 1.97.0's `opentelemetry-*~=1.25.0` pin capped protobuf below
 *    every patched release. A future bump that lands back inside an affected
 *    range would reintroduce a high with no other signal until the next
 *    scheduled OSV scan.
 *
 * 2. **The pin sites cannot drift.** The semgrep version lives in THREE
 *    places — this lockfile, `SEMGREP_PIN` in pr-quality.yml, and
 *    `DEFAULT_SEMGREP_PIN` in update-semgrep-rules.mjs — plus the
 *    `SEMGREP_HASHES` map that must carry digests for whatever the default is.
 *    Nothing detected disagreement between them before this file.
 *
 * 3. **`--require-hashes` stays satisfiable.** Every entry must be `==`-pinned
 *    with a sha256, or the install fails at CI time rather than here.
 *
 * The end-to-end proof (a real `pip install --require-hashes` on linux/cp312)
 * cannot run in this suite — it needs that platform and a network. It is a
 * `verify[]` step on the Story instead; these are the invariants checkable
 * from the tree.
 *
 * Run: node --test scripts/check-semgrep-lockfile.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const LOCKFILE = "scripts/semgrep-requirements.txt";
const WORKFLOW = ".github/workflows/pr-quality.yml";
const UPDATER = "scripts/update-semgrep-rules.mjs";

const DOCS = "docs/reusable-workflows.md";

const lockfile = readFileSync(LOCKFILE, "utf8");
const workflow = readFileSync(WORKFLOW, "utf8");

const SAST_STEP_HEADER = "- name: SAST (Semgrep, blocking, no SARIF upload)";

/**
 * Return the SAST step's `run:` body — from its `- name:` line to the next
 * step at the same indentation — with comment-only lines stripped.
 *
 * Both halves earn their place. Scoping to the step is what stops a whole-file
 * `indexOf` from resolving an anchor against an unrelated tier a thousand
 * lines away; dropping comments is what stops it from resolving against PROSE
 * ABOUT the code instead of the code. The selector-before-venv guard below did
 * both: its `select-semgrep-python.sh` hit landed in the side-checkout step's
 * comment block and its `-m venv` hit in a paragraph explaining venvs, so the
 * ordering it asserted was the ordering of two comments.
 */
function sastStepCode(text = workflow) {
  const start = text.indexOf(SAST_STEP_HEADER);
  if (start === -1) return "";
  const rest = text.slice(start + SAST_STEP_HEADER.length);
  const end = rest.indexOf("\n      - ");
  const step = end === -1 ? rest : rest.slice(0, end);
  return step
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * True when the SAST step chooses its interpreter before it builds the venv.
 * A predicate rather than a bare assertion so the guard can be exercised
 * against a MUTATED workflow — a test that only ever sees the passing input
 * cannot show it would notice the failure.
 */
function selectorPrecedesVenv(text) {
  const code = sastStepCode(text);
  const select = code.indexOf('source "${SELECT_PYTHON}"');
  const venv = code.indexOf('"${SEMGREP_PYTHON}" -m venv');
  if (select === -1 || venv === -1) return false;
  return select < venv;
}

// semgrep's own `requires_python`, recorded per release. Verified on PyPI
// 2026-09-10: 1.97.0 was `>=3.8`, 1.136.0 `>=3.9`, and 1.137.0 raised it to
// `>=3.10` — which is why a runner on macOS system Python (3.9.6) could not
// install the 1.176.1 pin at all (issue #480).
//
// This table is what makes the floor in pr-quality.yml checkable without a
// network call: a bump to a release with no entry here fails loudly, so
// "look up the new requires_python" becomes a step of the bump rather than
// something discovered by a consumer's red CI.
const SEMGREP_PYTHON_FLOORS = new Map([["1.176.1", "3.10"]]);

/**
 * Parse `name==version` requirement lines, ignoring comments and hash
 * continuations. Keyed by lowercased name.
 */
function requirements(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("--hash")) {
      continue;
    }
    const m = trimmed.match(/^([A-Za-z0-9._-]+)==([^\s\\]+)/);
    if (m) {
      out.set(m[1].toLowerCase(), m[2]);
    }
  }
  return out;
}

const REQS = requirements(lockfile);

/** Compare dotted release segments numerically. Returns -1 / 0 / 1. */
function compareVersions(a, b) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isNaN(pa[i]) || pa[i] === undefined ? 0 : pa[i];
    const y = Number.isNaN(pb[i]) || pb[i] === undefined ? 0 : pb[i];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 1. The advisories that put this Story on the board
// ---------------------------------------------------------------------------

test("protobuf is outside every CVE-2026-0994 affected range", () => {
  // Affected: `< 5.29.6` and `>= 6.30.0rc1, <= 6.33.4`. Patched: 5.29.6, 6.33.5.
  // A DoS in google.protobuf.json_format.ParseDict — 8.2, and the finding that
  // opened tracking issue #472.
  const version = REQS.get("protobuf");
  assert.ok(version, `${LOCKFILE}: protobuf must be pinned`);
  assert.doesNotMatch(version, /[a-zA-Z]/, "expected a final release, not a pre-release");

  assert.ok(
    compareVersions(version, "5.29.6") >= 0,
    `protobuf ${version} is below the 5.29.6 patch — inside the "< 5.29.6" affected range`,
  );
  const inSixLine = compareVersions(version, "6.0.0") >= 0;
  if (inSixLine) {
    assert.ok(
      compareVersions(version, "6.33.5") >= 0,
      `protobuf ${version} is inside the ">= 6.30.0rc1, <= 6.33.4" affected range`,
    );
  }
});

test("setuptools is absent from the closure", () => {
  // It was pinned to 80.9.0 only because semgrep 1.97.0's transitive
  // opentelemetry-instrumentation imported pkg_resources at load. 0.58b0 does
  // not, so the package — and its own advisory — leaves the graph entirely.
  assert.equal(
    REQS.has("setuptools"),
    false,
    "setuptools carries its own advisories and is no longer needed; do not re-add it without a stated reason",
  );
});

// ---------------------------------------------------------------------------
// 2. Drift between the three pin sites
// ---------------------------------------------------------------------------

test("the lockfile, the workflow, and the rules updater pin the same semgrep", () => {
  const lockVersion = REQS.get("semgrep");
  assert.ok(lockVersion, `${LOCKFILE}: semgrep must be pinned`);

  const wf = workflow.match(/SEMGREP_PIN='semgrep==([^']+)'/);
  assert.ok(wf, `${WORKFLOW}: SEMGREP_PIN not found`);
  assert.equal(wf[1], lockVersion, "workflow SEMGREP_PIN disagrees with the lockfile");

  const updater = readFileSync(UPDATER, "utf8");
  const up = updater.match(/const DEFAULT_SEMGREP_PIN = "semgrep==([^"]+)";/);
  assert.ok(up, `${UPDATER}: DEFAULT_SEMGREP_PIN not found`);
  assert.equal(up[1], lockVersion, "updater DEFAULT_SEMGREP_PIN disagrees with the lockfile");
});

test("the rules updater carries artifact hashes for the version it defaults to", () => {
  // SEMGREP_HASHES is a fail-fast supply-chain guard: a version with no entry
  // is rejected rather than installed unverified. A bump that moved the default
  // without adding digests would turn that guard into a hard stop.
  const updater = readFileSync(UPDATER, "utf8");
  const version = REQS.get("semgrep");
  const map = updater.slice(updater.indexOf("const SEMGREP_HASHES = {"));
  const block = map.slice(0, map.indexOf("\n};"));
  assert.ok(
    block.includes(`"${version}": [`),
    `${UPDATER}: SEMGREP_HASHES has no entry for ${version}`,
  );
});

// ---------------------------------------------------------------------------
// 3. --require-hashes remains satisfiable
// ---------------------------------------------------------------------------

test("every requirement is == pinned and carries a sha256 hash", () => {
  const pins = lockfile
    .split("\n")
    .filter((l) => /^[A-Za-z0-9._-]+==/.test(l.trim())).length;
  const hashes = lockfile.split("\n").filter((l) => l.trim().startsWith("--hash=sha256:")).length;

  assert.ok(pins > 0, "expected at least one pinned requirement");
  assert.equal(REQS.size, pins, "every pinned line must parse to a requirement");
  assert.ok(
    hashes >= pins,
    `${hashes} hash line(s) for ${pins} requirement(s) — --require-hashes needs at least one each`,
  );
});

test("no requirement is pinned with a loose operator", () => {
  // `--require-hashes` rejects these at install time; catching it here names
  // the offending line instead of failing inside CI's pip.
  //
  // The operator is matched by string comparison, NOT by a regex alternating
  // `<` and `>`. CodeQL reads such a pattern as an attempted HTML-tag filter
  // and raises js/bad-tag-filter at HIGH — which blocks the merge, since
  // code-scanning gates on high. Comparing prefixes says the same thing with
  // nothing for that query to match on.
  const LOOSE_OPERATORS = [">=", "<=", "~=", "!=", ">", "<"];
  for (const line of lockfile.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("--hash")) continue;
    const name = trimmed.match(/^[A-Za-z0-9._-]+/);
    if (!name) continue;
    const operator = trimmed.slice(name[0].length).trimStart();
    for (const loose of LOOSE_OPERATORS) {
      assert.ok(
        !operator.startsWith(loose),
        `loose pin (${loose}) — --require-hashes needs an exact ==: ${trimmed}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. The regeneration trap
// ---------------------------------------------------------------------------

test("the header warns about the manylinux_2_34 wheel tag", () => {
  // semgrep moved its Linux wheel tag after 1.157.0. A `pip download` whose
  // --platform list omits the new tag resolves NOTHING newer and reports only
  // "No matching distribution found", never naming the tag as the cause.
  const header = lockfile.slice(0, lockfile.indexOf("\n\n\n") + 1 || 4000);
  assert.match(header, /manylinux_2_34_x86_64/, "the header must name the current wheel tag");
  assert.match(header, /1\.157\.0/, "the header must say which version the tag changed after");
  assert.match(
    lockfile,
    /pip download semgrep/,
    "the header must carry a regeneration command",
  );
});

// ---------------------------------------------------------------------------
// 5. The interpreter floor on the non-lockfile install path (Story #482)
// ---------------------------------------------------------------------------

test("pr-quality.yml declares an interpreter floor matching the pinned semgrep", () => {
  const version = REQS.get("semgrep");
  const declared = workflow.match(/SEMGREP_PYTHON_FLOOR='([^']+)'/);
  assert.ok(
    declared,
    `${WORKFLOW}: SEMGREP_PYTHON_FLOOR must be declared beside SEMGREP_PIN — without it the SAST step cannot tell a too-old interpreter from a working one`,
  );

  const recorded = SEMGREP_PYTHON_FLOORS.get(version);
  assert.ok(
    recorded,
    `no requires_python floor recorded for semgrep ${version} — read it off PyPI and add it to SEMGREP_PYTHON_FLOORS before bumping SEMGREP_PIN`,
  );
  assert.equal(
    declared[1],
    recorded,
    `SEMGREP_PYTHON_FLOOR is ${declared[1]} but semgrep ${version} requires Python >= ${recorded}`,
  );
});

test("the selector rides the same side-checkout as the lockfile", () => {
  // The sparse-checkout is NON-CONE and lists exact paths, so a script the
  // SAST step sources is absent at run time unless it is named here — and a
  // missing `source` target kills the security tier for every consumer at
  // once. Both files must sit in the one list.
  const start = workflow.indexOf("- name: Checkout Semgrep lockfile");
  assert.notEqual(start, -1, `${WORKFLOW}: the Semgrep side-checkout step was renamed or removed`);
  const step = workflow.slice(start, workflow.indexOf("path: _mandrel-platform-semgrep", start));

  assert.ok(
    step.includes("scripts/semgrep-requirements.txt"),
    "the side-checkout must still carry the lockfile",
  );
  assert.ok(
    step.includes("scripts/select-semgrep-python.sh"),
    "the side-checkout must carry the interpreter selector the SAST step sources",
  );
  assert.ok(
    step.includes("sparse-checkout-cone-mode: false"),
    "non-cone mode is what makes the exact-path list meaningful",
  );
});

test("the SAST step selects an interpreter before it creates the venv", () => {
  // A venv inherits the interpreter that built it, so a floor enforced after
  // `-m venv` cannot fix anything. Order is the whole guarantee.
  const code = sastStepCode();
  assert.notEqual(code, "", `${WORKFLOW}: the SAST step was renamed or removed`);
  assert.ok(
    code.includes('source "${SELECT_PYTHON}"'),
    `${WORKFLOW}: the SAST step must source the interpreter selector`,
  );
  assert.ok(
    code.includes('"${SEMGREP_PYTHON}" -m venv'),
    "the venv must be built from the selected interpreter, not from bare python3",
  );
  assert.ok(selectorPrecedesVenv(workflow), "the selector must be sourced BEFORE the venv");
});

test("the selector-before-venv guard fails when the two are swapped", () => {
  // The mutation the guard exists to catch, performed on a copy: move the venv
  // line above the `source` line and the check must go red. Without this, the
  // guard could be resolving anchors that no reordering of the real step would
  // ever move — which is precisely how it passed while comparing two comments.
  const VENV_LINE = '          "${SEMGREP_PYTHON}" -m venv "${venv_dir}"\n';
  const SOURCE_LINE = '          source "${SELECT_PYTHON}"\n';
  assert.ok(workflow.includes(VENV_LINE), `${WORKFLOW}: the venv line changed shape`);
  assert.ok(workflow.includes(SOURCE_LINE), `${WORKFLOW}: the source line changed shape`);

  const mutated = workflow
    .replace(VENV_LINE, "")
    .replace(SOURCE_LINE, `${VENV_LINE}${SOURCE_LINE}`);
  assert.notEqual(mutated, workflow, "the mutation must actually change the workflow");
  assert.equal(
    selectorPrecedesVenv(mutated),
    false,
    "a venv built before the interpreter is chosen must fail the guard",
  );
});

test("the non-lockfile path installs exactly SEMGREP_PIN, never a resolved older release", () => {
  // Downgrading to fit an old interpreter re-admits CVE-2026-0994: the newest
  // py3.9-compatible semgrep (1.136.0) pins opentelemetry ~=1.25.0, which caps
  // protobuf below 5.0, and every protobuf 4.x is affected. This path is not
  // hash-pinned and its closure is not OSV-scanned, so it would be silent.
  assert.ok(
    workflow.includes('--retries 3 "${SEMGREP_PIN}"'),
    "the fallback must install the exact pin",
  );

  // Matched as literal substrings rather than a regex alternating the
  // comparison operators: CodeQL reads such a pattern as an attempted HTML-tag
  // filter and raises js/bad-tag-filter at HIGH, which blocks the merge.
  const LOOSE = ["semgrep<", "semgrep>", "semgrep~=", "semgrep!=", 'semgrep=="${'];
  for (const loose of LOOSE) {
    assert.ok(
      !workflow.includes(loose),
      `${WORKFLOW}: '${loose}' would let pip resolve a semgrep other than the pin`,
    );
  }
});

test("the Linux hash-pinned branch keeps its exact cp312 equality", () => {
  // Widening this to a `>=` (proposed in issue #480) would route a cp313
  // interpreter onto the lockfile's cp312-only wheels under
  // `--only-binary :all:`, with no sdist fallback — the fleet-red the fallback
  // exists to avoid. The equality is the guard, not the oversight.
  assert.ok(
    workflow.includes('[ "${pyver}" = "312" ]'),
    `${WORKFLOW}: the cp312 test must stay an equality`,
  );
  assert.ok(
    workflow.includes('The `= "312"` below is an EQUALITY on purpose'),
    "the equality must carry a comment saying why a >= test would be wrong",
  );
  assert.ok(
    workflow.includes("sdist fallback"),
    "that comment must name the missing sdist fallback as the mechanism",
  );
});

test("the floor added no workflow_call input and no new job permission", () => {
  // A consumer-set semgrep pin would re-open the same un-scanned downgrade
  // hole operator-side; `enable-sast: false` is the escape hatch. And a new
  // job-level permission is a COMPILE-TIME break for every caller of this
  // reusable workflow, not a runtime one.
  assert.ok(!workflow.includes("semgrep-pin:"), "no semgrep-pin input — see the Story's non-goals");
  assert.ok(!workflow.includes("python-version:"), "no python-version input — see the Story's non-goals");

  const start = workflow.indexOf("name: Security (secret scan + SAST)");
  assert.notEqual(start, -1, `${WORKFLOW}: the security job was renamed`);
  const header = workflow.slice(start, workflow.indexOf("steps:", start));
  const granted = header
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l === "contents: read" || l === "actions: write");
  assert.equal(
    granted.length,
    2,
    "the security job's permissions must remain exactly contents: read + actions: write",
  );
  assert.ok(!header.includes("id-token:"), "no new permission was needed for an interpreter floor");
  assert.ok(!header.includes("packages:"), "no new permission was needed for an interpreter floor");
});

// ---------------------------------------------------------------------------
// 6. The hash-pinned path's real preconditions, and an audible fallback (#495)
// ---------------------------------------------------------------------------

test("the hash-pinned branch tests architecture as well as OS and ABI", () => {
  // The lockfile was resolved with `--platform manylinux*_x86_64` only, and
  // PyPI ships a separate `manylinux_2_34_aarch64` semgrep wheel that no entry
  // covers. On an arm64 Linux runner the OS+ABI test passed and
  // `--require-hashes --only-binary` hard-failed on a hash mismatch — a red
  // that reads like a tampered artifact rather than an unsupported arch.
  const code = sastStepCode();
  assert.ok(
    code.includes('[ "${pyver}" = "312" ]'),
    `${WORKFLOW}: the cp312 test must stay an equality`,
  );
  assert.ok(
    code.includes('[ "${runner_arch}" = "x86_64" ]'),
    `${WORKFLOW}: the hash-pinned branch must also require x86_64`,
  );
  assert.ok(
    code.includes('runner_arch="$(uname -m)"'),
    "the architecture must be read from the runner, not assumed",
  );
});

test("the lockfile's declared ABI matches the branch's cp equality", () => {
  // Two spellings of one fact: `3.12` steers the interpreter probe and `312`
  // gates the install. A bump that moved one and not the other would probe for
  // an interpreter the install then rejects.
  const abi = workflow.match(/export SEMGREP_LOCKFILE_ABI='([^']+)'/);
  assert.ok(abi, `${WORKFLOW}: SEMGREP_LOCKFILE_ABI must be exported for the selector`);
  assert.equal(
    abi[1].replace(".", ""),
    "312",
    `SEMGREP_LOCKFILE_ABI is ${abi[1]} but the hash-pinned branch installs only on cp312`,
  );
});

test("every reason for leaving the hash-pinned path is warned about by name", () => {
  // The single line this replaced said "Non-Linux runner (or no lockfile)" on
  // all four, so the two that actually cost the fleet its supply-chain pin — a
  // rolled interpreter and an unsupported arch — were reported as neither of
  // them, at log level, on a green job.
  const code = sastStepCode();
  const reasons = code.split("\n").filter((l) => l.includes("fallback_reason="));
  assert.equal(reasons.length, 4, "expected one named reason per precondition");

  for (const [precondition, phrase] of [
    ["OS", "not Linux"],
    ["architecture", "not x86_64"],
    ["interpreter ABI", "not the lockfile's cp312"],
    ["missing lockfile", "lockfile is missing"],
  ]) {
    assert.ok(
      reasons.some((line) => line.includes(phrase)),
      `no fallback reason names the ${precondition} precondition (looked for "${phrase}")`,
    );
  }

  const warning = code
    .split("\n")
    .find((l) => l.includes("::warning::") && l.includes("${fallback_reason}"));
  assert.ok(
    warning,
    "the fallback must emit a ::warning:: carrying the resolved reason, not a log line",
  );
  assert.ok(
    warning.includes("WITHOUT hash-pinning"),
    "the warning must say what was actually lost",
  );
});

test("the SAST exclude list covers every platform side-checkout", () => {
  // Two directories are materialized from mandrel-platform's own tree —
  // `_mandrel-platform-sast` (the ruleset) and `_mandrel-platform-semgrep`
  // (the lockfile + selector). Only the first was ever excluded, so platform
  // source could enter a caller's finding set. The glob covers the next one
  // too.
  const code = sastStepCode();
  assert.ok(
    code.includes("--exclude '_mandrel-platform-*'"),
    `${WORKFLOW}: the exclude list must cover _mandrel-platform-* , not one checkout by name`,
  );

  // Both checkout paths must fall under the glob, or the exclude is cosmetic.
  for (const path of ["_mandrel-platform-sast", "_mandrel-platform-semgrep"]) {
    assert.ok(
      workflow.includes(`path: ${path}`),
      `${WORKFLOW}: expected a side-checkout at ${path}`,
    );
    assert.ok(path.startsWith("_mandrel-platform-"), `${path} is not covered by the glob`);
  }
});

// ---------------------------------------------------------------------------
// 7. The rules updater shares the selector, and counts its own hashes (#495)
// ---------------------------------------------------------------------------

test("the rules updater builds its venv from the shared interpreter selector", () => {
  const updater = readFileSync(UPDATER, "utf8");
  assert.ok(
    updater.includes("select-semgrep-python.sh"),
    `${UPDATER}: the venv interpreter must come from the same selector the SAST step uses`,
  );
  assert.ok(
    !/spawnSync\("python3"/.test(updater),
    `${UPDATER}: a hard-coded python3 installs nothing on a macOS system interpreter`,
  );
});

test("the rules updater no longer installs setuptools", () => {
  // It was there only because semgrep 1.97.0's transitive
  // opentelemetry-instrumentation 0.46b0 imported pkg_resources at load.
  // 0.58b0 does not, and 80.9.0 — the last release shipping pkg_resources —
  // carries its own advisories.
  const updater = readFileSync(UPDATER, "utf8");
  assert.ok(
    !/["']setuptools["']/.test(updater),
    `${UPDATER}: setuptools must not be reinstalled into the vendoring venv`,
  );
});

test("the SEMGREP_HASHES comment states the artifact count it actually carries", () => {
  // The comment read "the four platform wheels + the sdist" while the array
  // held eight. A reader checking whether the hash set is complete is reading
  // the comment, so a stale count is a supply-chain claim that is not true.
  const updater = readFileSync(UPDATER, "utf8");
  const version = REQS.get("semgrep");

  const mapStart = updater.indexOf("const SEMGREP_HASHES = {");
  assert.notEqual(mapStart, -1, `${UPDATER}: SEMGREP_HASHES not found`);
  const entryStart = updater.indexOf(`"${version}": [`, mapStart);
  assert.notEqual(entryStart, -1, `${UPDATER}: SEMGREP_HASHES has no entry for ${version}`);
  const entry = updater.slice(entryStart, updater.indexOf("],", entryStart));
  const recorded = entry.split("sha256:").length - 1;
  assert.ok(recorded > 0, `${UPDATER}: the ${version} entry carries no hashes`);

  const comment = updater.slice(0, mapStart);
  const claimed = comment.match(/(\d+) artifacts/);
  assert.ok(
    claimed,
    `${UPDATER}: the SEMGREP_HASHES comment must state how many artifacts it pins`,
  );
  assert.equal(
    Number.parseInt(claimed[1], 10),
    recorded,
    `the comment claims ${claimed[1]} artifacts but the ${version} entry pins ${recorded}`,
  );
});

// ---------------------------------------------------------------------------
// 8. The documented behaviour is the shipped behaviour (#495)
// ---------------------------------------------------------------------------

test("the SAST docs describe the ABI-first probe order and the fallback warning", () => {
  // A consumer debugging a lost hash pin reads this section, not the workflow.
  const docs = readFileSync(DOCS, "utf8");
  const start = docs.indexOf("> **Python interpreter floor.**");
  assert.notEqual(start, -1, `${DOCS}: the SAST interpreter section was renamed or removed`);
  const section = docs.slice(start, docs.indexOf("#### SAST ruleset provenance", start));

  assert.match(section, /SEMGREP_LOCKFILE_ABI|lockfile.{0,40}ABI/i, "the ABI input must be named");
  assert.match(section, /probed first|first on Linux/i, "the probe order must be stated");
  assert.match(section, /::warning::/, "the fallback warning must be documented");
  assert.match(section, /x86_64/, "the architecture precondition must be documented");
});
