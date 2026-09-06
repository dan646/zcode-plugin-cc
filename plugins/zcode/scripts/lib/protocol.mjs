/**
 * ZCode Protocol client.
 *
 * Transport is newline-delimited JSON over the stdio of `<cli> app-server`.
 * This is *not* JSON-RPC 2.0 — a `jsonrpc` field is rejected by the server's
 * validation, so it is never added to outgoing messages. There is no
 * handshake: methods are callable immediately after the process is spawned.
 *
 * Message envelope is a union of four shapes:
 *   {id, method, params}  - request  (either direction)
 *   {method, params}      - notification (either direction)
 *   {id, result}          - success response
 *   {id, error}           - error response
 *
 * The protocol is bidirectional: the server sends the client requests of its
 * own (e.g. `session/requestRuntimePreferences`) and blocks the turn until
 * the client replies `{id, result}`. See `onRequest()`.
 *
 * @typedef {{ code: number, message: string, data?: unknown }} ProtocolErrorPayload
 * @typedef {Error & { code?: number, data?: unknown }} ProtocolError
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   callTimeoutMs?: number,
 *   quietNotificationTypes?: string[],
 *   logger?: (line: string) => void,
 * }} ZCodeProtocolClientOptions
 */

import { spawn } from "node:child_process";

/** Default timeout for a single `call()`, in milliseconds. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/**
 * Default timeout for a single server-initiated request handler (registered
 * via `onRequest()`), in milliseconds. Per docs/zcode-protocol-recon.md's
 * "Протокол двусторонний" section, the server blocks the whole turn on the
 * client's reply — a handler that throws or rejects is already covered, but
 * one that simply never settles (a bug in caller-supplied code, or a promise
 * that depends on something that will never happen) would otherwise stall
 * that turn forever with no way to recover. See `_handleServerRequest`.
 */
export const DEFAULT_SERVER_REQUEST_HANDLER_TIMEOUT_MS = 30_000;

/**
 * Hard ceiling on the number of bytes of unterminated stdout data buffered
 * while waiting for a newline. Without this, a line from ZCode app-server
 * that never gets a trailing `\n` (a bug in the server, or a message so large
 * it is still being written) would grow `this.buffer` without bound for as
 * long as the process lives.
 */
export const DEFAULT_MAX_LINE_BUFFER_LENGTH = 10 * 1024 * 1024; // 10 MiB

/**
 * Cap on the tail of stderr output retained for diagnostics. Per
 * docs/zcode-protocol-recon.md, `session/list` spins up the workspace's MCP
 * servers, which keep emitting to stderr (`process/mcpTelemetry`-adjacent
 * noise) for the lifetime of a process the broker is expected to reuse — so
 * naive unbounded accumulation (`buffer += chunk`) is a memory leak under
 * ordinary operation, not just under adversarial input. Only a bounded tail
 * is kept; the total byte count is tracked separately so the "N bytes of
 * stderr captured" diagnostic on an unexpected exit stays accurate even once
 * the tail has been trimmed.
 */
const MAX_STDERR_TAIL_LENGTH = 4096;

/**
 * High-volume, purely diagnostic notification channels. Filtered out of
 * `on()` delivery by default — pass `quietNotificationTypes: []` (or your own
 * list) to opt out.
 */
export const DEFAULT_QUIET_NOTIFICATION_TYPES = [
  "process/mcpTelemetry",
  "v4/telemetry/event",
  "computer-use/operation-event",
];

/** Known ZCode Protocol JSON-RPC-style error codes. */
export const PROTOCOL_ERROR_CODES = Object.freeze({
  INVALID_MESSAGE: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SESSION_UNAVAILABLE: -32004,
});

// Redact any inline apiKey value before it can reach a log line. The provider
// schema only ever transmits `{source:"env", name}` on purpose, but this is a
// last-resort guard so a stray `{source:"inline", value:"..."}` (or garbage
// from the server) can never leak into logs. This is the *only* pattern
// `redactSecrets` applies: it matches a known, bounded JSON field shape from
// our own provider-config schema, not arbitrary text.
//
// A previous version of this file also tried to scrub `KEY=value`-style env
// assignments and `Bearer <token>` values out of arbitrary diagnostic text
// (error messages, stderr, unparsed input). That is a race against the shape
// of adversarial input that regexes cannot win: a tightened pattern
// (`\bKEY=`, tolerating a leading char requirement, or a `"KEY":` JSON-colon
// variant) was still trivially bypassed by e.g. bare `KEY=...` or
// `"ZAI_API_KEY":"..."`, and a broadened pattern capable of catching those
// exhibited quadratic backtracking on adversarial input (tens to hundreds of
// milliseconds — and a blocked event loop — on a 64k-character string with no
// `=` in it at all). The fix is not a better regex: arbitrary text is simply
// never logged in the first place (see `_logDiag` and its call sites below),
// so there is nothing left for a generic secret-scrubber to protect against.
const API_KEY_PATTERN = /"apiKey"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"(?:[^"\\]|\\.)*")/g;

/**
 * Redact the one secret-shaped substring `redactSecrets` still knows how to
 * find: a JSON `"apiKey": ...` field, whose shape is defined by our own
 * provider-config schema (see `API_KEY_PATTERN` above) — not a general-purpose
 * secret scanner for arbitrary text. Applied centrally by `_logDiag()` (see
 * `ZCodeProtocolClient`) so this one case only needs handling once.
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  if (typeof text !== "string") return text;
  return text.replace(API_KEY_PATTERN, '"apiKey":"[REDACTED]"');
}

// Hard ceiling on any single piece of diagnostic text, applied *before* it is
// touched by `redactSecrets` (or anything else) — never after. A cap applied
// only to the final output (as a trailing `.slice(...)`, the previous
// approach in `explainProtocolError`) still lets an unbounded-length input
// reach the regex first; capping first means no diagnostic call site can ever
// hand a regex more than this many characters, however large the underlying
// error message, stderr chunk, or protocol field turns out to be.
const MAX_DIAG_TEXT_LENGTH = 2000;

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function capDiagText(text, max = MAX_DIAG_TEXT_LENGTH) {
  const str = String(text);
  return str.length > max ? `${str.slice(0, max)}…[truncated ${str.length - max} chars]` : str;
}

/**
 * Best-effort extraction of the numeric "position" V8's JSON.parse
 * SyntaxError reports (e.g. "Unexpected token o in JSON at position 4").
 * Only ever reads the engine's own error message, never the original input
 * line — the message itself can contain a one-character fragment of the
 * source ("token o"), so callers must not log `err.message` verbatim either.
 * @param {unknown} err
 * @returns {number | null}
 */
function jsonErrorPosition(err) {
  const message = err instanceof Error ? err.message : String(err);
  const match = /position (\d+)/.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidId(id) {
  if (typeof id === "string") return true;
  if (typeof id === "number") return Number.isFinite(id);
  return false;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isValidErrorPayload(error) {
  return typeof error === "object" && error !== null && !Array.isArray(error) && typeof error.code === "number";
}

/** Real ZCode Protocol method names are short, ASCII, and shaped like
 * "namespace/verb" or "dotted.name" (see docs/zcode-protocol-recon.md's
 * method inventory and the fixture's method table). */
const SAFE_METHOD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*([./][A-Za-z0-9_]+)*$/;
const MAX_SAFE_METHOD_NAME_LENGTH = 100;

/**
 * `_logDiag`'s own invariant is that arbitrary text off the wire is never
 * logged — but a `method` (or a notification's `params.type`) is exactly
 * that: a string chosen by the server (or, for `type`, by whatever produced
 * `params`), not validated for shape or length beyond "non-empty string" by
 * `isValidEnvelope`. This lets every real, well-formed method name through
 * untouched (they all match `SAFE_METHOD_NAME_PATTERN`) while refusing to log
 * anything that doesn't look like one — arbitrarily long text, control
 * characters, or secret-shaped content included.
 * @param {unknown} method
 * @returns {string}
 */
function safeMethodForLog(method) {
  if (
    typeof method === "string" &&
    method.length > 0 &&
    method.length <= MAX_SAFE_METHOD_NAME_LENGTH &&
    SAFE_METHOD_NAME_PATTERN.test(method)
  ) {
    return method;
  }
  return "<unrecognized method name>";
}

/**
 * Check that a parsed line is *exactly* one of the four ZCode Protocol
 * envelope shapes from docs/zcode-protocol-recon.md's "Транспорт" section:
 *   {id, method, params}  - request
 *   {method, params}      - notification
 *   {id, result}          - response
 *   {id, error}           - error response
 *
 * `JSON.parse` happily accepts a bare scalar (`null`, `123`, `"str"`) or an
 * array — none of those are valid envelopes, and touching `.id`/`.method` on
 * them (or on `null`) throws, so this must be checked before any envelope
 * field is read.
 *
 * This is deliberately strict about the response shapes: `id` must be a
 * string or (finite) number, never `null`/absent-but-present-as-null; a
 * response must carry *exactly one* of `result`/`error`, never both and
 * never neither (e.g. `{id, error: null}` is not a valid error response —
 * `error` must be an object with a numeric `code`). Anything that doesn't
 * match one of the four shapes is rejected outright, rather than accepted on
 * the mere presence of a field.
 * @param {unknown} message
 * @returns {boolean}
 */
function isValidEnvelope(message) {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;

  const hasMethod = "method" in message;
  const hasId = "id" in message;
  const hasResult = "result" in message;
  const hasError = "error" in message;

  if (hasMethod) {
    // Request {id, method, params} or notification {method, params}. A
    // hybrid carrying `method` together with `result`/`error` is not one of
    // the four documented shapes — reject it outright rather than letting it
    // fall through as, e.g., a notification with `params === undefined` or a
    // request the client answers with a spurious extra reply.
    if (hasResult || hasError) return false;
    if (typeof message.method !== "string" || message.method.length === 0) return false;
    if (hasId && !isValidId(message.id)) return false;
    return true;
  }

  // Response {id, result} or error response {id, error} — id is required and
  // must be valid, and exactly one of result/error must be present.
  if (!hasId || !isValidId(message.id)) return false;
  if (hasResult === hasError) return false; // both present, or neither
  if (hasError && !isValidErrorPayload(message.error)) return false;
  return true;
}

/**
 * Build the argv the `<cli> app-server` process is spawned with: the CLI's
 * base args plus the literal `app-server` subcommand. Extracted into its own
 * exported function — rather than inlined at the `spawn()` call site — so a
 * future edit that drops the subcommand (which would silently start an
 * interactive TUI instead of the protocol server) is caught by a direct unit
 * test on this function, not only by an end-to-end test noticing a hang.
 * @param {import("./locate.mjs").ResolvedCli} cli
 * @returns {string[]}
 */
export function buildAppServerArgs(cli) {
  return [...(cli.args ?? []), "app-server"];
}

/**
 * @param {string} message
 * @param {{ code?: number, data?: unknown }} [extra]
 * @returns {ProtocolError}
 */
function createProtocolError(message, extra = {}) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  if (extra.code !== undefined) error.code = extra.code;
  if (extra.data !== undefined) error.data = extra.data;
  return error;
}

/**
 * Expand a ZCode Protocol error into readable lines.
 *
 * `error.data` frequently carries a Zod validation error where `message` is a
 * *JSON-encoded string* containing the array of Zod issues (rather than a
 * plain object) — this unwraps that, walking `invalid_union`'s nested
 * `errors` arrays recursively, and renders one line per issue:
 *   `path: want <type>, got <actual>`
 *   `path: extra ["key"]`
 *
 * Falls back to `<code> <message>` when there is no parseable issue list.
 * @param {{ code?: number, message?: string, data?: unknown } | null | undefined} error
 * @returns {string}
 */
export function explainProtocolError(error) {
  if (!error) return "unknown protocol error";

  // Cap the raw text *before* it reaches `redactSecrets` — this is
  // server-supplied content, and capping only the final output (the previous
  // `.slice(0, 500)` placement) would still let an arbitrarily large message
  // reach the regex first.
  const fallback = () =>
    redactSecrets(capDiagText(`${error.code ?? "?"} ${error.message ?? ""}`.replace(/\s+/g, " ").trim(), 500));

  const raw = /** @type {any} */ (error.data)?.message ?? /** @type {any} */ (error.data)?.issues ?? null;
  let issues = null;
  if (typeof raw === "string") {
    try {
      issues = JSON.parse(raw);
    } catch {
      issues = null;
    }
  } else if (Array.isArray(raw)) {
    issues = raw;
  }
  if (!Array.isArray(issues) || issues.length === 0) return fallback();

  const lines = [];
  const walk = (list) => {
    for (const issue of list) {
      if (Array.isArray(issue?.errors)) {
        // invalid_union: nested arrays of per-branch sub-issues
        for (const branch of issue.errors) walk(branch);
        continue;
      }
      const issuePath = Array.isArray(issue?.path) && issue.path.length > 0 ? issue.path.join(".") : "(root)";
      switch (issue?.code) {
        case "unrecognized_keys":
          lines.push(`${issuePath}: extra ${JSON.stringify(issue.keys)}`);
          break;
        case "invalid_type":
          lines.push(`${issuePath}: want ${issue.expected}, got ${issue.received ?? "undefined"}`);
          break;
        case "invalid_value":
        case "invalid_literal":
          lines.push(`${issuePath}: must be ${JSON.stringify(issue.values ?? issue.expected)}`);
          break;
        case "invalid_union":
          lines.push(`${issuePath}: union mismatch`);
          break;
        default:
          lines.push(`${issuePath}: ${issue?.code ?? "?"} ${issue?.message ?? ""}`.trim());
      }
    }
  };
  walk(issues);

  const unique = [...new Set(lines)];
  return unique.length > 0 ? redactSecrets(capDiagText(unique.join("\n"), 500)) : fallback();
}

/**
 * Default handler for the one server-initiated request known to be sent
 * unconditionally during the turn lifecycle (twice: at `session/create` with
 * `scope: "runtime-materialization"`, and at `session/send` with
 * `scope: "user-execution"`).
 * @returns {{ nativeSearchEnhancementsEnabled: boolean }}
 */
function defaultRuntimePreferencesHandler() {
  return { nativeSearchEnhancementsEnabled: false };
}

export class ZCodeProtocolClient {
  /**
   * @param {import("./locate.mjs").ResolvedCli} cli
   * @param {ZCodeProtocolClientOptions} [options]
   */
  constructor(cli, options = {}) {
    this.cli = cli;
    this.options = options;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.serverRequestHandlerTimeoutMs =
      options.serverRequestHandlerTimeoutMs ?? DEFAULT_SERVER_REQUEST_HANDLER_TIMEOUT_MS;
    this.maxLineBufferLength = options.maxLineBufferLength ?? DEFAULT_MAX_LINE_BUFFER_LENGTH;
    this.quietNotificationTypes = new Set(options.quietNotificationTypes ?? DEFAULT_QUIET_NOTIFICATION_TYPES);
    this._log = options.logger ?? ((line) => process.stderr.write(`[zcode-protocol] ${line}\n`));

    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout | null, method: string }>} */
    this.pending = new Map();
    /** @type {Map<string, (params: any, message: any) => any>} */
    this.requestHandlers = new Map();
    /** @type {Map<string, Set<(params: any, message: any) => void>>} */
    this.notificationHandlers = new Map();

    this.nextId = 1;
    this.buffer = "";
    this.proc = null;
    this.closed = false;
    this.exitError = null;
    // Total bytes of stderr ever seen (for the "N bytes captured" exit
    // diagnostic) plus a bounded tail (see `MAX_STDERR_TAIL_LENGTH`) — never
    // an unbounded accumulation. `stderrTail` itself is never logged with its
    // content, only its length; it exists so a future caller with a genuine
    // debugging need can inspect `client.stderrTail` without the process
    // having grown its memory footprint proportionally to stderr volume over
    // the process's whole lifetime.
    this.stderrByteCount = 0;
    this.stderrTail = "";
    this._exitHandled = false;

    // `exitPromise` signals that the transport has been declared unusable —
    // it resolves as soon as `_handleExit()` runs, which can happen well
    // before the OS process has actually exited (e.g. a stdin EPIPE error
    // means writes will never succeed again, but the child may still be
    // alive and ignoring signals). `close()` must not confuse the two — see
    // `_processExitPromise` below for the one that tracks the real exit.
    this.exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });

    // Resolves only when the child process has actually exited (the `exit`
    // event fired), or when there never was a process to begin with. This is
    // what `close()` waits on before deciding whether to escalate to
    // SIGKILL — using `exitPromise` for that (as a previous version of this
    // file did) meant a stdin error could make `close()` believe the process
    // was gone while it was still running and ignoring SIGTERM.
    this._processExitPromise = new Promise((resolve) => {
      this._resolveProcessExit = resolve;
    });

    this.onRequest("session/requestRuntimePreferences", defaultRuntimePreferencesHandler);
  }

  /**
   * The single choke point all diagnostic text passes through before
   * reaching the configured logger. Callers must route every diagnostic line
   * through this (never call `this._log` directly).
   *
   * Two things happen here, both load-bearing:
   *   1. The length is capped *before* anything else touches the text — see
   *      `capDiagText` — so no diagnostic call site can ever hand a regex
   *      (even the one bounded pattern left in `redactSecrets`) more than a
   *      few thousand characters, however large the underlying input was.
   *   2. `redactSecrets` is applied for the one known-shape case it still
   *      handles (a stray `"apiKey"` JSON field).
   *
   * Neither of those is a substitute for the real rule, which every call
   * site below must follow on its own: never pass arbitrary text in here in
   * the first place. `err.message` from a request/notification handler, raw
   * `stderr` output, and the content of a line that failed to parse as JSON
   * must never reach this method — only safe, self-constructed facts (an
   * error's `constructor.name`, a length, a JSON-parse error position) are
   * safe to log, because there is no shape a generic filter could rely on to
   * catch every way a secret might appear in genuinely arbitrary text.
   * @param {string} line
   */
  _logDiag(line) {
    // The configured `logger` is caller-supplied code (see
    // `ZCodeProtocolClientOptions.logger`) and is called from deep inside
    // transport-internal codepaths (stdout parsing, exit handling, reply
    // fallbacks). A logger that throws — a broken formatter, a closed file
    // stream — must never be allowed to propagate out of here and crash the
    // host process over what is, at worst, a lost diagnostic line.
    try {
      this._log(redactSecrets(capDiagText(line)));
    } catch {
      // Swallowed deliberately: logging must never be able to bring down the
      // host. There is nowhere safe left to report this failure.
    }
  }

  /**
   * Spawn the `<cli> app-server` process and start reading its stdout.
   * @returns {ZCodeProtocolClient} this, for chaining
   */
  start() {
    if (this.closed) {
      throw createProtocolError("Cannot start(): ZCode protocol client is closed.");
    }
    if (this.proc) return this;

    this.proc = spawn(this.cli.command, buildAppServerArgs(this.cli), {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk) => this._handleChunk(chunk));
    this.proc.stderr.on("data", (chunk) => {
      // Track the total length separately from the retained tail: the
      // process this client wraps is reused by the broker for its whole
      // lifetime (docs/zcode-protocol-recon.md: `session/list` alone spins up
      // the workspace's MCP servers, which then keep emitting stderr noise
      // indefinitely), so `+=` accumulation here is a memory leak under
      // ordinary, non-adversarial operation — not just a defense against a
      // hostile child process.
      this.stderrByteCount += chunk.length;
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL_LENGTH);
    });

    // A closed reading end on the child's side (e.g. it exited or never
    // consumed stdin) makes writes to `proc.stdin` fail asynchronously with
    // `EPIPE`, emitted as an "error" event on the stream itself — a
    // *different* object than `proc`, so `proc.on("error")` never sees it.
    // Without a listener here, Node treats an unhandled stream "error" as an
    // uncaught exception and brings the whole host process down. Route it
    // through the same idempotent cleanup as a process exit: reject every
    // pending call instead of hanging or crashing.
    this.proc.stdin.on("error", (err) => {
      this._handleExit(createProtocolError(`ZCode app-server stdin error: ${err.message}`));
    });

    this.proc.on("error", (err) => {
      this._handleExit(createProtocolError(`Failed to start ZCode CLI (${this.cli.command}): ${err.message}`));
    });

    this.proc.on("exit", (code, signal) => {
      // This is the *actual* OS-level exit — resolve the dedicated promise
      // `close()` relies on before it may safely stop escalating signals.
      this._resolveProcessExit();

      const clean = code === 0 || this.closed;
      const detail = clean
        ? null
        : createProtocolError(
            `ZCode app-server exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`}).` +
              // Never include the raw stderr text: it is arbitrary output
              // from the child process and may contain secret-shaped
              // content (e.g. a misconfigured provider echoing back its own
              // API key). A length is enough to know something was
              // captured, without repeating the arms race a generic
              // secret-scrubbing regex would require.
              (this.stderrByteCount > 0 ? ` (${this.stderrByteCount} bytes of stderr captured)` : ""),
          );
      this._handleExit(detail);
    });

    // When `spawn()` itself fails (e.g. ENOENT — the resolved CLI path no
    // longer exists, which docs/zcode-protocol-recon.md calls out as an
    // expected failure mode when ZCode.app has moved or been reinstalled),
    // Node emits "error" followed by "close" — but *never* "exit". Relying on
    // "exit" alone to resolve `_processExitPromise` would leave it pending
    // forever, and `close()` awaits exactly that promise before it may return
    // — hanging `close()` (and anything awaiting it) indefinitely even though
    // there both never was, and never will be, a real process to wait for.
    // "close" fires in every case "exit" does, plus this one, and never fires
    // early while a real, still-running child's stdio is still open — so it
    // is the one event this promise can safely resolve on unconditionally.
    this.proc.on("close", () => {
      this._resolveProcessExit();
    });

    return this;
  }

  /**
   * Register a handler for a server-initiated request. Overrides any
   * previous handler for the same method (including the built-in
   * `session/requestRuntimePreferences` default).
   * @param {string} method
   * @param {(params: any, message: any) => any | Promise<any>} handler returns the `result` payload
   */
  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Subscribe to notifications of a given type. The type is `params.type`
   * when present, otherwise the notification's `method`. Noisy channels
   * (`process/mcpTelemetry`, `v4/telemetry/event`,
   * `computer-use/operation-event`) are filtered by default — see
   * `quietNotificationTypes` in the constructor options.
   * @param {string} type
   * @param {(params: any, message: any) => void} callback
   * @returns {() => void} unsubscribe function
   */
  on(type, callback) {
    let set = this.notificationHandlers.get(type);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(type, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
    };
  }

  /**
   * Send a request and resolve/reject with the server's response.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ timeoutMs?: number }} [callOptions]
   * @returns {Promise<any>}
   */
  call(method, params = {}, callOptions = {}) {
    if (this.closed) {
      return Promise.reject(createProtocolError(`Cannot call "${method}": ZCode protocol client is closed.`));
    }
    if (!this.proc) {
      return Promise.reject(
        createProtocolError(`Cannot call "${method}": client has not been started (call start() first).`),
      );
    }
    if (!this.proc.stdin || this.proc.stdin.destroyed || !this.proc.stdin.writable) {
      return Promise.reject(createProtocolError(`Cannot call "${method}": stdin is not writable.`));
    }

    const id = this.nextId++;
    const timeoutMs = callOptions.timeoutMs ?? this.callTimeoutMs;

    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(createProtocolError(`Timed out after ${timeoutMs}ms waiting for a response to "${method}".`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._send({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Send a client-to-server notification (no response expected).
   *
   * Mirrors the same guard checks `call()` performs before attempting to
   * write: closed client, never-started client, and a stdin that has become
   * unwritable (e.g. after an EPIPE). Previously this method only checked
   * `closed`/`proc` and then called `_send()` unconditionally — a destroyed
   * or non-writable stdin would still reach `_send()`'s own check, which
   * throws, but that throw then escaped synchronously and uncaught from
   * `notify()` itself, with no analogous safety net to `call()`'s rejected
   * promise. Throwing a clear, typed `ProtocolError` up front — the same
   * shape `call()` rejects with — gives callers one consistent, catchable
   * failure mode instead of an unpredictable lower-level stream error.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  notify(method, params = {}) {
    if (this.closed) {
      throw createProtocolError(`Cannot notify "${method}": ZCode protocol client is closed.`);
    }
    if (!this.proc) {
      throw createProtocolError(`Cannot notify "${method}": client has not been started (call start() first).`);
    }
    if (!this.proc.stdin || this.proc.stdin.destroyed || !this.proc.stdin.writable) {
      throw createProtocolError(`Cannot notify "${method}": stdin is not writable.`);
    }
    this._send({ method, params });
  }

  /**
   * @param {unknown} message
   */
  _send(message) {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw createProtocolError("Cannot write to ZCode app-server: stdin is not available.");
    }

    const serialized = JSON.stringify(message);

    // `JSON.stringify` drops an object key outright — no exception raised —
    // when its value is `undefined`, a function, or a Symbol. A reply
    // envelope built by `_handleServerRequest` always carries a `result` or
    // `error` key (see docs/zcode-protocol-recon.md's four envelope shapes);
    // if a handler returned something unserializable, that key can vanish
    // here silently, e.g. `{id: "srv", result: someFunction}` serializes to
    // `{"id":"srv"}` — not one of the four valid shapes, and a request the
    // server never gets ANY expected field for stalls that turn forever.
    // Re-parsing and checking the field actually survived lets the caller
    // (`_replyToServerRequest`) fall back to a proper error envelope instead.
    if (message !== null && typeof message === "object" && ("result" in message || "error" in message)) {
      let roundTripped;
      try {
        roundTripped = JSON.parse(serialized);
      } catch {
        roundTripped = null;
      }
      if ("result" in message && !(roundTripped && "result" in roundTripped)) {
        throw createProtocolError('Refusing to send reply: "result" value is not JSON-serializable.');
      }
      if ("error" in message && !(roundTripped && "error" in roundTripped)) {
        throw createProtocolError('Refusing to send reply: "error" value is not JSON-serializable.');
      }
    }

    stdin.write(serialized + "\n");
  }

  /**
   * @param {string} chunk
   */
  _handleChunk(chunk) {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this._handleLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }

    // No newline found, and what remains is already unreasonably large: a
    // stream with no `\n` (a stalled/misbehaving server, or a message so
    // large something upstream lost the delimiter) would otherwise grow this
    // buffer without bound for as long as the process lives. Drop it and keep
    // going rather than let memory use climb indefinitely — never log the
    // content itself, only the fact and its length, per this file's own
    // logging invariant (see `_logDiag`).
    if (this.buffer.length > this.maxLineBufferLength) {
      this._logDiag(
        `discarding buffered stdout data: no newline seen after ${this.buffer.length} bytes ` +
          `(limit ${this.maxLineBufferLength})`,
      );
      this.buffer = "";
    }
  }

  /**
   * @param {string} line
   */
  _handleLine(line) {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      // A malformed line must never take down the client — log and move on.
      // Never log `err.message` or the line itself: a JSON SyntaxError
      // message embeds a fragment of the offending input, which may contain
      // secret-shaped content. Length and position are enough to debug.
      const position = jsonErrorPosition(err);
      this._logDiag(
        `ignoring unparseable line from ZCode app-server (length=${line.length}` +
          (position !== null ? `, position=${position}` : "") +
          ")",
      );
      return;
    }

    // A bare JSON scalar (`null`, `123`, `"str"`) or array parses
    // successfully but is never a valid envelope — reject it here, before
    // any field is read, rather than letting `.id`/`.method` throw below.
    if (!isValidEnvelope(message)) {
      const kind = Array.isArray(message) ? "array" : typeof message;
      this._logDiag(`ignoring message with invalid ZCode Protocol envelope shape (type=${kind}, length=${line.length})`);
      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      this._handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      this._handleResponse(message);
      return;
    }
    this._handleNotification(message);
  }

  /**
   * @param {{ id: number|string, method: string, params?: any }} message
   */
  async _handleServerRequest(message) {
    const handler = this.requestHandlers.get(message.method);
    let payload;
    if (!handler) {
      this._logDiag(`unhandled server request "${safeMethodForLog(message.method)}"; replying with {}`);
      payload = { id: message.id, result: {} };
    } else {
      try {
        const result = await this._runHandlerWithTimeout(handler, message);
        payload = { id: message.id, result: result ?? {} };
      } catch (err) {
        if (err?.zcodeHandlerTimeout) {
          // This message is our own text (method name + configured timeout),
          // not caller-supplied content, so — unlike the branch below — it is
          // safe to log in full.
          this._logDiag(
            `handler for server request "${safeMethodForLog(message.method)}" did not settle within ` +
              `${this.serverRequestHandlerTimeoutMs}ms; replying with a timeout error`,
          );
        } else {
          // Never log `err.message`: this is a caller-supplied handler (from
          // `onRequest()`), and its thrown error can contain anything — up to
          // and including a secret it was trying to report. The error's
          // `message` is still relayed to the server below, in the reply
          // payload itself (that is legitimate protocol data the caller
          // presumably wants surfaced) — only the *log line* is restricted to
          // the error's class name, a safe fact regardless of content.
          this._logDiag(
            `handler for server request "${safeMethodForLog(message.method)}" threw (${err?.constructor?.name ?? "Error"})`,
          );
        }
        payload = {
          id: message.id,
          error: {
            code: PROTOCOL_ERROR_CODES.INTERNAL_ERROR,
            message: err?.message ? String(err.message) : "internal handler error",
          },
        };
      }
    }
    this._replyToServerRequest(message.id, payload);
  }

  /**
   * Run a server-request handler under a timeout. Per
   * docs/zcode-protocol-recon.md's "Протокол двусторонний" section, the
   * server blocks the whole turn on the client's reply — a handler that
   * throws synchronously or rejects is already surfaced as an error reply by
   * the caller's try/catch, but a handler whose returned promise simply never
   * settles (a bug in caller-supplied code, e.g. `onRequest(...,  () => new
   * Promise(() => {}))`) would otherwise hang that turn forever with no way
   * to recover. `serverRequestHandlerTimeoutMs <= 0` disables the timeout
   * (mirrors `call()`'s `timeoutMs` convention).
   * @param {(params: any, message: any) => any} handler
   * @param {{ method: string, params?: any, id: number|string }} message
   * @returns {Promise<any>}
   */
  _runHandlerWithTimeout(handler, message) {
    const timeoutMs = this.serverRequestHandlerTimeoutMs;
    const handlerResult = Promise.resolve().then(() => handler(message.params ?? {}, message));
    if (!(timeoutMs > 0)) return handlerResult;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutError = createProtocolError(
          `Handler for server request "${message.method}" did not settle within ${timeoutMs}ms.`,
        );
        timeoutError.zcodeHandlerTimeout = true;
        reject(timeoutError);
      }, timeoutMs);
      timer.unref?.();

      handlerResult.then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Guarantee that *some* reply reaches the server for every server-initiated
   * request. Per docs/zcode-protocol-recon.md's "Протокол двусторонний"
   * section, a request the client never answers stalls that turn forever —
   * so a handler result that fails to serialize (e.g. a circular object) must
   * not just be logged and dropped. Tries the real payload first; if sending
   * it throws (handler exception already turned into an error payload above,
   * or `JSON.stringify` rejecting a non-serializable result), falls back to a
   * plain error envelope; if even that cannot be sent, the transport itself
   * is unusable, so it is torn down instead of leaving the server hanging
   * silently.
   * @param {number|string} id
   * @param {{id: number|string, result?: any, error?: any}} payload
   */
  _replyToServerRequest(id, payload) {
    if (this._trySend(payload)) return;

    const fallback = {
      id,
      error: { code: PROTOCOL_ERROR_CODES.INTERNAL_ERROR, message: "internal error: failed to serialize response" },
    };
    if (this._trySend(fallback)) return;

    this._logDiag(
      `could not deliver any reply for server request ${JSON.stringify(id)}; terminating the transport so the turn does not hang silently.`,
    );
    this.close().catch(() => {});
  }

  /**
   * @param {unknown} message
   * @returns {boolean} whether the send succeeded
   */
  _trySend(message) {
    try {
      this._send(message);
      return true;
    } catch (err) {
      this._logDiag(`failed to send message to ZCode app-server: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * @param {{ id: number|string, result?: any, error?: ProtocolErrorPayload }} message
   */
  _handleResponse(message) {
    let key = message.id;
    let pending = this.pending.get(key);
    if (!pending) {
      // `Map` lookup is strict-equality, so `pending.get("5") !== pending.get(5)`.
      // `this.nextId` always produces numbers, and the live ZCode app-server
      // has been observed to mirror an id's JSON type byte-for-byte (send a
      // number, get a number back; send a string, get a string back) — so
      // this fallback should never actually fire in production. It exists as
      // a cheap safety net in case some server implementation ever coerces
      // the id's type along the way, rather than trusting that behavior
      // forever.
      const target = String(message.id);
      for (const candidateKey of this.pending.keys()) {
        if (String(candidateKey) === target) {
          key = candidateKey;
          pending = this.pending.get(candidateKey);
          break;
        }
      }
    }
    if (!pending) return;
    this.pending.delete(key);
    if (pending.timer) clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(
        createProtocolError(message.error.message ?? `"${pending.method}" failed.`, {
          code: message.error.code,
          data: message.error.data,
        }),
      );
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  /**
   * @param {{ method: string, params?: any }} message
   */
  _handleNotification(message) {
    const type = message.params?.type ?? message.method;
    if (this.quietNotificationTypes.has(type) || this.quietNotificationTypes.has(message.method)) {
      return;
    }
    const handlers = this.notificationHandlers.get(type);
    if (!handlers || handlers.size === 0) return;
    for (const callback of handlers) {
      try {
        callback(message.params, message);
      } catch (err) {
        // Never log `err.message` here either — same reasoning as the
        // server-request handler above: this is caller-supplied code, and
        // its thrown error's text is arbitrary. Unlike a server-request
        // reply, a notification has nowhere to relay the message to, so it
        // simply never leaves this process.
        this._logDiag(
          `notification handler for "${safeMethodForLog(type)}" threw (${err?.constructor?.name ?? "Error"})`,
        );
      }
    }
  }

  /**
   * @param {ProtocolError | null} error
   */
  _handleExit(error) {
    if (this._exitHandled) return;
    this._exitHandled = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error ?? createProtocolError("ZCode app-server process exited."));
    }
    this.pending.clear();
    this._resolveExit();
  }

  /**
   * Gracefully shut down: close stdin, SIGTERM, wait briefly for exit, then
   * SIGKILL if it hasn't gone away. Idempotent and safe to call more than
   * once or before `start()`.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<void>}
   */
  async close(options = {}) {
    const gracefulTimeoutMs = options.timeoutMs ?? 2000;

    if (this.closed) {
      await this._processExitPromise;
      return;
    }
    this.closed = true;

    const proc = this.proc;
    if (!proc) {
      // No process was ever spawned, so there is nothing to wait on — the
      // "process exit" condition is vacuously true.
      this._resolveProcessExit();
      this._handleExit(this.exitError);
      return;
    }

    try {
      if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
    } catch {
      // already gone
    }

    // A process whose `spawn()` itself failed (e.g. ENOENT — the resolved CLI
    // path no longer exists) has `pid === undefined`: there is no OS process
    // to signal. Observed directly (Node v26.8.1/darwin): calling
    // `proc.kill()` on such a process never returns at all — not a rejected
    // promise, not a thrown error, the call itself hangs the event loop
    // permanently. There is nothing to kill in this case, so the fix is to
    // never make the call — `_handleExit` (already triggered by the "error"
    // event) and the "close" listener in `start()` have already done
    // everything cleanup here needs.
    if (proc.pid !== undefined && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }

    // Wait for the *actual* process exit here, not `exitPromise` — a stdin
    // write error (EPIPE) or a spawn error resolves `exitPromise` as soon as
    // the transport is declared dead, which can happen well before (or
    // without) the child process itself exiting. Racing against that would
    // let `close()` conclude the process is gone and skip SIGKILL entirely
    // while a child that ignores SIGTERM keeps running indefinitely.
    let killTimer;
    const exitedInTime = await Promise.race([
      this._processExitPromise.then(() => true),
      new Promise((resolve) => {
        killTimer = setTimeout(() => resolve(false), gracefulTimeoutMs);
      }),
    ]);
    clearTimeout(killTimer);

    if (!exitedInTime) {
      if (proc.pid !== undefined) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      await this._processExitPromise;
    }
  }
}
