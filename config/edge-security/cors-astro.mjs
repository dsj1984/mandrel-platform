/**
 * cors-astro.mjs — closed-allowlist CORS as an Astro middleware factory.
 *
 * Astro consumers (e.g. domio) hand-roll CORS in `src/middleware.ts` rather
 * than reaching for a `hono/cors`-style helper, because Astro's middleware
 * signature is `(context, next) => Response`. This variant ships the same
 * closed-allowlist invariant as `cors-hono.mjs` but in the shape Astro's
 * `defineMiddleware` expects — the architecture-driven divergence the Story
 * preserves (two variants, not one flattened form).
 *
 * The no-wildcard-with-credentials invariant is inherited *by construction*
 * from `createAllowlist`: building this middleware with `['*']` +
 * `credentials: true` throws before a request is ever served.
 */

import { createAllowlist } from "./allowlist.mjs";

/**
 * @typedef {Object} AstroCorsOptions
 * @property {string[]} allowedOrigins
 *   Per-env allowed origins (absolute, or a single `*`). Required.
 * @property {boolean} [credentials=false]
 *   Send `Access-Control-Allow-Credentials: true`. Rejected at construction
 *   when combined with a wildcard origin.
 * @property {string[]} [methods=["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"]]
 *   Methods echoed into `Access-Control-Allow-Methods` on preflight.
 * @property {string[]} [allowedHeaders=["Content-Type","Authorization"]]
 *   Request headers echoed into `Access-Control-Allow-Headers` on preflight.
 * @property {string[]} [exposedHeaders=[]]
 *   Response headers echoed into `Access-Control-Expose-Headers`.
 * @property {number} [maxAge=86400]
 *   Preflight cache lifetime, seconds (`Access-Control-Max-Age`).
 */

const DEFAULT_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];
const DEFAULT_ALLOWED_HEADERS = ["Content-Type", "Authorization"];

/**
 * Build an Astro-shaped CORS middleware: `(context, next) => Promise<Response>`.
 *
 * Wire it in `src/middleware.ts`:
 *
 * ```ts
 * import { defineMiddleware, sequence } from "astro:middleware";
 * import { createAstroCors } from "mandrel-platform/edge-security/cors-astro.mjs";
 *
 * const cors = createAstroCors({
 *   allowedOrigins: import.meta.env.PROD
 *     ? ["https://godomio.com"]
 *     : ["http://localhost:4321"],
 *   credentials: true,
 * });
 *
 * export const onRequest = sequence(defineMiddleware(cors));
 * ```
 *
 * @param {AstroCorsOptions} options
 * @returns {(context: { request: Request }, next: () => Promise<Response>) => Promise<Response>}
 */
export function createAstroCors(options) {
  if (!options || !Array.isArray(options.allowedOrigins)) {
    throw new TypeError(
      "[edge-security] createAstroCors({ allowedOrigins }): `allowedOrigins` (string[]) is required",
    );
  }

  const credentials = options.credentials === true;
  // Constructs the allowlist — throws here on wildcard + credentials.
  const allowlist = createAllowlist(options.allowedOrigins, { credentials });

  const methods = options.methods ?? DEFAULT_METHODS;
  const allowedHeaders = options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS;
  const exposedHeaders = options.exposedHeaders ?? [];
  const maxAge = options.maxAge ?? 86400;

  /**
   * Apply the CORS response headers for a resolved (trusted) origin.
   * @param {Headers} headers
   * @param {string} allowOrigin
   */
  function applyCorsHeaders(headers, allowOrigin) {
    headers.set("Access-Control-Allow-Origin", allowOrigin);
    // When we echo a specific origin (not `*`), Vary: Origin is mandatory so
    // shared caches don't serve one origin's ACAO to another.
    if (allowOrigin !== "*") {
      headers.append("Vary", "Origin");
    }
    if (credentials) {
      headers.set("Access-Control-Allow-Credentials", "true");
    }
    if (exposedHeaders.length > 0) {
      headers.set("Access-Control-Expose-Headers", exposedHeaders.join(", "));
    }
  }

  return async function astroCorsMiddleware(context, next) {
    const request = context.request;
    const requestOrigin = request.headers.get("Origin");
    const allowOrigin = allowlist.resolve(requestOrigin);

    // ── Preflight (OPTIONS) ──
    if (request.method === "OPTIONS") {
      const headers = new Headers();
      if (allowOrigin) {
        applyCorsHeaders(headers, allowOrigin);
        headers.set("Access-Control-Allow-Methods", methods.join(", "));
        headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
        headers.set("Access-Control-Max-Age", String(maxAge));
      }
      // 204 No Content is the conventional preflight response. Untrusted
      // origins get a 204 with no CORS headers — the browser then blocks the
      // real request (a closed allowlist, not a hard 4xx).
      return new Response(null, { status: 204, headers });
    }

    // ── Actual request ──
    const response = await next();
    if (allowOrigin) {
      applyCorsHeaders(response.headers, allowOrigin);
    }
    return response;
  };
}
