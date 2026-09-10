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
 * Everything that *talks to ZCode* goes through `lib/session.mjs`
 * (`runTurn`, `readWorkspaceState`, `isProviderConfigured`) and
 * `lib/locate.mjs` (`resolveZcodeCli`, `workspaceRef`) — this file never
 * constructs a `ZCodeProtocolClient` or calls its methods directly. It does
 * import two pure, side-effect-free text-safety helpers straight from
 * `lib/protocol.mjs` (`redactSecrets`, `capDiagText`) for the headless
 * tool-call progress line below — reusing the transport's own
 * secret-redaction/length-cap approach instead of inventing a second one,
 * per the same reasoning as `explainProtocolError`'s use of them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  buildReviewDiff,
  captureGitSnapshot,
  createFileJournal,
  diffGitSnapshots,
  renderChangesSummary,
  renderJournaledChangesSummary,
} from "./lib/diff.mjs";
import { formatDisplayPath } from "./lib/paths.mjs";
import { resolveZcodeCli, workspaceRef } from "./lib/locate.mjs";
import { runTurn, readWorkspaceState, isProviderConfigured, formatDurationMs } from "./lib/session.mjs";
import { redactSecrets, capDiagText } from "./lib/protocol.mjs";

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
// 180s is tight on an ordinary diff, not just a pathological one.
//
// The two numbers below come from real usage rather than that recon alone:
// running ZCode headless against an actual project (a dockerized Laravel
// app) via this plugin, a single unit of work took 20-30 minutes end to
// end, with the first 10-15 minutes producing no visible output at all
// (the model "thinks" before anything streams back) before the rest arrives
// in a burst. The old 900s/600s defaults would have timed out roughly every
// other `code` run under that pattern, and sooner on a `review` of anything
// but a small diff. `DEFAULT_CODE_TIMEOUT_SECONDS` is set to 2700s (45min)
// — the upper end of the observed 20-30min range plus headroom for a slow
// start and a correction round or two — and `DEFAULT_REVIEW_TIMEOUT_SECONDS`
// to 1800s (30min), scaled down from that since a review is one pass over
// an existing diff rather than `code`'s open-ended implement-and-fix loop.
// A user's own `--timeout` always overrides these.
const DEFAULT_CODE_TIMEOUT_SECONDS = 2700;
const DEFAULT_REVIEW_TIMEOUT_SECONDS = 1800;

// Valid `--mode` values for `session/setMode`. Confirmed by grepping the
// bundled `zcode.cjs` for the literal zod enum `["build","edit","plan","yolo"]`
// that `sessionSetMode`'s params schema validates `mode` against — not
// documented anywhere, and not the same list as ZCode's *interactive CLI*
// `--mode`/`--surface` flags (see docs/zcode-protocol-recon.md's "Часть
// документированных флагов CLI не реализована"), which is a different
// surface entirely from the app-server protocol this plugin drives.
//
// IMPORTANT — this is ZCode's own agent-behavior mode, NOT this plugin's
// write permission: `code`/`review` already always pass `permissionPolicy:
// "allow"` to `runTurn` regardless of `--mode` (see their call sites below),
// so ZCode is always ALLOWED to write files. `--mode` instead tells ZCode's
// own agent loop how it should behave with that permission — e.g. "plan"
// makes it propose a plan without touching any files even though it *could*,
// "yolo" skips ZCode's own internal confirmations. Conflating the two is
// exactly the confusion this constant's users must be warned against — see
// the USAGE_TEXT entry, and commands/code.md / commands/review.md / README.md.
export const ZCODE_MODES = Object.freeze(["build", "edit", "plan", "yolo"]);

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
  --mode <${ZCODE_MODES.join("|")}>
                            ZCode's own operating mode for this turn (code/review only). This is
                            NOT this plugin's write permission — code/review already always pass
                            permissionPolicy: "allow" to runTurn, with or without --mode, so ZCode
                            CAN write files either way. --mode instead tells ZCode's own agent how
                            to behave once it has that permission: "plan" makes it propose a plan
                            without touching files, "edit" restricts it to editing existing files,
                            "yolo" skips its own internal confirmations, "build" is its default.
                            Defaults to whatever ZCode's own session default is when omitted.
  --quiet                   Suppress per-step progress and summary on stderr (state changes,
                            tool calls, streaming text); print only the final response/footer
                            (code/review only)
  --no-stream               Suppress only streaming model text on stderr; keep tool calls,
                            heartbeats, and changes summary intact (code/review only)
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
 * Parse a `--mode` value for `runTurn`'s `mode` (forwarded verbatim to
 * `session/setMode` — see lib/session.mjs). Validated against the four known
 * values (see {@link ZCODE_MODES}) with an error that spells out the
 * allowed list, since an unknown value would otherwise only surface as an
 * opaque `session/setMode` protocol rejection deep inside `runTurn`.
 *
 * This is deliberately validated here, at the CLI boundary, and not inside
 * `lib/session.mjs`: `mode`'s valid values are a ZCode-specific fact (reverse
 * engineered from the bundle, see {@link ZCODE_MODES}'s comment), not a
 * protocol-transport concern — the same division of labor `--model`/
 * `--timeout` already follow.
 * @param {string | boolean | undefined} raw
 * @returns {string | null} `null` when `--mode` was not passed at all —
 *   callers leave `runTurn`'s `mode` unset, so ZCode falls back to its own
 *   session default.
 * @throws {UsageError} for anything not in {@link ZCODE_MODES}.
 */
export function parseModeFlag(raw) {
  if (raw === undefined) return null;
  if (raw === true || raw === false || !String(raw).trim()) {
    throw new UsageError(`--mode requires a value — one of: ${ZCODE_MODES.join(", ")} (got: ${JSON.stringify(raw)}).`);
  }
  const trimmed = String(raw).trim();
  if (!ZCODE_MODES.includes(trimmed)) {
    throw new UsageError(
      `--mode must be one of: ${ZCODE_MODES.join(", ")} (got: ${JSON.stringify(raw)}). ` +
        'Note: --mode controls ZCode\'s own operating mode for this turn, not this plugin\'s write ' +
        'permission (code/review always allow writes regardless of --mode) — see --help.',
    );
  }
  return trimmed;
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

// Above this size, doubling `--timeout` stops being a sensible suggestion —
// e.g. the current 2700s (45min) `code` default doubling to 5400s (90min).
// Doubling is fine below it (a 5s test timeout becoming 10s is a reasonable
// ask); above it, `suggestNextTimeoutSeconds` switches to a flat +50% bump
// instead of blindly scaling the multiplier with an already-large number.
const TIMEOUT_DOUBLING_CEILING_SECONDS = 300; // 5 minutes

/**
 * Pick a concrete next `--timeout` value to suggest after a timeout, given
 * the seconds value that just timed out. Doubling reads fine for a small
 * timeout but turns absurd for a large one (45min -> 90min), so this scales
 * the increase down as the input grows rather than always doubling.
 * @param {number} seconds
 * @returns {number}
 */
function suggestNextTimeoutSeconds(seconds) {
  if (seconds <= TIMEOUT_DOUBLING_CEILING_SECONDS) {
    return seconds * 2;
  }
  return Math.round(seconds * 1.5);
}

/**
 * Turn `runTurn`'s generic timeout error into something a user can act on:
 * how long the companion actually waited (in the human unit, seconds — the
 * raw error only states milliseconds), naming that value explicitly, plus a
 * concrete increased value to try instead. `lib/session.mjs` itself has no
 * opinion on `--timeout`, since that flag is a companion-level concept
 * layered on top of its `timeoutMs` parameter — this is why the enhancement
 * happens here, not there.
 * @param {Error} err
 * @param {number} timeoutMs the value this call actually passed to `runTurn`
 * @returns {Error}
 */
function toActionableTimeoutError(err, timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  const suggestedSeconds = suggestNextTimeoutSeconds(seconds);
  const enhanced = new Error(
    `${err.message} Waited ${seconds}s (current --timeout) before giving up. If this keeps ` +
      `happening on real work, raise the limit — try --timeout ${suggestedSeconds}.`,
  );
  enhanced.cause = err;
  return enhanced;
}

// Fields to prefer, in order, as the one-line argument summary for a tool
// call's progress line — picked from what the live server's `tool_call`
// events actually carry for the tools most likely to show up in a `code`/
// `review` turn (Read/Write/Edit's `file_path`, Bash's `command`, Grep/Glob's
// `pattern`, WebFetch's `url`). Falls back to the whole `input` object
// (JSON-stringified) for any tool this list does not name, rather than
// showing nothing for it.
const PATH_FIELDS = ["file_path", "filePath", "file", "filename", "path", "notebook_path"];
const TOOL_CALL_ARG_FIELDS = [
  "file_path",
  "filePath",
  "file",
  "filename",
  "path",
  "notebook_path",
  "command",
  "pattern",
  "query",
  "url",
  "skill",
  "name",
];

/** Hard cap on a tool-call progress line's argument summary — a long file
 * path or shell command must not make one line dominate the whole stream. */
const MAX_TOOL_ARG_DISPLAY_LENGTH = 160;

/**
 * Build the one-line, human-scannable argument summary for a tool-call
 * progress event (see {@link TOOL_CALL_ARG_FIELDS}).
 * @param {unknown} input `event.input` from a `kind: "tool_call"` progress event
 * @param {string} [cwd]
 * @returns {string} possibly empty
 */
export function summarizeToolCallInput(input, cwd = process.cwd()) {
  if (!input) return "";
  let obj = input;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object") obj = parsed;
      else return input;
    } catch {
      return input;
    }
  }
  if (typeof obj !== "object") return String(obj);

  const knownField = TOOL_CALL_ARG_FIELDS.find((field) => typeof obj[field] === "string" && obj[field]);
  if (knownField) {
    const val = obj[knownField];
    if (PATH_FIELDS.includes(knownField)) {
      return formatDisplayPath(val, cwd);
    }
    return val;
  }
  return Object.keys(obj).length > 0 ? JSON.stringify(obj) : "";
}

/**
 * Render one stderr line for a tool-call progress event, or `null` if the
 * event is not a tool call. Length-capped and secret-redacted with the exact
 * same helpers `lib/protocol.mjs` itself uses for its own diagnostics
 * (`capDiagText`/`redactSecrets`) — capping BEFORE redaction, same order as
 * `explainProtocolError`, so a pathological argument can never reach the
 * regex at more than {@link MAX_TOOL_ARG_DISPLAY_LENGTH} characters.
 *
 * Confirmed against a live, logged-in app-server (see docs/zcode-protocol-recon.md-
 * style recon: driving a turn that calls Read/Bash/Edit and dumping every
 * `model.streaming` kind seen) that `kind: "tool_call"` is the one event that
 * carries both `toolName` and the fully-assembled `input` object in a single
 * message — see `lib/session.mjs`'s `toProgressEvent` for why the earlier
 * `tool_input_start`/`tool_input_delta`/`tool_input_end` stream is not used
 * instead.
 * @param {any} event a progress event from `runTurn`'s `onProgress`
 * @param {string} [cwd]
 * @returns {string | null}
 */
export function formatToolCallLine(event, cwd = process.cwd()) {
  if (!event || event.type !== "model.streaming" || event.kind !== "tool_call") return null;
  // When no tool-name key survived the chain in lib/session.mjs's
  // toProgressEvent (payload.toolName ?? payload.name ?? payload.tool),
  // emit a visible fallback line instead of silently dropping it — the
  // "exactly one line per tool call" guarantee means the missing name must
  // be observable, not invisible.
  const toolName = event.toolName || "(неизвестный инструмент)";
  const summary = redactSecrets(capDiagText(summarizeToolCallInput(event.input, cwd), MAX_TOOL_ARG_DISPLAY_LENGTH));
  return summary ? `[zcode] tool: ${toolName} ${summary}` : `[zcode] tool: ${toolName}`;
}

/**
 * Render a token count the way a human scans a status line — `210000` reads
 * as noise, `210k` reads instantly. Used only by `formatHeartbeatLine` below;
 * exact precision does not matter here (this is a liveness indicator, not an
 * accounting figure — `renderTurnFooter`'s `formatUsage` still prints the
 * precise numbers for that).
 * @param {number} n
 * @returns {string}
 */
function formatTokenCount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * Render one stderr line for a `heartbeat` progress event (see
 * `lib/session.mjs`'s `runTurn` / `createHeartbeatMonitor`) — the answer to
 * "is it working or hung" during the long silent stretch a real turn spends
 * before any text streams back (see this file's own `DEFAULT_CODE_TIMEOUT_SECONDS`
 * comment for that timing). Three distinct shapes, matching the three things
 * a heartbeat event can report:
 *   - the probe itself failed (`alive: false`) — the server may be dying;
 *     `runTurn` itself ends the turn once this repeats `deadProbeThreshold`
 *     times, this line is what a human sees while that is still in doubt;
 *   - the server answered but `modelRequestCount`/`totalTokens` have not
 *     grown for a while (`stalled: true`) — reported distinctly from "dead"
 *     on purpose: a long model "thinking" stretch is normal and the turn is
 *     never aborted for it (see `DEFAULT_STALL_WARN_MS`'s doc comment);
 *   - the server answered and is making measurable progress — the common
 *     case, shown as request/token counts with a `(+delta)` since the last
 *     probe when one is available.
 * @param {any} event a `{type: "heartbeat", ...}` progress event from `runTurn`
 * @returns {string | null}
 */
export function formatHeartbeatLine(event) {
  if (!event || event.type !== "heartbeat") return null;
  const elapsed = formatDurationMs(event.elapsedMs ?? 0);

  if (!event.alive) {
    return `[zcode] ${elapsed} · нет ответа от ZCode (зонд не отвечает, ${event.consecutiveFailedProbes} подряд) — жду`;
  }

  if (event.stalled) {
    const stalledFor = formatDurationMs(event.sinceLastProgressMs ?? 0);
    return `[zcode] ${elapsed} · жив · без прогресса ${stalledFor} — модель думает`;
  }

  const parts = [];
  if (typeof event.modelRequestCount === "number") {
    const delta =
      typeof event.modelRequestCountDelta === "number" && event.modelRequestCountDelta > 0
        ? ` (+${event.modelRequestCountDelta})`
        : "";
    parts.push(`запросов ${event.modelRequestCount}${delta}`);
  }
  if (typeof event.totalTokens === "number") {
    const delta =
      typeof event.totalTokensDelta === "number" && event.totalTokensDelta > 0
        ? ` (+${formatTokenCount(event.totalTokensDelta)})`
        : "";
    parts.push(`токенов ${formatTokenCount(event.totalTokens)}${delta}`);
  }

  return `[zcode] ${elapsed} · жив${parts.length > 0 ? " · " + parts.join(" · ") : ""}`;
}

/**
 * Progress forwarder for `runTurn`'s `onProgress` — streams model text as it
 * arrives, announces state transitions, prints one line per tool call, and
 * one compact line per `heartbeat` self-check event (see `formatHeartbeatLine`
 * above) — all to stderr so stdout stays exactly the final response.
 *
 * `--quiet` suppresses all line-by-line progress entirely.
 * `--no-stream` suppresses only streamed model text deltas (natural-language
 * reasoning/response output), while keeping tool calls, heartbeats, and
 * state notifications visible.
 *
 * When a `journal` is supplied, every `tool_call` event is recorded into it
 * (file-writing tools by path, Bash commands by text) for the post-turn
 * two-part changes summary. Recording is skipped when there is no journal
 * (i.e. under `--quiet`) — no point building a summary that won't be printed.
 * @param {(text: string) => void} write
 * @param {{ quiet?: boolean, noStream?: boolean, cwd?: string, journal?: import("./lib/diff.mjs").ReturnType<typeof createFileJournal> | null }} [options]
 */
export function makeOnProgress(write, { quiet = false, noStream = false, cwd = process.cwd(), journal = null } = {}) {
  if (quiet) return () => {};
  // Track the last printed model/mode pair so we don't emit the same startup
  // line twice — the server frequently sends two identical `state.updated`
  // events (e.g. "model=glm-5.3-flash mode=build" at turn start), which would
  // otherwise print the line twice on stderr.
  let lastStateKey = null;
  return (event) => {
    if (event.type === "model.streaming") {
      if ((event.kind === "text_delta" || event.kind === "reasoning_delta") && typeof event.delta === "string" && event.delta) {
        if (!noStream) {
          write(event.delta);
        }
      } else if (event.kind === "tool_call") {
        if (journal) journal.recordToolCall(event.toolName, event.input);
        const line = formatToolCallLine(event, cwd);
        if (line) write(`\n${line}\n`);
      }
    } else if (event.type === "state.updated") {
      // Prefer showing concrete values (model id / mode) from the patch over
      // the bare reason string — "model_changed" says nothing a user can act
      // on, "model=glm-5.3-flash" does. Print nothing when there is no value.
      //
      // Only accept string values: a non-string (object) model/mode would
      // serialize as "[object Object]" on stderr. Secrets are handled by
      // `redactSecrets`, same helper `formatToolCallLine` reuses.
      const modelId = event.patch?.model?.current?.modelId;
      const mode = event.patch?.mode?.current;
      const safeModel = typeof modelId === "string" && modelId ? modelId : null;
      const safeMode = typeof mode === "string" && mode ? mode : null;
      if (safeModel || safeMode) {
        const key = `${safeModel ?? ""}::${safeMode ?? ""}`;
        if (key === lastStateKey) return;
        lastStateKey = key;
        const parts = [];
        if (safeModel) parts.push(`model=${safeModel}`);
        if (safeMode) parts.push(`mode=${safeMode}`);
        write(`\n${redactSecrets(`[zcode] ${parts.join(" ")}`)}\n`);
      } else if (event.reason) {
        write(`\n${redactSecrets(`[zcode] ${event.reason}`)}\n`);
      }
    } else if (event.type === "heartbeat") {
      const line = formatHeartbeatLine(event);
      if (line) write(`\n${line}\n`);
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
    captureGitSnapshot: deps.captureGitSnapshot ?? captureGitSnapshot,
    createFileJournal: deps.createFileJournal ?? createFileJournal,
    diffGitSnapshots: deps.diffGitSnapshots ?? diffGitSnapshots,
    renderChangesSummary: deps.renderChangesSummary ?? renderChangesSummary,
    renderJournaledChangesSummary: deps.renderJournaledChangesSummary ?? renderJournaledChangesSummary,
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

/**
 * Safely render and print the changes summary to stderr. Any error during
 * snapshot diffing — a git timeout, a race on fs.stat, an EPERM — is caught
 * and reported as a single "сводка недоступна" line; it never propagates
 * to change the turn's exit code (requirement 3: the summary is decoration,
 * never a success/failure signal).
 *
 * The two-part renderer (`renderJournaledChangesSummary`) splits the git diff
 * into "files this run wrote" (from the journal) and "everything else that
 * changed in the repo meanwhile" — the fix for parallel-edit false positives.
 * The legacy single-part renderer (`renderChangesSummary`) is kept as a
 * fallback for callers that don't pass a journal.
 * @param {ReturnType<typeof captureGitSnapshot> | null} gitSnapshot
 * @param {string} cwd
 * @param {{ writtenFiles?: Iterable<string>, bashCommands?: string[] } | null} journal
 * @param {(text: string) => void} logError
 * @param {(before: any, cwd: string) => any} diffSnapshots
 * @param {(diffResult: any, journal: any, cwd: string) => string} renderSummary
 */
function printChangesSummary(gitSnapshot, cwd, journal, logError, diffSnapshots, renderSummary) {
  if (!gitSnapshot) return;
  try {
    const diffResult = diffSnapshots(gitSnapshot, cwd);
    logError(renderSummary(diffResult, journal, cwd));
  } catch (err) {
    logError(`[zcode] сводка недоступна: ${err?.message ?? String(err)}\n`);
  }
}

async function handleCode(argv, deps, log, logError) {
  const {
    resolveZcodeCli: resolveCli,
    runTurn: runTurnFn,
    captureGitSnapshot: captureSnapshot,
    createFileJournal: createJournal,
    diffGitSnapshots: diffSnapshots,
    renderJournaledChangesSummary: renderSummary,
  } = resolveDeps(deps);
  const { options, positionals } = parseCompanionArgs(argv, {
    valueOptions: ["cwd", "model", "timeout", "mode"],
    booleanOptions: ["quiet", "no-stream"],
  });

  const task = positionals.join(" ").trim();
  if (!task) {
    throw new UsageError(
      "Usage: zcode-companion code <task description> [--model <id>] [--cwd <path>] " +
        `[--timeout <seconds>] [--mode <${ZCODE_MODES.join("|")}>] [--quiet] [--no-stream]`,
    );
  }

  const cwd = resolveCwd(options);
  const model = parseModelFlag(options.model) ?? DEFAULT_CODE_MODEL;
  const timeoutMs = parseTimeoutFlag(options.timeout) ?? DEFAULT_CODE_TIMEOUT_SECONDS * 1000;
  const mode = parseModeFlag(options.mode) ?? undefined;
  const cli = resolveCli();
  const prompt = buildCodePrompt({ task, cwd });

  // --quiet suppresses per-step progress AND the changes summary — so don't
  // bother capturing the git snapshot or building the journal at all
  // (avoiding wasteful work for a summary that won't be printed).
  const isQuiet = Boolean(options.quiet);
  const gitSnapshot = isQuiet ? null : captureSnapshot(cwd);
  const journal = isQuiet ? null : createJournal(cwd);

  let result;
  try {
    result = await runTurnFn({
      cli,
      workspace: workspaceRef(cwd),
      prompt,
      model,
      mode,
      timeoutMs,
      onProgress: makeOnProgress(logError, {
        quiet: Boolean(options.quiet),
        noStream: Boolean(options["no-stream"]),
        cwd,
        journal,
      }),
      // `runTurn`'s own default is "deny" (see lib/session.mjs) — a library
      // must not silently grant permissions. This call site opts into
      // "allow" deliberately: `code` exists to delegate actual file edits,
      // so denying every `interaction/requestPermission` would make the
      // command read-only and its whole purpose moot (this is precisely the
      // defect this fix closes — see the module doc comment above). The
      // owner accepted this because `code` always runs inside a git
      // repository, where any write it makes can be reviewed and reverted.
      // NOTE: this is unconditional — `--mode` (above) does not change it.
      // `--mode` is ZCode's own agent-behavior mode; permissionPolicy is this
      // plugin's own decision about whether to auto-answer ZCode's
      // permission prompts. See ZCODE_MODES's doc comment for why these must
      // not be conflated — e.g. `--mode plan` still runs with
      // permissionPolicy: "allow", it is ZCode's own plan-mode behavior
      // (propose without touching files) that keeps it from writing, not a
      // denial from this plugin.
      permissionPolicy: "allow",
    });
  } catch (err) {
    // Requirement 3: summarize first (best-effort, never changes exit code),
    // then re-throw so runCli()'s catch block sets the right exit code.
    // Requirement 7: print the summary even on turn failure — the model may
    // have written files before the turn failed, and that is exactly when
    // the summary is most useful.
    if (!isQuiet) {
      printChangesSummary(gitSnapshot, cwd, journal, logError, diffSnapshots, renderSummary);
    }
    throw isRunTurnTimeout(err) ? toActionableTimeoutError(err, timeoutMs) : err;
  }

  log((typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2)) + "\n");
  logError(renderTurnFooter(result));
  if (!isQuiet) {
    printChangesSummary(gitSnapshot, cwd, journal, logError, diffSnapshots, renderSummary);
  }
  return EXIT_OK;
}

async function handleReview(argv, deps, log, logError) {
  const {
    resolveZcodeCli: resolveCli,
    runTurn: runTurnFn,
    buildReviewDiff: buildDiff,
    captureGitSnapshot: captureSnapshot,
    createFileJournal: createJournal,
    diffGitSnapshots: diffSnapshots,
    renderJournaledChangesSummary: renderSummary,
  } = resolveDeps(deps);
  const { options, positionals } = parseCompanionArgs(argv, {
    valueOptions: ["cwd", "model", "timeout", "mode"],
    booleanOptions: ["quiet", "no-stream"],
  });

  const target = positionals.join(" ").trim() || null;
  const cwd = resolveCwd(options);
  // Throws a clear error for "not a git repo" / "nothing to review" —
  // never returns an empty diff (see lib/diff.mjs's buildReviewDiff).
  const diffInfo = buildDiff(cwd, target);

  const model = parseModelFlag(options.model) ?? DEFAULT_REVIEW_MODEL;
  const timeoutMs = parseTimeoutFlag(options.timeout) ?? DEFAULT_REVIEW_TIMEOUT_SECONDS * 1000;
  const mode = parseModeFlag(options.mode) ?? undefined;
  const cli = resolveCli();
  const prompt = buildReviewPrompt({ diffInfo, cwd });

  // --quiet suppresses per-step progress AND the changes summary — so don't
  // bother capturing the git snapshot or building the journal at all.
  const isQuiet = Boolean(options.quiet);
  const gitSnapshot = isQuiet ? null : captureSnapshot(cwd);
  const journal = isQuiet ? null : createJournal(cwd);

  let result;
  try {
    result = await runTurnFn({
      cli,
      workspace: workspaceRef(cwd),
      prompt,
      model,
      mode,
      timeoutMs,
      onProgress: makeOnProgress(logError, {
        quiet: Boolean(options.quiet),
        noStream: Boolean(options["no-stream"]),
        cwd,
        journal,
      }),
      // Same reasoning as `handleCode` above: `runTurn`'s default is "deny",
      // and `review` opts into "allow" too. A review needs to actually use
      // its tools to read the surrounding files a diff touches — denying
      // every permission request breaks that the same way, and just as
      // silently (resultType stays "success" while every read is refused).
      // Unaffected by `--mode` — see the matching note in `handleCode`.
      permissionPolicy: "allow",
    });
  } catch (err) {
    // Requirement 3 & 7: best-effort summary on failure (never changes exit
    // code), then re-throw so runCli() sets the right exit code.
    if (!isQuiet) {
      printChangesSummary(gitSnapshot, cwd, journal, logError, diffSnapshots, renderSummary);
    }
    throw isRunTurnTimeout(err) ? toActionableTimeoutError(err, timeoutMs) : err;
  }

  log((typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2)) + "\n");
  logError(renderTurnFooter(result));
  if (!isQuiet) {
    printChangesSummary(gitSnapshot, cwd, journal, logError, diffSnapshots, renderSummary);
  }
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
 *   captureGitSnapshot?: typeof captureGitSnapshot,
 *   createFileJournal?: typeof createFileJournal,
 *   diffGitSnapshots?: typeof diffGitSnapshots,
 *   renderChangesSummary?: typeof renderChangesSummary,
 *   renderJournaledChangesSummary?: typeof renderJournaledChangesSummary,
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
