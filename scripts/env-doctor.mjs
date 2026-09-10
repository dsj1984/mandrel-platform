#!/usr/bin/env node
/**
 * env-doctor.mjs — the shared, values-safe env/secrets residency doctor
 * (Story #451, lifted from domio's `scripts/env/` cluster).
 *
 * ## What it answers
 *
 * "Is every environment variable and secret this project declares actually
 * present, in every store that is supposed to hold it, and nowhere it
 * shouldn't be?" A JSON manifest declares the intended residency of each key;
 * this script probes five surfaces and reports the two-way difference
 * (missing = readiness, extra = orphans) plus an optional value-SHAPE verdict.
 *
 * The five surfaces:
 *
 *   1. local     — `.env.example` in the caller repo (the onboarding
 *                  contract). The doctor never reads a developer's real
 *                  local file: it holds live values, and a surface this
 *                  script reports on must be one every run can see.
 *   2. wrangler  — `[vars]` in each Worker's wrangler config
 *   3. github    — Actions secret/variable NAMES (repo + environment scope)
 *   4. cloudflare— Worker secret NAMES per resolved script name
 *   5. infisical — secret NAMES per environment and folder
 *
 * ## Why it never prints a value
 *
 * Four of the five surfaces cannot return values at all (GitHub and Cloudflare
 * expose names only, by design). Infisical can, which makes it the one place a
 * doctor could leak. So the residency probe asks Infisical for names ONLY
 * (`viewSecretValue=false`), and values are fetched exclusively by the shape
 * stage, compared in-process, and reduced to a pass/fail verdict before
 * anything is rendered. No value is ever written to stdout or stderr, and the
 * sibling test asserts that by grepping the full captured output of a real run
 * for every injected fixture value.
 *
 * ## Why `shape` is a closed vocabulary
 *
 * The obvious design lets a manifest entry carry its own regex. It cannot ship:
 * Semgrep blocks `new RegExp(<non-literal>)` on new JavaScript in this repo,
 * with no exemption for test files. So {@link SHAPE_VOCABULARY} is a fixed map
 * of names to literal, anchored RegExp objects, and an unknown shape name is a
 * manifest validation error rather than a silently-unchecked key. The
 * motivating case — a scheme-less `PUBLIC_SITE_URL` reaching production — is
 * `shape: "url"`, which the vocabulary covers.
 *
 * `placeholderPattern` is likewise NOT a regex: it is a literal,
 * case-insensitive substring ("changeme", "xxx"). Same constraint, same reason.
 *
 * ## Why an absent credential is not a failure but a failed probe is
 *
 * These are different states and conflating them is how a drift gate goes
 * permanently green. A consumer that has not provisioned a Cloudflare token
 * should still get value from the offline arm, so an absent credential marks
 * that surface `unchecked`, prints a notice, and leaves the exit code alone.
 *
 * But once a credential IS supplied, every probe failure must fail the run.
 * Only a 404 may degrade to "this resource is absent" — the discipline
 * `scripts/lib/gh-json.mjs` exists to enforce (Story #198). Without it a 401
 * from an expired PAT returns an empty name list, every key reads as an
 * orphan-free match, and the doctor reports "no drift" precisely because it
 * could not look. That is the fail-OPEN this module is built to refuse.
 *
 * ## Usage
 *
 *   node scripts/env-doctor.mjs --manifest env.manifest.json --offline
 *   node scripts/env-doctor.mjs --manifest env.manifest.json \
 *     --environments staging,production --repo owner/name --json
 *
 * Consumed by `.github/workflows/env-drift.yml`; a consumer runs it as
 * `node node_modules/mandrel-platform/scripts/env-doctor.mjs`, which is why
 * the entry guard below goes through the shared symlink-safe seam.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";

import { parseFlags } from "./lib/args.mjs";
import { isDirectInvocation } from "./lib/entry-guard.mjs";
import { listWorkflowFiles } from "./lib/walk.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INFISICAL_DEFAULT_SITE = "https://app.infisical.com";
export const GITHUB_API_BASE = "https://api.github.com";
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * The keys GitHub injects into every workflow run. A `secrets.GITHUB_TOKEN`
 * reference is not consumer-provisioned, so the offline arm must not demand a
 * manifest entry for it.
 */
export const GITHUB_BUILTIN_NAMES = new Set(["GITHUB_TOKEN", "ACTIONS_STEP_DEBUG", "ACTIONS_RUNNER_DEBUG"]);

/**
 * The closed `shape` vocabulary. Every entry is a literal, anchored RegExp —
 * see the module docblock for why a manifest-supplied pattern cannot ship.
 *
 * `non-empty` is deliberately a regex too (rather than a length test) so the
 * whole vocabulary has one uniform evaluation path.
 */
export const SHAPE_VOCABULARY = Object.freeze({
  "non-empty": /^(?!\s*$).+$/s,
  url: /^https?:\/\/[^\s/?#]+[^\s]*$/,
  "https-url": /^https:\/\/[^\s/?#]+[^\s]*$/,
  e164: /^\+[1-9]\d{1,14}$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  integer: /^-?\d+$/,
  hex: /^[0-9a-fA-F]+$/,
  base64: /^[A-Za-z0-9+/]+={0,2}$/,
});

export const SHAPE_NAMES = Object.freeze(Object.keys(SHAPE_VOCABULARY));

// ---------------------------------------------------------------------------
// Manifest schema + validation
// ---------------------------------------------------------------------------

/**
 * The manifest schema, exported so `docs/reusable-workflows.md` and a
 * consumer's own tooling describe exactly one shape.
 */
export const MANIFEST_SCHEMA = Object.freeze({
  environments: "string[] — environment slugs, e.g. ['staging','production']",
  environmentSlugs:
    "object? — surface name -> {environment: slug}. Only 'infisical' is honored; an unmapped environment resolves to itself.",
  workers:
    "object? — worker id -> {config, scriptName}. `scriptName` may contain '{env}', substituted per environment.",
  keys: "object[] — one entry per env var / secret (see KEY_SCHEMA)",
});

export const KEY_SCHEMA = Object.freeze({
  name: "string — the variable/secret name",
  kind: "'var' | 'secret'",
  sensitivity: "'public' | 'secret'",
  residency:
    "object — {local: 'var'|'secret'|'file'|null, github: G|G[]|null where G = {scope,kind,environments?}, cloudflare: {workers: (string | {worker, environments})[], kind}|null}",
  infisical:
    "{folder, environments} | {folders: (string | {folder, environments})[]} | 'unmanaged'",
  shape: `string? — one of ${SHAPE_NAMES.join(", ")}`,
  placeholderPattern: "string? — literal, case-insensitive substring marking an unset placeholder value",
  note: "string? — free text",
});

/**
 * The surfaces whose environment namespace can be remapped.
 *
 * `manifest.environments` names DEPLOY environments, and until Story #464 that
 * one list was substituted verbatim into three namespaces that are not the
 * same namespace — the Worker script name, the GitHub Environment API path,
 * and the Infisical environment slug. A project whose Infisical slugs differ
 * from its deploy names (`prod` against a `production` environment) could not
 * be probed at all: the surface went to `error`, which is deliberately
 * unsuppressable, so the lane was permanently red with no downstream fix.
 *
 * Only `infisical` is remappable, and deliberately so. Cloudflare already has
 * its own escape hatch — `resolveScriptName` substitutes `{env}` into
 * `workers[].scriptName`, so `acme-site-{env}` resolves whatever the deploy
 * name is — and giving it a slug map too would be two mechanisms for one job.
 * The GitHub Environment API is read at `manifest.environments` verbatim and
 * no divergence has been observed there. The CONTAINER is nonetheless keyed by
 * surface rather than being an Infisical-only field, so a surface that ever
 * does diverge adopts it without inventing a second idiom.
 */
export const SLUG_MAPPED_SURFACES = Object.freeze(["infisical"]);

/**
 * Normalize `manifest.environmentSlugs` to a total map over the slug-mapped
 * surfaces, so a caller never has to distinguish "absent" from "empty".
 *
 * Validation fails closed, matching this module's posture on an unknown
 * `shape`: silently ignoring a misspelled surface or environment is how a
 * manifest author comes to believe they have remapped something they have not,
 * and the symptom — a 404 from the store — looks nothing like the cause.
 *
 * @param {unknown} raw
 * @param {string[]} environments
 * @returns {Record<string, Record<string, string>>}
 */
function normalizeEnvironmentSlugs(raw, environments) {
  const out = {};
  for (const surface of SLUG_MAPPED_SURFACES) out[surface] = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest.environmentSlugs must be an object mapping a surface name -> {environment: slug}");
  }

  for (const [surface, map] of Object.entries(raw)) {
    if (!SLUG_MAPPED_SURFACES.includes(surface)) {
      throw new Error(
        `manifest.environmentSlugs."${surface}" is not a slug-mapped surface — supported: ` +
          `${SLUG_MAPPED_SURFACES.join(", ")}. Cloudflare resolves each environment through the ` +
          `"{env}" substitution in workers[].scriptName, and the GitHub Environment API is read at ` +
          `manifest.environments verbatim, so neither takes a slug map.`
      );
    }
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      throw new Error(`manifest.environmentSlugs.${surface} must be an object mapping environment -> slug`);
    }
    for (const [environment, slug] of Object.entries(map)) {
      if (!environments.includes(environment)) {
        throw new Error(
          `manifest.environmentSlugs.${surface} maps "${environment}", absent from manifest.environments`
        );
      }
      if (typeof slug !== "string" || !slug) {
        throw new Error(`manifest.environmentSlugs.${surface}["${environment}"] must be a non-empty slug string`);
      }
      out[surface][environment] = slug;
    }
  }
  return out;
}

/**
 * Resolve the slug one surface uses for a manifest environment. Identity for
 * any environment the manifest does not remap, which is what keeps an absent
 * `environmentSlugs` a no-op for every manifest written before Story #464.
 *
 * @param {object} manifest  A parsed manifest.
 * @param {string} surface
 * @param {string} environment
 * @returns {string}
 */
export function resolveSurfaceEnvironment(manifest, surface, environment) {
  return manifest?.environmentSlugs?.[surface]?.[environment] ?? environment;
}

/**
 * Parse and validate a raw manifest object. Throws with an actionable message
 * on any violation — a manifest is authored by hand, so a vague error costs a
 * round trip.
 *
 * @param {unknown} raw
 * @returns {{environments: string[], workers: Record<string, {config: string, scriptName: string}>, keys: object[]}}
 */
export function parseManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest must be a JSON object");
  }
  const environments = raw.environments;
  if (!Array.isArray(environments) || environments.length === 0 || !environments.every((e) => typeof e === "string")) {
    throw new Error("manifest.environments must be a non-empty array of environment-slug strings");
  }

  const workers = {};
  if (raw.workers !== undefined) {
    if (!raw.workers || typeof raw.workers !== "object" || Array.isArray(raw.workers)) {
      throw new Error("manifest.workers must be an object mapping worker id -> {config, scriptName}");
    }
    for (const [id, w] of Object.entries(raw.workers)) {
      if (!w || typeof w !== "object" || typeof w.scriptName !== "string" || !w.scriptName) {
        throw new Error(`manifest.workers["${id}"].scriptName is required and must be a non-empty string`);
      }
      if (w.config !== undefined && typeof w.config !== "string") {
        throw new Error(`manifest.workers["${id}"].config must be a string path when present`);
      }
      workers[id] = { config: w.config ?? null, scriptName: w.scriptName };
    }
  }

  if (!Array.isArray(raw.keys) || raw.keys.length === 0) {
    throw new Error("manifest.keys must be a non-empty array");
  }

  const environmentSlugs = normalizeEnvironmentSlugs(raw.environmentSlugs, environments);

  const seen = new Set();
  const keys = raw.keys.map((entry, i) => validateKeyEntry(entry, i, workers, environments, seen));

  return { environments: [...environments], environmentSlugs, workers, keys };
}

/**
 * Normalize `residency.github` to its canonical array form.
 *
 * The field accepts EITHER a single `{scope, kind}` object — the shape every
 * manifest written before Story #459 uses — or an array of them, because two
 * residencies that occur in practice cannot be said with one object:
 *
 *   1. **Dual scope.** A key can legitimately live at repository level AND at
 *      environment level, for different consumers: a deploy job declares
 *      `environment:` and reads the per-environment value while a CI job
 *      declares none and reads a repo-level credential of the same name.
 *      Under a single object, whichever scope the manifest declared, the other
 *      reported as an orphan — permanently, on a healthy repo.
 *   2. **Per-environment presence.** A key can be deliberately present in one
 *      environment and absent from another (a production-only analytics token
 *      whose staging counterpart is meant to resolve empty). With no
 *      per-entry `environments`, the absence read as a `missing` failure.
 *
 * Both authored shapes normalize to one array of `{scope, kind, environments}`
 * with `environments` defaulted and materialized to `manifest.environments`,
 * so `probeGitHub` has exactly one shape to read — the same normalize-at-parse
 * treatment `infisical.environments` already receives.
 *
 * Validation fails closed, matching this module's posture on an unknown
 * `shape`: silently ignoring a misplaced or misspelled `environments` is how a
 * manifest author comes to believe they have scoped something they have not.
 *
 * @param {unknown} raw
 * @param {{at: string, name: string, environments: string[]}} ctx
 * @returns {Array<{scope: string, kind: string, environments: string[]}> | null}
 */
function normalizeGitHubResidency(raw, { at, name, environments }) {
  if (raw === undefined || raw === null) return null;

  const authoredAsArray = Array.isArray(raw);
  const entries = authoredAsArray ? raw : [raw];
  if (entries.length === 0) {
    throw new Error(
      `${at}.residency.github must not be an empty array — use null when the key does not belong in GitHub (key ${name})`
    );
  }

  const seenPairs = new Set();
  return entries.map((entry, j) => {
    const where = authoredAsArray ? `${at}.residency.github[${j}]` : `${at}.residency.github`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${where} must be an object with {scope, kind} (key ${name})`);
    }
    if (entry.scope !== "environment" && entry.scope !== "repository") {
      throw new Error(`${where}.scope must be "environment" or "repository" (key ${name})`);
    }
    if (entry.kind !== "secret" && entry.kind !== "var") {
      throw new Error(`${where}.kind must be "secret" or "var" (key ${name})`);
    }

    const pair = `${entry.scope}/${entry.kind}`;
    if (seenPairs.has(pair)) {
      throw new Error(
        `${where} repeats the (scope, kind) pair "${pair}" — declare one entry per pair (key ${name})`
      );
    }
    seenPairs.add(pair);

    if (entry.environments !== undefined) {
      if (entry.scope === "repository") {
        throw new Error(
          `${where}.environments is meaningful only under scope "environment" — a repository-scope ` +
            `secret or variable belongs to no environment (key ${name})`
        );
      }
      if (!Array.isArray(entry.environments) || !entry.environments.every((e) => typeof e === "string")) {
        throw new Error(`${where}.environments must be an array of environment slugs (key ${name})`);
      }
      for (const e of entry.environments) {
        if (!environments.includes(e)) {
          throw new Error(
            `${where}.environments names "${e}", absent from manifest.environments (key ${name})`
          );
        }
      }
    }

    return {
      scope: entry.scope,
      kind: entry.kind,
      environments: entry.environments ? [...entry.environments] : [...environments],
    };
  });
}

/**
 * Normalize `infisical` residency to its canonical `{folders: [...]}` form.
 *
 * The field accepts EITHER a single `{folder, environments}` object — the shape
 * every manifest written before Story #464 uses — or `{folders: [...]}` whose
 * entries are a bare folder path or a `{folder, environments}` object, because
 * two residencies that occur in practice cannot be said with one folder:
 *
 *   1. **Multi-folder residency.** A key can legitimately be resident in more
 *      than one folder, and folder IMPORTS are what make that normal rather
 *      than sloppy: when `/cloudflare` imports `/shared`, a value entering at
 *      `/shared` is genuinely read through `/cloudflare` as well. Both
 *      statements are true and one field could hold only one, so the same
 *      misplacement was counted TWICE — `missing` from the declared folder and
 *      `orphan` in the folder that actually held it.
 *   2. **Per-environment residency.** A key can live in a different folder per
 *      environment (an operator-held credential that arrives via `/github` in
 *      staging only). With no per-entry `environments`, one of the two folders
 *      was always wrong.
 *
 * Both authored shapes normalize to one array of `{folder, environments}` with
 * `environments` defaulted and materialized to `manifest.environments`, so
 * `probeInfisical` has exactly one shape to read — the same normalize-at-parse
 * treatment `residency.github` received in Story #459, so there is one
 * precedent for expressive residency rather than two idioms.
 *
 * @param {unknown} raw
 * @param {{at: string, name: string, environments: string[]}} ctx
 * @returns {"unmanaged" | {folders: Array<{folder: string, environments: string[]}>}}
 */
function normalizeInfisicalResidency(raw, { at, name, environments }) {
  if (raw === undefined || raw === null || raw === "unmanaged") return "unmanaged";
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${at}.infisical must be "unmanaged", {folder, environments} or {folders: [...]} (key ${name})`);
  }

  const hasFolder = raw.folder !== undefined;
  const hasFolders = raw.folders !== undefined;
  if (hasFolder && hasFolders) {
    throw new Error(`${at}.infisical declares both "folder" and "folders" — use one or the other (key ${name})`);
  }
  if (!hasFolder && !hasFolders) {
    throw new Error(`${at}.infisical must declare "folder" or "folders", or be "unmanaged" (key ${name})`);
  }

  let authored;
  if (hasFolder) {
    authored = [{ folder: raw.folder, environments: raw.environments, where: `${at}.infisical` }];
  } else {
    if (!Array.isArray(raw.folders) || raw.folders.length === 0) {
      throw new Error(
        `${at}.infisical.folders must be a non-empty array — use "unmanaged" when the key does not ` +
          `belong in Infisical (key ${name})`
      );
    }
    if (raw.environments !== undefined) {
      throw new Error(
        `${at}.infisical.environments is meaningful only beside a single "folder" — under "folders" ` +
          `each entry carries its own environments (key ${name})`
      );
    }
    authored = raw.folders.map((folderEntry, j) => {
      const where = `${at}.infisical.folders[${j}]`;
      if (typeof folderEntry === "string") return { folder: folderEntry, environments: undefined, where };
      if (!folderEntry || typeof folderEntry !== "object" || Array.isArray(folderEntry)) {
        throw new Error(`${where} must be a folder path string or {folder, environments} (key ${name})`);
      }
      return { folder: folderEntry.folder, environments: folderEntry.environments, where };
    });
  }

  const seenFolders = new Set();
  const folders = authored.map(({ folder, environments: authoredEnvs, where }) => {
    if (typeof folder !== "string" || !folder) {
      throw new Error(`${where}.folder must be a non-empty folder path string (key ${name})`);
    }
    if (seenFolders.has(folder)) {
      throw new Error(`${at}.infisical repeats the folder "${folder}" — declare one entry per folder (key ${name})`);
    }
    seenFolders.add(folder);

    const envs = authoredEnvs ?? environments;
    if (!Array.isArray(envs) || !envs.every((e) => typeof e === "string")) {
      throw new Error(`${at}.infisical.environments must be an array of environment slugs (key ${name})`);
    }
    for (const e of envs) {
      if (!environments.includes(e)) {
        throw new Error(`${at}.infisical.environments names "${e}", absent from manifest.environments (key ${name})`);
      }
    }
    return { folder, environments: [...envs] };
  });

  return { folders };
}

/**
 * Normalize `residency.cloudflare` to its canonical
 * `{workers: [{worker, environments}], kind}` form.
 *
 * `workers` accepts a bare worker id — the shape every manifest written before
 * Story #483 uses — or a `{worker, environments}` object, because a key can be
 * deliberately resident on one Worker in one environment only: a peer-database
 * credential scoped that tightly to bound its blast radius, or a recipient
 * allowlist that exists only where non-production sending is gated. With no
 * per-entry `environments`, `probeCloudflare` reconciled ONE expected-name list
 * against EVERY environment, so a deliberate single-environment placement had
 * to report `missing` from the others — ten findings on one consumer's correct
 * manifest, every one of them false (Story #481).
 *
 * A bare entry keeps meaning "every environment". That is the load-bearing
 * constraint rather than a convenience: every manifest in existence declares
 * `workers` as a bare string array, so any other reading would break them all.
 *
 * Both authored shapes normalize to one array of `{worker, environments}` with
 * `environments` defaulted and materialized to `manifest.environments`, so
 * `probeCloudflare` has exactly one shape to read — the same
 * normalize-at-parse treatment `residency.github` received in Story #459 and
 * `infisical` in Story #464. Cloudflare is the surface that never got it, and
 * matching them matters more than the field shape itself: three expressive
 * residencies with one idiom, not three.
 *
 * One deliberate divergence from those two: an **empty** `environments` array
 * is rejected rather than read as "resident nowhere". That state is
 * indistinguishable from omitting the residency altogether, and silently
 * accepting it is precisely how a manifest author comes to believe they have
 * scoped something they have not — the same fail-closed posture this module
 * takes on an unknown `shape`.
 *
 * @param {unknown} raw
 * @param {{at: string, name: string, workers: Record<string, object>, environments: string[]}} ctx
 * @returns {{workers: Array<{worker: string, environments: string[]}>, kind: string} | null}
 */
function normalizeCloudflareResidency(raw, { at, name, workers, environments }) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${at}.residency.cloudflare must be an object with {workers, kind} (key ${name})`);
  }
  if (!Array.isArray(raw.workers) || raw.workers.length === 0) {
    throw new Error(`${at}.residency.cloudflare.workers must be a non-empty array of worker ids (key ${name})`);
  }
  if (raw.kind !== "secret" && raw.kind !== "var") {
    throw new Error(`${at}.residency.cloudflare.kind must be "secret" or "var" (key ${name})`);
  }

  const seenWorkers = new Set();
  const normalized = raw.workers.map((entry, j) => {
    const where = `${at}.residency.cloudflare.workers[${j}]`;
    let worker;
    let authoredEnvs;
    if (typeof entry === "string") {
      worker = entry;
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      worker = entry.worker;
      authoredEnvs = entry.environments;
    } else {
      throw new Error(`${where} must be a worker id string or {worker, environments} (key ${name})`);
    }

    if (typeof worker !== "string" || !Object.hasOwn(workers, worker)) {
      throw new Error(
        `${at}.residency.cloudflare.workers references unknown worker id ${JSON.stringify(worker)} (key ${name})`
      );
    }
    if (seenWorkers.has(worker)) {
      throw new Error(
        `${at}.residency.cloudflare repeats the worker "${worker}" — declare one entry per worker (key ${name})`
      );
    }
    seenWorkers.add(worker);

    if (authoredEnvs !== undefined) {
      if (!Array.isArray(authoredEnvs) || !authoredEnvs.every((e) => typeof e === "string")) {
        throw new Error(`${where}.environments must be an array of environment slugs (key ${name})`);
      }
      if (authoredEnvs.length === 0) {
        throw new Error(
          `${where}.environments must not be empty — omit it to mean every environment, or drop the entry (key ${name})`
        );
      }
      for (const e of authoredEnvs) {
        if (!environments.includes(e)) {
          throw new Error(`${where}.environments names "${e}", absent from manifest.environments (key ${name})`);
        }
      }
    }

    return { worker, environments: authoredEnvs ? [...authoredEnvs] : [...environments] };
  });

  return { workers: normalized, kind: raw.kind };
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @param {Record<string, object>} workers
 * @param {string[]} environments
 * @param {Set<string>} seen
 */
function validateKeyEntry(entry, index, workers, environments, seen) {
  const at = `manifest.keys[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${at} must be an object`);
  }
  const { name } = entry;
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${at}.name must be a valid environment-variable identifier (got ${JSON.stringify(name)})`);
  }
  if (seen.has(name)) throw new Error(`${at}.name "${name}" is declared more than once`);
  seen.add(name);

  if (entry.kind !== "var" && entry.kind !== "secret") {
    throw new Error(`${at}.kind must be "var" or "secret" (key ${name})`);
  }
  if (entry.sensitivity !== "public" && entry.sensitivity !== "secret") {
    throw new Error(`${at}.sensitivity must be "public" or "secret" (key ${name})`);
  }

  const residency = entry.residency;
  if (!residency || typeof residency !== "object" || Array.isArray(residency)) {
    throw new Error(`${at}.residency must be an object (key ${name})`);
  }

  const local = residency.local ?? null;
  if (local !== null && local !== "var" && local !== "secret" && local !== "file") {
    throw new Error(`${at}.residency.local must be "var", "secret", "file" or null (key ${name})`);
  }

  const github = normalizeGitHubResidency(residency.github, { at, name, environments });

  const cloudflare = normalizeCloudflareResidency(residency.cloudflare, { at, name, workers, environments });

  const infisical = normalizeInfisicalResidency(entry.infisical, { at, name, environments });

  if (entry.shape !== undefined) {
    if (typeof entry.shape !== "string" || !Object.hasOwn(SHAPE_VOCABULARY, entry.shape)) {
      throw new Error(
        `${at}.shape "${entry.shape}" is not in the supported vocabulary (key ${name}). ` +
          `Supported shapes: ${SHAPE_NAMES.join(", ")}.`
      );
    }
  }
  if (entry.placeholderPattern !== undefined && typeof entry.placeholderPattern !== "string") {
    throw new Error(`${at}.placeholderPattern must be a literal substring string (key ${name})`);
  }

  return {
    name,
    kind: entry.kind,
    sensitivity: entry.sensitivity,
    residency: {
      local,
      github,
      cloudflare,
    },
    infisical,
    shape: entry.shape ?? null,
    placeholderPattern: entry.placeholderPattern ?? null,
    note: typeof entry.note === "string" ? entry.note : null,
  };
}

/**
 * Substitute `{env}` in a worker's script name.
 *
 * @param {string} scriptName
 * @param {string} environment
 * @returns {string}
 */
export function resolveScriptName(scriptName, environment) {
  return scriptName.split("{env}").join(environment);
}

// ---------------------------------------------------------------------------
// Shape checking — values in, verdict out. A value never leaves this function.
// ---------------------------------------------------------------------------

/**
 * Check one value against a shape name and an optional placeholder substring.
 *
 * The value is NEVER included in the returned object: the whole point of this
 * seam is that the caller receives a verdict it can safely render.
 *
 * @param {object} opts
 * @param {string} opts.value
 * @param {string | null} opts.shape
 * @param {string | null} [opts.placeholderPattern]
 * @returns {{ok: boolean, reason: string | null}}
 */
export function checkShape({ value, shape, placeholderPattern = null }) {
  if (typeof value !== "string") return { ok: false, reason: "value is not a string" };
  if (placeholderPattern && value.toLowerCase().includes(placeholderPattern.toLowerCase())) {
    return { ok: false, reason: `value still contains the placeholder marker "${placeholderPattern}"` };
  }
  if (!shape) return { ok: true, reason: null };
  const re = SHAPE_VOCABULARY[shape];
  if (!re) return { ok: false, reason: `unknown shape "${shape}"` };
  return re.test(value) ? { ok: true, reason: null } : { ok: false, reason: `value does not match shape "${shape}"` };
}

// ---------------------------------------------------------------------------
// HTTP seam — one fetch wrapper, one fail-closed error policy
// ---------------------------------------------------------------------------

/**
 * Production request bounds. Every one is a CLIENT-CONSTRUCTOR option so the
 * sibling suite can pass millisecond-scale values: a suite that had to wait
 * out the real budget would simply not assert the timeout at all.
 *
 * A nightly drift gate hanging on one unresponsive store is the fail-open this
 * module exists to refuse in a slower disguise — the job burns its runner
 * minutes and reports nothing, which reads in the Actions UI as a run that has
 * not finished rather than a probe that failed.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRY_DELAY_MS = 500;

/** Attempts per request, INCLUDING the first. */
export const MAX_ATTEMPTS = 3;

/**
 * Pages a single listing may follow before the probe fails closed. A store
 * that keeps handing back a `rel="next"` is malfunctioning, and truncating its
 * listing silently would report every un-fetched name as an orphan-free match
 * — the same "no drift because we stopped looking" this module refuses.
 */
export const MAX_PAGES = 50;

/**
 * Which HTTP failures are worth a second attempt. 429 and 5xx are transient by
 * definition; everything else is a statement about the request itself. Retrying
 * a 401 just spends the budget three times to learn what the first attempt said,
 * and retrying a 404 would fight the one degradation rule this module allows.
 *
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with a deadline that does not depend on the fetch honouring it.
 *
 * An `AbortSignal` alone is a REQUEST to stop, and it is only as good as the
 * implementation reading it — a stub, a polyfill, or a wrapper that rebuilds
 * `init` can drop `init.signal` without any error, and the await then never
 * returns. So the signal is passed (real `fetch` uses it to release the socket)
 * AND raced against a timer, and the timer is what actually bounds the call.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`${init.method ?? "GET"} ${redactUrl(url)} timed out after ${timeoutMs}ms`);
      err.timedOut = true;
      reject(err);
    }, timeoutMs);
  });
  // Resolve.then keeps a fetchImpl that THROWS synchronously on the same
  // rejection path as one that returns a rejected promise.
  const pending = Promise.resolve().then(() => fetchImpl(url, { ...init, signal: controller.signal }));
  // The loser of the race still settles. Absorbing its rejection here is what
  // keeps a post-timeout abort from surfacing as an unhandled rejection and
  // tearing down a process that has already handled the timeout.
  pending.catch(() => {});
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Perform one bounded, retried request and return the raw `Response`.
 *
 * Any HTTP failure is tagged with `.httpStatus`, so a caller can apply the
 * 404-only degradation rule (see the module docblock).
 *
 * **A timeout is never retried.** Retrying it would multiply the wall clock by
 * the attempt count, and the surface's whole contract is that it fails within
 * its budget rather than eventually.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{timeoutMs?: number, retryDelayMs?: number, maxAttempts?: number}} [options]
 * @returns {Promise<Response>}
 */
export async function requestResponse(fetchImpl, url, init = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);
    } catch (err) {
      if (err?.timedOut) throw err;
      lastError = err;
      if (attempt === maxAttempts) throw err;
      await sleep(retryDelayMs * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res;
    // The body can echo request context; it is never a secret VALUE (these are
    // name-listing endpoints), but it is also not needed — the status is what
    // routes the decision, so only the status and a redacted URL are surfaced.
    const err = new Error(`${init.method ?? "GET"} ${redactUrl(url)} failed: ${res.status} ${res.statusText}`);
    err.httpStatus = res.status;
    lastError = err;
    if (!isRetryableStatus(res.status) || attempt === maxAttempts) throw err;
    await sleep(retryDelayMs * 2 ** (attempt - 1));
  }
  /* c8 ignore next 2 -- unreachable: every loop exit above returns or throws. */
  throw lastError ?? new Error(`${redactUrl(url)} failed with no attempt recorded`);
}

/**
 * `requestResponse`, decoded as JSON — what every non-paginating call wants.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{timeoutMs?: number, retryDelayMs?: number, maxAttempts?: number}} [options]
 * @returns {Promise<unknown>}
 */
export async function requestJson(fetchImpl, url, init = {}, options = {}) {
  const res = await requestResponse(fetchImpl, url, init, options);
  return res.json();
}

/**
 * The `rel="next"` URL of an RFC 8288 `Link` header, or `null`.
 *
 * Parsed by splitting rather than by regex, deliberately twice over: a pattern
 * over a header carrying a URL is the shape CodeQL flags as an unanchored host
 * match, and the grammar here — comma-separated `<uri>; param=value` — is
 * cleanly separable without one.
 *
 * @param {string | null | undefined} header
 * @returns {string | null}
 */
export function linkNextUrl(header) {
  if (typeof header !== "string" || header.length === 0) return null;
  for (const part of header.split(",")) {
    const segment = part.trim();
    if (!segment.startsWith("<")) continue;
    const close = segment.indexOf(">");
    if (close === -1) continue;
    const url = segment.slice(1, close);
    for (const param of segment.slice(close + 1).split(";")) {
      const [rawName, ...rest] = param.split("=");
      if (rawName.trim().toLowerCase() !== "rel") continue;
      let value = rest.join("=").trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.toLowerCase() === "next" && url.length > 0) return url;
    }
  }
  return null;
}

/**
 * Strip the query string from a URL before it reaches a log line. Query
 * parameters carry project ids and environment slugs, and a future caller
 * could put something sensitive there; the path alone identifies the endpoint.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}

/**
 * The single place a probe error becomes a surface result. A 404 is the ONLY
 * status that may degrade into "absent" — every other failure fails closed as
 * an `error` surface, which the exit contract treats as a failing run.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbsentStatus(err) {
  return Boolean(err && typeof err === "object" && err.httpStatus === 404);
}

// ---------------------------------------------------------------------------
// Surface probes — each returns names ONLY
// ---------------------------------------------------------------------------

/**
 * Parse a dotenv-style file into a name -> value map. Used for the local
 * surface, whose only input is the committed `.env.example` — a placeholder
 * file by construction. Values are parsed because the format has them, and
 * only names cross the boundary.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const name = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

/**
 * Reduce a JSONC document to JSON: drop `//` and block comments, drop trailing
 * commas, and leave everything inside a string literal untouched.
 *
 * A character scanner rather than a substitution, for two independent reasons.
 * The correctness one: a pattern cannot tell a `//` that opens a comment from
 * one inside `"https://example.test"`, and the line-comment substitution this
 * replaces truncated exactly that value — quietly, since the result usually
 * still parsed. The policy one: this repo's SAST refuses a dynamically built
 * `RegExp` outright, so the parsing rules a config like this needs are written
 * as code or not at all.
 *
 * `wrangler.jsonc` is a real shape, not a hypothetical: create-cloudflare's own
 * template emits trailing commas, and until Story #487 every one of them made
 * this function return an empty set — which the caller then read as "this
 * worker declares no vars", the false no-drift verdict.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      // Keep the newline: JSON ignores it, but a preserved line count keeps a
      // `JSON.parse` position error pointing at the author's own line.
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Extract the `[vars]` block key names from a wrangler config. Supports both
 * TOML (`[vars]` / `[env.<name>.vars]`) and JSON/JSONC (`"vars": {…}`) — the
 * two shapes wrangler accepts.
 *
 * **Throws** when a `.json`/`.jsonc` config cannot be parsed even after the
 * JSONC reduction. Returning `[]` there — as this did until Story #487 — is
 * indistinguishable from a config that genuinely declares nothing, so the
 * caller reported no drift precisely because it could not read the file. The
 * caller turns the throw into one `fail` finding on the `wrangler` surface.
 *
 * @param {string} text
 * @param {string} path  Used only to pick the parser by extension.
 * @returns {string[]} Sorted var names.
 * @throws {Error} With `.wranglerParseFailure === true` on unparseable JSONC.
 */
export function parseWranglerVars(text, path) {
  const names = new Set();
  if (/\.jsonc?$/.test(path)) {
    let doc;
    try {
      doc = JSON.parse(stripJsonc(text));
    } catch (err) {
      const failure = new Error(`is not parseable as JSON/JSONC even after comment and trailing-comma removal: ${err.message}`);
      failure.wranglerParseFailure = true;
      throw failure;
    }
    collectJsonVars(doc, names);
    return [...names].sort();
  }
  // TOML: collect every key directly under a `[vars]` or `[env.X.vars]` table.
  let inVars = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inVars = /^\[(?:env\.[^\].]+\.)?vars\]$/.test(line);
      continue;
    }
    if (!inVars || !line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

/**
 * @param {unknown} node
 * @param {Set<string>} names
 */
function collectJsonVars(node, names) {
  if (!node || typeof node !== "object") return;
  if (node.vars && typeof node.vars === "object" && !Array.isArray(node.vars)) {
    for (const k of Object.keys(node.vars)) names.add(k);
  }
  if (node.env && typeof node.env === "object") {
    for (const child of Object.values(node.env)) collectJsonVars(child, names);
  }
}

/**
 * GitHub Actions secret/variable NAME probe. Values are not exposed by these
 * endpoints at all, which is why this surface is inherently values-safe.
 *
 * Requires a fine-grained PAT with `Secrets: read` and `Variables: read`:
 * there is NO `permissions:` scope that grants the workflow `GITHUB_TOKEN`
 * access to either collection, so the default token can never serve this probe
 * (verified against the workflow-syntax permissions reference, 2026-09).
 *
 * `per_page=100` bounds a PAGE, not the collection. A repository with more
 * than a hundred Actions secrets returns the first hundred and a `Link` header
 * naming the rest, and reading only page one reports every name beyond it as
 * `missing` while every genuine orphan past the boundary goes unseen — drift
 * invented and drift hidden by the same omission. So every listing follows
 * `rel="next"` to completion, and a listing that will not end fails closed.
 *
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.repo  "owner/name"
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.apiBase]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retryDelayMs]
 */
export function createGitHubClient({
  token,
  repo,
  fetchImpl = fetch,
  apiBase = GITHUB_API_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const bounds = { timeoutMs, retryDelayMs };

  /**
   * @param {string} path
   * @param {(body: any) => Array<{name: string}>} pick
   * @returns {Promise<string[]>}
   */
  async function listAll(path, pick) {
    const names = [];
    let url = `${apiBase}${path}`;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await requestResponse(fetchImpl, url, { headers }, bounds);
      const body = await res.json();
      for (const entry of pick(body) ?? []) if (entry?.name) names.push(entry.name);
      const next = linkNextUrl(typeof res.headers?.get === "function" ? res.headers.get("link") : null);
      if (!next) return names.sort();
      url = next;
    }
    throw new Error(`${redactUrl(`${apiBase}${path}`)} still offered a rel="next" after ${MAX_PAGES} pages`);
  }

  /**
   * @param {string} prefix
   * @returns {Promise<{secret: string[], var: string[]}>}
   */
  async function namesUnder(prefix) {
    const [secret, vars] = await Promise.all([
      listAll(`${prefix}/secrets?per_page=100`, (b) => b.secrets ?? []),
      listAll(`${prefix}/variables?per_page=100`, (b) => b.variables ?? []),
    ]);
    return { secret, var: vars };
  }

  return {
    repositoryNames() {
      return namesUnder(`/repos/${repo}/actions`);
    },
    environmentNames(environment) {
      return namesUnder(`/repos/${repo}/environments/${encodeURIComponent(environment)}`);
    },
  };
}

/**
 * Cloudflare Worker secret NAME probe. The Workers API returns `{name, type}`
 * per binding and no value, by design.
 *
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.accountId
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.apiBase]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retryDelayMs]
 */
export function createCloudflareClient({
  token,
  accountId,
  fetchImpl = fetch,
  apiBase = CLOUDFLARE_API_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const bounds = { timeoutMs, retryDelayMs };
  return {
    async secretNames(scriptName) {
      const body = await requestJson(
        fetchImpl,
        `${apiBase}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
        { headers },
        bounds
      );
      return (body.result ?? []).map((s) => s.name).sort();
    },
  };
}

/**
 * Flatten a v4 secrets response into the secrets RESIDENT AT THE REQUESTED
 * FOLDER — its own entries plus everything reaching it through an import.
 *
 * The v4 list endpoint answers in two parts: `secrets[]` holds what the queried
 * folder defines itself, and a separate top-level `imports[]` holds one group
 * per import, each carrying the SOURCE folder in `secretPath`. Reading only the
 * first part is what made a folder that imports its whole content report every
 * key `missing` — the store had the secret, the Worker would resolve it, and
 * the doctor said it was absent.
 *
 * `imports[].secretPath` is deliberately DISCARDED rather than used to
 * re-attribute the name. The manifest declares where a key must be RESOLVABLE,
 * which is the folder the deploy reads; attributing an imported key back to
 * `/shared` would report it missing from the folder that legitimately resolves
 * it and orphaned in a folder the manifest never asked about.
 *
 * A name defined directly in the queried folder wins over an imported one of
 * the same name, matching Infisical's own precedence — so the shape stage
 * checks the value the deploy would actually see.
 *
 * @param {unknown} body
 * @returns {Array<{secretKey: string, secretValue?: string}>}
 */
export function collectInfisicalSecrets(body) {
  const merged = new Map();
  const add = (entry) => {
    if (entry && typeof entry.secretKey === "string" && entry.secretKey.length > 0) {
      merged.set(entry.secretKey, entry);
    }
  };
  const imports = Array.isArray(body?.imports) ? body.imports : [];
  for (const group of imports) {
    for (const entry of Array.isArray(group?.secrets) ? group.secrets : []) add(entry);
  }
  for (const entry of Array.isArray(body?.secrets) ? body.secrets : []) add(entry);
  return [...merged.values()];
}

/**
 * Infisical client. Authenticates with a pre-issued access token when one is
 * supplied, otherwise with a Universal Auth machine identity.
 *
 * Accepting a pre-issued token is deliberate: it removes any dependency on a
 * consumer's Infisical plan permitting machine identities. Either credential
 * reaches the same read-only listing calls.
 *
 * `listNames` passes `viewSecretValue=false` so the residency probe cannot
 * pull a value into this process at all. `listValues` is the ONLY call that
 * requests values, and only the shape stage invokes it.
 *
 * @param {object} opts
 * @param {string} [opts.token]
 * @param {string} [opts.clientId]
 * @param {string} [opts.clientSecret]
 * @param {string} opts.projectId
 * @param {string} [opts.siteUrl]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retryDelayMs]
 */
export function createInfisicalClient({
  token = null,
  clientId = null,
  clientSecret = null,
  projectId,
  siteUrl = INFISICAL_DEFAULT_SITE,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  const base = siteUrl.replace(/\/+$/, "");
  const bounds = { timeoutMs, retryDelayMs };
  let accessToken = token;

  async function auth() {
    if (accessToken) return accessToken;
    const body = await requestJson(
      fetchImpl,
      `${base}/api/v1/auth/universal-auth/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      },
      bounds
    );
    if (!body.accessToken) throw new Error("Infisical universal-auth login returned no accessToken");
    accessToken = body.accessToken;
    return accessToken;
  }

  async function list({ environment, folder, withValues }) {
    const t = await auth();
    const params = new URLSearchParams({
      projectId,
      environment,
      secretPath: folder || "/",
      viewSecretValue: withValues ? "true" : "false",
      // Sent EXPLICITLY. The upstream default is documented as true, and a
      // default is not a contract — a server-side change to it would silently
      // hide every imported secret and report each one `missing`, which is the
      // false-drift twin of the false no-drift this module is built against.
      includeImports: "true",
    });
    const body = await requestJson(
      fetchImpl,
      `${base}/api/v4/secrets?${params.toString()}`,
      { headers: { Authorization: `Bearer ${t}` } },
      bounds
    );
    return collectInfisicalSecrets(body);
  }

  return {
    async listNames({ environment, folder }) {
      const secrets = await list({ environment, folder, withValues: false });
      return secrets.map((s) => s.secretKey).sort();
    },
    async listValues({ environment, folder }) {
      const secrets = await list({ environment, folder, withValues: true });
      const out = new Map();
      for (const s of secrets) out.set(s.secretKey, s.secretValue ?? "");
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Offline arm — manifest vs. what the repo itself declares
// ---------------------------------------------------------------------------

/**
 * Collect every `secrets.X` / `vars.X` name referenced by a workflow file.
 *
 * The pattern is a literal RegExp over the raw file text rather than a YAML
 * parse: a reference can appear anywhere an expression can, including inside
 * a `run:` block's shell, and a structural walk would miss those.
 *
 * Two narrowings keep that reach from over-claiming, and each one had produced
 * a manifest key that had to exist for a variable that does not:
 *
 *   - **A whole-line YAML comment is prose, not a reference.** The `#` line
 *     documenting which secret a caller should pass is the single most common
 *     place either token appears, and demanding a manifest entry for it makes
 *     the doctor fail on its own documentation.
 *   - **`vars` reached as a property of something else is not the `vars`
 *     context.** `steps.build.outputs.vars.PROFILE` is a step output that
 *     happens to be named `vars`; `\b` matched it, because a `.` is a word
 *     boundary. The lookbehind refuses any match preceded by a `.` or an
 *     identifier character, which is exactly the set of ways a longer path
 *     can end just before this one starts.
 *
 * @param {string} text
 * @returns {{secrets: string[], vars: string[]}}
 */
export function collectWorkflowReferences(text) {
  const secrets = new Set();
  const vars = new Set();
  const scannable = text
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith("#") ? "" : line))
    .join("\n");
  const re = /(?<![\w.])(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m = re.exec(scannable);
  while (m !== null) {
    (m[1] === "secrets" ? secrets : vars).add(m[2]);
    m = re.exec(scannable);
  }
  return { secrets: [...secrets].sort(), vars: [...vars].sort() };
}

/**
 * The offline arm: everything checkable with no credential at all.
 *
 * @param {object} opts
 * @param {ReturnType<typeof parseManifest>} opts.manifest
 * @param {string} opts.repoRoot
 * @returns {{findings: object[], checked: string[]}}
 */
export function runOfflineChecks({ manifest, repoRoot }) {
  const findings = [];
  const checked = [];
  const declared = new Set(manifest.keys.map((k) => k.name));

  // 1. Workflow expression references must be declared (or GitHub built-ins).
  const workflowDir = join(repoRoot, ".github", "workflows");
  const workflowFiles = listWorkflowFiles(workflowDir);
  if (workflowFiles.length > 0) {
    checked.push("workflow-references");
    for (const file of workflowFiles) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { secrets, vars } = collectWorkflowReferences(text);
      for (const [names, kind] of [
        [secrets, "secret"],
        [vars, "var"],
      ]) {
        for (const name of names) {
          if (GITHUB_BUILTIN_NAMES.has(name) || declared.has(name)) continue;
          findings.push({
            severity: "fail",
            kind: "undeclared-reference",
            key: name,
            surface: "workflow",
            environment: null,
            detail: `${file.replace(`${repoRoot}/`, "")} references ${kind === "secret" ? "secrets" : "vars"}.${name}, which no manifest key declares`,
          });
        }
      }
    }
  }

  // 2. `.env.example` keys must be declared, and every locally-resident key
  //    must appear in `.env.example` — the file is the onboarding contract.
  const examplePath = join(repoRoot, ".env.example");
  if (existsSync(examplePath)) {
    checked.push("env-example");
    const example = parseDotenv(readFileSync(examplePath, "utf8"));
    for (const name of Object.keys(example)) {
      if (!declared.has(name)) {
        findings.push({
          severity: "fail",
          kind: "undeclared-reference",
          key: name,
          surface: "env-example",
          environment: null,
          detail: ".env.example declares a key absent from the manifest",
        });
      }
    }
    for (const key of manifest.keys) {
      if (key.residency.local && !Object.hasOwn(example, key.name)) {
        findings.push({
          severity: "fail",
          kind: "missing",
          key: key.name,
          surface: "env-example",
          environment: null,
          detail: `manifest declares residency.local = "${key.residency.local}" but .env.example does not list the key`,
        });
      }
    }
  }

  // 3. Wrangler `[vars]` must match the manifest's cloudflare var residency.
  for (const [id, worker] of Object.entries(manifest.workers)) {
    if (!worker.config) continue;
    const configPath = isAbsolute(worker.config) ? worker.config : join(repoRoot, worker.config);
    if (!existsSync(configPath)) {
      findings.push({
        severity: "fail",
        kind: "missing",
        key: null,
        surface: "wrangler",
        environment: null,
        detail: `manifest.workers["${id}"].config points at ${worker.config}, which does not exist`,
      });
      continue;
    }
    let present;
    try {
      present = new Set(parseWranglerVars(readFileSync(configPath, "utf8"), configPath));
    } catch (err) {
      // One finding, and the worker's expected/orphan reconciliation is
      // skipped entirely: reporting every declared var as `missing` from a
      // file nobody could read blames the manifest for the config's syntax.
      findings.push({
        severity: "fail",
        kind: "unreadable",
        key: null,
        surface: "wrangler",
        environment: null,
        detail: `manifest.workers["${id}"].config ${worker.config} ${err.message}`,
      });
      continue;
    }
    checked.push(`wrangler:${id}`);
    const expected = manifest.keys.filter(
      // Environment-agnostic by design: this check reports `environment: null`
      // and `parseWranglerVars` flattens `[env.X.vars]` into one set, so there
      // is no environment axis to narrow against. A var declared for ANY
      // environment stays expected in that worker's config.
      (k) =>
        k.residency.cloudflare?.kind === "var" &&
        k.residency.cloudflare.workers.some((w) => w.worker === id)
    );
    for (const key of expected) {
      if (!present.has(key.name)) {
        findings.push({
          severity: "fail",
          kind: "missing",
          key: key.name,
          surface: "wrangler",
          environment: null,
          detail: `worker "${id}" declares cloudflare var residency but ${worker.config} has no [vars] entry`,
        });
      }
    }
    for (const name of present) {
      if (!declared.has(name)) {
        findings.push({
          severity: "orphan",
          kind: "orphan",
          key: name,
          surface: "wrangler",
          environment: null,
          detail: `${worker.config} declares a [vars] key absent from the manifest`,
        });
      }
    }
  }

  return { findings, checked };
}

// ---------------------------------------------------------------------------
// Live surfaces — reconcile manifest residency against probed names
// ---------------------------------------------------------------------------

/**
 * Reconcile one surface's probed name set against what the manifest expects.
 *
 * @param {object} opts
 * @param {string[]} opts.expected  Manifest-declared names for this surface.
 * @param {string[]} opts.present   Probed names.
 * @param {string} opts.surface
 * @param {string | null} opts.environment
 * @param {string} [opts.scope]     Free-text scope for the detail line.
 * @param {Iterable<string> | null} [opts.declaredElsewhere]
 *   Names the caller has already accounted for in a SIBLING partition of the
 *   same surface. A name in this set is never reported as an orphan here; it
 *   has no effect on `missing`. The option exists because a surface can be
 *   probed in more than one partition — GitHub is read at repository scope and
 *   again per environment — and a key legitimately resident in two of them is
 *   not drift. Only the caller knows which partitions are siblings, so the set
 *   is supplied rather than inferred: the default is `null`, which keeps this
 *   function's behaviour identical for every caller that omits it.
 * @returns {object[]} findings
 */
export function reconcileNames({ expected, present, surface, environment, scope = "", declaredElsewhere = null }) {
  const findings = [];
  const presentSet = new Set(present);
  const expectedSet = new Set(expected);
  const elsewhere = declaredElsewhere ? new Set(declaredElsewhere) : null;
  const where = scope ? ` (${scope})` : "";
  for (const name of expected) {
    if (!presentSet.has(name)) {
      findings.push({
        severity: "fail",
        kind: "missing",
        key: name,
        surface,
        environment,
        detail: `declared in the manifest but absent from ${surface}${where}`,
      });
    }
  }
  for (const name of present) {
    if (!expectedSet.has(name)) {
      if (elsewhere?.has(name)) continue;
      findings.push({
        severity: "orphan",
        kind: "orphan",
        key: name,
        surface,
        environment,
        detail: `present in ${surface}${where} but declared by no manifest key`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

/**
 * Parse an exceptions document. Every entry carries a `revisit-date`: an
 * exception with no expiry is a permanent silence, which is how drift becomes
 * invisible. An expired entry FAILS the run rather than lapsing quietly —
 * lapsing quietly would re-raise a finding the operator already chose to defer
 * without anyone noticing the deferral had run out.
 *
 * `severity` selects WHICH finding an entry silences and defaults to `"fail"`.
 * The `"orphan"` form exists because the alternative was worse: the only way
 * to silence one known orphan under `--strict-orphans` was to add a manifest
 * key for a secret the project does not actually declare, which buys quiet by
 * making the manifest lie — and a lying manifest is the exact false no-drift
 * this whole module refuses. An orphan exception still expires on its date.
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
export function parseExceptions(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.exceptions ?? []);
  if (!Array.isArray(list)) throw new Error("exceptions must be an array, or an object with an `exceptions` array");
  return list.map((e, i) => {
    if (!e || typeof e !== "object") throw new Error(`exceptions[${i}] must be an object`);
    if (typeof e.key !== "string" || !e.key) throw new Error(`exceptions[${i}].key is required`);
    const revisit = e["revisit-date"] ?? e.revisitDate;
    if (typeof revisit !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(revisit)) {
      throw new Error(`exceptions[${i}] ("${e.key}") requires a "revisit-date" in YYYY-MM-DD form`);
    }
    if (Number.isNaN(Date.parse(`${revisit}T00:00:00Z`))) {
      throw new Error(`exceptions[${i}] ("${e.key}") has an unparseable revisit-date "${revisit}"`);
    }
    const severity = e.severity ?? "fail";
    if (severity !== "fail" && severity !== "orphan") {
      throw new Error(
        `exceptions[${i}] ("${e.key}").severity must be "fail" or "orphan" — got "${severity}". ` +
          `Omit it to default to "fail".`
      );
    }
    return {
      key: e.key,
      surface: e.surface ?? null,
      environment: e.environment ?? null,
      severity,
      reason: typeof e.reason === "string" ? e.reason : "",
      revisitDate: revisit,
    };
  });
}

/**
 * Apply exceptions to a finding list.
 *
 * @param {object} opts
 * @param {object[]} opts.findings
 * @param {object[]} opts.exceptions
 * @param {Date} [opts.now]
 * @returns {{findings: object[], suppressed: object[], expired: object[]}}
 */
export function applyExceptions({ findings, exceptions, now = new Date() }) {
  const today = now.toISOString().slice(0, 10);
  const expired = exceptions.filter((e) => e.revisitDate < today);
  const active = exceptions.filter((e) => e.revisitDate >= today);

  const suppressed = [];
  const kept = [];
  for (const f of findings) {
    const match = active.find(
      (e) =>
        e.key === f.key &&
        e.severity === f.severity &&
        (e.surface === null || e.surface === f.surface) &&
        (e.environment === null || e.environment === f.environment)
    );
    if (match) {
      suppressed.push({ ...f, exception: match });
    } else {
      kept.push(f);
    }
  }
  return { findings: kept, suppressed, expired };
}

// ---------------------------------------------------------------------------
// Exit contract
// ---------------------------------------------------------------------------

/**
 * Resolve the environments to check, failing CLOSED on one the manifest does
 * not declare.
 *
 * Nothing downstream can catch a misspelling. `--environments prodcution`
 * against a manifest declaring `production` narrows every reconcile to a slug
 * no key claims, so `expected` is empty everywhere, the stores are asked for
 * folders and environments that do not exist, and the run exits 0 with every
 * surface `checked` and zero findings — the most convincing possible report
 * that nothing is wrong, produced by a run that examined nothing. A typo in a
 * cron-scheduled workflow input can hold that state indefinitely.
 *
 * An empty request is not an error: it means "use the manifest's own list",
 * which is exactly what the reusable workflow's empty `environments` input
 * interpolates to.
 *
 * @param {object} opts
 * @param {string | null | undefined} opts.requested  Raw comma-separated CLI/input value.
 * @param {{environments: string[]}} opts.manifest
 * @returns {string[]}
 * @throws {Error} When a requested slug is not in `manifest.environments`.
 */
export function resolveEnvironments({ requested, manifest }) {
  const wanted =
    typeof requested === "string"
      ? requested
          .split(",")
          .map((slug) => slug.trim())
          .filter(Boolean)
      : [];
  if (wanted.length === 0) return manifest.environments;
  const unknown = wanted.filter((slug) => !manifest.environments.includes(slug));
  if (unknown.length > 0) {
    throw new Error(
      `--environments requested ${unknown.map((slug) => `"${slug}"`).join(", ")}, which manifest.environments ` +
        `does not declare. Declared environments: ${manifest.environments.join(", ")}. ` +
        `Nothing was probed — an undeclared environment would report zero findings on every surface.`
    );
  }
  return wanted;
}

/**
 * Decide the process exit code from a completed report.
 *
 * An `unchecked` surface never contributes: an absent credential is a coverage
 * gap the notice reports, not a failure. An `error` surface always does — see
 * the module docblock on why the two must not be conflated.
 *
 * @param {object} opts
 * @param {object[]} opts.findings
 * @param {object[]} opts.expired
 * @param {object[]} opts.surfaces
 * @param {boolean} opts.strictOrphans
 * @returns {number}
 */
export function computeExitCode({ findings, expired, surfaces, strictOrphans }) {
  if (expired.length > 0) return 1;
  if (surfaces.some((s) => s.status === "error")) return 1;
  if (findings.some((f) => f.severity === "fail")) return 1;
  if (strictOrphans && findings.some((f) => f.severity === "orphan")) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Rendering — verdicts only, never a value
// ---------------------------------------------------------------------------

/**
 * @param {object} report
 * @returns {string}
 */
export function renderReport(report) {
  const lines = [];
  lines.push("env-doctor — environment & secret residency report");
  lines.push("");

  for (const s of report.surfaces) {
    const icon = s.status === "checked" ? "✅" : s.status === "unchecked" ? "⏭️ " : "❌";
    lines.push(`${icon} ${s.surface}: ${s.status}${s.notice ? ` — ${s.notice}` : ""}`);
  }
  lines.push("");

  const fails = report.findings.filter((f) => f.severity === "fail");
  const orphans = report.findings.filter((f) => f.severity === "orphan");

  if (fails.length === 0 && orphans.length === 0) {
    lines.push("No drift found across the checked surfaces.");
  }
  for (const f of fails) {
    lines.push(`FAIL  [${f.surface}${f.environment ? `/${f.environment}` : ""}] ${f.key ?? "-"}: ${f.detail}`);
  }
  for (const f of orphans) {
    const label = report.strictOrphans ? "FAIL " : "ORPHN";
    lines.push(`${label} [${f.surface}${f.environment ? `/${f.environment}` : ""}] ${f.key ?? "-"}: ${f.detail}`);
  }

  if (report.suppressed.length > 0) {
    lines.push("");
    lines.push("Suppressed by an active exception:");
    for (const s of report.suppressed) {
      lines.push(
        `  - ${s.key} [${s.surface}${s.environment ? `/${s.environment}` : ""}] (${s.severity}) — ` +
          `revisit ${s.exception.revisitDate}${s.exception.reason ? `: ${s.exception.reason}` : ""}`
      );
    }
  }
  if (report.expired.length > 0) {
    lines.push("");
    lines.push("EXPIRED exceptions (these fail the run):");
    for (const e of report.expired) {
      lines.push(`  - ${e.key} — revisit-date ${e.revisitDate} has passed${e.reason ? `: ${e.reason}` : ""}`);
    }
  }

  lines.push("");
  lines.push(
    `Summary: ${fails.length} failure(s), ${orphans.length} orphan(s), ` +
      `${report.suppressed.length} suppressed, ${report.expired.length} expired exception(s).`
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the doctor. Every external dependency is injected, so the sibling test
 * suite exercises the whole orchestration with zero network access.
 *
 * @param {object} opts
 * @returns {Promise<object>} The report.
 */
export async function runDoctor({
  manifest,
  repoRoot,
  environments,
  offline = false,
  strictOrphans = false,
  exceptions = [],
  github = null,
  cloudflare = null,
  infisical = null,
  unavailability = {},
  now = new Date(),
}) {
  const surfaces = [];
  let findings = [];

  const offlineResult = runOfflineChecks({ manifest, repoRoot });
  findings.push(...offlineResult.findings);
  surfaces.push({
    surface: "offline",
    status: "checked",
    notice: `${offlineResult.checked.length} check(s): ${offlineResult.checked.join(", ") || "none applicable"}`,
  });

  if (offline) {
    // Report the live surfaces as explicitly skipped rather than omitting
    // them. Silence and "checked" look identical in a summary, which is the
    // same failure mode the workflow avoids by never `if:`-skipping its job.
    for (const surface of LIVE_SURFACES) {
      surfaces.push({ surface, status: "unchecked", notice: OFFLINE_NOTICE });
    }
  } else {
    await probeGitHub({ manifest, environments, github, surfaces, findings, unavailability });
    await probeCloudflare({ manifest, environments, cloudflare, surfaces, findings, unavailability });
    await probeInfisical({ manifest, environments, infisical, surfaces, findings, unavailability });
  }

  const applied = applyExceptions({ findings, exceptions, now });
  findings = applied.findings;

  const report = {
    findings,
    suppressed: applied.suppressed,
    expired: applied.expired,
    surfaces,
    strictOrphans,
    environments,
  };
  report.exitCode = computeExitCode({ findings, expired: applied.expired, surfaces, strictOrphans });
  return report;
}

/**
 * Why a live surface has no client — the distinction the notices depend on.
 *
 * A surface can be `unchecked` for three different reasons, and until Story
 * #455 all three rendered as the first one. That is not a cosmetic problem:
 * "no Cloudflare API token supplied" sends a reader to re-issue a token that
 * was never the thing missing, which is exactly how the reusable workflow's
 * inability to pass an account id survived a release.
 */
const NO_CREDENTIAL_NOTICE = {
  github: "no GitHub token supplied — Actions secret/variable names were not compared",
  cloudflare: "no Cloudflare API token supplied — Worker secret names were not compared",
  infisical: "no Infisical credential supplied — secret names and value shapes were not compared",
};

/** A credential WAS supplied; the identifier naming what to read was not. */
const MISSING_IDENTIFIER_NOTICE = {
  github:
    "no repository supplied (GITHUB_REPOSITORY, or --repo) — a GitHub token WAS supplied; Actions secret/variable names were not compared",
  cloudflare:
    "no Cloudflare account id supplied (CLOUDFLARE_ACCOUNT_ID, or --cloudflare-account) — an API token WAS supplied; Worker secret names were not compared",
  infisical:
    "no Infisical project id supplied (INFISICAL_PROJECT_ID, or --infisical-project) — a credential WAS supplied; secret names and value shapes were not compared",
};

/** Nothing was contacted because the run asked for the credential-free arm. */
const OFFLINE_NOTICE = "offline mode (--offline) — no live store was contacted";

/** The live surfaces, in report order. */
const LIVE_SURFACES = ["github", "cloudflare", "infisical"];

/**
 * @param {Record<string, string>} unavailability
 * @param {string} surface
 * @returns {string}
 */
function unavailableNotice(unavailability, surface) {
  return unavailability[surface] ?? NO_CREDENTIAL_NOTICE[surface];
}

/**
 * Names declared at one GitHub `(scope, kind)`, optionally narrowed to the
 * entries that name a given environment.
 *
 * @param {object[]} keys           Parsed manifest keys.
 * @param {string} scope            "repository" | "environment"
 * @param {string} kind             "secret" | "var"
 * @param {string | null} environment  Non-null narrows to entries naming it.
 * @returns {string[]}
 */
function githubNamesAt(keys, scope, kind, environment) {
  return keys
    .filter((k) =>
      (k.residency.github ?? []).some(
        (g) =>
          g.scope === scope && g.kind === kind && (environment === null || g.environments.includes(environment))
      )
    )
    .map((k) => k.name);
}

/**
 * Reconcile the GitHub surface per `(scope, kind, environment)` triple.
 *
 * Two partitions are read — repository scope once, environment scope once per
 * environment — and a key may legitimately be resident in both. So each
 * partition suppresses orphans for names declared at the OTHER scope with the
 * SAME kind, and nothing wider:
 *
 * - **Cross-scope, same kind** is suppressed: that is the dual-scope residency
 *   the array form exists to describe, and reporting it was the false orphan.
 * - **Cross-kind is NOT suppressed.** A name declared as a secret but present
 *   as a variable is a real mismatch, and the orphan is how it surfaces.
 * - **Cross-environment is NOT suppressed.** A production-only key turning up
 *   in staging is undeclared presence in that environment — arguably the most
 *   interesting thing this surface can find — so it still orphans.
 *
 * A name declared in no GitHub scope at all orphans exactly as before, which
 * is what keeps `--strict-orphans` worth enabling once a manifest is correct.
 *
 * @param {object} ctx
 */
async function probeGitHub({ manifest, environments, github, surfaces, findings, unavailability = {} }) {
  if (!github) {
    surfaces.push({
      surface: "github",
      status: "unchecked",
      notice: unavailableNotice(unavailability, "github"),
    });
    return;
  }
  const keys = manifest.keys;
  try {
    const present = await github.repositoryNames();
    for (const kind of ["secret", "var"]) {
      findings.push(
        ...reconcileNames({
          expected: githubNamesAt(keys, "repository", kind, null),
          present: present[kind] ?? [],
          surface: "github",
          environment: null,
          scope: `repository ${kind}s`,
          declaredElsewhere: githubNamesAt(keys, "environment", kind, null),
        })
      );
    }
    for (const environment of environments) {
      const envPresent = await github.environmentNames(environment);
      for (const kind of ["secret", "var"]) {
        findings.push(
          ...reconcileNames({
            expected: githubNamesAt(keys, "environment", kind, environment),
            present: envPresent[kind] ?? [],
            surface: "github",
            environment,
            scope: `environment ${kind}s`,
            declaredElsewhere: githubNamesAt(keys, "repository", kind, null),
          })
        );
      }
    }
    surfaces.push({ surface: "github", status: "checked", notice: null });
  } catch (err) {
    surfaces.push({
      surface: "github",
      status: "error",
      notice: `probe failed and was NOT degraded to "no drift": ${err.message}`,
    });
  }
}

/**
 * Reconcile the Cloudflare surface per `(worker, environment)` pair.
 *
 * `expected` is narrowed to the keys whose residency names BOTH this worker
 * and this environment, so a deliberate single-environment placement no longer
 * reports `missing` from the environments it never claimed (Story #481).
 *
 * Two consequences of that narrowing are load-bearing, and neither is
 * incidental:
 *
 *   1. **A worker is still probed in an environment it expects nothing in**,
 *      as long as it expects something SOMEWHERE. Skipping it would take the
 *      surface's most interesting finding with it: a production-only key
 *      turning up in staging is undeclared presence, and only an
 *      empty-`expected` reconcile against a non-empty `present` reports it.
 *      Cross-environment orphans go unsuppressed here exactly as they do on
 *      the GitHub and Infisical surfaces. A worker that declares nothing in
 *      any environment is still skipped entirely — that is the manifest
 *      saying it has no opinion, which is not the same statement.
 *   2. **A 404 is only a finding where something WAS expected.** A worker
 *      deployed to one environment by design 404s in the other, and with
 *      nothing declared there that agrees with the manifest rather than
 *      contradicting it. Reporting it would re-introduce, one layer down, the
 *      same false failure this narrowing removes.
 *
 * @param {object} ctx
 */
async function probeCloudflare({ manifest, environments, cloudflare, surfaces, findings, unavailability = {} }) {
  const cfKeys = manifest.keys.filter((k) => k.residency.cloudflare?.kind === "secret");
  /** Does any key declare this worker in any environment at all? */
  const declaresWorker = (id) =>
    cfKeys.some((k) => k.residency.cloudflare.workers.some((w) => w.worker === id));
  if (!cloudflare) {
    surfaces.push({
      surface: "cloudflare",
      status: "unchecked",
      notice: unavailableNotice(unavailability, "cloudflare"),
    });
    return;
  }
  try {
    for (const environment of environments) {
      for (const [id, worker] of Object.entries(manifest.workers)) {
        const expected = cfKeys
          .filter((k) =>
            k.residency.cloudflare.workers.some((w) => w.worker === id && w.environments.includes(environment))
          )
          .map((k) => k.name);
        if (!declaresWorker(id)) continue;
        const scriptName = resolveScriptName(worker.scriptName, environment);
        let present;
        try {
          present = await cloudflare.secretNames(scriptName);
        } catch (err) {
          if (!isAbsentStatus(err)) throw err;
          // A 404 is the one status that legitimately means "absent": the
          // Worker has not been deployed to this environment yet. That is only
          // drift where the manifest expected something here; a worker
          // deliberately absent from an environment it declares nothing in is
          // agreement, not a finding.
          if (expected.length > 0) {
            findings.push({
              severity: "fail",
              kind: "missing",
              key: null,
              surface: "cloudflare",
              environment,
              detail: `Worker script "${scriptName}" does not exist (404) — ${expected.length} declared secret(s) cannot be verified`,
            });
          }
          continue;
        }
        findings.push(
          ...reconcileNames({
            expected,
            present,
            surface: "cloudflare",
            environment,
            scope: `worker ${id} → ${scriptName}`,
          })
        );
      }
    }
    surfaces.push({ surface: "cloudflare", status: "checked", notice: null });
  } catch (err) {
    surfaces.push({
      surface: "cloudflare",
      status: "error",
      notice: `probe failed and was NOT degraded to "no drift": ${err.message}`,
    });
  }
}

/**
 * Does a key declare residency at this folder in this environment?
 *
 * @param {object} key   A parsed manifest key with normalized infisical residency.
 * @param {string} folder
 * @param {string} environment
 * @returns {boolean}
 */
function residentAt(key, folder, environment) {
  return key.infisical.folders.some((f) => f.folder === folder && f.environments.includes(environment));
}

/**
 * Names declared in a SIBLING declared folder of the same environment.
 *
 * Infisical is probed once per (environment, folder) pair, so a key resident
 * in two folders is read in two partitions — and reporting it as an orphan in
 * the one the manifest happens not to be reconciling is the false positive the
 * `folders` array exists to remove. Suppression is deliberately no wider:
 *
 * - **Cross-folder, same environment** is suppressed: that is multi-folder
 *   residency, including the folder-import case.
 * - **Cross-environment is NOT suppressed.** A key declared for staging only
 *   but present in production is undeclared presence in that environment —
 *   the most interesting thing this surface can find — so it still orphans.
 *
 * A name declared in no folder at all orphans exactly as before, which is what
 * keeps `--strict-orphans` worth enabling once a manifest is correct. This is
 * the `declaredElsewhere` treatment `probeGitHub` has had since Story #459;
 * its absence here is why a single misplacement was reported twice.
 *
 * @param {object[]} managed
 * @param {string} folder
 * @param {string} environment
 * @returns {string[]}
 */
function infisicalNamesElsewhere(managed, folder, environment) {
  return managed
    .filter((k) => k.infisical.folders.some((f) => f.folder !== folder && f.environments.includes(environment)))
    .map((k) => k.name);
}

/**
 * The Infisical probe, plus the shape stage — the only place a value is read.
 *
 * @param {object} ctx
 */
async function probeInfisical({ manifest, environments, infisical, surfaces, findings, unavailability = {} }) {
  const managed = manifest.keys.filter((k) => k.infisical !== "unmanaged");
  if (!infisical) {
    surfaces.push({
      surface: "infisical",
      status: "unchecked",
      notice: unavailableNotice(unavailability, "infisical"),
    });
    return;
  }
  try {
    const folders = new Set(managed.flatMap((k) => k.infisical.folders.map((f) => f.folder)));
    const shapeChecked = [];
    // A key resident in several folders is READ in each of them, but its value
    // is one value — so it earns at most one shape verdict per environment.
    // Scoring it once per folder would re-introduce, in the shape stage, the
    // very double-reporting this Story removes from the residency stage.
    const shapeSeen = new Set();
    for (const environment of environments) {
      // The store's own environment slug, which need not be the deploy name.
      const slug = resolveSurfaceEnvironment(manifest, "infisical", environment);
      for (const folder of folders) {
        const expected = managed.filter((k) => residentAt(k, folder, environment)).map((k) => k.name);
        const present = await infisical.listNames({ environment: slug, folder });
        findings.push(
          ...reconcileNames({
            expected,
            present,
            surface: "infisical",
            environment,
            scope: `folder ${folder}`,
            declaredElsewhere: infisicalNamesElsewhere(managed, folder, environment),
          })
        );

        // Shape stage. Values enter this scope and leave it as verdicts.
        const needShape = managed.filter(
          (k) =>
            residentAt(k, folder, environment) &&
            (k.shape || k.placeholderPattern) &&
            !shapeSeen.has(`${environment}\u241f${k.name}`)
        );
        if (needShape.length === 0) continue;
        const values = await infisical.listValues({ environment: slug, folder });
        for (const key of needShape) {
          if (!values.has(key.name)) continue;
          const verdict = checkShape({
            value: values.get(key.name),
            shape: key.shape,
            placeholderPattern: key.placeholderPattern,
          });
          shapeChecked.push(key.name);
          shapeSeen.add(`${environment}\u241f${key.name}`);
          if (!verdict.ok) {
            findings.push({
              severity: "fail",
              kind: "shape-fail",
              key: key.name,
              surface: "infisical",
              environment,
              // `verdict.reason` is built from the shape NAME and the
              // placeholder marker only — never from the value itself.
              detail: verdict.reason,
            });
          }
        }
      }
    }
    surfaces.push({
      surface: "infisical",
      status: "checked",
      notice: shapeChecked.length > 0 ? `${shapeChecked.length} value shape(s) verified` : null,
    });
  } catch (err) {
    surfaces.push({
      surface: "infisical",
      status: "error",
      notice: `probe failed and was NOT degraded to "no drift": ${err.message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/env-doctor.mjs --manifest <path> [options]

  --manifest <path>        Required. The JSON residency manifest.
  --repo-root <path>       Repo root for the offline arm (default: cwd).
  --environments <a,b>     Environment slugs to check (default: manifest.environments).
  --offline                Run only the credential-free checks.
  --exceptions <path>      JSON exceptions document; each entry needs a revisit-date.
  --strict-orphans         Treat orphans as failures.
  --json                   Emit the machine report on stdout instead of the text one.
  --repo <owner/name>      GitHub repo to probe (default: $GITHUB_REPOSITORY).
  --cloudflare-account <id>  Cloudflare account id (default: $CLOUDFLARE_ACCOUNT_ID).
  --infisical-project <id>   Infisical project id (default: $INFISICAL_PROJECT_ID).
  --infisical-site <url>     Infisical site URL (default: ${INFISICAL_DEFAULT_SITE}).
  --help                   Show this message.

Credentials come from the environment, never from a flag (a flag lands in the
process table): ENV_DRIFT_GITHUB_TOKEN, CLOUDFLARE_API_TOKEN, INFISICAL_TOKEN,
INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET.
`;

/**
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  return parseFlags(argv, {
    flags: {
      "--manifest": { type: "string", dest: "manifest", default: null },
      "--repo-root": { type: "string", dest: "repoRoot", default: process.cwd() },
      "--environments": { type: "string", dest: "environments", default: null },
      "--exceptions": { type: "string", dest: "exceptions", default: null },
      // `||`, not `??`, on every environment-backed default. An unset GitHub
      // secret or input does not arrive as undefined — it interpolates to the
      // EMPTY STRING, which `??` treats as a supplied value. For the three
      // identifiers that is merely redundant (empty is falsy, so the client
      // still resolves null), but for the site URL it is a live defect: an
      // empty string would beat INFISICAL_DEFAULT_SITE and aim every probe at
      // a host that does not exist.
      "--repo": { type: "string", dest: "repo", default: process.env.GITHUB_REPOSITORY || null },
      "--cloudflare-account": {
        type: "string",
        dest: "cloudflareAccount",
        default: process.env.CLOUDFLARE_ACCOUNT_ID || null,
      },
      "--infisical-project": {
        type: "string",
        dest: "infisicalProject",
        default: process.env.INFISICAL_PROJECT_ID || null,
      },
      "--infisical-site": {
        type: "string",
        dest: "infisicalSite",
        default: process.env.INFISICAL_SITE_URL || INFISICAL_DEFAULT_SITE,
      },
      "--offline": { type: "boolean", dest: "offline", default: false },
      "--strict-orphans": { type: "boolean", dest: "strictOrphans", default: false },
      "--json": { type: "boolean", dest: "json", default: false },
      "--help": { type: "boolean", dest: "help", default: false },
    },
    aliases: { "-h": "--help", "-m": "--manifest" },
    onUnknown: "throw",
  });
}

/**
 * Build the live clients from the ambient environment. A surface with no
 * credential yields `null`, which the probes render as `unchecked`.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildClients(opts, env = process.env) {
  const hasGitHubCred = Boolean(env.ENV_DRIFT_GITHUB_TOKEN);
  const github =
    hasGitHubCred && opts.repo ? createGitHubClient({ token: env.ENV_DRIFT_GITHUB_TOKEN, repo: opts.repo }) : null;
  const hasCloudflareCred = Boolean(env.CLOUDFLARE_API_TOKEN);
  const cloudflare =
    hasCloudflareCred && opts.cloudflareAccount
      ? createCloudflareClient({ token: env.CLOUDFLARE_API_TOKEN, accountId: opts.cloudflareAccount })
      : null;
  const hasInfisicalCreds = Boolean(env.INFISICAL_TOKEN || (env.INFISICAL_CLIENT_ID && env.INFISICAL_CLIENT_SECRET));
  const infisical =
    hasInfisicalCreds && opts.infisicalProject
      ? createInfisicalClient({
          token: env.INFISICAL_TOKEN || null,
          clientId: env.INFISICAL_CLIENT_ID || null,
          clientSecret: env.INFISICAL_CLIENT_SECRET || null,
          projectId: opts.infisicalProject,
          siteUrl: opts.infisicalSite,
        })
      : null;

  // Which HALF was missing. Every identifier is tested for truthiness rather
  // than for null, because an unset GitHub secret arrives as "".
  const unavailability = {};
  for (const [surface, client, hasCredential] of [
    ["github", github, hasGitHubCred],
    ["cloudflare", cloudflare, hasCloudflareCred],
    ["infisical", infisical, hasInfisicalCreds],
  ]) {
    if (client) continue;
    unavailability[surface] = hasCredential ? MISSING_IDENTIFIER_NOTICE[surface] : NO_CREDENTIAL_NOTICE[surface];
  }

  return { github, cloudflare, infisical, unavailability };
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[env-doctor] ERROR: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!opts.manifest) {
    process.stderr.write(`[env-doctor] ERROR: --manifest <path> is required.\n\n${USAGE}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(resolve(opts.manifest), "utf8")));
  } catch (err) {
    process.stderr.write(`[env-doctor] ERROR: invalid manifest: ${err.message}\n`);
    process.exit(1);
  }

  let exceptions = [];
  if (opts.exceptions) {
    try {
      exceptions = parseExceptions(JSON.parse(readFileSync(resolve(opts.exceptions), "utf8")));
    } catch (err) {
      process.stderr.write(`[env-doctor] ERROR: invalid exceptions document: ${err.message}\n`);
      process.exit(1);
    }
  }

  let environments;
  try {
    environments = resolveEnvironments({ requested: opts.environments, manifest });
  } catch (err) {
    process.stderr.write(`[env-doctor] ERROR: ${err.message}\n`);
    process.exit(1);
  }

  // Offline builds no clients at all; `runDoctor` marks the live surfaces
  // skipped-because-offline rather than reaching for an unavailability reason.
  const clients = opts.offline ? {} : buildClients(opts);

  let report;
  try {
    report = await runDoctor({
      manifest,
      repoRoot: resolve(opts.repoRoot),
      environments,
      offline: opts.offline,
      strictOrphans: opts.strictOrphans,
      exceptions,
      ...clients,
    });
  } catch (err) {
    process.stderr.write(`[env-doctor] ERROR: ${err.message}\n`);
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderReport(report));
  }

  // Annotations go to STDERR in every mode, not just under `--json`. Actions
  // reads workflow commands from both streams, so nothing is lost — but stdout
  // is the machine channel, and `--json` promising one JSON document while
  // appending `::notice` lines to it made `JSON.parse(stdout)` throw for every
  // consumer whose run had an unchecked surface, which is most of them.
  // Splitting by mode would leave the text mode's stdout un-pipeable for the
  // same reason, so the rule is unconditional.
  for (const s of report.surfaces) {
    if (s.status === "unchecked") {
      process.stderr.write(`::notice title=env-doctor surface unchecked::${s.surface}: ${s.notice}\n`);
    }
    if (s.status === "error") {
      process.stderr.write(`::error title=env-doctor probe failed::${s.surface}: ${s.notice}\n`);
    }
  }

  process.exit(report.exitCode);
}

// Direct-invocation guard — symlink-safe via the shared seam (Story #407).
// The consumer contract is `node node_modules/mandrel-platform/scripts/env-doctor.mjs`,
// and pnpm installs that path as a symlink into its content-addressed store.
// The naive guards (comparing an unresolved argv[1] against a realpath-resolved
// import.meta.url) never match through that symlink: the CLI silently exits 0
// having printed nothing, which in a CI log is indistinguishable from a clean
// drift report. A drift gate that passes because it did not run is the single
// worst failure this script can have, so the guard goes through the seam that
// resolves BOTH sides.
if (isDirectInvocation(import.meta.url)) {
  await main();
}
