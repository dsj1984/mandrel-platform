/**
 * scripts/lib/semver-duration.mjs
 *
 * The semver + Renovate-duration parsers shared by the pin-drift dashboard
 * (`check-pin-drift.mjs`) and the pin-repair loop (`platform-repair.mjs`).
 * Extracted from `check-pin-drift.mjs` (Story #198) so both consumers parse
 * release tags, dependency specs, and `minimumReleaseAge` windows through one
 * SSOT rather than a monolith import.
 *
 * These are pure functions — no I/O, no GitHub access.
 */

/**
 * Extract a comparable `x.y.z` semver core from a release tag or version spec.
 * The platform tags releases as `mandrel-platform-v<semver>`; consumer specs
 * may carry a range prefix (`^0.11.3`, `~0.11.3`). Returns the dotted triple
 * or null when no numeric semver core is present (`workspace:*`, `latest`, a
 * git URL).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseSemver(value) {
  if (typeof value !== "string") return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/**
 * Compare two `x.y.z` semver cores. Returns -1 when a < b, 0 when equal, 1
 * when a > b. Inputs MUST already be normalized dotted triples (see
 * `parseSemver`).
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Parse a Renovate-style `minimumReleaseAge` duration into milliseconds. The
 * preset uses human strings like `"3 days"`, `"36 hours"`, `"1 week"`; this
 * accepts an integer (or float) count followed by a unit (the same units
 * Renovate's `ms`-backed parser accepts). Returns null for an unparseable or
 * non-positive value so the caller can fall back to "no hold window".
 *
 * @param {unknown} value
 * @returns {number | null}  Window length in ms, or null.
 */
export function parseDurationMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Bare number is interpreted as days (the preset's unit of record).
    return value * 24 * 60 * 60 * 1000;
  }
  if (typeof value !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(value.trim());
  if (!m) return null;
  const count = Number.parseFloat(m[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  const unit = m[2].toLowerCase();
  const units = {
    minute: 60 * 1000,
    minutes: 60 * 1000,
    min: 60 * 1000,
    mins: 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    hr: 60 * 60 * 1000,
    hrs: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
  };
  const factor = units[unit];
  return factor ? count * factor : null;
}
