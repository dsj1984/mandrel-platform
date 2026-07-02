/**
 * scripts/lib/uses-pins.mjs
 *
 * The single home for `uses:`-line parsing, reference classification, and
 * 40-hex-SHA validation shared by the pin-tooling scripts. These primitives
 * had been copy-pasted into `check-action-pins.mjs` (the SHA-pin ratchet) and
 * partially re-implemented as ad-hoc regexes in `check-workflow-portability.mjs`
 * (the internal-pin collector) — the exact drift Story #203 consolidates.
 *
 * Nothing here reads the filesystem or the environment: every function is a
 * pure text transform, so the sibling `uses-pins.test.mjs` runs fully offline.
 *
 * ## Vocabulary
 *
 *   • A raw `uses:` VALUE is whatever follows `uses:` on a workflow/action
 *     line, possibly quoted and possibly carrying a trailing `# vX.Y.Z` tag
 *     note. {@link stripUsesValue} reduces it to the bare reference.
 *   • A bare REFERENCE is `owner/repo[/subpath]@gitref`, `./local/path`, or
 *     `docker://image`. {@link classifyUses} sorts it into first-party /
 *     third-party / local / docker / unparseable.
 *   • A git REF is a full 40-char commit SHA, a tag, a branch, or a short SHA.
 *     {@link isSha40} is the SHA-pin predicate the ratchet enforces.
 *
 * ## Single-pin invariant (Story #203)
 *
 * {@link findSinglePinViolations} adds an INTRA-repo check absent from the
 * cross-repo pin-drift dashboard: within one repo's `.github/workflows/`, two
 * first-party `uses:` refs to the SAME subpath MUST carry the SAME SHA. Two
 * workflows pinning `owner/repo/.github/actions/foo` at different commits is a
 * silent split-brain — one workflow runs the fixed action, the other the
 * stale one. This check makes that state fail CI.
 */

const DEFAULT_FIRST_PARTY_OWNER = "dsj1984/mandrel-platform";

/** A full git commit SHA is exactly 40 lowercase/uppercase hex characters. */
const SHA40_RE = /^[0-9a-fA-F]{40}$/;

/**
 * Matches a YAML `uses:` mapping key: optional leading whitespace, an optional
 * leading `- ` (sequence item), then `uses:` and the value. A `uses:` inside a
 * `#` comment or a `run:` heredoc is indented past a leading `#`, so anchoring
 * on the leading token avoids false hits on documentation examples.
 */
const USES_LINE_RE = /^\s*(?:-\s+)?uses:\s*(\S.*)$/;

export { DEFAULT_FIRST_PARTY_OWNER, SHA40_RE, USES_LINE_RE };

/**
 * Strip a trailing `# comment` (the conventional `# v4.2.2` tag note) and
 * surrounding whitespace/quotes from a raw `uses:` value, returning the bare
 * action reference. A `#` inside the ref itself is not valid GitHub syntax,
 * so splitting on the first ` #` is safe.
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripUsesValue(raw) {
  let v = String(raw).trim();
  // Drop a trailing comment: the first '#' that is preceded by whitespace (or
  // at the start) begins a comment. GitHub action refs never contain '#'.
  const hashIdx = v.search(/\s#/);
  if (hashIdx !== -1) v = v.slice(0, hashIdx);
  v = v.trim();
  // Unwrap matched surrounding quotes.
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/**
 * If a line is a YAML `uses:` mapping key, return its bare reference (comment
 * and quotes stripped); otherwise return null. Whole-line `#` comments never
 * match.
 *
 * @param {string} line
 * @returns {string | null}
 */
export function parseUsesLine(line) {
  const raw = String(line);
  if (/^\s*#/.test(raw)) return null;
  const m = raw.match(USES_LINE_RE);
  if (!m) return null;
  return stripUsesValue(m[1]);
}

/**
 * Classify a bare `uses:` reference. Returns one of:
 *   { kind: 'local' }                     — `./path` or `../path` (exempt)
 *   { kind: 'docker' }                    — `docker://image` (exempt)
 *   { kind: 'first-party', owner, subpath, ref } — the configured first-party
 *                                           owner (exempt from the SHA ratchet)
 *   { kind: 'third-party', owner, subpath, ref } — external action (MUST be
 *                                           SHA-pinned)
 *   { kind: 'unparseable' }               — not a recognizable `uses:` reference
 *
 * `subpath` is the path segment after `owner/repo/` (empty string when the ref
 * is the bare `owner/repo`), so single-pin comparison can key on it.
 *
 * @param {string} bareRef
 * @param {string} [firstPartyOwner]
 * @returns {{kind: string, owner?: string, subpath?: string, ref?: string, ownerRepoPath?: string}}
 */
export function classifyUses(bareRef, firstPartyOwner = DEFAULT_FIRST_PARTY_OWNER) {
  const ref = String(bareRef).trim();
  if (ref === "") return { kind: "unparseable" };
  if (ref.startsWith("./") || ref.startsWith("../")) return { kind: "local" };
  if (ref.startsWith("docker://")) return { kind: "docker" };

  // owner/repo[/subpath]@gitref. The git ref is everything after the LAST '@'
  // (an action subpath never contains '@'; the ref does not either).
  const atIdx = ref.lastIndexOf("@");
  if (atIdx === -1) {
    // No `@ref` at all — not a pinnable external reference (e.g. a malformed
    // entry). Treat as unparseable so the caller can flag it explicitly.
    return { kind: "unparseable", ownerRepoPath: ref };
  }
  const ownerRepoPath = ref.slice(0, atIdx);
  const gitRef = ref.slice(atIdx + 1);
  const segments = ownerRepoPath.split("/");
  if (segments.length < 2) return { kind: "unparseable", ownerRepoPath, ref: gitRef };

  const ownerRepo = `${segments[0]}/${segments[1]}`;
  const subpath = segments.slice(2).join("/");
  if (ownerRepo.toLowerCase() === String(firstPartyOwner).toLowerCase()) {
    return { kind: "first-party", owner: ownerRepo, subpath, ref: gitRef };
  }
  return { kind: "third-party", owner: ownerRepo, subpath, ref: gitRef };
}

/**
 * True when a git ref is a full 40-character commit SHA.
 *
 * @param {string} gitRef
 * @returns {boolean}
 */
export function isSha40(gitRef) {
  return SHA40_RE.test(String(gitRef).trim());
}

/**
 * Scan a file's TEXT for first-party `uses:` refs and index each by its
 * `owner/repo/subpath` reference target, capturing the SHA (or non-SHA ref)
 * each site pins. Returns a Map keyed by `owner/repo` + `/subpath` (the full
 * reference minus `@ref`), each value an array of
 * `{ file, line, ref, target }` occurrences. Only `first-party` refs with a
 * non-empty subpath are collected — a bare `owner/repo@ref` self-reference has
 * no subpath to disambiguate, and third-party refs are governed by the
 * cross-repo pin-drift dashboard, not the intra-repo single-pin invariant.
 *
 * @param {string} content
 * @param {string} displayFile
 * @param {string} [firstPartyOwner]
 * @returns {Map<string, Array<{file: string, line: number, ref: string, target: string}>>}
 */
export function collectFirstPartyPins(
  content,
  displayFile,
  firstPartyOwner = DEFAULT_FIRST_PARTY_OWNER
) {
  const byTarget = new Map();
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const bareRef = parseUsesLine(lines[i]);
    if (bareRef === null) continue;
    const cls = classifyUses(bareRef, firstPartyOwner);
    if (cls.kind !== "first-party") continue;
    if (!cls.subpath) continue; // bare owner/repo self-ref has no subpath to key on
    const target = `${cls.owner}/${cls.subpath}`;
    const occ = { file: displayFile, line: i + 1, ref: cls.ref, target };
    const existing = byTarget.get(target);
    if (existing) existing.push(occ);
    else byTarget.set(target, [occ]);
  }
  return byTarget;
}

/**
 * The single-pin invariant (Story #203). Given a list of `{ file, content }`
 * records (the repo's workflow files), find every first-party `uses:` target
 * that is pinned to MORE THAN ONE distinct SHA across the set. Returns an
 * array of violations, one per drifting target:
 *
 *   { target, shas: [...distinct refs], occurrences: [{ file, line, ref }] }
 *
 * A target pinned consistently (or referenced only once) yields no violation.
 *
 * @param {Array<{file: string, content: string}>} files
 * @param {string} [firstPartyOwner]
 * @returns {Array<{target: string, shas: string[], occurrences: Array<{file: string, line: number, ref: string}>}>}
 */
export function findSinglePinViolations(files, firstPartyOwner = DEFAULT_FIRST_PARTY_OWNER) {
  // Merge every file's per-target occurrences into one index.
  const merged = new Map();
  for (const { file, content } of files) {
    const perFile = collectFirstPartyPins(content, file, firstPartyOwner);
    for (const [target, occs] of perFile) {
      const existing = merged.get(target);
      if (existing) existing.push(...occs);
      else merged.set(target, [...occs]);
    }
  }

  const violations = [];
  for (const [target, occs] of merged) {
    const distinct = [...new Set(occs.map((o) => o.ref))];
    if (distinct.length > 1) {
      violations.push({
        target,
        shas: distinct,
        occurrences: occs.map((o) => ({ file: o.file, line: o.line, ref: o.ref })),
      });
    }
  }
  return violations;
}
