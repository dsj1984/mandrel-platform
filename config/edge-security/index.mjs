/**
 * edge-security — reusable per-env edge-security middleware units for
 * mandrel-platform consumers.
 *
 * Covers the three invariants every consumer was hand-rolling per env:
 *   - **CORS** (closed allowlist; Astro + hono variants), with the
 *     no-wildcard-with-credentials invariant enforced *by construction*.
 *   - **Security headers** (CSP / HSTS / XFO / XCTO / Referrer-Policy).
 *   - **App-layer rate limiting** (fixed-window; Astro + hono adapters).
 *
 * Distributed through the npm package-export channel (see
 * `mandrel-platform/edge-security/*`), consistent with the platform's other
 * reusable code (`config/*.base.json`, `scripts/*`). Import the barrel for
 * everything, or a single sub-path for one unit.
 *
 * The CORS code legitimately differs by architecture (Astro middleware vs
 * `hono/cors`), so both variants ship — the divergence is preserved, not
 * flattened.
 */

export { createAllowlist, normalizeOrigin, WILDCARD } from "./allowlist.mjs";
export { createAstroCors } from "./cors-astro.mjs";
export { createHonoCorsOptions } from "./cors-hono.mjs";
export {
  applySecurityHeaders,
  buildSecurityHeaders,
} from "./security-headers.mjs";
export {
  createAstroRateLimit,
  createHonoRateLimit,
  createMemoryStore,
  createRateLimiter,
  rateLimitHeaders,
} from "./rate-limit.mjs";
