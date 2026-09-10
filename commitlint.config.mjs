/**
 * commitlint.config.mjs — this repository's own commitlint configuration.
 *
 * `config/commitlint.base.mjs` single-sources the fleet's conventional-commit
 * type-enum, but it is published for **consumers** (it is declared in
 * package.json `exports`); nothing made this repository apply it to its own
 * commits. Re-exporting it here is what makes the platform obey the contract it
 * ships, and keeps the type list in exactly one place — see Story #513.
 */

export { default } from "./config/commitlint.base.mjs";
