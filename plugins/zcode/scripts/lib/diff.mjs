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
 * @returns {{ status: number | null, stdout: string, stderr: string, error?: NodeJS.ErrnoException }}
 */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
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
