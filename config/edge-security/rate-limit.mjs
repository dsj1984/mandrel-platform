/**
 * rate-limit.mjs — app-layer rate limiting as a framework-agnostic fixed-window
 * limiter plus thin Astro / hono adapters.
 *
 * Consumers were each hand-rolling an in-memory / KV-backed limiter with the
 * same intent (N requests per window per key). This unit ships the core
 * decision function — `createRateLimiter` — parameterized by limit, window, a
 * key extractor, and a pluggable store, so a consumer swaps the in-memory store
 * for a Cloudflare KV / Durable Object store without re-deriving the limiter
 * logic. The default store is a bounded in-memory `Map` suitable for a
 * single-isolate dev / small deployment; production multi-isolate consumers
 * pass a shared store.
 */

/**
 * Max number of live buckets the default in-memory store retains before it
 * evicts. A stream of distinct keys (e.g. a rotating-IP flood, or a spoofed
 * forwarded header — see `defaultKeyExtractor`) would otherwise grow the
 * backing `Map` without bound. Once the store holds this many buckets, the
 * least-recently-touched entry is evicted (LRU) on the next `set`. The value
 * is large enough to be a non-event for legitimate single-isolate traffic
 * while capping worst-case memory.
 */
const DEFAULT_MAX_BUCKETS = 10_000;

/**
 * @typedef {Object} RateLimitStore
 * @property {(key: string) => Promise<{ count: number, resetAt: number } | null> | { count: number, resetAt: number } | null} get
 * @property {(key: string, value: { count: number, resetAt: number }) => Promise<void> | void} set
 */

/**
 * In-memory fixed-window store. Bounded two ways so a stream of distinct keys
 * cannot grow the backing `Map` without bound:
 *
 *  1. **Expired-bucket sweep.** `get` evicts a bucket the moment its window has
 *     elapsed, and `set` amortizes a full sweep of expired buckets across
 *     writes. Keys that stop being seen do not linger past their window.
 *  2. **Max-size LRU cap.** The `Map` retains at most `maxBuckets` live
 *     entries. When a `set` would exceed the cap after sweeping, the
 *     least-recently-touched entry is evicted first (a `Map` preserves
 *     insertion order, and every touch re-inserts, so the first key is the
 *     LRU one). This caps worst-case memory even under an active flood of
 *     keys that have not yet expired.
 *
 * NOT shared across isolates — fine for dev / single instance; pass a
 * KV-backed store in production.
 *
 * @param {{ maxBuckets?: number }} [options]
 *   Optional cap override. Defaults to {@link DEFAULT_MAX_BUCKETS}. Callers
 *   that pass no argument get the default — the zero-arg signature is
 *   preserved for existing consumers.
 * @returns {RateLimitStore}
 */
export function createMemoryStore(options) {
  const maxBuckets =
    options && typeof options.maxBuckets === "number" && options.maxBuckets >= 1
      ? Math.floor(options.maxBuckets)
      : DEFAULT_MAX_BUCKETS;
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  /** Evict every bucket whose window has already elapsed. */
  function sweepExpired(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }

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
      // Re-insert so the touched key moves to the most-recently-used end,
      // keeping the LRU eviction order in `set` honest.
      buckets.delete(key);
      buckets.set(key, bucket);
      return bucket;
    },
    set(key, value) {
      const now = Date.now();
      // A re-`set` of an existing key must not double-count toward the cap;
      // drop it first so the size check and LRU ordering stay correct.
      buckets.delete(key);
      buckets.set(key, value);
      if (buckets.size > maxBuckets) {
        // Cheap first: reclaim anything already expired.
        sweepExpired(now);
      }
      // Still over cap (an active flood of un-expired keys) — evict LRU
      // entries (insertion-order-oldest) until we are back within bound.
      while (buckets.size > maxBuckets) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        buckets.delete(oldest);
      }
    },
  };
}

/**
 * @typedef {Object} RateLimiterOptions
 * @property {number} limit          Max requests allowed per window. Required.
 * @property {number} windowMs       Window length in milliseconds. Required.
 * @property {(request: Request) => string} [keyExtractor]
 *   Derives the rate-limit bucket key from the request. Defaults to
 *   {@link defaultKeyExtractor}, which trusts only `CF-Connecting-IP` and
 *   falls back to a constant shared bucket — it does NOT read
 *   `X-Forwarded-For`, which is client-spoofable. See that function's doc for
 *   the trust boundary and how to opt back into `X-Forwarded-For` when your
 *   own edge is known to overwrite it.
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
 * Default key extractor: the Cloudflare-supplied client IP, failing closed to
 * a shared bucket.
 *
 * **Trust boundary.** Identity is derived only from `CF-Connecting-IP`, a
 * header Cloudflare's edge sets (and overwrites) from the terminating TCP
 * connection — a client cannot forge it. `X-Forwarded-For` is deliberately
 * NOT consulted: any client can send an arbitrary `X-Forwarded-For`, so
 * keying off it lets an attacker mint a fresh bucket per request (defeating
 * the limit) or impersonate another client's bucket. When no trusted client
 * IP is present, we fail *closed* into one shared `"anonymous"` bucket rather
 * than handing every request its own unlimited allowance.
 *
 * If your own reverse proxy is known to strip inbound `X-Forwarded-For` and
 * append the real client, opt back in explicitly with a custom
 * `keyExtractor`, e.g.:
 *
 * ```js
 * createRateLimiter({
 *   limit, windowMs,
 *   keyExtractor: (req) =>
 *     req.headers.get("CF-Connecting-IP") ??
 *     req.headers.get("X-Forwarded-For")?.split(",").pop()?.trim() ??
 *     "anonymous",
 * });
 * ```
 *
 * @param {Request} request
 * @returns {string}
 */
function defaultKeyExtractor(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) {
    return cf.trim();
  }
  // No trusted client identity. `X-Forwarded-For` is intentionally ignored
  // here because it is client-spoofable; fail closed into one shared bucket.
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
