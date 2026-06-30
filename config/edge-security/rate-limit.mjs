/**
 * rate-limit.mjs — app-layer rate limiting as a framework-agnostic fixed-window
 * limiter plus thin Astro / hono adapters.
 *
 * Consumers were each hand-rolling an in-memory / KV-backed limiter with the
 * same intent (N requests per window per key). This unit ships the core
 * decision function — `createRateLimiter` — parameterized by limit, window, a
 * key extractor, and a pluggable store, so a consumer swaps the in-memory store
 * for a Cloudflare KV / Durable Object store without re-deriving the limiter
 * logic. The default store is a self-pruning in-memory `Map` suitable for a
 * single-isolate dev / small deployment; production multi-isolate consumers
 * pass a shared store.
 */

/**
 * @typedef {Object} RateLimitStore
 * @property {(key: string) => Promise<{ count: number, resetAt: number } | null> | { count: number, resetAt: number } | null} get
 * @property {(key: string, value: { count: number, resetAt: number }) => Promise<void> | void} set
 */

/**
 * In-memory fixed-window store. Self-prunes expired buckets on access so it
 * does not leak unboundedly. NOT shared across isolates — fine for dev / single
 * instance; pass a KV-backed store in production.
 * @returns {RateLimitStore}
 */
export function createMemoryStore() {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();
  return {
    get(key) {
      const bucket = buckets.get(key);
      if (!bucket) {
        return null;
      }
      if (bucket.resetAt <= Date.now()) {
        buckets.delete(key);
        return null;
      }
      return bucket;
    },
    set(key, value) {
      buckets.set(key, value);
    },
  };
}

/**
 * @typedef {Object} RateLimiterOptions
 * @property {number} limit          Max requests allowed per window. Required.
 * @property {number} windowMs       Window length in milliseconds. Required.
 * @property {(request: Request) => string} [keyExtractor]
 *   Derives the rate-limit bucket key from the request. Defaults to the
 *   client IP from `CF-Connecting-IP` / `X-Forwarded-For` (first hop), falling
 *   back to a constant so a missing IP fails *closed* into one shared bucket
 *   rather than bypassing the limit per-request.
 * @property {RateLimitStore} [store] Defaults to `createMemoryStore()`.
 */

/**
 * @typedef {Object} RateLimitDecision
 * @property {boolean} allowed
 * @property {number} limit
 * @property {number} remaining
 * @property {number} resetAt    Epoch ms when the current window resets.
 * @property {number} retryAfter Seconds until reset (0 when allowed).
 */

/**
 * Default key extractor: client IP, failing closed to a shared bucket.
 * @param {Request} request
 * @returns {string}
 */
function defaultKeyExtractor(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) {
    return cf;
  }
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0];
    if (first) {
      return first.trim();
    }
  }
  // No identifiable client — fail closed into one shared bucket rather than
  // handing every anonymous request its own unlimited allowance.
  return "anonymous";
}

/**
 * Build a fixed-window rate limiter. The returned `check(request)` resolves to
 * a decision object the caller turns into a 429 (or passes through).
 *
 * @param {RateLimiterOptions} options
 * @returns {{ check: (request: Request) => Promise<RateLimitDecision> }}
 */
export function createRateLimiter(options) {
  if (
    !options ||
    typeof options.limit !== "number" ||
    typeof options.windowMs !== "number"
  ) {
    throw new TypeError(
      "[edge-security] createRateLimiter({ limit, windowMs }): numeric `limit` and `windowMs` are required",
    );
  }
  if (options.limit < 1 || options.windowMs < 1) {
    throw new RangeError(
      "[edge-security] createRateLimiter: `limit` and `windowMs` must be >= 1",
    );
  }
  const limit = options.limit;
  const windowMs = options.windowMs;
  const keyExtractor = options.keyExtractor ?? defaultKeyExtractor;
  const store = options.store ?? createMemoryStore();

  return {
    /**
     * @param {Request} request
     * @returns {Promise<RateLimitDecision>}
     */
    async check(request) {
      const key = keyExtractor(request);
      const now = Date.now();
      const existing = await store.get(key);

      let count;
      let resetAt;
      if (existing && existing.resetAt > now) {
        count = existing.count + 1;
        resetAt = existing.resetAt;
      } else {
        count = 1;
        resetAt = now + windowMs;
      }

      await store.set(key, { count, resetAt });

      const allowed = count <= limit;
      const remaining = Math.max(0, limit - count);
      const retryAfter = allowed ? 0 : Math.ceil((resetAt - now) / 1000);

      return { allowed, limit, remaining, resetAt, retryAfter };
    },
  };
}

/**
 * Standard rate-limit response headers for a decision. Spread onto a 429 (or a
 * passed-through response) so clients see their budget.
 * @param {RateLimitDecision} decision
 * @returns {Record<string, string>}
 */
export function rateLimitHeaders(decision) {
  /** @type {Record<string, string>} */
  const headers = {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(Math.ceil((decision.resetAt - Date.now()) / 1000)),
  };
  if (!decision.allowed) {
    headers["Retry-After"] = String(decision.retryAfter);
  }
  return headers;
}

/**
 * Astro middleware adapter: returns `(context, next) => Response`. Short-circuits
 * with a 429 when the limiter denies the request, otherwise annotates the
 * downstream response with the budget headers.
 *
 * @param {RateLimiterOptions} options
 * @returns {(context: { request: Request }, next: () => Promise<Response>) => Promise<Response>}
 */
export function createAstroRateLimit(options) {
  const limiter = createRateLimiter(options);
  return async function astroRateLimitMiddleware(context, next) {
    const decision = await limiter.check(context.request);
    if (!decision.allowed) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: rateLimitHeaders(decision),
      });
    }
    const response = await next();
    for (const [key, value] of Object.entries(rateLimitHeaders(decision))) {
      response.headers.set(key, value);
    }
    return response;
  };
}

/**
 * hono middleware adapter: returns `(c, next) => Promise<Response | void>`.
 * Short-circuits with `c.text("Too Many Requests", 429)` when denied.
 *
 * ```ts
 * import { createHonoRateLimit } from "mandrel-platform/edge-security/rate-limit.mjs";
 * app.use("*", createHonoRateLimit({ limit: 100, windowMs: 60_000 }));
 * ```
 *
 * @param {RateLimiterOptions} options
 * @returns {(c: any, next: () => Promise<void>) => Promise<Response | void>}
 */
export function createHonoRateLimit(options) {
  const limiter = createRateLimiter(options);
  return async function honoRateLimitMiddleware(c, next) {
    const decision = await limiter.check(c.req.raw);
    const headers = rateLimitHeaders(decision);
    if (!decision.allowed) {
      return c.text("Too Many Requests", 429, headers);
    }
    await next();
    for (const [key, value] of Object.entries(headers)) {
      c.res.headers.set(key, value);
    }
  };
}
