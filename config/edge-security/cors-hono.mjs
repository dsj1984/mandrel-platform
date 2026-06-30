/**
 * cors-hono.mjs — closed-allowlist CORS as a `hono/cors` options factory.
 *
 * `hono`-based consumers (athportal, swarm-os) reach for the built-in
 * `hono/cors` middleware, whose options object takes an `origin` that may be a
 * function `(origin, c) => string | null`. This variant builds exactly that
 * options object — pre-wired with the closed-allowlist resolver — so the
 * consumer writes `app.use("*", cors(createHonoCorsOptions({...})))` and
 * inherits the invariant instead of re-deriving the origin callback.
 *
 * The no-wildcard-with-credentials invariant is inherited *by construction*
 * from `createAllowlist`: building these options with `['*']` +
 * `credentials: true` throws before the app ever starts.
 */

import { createAllowlist } from "./allowlist.mjs";

/**
 * @typedef {Object} HonoCorsOptions
 * @property {string[]} allowedOrigins
 *   Per-env allowed origins (absolute, or a single `*`). Required.
 * @property {boolean} [credentials=false]
 *   Maps to the `hono/cors` `credentials` option. Rejected at construction
 *   when combined with a wildcard origin.
 * @property {string[]} [methods=["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"]]
 * @property {string[]} [allowedHeaders=["Content-Type","Authorization"]]
 * @property {string[]} [exposedHeaders=[]]
 * @property {number} [maxAge=86400]
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
 * Build the options object for `hono/cors`'s `cors()` middleware.
 *
 * The returned `origin` is a function so the closed allowlist is applied
 * per-request: it echoes the request origin only when trusted, and returns
 * `null` otherwise (no `Access-Control-Allow-Origin` header — `hono/cors`
 * omits the header for a `null` return, which is the closed-allowlist
 * behaviour). For a wildcard env it returns the literal `*` (credentials are
 * proven `false` by construction in that case).
 *
 * ```ts
 * import { Hono } from "hono";
 * import { cors } from "hono/cors";
 * import { createHonoCorsOptions } from "mandrel-platform/edge-security/cors-hono.mjs";
 *
 * const app = new Hono();
 * app.use(
 *   "*",
 *   cors(
 *     createHonoCorsOptions({
 *       allowedOrigins: ["https://athportal.com"],
 *       credentials: true,
 *     }),
 *   ),
 * );
 * ```
 *
 * @param {HonoCorsOptions} options
 * @returns {{
 *   origin: (origin: string) => string | null,
 *   allowMethods: string[],
 *   allowHeaders: string[],
 *   exposeHeaders: string[],
 *   credentials: boolean,
 *   maxAge: number,
 * }}
 */
export function createHonoCorsOptions(options) {
  if (!options || !Array.isArray(options.allowedOrigins)) {
    throw new TypeError(
      "[edge-security] createHonoCorsOptions({ allowedOrigins }): `allowedOrigins` (string[]) is required",
    );
  }

  const credentials = options.credentials === true;
  // Constructs the allowlist — throws here on wildcard + credentials.
  const allowlist = createAllowlist(options.allowedOrigins, { credentials });

  const allowMethods = options.methods ?? DEFAULT_METHODS;
  const allowHeaders = options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS;
  const exposeHeaders = options.exposedHeaders ?? [];
  const maxAge = options.maxAge ?? 86400;

  return {
    /**
     * `hono/cors` origin callback. Returns the value for
     * `Access-Control-Allow-Origin`, or `null` when the origin is untrusted.
     * @param {string} requestOrigin
     * @returns {string | null}
     */
    origin(requestOrigin) {
      return allowlist.resolve(requestOrigin);
    },
    allowMethods,
    allowHeaders,
    exposeHeaders,
    credentials,
    maxAge,
  };
}
