/**
 * scripts/lib/gh-json.mjs
 *
 * The single GitHub-access seam shared by the pin-drift dashboard
 * (`check-pin-drift.mjs`) and the pin-repair loop (`platform-repair.mjs`).
 * Extracted from `check-pin-drift.mjs` (Story #198) so both consumers run
 * `gh api` through one thin, injectable runner and one JSON parser.
 *
 * GitHub access is via the `gh` CLI (`gh api`), so callers inherit the
 * environment's auth (a `GH_TOKEN`/`GITHUB_TOKEN` in CI, or `gh auth`
 * locally). No secrets are read or printed here.
 *
 * ## Fail-closed HTTP-status surfacing (Story #198)
 *
 * `gh api` exits non-zero on any HTTP error and writes a line like
 * `gh: Not Found (HTTP 404)` to stderr. `execFileSync` turns that into a
 * thrown Error whose `.stderr` / `.message` carries the `(HTTP <code>)`
 * marker. Historically the per-consumer fetchers in the dashboard caught
 * *every* such error and returned an "absent" sentinel — so a transient 500,
 * a network blip, or an auth failure all read as "no drift" and the
 * `--strict` gate silently exited 0 (a fail-OPEN). That is the bug this
 * module exists to close.
 *
 * `httpStatusOf(err)` parses the HTTP status back out of a thrown `gh` error,
 * and `isNotFound(err)` is the ONLY predicate a fetcher may use to justify
 * swallowing an error into an "absent" result. Every other error must
 * propagate so the caller's per-consumer catch records an `error` row (which
 * `hasDrift` counts and `--strict` fails on) — the gate fails CLOSED.
 */

import { execFileSync } from "node:child_process";

/**
 * Default gh runner — shells out to the `gh` CLI.
 *
 * @param {string[]} args
 * @returns {string}
 */
export function defaultGhRunner(args) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Extract the HTTP status code from an error thrown by a `gh api` invocation.
 * `gh` reports failures as `gh: <message> (HTTP <code>)` on stderr, which
 * `execFileSync` surfaces on the thrown error's `.stderr` (a Buffer/string)
 * and, for some shells, folded into `.message`. Also handles a structured
 * error that already carries a numeric `.httpStatus` / `.status` HTTP field.
 *
 * @param {unknown} err
 * @returns {number | null}  The HTTP status, or null when none can be parsed.
 */
export function httpStatusOf(err) {
  if (!err || typeof err !== "object") return null;
  // A pre-tagged HTTP status wins (set by ghApiJson on rethrow, or by a caller
  // that already classified the error). Guard against `execFileSync`'s own
  // numeric `.status` (that is a PROCESS exit code, not an HTTP status), so we
  // only trust an explicit `.httpStatus`.
  const tagged = /** @type {{ httpStatus?: unknown }} */ (err).httpStatus;
  if (typeof tagged === "number" && Number.isInteger(tagged)) return tagged;

  const parts = [];
  const e = /** @type {{ stderr?: unknown, stdout?: unknown, message?: unknown }} */ (err);
  if (e.stderr != null) parts.push(String(e.stderr));
  if (e.stdout != null) parts.push(String(e.stdout));
  if (typeof e.message === "string") parts.push(e.message);
  const haystack = parts.join("\n");
  // `gh` form: "(HTTP 404)". REST body form: "\"status\":\"404\"".
  const m = /\(HTTP\s+(\d{3})\)/.exec(haystack) || /"status"\s*:\s*"(\d{3})"/.exec(haystack);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Is `err` a GitHub 404 (Not Found)? This is the ONLY error class a fetcher
 * may legitimately swallow into an "absent" sentinel — a 404 genuinely means
 * "this resource does not exist" (a consumer with no `package.json`, no
 * `.github/workflows/` dir, no release). Every other status (403, 429, 5xx,
 * or an unparseable transport failure) must fail CLOSED.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNotFound(err) {
  return httpStatusOf(err) === 404;
}

/**
 * Run `gh api <path>` and parse the JSON response. On failure, the thrown
 * error is re-thrown with its HTTP status tagged on `.httpStatus` (parsed via
 * `httpStatusOf`) so downstream `catch` blocks can distinguish a 404 (safe to
 * treat as "absent") from every other error (must fail closed). The status is
 * surfaced, never swallowed here — the swallow/rethrow policy lives in the
 * per-consumer fetchers.
 *
 * @param {string} apiPath  e.g. "repos/owner/repo/releases/latest".
 * @param {(args: string[]) => string} runGh  Injectable runner.
 * @returns {unknown}
 */
export function ghApiJson(apiPath, runGh) {
  let raw;
  try {
    raw = runGh(["api", apiPath, "-H", "Accept: application/vnd.github+json"]);
  } catch (err) {
    const status = httpStatusOf(err);
    if (status !== null && err && typeof err === "object" && !("httpStatus" in err)) {
      try {
        /** @type {{ httpStatus?: number }} */ (err).httpStatus = status;
      } catch {
        // Non-extensible error object — the parseable status still lives in
        // `.stderr`/`.message`, so httpStatusOf(err) recovers it downstream.
      }
    }
    throw err;
  }
  return JSON.parse(raw);
}
