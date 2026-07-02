#!/usr/bin/env node
/**
 * edge-security.test.mjs — node:test suite for the reusable edge-security
 * middleware units (Story #116): CORS (Astro + hono variants), security
 * headers, and app-layer rate limiting.
 *
 * The units live under `config/edge-security/` (the npm package-export channel)
 * and are imported here by relative path. Run: `node --test scripts/` or
 * `npm test`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAllowlist,
  normalizeOrigin,
} from "../config/edge-security/allowlist.mjs";
import { createAstroCors } from "../config/edge-security/cors-astro.mjs";
import { createHonoCorsOptions } from "../config/edge-security/cors-hono.mjs";
import {
  applySecurityHeaders,
  buildSecurityHeaders,
} from "../config/edge-security/security-headers.mjs";
import {
  createAstroRateLimit,
  createMemoryStore,
  createRateLimiter,
  rateLimitHeaders,
} from "../config/edge-security/rate-limit.mjs";
import * as barrel from "../config/edge-security/index.mjs";

// ---------------------------------------------------------------------------
// allowlist — the no-wildcard-with-credentials invariant
// ---------------------------------------------------------------------------

test("normalizeOrigin strips trailing slash / path to scheme+host+port", () => {
  assert.equal(normalizeOrigin("https://app.example.com/"), "https://app.example.com");
  assert.equal(normalizeOrigin("https://app.example.com:8443/x"), "https://app.example.com:8443");
  assert.equal(normalizeOrigin("*"), "*");
});

test("normalizeOrigin rejects a non-absolute / bare-host entry", () => {
  assert.throws(() => normalizeOrigin("app.example.com"), /not a valid absolute origin/);
});

test("createAllowlist THROWS on wildcard + credentials (invariant by construction)", () => {
  assert.throws(
    () => createAllowlist(["*"], { credentials: true }),
    /wildcard origin .* AND credentials/i,
  );
});

test("createAllowlist allows wildcard when credentials are off", () => {
  const al = createAllowlist(["*"], { credentials: false });
  assert.equal(al.isWildcard, true);
  assert.equal(al.credentials, false);
  assert.equal(al.resolve("https://anything.example.com"), "*");
});

test("createAllowlist rejects wildcard mixed with explicit origins", () => {
  assert.throws(
    () => createAllowlist(["*", "https://a.example.com"]),
    /cannot be combined with explicit origins/,
  );
});

test("closed allowlist echoes only trusted origins, null otherwise", () => {
  const al = createAllowlist(["https://app.example.com"], { credentials: true });
  assert.equal(al.resolve("https://app.example.com"), "https://app.example.com");
  assert.equal(al.resolve("https://app.example.com/"), "https://app.example.com"); // normalized
  assert.equal(al.resolve("https://evil.example.com"), null);
  assert.equal(al.resolve(null), null);
  assert.equal(al.resolve("not a url"), null);
});

// ---------------------------------------------------------------------------
// cors-astro
// ---------------------------------------------------------------------------

test("createAstroCors throws on wildcard + credentials at construction", () => {
  assert.throws(
    () => createAstroCors({ allowedOrigins: ["*"], credentials: true }),
    /wildcard origin .* AND credentials/i,
  );
});

test("createAstroCors requires allowedOrigins", () => {
  assert.throws(() => createAstroCors({}), /allowedOrigins/);
});

test("astro CORS preflight: trusted origin gets full CORS headers", async () => {
  const cors = createAstroCors({
    allowedOrigins: ["https://godomio.com"],
    credentials: true,
    methods: ["GET", "POST"],
  });
  const req = new Request("https://godomio.com/api", {
    method: "OPTIONS",
    headers: { Origin: "https://godomio.com" },
  });
  const res = await cors({ request: req }, async () => new Response("unused"));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://godomio.com");
  assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, POST");
  assert.match(res.headers.get("Vary") ?? "", /Origin/);
});

test("astro CORS preflight: untrusted origin gets 204 with NO cors headers", async () => {
  const cors = createAstroCors({ allowedOrigins: ["https://godomio.com"] });
  const req = new Request("https://godomio.com/api", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example.com" },
  });
  const res = await cors({ request: req }, async () => new Response("unused"));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("astro CORS actual request: annotates downstream response for trusted origin", async () => {
  const cors = createAstroCors({ allowedOrigins: ["https://godomio.com"] });
  const req = new Request("https://godomio.com/api", {
    method: "GET",
    headers: { Origin: "https://godomio.com" },
  });
  const res = await cors({ request: req }, async () => new Response("ok"));
  assert.equal(await res.text(), "ok");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://godomio.com");
});

test("astro CORS actual request: untrusted origin response carries no ACAO", async () => {
  const cors = createAstroCors({ allowedOrigins: ["https://godomio.com"] });
  const req = new Request("https://godomio.com/api", {
    method: "GET",
    headers: { Origin: "https://evil.example.com" },
  });
  const res = await cors({ request: req }, async () => new Response("ok"));
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

// ---------------------------------------------------------------------------
// cors-hono
// ---------------------------------------------------------------------------

test("createHonoCorsOptions throws on wildcard + credentials at construction", () => {
  assert.throws(
    () => createHonoCorsOptions({ allowedOrigins: ["*"], credentials: true }),
    /wildcard origin .* AND credentials/i,
  );
});

test("hono CORS options origin callback enforces the closed allowlist", () => {
  const opts = createHonoCorsOptions({
    allowedOrigins: ["https://athportal.com"],
    credentials: true,
  });
  assert.equal(opts.credentials, true);
  assert.equal(opts.origin("https://athportal.com"), "https://athportal.com");
  assert.equal(opts.origin("https://evil.example.com"), null);
  assert.deepEqual(opts.allowMethods.includes("GET"), true);
});

test("hono CORS wildcard env returns * via origin callback (no credentials)", () => {
  const opts = createHonoCorsOptions({ allowedOrigins: ["*"] });
  assert.equal(opts.credentials, false);
  assert.equal(opts.origin("https://anything.example.com"), "*");
});

// ---------------------------------------------------------------------------
// security-headers
// ---------------------------------------------------------------------------

test("buildSecurityHeaders ships the hardened default set", () => {
  const h = buildSecurityHeaders();
  assert.match(h["Content-Security-Policy"], /default-src 'self'/);
  assert.match(h["Strict-Transport-Security"], /max-age=63072000/);
  assert.match(h["Strict-Transport-Security"], /includeSubDomains/);
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "strict-origin-when-cross-origin");
});

test("buildSecurityHeaders omits headers set to false", () => {
  const h = buildSecurityHeaders({
    contentSecurityPolicy: false,
    hsts: false,
    frameOptions: false,
  });
  assert.equal("Content-Security-Policy" in h, false);
  assert.equal("Strict-Transport-Security" in h, false);
  assert.equal("X-Frame-Options" in h, false);
  // The remaining defaults are still present.
  assert.equal(h["X-Content-Type-Options"], "nosniff");
});

test("buildSecurityHeaders honours custom CSP + HSTS preload", () => {
  const h = buildSecurityHeaders({
    contentSecurityPolicy: "default-src 'none'",
    hsts: { maxAge: 100, preload: true, includeSubDomains: false },
  });
  assert.equal(h["Content-Security-Policy"], "default-src 'none'");
  assert.equal(h["Strict-Transport-Security"], "max-age=100; preload");
});

test("applySecurityHeaders mutates a Headers instance in place", () => {
  const headers = new Headers();
  applySecurityHeaders(headers);
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.throws(() => applySecurityHeaders({}), /must be a Headers instance/);
});

// ---------------------------------------------------------------------------
// rate-limit
// ---------------------------------------------------------------------------

function ipReq(ip) {
  return new Request("https://api.example.com/", {
    headers: { "CF-Connecting-IP": ip },
  });
}

test("createRateLimiter validates its options", () => {
  assert.throws(() => createRateLimiter({}), /limit.*windowMs/);
  assert.throws(() => createRateLimiter({ limit: 0, windowMs: 1000 }), />= 1/);
});

test("fixed-window limiter allows up to limit then denies", async () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
  const a = await limiter.check(ipReq("1.1.1.1"));
  assert.equal(a.allowed, true);
  assert.equal(a.remaining, 1);
  const b = await limiter.check(ipReq("1.1.1.1"));
  assert.equal(b.allowed, true);
  assert.equal(b.remaining, 0);
  const c = await limiter.check(ipReq("1.1.1.1"));
  assert.equal(c.allowed, false);
  assert.ok(c.retryAfter > 0);
});

test("rate limiter buckets are per-key (per-IP)", async () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal((await limiter.check(ipReq("1.1.1.1"))).allowed, true);
  assert.equal((await limiter.check(ipReq("2.2.2.2"))).allowed, true);
  assert.equal((await limiter.check(ipReq("1.1.1.1"))).allowed, false);
});

test("default key extractor fails closed to a shared bucket when no IP", async () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  const bare = () => new Request("https://api.example.com/");
  assert.equal((await limiter.check(bare())).allowed, true);
  assert.equal((await limiter.check(bare())).allowed, false); // same "anonymous" bucket
});

test("memory store evicts expired buckets on access", async () => {
  const store = createMemoryStore();
  store.set("k", { count: 5, resetAt: Date.now() - 1 });
  assert.equal(store.get("k"), null);
});

test("memory store sweeps expired buckets on write so distinct keys do not leak", () => {
  const store = createMemoryStore({ maxBuckets: 4 });
  // Seed the store to capacity with already-expired buckets.
  for (let i = 0; i < 4; i += 1) {
    store.set(`expired-${i}`, { count: 1, resetAt: Date.now() - 1 });
  }
  // One more distinct key triggers the amortized sweep; the expired entries
  // are reclaimed instead of growing the map past the cap.
  store.set("live", { count: 1, resetAt: Date.now() + 60_000 });
  assert.equal(store.get("live") !== null, true);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(store.get(`expired-${i}`), null);
  }
});

test("memory store caps live-key count via LRU eviction under a distinct-key flood", () => {
  const maxBuckets = 8;
  const store = createMemoryStore({ maxBuckets });
  const resetAt = Date.now() + 60_000; // all un-expired, so only the cap bounds size
  // A flood of far more distinct, still-live keys than the cap.
  for (let i = 0; i < maxBuckets * 50; i += 1) {
    store.set(`ip-${i}`, { count: 1, resetAt });
  }
  // Size stays bounded — the map never grew to the flood count.
  let liveCount = 0;
  for (let i = 0; i < maxBuckets * 50; i += 1) {
    if (store.get(`ip-${i}`) !== null) {
      liveCount += 1;
    }
  }
  assert.equal(liveCount <= maxBuckets, true, `expected <= ${maxBuckets} live buckets, got ${liveCount}`);
  // The most-recently-inserted key survived; the oldest was evicted (LRU).
  assert.equal(store.get(`ip-${maxBuckets * 50 - 1}`) !== null, true);
  assert.equal(store.get("ip-0"), null);
});

test("a rate limiter over the bounded store stays memory-bounded across a distinct-key flood", async () => {
  const store = createMemoryStore({ maxBuckets: 16 });
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, store });
  // Each request presents a distinct client IP; without the cap this would
  // grow one bucket per request forever.
  for (let i = 0; i < 5_000; i += 1) {
    await limiter.check(ipReq(`10.0.${(i >> 8) & 255}.${i & 255}`));
  }
  let liveCount = 0;
  for (let i = 0; i < 5_000; i += 1) {
    if (store.get(`10.0.${(i >> 8) & 255}.${i & 255}`) !== null) {
      liveCount += 1;
    }
  }
  assert.equal(liveCount <= 16, true, `expected <= 16 live buckets, got ${liveCount}`);
});

test("default key extractor ignores spoofable X-Forwarded-For", async () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  // Two requests with different X-Forwarded-For values but no CF-Connecting-IP
  // must land in the SAME bucket — a client cannot mint fresh buckets by
  // rotating a forged X-Forwarded-For.
  const xffReq = (xff) =>
    new Request("https://api.example.com/", {
      headers: { "X-Forwarded-For": xff },
    });
  assert.equal((await limiter.check(xffReq("1.2.3.4"))).allowed, true);
  // Different forged header, same shared "anonymous" bucket → denied.
  assert.equal((await limiter.check(xffReq("5.6.7.8"))).allowed, false);
});

test("default key extractor keys off trusted CF-Connecting-IP even when X-Forwarded-For differs", async () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  const req = (cf, xff) =>
    new Request("https://api.example.com/", {
      headers: { "CF-Connecting-IP": cf, "X-Forwarded-For": xff },
    });
  // Distinct trusted IPs get distinct buckets regardless of the forged XFF.
  assert.equal((await limiter.check(req("1.1.1.1", "9.9.9.9"))).allowed, true);
  assert.equal((await limiter.check(req("2.2.2.2", "9.9.9.9"))).allowed, true);
  // Same trusted IP, different forged XFF → same bucket → denied.
  assert.equal((await limiter.check(req("1.1.1.1", "8.8.8.8"))).allowed, false);
});

test("rateLimitHeaders includes Retry-After only when denied", () => {
  const allowed = rateLimitHeaders({ allowed: true, limit: 10, remaining: 9, resetAt: Date.now() + 1000, retryAfter: 0 });
  assert.equal("Retry-After" in allowed, false);
  assert.equal(allowed["RateLimit-Limit"], "10");
  const denied = rateLimitHeaders({ allowed: false, limit: 10, remaining: 0, resetAt: Date.now() + 1000, retryAfter: 1, });
  assert.equal(denied["Retry-After"], "1");
});

test("createAstroRateLimit short-circuits with 429 when denied", async () => {
  const mw = createAstroRateLimit({ limit: 1, windowMs: 60_000 });
  const ok = await mw({ request: ipReq("9.9.9.9") }, async () => new Response("body"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("RateLimit-Limit"), "1");
  const denied = await mw({ request: ipReq("9.9.9.9") }, async () => new Response("body"));
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("Retry-After") !== null, true);
});

// ---------------------------------------------------------------------------
// barrel
// ---------------------------------------------------------------------------

test("index barrel re-exports every public unit", () => {
  for (const name of [
    "createAllowlist",
    "normalizeOrigin",
    "WILDCARD",
    "createAstroCors",
    "createHonoCorsOptions",
    "buildSecurityHeaders",
    "applySecurityHeaders",
    "createRateLimiter",
    "createMemoryStore",
    "createAstroRateLimit",
    "createHonoRateLimit",
    "rateLimitHeaders",
  ]) {
    assert.equal(typeof barrel[name] !== "undefined", true, `barrel missing ${name}`);
  }
});
