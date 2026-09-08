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
 *   1. local     — `.env` / `.env.example` in the caller repo
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
  workers:
    "object? — worker id -> {config, scriptName}. `scriptName` may contain '{env}', substituted per environment.",
  keys: "object[] — one entry per env var / secret (see KEY_SCHEMA)",
});

export const KEY_SCHEMA = Object.freeze({
  name: "string — the variable/secret name",
  kind: "'var' | 'secret'",
  sensitivity: "'public' | 'secret'",
  residency:
    "object — {local: 'var'|'secret'|'file'|null, github: {scope,kind}|null, cloudflare: {workers,kind}|null}",
  infisical: "{folder, environments} | 'unmanaged'",
  shape: `string? — one of ${SHAPE_NAMES.join(", ")}`,
  placeholderPattern: "string? — literal, case-insensitive substring marking an unset placeholder value",
  note: "string? — free text",
});

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

  const seen = new Set();
  const keys = raw.keys.map((entry, i) => validateKeyEntry(entry, i, workers, environments, seen));

  return { environments: [...environments], workers, keys };
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

  const github = residency.github ?? null;
  if (github !== null) {
    if (github.scope !== "environment" && github.scope !== "repository") {
      throw new Error(`${at}.residency.github.scope must be "environment" or "repository" (key ${name})`);
    }
    if (github.kind !== "secret" && github.kind !== "var") {
      throw new Error(`${at}.residency.github.kind must be "secret" or "var" (key ${name})`);
    }
  }

  const cloudflare = residency.cloudflare ?? null;
  if (cloudflare !== null) {
    if (!Array.isArray(cloudflare.workers) || cloudflare.workers.length === 0) {
      throw new Error(`${at}.residency.cloudflare.workers must be a non-empty array of worker ids (key ${name})`);
    }
    for (const id of cloudflare.workers) {
      if (!Object.hasOwn(workers, id)) {
        throw new Error(`${at}.residency.cloudflare.workers references unknown worker id "${id}" (key ${name})`);
      }
    }
    if (cloudflare.kind !== "secret" && cloudflare.kind !== "var") {
      throw new Error(`${at}.residency.cloudflare.kind must be "secret" or "var" (key ${name})`);
    }
  }

  const infisical = entry.infisical ?? "unmanaged";
  if (infisical !== "unmanaged") {
    if (!infisical || typeof infisical !== "object" || typeof infisical.folder !== "string") {
      throw new Error(`${at}.infisical must be "unmanaged" or {folder, environments} (key ${name})`);
    }
    const envs = infisical.environments ?? environments;
    if (!Array.isArray(envs) || !envs.every((e) => typeof e === "string")) {
      throw new Error(`${at}.infisical.environments must be an array of environment slugs (key ${name})`);
    }
    for (const e of envs) {
      if (!environments.includes(e)) {
        throw new Error(`${at}.infisical.environments names "${e}", absent from manifest.environments (key ${name})`);
      }
    }
  }

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
      cloudflare: cloudflare ? { workers: [...cloudflare.workers], kind: cloudflare.kind } : null,
    },
    infisical:
      infisical === "unmanaged"
        ? "unmanaged"
        : { folder: infisical.folder, environments: [...(infisical.environments ?? environments)] },
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
 * Perform a JSON request and tag any HTTP failure with `.httpStatus`, so a
 * caller can apply the 404-only degradation rule (see the module docblock).
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<unknown>}
 */
export async function requestJson(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    // The body can echo request context; it is never a secret VALUE (these are
    // name-listing endpoints), but it is also not needed — the status is what
    // routes the decision, so only the status and a redacted URL are surfaced.
    const err = new Error(`${init.method ?? "GET"} ${redactUrl(url)} failed: ${res.status} ${res.statusText}`);
    err.httpStatus = res.status;
    throw err;
  }
  return res.json();
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
 * surface; values are read (a local `.env` is already on the developer's disk)
 * but only names cross the boundary unless the shape stage asks.
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
 * Extract the `[vars]` block key names from a wrangler config. Supports both
 * TOML (`[vars]` / `[env.<name>.vars]`) and JSON/JSONC (`"vars": {…}`) — the
 * two shapes wrangler accepts.
 *
 * @param {string} text
 * @param {string} path  Used only to pick the parser by extension.
 * @returns {string[]} Sorted var names.
 */
export function parseWranglerVars(text, path) {
  const names = new Set();
  if (/\.jsonc?$/.test(path)) {
    // Strip line comments so JSONC parses; block comments are not used by
    // wrangler's own generated configs.
    const stripped = text.replace(/^\s*\/\/.*$/gm, "");
    let doc;
    try {
      doc = JSON.parse(stripped);
    } catch {
      return [];
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
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.repo  "owner/name"
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.apiBase]
 */
export function createGitHubClient({ token, repo, fetchImpl = fetch, apiBase = GITHUB_API_BASE }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const get = (path) => requestJson(fetchImpl, `${apiBase}${path}`, { headers });

  return {
    async repositoryNames() {
      const [secrets, variables] = await Promise.all([
        get(`/repos/${repo}/actions/secrets?per_page=100`),
        get(`/repos/${repo}/actions/variables?per_page=100`),
      ]);
      return {
        secret: (secrets.secrets ?? []).map((s) => s.name).sort(),
        var: (variables.variables ?? []).map((v) => v.name).sort(),
      };
    },
    async environmentNames(environment) {
      const env = encodeURIComponent(environment);
      const [secrets, variables] = await Promise.all([
        get(`/repos/${repo}/environments/${env}/secrets?per_page=100`),
        get(`/repos/${repo}/environments/${env}/variables?per_page=100`),
      ]);
      return {
        secret: (secrets.secrets ?? []).map((s) => s.name).sort(),
        var: (variables.variables ?? []).map((v) => v.name).sort(),
      };
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
 */
export function createCloudflareClient({ token, accountId, fetchImpl = fetch, apiBase = CLOUDFLARE_API_BASE }) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    async secretNames(scriptName) {
      const body = await requestJson(
        fetchImpl,
        `${apiBase}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
        { headers }
      );
      return (body.result ?? []).map((s) => s.name).sort();
    },
  };
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
 */
export function createInfisicalClient({
  token = null,
  clientId = null,
  clientSecret = null,
  projectId,
  siteUrl = INFISICAL_DEFAULT_SITE,
  fetchImpl = fetch,
}) {
  const base = siteUrl.replace(/\/+$/, "");
  let accessToken = token;

  async function auth() {
    if (accessToken) return accessToken;
    const body = await requestJson(fetchImpl, `${base}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    });
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
    });
    const body = await requestJson(fetchImpl, `${base}/api/v4/secrets?${params.toString()}`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    return body.secrets ?? [];
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
 * @param {string} text
 * @returns {{secrets: string[], vars: string[]}}
 */
export function collectWorkflowReferences(text) {
  const secrets = new Set();
  const vars = new Set();
  const re = /\b(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m = re.exec(text);
  while (m !== null) {
    (m[1] === "secrets" ? secrets : vars).add(m[2]);
    m = re.exec(text);
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
    checked.push(`wrangler:${id}`);
    const present = new Set(parseWranglerVars(readFileSync(configPath, "utf8"), configPath));
    const expected = manifest.keys.filter(
      (k) => k.residency.cloudflare?.kind === "var" && k.residency.cloudflare.workers.includes(id)
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
 * @returns {object[]} findings
 */
export function reconcileNames({ expected, present, surface, environment, scope = "" }) {
  const findings = [];
  const presentSet = new Set(present);
  const expectedSet = new Set(expected);
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
    return {
      key: e.key,
      surface: e.surface ?? null,
      environment: e.environment ?? null,
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
        (e.surface === null || e.surface === f.surface) &&
        (e.environment === null || e.environment === f.environment)
    );
    if (match && f.severity === "fail") {
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
        `  - ${s.key} [${s.surface}${s.environment ? `/${s.environment}` : ""}] — revisit ${s.exception.revisitDate}${s.exception.reason ? `: ${s.exception.reason}` : ""}`
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
  const repoKeys = manifest.keys.filter((k) => k.residency.github?.scope === "repository");
  const envKeys = manifest.keys.filter((k) => k.residency.github?.scope === "environment");
  try {
    const present = await github.repositoryNames();
    for (const kind of ["secret", "var"]) {
      findings.push(
        ...reconcileNames({
          expected: repoKeys.filter((k) => k.residency.github.kind === kind).map((k) => k.name),
          present: present[kind] ?? [],
          surface: "github",
          environment: null,
          scope: `repository ${kind}s`,
        })
      );
    }
    for (const environment of environments) {
      const envPresent = await github.environmentNames(environment);
      for (const kind of ["secret", "var"]) {
        findings.push(
          ...reconcileNames({
            expected: envKeys.filter((k) => k.residency.github.kind === kind).map((k) => k.name),
            present: envPresent[kind] ?? [],
            surface: "github",
            environment,
            scope: `environment ${kind}s`,
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
 * @param {object} ctx
 */
async function probeCloudflare({ manifest, environments, cloudflare, surfaces, findings, unavailability = {} }) {
  const cfKeys = manifest.keys.filter((k) => k.residency.cloudflare?.kind === "secret");
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
        const expected = cfKeys.filter((k) => k.residency.cloudflare.workers.includes(id)).map((k) => k.name);
        if (expected.length === 0) continue;
        const scriptName = resolveScriptName(worker.scriptName, environment);
        let present;
        try {
          present = await cloudflare.secretNames(scriptName);
        } catch (err) {
          if (!isAbsentStatus(err)) throw err;
          // A 404 is the one status that legitimately means "absent": the
          // Worker has not been deployed to this environment yet.
          findings.push({
            severity: "fail",
            kind: "missing",
            key: null,
            surface: "cloudflare",
            environment,
            detail: `Worker script "${scriptName}" does not exist (404) — ${expected.length} declared secret(s) cannot be verified`,
          });
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
    const folders = new Set(managed.map((k) => k.infisical.folder));
    const shapeChecked = [];
    for (const environment of environments) {
      for (const folder of folders) {
        const expected = managed
          .filter((k) => k.infisical.folder === folder && k.infisical.environments.includes(environment))
          .map((k) => k.name);
        const present = await infisical.listNames({ environment, folder });
        findings.push(
          ...reconcileNames({ expected, present, surface: "infisical", environment, scope: `folder ${folder}` })
        );

        // Shape stage. Values enter this scope and leave it as verdicts.
        const needShape = managed.filter(
          (k) =>
            k.infisical.folder === folder &&
            k.infisical.environments.includes(environment) &&
            (k.shape || k.placeholderPattern)
        );
        if (needShape.length === 0) continue;
        const values = await infisical.listValues({ environment, folder });
        for (const key of needShape) {
          if (!values.has(key.name)) continue;
          const verdict = checkShape({
            value: values.get(key.name),
            shape: key.shape,
            placeholderPattern: key.placeholderPattern,
          });
          shapeChecked.push(key.name);
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

  const environments = opts.environments
    ? opts.environments
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : manifest.environments;

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

  for (const s of report.surfaces) {
    if (s.status === "unchecked") {
      process.stdout.write(`::notice title=env-doctor surface unchecked::${s.surface}: ${s.notice}\n`);
    }
    if (s.status === "error") {
      process.stdout.write(`::error title=env-doctor probe failed::${s.surface}: ${s.notice}\n`);
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
