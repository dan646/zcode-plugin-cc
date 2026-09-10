/**
 * Minimal argv parser and shell-style tokenizer for the companion CLI.
 *
 * Deliberately dependency-free (see the unit-4 spec's "Ноль внешних
 * зависимостей" requirement) and deliberately small: this plugin only ever
 * needs a handful of `--flag <value>` / `--flag` options plus free-text
 * positionals, never subcommand trees or type coercion.
 */

/**
 * @typedef {{
 *   valueOptions?: string[],
 *   repeatableValueOptions?: string[],
 *   booleanOptions?: string[],
 *   aliasMap?: Record<string, string>,
 * }} ParseArgsConfig
 * @typedef {{ options: Record<string, string | string[] | boolean>, positionals: string[] }} ParsedArgs
 */

/**
 * Parse an argv array into `{options, positionals}`.
 *
 * Supports `--key value`, `--key=value`, `--key` (boolean), short `-k`
 * aliases via `aliasMap`, and a `--` separator after which every remaining
 * token is treated as a positional (even if it looks like a flag) — the
 * standard POSIX escape hatch, needed here so a task/review-target string
 * that happens to start with `-` can still be passed through explicitly.
 * @param {string[]} argv
 * @param {ParseArgsConfig} [config]
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const repeatableValueOptions = new Set(config.repeatableValueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      // NOT `body.split("=", 2)`: JS's `split(sep, limit)` truncates the
      // *fully split* array to `limit` entries rather than stopping after
      // `limit - 1` splits, so `"cwd=/a/b=c".split("=", 2)` silently drops
      // everything from the second "=" onward instead of keeping it in the
      // value. Splitting on the first "=" by index avoids that.
      const body = token.slice(2);
      const eqIndex = body.indexOf("=");
      const rawKey = eqIndex === -1 ? body : body.slice(0, eqIndex);
      const inlineValue = eqIndex === -1 ? undefined : body.slice(eqIndex + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key) || repeatableValueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        if (repeatableValueOptions.has(key)) {
          const previous = options[key];
          options[key] = [...(Array.isArray(previous) ? previous : []), nextValue];
        } else {
          options[key] = nextValue;
        }
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      // Unknown flag: keep it verbatim as a positional rather than dropping
      // it silently — a task/review-target string may legitimately contain
      // a `--something` token that is not one of this command's options.
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key) || repeatableValueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      if (repeatableValueOptions.has(key)) {
        const previous = options[key];
        options[key] = [...(Array.isArray(previous) ? previous : []), nextValue];
      } else {
        options[key] = nextValue;
      }
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

/**
 * Tokenize a single shell-style argument string (quotes and backslash
 * escapes honored, no globbing/variable expansion) into an argv array.
 *
 * Needed because Claude Code's slash commands hand `$ARGUMENTS` through as
 * one opaque string when the command markdown quotes it (`"$ARGUMENTS"`);
 * `parseArgs` alone cannot see the flags inside that blob without this step
 * first. See `zcode-companion.mjs`'s `normalizeArgv`, which decides whether
 * a call needs this at all.
 * @param {string} raw
 * @returns {string[]}
 */
export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
