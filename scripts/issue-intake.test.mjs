// Unit coverage for the producer-agnostic issue-intake normalizer (Story #435).
//
// The action decides what an inbound issue is allowed to set in motion, so the
// claims worth pinning are the ones a consumer would otherwise re-derive and
// get wrong:
//
//   • the trigger label is a TWO-signal trust boundary — either signal alone
//     classifies `ignored`, and an `ignored` verdict touches nothing;
//   • label discovery pages past the first 200, and a create refused as
//     already-existing is a skip rather than a failure;
//   • fire semantics INVERT on configuration — a configured-and-refused fire
//     reds the run, an unwired one warns and stays green.
//
// Everything here runs offline: the `gh` adapter and `fetch` are injected
// seams, so even the behavioural claims are asserted without network access.
//
// Run: node --test scripts/issue-intake.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANTHROPIC_BETA,
  ANTHROPIC_VERSION,
  DEFAULT_LABEL_PREFIX,
  DUPLICATE,
  IGNORED,
  LABEL_PAGE_SIZE,
  PRESET_NAMES,
  PRODUCER_PRESETS,
  TRIAGE,
  classifyIntake,
  classifyLabelCreateFailure,
  ensureIntakeLabels,
  findDuplicateIssue,
  fireHeaders,
  fireRequestBody,
  fireRoutine,
  intakeLabelPlan,
  intrinsicIdentity,
  isProducerLogin,
  labelFor,
  listRepoLabels,
  lookupPreset,
  main,
  matchesBodyShape,
  parseLogins,
  renderOutputEntry,
  resolveConfig,
  resolveFingerprint,
  resolveFireOutcome,
  selectMissingLabels,
  writeGithubOutput,
} from "../.github/actions/issue-intake/issue-intake.mjs";

const REPO = "acme/widgets";
const PRODUCER = "acme-monitor-bot";
const LOGINS = [PRODUCER, "second-bot"];
const PRESET = "structured-report";
const MATCHING_BODY = ["An alert fired in production.", "", "Fingerprint: alert-7731-cpu", ""].join("\n");
const NON_MATCHING_BODY = "Hey, the site felt slow this morning. Could someone look?";

// ---------------------------------------------------------------------------
// Fake `gh` runner — records every call so "wrote nothing" is assertable.
// ---------------------------------------------------------------------------

/**
 * @param {{labels?: string[], duplicates?: Array<{number: number, body: string}>, createFails?: (name: string) => Error|null}} [opts]
 */
function fakeRunner(opts = {}) {
  const labels = opts.labels ?? [];
  const duplicates = opts.duplicates ?? [];
  const calls = [];

  const runner = (args, ctx) => {
    calls.push({ args, ctx });

    if (args[0] === "api" && String(args[1]).endsWith("/labels")) {
      const pageArg = args.find((a) => String(a).startsWith("page="));
      const page = Number(String(pageArg).slice("page=".length));
      const start = (page - 1) * LABEL_PAGE_SIZE;
      const slice = labels.slice(start, start + LABEL_PAGE_SIZE);
      return JSON.stringify(slice.map((name) => ({ name })));
    }
    if (args[0] === "label" && args[1] === "create") {
      const failure = opts.createFails ? opts.createFails(args[2]) : null;
      if (failure) throw failure;
      return "";
    }
    if (args[0] === "issue" && args[1] === "list") {
      return JSON.stringify(duplicates);
    }
    if (args[0] === "issue" && args[1] === "edit") {
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  runner.calls = calls;
  runner.mutations = () =>
    calls.filter(
      ({ args }) =>
        (args[0] === "label" && args[1] === "create") ||
        (args[0] === "issue" && args[1] === "edit"),
    );
  return runner;
}

/** Run `fn` with console output captured, returning its result and the lines. */
async function withCapturedConsole(fn) {
  const log = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a) => log.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    const result = await fn();
    return { result, log, err };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** A complete, valid environment bag; `overrides` tweaks one field at a time. */
const envFor = (overrides = {}) => ({
  INTAKE_REPO: REPO,
  INTAKE_ISSUE_NUMBER: "412",
  INTAKE_ISSUE_TITLE: "CPU saturation on edge-3",
  INTAKE_ISSUE_BODY: MATCHING_BODY,
  INTAKE_ISSUE_AUTHOR: PRODUCER,
  INTAKE_ISSUE_URL: `https://github.com/${REPO}/issues/412`,
  INTAKE_PRODUCER_LOGINS: LOGINS.join(","),
  INTAKE_PRODUCER_PRESET: PRESET,
  INTAKE_LABEL_PREFIX: "intake",
  INTAKE_FIRE_URL: "",
  INTAKE_FIRE_TOKEN: "",
  INTAKE_DRY_RUN: "false",
  ...overrides,
});

// ---------------------------------------------------------------------------
// AC-2 — the trigger label is a TWO-signal trust boundary
// ---------------------------------------------------------------------------

test("AC-2: a matching producer login with a non-matching body classifies ignored", () => {
  const verdict = classifyIntake({
    login: PRODUCER,
    body: NON_MATCHING_BODY,
    preset: PRESET,
    logins: LOGINS,
  });
  assert.equal(verdict.action, IGNORED);
  assert.equal(verdict.loginMatch, true);
  assert.equal(verdict.bodyMatch, false);
  assert.match(verdict.reason, /body does not match/);
});

test("AC-2: a matching body from a non-producer login classifies ignored", () => {
  const verdict = classifyIntake({
    login: "drive-by-contributor",
    body: MATCHING_BODY,
    preset: PRESET,
    logins: LOGINS,
  });
  assert.equal(verdict.action, IGNORED);
  assert.equal(verdict.loginMatch, false);
  assert.equal(verdict.bodyMatch, true);
  assert.match(verdict.reason, /not a configured producer/);
});

test("AC-2: both signals together are what classify triage", () => {
  const verdict = classifyIntake({
    login: PRODUCER,
    body: MATCHING_BODY,
    preset: PRESET,
    logins: LOGINS,
  });
  assert.equal(verdict.action, TRIAGE);
  assert.equal(verdict.loginMatch, true);
  assert.equal(verdict.bodyMatch, true);
});

test("AC-2: neither signal matching classifies ignored", () => {
  const verdict = classifyIntake({
    login: "someone-else",
    body: NON_MATCHING_BODY,
    preset: PRESET,
    logins: LOGINS,
  });
  assert.equal(verdict.action, IGNORED);
  assert.match(verdict.reason, /neither signal/);
});

test("AC-2: an ignored verdict is inert — no gh call reaches the runner at all", async () => {
  const runner = fakeRunner({ labels: [] });
  const { result } = await withCapturedConsole(() =>
    main(envFor({ INTAKE_ISSUE_AUTHOR: "drive-by-contributor" }), { runner }),
  );
  assert.equal(result, 0);
  assert.deepEqual(runner.calls, []);
});

test("login matching is case-insensitive; an empty login never matches", () => {
  assert.equal(isProducerLogin("ACME-Monitor-Bot", LOGINS), true);
  assert.equal(isProducerLogin("", LOGINS), false);
  assert.equal(isProducerLogin(undefined, LOGINS), false);
  assert.deepEqual(parseLogins(" A , b ,, B "), ["a", "b"]);
});

test("an unknown preset never matches a body — the boundary fails closed", () => {
  assert.equal(matchesBodyShape(MATCHING_BODY, "no-such-preset"), false);
  assert.equal(lookupPreset("constructor"), null, "prototype keys are not presets");
  assert.equal(
    classifyIntake({ login: PRODUCER, body: MATCHING_BODY, preset: "constructor", logins: LOGINS }).action,
    IGNORED,
  );
});

// ---------------------------------------------------------------------------
// AC-4 — matchers are regex LITERALS in a preset table
// ---------------------------------------------------------------------------

test("AC-4: every preset matcher is a stateless RegExp literal (no `g` flag)", () => {
  assert.ok(PRESET_NAMES.length >= 3);
  for (const name of PRESET_NAMES) {
    const entry = PRODUCER_PRESETS[name];
    if (entry.extract) {
      // A URL-signalled preset supplies a parser INSTEAD of the regex pair: a
      // regex cannot check a host safely (see the sentry regression below).
      assert.equal(typeof entry.extract, "function", `${name}.extract is a function`);
      assert.equal(entry.shape, undefined, `${name} carries no regex shape`);
      assert.equal(entry.identity, undefined, `${name} carries no regex identity`);
      continue;
    }
    assert.ok(entry.shape instanceof RegExp, `${name}.shape is a RegExp`);
    assert.ok(!entry.shape.global, `${name}.shape must not carry the g flag`);
    if (entry.identity) {
      assert.ok(entry.identity instanceof RegExp, `${name}.identity is a RegExp`);
      assert.ok(!entry.identity.global, `${name}.identity must not carry the g flag`);
    }
  }
});

test("each shipped preset matches its own producer shape and rejects prose", () => {
  const samples = {
    "structured-report": MATCHING_BODY,
    "mandrel-tracker": "<!-- acme:nightly-tracker -->\n<!-- acme:nightly-tracker-digest: 9f2c41ab77de -->",
    sentry: "Error spike: https://acme.sentry.io/issues/554120 needs attention.",
    "osv-advisory": "Advisory GHSA-abcd-1234-wxyz affects lodash.",
  };
  for (const [name, body] of Object.entries(samples)) {
    assert.equal(matchesBodyShape(body, name), true, `${name} matches its own shape`);
    assert.equal(matchesBodyShape(NON_MATCHING_BODY, name), false, `${name} rejects prose`);
  }
});

test("the sentry matcher checks the HOST, so a lookalike URL is not a producer shape", () => {
  const real = "Error spike: https://acme.sentry.io/issues/554120 needs attention.";
  assert.equal(matchesBodyShape(real, "sentry"), true, "a real Sentry link still matches");
  assert.equal(intrinsicIdentity(real, "sentry"), "554120");
  assert.equal(matchesBodyShape("https://sentry.io/issues/9 fired.", "sentry"), true, "the bare host matches too");

  // Every body below carries the literal text of a Sentry issue URL, and the
  // unanchored host regex this preset used to ship matched all of them
  // (CodeQL js/regex/missing-regexp-anchor, PR #438). An issue body is
  // attacker-controlled, so each one forged the second of the two trust
  // signals — a real defect, not a lint.
  const forged = [
    "https://evil.example/?u=https://acme.sentry.io/issues/1",
    "https://evil.example/acme.sentry.io/issues/1",
    "https://notsentry.io/issues/1",
    "https://acme.sentry.io.evil.example/issues/1",
    "http://acme.sentry.io/issues/1",
  ];
  for (const body of forged) {
    assert.equal(matchesBodyShape(body, "sentry"), false, `forged shape accepted: ${body}`);
    assert.equal(intrinsicIdentity(body, "sentry"), null, `forged identity extracted: ${body}`);
  }
});

test("a forged sentry body is ignored even when the author IS a configured producer", () => {
  // The producer login is real; only the body is forged. Signal one alone must
  // not be enough, which is the whole point of the two-signal boundary.
  const verdict = classifyIntake({
    login: PRODUCER,
    body: "https://evil.example/?u=https://acme.sentry.io/issues/1",
    preset: "sentry",
    logins: LOGINS,
  });
  assert.equal(verdict.action, IGNORED);
});

test("the mandrel-tracker matcher honours the legacy `--!>` comment terminator", () => {
  const legacy = "<!-- acme:tracker-digest: 9f2c41ab77de --!>";
  assert.equal(matchesBodyShape(legacy, "mandrel-tracker"), true);
  assert.equal(intrinsicIdentity(legacy, "mandrel-tracker"), "9f2c41ab77de");
});

test("a preset with an intrinsic identity dedupes; one without falls back to a content hash", () => {
  const intrinsic = resolveFingerprint(MATCHING_BODY, PRESET);
  assert.deepEqual(intrinsic, { value: "alert-7731-cpu", dedupable: true });

  const hashed = resolveFingerprint("Fingerprint: x\nGHSA-abcd-1234-wxyz", "osv-advisory");
  assert.equal(hashed.dedupable, true);
  assert.equal(hashed.value, "GHSA-abcd-1234-wxyz");

  const noIdentity = resolveFingerprint("Fingerprint: sh\nnothing structured here", PRESET);
  assert.equal(noIdentity.dedupable, false);
  assert.match(noIdentity.value, /^sha:[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------------------
// AC-3 — label discovery pages, and "already exists" is a SKIP
// ---------------------------------------------------------------------------

test("AC-3: label discovery pages past the first 200 (313-label fixture)", () => {
  const labels = Array.from({ length: 313 }, (_, i) => `label-${i}`);
  const runner = fakeRunner({ labels });
  const discovered = listRepoLabels({ repo: REPO }, runner);

  assert.equal(discovered.length, 313, "every label is discovered, not just page one");
  assert.ok(discovered.includes("label-300"), "a label past the 200th is seen");
  assert.equal(runner.calls.length, 4, "100 + 100 + 100 + 13 → four pages");
});

test("AC-3: an intake label sitting past page one is never re-created", () => {
  const plan = intakeLabelPlan(DEFAULT_LABEL_PREFIX);
  const labels = [
    ...Array.from({ length: 311 }, (_, i) => `label-${i}`),
    plan[0].name,
    plan[1].name,
  ];
  const runner = fakeRunner({ labels });
  const result = ensureIntakeLabels({ repo: REPO, prefix: DEFAULT_LABEL_PREFIX }, runner);

  assert.equal(result.discovered, 313);
  assert.deepEqual(result.created, [plan[2].name], "only the genuinely absent label is created");
  assert.deepEqual(result.skipped, []);
});

test("AC-3: a create refused as already-existing returns success as a skip", () => {
  const runner = fakeRunner({
    labels: [],
    createFails: (name) =>
      name === labelFor(DEFAULT_LABEL_PREFIX, DUPLICATE)
        ? new Error('HTTP 422: Validation Failed (name: already_exists)')
        : null,
  });
  const result = ensureIntakeLabels({ repo: REPO, prefix: DEFAULT_LABEL_PREFIX }, runner);

  assert.deepEqual(result.skipped, [labelFor(DEFAULT_LABEL_PREFIX, DUPLICATE)]);
  assert.equal(result.created.length, 2);
});

test("a genuine create failure is still an error", () => {
  const runner = fakeRunner({ labels: [], createFails: () => new Error("HTTP 403: Resource not accessible") });
  assert.throws(
    () => ensureIntakeLabels({ repo: REPO, prefix: DEFAULT_LABEL_PREFIX }, runner),
    /could not create label .*403/,
  );
});

test("classifyLabelCreateFailure separates the benign refusal from a real failure", () => {
  assert.equal(classifyLabelCreateFailure(new Error("name already exists")), "skip");
  assert.equal(classifyLabelCreateFailure("already_exists"), "skip");
  assert.equal(classifyLabelCreateFailure(new Error("403 Forbidden")), "error");
});

test("missing-label selection ignores case, matching GitHub's own collision rule", () => {
  const plan = intakeLabelPlan("Intake");
  assert.deepEqual(selectMissingLabels(["intake:triage", "intake:ignored"], plan), [plan[1]]);
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

test("a fingerprint already open under the trigger label downgrades triage to duplicate", async () => {
  const runner = fakeRunner({
    labels: [],
    duplicates: [{ number: 88, body: "Fingerprint: alert-7731-cpu" }],
  });
  const { result, log } = await withCapturedConsole(() => main(envFor(), { runner }));

  assert.equal(result, 0);
  assert.ok(log.some((l) => l.includes("duplicate")), "the verdict is reported as duplicate");
  const edit = runner.calls.find(({ args }) => args[0] === "issue" && args[1] === "edit");
  assert.ok(edit.args.includes("intake:duplicate"), "the duplicate label is what gets applied");
});

test("the `in:body` search is a hint — a hit that does not carry the fingerprint is not a duplicate", () => {
  const runner = fakeRunner({ duplicates: [{ number: 90, body: "unrelated text" }] });
  assert.equal(
    findDuplicateIssue(
      { repo: REPO, label: "intake:triage", fingerprint: "alert-7731-cpu", selfNumber: 412 },
      runner,
    ),
    null,
  );
});

test("an issue never dedupes against itself", () => {
  const runner = fakeRunner({ duplicates: [{ number: 412, body: "Fingerprint: alert-7731-cpu" }] });
  assert.equal(
    findDuplicateIssue(
      { repo: REPO, label: "intake:triage", fingerprint: "alert-7731-cpu", selfNumber: 412 },
      runner,
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// AC-5 — fire semantics invert on configuration
// ---------------------------------------------------------------------------

test("AC-5: a configured fire that is refused exits non-zero", async () => {
  const runner = fakeRunner({ labels: [] });
  const { result, err } = await withCapturedConsole(() =>
    main(
      envFor({
        INTAKE_FIRE_URL: "https://api.anthropic.test/v1/routines",
        INTAKE_FIRE_TOKEN: "routine-token",
      }),
      { runner, fetchImpl: async () => ({ ok: false, status: 503 }) },
    ),
  );

  assert.equal(result, 1, "a classified issue nothing picked up must red the run");
  assert.ok(err.some((l) => l.startsWith("::error::")), "the refusal is reported as an error");
  const edit = runner.calls.find(({ args }) => args[0] === "issue" && args[1] === "edit");
  assert.ok(edit.args.includes("intake:triage"), "the issue is still labelled before the fire");
});

test("AC-5: an unconfigured fire warns and exits zero", async () => {
  const runner = fakeRunner({ labels: [] });
  const { result, err } = await withCapturedConsole(() =>
    main(envFor({ INTAKE_FIRE_URL: "", INTAKE_FIRE_TOKEN: "" }), {
      runner,
      fetchImpl: async () => {
        throw new Error("fetch must not be called when no fire is configured");
      },
    }),
  );

  assert.equal(result, 0, "a repo that has not opted in stays green");
  assert.ok(err.some((l) => l.startsWith("::warning::")), "the unwired fire is warned about");
});

test("AC-5: a configured fire that is accepted exits zero", async () => {
  const runner = fakeRunner({ labels: [] });
  const seen = [];
  const { result } = await withCapturedConsole(() =>
    main(
      envFor({
        INTAKE_FIRE_URL: "https://api.anthropic.test/v1/routines",
        INTAKE_FIRE_TOKEN: "routine-token",
      }),
      {
        runner,
        fetchImpl: async (url, init) => {
          seen.push({ url, init });
          return { ok: true, status: 200 };
        },
      },
    ),
  );

  assert.equal(result, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].url, "https://api.anthropic.test/v1/routines");
  assert.equal(seen[0].init.headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(seen[0].init.headers["anthropic-beta"], ANTHROPIC_BETA);
  assert.deepEqual(
    Object.keys(JSON.parse(seen[0].init.body)),
    ["text"],
    "the payload carries exactly one `text` field",
  );
});

test("resolveFireOutcome inverts on configuration, not on the response alone", () => {
  assert.equal(resolveFireOutcome({ configured: false }).exitCode, 0);
  assert.equal(resolveFireOutcome({ configured: false }).level, "warning");
  assert.equal(resolveFireOutcome({ configured: true, delivered: false, detail: "HTTP 500" }).exitCode, 1);
  assert.equal(resolveFireOutcome({ configured: true, delivered: true }).exitCode, 0);
});

test("the fire carries both Anthropic headers — omitting either returns 400", () => {
  const headers = fireHeaders("tok-123");
  assert.equal(headers.Authorization, "Bearer tok-123");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(headers["anthropic-beta"], ANTHROPIC_BETA);
});

test("the fire body is a single `text` field naming the issue, not quoting it", () => {
  const payload = JSON.parse(
    fireRequestBody({
      repo: REPO,
      issueNumber: 412,
      title: "CPU saturation on edge-3",
      url: `https://github.com/${REPO}/issues/412`,
      preset: PRESET,
      fingerprint: "alert-7731-cpu",
    }),
  );
  assert.deepEqual(Object.keys(payload), ["text"]);
  assert.match(payload.text, /#412/);
  assert.match(payload.text, /alert-7731-cpu/);
  assert.ok(!payload.text.includes(NON_MATCHING_BODY));
});

test("a transport-level fire failure is a refusal, not a crash", async () => {
  const outcome = await fireRoutine(
    { url: "https://api.anthropic.test/v1/routines", token: "t", payload: "{}" },
    async () => {
      throw new Error("ECONNREFUSED");
    },
  );
  assert.deepEqual(outcome, { delivered: false, detail: "ECONNREFUSED" });
});

test("a duplicate never re-fires — that storm is what dedupe exists to stop", async () => {
  const runner = fakeRunner({
    labels: [],
    duplicates: [{ number: 88, body: "Fingerprint: alert-7731-cpu" }],
  });
  const { result } = await withCapturedConsole(() =>
    main(
      envFor({
        INTAKE_FIRE_URL: "https://api.anthropic.test/v1/routines",
        INTAKE_FIRE_TOKEN: "routine-token",
      }),
      {
        runner,
        fetchImpl: async () => {
          throw new Error("a duplicate must not fire");
        },
      },
    ),
  );
  assert.equal(result, 0);
});

// ---------------------------------------------------------------------------
// Configuration contract
// ---------------------------------------------------------------------------

test("resolveConfig defaults the label prefix and reads the dry-run flag literally", () => {
  const cfg = resolveConfig(envFor({ INTAKE_LABEL_PREFIX: "", INTAKE_DRY_RUN: "TRUE" }));
  assert.equal(cfg.error, null);
  assert.equal(cfg.labelPrefix, DEFAULT_LABEL_PREFIX);
  assert.equal(cfg.dryRun, false, "only the exact string `true` enables a dry run");
});

test("resolveConfig rejects each misconfiguration with a named reason", () => {
  const cases = [
    [{ INTAKE_REPO: "" }, /INTAKE_REPO is required/],
    [{ INTAKE_ISSUE_NUMBER: "" }, /INTAKE_ISSUE_NUMBER/],
    [{ INTAKE_ISSUE_NUMBER: "0" }, /INTAKE_ISSUE_NUMBER/],
    [{ INTAKE_PRODUCER_PRESET: "" }, /INTAKE_PRODUCER_PRESET is required/],
    [{ INTAKE_PRODUCER_PRESET: "made-up" }, /unknown producer-preset/],
    [{ INTAKE_PRODUCER_LOGINS: " , " }, /INTAKE_PRODUCER_LOGINS is required/],
    [{ INTAKE_LABEL_PREFIX: "not a prefix!" }, /not a usable label-name prefix/],
    [{ INTAKE_FIRE_URL: "https://x.test", INTAKE_FIRE_TOKEN: "" }, /needs its bearer token/],
  ];
  for (const [overrides, shape] of cases) {
    const cfg = resolveConfig(envFor(overrides));
    assert.match(String(cfg.error), shape);
  }
});

test("a misconfigured run exits 1 without touching the repo", async () => {
  const runner = fakeRunner({ labels: [] });
  const { result } = await withCapturedConsole(() =>
    main(envFor({ INTAKE_PRODUCER_PRESET: "made-up" }), { runner }),
  );
  assert.equal(result, 1);
  assert.deepEqual(runner.calls, []);
});

test("a dry run classifies but writes nothing", async () => {
  const runner = fakeRunner({ labels: [] });
  const { result, log } = await withCapturedConsole(() =>
    main(envFor({ INTAKE_DRY_RUN: "true", INTAKE_FIRE_URL: "https://x.test", INTAKE_FIRE_TOKEN: "t" }), {
      runner,
      fetchImpl: async () => {
        throw new Error("a dry run must not fire");
      },
    }),
  );
  assert.equal(result, 0);
  assert.deepEqual(runner.mutations(), []);
  assert.ok(log.some((l) => l.includes("(dry-run)")));
});

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

test("outputs report the verdict and the issue, and survive a multi-line value", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-intake-"));
  const file = join(dir, "outputs");
  writeGithubOutput(
    [
      ["action", TRIAGE],
      ["issue", "412"],
    ],
    file,
  );
  const written = readFileSync(file, "utf8");
  assert.match(written, /^action=triage$/m);
  assert.match(written, /^issue=412$/m);

  assert.equal(renderOutputEntry("k", "one"), "k=one\n");
  assert.match(renderOutputEntry("k", "one\ntwo"), /^k<<k_EOF_[0-9a-f]+\none\ntwo\nk_EOF_[0-9a-f]+\n$/);
});

test("an unset $GITHUB_OUTPUT skips the write rather than failing the run", () => {
  assert.doesNotThrow(() => writeGithubOutput([["action", IGNORED]], undefined));
});

test("main publishes the verdict to $GITHUB_OUTPUT even when the issue is ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-intake-"));
  const file = join(dir, "outputs");
  const runner = fakeRunner({ labels: [] });
  await withCapturedConsole(() =>
    main(envFor({ INTAKE_ISSUE_AUTHOR: "stranger", GITHUB_OUTPUT: file }), { runner }),
  );
  const written = readFileSync(file, "utf8");
  assert.match(written, /^action=ignored$/m);
  assert.match(written, /^issue=412$/m);
});
