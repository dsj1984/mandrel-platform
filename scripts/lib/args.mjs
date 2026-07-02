/**
 * scripts/lib/args.mjs
 *
 * The single argv-parsing seam shared by the pin-tooling CLIs
 * (`check-action-pins.mjs`, `check-workflow-portability.mjs`, …). Each of
 * those scripts had grown its own hand-rolled `parseArgs` — one throwing on
 * an unknown flag, one silently ignoring it, and both re-implementing the
 * same "take the next argv slot as this flag's value" dance. They had already
 * drifted (different alias support, different unknown-flag policy), which is
 * exactly the duplication Story #203 consolidates.
 *
 * `parseFlags(argv, spec)` is a tiny, dependency-free flag reader driven by a
 * declarative spec. It intentionally does NOT try to be a full getopt: it
 * supports the two shapes the pin tooling actually uses —
 *
 *   • `string` flags   — `--workflows-dir <value>` (optionally with aliases,
 *                        e.g. `-w`), consuming the next argv slot as the value.
 *   • `boolean` flags  — `--no-pin-check`, `--help` (present ⇒ the configured
 *                        boolean value, default the inverse).
 *
 * The unknown-flag policy is a per-call knob (`onUnknown`) so a strict lint
 * (fail loudly on a typo'd flag) and a lenient CLI (ignore stray args) can
 * share one parser without either losing its behavior.
 *
 * This module reads no environment and performs no I/O, so the sibling
 * `args.test.mjs` suite exercises it entirely offline.
 */

/**
 * @typedef {Object} FlagSpec
 * @property {"string" | "boolean"} type  How to consume the flag.
 * @property {string} dest               The result key to write.
 * @property {*} [default]               Default value when the flag is absent.
 * @property {boolean} [value]           For a boolean flag, the value to set
 *                                       when the flag IS present (default true).
 */

/**
 * Parse an argv slice (the array AFTER `node script.mjs`) into an options
 * object driven by `spec`.
 *
 * @param {string[]} argv
 * @param {Object} spec
 * @param {Record<string, FlagSpec>} spec.flags  Map of canonical flag token
 *   (e.g. `"--workflows-dir"`) to its {@link FlagSpec}.
 * @param {Record<string, string>} [spec.aliases]  Map of alias token
 *   (e.g. `"-w"`) to a canonical flag token present in `spec.flags`.
 * @param {"throw" | "ignore"} [spec.onUnknown]  What to do with an argument
 *   that is not a known flag or alias. `"throw"` (default) fails loudly;
 *   `"ignore"` skips it.
 * @returns {Record<string, *>} The resolved options, seeded from each flag's
 *   `default`.
 */
export function parseFlags(argv, spec) {
  const flags = spec?.flags ?? {};
  const aliases = spec?.aliases ?? {};
  const onUnknown = spec?.onUnknown ?? "throw";

  // Seed the result with every flag's declared default.
  const opts = {};
  for (const def of Object.values(flags)) {
    opts[def.dest] = "default" in def ? def.default : undefined;
  }

  const canonical = (arg) => {
    if (Object.prototype.hasOwnProperty.call(flags, arg)) return arg;
    if (Object.prototype.hasOwnProperty.call(aliases, arg)) return aliases[arg];
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const key = canonical(arg);
    if (key === null) {
      if (onUnknown === "ignore") continue;
      throw new Error(`unknown argument "${arg}"`);
    }
    const def = flags[key];
    if (def.type === "boolean") {
      opts[def.dest] = "value" in def ? def.value : true;
      continue;
    }
    // string flag: consume the next argv slot as the value.
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for "${arg}"`);
    }
    opts[def.dest] = next;
    i++;
  }

  return opts;
}
