#!/usr/bin/env node
/**
 * Producer-agnostic issue-intake normalizer (Story #435).
 *
 * An external producer opens an issue; this action decides what that issue is
 * allowed to set in motion. The decision is a pure function of
 * (author login, body text, preset, duplicate lookup), so the whole trust
 * contract is unit-tested without any network access
 * (`scripts/issue-intake.test.mjs`). `main()` only translates the verdict into
 * `gh` calls and one optional POST, and takes injectable seams for both — so
 * the claims that are about BEHAVIOUR rather than about the verdict (an
 * `ignored` issue is never written to; a configured-but-refused fire reds the
 * run; an unwired fire does not) are assertable offline too.
 *
 * ## 1. The trigger label is the trust boundary
 *
 * `<prefix>:triage` is what an agent workflow keys off, so applying it is the
 * act of conscripting the agent. It requires TWO independent signals — the
 * author is a configured producer login AND the body matches the preset's
 * shape. Either signal alone classifies `ignored`, because either alone is
 * forgeable by anyone who can open an issue: a login check alone trusts every
 * issue a compromised or merely careless bot account files, and a body check
 * alone lets any account paste the right shape and be routed to an agent.
 *
 * An `ignored` verdict is deliberately INERT — no label is created, none is
 * applied, nothing is fired. The action leaves an issue it does not trust
 * exactly as its author wrote it.
 *
 * ## 2. Matchers are regex LITERALS in a preset table
 *
 * `producer-preset` selects a matcher from `PRODUCER_PRESETS`; it never
 * supplies one. A free-form pattern input cannot ship here for two reasons
 * that reinforce each other: compiling a pattern out of an input value is a
 * SAST finding the vendored ruleset raises (`detect-non-literal-regexp`, and
 * the diff-baselined SAST tier does not exempt test files), and — the
 * substantive reason — a
 * caller-supplied pattern is a way to widen the trust boundary from outside
 * the action, which is exactly what invariant 1 exists to prevent.
 *
 * ## 3. Label discovery pages, and an "already exists" refusal is a SKIP
 *
 * `gh label list` returns one page. A consumer with 313 labels lost the intake
 * labels off the end of it, so every run after the first tried to re-create
 * them and died on GitHub's "already exists" refusal. Discovery therefore
 * pages to exhaustion, and a create refused as already-existing is reported as
 * a skip — the desired end state (the label exists) is reached either way.
 *
 * ## 4. Fire semantics invert on configuration
 *
 * A fire that was CONFIGURED and then REFUSED is a broken pipeline: the issue
 * was classified and nothing picked it up, so the run must go red. A fire that
 * was never wired is a repo that has not opted in: warn, stay green. The POST
 * carries `Authorization: Bearer`, `Content-Type: application/json` and BOTH
 * Anthropic headers — omitting either returns 400 — with a `{"text": "…"}`
 * body.
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The three verdicts this action can reach. */
export const TRIAGE = "triage";
export const DUPLICATE = "duplicate";
export const IGNORED = "ignored";

/** Label prefix a caller gets when it supplies none. */
export const DEFAULT_LABEL_PREFIX = "intake";

/** Both Anthropic headers are mandatory — omitting either returns 400. */
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_BETA = "experimental-cc-routine-2026-04-01";

/** `gh` caps a page at 100; discovery walks pages until one comes back short. */
export const LABEL_PAGE_SIZE = 100;

/** Hard stop on the paging loop, so a pathological repo cannot spin forever. */
export const MAX_LABEL_PAGES = 50;

/**
 * Characters that terminate a URL token in prose. This pattern names no host,
 * so there is nothing an attacker can prefix — isolating a candidate is
 * deliberately kept separate from deciding whether its host is trusted.
 */
const URL_TOKEN_DELIMITERS = /[\s<>"'`()[\],]+/;

/**
 * The Sentry issue id a body links, or null when it links none.
 *
 * Each candidate is parsed with `new URL()` and its `hostname` compared
 * exactly, which is what a regex cannot do safely:
 * `https://evil.example/?u=https://acme.sentry.io/issues/1` carries the wrong
 * host, and `https://notsentry.io/issues/1` is a different registrable domain
 * that merely ends in the same letters. Both must fail, because this is one of
 * the two trust signals (header § 1).
 *
 * @param {string|undefined} body
 * @returns {string|null}
 */
function sentryIssueId(body) {
  for (const token of String(body ?? "").split(URL_TOKEN_DELIMITERS)) {
    if (!token.toLowerCase().startsWith("https://")) continue;
    let url;
    try {
      url = new URL(token);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const host = url.hostname.toLowerCase();
    if (host !== "sentry.io" && !host.endsWith(".sentry.io")) continue;
    const path = /^\/issues\/([0-9]+)\/?$/.exec(url.pathname);
    if (path) return path[1];
  }
  return null;
}

/**
 * Body-shape matchers, keyed by `producer-preset`.
 *
 * Every matcher here is STATIC (see the header): a regex literal, or a named
 * function over literals. `shape` decides the second trust signal; `identity`
 * optionally captures a stable id carried IN the body, which is what makes
 * duplicate detection possible — a preset with no intrinsic identity still
 * classifies, it just cannot dedupe (see `resolveFingerprint`).
 *
 * A preset whose signal is a URL supplies `extract` instead of the pair: a
 * regex cannot check a host safely. An unanchored host pattern matches
 * anywhere in an attacker-controlled body, so
 * `https://evil.example/?u=https://acme.sentry.io/issues/1` satisfies it —
 * which would reduce the two-signal trust boundary of header § 1 to the
 * producer login alone. `extract` parses each candidate with `new URL()` and
 * compares `hostname` exactly, so a lookalike host cannot pass. CodeQL names
 * the regex form of this defect `js/regex/missing-regexp-anchor`.
 *
 * No pattern carries the `g` flag: a shared literal with `lastIndex` state
 * would return different answers on alternating calls.
 */
export const PRODUCER_PRESETS = Object.freeze({
  // A producer that emits an explicit `Fingerprint: <id>` line. The
  // producer-agnostic default: any bot can be taught to emit one line.
  "structured-report": Object.freeze({
    description: "A report body carrying an explicit `Fingerprint: <id>` line.",
    shape: /^[ \t]*fingerprint:[ \t]*[A-Za-z0-9_.:-]{4,}[ \t]*$/im,
    identity: /^[ \t]*fingerprint:[ \t]*([A-Za-z0-9_.:-]{4,})[ \t]*$/im,
  }),
  // An issue filed by this platform's own track-issue action: a discovery
  // marker plus a digest marker. Both HTML-comment terminators are matched —
  // a `-->`-only matcher is blind to the legacy `--!>` form that GitHub and
  // browsers both honour, which would silently fail the shape check.
  "mandrel-tracker": Object.freeze({
    description: "A tracked-issue body carrying a `<!-- key-digest: … -->` marker.",
    shape: /<!--[ \t]*[A-Za-z0-9_.:-]*-digest:[ \t]*[0-9a-f]{6,64}[ \t]*--!?>/,
    identity: /<!--[ \t]*[A-Za-z0-9_.:-]*-digest:[ \t]*([0-9a-f]{6,64})[ \t]*--!?>/,
  }),
  // A Sentry alert forwarded into the repo. Host-checked by `new URL()`, never
  // by a regex — see the `extract` note above.
  sentry: Object.freeze({
    description: "A body linking a Sentry issue (`https://<org>.sentry.io/issues/<id>`).",
    extract: sentryIssueId,
  }),
  // An advisory-shaped report naming a GHSA id.
  "osv-advisory": Object.freeze({
    description: "A body naming a GHSA advisory id.",
    shape: /\bGHSA-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}\b/,
    identity: /\b(GHSA-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})\b/,
  }),
});

/** Preset keys, for error messages and docs. */
export const PRESET_NAMES = Object.freeze(Object.keys(PRODUCER_PRESETS));

/** A label prefix has to be usable as a label-name prefix, so keep it tame. */
const LABEL_PREFIX_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/;

/** GitHub's refusal when a label of that name is already present. */
const ALREADY_EXISTS = /already[ _-]?exists/i;

// ---------------------------------------------------------------------------
// Trust signals
// ---------------------------------------------------------------------------

/**
 * Split the comma-separated producer list into normalized logins.
 *
 * @param {string|undefined} raw
 * @returns {string[]} lowercased, de-duplicated, empties dropped
 */
export function parseLogins(raw) {
  const seen = new Set();
  for (const part of String(raw ?? "").split(",")) {
    const login = part.trim().toLowerCase();
    if (login) seen.add(login);
  }
  return [...seen];
}

/**
 * Signal one: is the issue's author a configured producer? GitHub logins are
 * case-insensitive, so the comparison is too.
 *
 * @param {string|undefined} login
 * @param {string[]} logins
 * @returns {boolean}
 */
export function isProducerLogin(login, logins) {
  const candidate = String(login ?? "").trim().toLowerCase();
  if (!candidate) return false;
  return logins.includes(candidate);
}

/**
 * Look a preset up without inheriting anything from `Object.prototype` — a
 * `producer-preset` of `constructor` must be an unknown preset, not a hit.
 *
 * @param {string} preset
 * @returns {{description: string, shape?: RegExp, identity?: RegExp|null,
 *   extract?: (body: string|undefined) => string|null}|null}
 */
export function lookupPreset(preset) {
  const key = String(preset ?? "").trim();
  return Object.hasOwn(PRODUCER_PRESETS, key) ? PRODUCER_PRESETS[key] : null;
}

/**
 * Signal two: does the body match the preset's shape? An unknown preset never
 * matches — fail closed, so a typo'd preset cannot widen the boundary.
 *
 * @param {string|undefined} body
 * @param {string} preset
 * @returns {boolean}
 */
export function matchesBodyShape(body, preset) {
  const entry = lookupPreset(preset);
  if (!entry) return false;
  if (entry.extract) return entry.extract(body) !== null;
  return entry.shape.test(String(body ?? ""));
}

/**
 * The identity carried IN the body, or null when the preset defines none / the
 * body does not carry one. Only an intrinsic identity can dedupe: it is the
 * one value another issue from the same producer would repeat verbatim.
 *
 * @param {string|undefined} body
 * @param {string} preset
 * @returns {string|null}
 */
export function intrinsicIdentity(body, preset) {
  const entry = lookupPreset(preset);
  if (!entry) return null;
  if (entry.extract) return entry.extract(body);
  if (!entry.identity) return null;
  const m = entry.identity.exec(String(body ?? ""));
  return m?.[1] ? m[1].trim() : null;
}

/**
 * Resolve the fingerprint for a body: the intrinsic identity when there is
 * one, else a content hash. The content hash still identifies the run in logs
 * and outputs, but it appears in no other issue's body, so `dedupable` is
 * false and the duplicate lookup is skipped rather than run and wasted.
 *
 * @param {string|undefined} body
 * @param {string} preset
 * @returns {{value: string, dedupable: boolean}}
 */
export function resolveFingerprint(body, preset) {
  const identity = intrinsicIdentity(body, preset);
  if (identity !== null) return { value: identity, dedupable: true };
  const hash = createHash("sha256")
    .update(String(body ?? "").replace(/\r\n/g, "\n").trim())
    .digest("hex")
    .slice(0, 12);
  return { value: `sha:${hash}`, dedupable: false };
}

/**
 * The whole classification, as a pure function.
 *
 * `duplicateOf` is the number of an already-open intake issue carrying the
 * same fingerprint (null when there is none, or when the lookup was skipped).
 * It only ever downgrades a `triage` — a duplicate of something is by
 * definition something that already passed the boundary.
 *
 * @param {{login?: string, body?: string, preset: string, logins: string[], duplicateOf?: number|null}} args
 * @returns {{action: string, reason: string, loginMatch: boolean, bodyMatch: boolean, duplicateOf: number|null}}
 */
export function classifyIntake({ login, body, preset, logins, duplicateOf = null }) {
  const loginMatch = isProducerLogin(login, logins);
  const bodyMatch = matchesBodyShape(body, preset);

  if (!loginMatch && !bodyMatch) {
    return {
      action: IGNORED,
      reason: "neither signal matched: the author is not a configured producer and the body does not match the preset.",
      loginMatch,
      bodyMatch,
      duplicateOf: null,
    };
  }
  if (!loginMatch) {
    return {
      action: IGNORED,
      reason: `body shape matched \`${preset}\` but the author is not a configured producer — a body shape alone is forgeable by any account that can open an issue.`,
      loginMatch,
      bodyMatch,
      duplicateOf: null,
    };
  }
  if (!bodyMatch) {
    return {
      action: IGNORED,
      reason: `the author is a configured producer but the body does not match \`${preset}\` — a producer login alone is not enough to conscript an agent.`,
      loginMatch,
      bodyMatch,
      duplicateOf: null,
    };
  }
  if (Number.isInteger(duplicateOf) && duplicateOf > 0) {
    return {
      action: DUPLICATE,
      reason: `both signals matched, but issue #${duplicateOf} already carries this fingerprint.`,
      loginMatch,
      bodyMatch,
      duplicateOf,
    };
  }
  return {
    action: TRIAGE,
    reason: "both signals matched: a configured producer login and a matching body shape.",
    loginMatch,
    bodyMatch,
    duplicateOf: null,
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The label name for one verdict under a prefix. */
export const labelFor = (prefix, action) => `${prefix}:${action}`;

/**
 * The three labels this action owns. `<prefix>:triage` is first because it is
 * the trigger label — the one whose existence has to be guaranteed before any
 * issue is labelled with it.
 *
 * @param {string} prefix
 * @returns {Array<{name: string, color: string, description: string}>}
 */
export function intakeLabelPlan(prefix) {
  return [
    {
      name: labelFor(prefix, TRIAGE),
      color: "0e8a16",
      description: "Intake: accepted from a configured producer — ready for triage.",
    },
    {
      name: labelFor(prefix, DUPLICATE),
      color: "cfd3d7",
      description: "Intake: duplicate of an already-open intake issue.",
    },
    {
      name: labelFor(prefix, IGNORED),
      color: "e4e669",
      description: "Intake: did not clear the two-signal trust boundary.",
    },
  ];
}

/**
 * Which planned labels are absent from the repo. Compared case-insensitively
 * because GitHub refuses a create that differs only in case, which would look
 * like a spurious failure rather than the no-op it is.
 *
 * @param {string[]} existingNames
 * @param {Array<{name: string}>} plan
 * @returns {Array<{name: string}>}
 */
export function selectMissingLabels(existingNames, plan) {
  const have = new Set((existingNames || []).map((n) => String(n).trim().toLowerCase()));
  return plan.filter((label) => !have.has(label.name.toLowerCase()));
}

/**
 * Is this create failure the benign "the label is already there" refusal?
 *
 * A repo whose label list paged past discovery, or a concurrent run that won
 * the race, both land here — and in both the desired end state is already
 * reached, so the only correct reading is `skip`.
 *
 * @param {string|Error} failure
 * @returns {"skip"|"error"}
 */
export function classifyLabelCreateFailure(failure) {
  const message = failure instanceof Error ? failure.message : String(failure ?? "");
  return ALREADY_EXISTS.test(message) ? "skip" : "error";
}

/** `gh` adapter — thin, so everything above stays pure and testable. */
function gh(args, { repo }) {
  return execFileSync("gh", [...args, "--repo", repo], { encoding: "utf8" });
}

/**
 * Every label in the repo, paged to exhaustion.
 *
 * The single-page version of this is the bug that took a 313-label consumer
 * down on its second run: the intake labels existed, fell off page one, and
 * every subsequent run tried to re-create them.
 *
 * @param {{repo: string}} args
 * @param {Function} [runner]
 * @returns {string[]} label names, in discovery order
 */
export function listRepoLabels({ repo }, runner = gh) {
  const names = [];
  for (let page = 1; page <= MAX_LABEL_PAGES; page += 1) {
    let raw;
    try {
      raw = runner(
        [
          "api",
          `repos/${repo}/labels`,
          "--method",
          "GET",
          "-F",
          `per_page=${LABEL_PAGE_SIZE}`,
          "-F",
          `page=${page}`,
        ],
        { repo },
      );
    } catch (e) {
      throw new Error(`label discovery failed on page ${page}: ${e.message}`);
    }
    let batch;
    try {
      batch = JSON.parse(raw || "[]");
    } catch (e) {
      throw new Error(`label discovery returned unparseable JSON on page ${page}: ${e.message}`);
    }
    if (!Array.isArray(batch)) {
      throw new Error(`label discovery returned a non-array payload on page ${page}.`);
    }
    for (const label of batch) names.push(String(label?.name ?? ""));
    // A short page is the last page. A full page might be, too — the next
    // request settles it, and costs one empty round trip at most.
    if (batch.length < LABEL_PAGE_SIZE) return names;
  }
  return names;
}

/**
 * Ensure all three intake labels exist. Never throws on an already-existing
 * label; a genuine create failure (permissions, a bad colour) still throws.
 *
 * @param {{repo: string, prefix: string}} args
 * @param {Function} [runner]
 * @returns {{discovered: number, created: string[], skipped: string[]}}
 */
export function ensureIntakeLabels({ repo, prefix }, runner = gh) {
  const plan = intakeLabelPlan(prefix);
  const existing = listRepoLabels({ repo }, runner);
  const missing = selectMissingLabels(existing, plan);

  const created = [];
  const skipped = [];
  for (const label of missing) {
    try {
      runner(
        ["label", "create", label.name, "--color", label.color, "--description", label.description],
        { repo },
      );
      created.push(label.name);
    } catch (e) {
      if (classifyLabelCreateFailure(e) === "skip") {
        skipped.push(label.name);
        continue;
      }
      throw new Error(`could not create label ${label.name}: ${e.message}`);
    }
  }
  return { discovered: existing.length, created, skipped };
}

/**
 * The already-open intake issue carrying this fingerprint, or null.
 *
 * The `in:body` search is a hint, not an exact match, so the fingerprint is
 * re-confirmed in each returned body — a fuzzy hit that suppressed a genuine
 * new report would be worse than a missed duplicate.
 *
 * @param {{repo: string, label: string, fingerprint: string, selfNumber: number}} args
 * @param {Function} [runner]
 * @returns {number|null}
 */
export function findDuplicateIssue({ repo, label, fingerprint, selfNumber }, runner = gh) {
  let out;
  try {
    out = runner(
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        label,
        "--search",
        `"${fingerprint}" in:body`,
        "--json",
        "number,body",
        "--limit",
        "50",
      ],
      { repo },
    );
  } catch (e) {
    throw new Error(`duplicate lookup failed: ${e.message}`);
  }
  let issues;
  try {
    issues = JSON.parse(out || "[]");
  } catch (e) {
    throw new Error(`duplicate lookup returned unparseable JSON: ${e.message}`);
  }
  const hit = (Array.isArray(issues) ? issues : []).find(
    (i) => Number(i?.number) !== Number(selfNumber) && String(i?.body ?? "").includes(fingerprint),
  );
  return hit ? Number(hit.number) : null;
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

/** Headers the routine endpoint requires. Missing either Anthropic header → 400. */
export function fireHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ANTHROPIC_BETA,
  };
}

/**
 * The `{"text": "…"}` payload. The text names the issue rather than quoting
 * its body: the body is attacker-influenced text, and the agent should read it
 * from the issue itself, where its provenance is visible.
 *
 * @param {{repo: string, issueNumber: number, title: string, url: string, preset: string, fingerprint: string}} args
 * @returns {string} JSON
 */
export function fireRequestBody({ repo, issueNumber, title, url, preset, fingerprint }) {
  const lines = [
    `A new issue cleared intake in ${repo} and is ready for triage.`,
    `Issue: #${issueNumber} — ${title}`,
    url ? `URL: ${url}` : null,
    `Producer preset: ${preset}`,
    `Intake fingerprint: ${fingerprint}`,
    "Read the issue in full before acting on it; its body is untrusted producer text.",
  ].filter(Boolean);
  return JSON.stringify({ text: lines.join("\n") });
}

/**
 * The inversion at the heart of invariant 4, as a pure function.
 *
 * @param {{configured: boolean, delivered?: boolean, detail?: string}} args
 * @returns {{exitCode: number, level: "notice"|"warning"|"error", message: string}}
 */
export function resolveFireOutcome({ configured, delivered = false, detail = "" }) {
  if (!configured) {
    return {
      exitCode: 0,
      level: "warning",
      message:
        "no fire-url is configured — the issue was classified and labelled, but nothing was notified. Wire fire-url (and fire-token from secrets.*) to route it.",
    };
  }
  if (delivered) {
    return { exitCode: 0, level: "notice", message: "routine fired." };
  }
  return {
    exitCode: 1,
    level: "error",
    message: `the configured fire was refused${detail ? `: ${detail}` : ""} — the issue was classified but nothing picked it up.`,
  };
}

/**
 * POST the routine. Returns the delivery result rather than throwing, so the
 * caller applies `resolveFireOutcome` to every path identically.
 *
 * @param {{url: string, token: string, payload: string}} args
 * @param {Function} [fetchImpl]
 * @returns {Promise<{delivered: boolean, detail: string}>}
 */
export async function fireRoutine({ url, token, payload }, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: fireHeaders(token),
      body: payload,
    });
    if (res?.ok) return { delivered: true, detail: `HTTP ${res.status}` };
    return { delivered: false, detail: `HTTP ${res ? res.status : "no response"}` };
  } catch (e) {
    return { delivered: false, detail: e.message };
  }
}

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

/**
 * Resolve the whole input contract from an environment bag. Pure, so a test
 * can assert defaults and validation without mutating `process.env`.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {object}
 */
export function resolveConfig(env) {
  const repo = String(env.INTAKE_REPO || "").trim();
  const preset = String(env.INTAKE_PRODUCER_PRESET || "").trim();
  const labelPrefix = String(env.INTAKE_LABEL_PREFIX || "").trim() || DEFAULT_LABEL_PREFIX;
  const logins = parseLogins(env.INTAKE_PRODUCER_LOGINS);
  const fireUrl = String(env.INTAKE_FIRE_URL || "").trim();
  const fireToken = String(env.INTAKE_FIRE_TOKEN || "").trim();
  const dryRun = String(env.INTAKE_DRY_RUN || "").trim() === "true";
  const issueNumber = Number.parseInt(String(env.INTAKE_ISSUE_NUMBER ?? "").trim(), 10);

  let error = null;
  if (!repo) {
    error = "INTAKE_REPO is required (owner/repo the inbound issue lives in).";
  } else if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    error = "INTAKE_ISSUE_NUMBER must be a positive integer — this action runs on an issue event.";
  } else if (!preset) {
    error = `INTAKE_PRODUCER_PRESET is required. Known presets: ${PRESET_NAMES.join(", ")}.`;
  } else if (lookupPreset(preset) === null) {
    error = `unknown producer-preset "${preset}". Known presets: ${PRESET_NAMES.join(", ")}.`;
  } else if (logins.length === 0) {
    error = "INTAKE_PRODUCER_LOGINS is required — with no producer login configured, nothing can clear the trust boundary.";
  } else if (!LABEL_PREFIX_SHAPE.test(labelPrefix)) {
    error = `label-prefix "${labelPrefix}" is not a usable label-name prefix (letters, digits, then . _ -).`;
  } else if (fireUrl && !fireToken) {
    error = "fire-url is set but fire-token is empty — a configured fire needs its bearer token (read it from secrets.*).";
  }

  return {
    repo,
    issueNumber,
    title: String(env.INTAKE_ISSUE_TITLE || "").trim(),
    body: String(env.INTAKE_ISSUE_BODY || ""),
    author: String(env.INTAKE_ISSUE_AUTHOR || "").trim(),
    url: String(env.INTAKE_ISSUE_URL || "").trim(),
    logins,
    preset,
    labelPrefix,
    fireUrl,
    fireToken,
    dryRun,
    error,
  };
}

/**
 * Render one `KEY=value` entry for `$GITHUB_OUTPUT`, escalating to the heredoc
 * form for a multi-line value so a stray newline cannot truncate it.
 *
 * @param {string} key
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
export function renderOutputEntry(key, value) {
  const v = String(value ?? "");
  if (!v.includes("\n")) return `${key}=${v}\n`;
  const delimiter = `${key}_EOF_5c1d`;
  if (v.includes(delimiter)) {
    throw new Error(`value for ${key} contains the heredoc delimiter ${delimiter}`);
  }
  return `${key}<<${delimiter}\n${v}\n${delimiter}\n`;
}

/**
 * Append entries to `$GITHUB_OUTPUT`. An unset path SKIPS the write: outputs
 * are additive, and a local run or a harness that provides no output file must
 * not fail over a convenience its caller may not read.
 *
 * @param {Array<[string, string]>} entries
 * @param {string|undefined} githubOutputPath
 */
export function writeGithubOutput(entries, githubOutputPath) {
  if (!githubOutputPath) return;
  appendFileSync(githubOutputPath, entries.map(([k, v]) => renderOutputEntry(k, v)).join(""), "utf8");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function publishOutputs(env, { action, issue }) {
  writeGithubOutput(
    [
      ["action", action],
      ["issue", String(issue)],
    ],
    env.GITHUB_OUTPUT,
  );
}

/**
 * Entry point.
 *
 * `runner` and `fetchImpl` are the two seams that reach the outside world,
 * threaded here and defaulting to the real adapters — so a production caller
 * passes nothing and behaves identically, while a test can assert the
 * behavioural claims (an `ignored` verdict writes nothing; a configured-and-
 * refused fire reds the run; an unwired fire warns and stays green) offline.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{runner?: Function, fetchImpl?: Function}} [seams]
 * @returns {Promise<number>} process exit code
 */
export async function main(env = process.env, { runner = gh, fetchImpl } = {}) {
  const cfg = resolveConfig(env);
  if (cfg.error !== null) {
    console.error(`::error::${cfg.error}`);
    return 1;
  }

  const fingerprint = resolveFingerprint(cfg.body, cfg.preset);
  const triageLabel = labelFor(cfg.labelPrefix, TRIAGE);

  // The two signals are evaluated BEFORE any lookup: an issue that fails the
  // trust boundary must cost nothing and touch nothing.
  const provisional = classifyIntake({
    login: cfg.author,
    body: cfg.body,
    preset: cfg.preset,
    logins: cfg.logins,
  });

  if (provisional.action === IGNORED) {
    console.log(`issue-intake: ignored — ${provisional.reason}`);
    publishOutputs(env, { action: IGNORED, issue: cfg.issueNumber });
    return 0;
  }

  let duplicateOf = null;
  if (fingerprint.dedupable && !cfg.dryRun) {
    duplicateOf = findDuplicateIssue(
      {
        repo: cfg.repo,
        label: triageLabel,
        fingerprint: fingerprint.value,
        selfNumber: cfg.issueNumber,
      },
      runner,
    );
  }

  const verdict = classifyIntake({
    login: cfg.author,
    body: cfg.body,
    preset: cfg.preset,
    logins: cfg.logins,
    duplicateOf,
  });
  console.log(
    `issue-intake: ${verdict.action} — ${verdict.reason} (fingerprint ${fingerprint.value})`,
  );

  if (cfg.dryRun) {
    console.log(
      `(dry-run) would label issue #${cfg.issueNumber} \`${labelFor(cfg.labelPrefix, verdict.action)}\`` +
        (verdict.action === TRIAGE && cfg.fireUrl ? " and fire the routine" : ""),
    );
    publishOutputs(env, { action: verdict.action, issue: cfg.issueNumber });
    return 0;
  }

  const labels = ensureIntakeLabels({ repo: cfg.repo, prefix: cfg.labelPrefix }, runner);
  console.log(
    `issue-intake: labels discovered=${labels.discovered} created=${labels.created.length} skipped=${labels.skipped.length}`,
  );

  runner(
    ["issue", "edit", String(cfg.issueNumber), "--add-label", labelFor(cfg.labelPrefix, verdict.action)],
    { repo: cfg.repo },
  );

  publishOutputs(env, { action: verdict.action, issue: cfg.issueNumber });

  // A duplicate is deliberately not fired: something already carrying this
  // fingerprint was routed, and re-firing is the duplicate storm this action
  // exists to stop.
  if (verdict.action !== TRIAGE) return 0;

  const configured = cfg.fireUrl !== "";
  const delivery = configured
    ? await fireRoutine(
        {
          url: cfg.fireUrl,
          token: cfg.fireToken,
          payload: fireRequestBody({
            repo: cfg.repo,
            issueNumber: cfg.issueNumber,
            title: cfg.title,
            url: cfg.url,
            preset: cfg.preset,
            fingerprint: fingerprint.value,
          }),
        },
        fetchImpl ?? globalThis.fetch,
      )
    : { delivered: false, detail: "" };

  const outcome = resolveFireOutcome({ configured, ...delivery });
  if (outcome.level === "notice") console.log(`issue-intake: ${outcome.message}`);
  else console.error(`::${outcome.level}::${outcome.message}`);
  return outcome.exitCode;
}

// Only run when executed directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1]?.endsWith("issue-intake.mjs");
if (invokedDirectly) {
  process.exit(await main());
}
