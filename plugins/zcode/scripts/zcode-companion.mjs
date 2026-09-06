#!/usr/bin/env node
/**
 * Single entry point for all `zcode` plugin slash commands — mirrors the
 * organization of `openai/codex-plugin-cc`'s `codex-companion.mjs` (one
 * script, one subcommand dispatch, small `lib/` helpers), without copying
 * any of its content: this plugin has no job control, no background tasks,
 * and no broker process, because `runTurn()` (see `lib/session.mjs`) is a
 * single synchronous call per turn and ZCode itself owns its own process
 * lifecycle.
 *
 * Subcommands: `setup`, `code <task>`, `review [target]`, `status`.
 *
 * Everything that talks to ZCode goes through `lib/session.mjs`
 * (`runTurn`, `readWorkspaceState`, `isProviderConfigured`) and
 * `lib/locate.mjs` (`resolveZcodeCli`, `workspaceRef`) — never directly at
 * `lib/protocol.mjs`. Both of those modules, plus `lib/session.mjs` itself,
 * are out of scope for this unit and are only ever imported, never edited.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { buildReviewDiff } from "./lib/diff.mjs";
import { resolveZcodeCli, workspaceRef } from "./lib/locate.mjs";
import { runTurn, readWorkspaceState, isProviderConfigured } from "./lib/session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Plugin root — the directory that contains `prompts/` (see `lib/prompts.mjs`). */
const ROOT_DIR = path.dirname(__dirname);

/** Provider id every model shorthand resolves against — see `parseModelFlag`. */
const DEFAULT_PROVIDER_ID = "zai";

// Per-session model overrides applied when the caller does not pass
// `--model` (see `parseModelFlag` / `resolveModel`). A bare `--model`-less
// call to `runTurn()` would otherwise leave the choice entirely to whatever
// ZCode's own config currently points at; these two constants are a
// deliberate per-command override on top of that default, tuned for the
// shape of each command's typical workload — `code` runs often and mostly
// on straightforward changes (favor the cheap/fast model), `review` runs
// less often and its whole value is judgment quality (favor the strongest
// model). A user's own `--model` always wins over both.
//
// Caveat from docs/zcode-protocol-recon.md ("Модели: каталог врёт, эндпоинт
// — нет"): a fresh `zcode login` registers only `glm-5.1`/`glm-4.7` on the
// `zai` provider, not the `glm-5.3` family below (that set was only
// confirmed working via the desktop app's provider config). If
// `session/setModel` rejects one of these defaults with an unknown-model
// error, pass `--model <id>` explicitly with whatever `/zcode:status` shows
// as actually available.
const DEFAULT_CODE_MODEL = { providerId: DEFAULT_PROVIDER_ID, modelId: "glm-5.3-flash" };
const DEFAULT_REVIEW_MODEL = { providerId: DEFAULT_PROVIDER_ID, modelId: "glm-5.3" };

// Per-command default turn timeout, in seconds (converted to ms before
// reaching `runTurn`). `lib/session.mjs`'s own `DEFAULT_TURN_TIMEOUT_MS`
// (180s) is a library default sized for a single request/response — it is
// NOT sized for what `code`/`review` actually do, which is multi-round-trip,
// tool-using work. A live `/zcode:review` run against one modest file in
// this repo took six separate model round-trips inside a single turn, so
// 180s is tight on an ordinary diff, not just a pathological one. `code`
// gets an even higher default since it does at least as much tool-calling.
// A user's own `--timeout` always overrides these.
const DEFAULT_CODE_TIMEOUT_SECONDS = 900;
const DEFAULT_REVIEW_TIMEOUT_SECONDS = 600;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** Exit code used specifically for a `turn.failed` result (see `lib/session.mjs`'s `runTurn`). */
export const EXIT_TURN_FAILED = 2;

const USAGE_TEXT = `Usage: zcode-companion <command> [options]

Commands:
  setup                     Check whether the ZCode CLI is ready (provider configured)
  code <task description>   Delegate a coding task to ZCode
  review [target]           Send a diff to ZCode for review (default: working tree vs HEAD)
  status                    Show what is known about the ZCode CLI, provider, and model

Common options:
  --model <id>              Per-session model override (e.g. glm-5.3-flash, or zai/glm-5.3-flash)
  --cwd <path>              Working directory (default: current directory)
  --json                    Machine-readable output (setup, status)
  --timeout <seconds>       Turn timeout in seconds (code/review only; defaults: code=${DEFAULT_CODE_TIMEOUT_SECONDS}, review=${DEFAULT_REVIEW_TIMEOUT_SECONDS})
`;

/** Thrown for bad CLI usage (missing/invalid arguments) — always maps to {@link EXIT_ERROR}. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * `$ARGUMENTS` from a slash command markdown arrives either already
 * shell-split (unquoted `$ARGUMENTS`, one argv entry per word) or as one
 * opaque blob (quoted `"$ARGUMENTS"`). A single leftover token after the
 * subcommand is indistinguishable from "the whole blob" — so it is always
 * re-tokenized in that case; a real single-word argument re-tokenizes to
 * itself and is unaffected.
 * @param {string[]} argv
 * @returns {string[]}
 */
function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}

/** @param {string[]} argv @param {import("./lib/args.mjs").ParseArgsConfig} [config] */
function parseCompanionArgs(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { m: "model", C: "cwd", ...(config.aliasMap ?? {}) },
  });
}

/** @param {{ cwd?: string }} options */
function resolveCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

/**
 * Parse a `--model` value into `{providerId, modelId}`. Accepts either a
 * bare model id (`glm-5.3-flash`, assumed on {@link DEFAULT_PROVIDER_ID}) or
 * an explicit `providerId/modelId` pair, since `session/setModel` requires
 * both (see docs/zcode-protocol-recon.md's "Выбирать модель можно и на
 * сессию").
 * @param {string | boolean | undefined} raw
 * @returns {{ providerId: string, modelId: string } | null}
 */
export function parseModelFlag(raw) {
  if (raw === undefined || raw === true || raw === false) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) {
    return { providerId: DEFAULT_PROVIDER_ID, modelId: trimmed };
  }
  return { providerId: trimmed.slice(0, slashIndex), modelId: trimmed.slice(slashIndex + 1) };
}

/**
 * Parse a `--timeout <seconds>` value into milliseconds for `runTurn`'s
 * `timeoutMs`. Seconds is the human-facing unit (matches how people reason
 * about "how long am I willing to wait"); `runTurn` itself only knows
 * milliseconds, so the conversion happens here, once, at the CLI boundary.
 * @param {string | boolean | undefined} raw
 * @returns {number | null} `null` when `--timeout` was not passed at all —
 *   callers fall back to their own per-command default in that case.
 * @throws {UsageError} for anything that is not a finite positive number.
 */
export function parseTimeoutFlag(raw) {
  if (raw === undefined) return null;
  if (raw === true || raw === false) {
    throw new UsageError(`--timeout requires a numeric value in seconds, got: ${raw}`);
  }
  const trimmed = String(raw).trim();
  const seconds = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`--timeout must be a positive number of seconds, got: ${JSON.stringify(raw)}`);
  }
  return Math.round(seconds * 1000);
}

/** @param {any} usage `turn.completed.payload.usage` or `session/usage`'s result — see lib/session.mjs */
function formatUsage(usage) {
  if (!usage) return "n/a";
  const parts = [];
  if (typeof usage.inputTokens === "number") parts.push(`in=${usage.inputTokens}`);
  if (typeof usage.outputTokens === "number") parts.push(`out=${usage.outputTokens}`);
  if (typeof usage.totalTokens === "number") parts.push(`total=${usage.totalTokens}`);
  if (typeof usage.modelRequestCount === "number") parts.push(`requests=${usage.modelRequestCount}`);
  if (typeof usage.modelErrorCount === "number") parts.push(`errors=${usage.modelErrorCount}`);
  return parts.length > 0 ? parts.join(", ") : JSON.stringify(usage);
}

/**
 * Render the footer printed after a `code`/`review` turn: both usage
 * metrics, kept explicitly separate (never merged) per
 * docs/zcode-protocol-recon.md's "Две разные метрики расхода — не путать".
 * @param {import("./lib/session.mjs").RunTurnResult} result
 */
function renderTurnFooter(result) {
  return (
    `[zcode] resultType=${result.resultType} sessionId=${result.sessionId}\n` +
    `[zcode] turn usage:    ${formatUsage(result.usage)}\n` +
    `[zcode] session usage: ${formatUsage(result.sessionUsage)}\n`
  );
}

/** Matches the generic timeout `Error` thrown by `lib/session.mjs`'s `runTurn` (see its message format). */
function isRunTurnTimeout(err) {
  return err instanceof Error && /ZCode turn timed out after \d+ms/.test(err.message);
}

/**
 * Turn `runTurn`'s generic timeout error into something a user can act on:
 * how long the companion actually waited (in the human unit, seconds — the
 * raw error only states milliseconds) plus the exact flag to raise it with.
 * `lib/session.mjs` itself has no opinion on `--timeout`, since that flag is
 * a companion-level concept layered on top of its `timeoutMs` parameter —
 * this is why the enhancement happens here, not there.
 * @param {Error} err
 * @param {number} timeoutMs the value this call actually passed to `runTurn`
 * @returns {Error}
 */
function toActionableTimeoutError(err, timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  const suggestedSeconds = seconds * 2;
  const enhanced = new Error(
    `${err.message} Waited ${seconds}s before giving up. If this keeps happening on real work, ` +
      `raise the limit with --timeout <seconds> (e.g. --timeout ${suggestedSeconds}).`,
  );
  enhanced.cause = err;
  return enhanced;
}

/**
 * Progress forwarder for `runTurn`'s `onProgress` — streams model text as it
 * arrives and announces state transitions, both to stderr so stdout stays
 * exactly the final response (pipeable, per the unit-4 spec).
 * @param {(text: string) => void} write
 */
function makeOnProgress(write) {
  return (event) => {
    if (event.type === "model.streaming" && typeof event.delta === "string" && event.delta) {
      write(event.delta);
    } else if (event.type === "state.updated" && event.reason) {
      write(`\n[zcode] ${event.reason}\n`);
    }
  };
}

export function buildCodePrompt({ task, cwd }) {
  const template = loadPromptTemplate(ROOT_DIR, "code");
  return interpolateTemplate(template, { TASK: task, CWD: cwd });
}

export function buildReviewPrompt({ diffInfo, cwd }) {
  const template = loadPromptTemplate(ROOT_DIR, "review");
  const diffBody =
    diffInfo.diff.trim() ||
    (diffInfo.untracked.length > 0
      ? `(no tracked diff; new untracked file(s): ${diffInfo.untracked.join(", ")})`
      : "(empty)");
  return interpolateTemplate(template, {
    CWD: cwd,
    BRANCH: diffInfo.branch,
    TARGET_LABEL: diffInfo.label,
    STAT: diffInfo.stat || "(no stat)",
    DIFF: diffBody,
  });
}

/**
 * Resolve which dependencies a handler actually uses, defaulting to the
 * real implementations. Every handler takes `deps` so tests can substitute
 * `runTurn`/`readWorkspaceState`/`resolveZcodeCli`/`buildReviewDiff`
 * without ever spawning a real ZCode process or touching the network — see
 * the unit-4 spec: "для проверок, которым нужен runTurn, подменяй его".
 * @param {Record<string, any>} deps
 */
function resolveDeps(deps) {
  return {
    resolveZcodeCli: deps.resolveZcodeCli ?? resolveZcodeCli,
    readWorkspaceState: deps.readWorkspaceState ?? readWorkspaceState,
    runTurn: deps.runTurn ?? runTurn,
    buildReviewDiff: deps.buildReviewDiff ?? buildReviewDiff,
  };
}

/**
 * Shared diagnostic probe behind both `setup` and `status`: resolve the
 * CLI, then check `workspace/readState` for a configured provider. Never
 * throws — every failure mode is captured on the returned object so callers
 * can decide how to react (`setup` turns it into exit-code + instructions,
 * `status` just displays it).
 * @param {string} cwd
 * @param {{ resolveZcodeCli: typeof resolveZcodeCli, readWorkspaceState: typeof readWorkspaceState }} deps
 */
async function probeReadiness(cwd, deps) {
  /** @type {any} */
  const report = {
    cwd,
    cli: null,
    cliError: null,
    ready: false,
    providerId: null,
    modelId: null,
    availableModels: null,
    stateError: null,
  };

  let cli;
  try {
    cli = deps.resolveZcodeCli();
    report.cli = { command: cli.command, args: cli.args };
  } catch (err) {
    report.cliError = err.message;
    return report;
  }

  try {
    const state = await deps.readWorkspaceState({ cli, workspace: workspaceRef(cwd) });
    report.ready = isProviderConfigured(state);
    // Verified against a real, logged-in `app-server`: the current model
    // lives at `settings.model.current`, NOT a top-level `model.current` —
    // docs/zcode-protocol-recon.md's "Блокер и его решение" snippet only
    // shows the unconfigured/blocked shape (`zcode-unconfigured`) with the
    // `settings.` prefix elided for brevity, which reads as if `model` were
    // top-level. It is not, once a provider is actually configured.
    const current = state?.settings?.model?.current;
    report.providerId = current?.providerId ?? null;
    report.modelId = current?.modelId ?? null;
    // Each `modelCatalog.available[]` entry nests its id under `.ref`
    // (`{ref: {providerId, modelId}, label, ...}`), not a flat `modelId` —
    // also only confirmed by querying a live, configured server.
    const available = state?.modelCatalog?.available;
    if (Array.isArray(available) && available.length > 0) {
      report.availableModels = available
        .map((entry) => entry?.ref?.modelId ?? entry?.label ?? null)
        .filter((id) => id !== null);
    }
  } catch (err) {
    report.stateError = err.message;
  }

  return report;
}

function buildLoginInstructions(report) {
  if (report.cliError) {
    // resolveZcodeCli()'s own error already spells out install/PATH/env fixes.
    return report.cliError;
  }
  if (report.stateError) {
    return `Could not read ZCode workspace state: ${report.stateError}`;
  }
  return (
    "ZCode CLI has no model provider configured. Run `zcode login` once " +
    "(or `node <path-to-zcode.cjs> login`) to authorize it, then retry — " +
    "this plugin never configures providers or touches credentials itself."
  );
}

function renderSetupReport(payload) {
  const lines = [
    `ZCode CLI: ${payload.cli ? `${payload.cli.command} ${payload.cli.args.join(" ")}`.trim() : "not found"}`,
    `Provider configured: ${payload.ready ? "yes" : "no"}`,
  ];
  if (payload.ready) {
    lines.push(`Current model: ${payload.providerId}/${payload.modelId}`);
  }
  if (payload.instructions) {
    lines.push("", payload.instructions);
  }
  return lines.join("\n") + "\n";
}

function renderStatusReport(report) {
  const lines = [
    `cwd: ${report.cwd}`,
    `CLI: ${report.cli ? `${report.cli.command} ${report.cli.args.join(" ")}`.trim() : `not found (${report.cliError})`}`,
  ];
  if (report.cli) {
    lines.push(`Provider configured: ${report.ready ? "yes" : "no"}`);
    if (report.ready) {
      lines.push(`Current model: ${report.providerId}/${report.modelId}`);
    } else if (report.stateError) {
      lines.push(`Could not read workspace state: ${report.stateError}`);
    } else {
      lines.push("Run `zcode login` to configure a provider (see /zcode:setup).");
    }
    if (report.availableModels) {
      lines.push(`Models in catalog: ${report.availableModels.join(", ")}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * @param {string[]} argv
 * @param {Record<string, any>} deps
 * @param {(text: string) => void} log stdout sink
 * @param {(text: string) => void} logError stderr sink
 * @returns {Promise<number>}
 */
async function handleSetup(argv, deps, log) {
  const { resolveZcodeCli: resolveCli, readWorkspaceState: readState } = resolveDeps(deps);
  const { options } = parseCompanionArgs(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCwd(options);

  const report = await probeReadiness(cwd, { resolveZcodeCli: resolveCli, readWorkspaceState: readState });
  const instructions = report.ready ? null : buildLoginInstructions(report);
  const payload = { ...report, instructions };

  log(options.json ? JSON.stringify(payload, null, 2) + "\n" : renderSetupReport(payload));
  return payload.ready ? EXIT_OK : EXIT_ERROR;
}

async function handleStatus(argv, deps, log) {
  const { resolveZcodeCli: resolveCli, readWorkspaceState: readState } = resolveDeps(deps);
  const { options } = parseCompanionArgs(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCwd(options);

  const report = await probeReadiness(cwd, { resolveZcodeCli: resolveCli, readWorkspaceState: readState });
  log(options.json ? JSON.stringify(report, null, 2) + "\n" : renderStatusReport(report));
  // status is a pure diagnostic snapshot, not a readiness gate — it always
  // succeeds as long as it could run at all; `setup`'s exit code is the one
  // scripts should branch on.
  return EXIT_OK;
}

async function handleCode(argv, deps, log, logError) {
  const { resolveZcodeCli: resolveCli, runTurn: runTurnFn } = resolveDeps(deps);
  const { options, positionals } = parseCompanionArgs(argv, {
    valueOptions: ["cwd", "model", "timeout"],
    booleanOptions: [],
  });

  const task = positionals.join(" ").trim();
  if (!task) {
    throw new UsageError(
      "Usage: zcode-companion code <task description> [--model <id>] [--cwd <path>] [--timeout <seconds>]",
    );
  }

  const cwd = resolveCwd(options);
  const model = parseModelFlag(options.model) ?? DEFAULT_CODE_MODEL;
  const timeoutMs = parseTimeoutFlag(options.timeout) ?? DEFAULT_CODE_TIMEOUT_SECONDS * 1000;
  const cli = resolveCli();
  const prompt = buildCodePrompt({ task, cwd });

  let result;
  try {
    result = await runTurnFn({
      cli,
      workspace: workspaceRef(cwd),
      prompt,
      model,
      timeoutMs,
      onProgress: makeOnProgress(logError),
    });
  } catch (err) {
    throw isRunTurnTimeout(err) ? toActionableTimeoutError(err, timeoutMs) : err;
  }

  log((typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2)) + "\n");
  logError(renderTurnFooter(result));
  return EXIT_OK;
}

async function handleReview(argv, deps, log, logError) {
  const { resolveZcodeCli: resolveCli, runTurn: runTurnFn, buildReviewDiff: buildDiff } = resolveDeps(deps);
  const { options, positionals } = parseCompanionArgs(argv, {
    valueOptions: ["cwd", "model", "timeout"],
    booleanOptions: [],
  });

  const target = positionals.join(" ").trim() || null;
  const cwd = resolveCwd(options);
  // Throws a clear error for "not a git repo" / "nothing to review" —
  // never returns an empty diff (see lib/diff.mjs's buildReviewDiff).
  const diffInfo = buildDiff(cwd, target);

  const model = parseModelFlag(options.model) ?? DEFAULT_REVIEW_MODEL;
  const timeoutMs = parseTimeoutFlag(options.timeout) ?? DEFAULT_REVIEW_TIMEOUT_SECONDS * 1000;
  const cli = resolveCli();
  const prompt = buildReviewPrompt({ diffInfo, cwd });

  let result;
  try {
    result = await runTurnFn({
      cli,
      workspace: workspaceRef(cwd),
      prompt,
      model,
      timeoutMs,
      onProgress: makeOnProgress(logError),
    });
  } catch (err) {
    throw isRunTurnTimeout(err) ? toActionableTimeoutError(err, timeoutMs) : err;
  }

  log((typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2)) + "\n");
  logError(renderTurnFooter(result));
  return EXIT_OK;
}

/**
 * Run the companion CLI end to end and return an exit code — never touches
 * `process.exitCode` itself, so tests can call this directly and assert on
 * the return value (see tests/companion.test.mjs).
 * @param {string[]} argv `process.argv.slice(2)`-shaped
 * @param {{
 *   resolveZcodeCli?: typeof resolveZcodeCli,
 *   readWorkspaceState?: typeof readWorkspaceState,
 *   runTurn?: typeof runTurn,
 *   buildReviewDiff?: typeof buildReviewDiff,
 *   log?: (text: string) => void,
 *   logError?: (text: string) => void,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runCli(argv, deps = {}) {
  const log = deps.log ?? ((text) => process.stdout.write(text));
  const logError = deps.logError ?? ((text) => process.stderr.write(text));
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    log(USAGE_TEXT);
    return EXIT_OK;
  }

  try {
    switch (subcommand) {
      case "setup":
        return await handleSetup(rest, deps, log, logError);
      case "status":
        return await handleStatus(rest, deps, log, logError);
      case "code":
        return await handleCode(rest, deps, log, logError);
      case "review":
        return await handleReview(rest, deps, log, logError);
      default:
        logError(`Unknown subcommand: ${subcommand}\n`);
        log(USAGE_TEXT);
        return EXIT_ERROR;
    }
  } catch (err) {
    // A turn.failed error carries this marker (see lib/session.mjs's
    // runTurn) — surface code/message/retryable explicitly per the unit-4
    // spec, on its own exit code so callers can distinguish "ZCode ran and
    // failed" from "the companion itself errored out".
    if (err && err.zcodeTurnError) {
      logError(`ZCode turn failed: ${err.message}\n`);
      logError(`  code: ${JSON.stringify(err.code ?? null)}\n`);
      logError(`  retryable: ${Boolean(err.retryable)}\n`);
      if (err.sessionUsage) {
        logError(`  sessionUsage: ${JSON.stringify(err.sessionUsage)}\n`);
      }
      return EXIT_TURN_FAILED;
    }
    logError(`${err?.message ?? String(err)}\n`);
    return EXIT_ERROR;
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
