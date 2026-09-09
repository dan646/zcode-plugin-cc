/**
 * Git diff collection for the `review` subcommand.
 *
 * Talks to `git` directly via `child_process` (no dependency on any
 * `codex-companion.mjs` helper — that plugin is a read-only reference, not a
 * shared library). Every failure mode here must produce a message a human
 * can act on immediately: "not a git repo" and "nothing to review" are the
 * two the unit-4 spec calls out explicitly, so both get their own check
 * rather than falling through to a generic git error.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Default timeout for a single `git` invocation via `spawnSync`, in milliseconds. */
const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/**
 * Known ZCode service directories whose files are hook/runtime artifacts, not
 * model-written output. Filtered from the changes summary so they never mask
 * the changes that actually matter. Add new directories here as ZCode
 * introduces them.
 */
export const ZCODE_SERVICE_DIRS = [".mimosa"];

/**
 * @typedef {{
 *   repoRoot: string,
 *   branch: string,
 *   label: string,
 *   diff: string,
 *   stat: string,
 *   untracked: string[],
 *   target: string | null,
 * }} ReviewDiff
 */

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ status: number | null, stdout: string, stderr: string, error?: Error, signal?: NodeJS.Signals }}
 */
function git(cwd, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  let error = result.error;
  if (result.signal) {
    // spawnSync killed the process (timeout, signal) — fabricate an Error
    // so callers that check result.error see a consistent failure shape.
    error = error ?? new Error(`git ${args.join(" ")} killed by signal ${result.signal} after ${timeoutMs}ms`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error,
    signal: result.signal,
  };
}

/**
 * Whether a repo-relative path lives under a known ZCode service directory
 * (e.g. `.mimosa/hook-state/...`) and should be excluded from the changes
 * summary.
 * @param {string} relPath
 * @returns {boolean}
 */
function isZcodeServicePath(relPath) {
  for (const dir of ZCODE_SERVICE_DIRS) {
    if (relPath === dir || relPath.startsWith(dir + "/") || relPath.startsWith(dir + path.sep)) {
      return true;
    }
  }
  return false;
}

function splitLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string} cwd
 * @returns {string} absolute repo root
 * @throws {Error} if `cwd` is not inside a git repository, or git itself is missing
 */
function ensureGitRepo(cwd) {
  if (!fs.existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error && /** @type {any} */ (result.error).code === "ENOENT") {
    throw new Error("git is not installed (or not on PATH). Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error(
      `"${cwd}" is not inside a git repository (git rev-parse --show-toplevel failed: ` +
        `${result.stderr.trim() || "unknown error"}).`,
    );
  }
  return result.stdout.trim();
}

/**
 * Whether `ref` names an existing commit (branch, tag, or commit hash) in
 * this repo. Used to decide whether an explicit review target is a git ref
 * or a filesystem path — see `resolveReviewTarget`'s doc comment for the
 * disambiguation rule.
 * @param {string} repoRoot
 * @param {string} ref
 * @returns {boolean}
 */
function isCommitRef(repoRoot, ref) {
  const result = git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.status === 0;
}

/**
 * Resolve an explicit `review <target>` argument to either a git ref (branch
 * or commit) or a repo-relative path.
 *
 * A ref check runs first: if `target` names a real commit, it is treated as
 * a ref even when a same-named file or directory also exists (git itself
 * resolves this the same way — `--` is the escape hatch to force "path" on
 * the rare name collision, mirrored here as `git diff -- <path>` internally
 * once a path is chosen).
 * @param {string} repoRoot
 * @param {string} cwd where a relative `target` path is resolved against
 * @param {string} target
 * @returns {{ kind: "ref", ref: string } | { kind: "path", relPath: string }}
 * @throws {Error} if `target` is neither a known ref nor an existing path
 */
function resolveReviewTarget(repoRoot, cwd, target) {
  if (isCommitRef(repoRoot, target)) {
    return { kind: "ref", ref: target };
  }

  const absTargetPath = path.resolve(cwd, target);
  if (fs.existsSync(absTargetPath)) {
    // `repoRoot` comes back from `git rev-parse --show-toplevel` already
    // symlink-resolved (e.g. macOS's `/var` -> `/private/var`); `cwd` as
    // handed in by a caller is not guaranteed to be. Without realpath-ing
    // the target too, a same-location comparison can textually diverge into
    // a long bogus `../../..` chain purely from the symlink prefix mismatch.
    const realTargetPath = fs.realpathSync(absTargetPath);
    const relPath = path.relative(repoRoot, realTargetPath) || ".";
    if (relPath === ".." || relPath.startsWith(`..${path.sep}`)) {
      // `git diff -- <relPath>` for a pathspec outside the repo exits
      // non-zero with empty stdout, which buildReviewDiff's caller would
      // otherwise misreport as "no changes" instead of the real problem.
      throw new Error(`"${target}" resolves to ${realTargetPath}, which is outside the repository at ${repoRoot}.`);
    }
    return { kind: "path", relPath };
  }

  throw new Error(
    `"${target}" is neither a known git ref (branch/commit) nor an existing path ` +
      `under ${cwd}. Pass a branch name, commit-ish, or a real file/directory path.`,
  );
}

/**
 * Build the diff ZCode should review.
 *
 * Three modes, chosen by `target`:
 *   - no target: working tree vs `HEAD` (staged + unstaged), the spec's
 *     default;
 *   - `target` is a git ref: `HEAD` vs that ref's merge-base, i.e. "what this
 *     branch/commit introduced relative to where it diverged";
 *   - `target` is an existing path: working tree vs `HEAD`, scoped to that
 *     path with `git diff -- <path>`.
 *
 * Throws a clear, specific error (never returns an empty result) when `cwd`
 * is not a git repository, or when the resolved diff is empty — see the
 * unit-4 spec: "если репозиторий не git или диффа нет — внятная ошибка, а не
 * пустой прогон".
 * @param {string} cwd absolute working directory
 * @param {string | null} [target]
 * @returns {ReviewDiff}
 */
export function buildReviewDiff(cwd, target = null) {
  const repoRoot = ensureGitRepo(cwd);
  const branch = git(repoRoot, ["branch", "--show-current"]).stdout.trim() || "HEAD (detached)";

  let label;
  let diff;
  let stat;
  let untracked = [];

  if (!target) {
    label = "working tree vs HEAD";
    diff = git(repoRoot, ["diff", "HEAD", "--no-ext-diff"]).stdout;
    stat = git(repoRoot, ["diff", "--stat", "HEAD"]).stdout.trim();
    untracked = splitLines(git(repoRoot, ["ls-files", "--others", "--exclude-standard"]).stdout);
  } else {
    const resolved = resolveReviewTarget(repoRoot, cwd, target);

    if (resolved.kind === "ref") {
      const mergeBaseResult = git(repoRoot, ["merge-base", resolved.ref, "HEAD"]);
      const mergeBase = mergeBaseResult.status === 0 ? mergeBaseResult.stdout.trim() : resolved.ref;
      label =
        mergeBase === resolved.ref
          ? `${resolved.ref}..HEAD`
          : `${resolved.ref}..HEAD (merge-base ${mergeBase})`;
      diff = git(repoRoot, ["diff", `${mergeBase}..HEAD`, "--no-ext-diff"]).stdout;
      stat = git(repoRoot, ["diff", "--stat", `${mergeBase}..HEAD`]).stdout.trim();
    } else {
      label = `working tree vs HEAD, scoped to ${resolved.relPath}`;
      diff = git(repoRoot, ["diff", "HEAD", "--no-ext-diff", "--", resolved.relPath]).stdout;
      stat = git(repoRoot, ["diff", "--stat", "HEAD", "--", resolved.relPath]).stdout.trim();
      // A brand-new file passed as an explicit target has no tracked diff
      // (git diff never compares against an untracked file) — surface that
      // it exists rather than reporting it as "no changes".
      untracked = splitLines(
        git(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", resolved.relPath]).stdout,
      );
    }
  }

  if (!diff.trim() && untracked.length === 0) {
    throw new Error(`No changes to review (${label}). Nothing differs from HEAD.`);
  }

  return { repoRoot, branch, label, diff, stat, untracked, target: target ?? null };
}

/**
 * Compute sha256 hash of a file on disk, or null if file doesn't exist / is a directory / cannot be read.
 * @param {string} absPath
 * @returns {string | null}
 */
export function hashFile(absPath) {
  try {
    if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) return null;
    return createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Capture a snapshot of git repository status and file hashes before a turn.
 * @param {string} cwd
 * @returns {{ isGit: boolean, repoRoot?: string, files?: Map<string, { status: string, hash: string | null }>, headCommit?: string | null }}
 */
export function captureGitSnapshot(cwd) {
  if (!fs.existsSync(cwd)) {
    return { isGit: false };
  }
  const check = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (check.status !== 0 || !check.stdout.trim()) {
    return { isGit: false };
  }
  const repoRoot = check.stdout.trim();
  const statusRes = git(repoRoot, ["status", "--porcelain=v1", "-z", "-uall"]);
  const files = new Map();

  if (statusRes.status === 0 && statusRes.stdout) {
    // `-z` makes git NUL-terminate each entry and emit paths verbatim
    // (no octal-escape quoting), so Cyrillic and other non-ASCII filenames
    // arrive raw. For renames/copies (R/C in either status position) the
    // -z format appends a second NUL-terminated path: the SOURCE path,
    // i.e. `XY newpath\0oldpath\0` — so both the old and new path must be
    // recorded so diffGitSnapshots can report the rename as a delete+create.
    const parts = statusRes.stdout.split("\0");
    let i = 0;
    while (i < parts.length) {
      const entry = parts[i];
      if (!entry) {
        i++;
        continue;
      }
      const status = entry.slice(0, 2);
      const firstPath = entry.slice(3); // after "XY "
      if (!firstPath) {
        i++;
        continue;
      }

      const isRename = status.includes("R") || status.includes("C");
      if (isRename && i + 1 < parts.length && parts[i + 1]) {
        // Rename: firstPath is the destination (new) path, parts[i+1] is source (old).
        files.set(firstPath, { status, hash: hashFile(path.resolve(repoRoot, firstPath)) });
        files.set(parts[i + 1], { status, hash: null });
        i += 2;
      } else {
        files.set(firstPath, { status, hash: hashFile(path.resolve(repoRoot, firstPath)) });
        i += 1;
      }
    }
  }

  const headRes = git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  const headCommit = headRes.status === 0 ? headRes.stdout.trim() : null;

  return { isGit: true, repoRoot, files, headCommit };
}

/**
 * Compare before snapshot with current git state to find what actually changed during the turn.
 * @param {ReturnType<typeof captureGitSnapshot>} before
 * @param {string} cwd
 * @returns {{ isGit: boolean, changes: Array<{ path: string, kind: "created" | "modified" | "deleted" }> }}
 */
export function diffGitSnapshots(before, cwd) {
  if (!before || !before.isGit) {
    return { isGit: false, changes: [] };
  }

  const after = captureGitSnapshot(cwd);
  if (!after.isGit) {
    return { isGit: false, changes: [] };
  }

  const repoRoot = after.repoRoot;
  const changes = [];
  const allRelPaths = new Set([...(before.files?.keys() ?? []), ...(after.files?.keys() ?? [])]);
  const committedChanges = new Map();

  if (before.headCommit && after.headCommit && before.headCommit !== after.headCommit) {
    // Use -M (rename detection) and -z (NUL-separated, raw paths) so that:
    //  - committed renames show as `Rxxx\0old\0new\0` instead of two
    //    separate D/A lines, letting us record both the old and new path;
    //  - non-ASCII paths (Cyrillic, etc.) arrive raw, not octal-escaped.
    const commitDiff = git(repoRoot, ["diff", "-M", "--name-status", "-z", `${before.headCommit}..${after.headCommit}`]);
    if (commitDiff.status === 0 && commitDiff.stdout) {
      const parts = commitDiff.stdout.split("\0");
      let i = 0;
      while (i < parts.length) {
        const statusCode = parts[i];
        if (!statusCode) {
          i++;
          continue;
        }
        const isRename = statusCode.startsWith("R") || statusCode.startsWith("C");
        if (isRename && i + 2 < parts.length && parts[i + 1] && parts[i + 2]) {
          // -z rename entry: status\0old\0new — old path is the source.
          const oldPath = parts[i + 1];
          const newPath = parts[i + 2];
          committedChanges.set(oldPath, "D");
          committedChanges.set(newPath, "A");
          allRelPaths.add(oldPath);
          allRelPaths.add(newPath);
          i += 3;
        } else if (i + 1 < parts.length) {
          const relPath = parts[i + 1];
          if (relPath) {
            committedChanges.set(relPath, statusCode);
            allRelPaths.add(relPath);
          }
          i += 2;
        } else {
          i++;
        }
      }
    }
  }

  for (const relPath of allRelPaths) {
    if (isZcodeServicePath(relPath)) continue;

    const b = before.files?.get(relPath);
    const a = after.files?.get(relPath);
    const absPath = path.resolve(repoRoot, relPath);
    let existsNow = false;
    try {
      existsNow = fs.existsSync(absPath) && !fs.statSync(absPath).isDirectory();
    } catch {
      // Race or permission error between existsSync and statSync — treat as
      // non-existent rather than crashing the summary.
      existsNow = false;
    }
    const currentHash = hashFile(absPath);

    let displayPath = relPath;
    if (cwd) {
      const resolvedCwd = path.resolve(cwd);
      let realCwd = resolvedCwd;
      let realAbs = absPath;
      try {
        if (fs.existsSync(resolvedCwd)) realCwd = fs.realpathSync(resolvedCwd);
        if (fs.existsSync(absPath)) realAbs = fs.realpathSync(absPath);
      } catch {}
      const relToCwd = path.relative(realCwd, realAbs);
      if (!relToCwd.startsWith("..") && !path.isAbsolute(relToCwd)) {
        displayPath = relToCwd || ".";
      }
    }

    if (!b && a) {
      if (!existsNow || a.status.includes("D")) {
        changes.push({ path: displayPath, kind: "deleted" });
      } else if (a.status === "??" || a.status.includes("A") || a.status.includes("R") || a.status.includes("C")) {
        changes.push({ path: displayPath, kind: "created" });
      } else {
        changes.push({ path: displayPath, kind: "modified" });
      }
    } else if (b && a) {
      if (b.hash !== currentHash) {
        if (!existsNow) {
          changes.push({ path: displayPath, kind: "deleted" });
        } else if (b.hash === null) {
          changes.push({ path: displayPath, kind: "created" });
        } else {
          changes.push({ path: displayPath, kind: "modified" });
        }
      }
    } else if (b && !a) {
      const cStatus = committedChanges.get(relPath);
      if (cStatus && cStatus.startsWith("D")) {
        changes.push({ path: displayPath, kind: "deleted" });
      } else if (!existsNow) {
        changes.push({ path: displayPath, kind: "deleted" });
      } else if (b.status === "??" && cStatus && cStatus.startsWith("A")) {
        changes.push({ path: displayPath, kind: "created" });
      } else if (b.hash !== currentHash) {
        changes.push({ path: displayPath, kind: "modified" });
      }
    } else if (!b && !a && committedChanges.has(relPath)) {
      const cStatus = committedChanges.get(relPath);
      if (cStatus && (cStatus.startsWith("D") || !existsNow)) {
        changes.push({ path: displayPath, kind: "deleted" });
      } else if (cStatus && cStatus.startsWith("A")) {
        changes.push({ path: displayPath, kind: "created" });
      } else {
        changes.push({ path: displayPath, kind: "modified" });
      }
    }
  }

  changes.sort((x, y) => x.path.localeCompare(y.path));
  return { isGit: true, changes };
}

/**
 * Render the human-readable summary of changed files for stderr.
 * @param {{ isGit: boolean, changes?: Array<{ path: string, kind: "created" | "modified" | "deleted" }> }} diffResult
 * @returns {string}
 */
export function renderChangesSummary(diffResult) {
  if (!diffResult) return "";
  if (!diffResult.isGit) {
    return "[zcode] сводка изменений недоступна вне git-репозитория\n";
  }
  if (!diffResult.changes || diffResult.changes.length === 0) {
    return "[zcode] изменённые файлы: (нет изменений)\n";
  }
  const lines = ["[zcode] изменённые файлы:"];
  const labels = {
    created: "создан",
    modified: "изменён",
    deleted: "удалён",
  };
  for (const item of diffResult.changes) {
    const label = labels[item.kind] ?? item.kind;
    lines.push(`[zcode]   ${item.path} (${label})`);
  }
  return lines.join("\n") + "\n";
}

