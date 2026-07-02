/**
 * commitlint.base.mjs — shared commitlint config for mandrel-platform
 * consumers.
 *
 * Single-sources the conventional-commit type-enum from
 * `.agents/rules/git-conventions.md` (§ Conventional Commits) so the eleven
 * allowed types live in exactly one place instead of being hand-copied into
 * each consumer's own `commitlint.config.js`. Keep this list, the
 * git-conventions.md prose list, and `release-please-config.json`'s
 * `changelog-sections` in sync when adding a type — all three must agree.
 *
 * Extends `@commitlint/config-conventional` for everything else (header
 * casing/length, body/footer leading-blank-line, etc.) and narrows
 * `type-enum` to the fleet's eleven types.
 */

const TYPE_ENUM = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "docs",
  "style",
  "chore",
  "test",
  "build",
  "ci",
];

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", TYPE_ENUM],
  },
};
