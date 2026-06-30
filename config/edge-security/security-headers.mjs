/**
 * security-headers.mjs — the uniform security-header set every consumer was
 * hand-rolling per env: CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
 * and Referrer-Policy.
 *
 * Ships two surfaces so both architectures inherit the same invariant:
 *   - `buildSecurityHeaders(options)` — a framework-agnostic `Record<string,string>`
 *     a consumer can spread onto any `Headers` / response (Astro, hono, plain
 *     Workers `fetch`).
 *   - `applySecurityHeaders(headers, options)` — mutates a `Headers` instance
 *     in place (the common middleware path).
 *
 * Every header is parameterized but ships a safe default, so a consumer that
 * passes `{}` still inherits a hardened baseline rather than re-deriving the
 * directive strings.
 */

/**
 * @typedef {Object} SecurityHeaderOptions
 * @property {string | false} [contentSecurityPolicy]
 *   The full CSP string. Defaults to a strict self-only policy. Pass `false`
 *   to omit the CSP header entirely (e.g. when a CDN injects it).
 * @property {Object} [hsts]
 * @property {number} [hsts.maxAge=63072000]   `max-age` seconds (default 2y).
 * @property {boolean} [hsts.includeSubDomains=true]
 * @property {boolean} [hsts.preload=false]
 * @property {false} [hsts.enabled]
 *   Pass `{ enabled: false }`-style by setting `hsts: false` to omit HSTS
 *   (e.g. on a non-HTTPS preview host).
 * @property {string | false} [frameOptions="DENY"]
 *   `X-Frame-Options`. `false` omits it (rely on CSP `frame-ancestors`).
 * @property {string | false} [contentTypeOptions="nosniff"]
 *   `X-Content-Type-Options`. `false` omits it.
 * @property {string | false} [referrerPolicy="strict-origin-when-cross-origin"]
 *   `Referrer-Policy`. `false` omits it.
 */

const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const DEFAULT_HSTS_MAX_AGE = 63072000; // 2 years

/**
 * Build the `Strict-Transport-Security` value from the hsts option, or `null`
 * when HSTS is disabled.
 * @param {SecurityHeaderOptions["hsts"] | false | undefined} hsts
 * @returns {string | null}
 */
function buildHsts(hsts) {
  if (hsts === false) {
    return null;
  }
  const maxAge =
    hsts && typeof hsts.maxAge === "number" ? hsts.maxAge : DEFAULT_HSTS_MAX_AGE;
  const includeSubDomains = !hsts || hsts.includeSubDomains !== false;
  const preload = Boolean(hsts && hsts.preload);

  let value = `max-age=${maxAge}`;
  if (includeSubDomains) {
    value += "; includeSubDomains";
  }
  if (preload) {
    value += "; preload";
  }
  return value;
}

/**
 * Build the security-header set as a plain object. Keys are only present when
 * the corresponding header is enabled (a disabled header is omitted, not set
 * empty).
 *
 * @param {SecurityHeaderOptions} [options]
 * @returns {Record<string, string>}
 */
export function buildSecurityHeaders(options = {}) {
  /** @type {Record<string, string>} */
  const headers = {};

  const csp =
    options.contentSecurityPolicy === undefined
      ? DEFAULT_CSP
      : options.contentSecurityPolicy;
  if (csp !== false) {
    headers["Content-Security-Policy"] = csp;
  }

  const hsts = buildHsts(options.hsts);
  if (hsts !== null) {
    headers["Strict-Transport-Security"] = hsts;
  }

  const frameOptions =
    options.frameOptions === undefined ? "DENY" : options.frameOptions;
  if (frameOptions !== false) {
    headers["X-Frame-Options"] = frameOptions;
  }

  const contentTypeOptions =
    options.contentTypeOptions === undefined
      ? "nosniff"
      : options.contentTypeOptions;
  if (contentTypeOptions !== false) {
    headers["X-Content-Type-Options"] = contentTypeOptions;
  }

  const referrerPolicy =
    options.referrerPolicy === undefined
      ? "strict-origin-when-cross-origin"
      : options.referrerPolicy;
  if (referrerPolicy !== false) {
    headers["Referrer-Policy"] = referrerPolicy;
  }

  return headers;
}

/**
 * Mutate a `Headers` instance in place with the security-header set. Returns
 * the same instance for chaining.
 *
 * ```ts
 * import { applySecurityHeaders } from "mandrel-platform/edge-security/security-headers.mjs";
 * const response = await next();
 * applySecurityHeaders(response.headers);
 * return response;
 * ```
 *
 * @param {Headers} headers
 * @param {SecurityHeaderOptions} [options]
 * @returns {Headers}
 */
export function applySecurityHeaders(headers, options = {}) {
  if (!headers || typeof headers.set !== "function") {
    throw new TypeError(
      "[edge-security] applySecurityHeaders(headers): `headers` must be a Headers instance",
    );
  }
  for (const [key, value] of Object.entries(buildSecurityHeaders(options))) {
    headers.set(key, value);
  }
  return headers;
}
