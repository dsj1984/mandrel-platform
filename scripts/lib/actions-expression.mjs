/**
 * actions-expression.mjs — a minimal GitHub Actions expression evaluator.
 *
 * Extracted from check-toolchain-cache-default.test.mjs (Story #364) when a
 * second guard needed it (Story #421). It exists because **a `grep` is not an
 * acceptance criterion for a workflow expression**: string-matching pins the
 * spelling, not the behaviour, and both expression defects this repo has
 * shipped read correctly and evaluated wrong. Extract the real expression from
 * the YAML and RUN it.
 *
 * Supported surface — only what the guarded expressions use: string literals,
 * `inputs.<name>` / `inputs['<name>']` reads, `==`/`!=`, `&&`/`||`,
 * parentheses, and `contains()`, `startsWith()`, `format()`, `fromJSON()`.
 *
 * The semantics that matter, and that a hand-read gets wrong:
 *
 *   - `a && b` yields `b` when `a` is truthy, else `a`.
 *   - `a || b` yields `a` when `a` is truthy, else `b`.
 *     Both yield OPERANDS, not booleans.
 *   - EVERY non-empty string is truthy — including the string `'false'`.
 *   - Arrays and objects are truthy. GitHub documents the falsy set as exactly
 *     `false`, `0`, `-0`, `''`, `null`; an array is not in it.
 *   - String comparison is case-insensitive.
 *
 * ## On short-circuiting
 *
 * This evaluator parses to an AST first and evaluates `&&`/`||` lazily, which
 * is the standard semantic. GitHub does NOT document whether its own evaluator
 * short-circuits, so a guarded expression **must not depend on it** — never
 * place a throwing call (`fromJSON` on caller-controlled text) in a branch that
 * is only conditionally reached. Wrap the conditional instead:
 *
 *     fromJSON(cond && '<json>' || '<json>')     ← safe under either semantic
 *     cond && fromJSON(x) || x                   ← safe ONLY if lazy
 *
 * Evaluating lazily here while requiring the safe shape in the workflows means
 * the guard cannot bless an expression whose correctness rests on an
 * unverified assumption about GitHub's evaluator.
 *
 * Errors are thrown as plain `Error`s; nothing here depends on a test framework.
 */

/** Actions truthiness — NOT JavaScript's. */
export function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  return v !== null && v !== undefined;
}

/** Actions comparison: case-insensitive for strings. */
export function looseEqual(a, b) {
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function fail(message) {
  throw new Error(`[actions-expression] ${message}`);
}

const FUNCTIONS = new Map([
  ["contains", 2],
  ["startsWith", 2],
  ["endsWith", 2],
  ["fromJSON", 1],
]);

/** Parse `expr` into an AST. Exported for tests that assert on shape. */
export function parse(expr) {
  let i = 0;

  const ws = () => {
    while (i < expr.length && /\s/.test(expr[i])) i++;
  };
  const eat = (token) => {
    ws();
    if (expr.startsWith(token, i)) {
      i += token.length;
      return true;
    }
    return false;
  };

  function parseOr() {
    let left = parseAnd();
    for (;;) {
      ws();
      if (!eat("||")) return left;
      left = { kind: "or", left, right: parseAnd() };
    }
  }

  function parseAnd() {
    let left = parseCompare();
    for (;;) {
      ws();
      if (!eat("&&")) return left;
      left = { kind: "and", left, right: parseCompare() };
    }
  }

  function parseCompare() {
    const left = parsePrimary();
    ws();
    if (eat("!=")) return { kind: "ne", left, right: parsePrimary() };
    if (eat("==")) return { kind: "eq", left, right: parsePrimary() };
    return left;
  }

  function parsePrimary() {
    ws();
    if (eat("(")) {
      const node = parseOr();
      ws();
      if (!eat(")")) fail(`unbalanced parenthesis at ${i} in: ${expr}`);
      return node;
    }
    if (expr[i] === "'") {
      i++;
      let out = "";
      while (i < expr.length) {
        if (expr[i] === "'" && expr[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        if (expr[i] === "'") {
          i++;
          return { kind: "literal", value: out };
        }
        out += expr[i++];
      }
      fail(`unterminated string literal in: ${expr}`);
    }
    for (const [name, arity] of FUNCTIONS) {
      if (!expr.startsWith(`${name}(`, i)) continue;
      i += `${name}(`.length;
      const args = [parseOr()];
      while (args.length < arity) {
        ws();
        if (!eat(",")) fail(`${name}() expects ${arity} arguments in: ${expr}`);
        args.push(parseOr());
      }
      ws();
      if (!eat(")")) fail(`unclosed ${name}() in: ${expr}`);
      return { kind: "call", name, args };
    }
    // `format()` is variadic, so it is parsed separately from the fixed-arity table.
    if (expr.startsWith("format(", i)) {
      i += "format(".length;
      const args = [parseOr()];
      for (;;) {
        ws();
        if (!eat(",")) break;
        args.push(parseOr());
      }
      ws();
      if (!eat(")")) fail(`unclosed format() in: ${expr}`);
      return { kind: "call", name: "format", args };
    }
    const ident = expr.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.\-]*(\['[^']*'\])?/);
    if (!ident) fail(`unparseable token at ${i} in: ${expr}`);
    i += ident[0].length;
    const raw = ident[0];
    if (raw === "true") return { kind: "literal", value: true };
    if (raw === "false") return { kind: "literal", value: false };
    const bracket = raw.match(/^inputs\['([^']*)'\]$/);
    const dotted = raw.match(/^inputs\.(.+)$/);
    const key = bracket ? bracket[1] : dotted ? dotted[1] : null;
    if (key === null) fail(`unsupported context read \`${raw}\` in: ${expr}`);
    return { kind: "input", key };
  }

  const ast = parseOr();
  ws();
  if (i !== expr.length) fail(`trailing tokens at ${i} in: ${expr}`);
  return ast;
}

function applyFormat(args) {
  const template = String(args[0]);
  const rest = args.slice(1);
  let out = "";
  for (let k = 0; k < template.length; k++) {
    const ch = template[k];
    if (ch === "{" && template[k + 1] === "{") {
      out += "{";
      k++;
    } else if (ch === "}" && template[k + 1] === "}") {
      out += "}";
      k++;
    } else if (ch === "{") {
      const close = template.indexOf("}", k);
      if (close === -1) fail(`unclosed format placeholder in: ${template}`);
      const idx = Number(template.slice(k + 1, close));
      if (!Number.isInteger(idx)) fail(`non-numeric format placeholder in: ${template}`);
      out += rest[idx] === undefined ? "" : String(rest[idx]);
      k = close;
    } else {
      out += ch;
    }
  }
  return out;
}

function evalNode(node, inputs) {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "input":
      if (!(node.key in inputs)) {
        fail(`expression reads \`inputs.${node.key}\`, not provided by the caller`);
      }
      return inputs[node.key];
    case "and": {
      // Lazy on purpose — see the module header's note on short-circuiting.
      const left = evalNode(node.left, inputs);
      return truthy(left) ? evalNode(node.right, inputs) : left;
    }
    case "or": {
      const left = evalNode(node.left, inputs);
      return truthy(left) ? left : evalNode(node.right, inputs);
    }
    case "eq":
      return looseEqual(evalNode(node.left, inputs), evalNode(node.right, inputs));
    case "ne":
      return !looseEqual(evalNode(node.left, inputs), evalNode(node.right, inputs));
    case "call": {
      const args = node.args.map((a) => evalNode(a, inputs));
      if (node.name === "format") return applyFormat(args);
      const [a, b] = args;
      if (node.name === "contains") {
        // Substring on a string haystack; exact-item match on an array one.
        if (Array.isArray(a)) return a.some((item) => looseEqual(item, b));
        return String(a).toLowerCase().includes(String(b).toLowerCase());
      }
      if (node.name === "startsWith") {
        return String(a).toLowerCase().startsWith(String(b).toLowerCase());
      }
      if (node.name === "endsWith") {
        return String(a).toLowerCase().endsWith(String(b).toLowerCase());
      }
      if (node.name === "fromJSON") {
        try {
          return JSON.parse(String(a));
        } catch {
          // A parse failure is a HARD expression error in Actions — the run
          // fails rather than yielding null, which is what makes a malformed
          // `runner` value loud instead of silently unmatchable.
          fail(`fromJSON() could not parse ${JSON.stringify(String(a))} in this expression`);
        }
      }
      return fail(`unsupported function \`${node.name}\``);
    }
    default:
      return fail(`unsupported node kind \`${node.kind}\``);
  }
}

/**
 * Evaluate `expr` (the body BETWEEN `${{` and `}}`) against `inputs`.
 *
 * @param {string} expr
 * @param {Record<string, unknown>} inputs values for `inputs.*` reads
 * @returns {unknown} the resulting operand — a string, boolean, or array
 */
export function evaluate(expr, inputs) {
  return evalNode(parse(expr), inputs);
}
