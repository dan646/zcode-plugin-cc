/**
 * Prompt template loading + interpolation for the companion CLI.
 *
 * Kept as a tiny, separate module (mirrors `codex-companion.mjs`'s
 * `lib/prompts.mjs`) so the actual prompt text lives in `prompts/*.md` and
 * can be edited without touching any code.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Read `<rootDir>/prompts/<name>.md`.
 * @param {string} rootDir plugin root (the directory that contains `prompts/`)
 * @param {string} name template name, without extension
 * @returns {string}
 */
export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

/**
 * Substitute `{{UPPER_SNAKE_CASE}}` placeholders with values from
 * `variables`. A placeholder with no matching key is replaced with the
 * empty string rather than left in place — a silently-unreplaced
 * `{{PLACEHOLDER}}` reaching ZCode would be far more confusing than a blank.
 * @param {string} template
 * @param {Record<string, string>} variables
 * @returns {string}
 */
export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}
