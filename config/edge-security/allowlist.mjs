/**
 * allowlist.mjs — the closed-allowlist origin resolver shared by both CORS
 * variants (Astro middleware + `hono/cors`).
 *
 * This module is the single home of the **no-wildcard-with-credentials
 * invariant**, enforced *by construction*: the resolver never echoes a request
 * `Origin` it has not been told to trust, and the factories that build a CORS
 * unit refuse — at construction time — to combine a wildcard origin with
 * `credentials: true`. A consumer cannot mis-configure the unit into the
 * forbidden `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Credentials: true`
 * shape that the Fetch spec itself rejects and that browsers treat as a CORS
 * failure (and which, when a server hand-rolls it, silently disables the
 * credentialed-request protection the allowlist is meant to provide).
 *
 * The resolver is per-env: a consumer passes the allowlist for the current
 * deployment environment (e.g. the production origin set vs. the preview /
 * localhost set) and the same code path applies in every env.
 */

export const WILDCARD = "*";

/**
 * @typedef {Object} AllowlistOptions
 * @property {boolean} [credentials=false]
 *   When true the unit will send `Access-Control-Allow-Credentials: true`. A
 *   wildcard origin is **rejected at construction** when this is true — that is
 *   the no-wildcard-with-credentials invariant, enforced by construction.
 */

/**
 * Normalize a single allowed-origin entry to its scheme+host+port form so that
 * `https://app.example.com` and `https://app.example.com/` (trailing slash)
 * compare equal, and a bare host is rejected rather than silently matching.
 *
 * @param {string} entry
 * @returns {string} normalized origin, or the literal `*` wildcard
 */
export function normalizeOrigin(entry) {
  if (typeof entry !== "string") {
    throw new TypeError(
      `[edge-security] allowlist entry must be a string, got ${typeof entry}`,
    );
  }
  const trimmed = entry.trim();
  if (trimmed === WILDCARD) {
    return WILDCARD;
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError(
      `[edge-security] allowlist entry "${entry}" is not a valid absolute origin ` +
        `(expected e.g. "https://app.example.com" or "*")`,
    );
  }
  // `URL.origin` is already scheme://host[:port] with no trailing slash.
  return url.origin;
}

/**
 * Build a closed-allowlist origin resolver from a per-env list of allowed
 * origins.
 *
 * The returned object exposes:
 *   - `isWildcard` — whether the env trusts every origin (`*`).
 *   - `credentials` — the resolved credentials flag (always `false` when wildcard).
 *   - `origins` — the normalized, de-duplicated allowed-origin set (frozen).
 *   - `resolve(requestOrigin)` — returns the value to echo into
 *     `Access-Control-Allow-Origin` for this request, or `null` when the origin
 *     is not trusted (the request gets NO ACAO header — a closed allowlist).
 *
 * @param {string[]} allowed   Per-env allowed origins (absolute, or a single `*`).
 * @param {AllowlistOptions} [options]
 * @returns {{
 *   isWildcard: boolean,
 *   credentials: boolean,
 *   origins: ReadonlySet<string>,
 *   resolve: (requestOrigin: string | null | undefined) => string | null,
 * }}
 */
export function createAllowlist(allowed, options = {}) {
  if (!Array.isArray(allowed)) {
    throw new TypeError(
      "[edge-security] createAllowlist(allowed): `allowed` must be an array of origins",
    );
  }
  const credentials = options.credentials === true;

  const normalized = allowed.map(normalizeOrigin);
  const isWildcard = normalized.includes(WILDCARD);

  // ── The no-wildcard-with-credentials invariant, enforced by construction ──
  if (isWildcard && credentials) {
    throw new Error(
      "[edge-security] Refusing to build a CORS unit with a wildcard origin (`*`) " +
        "AND credentials enabled. `Access-Control-Allow-Origin: *` with " +
        "`Access-Control-Allow-Credentials: true` is forbidden by the Fetch spec " +
        "and disables the credentialed-request protection. Either enumerate the " +
        "allowed origins explicitly, or set credentials: false.",
    );
  }

  if (isWildcard && normalized.length > 1) {
    throw new Error(
      "[edge-security] Wildcard `*` cannot be combined with explicit origins — " +
        "pass either `['*']` or an explicit allowlist, not both.",
    );
  }

  const origins = Object.freeze(new Set(normalized));

  /**
   * @param {string | null | undefined} requestOrigin
   * @returns {string | null}
   */
  function resolve(requestOrigin) {
    if (isWildcard) {
      // Wildcard env, credentials already proven false above: a literal `*` is
      // the correct, safe ACAO value (any origin, no credentials).
      return WILDCARD;
    }
    if (!requestOrigin) {
      return null;
    }
    let candidate;
    try {
      candidate = new URL(requestOrigin).origin;
    } catch {
      return null;
    }
    // Closed allowlist: echo the request origin *only* when it is trusted.
    // Never reflect an untrusted Origin back (the reflection footgun).
    return origins.has(candidate) ? candidate : null;
  }

  return { isWildcard, credentials, origins, resolve };
}
