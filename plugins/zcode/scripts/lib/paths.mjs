/**
 * Shared path helpers for the zcode plugin. Kept dependency-free (only
 * `node:fs`/`node:path`) so both `lib/diff.mjs` and `zcode-companion.mjs`
 * can import them without creating a cycle — `diff.mjs` must not import
 * from `zcode-companion.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve a path's symlinks by walking up to the nearest existing ancestor
 * and rebuilding the missing tail from there. `fs.realpathSync` only
 * resolves when the *final* file exists — a file the model wrote then
 * deleted, or one not created yet, would keep its raw (possibly symlink-
 * prefixed) form while git displays the canonical one, so the same file
 * lands in BOTH parts of the changes summary. Canonicalizing via the
 * nearest existing parent gives deleted/uncreated files the same canonical
 * shape as existing ones.
 *
 * Falls back to a manual `/var`→`/private/var`, `/tmp`→`/private/tmp`
 * rewrite when realpathSync fails entirely (defensive: no existing ancestor
 * could be resolved, or a symlink/existence race threw). The direction is
 * intentionally OPPOSITE to the old `/private/...`→`/...` rewrite: on macOS
 * `/var` and `/tmp` are symlinks to `/private/var` and `/private/tmp`, and
 * `fs.realpathSync` on success returns the `/private/...` form — so the
 * fallback must produce the SAME `/private/...` form to stay consistent with
 * the successful branch. This is macOS-only: on other platforms `/var` and
 * `/tmp` are not symlinks to `/private/...`, so no rewrite is applied at all
 * and the path is returned verbatim. The bare stems `/var` and `/tmp`
 * (without a trailing path segment) are handled too.
 * @param {string} p
 * @returns {string}
 */
export function canonicalizePath(p) {
  let abs = path.resolve(p);
  try {
    if (fs.existsSync(abs)) {
      return fs.realpathSync(abs);
    }
    let cur = abs;
    const tail = [];
    while (cur && cur !== path.dirname(cur)) {
      tail.unshift(path.basename(cur));
      cur = path.dirname(cur);
      if (fs.existsSync(cur)) {
        return path.join(fs.realpathSync(cur), ...tail);
      }
    }
  } catch {
    // realpathSync/existsSync race or permission error — fall through to the
    // manual prefix rewrite below rather than returning a raw path.
  }
  if (process.platform === "darwin") {
    // Match the `/private/...` form that fs.realpathSync yields on success.
    if (abs === "/var") return "/private/var";
    if (abs.startsWith("/var/")) return `/private/var/${abs.slice("/var/".length)}`;
    if (abs === "/tmp") return "/private/tmp";
    if (abs.startsWith("/tmp/")) return `/private/tmp/${abs.slice("/tmp/".length)}`;
  }
  return abs;
}

/**
 * Format an absolute or home-relative path relative to `cwd`, shortening
 * paths outside `cwd` that are under the user's home directory to `~/...`.
 * @param {string} targetPath
 * @param {string} [cwd]
 * @param {string} [homedir]
 * @returns {string}
 */
export function formatDisplayPath(targetPath, cwd = process.cwd(), homedir = os.homedir()) {
  if (typeof targetPath !== "string" || !targetPath.trim()) return targetPath;
  const raw = targetPath.trim();

  // Only expand bare `~` and `~/...` — NOT `~user/...` (which `path.join`
  // would garble by treating `user` as a literal path segment under homedir).
  const expanded = raw === "~" ? homedir : raw.startsWith("~/") ? path.join(homedir, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) {
    return raw;
  }

  const resolvedTarget = canonicalizePath(expanded);
  const resolvedCwd = canonicalizePath(cwd);
  const resolvedHome = homedir ? canonicalizePath(homedir) : "";

  const relToCwd = path.relative(resolvedCwd, resolvedTarget);
  if (relToCwd === "") return ".";
  if (!relToCwd.startsWith("..") && !path.isAbsolute(relToCwd)) {
    return relToCwd;
  }

  if (resolvedHome) {
    const relToHome = path.relative(resolvedHome, resolvedTarget);
    if (relToHome === "") return "~";
    if (!relToHome.startsWith("..") && !path.isAbsolute(relToHome)) {
      return `~/${relToHome}`;
    }
  }

  return raw;
}
