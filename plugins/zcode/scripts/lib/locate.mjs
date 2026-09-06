/**
 * Locates the ZCode CLI and derives workspace references for the ZCode Protocol.
 *
 * The CLI ships inside ZCode.app as a bundled `zcode.cjs` script run with `node`.
 * That path moves whenever the app updates or is reinstalled, so callers must
 * never hardcode it — always go through `resolveZcodeCli()`.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Default install location of the bundled CLI inside ZCode.app. */
const DEFAULT_APP_CLI_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

/** Extensions that must be run through `node` rather than executed directly. */
const NODE_SCRIPT_EXTENSIONS = new Set([".cjs", ".mjs", ".js"]);

/**
 * @typedef {{ command: string, args: string[] }} ResolvedCli
 */

/**
 * Turn a filesystem path to the CLI into a spawnable `{command, args}` pair.
 * A `.cjs`/`.mjs`/`.js` file is run via `node <path>`; anything else (a native
 * binary, e.g. one found on PATH) is treated as directly executable.
 * @param {string} cliPath
 * @returns {ResolvedCli}
 */
function toSpawnTarget(cliPath) {
  const ext = path.extname(cliPath);
  if (NODE_SCRIPT_EXTENSIONS.has(ext)) {
    return { command: process.execPath, args: [cliPath] };
  }
  return { command: cliPath, args: [] };
}

/**
 * `fs.existsSync` returns `true` for a directory just as readily as for a
 * file — so `ZCODE_CLI=/Applications/ZCode.app` (the app bundle itself, not
 * the script inside it) would pass a bare `existsSync` check and then be
 * handed straight to `spawn()`, which fails (you cannot exec a directory) in
 * exactly the way docs/zcode-protocol-recon.md's "CLI внутри `.app`" warning
 * describes. Require an actual file.
 * @param {string} candidate
 * @returns {boolean}
 */
function isExistingFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Search `PATH` for an executable named `binName`, the way a shell would.
 * Pure stdlib — no `which`/`where` subprocess, so it works the same on every
 * platform this Node build targets. Verifies the candidate is actually
 * executable (not just present) on POSIX, where a non-executable file with
 * the right name must not be picked over one further down `PATH`.
 * @param {string} binName
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null} absolute path to the executable, or null
 */
function findOnPath(binName, env) {
  const pathEnv = env.PATH ?? env.Path ?? "";
  if (!pathEnv) return null;

  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const isWindows = process.platform === "win32";
  const exts = isWindows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      // `path.resolve`, not `path.join`: a PATH entry may itself be
      // relative (e.g. "./node_modules/.bin", or a bare "bin"), and `join`
      // would preserve that, handing callers a relative `command` string. A
      // relative command is resolved against whatever `cwd` the process is
      // eventually spawned with (see `ZCodeProtocolClient.start()`'s
      // `options.cwd`) — which is not guaranteed to be this process's cwd —
      // so it could silently look up the wrong file, or nothing at all.
      // `resolve` fixes the path to an absolute one now, against this
      // process's own cwd, exactly like a shell resolves a relative PATH
      // entry at lookup time.
      const candidate = path.resolve(dir, binName + ext);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        // PATHEXT-matched files are treated as executable on Windows; POSIX
        // has no such convention, so check the execute bit explicitly there.
        if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not found here, or found but not executable — keep searching
      }
    }
  }
  return null;
}

/**
 * Resolve the ZCode CLI to spawn, in priority order:
 *   1. `ZCODE_CLI` env var (explicit override — path to `zcode`/`zcode.cjs`)
 *   2. the bundled CLI inside ZCode.app
 *   3. `zcode` on PATH
 *
 * @param {{ env?: NodeJS.ProcessEnv, appCliPath?: string }} [options] `appCliPath`
 *   overrides the bundled-app path this checks (mainly for tests) — production
 *   callers should never need it.
 * @returns {ResolvedCli}
 * @throws {Error} with install/setup instructions if nothing is found
 */
export function resolveZcodeCli(options = {}) {
  const env = options.env ?? process.env;
  const appCliPath = options.appCliPath ?? DEFAULT_APP_CLI_PATH;
  const tried = [];

  const override = env.ZCODE_CLI;
  if (override) {
    // Resolve against this process's own cwd now, for the same reason
    // `findOnPath` resolves each PATH entry eagerly: a relative path handed
    // straight to `spawn()` later would be resolved against whatever `cwd`
    // the transport happens to be spawned with (see
    // `ZCodeProtocolClient.start()`'s `options.cwd`), which is not
    // guaranteed to match this process's cwd, and could silently pick up the
    // wrong file or nothing at all.
    const resolvedOverride = path.resolve(override);
    tried.push(`$ZCODE_CLI (${resolvedOverride})`);
    if (isExistingFile(resolvedOverride)) {
      return toSpawnTarget(resolvedOverride);
    }
  }

  const resolvedAppCliPath = path.resolve(appCliPath);
  tried.push(`bundled ZCode.app CLI (${resolvedAppCliPath})`);
  if (isExistingFile(resolvedAppCliPath)) {
    return toSpawnTarget(resolvedAppCliPath);
  }

  tried.push('"zcode" on PATH');
  const onPath = findOnPath("zcode", env);
  if (onPath) {
    // Return the resolved absolute path, not the bare "zcode" name: the
    // resolver's PATH (from `options.env`) and the transport's spawn
    // environment are not guaranteed to be the same, so re-resolving by bare
    // name at spawn time could hit a different PATH, a different binary, or
    // ENOENT outright.
    return toSpawnTarget(onPath);
  }

  throw new Error(
    "Could not locate the ZCode CLI. Looked for:\n" +
      tried.map((t) => `  - ${t}`).join("\n") +
      "\n\nFix one of:\n" +
      "  - Install ZCode.app (https://z.ai) so the bundled CLI exists at the path above.\n" +
      "  - Install the `zcode` CLI and make sure it is on PATH.\n" +
      '  - Set ZCODE_CLI to the absolute path of the "zcode" executable or "zcode.cjs" script.',
  );
}

/**
 * @typedef {{ workspacePath: string, workspaceKey: string }} WorkspaceRef
 */

/**
 * Build the `{workspacePath, workspaceKey}` reference the ZCode Protocol expects
 * wherever a `workspace` param is required. `workspaceKey` is the first 12 hex
 * characters of the SHA-256 of the absolute workspace path — verified against
 * ZCode's own `~/.zcode/v2/sessions/` directory naming.
 * @param {string} absPath absolute path to the workspace root
 * @returns {WorkspaceRef}
 */
export function workspaceRef(absPath) {
  if (!path.isAbsolute(absPath)) {
    throw new Error(`workspaceRef() requires an absolute path, got: ${absPath}`);
  }
  const workspaceKey = createHash("sha256").update(absPath).digest("hex").slice(0, 12);
  return { workspacePath: absPath, workspaceKey };
}
