/**
 * Dependency-free path scope checks for permission requests with a path.
 * Patterns are relative to the turn's working directory and intentionally
 * support only the small glob language documented by the companion: `**`,
 * `*`, and `?`.
 */
import path from "node:path";
import { canonicalizePath } from "./paths.mjs";

function splitSegments(value) {
  return String(value).replaceAll("\\", "/").split("/").filter(Boolean);
}

function matchesSegment(value, pattern) {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(value);
}

/**
 * Match a cwd-relative path against a documented write-scope glob.
 * `**` is meaningful as a whole path segment and matches zero or more
 * segments, so `app/**` includes the `app` directory itself.
 * @param {string} relativePath
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesPathGlob(relativePath, pattern) {
  const pathSegments = splitSegments(relativePath);
  const patternSegments = splitSegments(pattern);
  if (patternSegments.length === 0) return pathSegments.length === 0;

  const visit = (pathIndex, patternIndex) => {
    if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
    const segment = patternSegments[patternIndex];
    if (segment === "**") {
      if (patternIndex === patternSegments.length - 1) return true;
      for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
        if (visit(nextPathIndex, patternIndex + 1)) return true;
      }
      return false;
    }
    return pathIndex < pathSegments.length && matchesSegment(pathSegments[pathIndex], segment) && visit(pathIndex + 1, patternIndex + 1);
  };

  return visit(0, 0);
}

/** @param {string[]} patterns */
function formatPatterns(patterns) {
  return patterns.length > 0 ? patterns.join(", ") : "all paths inside the working directory except denied paths";
}

const PATH_INPUT_FIELDS = ["file_path", "notebook_path", "path"];

function getPathInput(input) {
  if (!input || typeof input !== "object") return null;
  const field = PATH_INPUT_FIELDS.find((name) => Object.hasOwn(input, name));
  return field ? { field, value: input[field] } : null;
}

function matchesScopeGlob(relativePath, pattern) {
  // APFS/HFS+ volumes are commonly case-insensitive. realpathSync preserves
  // the spelling supplied by the caller, so it cannot make a case-sensitive
  // glob comparison safe for aliases of the same on-disk path.
  if (process.platform === "darwin") {
    return matchesPathGlob(relativePath.toLowerCase(), pattern.toLowerCase());
  }
  return matchesPathGlob(relativePath, pattern);
}

/**
 * Create a runTurn-compatible permission policy. It checks every permission
 * request with a known path input and allows requests without one (including
 * Bash): command text cannot be safely parsed for writes.
 * @param {{ cwd: string, allow?: string[], deny?: string[], onDenied?: (details: { toolCallId: unknown, path: string, reason: string }) => void }} options
 */
export function createWriteScopePolicy({ cwd, allow = [], deny = [], onDenied = () => {} }) {
  const canonicalCwd = canonicalizePath(cwd);
  const allowedPatterns = allow.map((value) => String(value).trim()).filter(Boolean);
  const deniedPatterns = deny.map((value) => String(value).trim()).filter(Boolean);

  return {
    type: "write-scope",
    cwd: canonicalCwd,
    allow: allowedPatterns,
    deny: deniedPatterns,
    decide(params) {
      const reject = (displayPath, detail, rejectedPath = null) => {
        const reason =
          `Path ${displayPath} was denied: ${detail}. Allowed: ${formatPatterns(allowedPatterns)}. ` +
          "Do not try to write this path again; change only files inside the allowed scope.";
        onDenied({ toolCallId: params?.toolCallId, path: rejectedPath, reason });
        return { decision: "deny", reason };
      };
      const pathInput = getPathInput(params?.input);
      if (!pathInput) {
        // Preserve the fail-closed behavior for malformed legacy writer
        // requests while allowing non-path tools such as Bash.
        if (params?.toolName === "Write" || params?.toolName === "Edit") {
          return reject("(missing file_path)", "the Write/Edit request did not provide a usable file_path");
        }
        return { decision: "allow", reason: "Approved by zcode-companion write scope (no path input)." };
      }

      const filePath = pathInput.value;

      if (typeof filePath !== "string" || !filePath.trim()) {
        return reject(`(missing ${pathInput.field})`, `the request did not provide a usable ${pathInput.field}`);
      }

      const targetPath = canonicalizePath(path.resolve(canonicalCwd, filePath));
      const relativePath = path.relative(canonicalCwd, targetPath);
      if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return reject(targetPath, "it is outside the working directory", targetPath);
      }

      const displayPath = relativePath.replaceAll(path.sep, "/");
      if (deniedPatterns.some((pattern) => matchesScopeGlob(displayPath, pattern))) {
        return reject(displayPath, "it matches a denied pattern", targetPath);
      }
      if (allowedPatterns.length > 0 && !allowedPatterns.some((pattern) => matchesScopeGlob(displayPath, pattern))) {
        return reject(displayPath, "it is outside the allowed scope", targetPath);
      }
      return { decision: "allow", reason: "Approved by zcode-companion write scope." };
    },
  };
}
