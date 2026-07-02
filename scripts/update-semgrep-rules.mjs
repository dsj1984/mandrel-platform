#!/usr/bin/env node
/**
 * update-semgrep-rules.mjs
 *
 * SAST ruleset vendoring (Story #132).
 *
 * `pr-quality.yml`'s SAST sub-step used to scan against the LIVE Semgrep
 * registry alias `p/default`. The registry alias is not pinned: Semgrep can
 * (and did) add new rules to it at any time, so a full-tree / non-PR scan
 * could turn red with ZERO code change on our side (the 0.14.0 release
 * incident — pnpm supply-chain rules + `secrets-inherit` landed in
 * `p/default` mid-flight and blocked the release gate). This script is the
 * deterministic replacement: it resolves `p/default` ONCE against the
 * pinned Semgrep binary version, filters to the language set this platform
 * actually scans, and writes the result to `.semgrep/rules.json` — a
 * committed, reviewable file `pr-quality.yml` then passes directly to
 * `semgrep scan --config`. No registry call happens at scan time.
 *
 * A ruleset bump is now a deliberate, reviewable PR (re-run this script,
 * diff `.semgrep/rules.json`, commit) — the same "bump is a PR" discipline
 * the action-pin ratchet (`check-action-pins.mjs`, Story #112) and the OSV
 * advisory tier (`osv-scanner-version` pin, Story #114) already apply to
 * their respective pinned inputs.
 *
 * Language scope (Story #132): mandrel-platform and its consumers are
 * TypeScript/JavaScript platforms whose CI surface is GitHub Actions YAML,
 * JSON config, and shell `run:` blocks — NOT Python/Java/Go/Ruby/etc. Full
 * `p/default` ships 1074 rules across every language Semgrep supports;
 * >70% of them (Python, Java, Go, Ruby, HCL, PHP, Solidity, Scala, C#, …)
 * can never fire in this tree and only bloat the vendored file and the scan
 * time. We keep the rules for the languages actually present:
 *
 *   js, ts, typescript  — application + tooling source
 *   yaml                 — GitHub Actions workflows (this is where
 *                          `secrets-inherit` and the pnpm supply-chain
 *                          rules live)
 *   json                 — config files (Renovate, package.json, …)
 *   bash                 — `run:` step shell scripts
 *   dockerfile           — container build files
 *   generic, regex       — cross-language taint/secret patterns Semgrep
 *                          ships as language-agnostic rules
 *
 * A rule whose `languages` array intersects this set is KEPT in full,
 * including any sibling languages outside the set (e.g. the one
 * multi-language catch-all rule) — we filter by relevance, not by
 * single-language purity.
 *
 * Usage:
 *   node scripts/update-semgrep-rules.mjs
 *   node scripts/update-semgrep-rules.mjs --semgrep-pin semgrep==1.97.0
 *   node scripts/update-semgrep-rules.mjs --out .semgrep/rules.json --dry-run
 *
 * Requires network egress to PyPI (to install the pinned `semgrep` package,
 * whose artifact is verified against the recorded SHA-256 hashes via pip's
 * `--require-hashes`) and to the Semgrep registry (to resolve `p/default`) —
 * this script is run by a human/agent deliberately bumping the ruleset, NOT
 * by CI on every PR.
 *
 * Exit codes:
 *   0 — rules file written (or, with --dry-run, would-write reported).
 *   1 — semgrep install or rule resolution failed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// Must match the `SEMGREP_PIN` literal in `.github/workflows/pr-quality.yml`'s
// SAST step. Keep these two pins in lockstep: the vendored rules are
// resolved AGAINST this exact Semgrep version's registry-resolution logic,
// so scanning with a different installed version than the one used to
// generate the file is a (harmless but inconsistent) version skew.
const DEFAULT_SEMGREP_PIN = "semgrep==1.97.0";

// SHA-256 hashes for every `DEFAULT_SEMGREP_PIN` distribution published on
// PyPI (the four platform wheels + the sdist). pip's `--require-hashes` mode
// verifies the downloaded `semgrep` artifact against this set before it is
// installed, so a compromised or swapped PyPI artifact for this exact version
// is rejected at install time — the same "pin the supply-chain input" posture
// the action-pin ratchet (SHA-pinned Actions) and the OSV advisory pin apply
// to their inputs. When bumping `DEFAULT_SEMGREP_PIN`, refresh this map from
// `https://pypi.org/pypi/semgrep/<version>/json` (the `urls[].digests.sha256`
// values) — a version with no hash entry here fails fast rather than
// installing unverified.
const SEMGREP_HASHES = {
  "1.97.0": [
    "sha256:0ddaa25ee45e669e1fef87e88dcef73b2aee0874b507e09f618862c42452a205",
    "sha256:9184500bf8c49ad19d0fb2d84923abb4aa53058b0ece7008b57a3b0b5e6ce3ee",
    "sha256:f7d21d6499d4e6fafb4c0b04b1750e9f4b704a26bd78f0aff19f1c73d44843b4",
    "sha256:996fe0b2bfac3a4d4511e470fdf5f3bca96b1f794f398e0336c8388802c218de",
    "sha256:c585164358e03cd7868e1f0d38fbcb422c88dbe08795b83caeb5e36cf18874aa",
  ],
};

const DEFAULT_OUT = join(REPO_ROOT, ".semgrep", "rules.json");

// Languages this platform's reusable workflows + consumer trees actually
// scan. See the module doc above for the rationale per language.
const KEPT_LANGUAGES = new Set([
  "js",
  "ts",
  "typescript",
  "yaml",
  "json",
  "bash",
  "dockerfile",
  "generic",
  "regex",
]);

// Rule IDs excluded from the vendored snapshot for a reason OTHER than
// language scope. Each entry is a deliberate, reviewable carve-out — never a
// silent drop. The one entry below is excluded because ITS OWN rule body
// embeds a credential-shaped placeholder literal (an inert `pattern-not`
// example, not a live secret) that GitHub push protection's secret scanner
// flags on `git push` regardless of context (Story #132). We do NOT rewrite
// or obfuscate that literal to evade the scanner — that would be weakening
// a security control to get past another one. Dropping the single rule is
// the transparent fix: it costs one Slack-webhook-detection rule (not named
// in Story #132's AC — the pnpm supply-chain rules and `secrets-inherit`
// are the AC-named rules, both unaffected) out of the language-filtered
// set, and the gitleaks sub-step in the same security tier already covers
// credential-shaped findings via a dedicated, purpose-built secret scanner.
// Re-adding this rule requires either (a) GitHub's push-protection "allow
// this secret" flow for this exact literal (an explicit, audited
// repo-owner action — not a code change), or (b) Semgrep relaxing the
// placeholder shape upstream.
const EXCLUDED_RULE_IDS = new Set([
  "generic.secrets.security.detected-slack-webhook.detected-slack-webhook",
]);

function parseArgs(argv) {
  const opts = {
    semgrepPin: DEFAULT_SEMGREP_PIN,
    out: DEFAULT_OUT,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--semgrep-pin") {
      opts.semgrepPin = argv[++i];
    } else if (arg === "--out") {
      opts.out = resolve(argv[++i]);
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * Resolve `p/default` against a pinned, ephemeral Semgrep install and return
 * the full rule list as parsed JSON objects. Mirrors the hermetic-venv
 * install strategy `pr-quality.yml`'s SAST step uses (Story #92): an
 * ephemeral `python3 -m venv` under `mktemp -d`, never the shared user site.
 */
function resolveRegistryRules(semgrepPin) {
  const venvDir = join(mkdtempSync(join(tmpdir(), "semgrep-vendor-")), "venv");
  const targetDir = mkdtempSync(join(tmpdir(), "semgrep-vendor-target-"));
  const semgrepHome = mkdtempSync(join(tmpdir(), "semgrep-vendor-home-"));
  const reqsFile = join(mkdtempSync(join(tmpdir(), "semgrep-vendor-reqs-")), "semgrep.txt");

  try {
    spawnSync("python3", ["-m", "venv", venvDir], { stdio: "inherit" });
    const pip = join(venvDir, "bin", "pip");
    const semgrep = join(venvDir, "bin", "semgrep");

    // Resolve the exact version from the pin (`semgrep==<version>`) so we can
    // look up its published artifact hashes. Only the `==` form is hashable;
    // an unpinned or range pin cannot be verified.
    const versionMatch = /^semgrep==(.+)$/.exec(semgrepPin.trim());
    if (!versionMatch) {
      throw new Error(
        `cannot hash-pin ${semgrepPin}: only an exact 'semgrep==<version>' pin is supported`
      );
    }
    const version = versionMatch[1];
    const hashes = SEMGREP_HASHES[version];
    if (!hashes || hashes.length === 0) {
      throw new Error(
        `no published artifact hashes recorded for ${semgrepPin} in SEMGREP_HASHES — ` +
          `refresh from https://pypi.org/pypi/semgrep/${version}/json before pinning`
      );
    }

    // Hash-pinned install: write a requirements file that pins `semgrep` to
    // the exact version with every published artifact hash, then install it
    // with `--require-hashes --no-deps`. pip verifies the downloaded semgrep
    // artifact against this set before installing — a swapped/compromised
    // artifact for this version is rejected. Dependencies are resolved in a
    // separate, non-hashed step (semgrep is already satisfied), keeping the
    // supply-chain-critical `semgrep` binary itself hash-verified.
    const hashFlags = hashes.map((h) => `    --hash=${h}`).join(" \\\n");
    writeFileSync(reqsFile, `semgrep==${version} \\\n${hashFlags}\n`, "utf8");

    const installSemgrep = spawnSync(
      pip,
      [
        "install",
        "--quiet",
        "--disable-pip-version-check",
        "--require-hashes",
        "--no-deps",
        "-r",
        reqsFile,
      ],
      { stdio: "inherit" }
    );
    if (installSemgrep.status !== 0) {
      throw new Error(
        `hash-pinned pip install ${semgrepPin} failed (exit ${installSemgrep.status})`
      );
    }

    const install = spawnSync(
      pip,
      ["install", "--quiet", "--disable-pip-version-check", "setuptools", semgrepPin],
      { stdio: "inherit" }
    );
    if (install.status !== 0) {
      throw new Error(`pip install ${semgrepPin} (dependencies) failed (exit ${install.status})`);
    }

    // A throwaway target file gives semgrep something to "scan" so it
    // resolves + dumps the full `p/default` rule set without needing real
    // findings. `--dump-command-for-core` makes semgrep write the resolved
    // rules to `<SEMGREP_HOME>/semgrep_rules.json` and print the core
    // command line instead of actually invoking the native scanner — we
    // only want the resolved rules, not a scan result.
    writeFileSync(join(targetDir, "placeholder.txt"), "// vendoring placeholder\n");

    const dump = spawnSync(
      semgrep,
      [
        "scan",
        "--config",
        "p/default",
        "--metrics=off",
        "--disable-version-check",
        "--dump-command-for-core",
        targetDir,
      ],
      {
        stdio: "inherit",
        env: { ...process.env, SEMGREP_HOME: semgrepHome, HOME: semgrepHome },
      }
    );
    if (dump.status !== 0) {
      throw new Error(`semgrep p/default resolution failed (exit ${dump.status})`);
    }

    const resolvedPath = join(semgrepHome, ".semgrep", "semgrep_rules.json");
    if (!existsSync(resolvedPath)) {
      throw new Error(`expected resolved rules at ${resolvedPath}, found nothing`);
    }
    const resolved = JSON.parse(readFileSync(resolvedPath, "utf8"));
    return resolved.rules ?? [];
  } finally {
    rmSync(venvDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(semgrepHome, { recursive: true, force: true });
    rmSync(dirname(reqsFile), { recursive: true, force: true });
  }
}

/** Keep a rule iff its `languages` array intersects `KEPT_LANGUAGES`. */
function filterByLanguage(rules) {
  return rules.filter((rule) => {
    const langs = Array.isArray(rule.languages) ? rule.languages : [];
    return langs.some((lang) => KEPT_LANGUAGES.has(lang));
  });
}

/** Drop any rule whose id is in the explicit, documented `EXCLUDED_RULE_IDS`. */
function filterByExclusionList(rules) {
  return rules.filter((rule) => !EXCLUDED_RULE_IDS.has(rule.id));
}

/** Sort rules by `id` for a deterministic, low-diff-noise file on re-run. */
function sortRules(rules) {
  return [...rules].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function buildVendoredRuleset({ semgrepPin = DEFAULT_SEMGREP_PIN, resolve: resolveFn = resolveRegistryRules } = {}) {
  const allRules = resolveFn(semgrepPin);
  const kept = sortRules(filterByExclusionList(filterByLanguage(allRules)));
  return {
    rules: kept,
    droppedCount: allRules.length - kept.length,
    totalCount: allRules.length,
  };
}

export function runCli(argv, { log = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`[semgrep-vendor] ❌ ${e.message}`);
    return 1;
  }

  let result;
  try {
    result = buildVendoredRuleset({ semgrepPin: opts.semgrepPin });
  } catch (e) {
    err(`[semgrep-vendor] ❌ ${e.message}`);
    return 1;
  }

  const payload = { rules: result.rules };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;

  if (opts.dryRun) {
    log(
      `[semgrep-vendor] (dry-run) would write ${result.rules.length} rule(s) ` +
        `(${result.droppedCount} of ${result.totalCount} dropped as out-of-scope-language) to ${opts.out}`
    );
    return 0;
  }

  writeFileSync(opts.out, serialized);
  log(
    `[semgrep-vendor] ✅ wrote ${result.rules.length} rule(s) ` +
      `(${result.droppedCount} of ${result.totalCount} dropped as out-of-scope-language) to ${opts.out}`
  );
  log(
    "[semgrep-vendor] Review the diff, then commit `.semgrep/rules.json` as a " +
      "deliberate ruleset bump (mirrors the action-pin ratchet / OSV pin model)."
  );
  return 0;
}

// Only run when executed directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
