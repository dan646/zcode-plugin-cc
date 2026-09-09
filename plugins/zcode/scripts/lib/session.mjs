/**
 * Turn lifecycle layer on top of `ZCodeProtocolClient` (see ./protocol.mjs).
 *
 * `protocol.mjs` only speaks the wire transport (envelopes, timeouts,
 * bidirectional requests). This module knows the *sequence* of calls a real
 * ZCode turn needs — see docs/zcode-protocol-recon.md's "Жизненный цикл
 * хода" section — and returns one finished result per call to `runTurn()`.
 *
 * Everything here is deliberately conservative about what it assumes the
 * server did: `session/create`'s `result.projection.sessionId` is a known
 * "unknown" placeholder trap (see `extractSessionId`), `turn.completed`'s
 * `payload.response` is already the whole answer (streaming deltas are for
 * progress only, never accumulated here), and the client never registers a
 * model provider or touches secrets — see requirement 1 in the unit-3 spec
 * this file implements.
 *
 * @typedef {{ code?: unknown, message?: string, detail?: unknown,
 *   attribution?: { source?: string, reason?: string, retryable?: boolean } }} TurnErrorPayload
 * @typedef {{
 *   sessionId: string,
 *   response: unknown,
 *   usage: unknown,
 *   sessionUsage: unknown,
 *   events: Array<{ type: string, params: any }>,
 *   resultType: string,
 * }} RunTurnResult
 */
/*
 * `usage` and `sessionUsage` are NOT duplicates — see
 * docs/zcode-protocol-recon.md, "Две разные метрики расхода — не путать".
 * They come from two different calls and measure two different things:
 *   - `usage` is `turn.completed.payload.usage` — this one turn's spend,
 *     provider-shaped (`source`, `cacheWriteTokens`, `webFetchRequests`,
 *     `webSearchRequests`). It is `null` for a turn that never completes
 *     (timeout, turn.failed, cancellation with no completion in the grace
 *     window).
 *   - `sessionUsage` is a separate `session/usage` call's result — the whole
 *     session's cumulative spend, session-shaped (`modelErrorCount`,
 *     `cacheCreationTokens`, `inputBaselineBySource`, `sessionId`). It can
 *     differ from `usage` by more than rounding: e.g. a hidden `lite`-role
 *     request to generate the session title bumps `session/usage`'s
 *     `modelRequestCount` by one over the turn's own count. `modelErrorCount`
 *     exists ONLY here — it is the only way to check the model didn't error
 *     out during the turn. `sessionUsage` is `null` when the `session/usage`
 *     call itself failed (see `fetchSessionUsage`) — that must never be
 *     confused with a turn that had zero session-level usage.
 */

import { ZCodeProtocolClient } from "./protocol.mjs";

/** Default timeout waiting for `turn.completed`/`turn.failed`, in milliseconds. */
export const DEFAULT_TURN_TIMEOUT_MS = 180_000;

/**
 * Valid values for `runTurn`'s `permissionPolicy` option (see below).
 */
export const PERMISSION_POLICIES = Object.freeze(["allow", "deny"]);

/**
 * `runTurn`'s default `permissionPolicy`. Deliberately the *restrictive*
 * choice: a library that answers `interaction/requestPermission` with
 * `{decision:"allow"}` unless a caller opts out would be silently granting
 * write/tool access to whatever prompt happens to be running. Only a caller
 * that has actually weighed the tradeoff (see `zcode-companion.mjs`'s
 * `handleCode`/`handleReview`, which both pass `"allow"` deliberately) should
 * get that behavior.
 */
export const DEFAULT_PERMISSION_POLICY = "deny";

/**
 * How long to keep waiting for a terminal event after `session/stop` has
 * been called on cancellation, before giving up and returning
 * `resultType: "cancelled"` anyway. The server is not guaranteed to ever
 * emit one for a stopped turn, so this must not be the same (long) budget as
 * `DEFAULT_TURN_TIMEOUT_MS` — a caller cancelling a turn wants a prompt
 * response, not to wait out the original timeout a second time.
 */
export const DEFAULT_CANCEL_GRACE_MS = 5_000;

// --- Heartbeat (active liveness self-check while waiting for a turn) -------
//
// `zcode-companion.mjs`'s own defaults bumped the turn timeout to 2700s/1800s
// (see its module doc comment) because real ZCode work takes 20-30 minutes
// end to end, with the FIRST 10-15 minutes producing no streamed output at
// all. During that stretch a caller cannot tell "still working" from "the
// connection died silently" — and on a real disconnect, the old behavior was
// to find out only once the full 45-minute timeout finally elapsed.
//
// A wall-clock timer proves nothing here ("it's been quiet for 10 minutes"
// is exactly what a healthy turn looks like too) — the only trustworthy
// signal is an ACTIVE probe: `session/usage` is a cheap round trip that both
// (a) confirms the server is still answering at all, and (b) reports
// `modelRequestCount`/`totalTokens`, which keep climbing while the model is
// genuinely working even though nothing has streamed back yet. See
// `createHeartbeatMonitor` below for the mechanism, and `runTurn`'s own doc
// comment for how it plugs into the wait loop.

/** Default `runTurn` `heartbeatIntervalMs` — how long the wait loop tolerates
 * silence (no event of any kind) from the server before it actively probes
 * with `session/usage`. Passing `0` disables the whole mechanism. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Default `runTurn` `heartbeatProbeTimeoutMs` — the probe's OWN timeout,
 * deliberately short and unrelated to the turn's overall `timeoutMs`: a
 * probe that itself hangs for minutes would defeat the point of probing. */
export const DEFAULT_HEARTBEAT_PROBE_TIMEOUT_MS = 5_000;

/** Default `runTurn` `deadProbeThreshold` — consecutive failed/timed-out
 * probes after which the turn is ended early with a clear error, rather than
 * silently waiting out the rest of `timeoutMs` against a server that has
 * already stopped answering. */
export const DEFAULT_DEAD_PROBE_THRESHOLD = 3;

/** Default `runTurn` `stallWarnMs` — how long a live server may go without
 * `modelRequestCount`/`totalTokens` growing before a heartbeat event flags
 * `stalled: true`. This is advisory only (see `createHeartbeatMonitor`) —
 * long model "thinking" is normal and the turn is never aborted for it. */
export const DEFAULT_STALL_WARN_MS = 5 * 60_000;

/**
 * Render a millisecond duration as `"<minutes>m<seconds>s"` (e.g. `12m30s`,
 * `0m05s`) — the one duration format this module and `zcode-companion.mjs`'s
 * heartbeat lines both use, so a user comparing the two never has to
 * reconcile two different notations for the same kind of number.
 * @param {number} ms
 * @returns {string}
 */
export function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Active liveness monitor for the "waiting on a terminal event" phase of a
 * turn (see the module-level heartbeat design comment above, and `runTurn`'s
 * own use of this below). Ticks on a fixed `heartbeatIntervalMs` cadence;
 * each tick only actually probes when the server has been silent (no
 * progress/terminal notification of any kind — see `getLastEventAt`) for at
 * least that long, so an actively-streaming turn is never interrupted by
 * probing at all.
 *
 * Every probe outcome is reported via `onProgress` as a `{type: "heartbeat"}`
 * event (requirement 3 of the self-check spec) with enough fields for a
 * caller to render "is it working or hung" in one line:
 *   - `elapsedMs` / `sinceLastEventMs`: how long the turn has been waiting,
 *     and how long since the last event of any kind.
 *   - `alive`: whether THIS probe got a response at all.
 *   - `progressed`: whether `modelRequestCount`/`totalTokens` grew versus
 *     the PREVIOUS probe (`null` on the very first probe — there is nothing
 *     to compare against yet).
 *   - `stalled`: `true` only once a live server has gone `stallWarnMs`
 *     without measured progress — deliberately advisory, never a reason to
 *     abort (long model "thinking" is normal; see `DEFAULT_STALL_WARN_MS`).
 *   - `consecutiveFailedProbes`: resets to 0 on the first successful probe
 *     after any failures — a single blip must not count toward
 *     `deadProbeThreshold`.
 *
 * When `consecutiveFailedProbes` reaches `deadProbeThreshold`, `deadPromise`
 * resolves — `runTurn` races this alongside its timeout/terminal/abort
 * promises so a genuinely dead connection ends the turn immediately instead
 * of waiting out the rest of `timeoutMs` (requirement 4).
 * @param {object} args
 * @param {import("./protocol.mjs").ZCodeProtocolClient} args.client
 * @param {string} args.sessionId
 * @param {((event: any) => void) | undefined} args.onProgress
 * @param {number} args.heartbeatIntervalMs
 * @param {number} args.heartbeatProbeTimeoutMs
 * @param {number} args.deadProbeThreshold
 * @param {number} args.stallWarnMs
 * @param {number} args.waitStartedAt epoch ms when the turn began waiting (right after `session/send`)
 * @param {() => number} args.getLastEventAt reads the current "last event at" timestamp
 * @returns {{ deadPromise: Promise<{ type: "dead", elapsedMs: number, consecutiveFailedProbes: number, probeError: string | null }>, stop: () => void }}
 */
function createHeartbeatMonitor({
  client,
  sessionId,
  onProgress,
  heartbeatIntervalMs,
  heartbeatProbeTimeoutMs,
  deadProbeThreshold,
  stallWarnMs,
  waitStartedAt,
  getLastEventAt,
}) {
  let stopped = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let consecutiveFailedProbes = 0;
  /** @type {{ modelRequestCount: number | null, totalTokens: number | null } | null} */
  let lastProbeCounts = null;
  let lastProgressAt = waitStartedAt;
  /** @type {(value: { elapsedMs: number, consecutiveFailedProbes: number, probeError: string | null }) => void} */
  let resolveDead;
  const deadOutcome = new Promise((resolve) => {
    resolveDead = resolve;
  });

  function schedule() {
    if (stopped) return;
    timer = setTimeout(tick, heartbeatIntervalMs);
    timer.unref?.();
  }

  async function tick() {
    if (stopped) return;
    const now = Date.now();
    const sinceLastEventMs = now - getLastEventAt();
    if (sinceLastEventMs < heartbeatIntervalMs) {
      // The server has said SOMETHING recently enough — no need to probe.
      schedule();
      return;
    }

    let alive = false;
    let probeError = null;
    /** @type {{ modelRequestCount: number | null, totalTokens: number | null } | null} */
    let counts = null;
    try {
      const usage = await client.call("session/usage", { sessionId }, { timeoutMs: heartbeatProbeTimeoutMs });
      alive = true;
      counts = {
        modelRequestCount: typeof usage?.modelRequestCount === "number" ? usage.modelRequestCount : null,
        totalTokens: typeof usage?.totalTokens === "number" ? usage.totalTokens : null,
      };
    } catch (err) {
      probeError = err?.message ? String(err.message) : "unknown probe error";
    }

    // The main wait may have settled (terminal event, timeout, abort) while
    // this probe was in flight — `stop()` already ran, so no further ticks
    // or progress events should follow from this one.
    if (stopped) return;

    const afterProbeNow = Date.now();
    let progressed = null;
    let modelRequestCountDelta = null;
    let totalTokensDelta = null;

    if (alive) {
      if (lastProbeCounts) {
        if (typeof counts.modelRequestCount === "number" && typeof lastProbeCounts.modelRequestCount === "number") {
          modelRequestCountDelta = counts.modelRequestCount - lastProbeCounts.modelRequestCount;
        }
        if (typeof counts.totalTokens === "number" && typeof lastProbeCounts.totalTokens === "number") {
          totalTokensDelta = counts.totalTokens - lastProbeCounts.totalTokens;
        }
        progressed = (modelRequestCountDelta ?? 0) > 0 || (totalTokensDelta ?? 0) > 0;
      }
      // No previous probe to compare against (`progressed === null`) counts
      // as fresh, not stale — the stall clock only starts once there is
      // actually something to have gone stale against.
      if (progressed !== false) {
        lastProgressAt = afterProbeNow;
      }
      lastProbeCounts = counts;
      consecutiveFailedProbes = 0;
    } else {
      consecutiveFailedProbes += 1;
    }

    const elapsedMs = afterProbeNow - waitStartedAt;
    const sinceLastProgressMs = alive ? afterProbeNow - lastProgressAt : null;
    const stalled = alive && sinceLastProgressMs !== null && sinceLastProgressMs >= stallWarnMs;

    safeProgress(onProgress, {
      type: "heartbeat",
      elapsedMs,
      sinceLastEventMs,
      alive,
      probeError,
      consecutiveFailedProbes,
      progressed,
      stalled,
      sinceLastProgressMs,
      modelRequestCount: counts?.modelRequestCount ?? null,
      totalTokens: counts?.totalTokens ?? null,
      modelRequestCountDelta,
      totalTokensDelta,
    });

    if (!alive && consecutiveFailedProbes >= deadProbeThreshold) {
      stopped = true;
      resolveDead({ elapsedMs, consecutiveFailedProbes, probeError });
      return;
    }

    schedule();
  }

  schedule();

  return {
    deadPromise: deadOutcome.then((info) => ({ type: "dead", ...info })),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

const TERMINAL_EVENT_TYPES = ["turn.completed", "turn.failed"];
const PROGRESS_EVENT_TYPES = ["model.streaming", "state.updated"];

/**
 * Call a caller-supplied progress callback without letting it break the
 * turn. `onProgress` is a UI hook (see requirement 7): a throwing
 * implementation must never abort an otherwise-successful turn.
 * @param {((event: any) => void) | undefined} onProgress
 * @param {any} event
 */
function safeProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(event);
  } catch {
    // Deliberately swallowed — see doc comment above.
  }
}

/**
 * @param {any} state result of `workspace/readState`
 * @returns {boolean}
 */
export function isProviderConfigured(state) {
  const providers = state?.modelCatalog?.providers;
  return Array.isArray(providers) && providers.length > 0;
}

/**
 * @param {any} state result of `workspace/readState`
 * @throws {Error} with a direct `zcode login` instruction when unconfigured
 */
function assertProviderConfigured(state) {
  if (isProviderConfigured(state)) return;
  const providerId = state?.model?.current?.providerId ?? "unknown";
  throw new Error(
    "ZCode CLI has no model provider configured " +
      `(workspace/readState: modelCatalog.providers is empty, current providerId is ${JSON.stringify(providerId)}). ` +
      "Run `zcode login` once to configure the CLI (see docs/zcode-protocol-recon.md, section \"Авторизация\") " +
      "before running a turn — this plugin never registers a provider itself.",
  );
}

/**
 * Pull the real session id out of a `session/create` result.
 *
 * `result.projection.sessionId` holds the literal string `"unknown"` at
 * create time (docs/zcode-protocol-recon.md's "Ловушка") — it must never be
 * read from here, only `result.session.sessionId`.
 * @param {any} created result of `session/create`
 * @returns {string}
 * @throws {Error} if `session.sessionId` is missing or not a string
 */
function extractSessionId(created) {
  const sessionId = created?.session?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(
      "session/create did not return a usable session.sessionId " +
        `(got session=${JSON.stringify(created?.session)}). ` +
        "Note: result.projection.sessionId is a known \"unknown\" placeholder and must never be used instead.",
    );
  }
  return sessionId;
}

/**
 * Thin wrapper around `workspace/readState` — used both as the preflight
 * check inside `runTurn()` and standalone for diagnostics (e.g. a `/status`
 * command checking whether `zcode login` is still needed).
 * @param {{ cli: import("./locate.mjs").ResolvedCli, workspace: import("./locate.mjs").WorkspaceRef,
 *   clientOptions?: import("./protocol.mjs").ZCodeProtocolClientOptions }} args
 * @returns {Promise<any>}
 */
export async function readWorkspaceState({ cli, workspace, clientOptions = {} }) {
  const client = new ZCodeProtocolClient(cli, clientOptions);
  try {
    client.start();
    return await client.call("workspace/readState", { workspace });
  } finally {
    try {
      await client.close();
    } catch {
      // Best-effort cleanup — nothing else to do if close() itself fails.
    }
  }
}

/**
 * Build the `{type, params}` -> normalized progress event mapping for
 * `onProgress` (requirement 7).
 *
 * `params` is NOT one uniform shape here — see docs/zcode-protocol-recon.md,
 * section "Два класса сообщений — не путать" (confirmed against a live
 * server by dumping `Object.keys(params)` per event type). There are two
 * distinct message classes on the wire, not one shape with an optional
 * wrapper:
 *   - session events (`model.streaming`, `turn.*`, `session.*`) arrive in a
 *     full envelope (`eventId`, `seq`, `turnId`, `traceId`, `timestamp`,
 *     `deliveryKind`, ...) with the type-specific data nested under
 *     `payload`;
 *   - `state.updated` is a state-sync message with a *different*, flatter
 *     envelope and **no `payload` at all** — `patch`/`reason`/`revision`/
 *     `scope` sit directly on `params`, and there is no `eventId`/`seq`/
 *     `turnId`.
 * Collapsing both to `params.payload ?? params` would happen to work today,
 * but it hides that difference from the next reader, who would reasonably
 * conclude the wrapper is simply optional. So the two classes are branched
 * on explicitly instead.
 * @param {string} type
 * @param {any} params full notification params, shape depends on `type` (see above)
 * @returns {any}
 */
function toProgressEvent(type, params) {
  if (type === "state.updated") {
    // Flat state-sync message — never wrapped in `payload`. A change to
    // e.g. a session's running/idle status shows up as `patch.status`; the
    // human-readable cause (e.g. "prompt_started", "prompt_completed") is
    // `reason`.
    return {
      type,
      reason: params?.reason,
      revision: params?.revision,
      scope: params?.scope,
      patch: params?.patch,
    };
  }
  // model.streaming (and any other session event) — full envelope, data
  // under `payload`.
  const payload = params?.payload ?? {};
  const event = {
    type,
    kind: payload.kind,
    delta: payload.delta,
    done: payload.done,
    assistantMessageId: payload.assistantMessageId,
  };

  // Tool-call visibility (headless-progress requirement): confirmed against
  // a live, logged-in app-server by driving a turn that calls Read/Bash/Edit
  // and dumping every `model.streaming` `payload.kind` actually seen. A tool
  // call's arguments stream in three stages — `tool_input_start` (empty),
  // `tool_input_delta` (a fragment of partial JSON), `tool_input_end`
  // (empty) — and only THEN does a fourth, distinct kind, `tool_call`, arrive
  // carrying `toolName` and the fully-assembled `input` object in one piece
  // (e.g. `{file_path: "..."}` for Read, `{command: "..."}` for Bash). Only
  // `tool_call` is surfaced here: reassembling a stream of partial JSON
  // fragments from `tool_input_delta` is exactly the kind of fragile parsing
  // this project avoids elsewhere (see `explainProtocolError`'s handling of
  // the server's own JSON-string-of-issues), and would just reproduce, by
  // hand, the assembly the server has already done for `tool_call`.
  //
  // These three keys are added only for `kind === "tool_call"` — never
  // unconditionally — so every other kind's event shape (in particular
  // `text_delta`/`reasoning_delta`, pinned by an exact `deepEqual` in
  // tests/session.test.mjs) is completely unaffected.
  if (payload.kind === "tool_call") {
    event.toolCallId = payload.toolCallId ?? payload.id;
    event.toolName = payload.toolName ?? payload.name ?? payload.tool;
    event.input = payload.input ?? payload.arguments ?? payload.args ?? payload.params;
  }

  return event;
}

/**
 * Fetch the session-level usage total via `session/usage` (requirement 1/5 of
 * the follow-up spec — see docs/zcode-protocol-recon.md, "Две разные метрики
 * расхода — не путать"). This is a separate call from the per-turn `usage`
 * that already comes back on `turn.completed.payload.usage`; the two are
 * never merged (see the `RunTurnResult` doc comment above for why).
 *
 * Best-effort: a caller wants the turn's real result/error far more than
 * this metric, so any failure here (timeout, rejection, the session already
 * being gone) is swallowed and reported as `null` rather than replacing or
 * masking the turn's outcome.
 * @param {ZCodeProtocolClient} client
 * @param {string | null} sessionId
 * @returns {Promise<unknown | null>}
 */
async function fetchSessionUsage(client, sessionId) {
  if (!sessionId) return null;
  try {
    return await client.call("session/usage", { sessionId });
  } catch {
    return null;
  }
}

/**
 * Build the client-side handler for the server-initiated
 * `interaction/requestPermission` request — the actual defect this file
 * fixes. ZCode asks permission through this two-way request whenever a tool
 * call (a file write, a shell command, ...) needs sign-off; the *transport*
 * (`protocol.mjs`) has no handler registered for it by default, so an
 * unanswered turn used to get the transport's generic `{}` fallback — which
 * fails this method's own response schema (`decision` is a required enum)
 * and is treated by ZCode as an implicit denial. The turn still reports
 * `resultType: "success"` and exit code 0, because from ZCode's point of view
 * nothing went wrong — it asked, was told (in effect) no, and moved on. That
 * is how `/zcode:code` ran read-only while looking like it succeeded.
 *
 * Policy lives here, in the turn-lifecycle layer, deliberately NOT in
 * `protocol.mjs` — the transport must stay free of opinions about what to
 * grant. See `PERMISSION_POLICIES`/`DEFAULT_PERMISSION_POLICY` above for the
 * default, and `zcode-companion.mjs`'s `handleCode`/`handleReview` for the
 * one caller that currently opts into `"allow"`.
 * @param {"allow" | "deny"} policy
 * @returns {(params: any, message: any) => { decision: "allow" | "deny", reason: string }}
 */
function makeRequestPermissionHandler(policy) {
  if (policy === "allow") {
    return () => ({
      decision: "allow",
      reason: 'Approved by zcode-companion (runTurn permissionPolicy: "allow").',
    });
  }
  return () => ({
    decision: "deny",
    reason: 'Denied by zcode-companion (runTurn permissionPolicy: "deny", the library default).',
  });
}

/**
 * Client-side handler for the server-initiated `interaction/requestUserInput`
 * request (the family `interaction/requestPermission` belongs to — see
 * docs/zcode-protocol-recon.md's two-way request section). `runTurn()` has no
 * human on the other end, ever — this is a headless, one-shot turn — so there
 * is nobody who could ever answer a prompt for free-text input or a
 * multiple-choice question.
 *
 * The reply shape (`{action: "accept"|"decline"|"cancel", content?, reason?}`)
 * was recovered from `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
 * (search for `interactionRequestUserInput` and the zod schema it validates
 * replies against, referred to there as `Fje`:
 * `f.object({action:f.enum(["accept","decline","cancel"]),content:Wu.optional(),reason:f.string().optional()}).strict()`,
 * with `Wu = f.record(f.string(), f.unknown())`). This mirrors the MCP
 * elicitation protocol's own `accept`/`decline`/`cancel` vocabulary, where
 * `"decline"` means "the requester was reached and explicitly said no" (as
 * opposed to `"cancel"`, "the request was abandoned/dismissed without an
 * answer either way"). `"decline"` is the closer fit for "no interactive
 * input will ever arrive this turn" — it lets ZCode's own flow react to an
 * explicit no (e.g. fall back to a default, or fail that one tool call)
 * rather than treating the whole interaction as aborted.
 *
 * What is NOT independently confirmed: how differently ZCode's *tool-calling*
 * loop (as opposed to the elicitation plumbing this schema was lifted from)
 * actually branches on `"decline"` vs `"cancel"` for every possible caller of
 * `interaction/requestUserInput` (e.g. `askUserQuestion` vs a plan-approval
 * prompt vs others) — only that a schema-valid, semantically-reasonable reply
 * is sent instead of the schema-invalid `{}` this bug report is about. If a
 * future live run shows `"decline"` stalls or mishandles some particular
 * question shape, that is the next thing to reconcile against the bundle.
 * @returns {{ action: "decline", reason: string }}
 */
function requestUserInputHandler() {
  return {
    action: "decline",
    reason: "zcode-companion runs unattended: no interactive input is available for this turn.",
  };
}

/**
 * Run one ZCode turn end to end: preflight -> session/create -> subscribe ->
 * (optional setModel/setMode) -> send -> wait for a terminal event -> close.
 *
 * See docs/zcode-protocol-recon.md's "Жизненный цикл хода" for the sequence
 * this follows, and the unit-3 task spec (requirements 1-12) for exactly
 * which traps this must avoid (no provider registration, sessionId from
 * `session` not `projection`, no stray `workspace` key on
 * subscribe/send/stop/close, cleanup on every exit path).
 *
 * @param {{
 *   cli: import("./locate.mjs").ResolvedCli,
 *   workspace: import("./locate.mjs").WorkspaceRef,
 *   prompt: string,
 *   model?: { providerId: string, modelId: string },
 *   mode?: string,
 *   signal?: AbortSignal,
 *   onProgress?: (event: any) => void,
 *   timeoutMs?: number,
 *   cancelGraceMs?: number,
 *   permissionPolicy?: "allow" | "deny",
 *   heartbeatIntervalMs?: number,
 *   heartbeatProbeTimeoutMs?: number,
 *   deadProbeThreshold?: number,
 *   stallWarnMs?: number,
 *   clientOptions?: import("./protocol.mjs").ZCodeProtocolClientOptions,
 * }} args
 * @param {number} [args.heartbeatIntervalMs] How long the wait loop tolerates
 *   silence (no event of any kind from the server) before actively probing
 *   with `session/usage` — see the "Heartbeat" section above `runTurn` for
 *   why a passive timer alone cannot tell "still working" from "hung".
 *   Defaults to {@link DEFAULT_HEARTBEAT_INTERVAL_MS} (30s). Pass `0` to
 *   disable the whole mechanism (no probes, no `heartbeat` progress events,
 *   no early exit on a dead connection).
 * @param {number} [args.heartbeatProbeTimeoutMs] The probe's own timeout —
 *   short and independent of `timeoutMs` (a hung probe must not itself wait
 *   minutes). Defaults to {@link DEFAULT_HEARTBEAT_PROBE_TIMEOUT_MS} (5s).
 * @param {number} [args.deadProbeThreshold] Consecutive failed/timed-out
 *   probes after which the turn is ended early with a clear error instead of
 *   silently waiting out the rest of `timeoutMs` against a server that has
 *   already stopped answering. Defaults to {@link DEFAULT_DEAD_PROBE_THRESHOLD}
 *   (3). A single failed probe followed by a successful one resets the
 *   counter — one blip is not a dead connection.
 * @param {number} [args.stallWarnMs] How long a live server may go without
 *   `modelRequestCount`/`totalTokens` growing before a `heartbeat` progress
 *   event reports `stalled: true`. Purely advisory — the turn is never ended
 *   for this, since long model "thinking" with no visible progress is normal
 *   (see docs/zcode-protocol-recon.md and `zcode-companion.mjs`'s own timeout
 *   defaults for the 10-15 minute silent stretch this was measured against).
 *   Defaults to {@link DEFAULT_STALL_WARN_MS} (5 minutes).
 * @returns {Promise<RunTurnResult>}
 */
export async function runTurn({
  cli,
  workspace,
  prompt,
  model,
  mode,
  signal,
  onProgress,
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
  permissionPolicy = DEFAULT_PERMISSION_POLICY,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  heartbeatProbeTimeoutMs = DEFAULT_HEARTBEAT_PROBE_TIMEOUT_MS,
  deadProbeThreshold = DEFAULT_DEAD_PROBE_THRESHOLD,
  stallWarnMs = DEFAULT_STALL_WARN_MS,
  clientOptions = {},
}) {
  if (!PERMISSION_POLICIES.includes(permissionPolicy)) {
    throw new Error(
      `runTurn: invalid permissionPolicy ${JSON.stringify(permissionPolicy)} — ` +
        `must be one of ${JSON.stringify(PERMISSION_POLICIES)}.`,
    );
  }

  const client = new ZCodeProtocolClient(cli, clientOptions);

  // Answer the two server-initiated requests a headless turn is guaranteed to
  // have no human for. Registered before `start()` so there is no window
  // where `interaction/requestPermission` could fall through to
  // `protocol.mjs`'s generic, schema-invalid `{}` default (see
  // `makeRequestPermissionHandler`'s doc comment for why that default is the
  // actual defect this closes).
  client.onRequest("interaction/requestPermission", makeRequestPermissionHandler(permissionPolicy));
  client.onRequest("interaction/requestUserInput", requestUserInputHandler);

  /** @type {Array<{ type: string, params: any }>} */
  const events = [];
  /** @type {string | null} */
  let sessionId = null;

  // Timestamp of the most recent notification of ANY kind (progress or
  // terminal) received from the server — the heartbeat monitor's definition
  // of "silence" (see `createHeartbeatMonitor` above). `null` until the wait
  // loop actually starts (right after `session/send`), which is also where
  // this gets its first real value.
  /** @type {number | null} */
  let lastEventAt = null;

  /** @type {(value: { kind: "completed" | "failed", params: any }) => void} */
  let resolveTerminal;
  const terminalPromise = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  let terminalSettled = false;

  const unsubscribers = [];
  for (const type of PROGRESS_EVENT_TYPES) {
    unsubscribers.push(
      client.on(type, (params) => {
        events.push({ type, params });
        lastEventAt = Date.now();
        safeProgress(onProgress, toProgressEvent(type, params));
      }),
    );
  }
  for (const type of TERMINAL_EVENT_TYPES) {
    unsubscribers.push(
      client.on(type, (params) => {
        events.push({ type, params });
        lastEventAt = Date.now();
        if (terminalSettled) return; // a stray duplicate must not re-resolve
        terminalSettled = true;
        resolveTerminal({ kind: type === "turn.completed" ? "completed" : "failed", params });
      }),
    );
  }

  try {
    client.start();

    // 2. Preflight — see docs/zcode-protocol-recon.md's "Блокер и его
    // решение": fail here, with a direct fix, rather than on session/send.
    const state = await client.call("workspace/readState", { workspace });
    assertProviderConfigured(state);

    // 3. sessionId from `session`, never `projection` (see extractSessionId).
    const created = await client.call("session/create", { workspace });
    sessionId = extractSessionId(created);

    // Everything below runs with a real session on the server. Wrapped so
    // that ANY failure past this point — a rejected setModel/send call, the
    // timeout throw, or the turn.failed throw below — can still attach
    // `sessionUsage` to the error before it reaches the caller (follow-up
    // requirement 4): the session existed and its cost is still knowable
    // even though the turn itself did not succeed.
    try {
      // 5. subscribe/send/setModel/setMode/stop/close take only `sessionId`
      // — `workspace` is not a valid key for any of them.
      await client.call("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });

      // 8. Per-session model override — never touches ZCode's own config.
      if (model) {
        await client.call("session/setModel", { sessionId, model });
      }
      // Per-session ZCode operating mode. Confirmed against the bundled
      // `zcode.cjs` (grep for the literal `["build","edit","plan","yolo"]`
      // enum `session/setMode` validates against) — this is ZCode's own
      // agentic behavior (e.g. `plan` proposes changes without making them),
      // completely orthogonal to this library's `permissionPolicy` above
      // (whether *this client* auto-answers `interaction/requestPermission`
      // requests). `mode` is passed through verbatim and unvalidated here —
      // validating against the four known values is `zcode-companion.mjs`'s
      // job (see its `parseModeFlag`), the same division of labor as
      // `permissionPolicy` is validated here rather than at the transport.
      if (mode) {
        await client.call("session/setMode", { sessionId, mode });
      }

      await client.call("session/send", { sessionId, content: prompt });

      // The wait loop starts now — this is also the heartbeat monitor's
      // t=0 and its baseline for "silence since the last event" (see
      // `createHeartbeatMonitor` above and requirement 1/2 of the self-check
      // spec: an active `session/usage` probe kicks in once nothing has been
      // heard for `heartbeatIntervalMs`, not on a passive timer alone).
      const waitStartedAt = Date.now();
      lastEventAt = waitStartedAt;

      const racers = [terminalPromise.then((result) => ({ type: "terminal", ...result }))];

      let timeoutTimer;
      const timeoutPromise = new Promise((resolve) => {
        timeoutTimer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
        timeoutTimer.unref?.();
      });
      racers.push(timeoutPromise);

      let abortListener;
      if (signal) {
        racers.push(
          new Promise((resolve) => {
            abortListener = () => resolve({ type: "aborted" });
            if (signal.aborted) abortListener();
            else signal.addEventListener("abort", abortListener, { once: true });
          }),
        );
      }

      // requirement 5: heartbeatIntervalMs: 0 disables the mechanism
      // entirely — no timer, no probes, no heartbeat progress events, no
      // early exit.
      const heartbeat =
        heartbeatIntervalMs > 0
          ? createHeartbeatMonitor({
              client,
              sessionId,
              onProgress,
              heartbeatIntervalMs,
              heartbeatProbeTimeoutMs,
              deadProbeThreshold,
              stallWarnMs,
              waitStartedAt,
              getLastEventAt: () => lastEventAt,
            })
          : null;
      if (heartbeat) racers.push(heartbeat.deadPromise);

      const outcome = await Promise.race(racers);
      clearTimeout(timeoutTimer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      // Stop probing the instant the race settles for ANY reason — a
      // terminal event, the real timeout, cancellation, or the heartbeat's
      // own "dead" verdict below. Otherwise a probe already in flight (or
      // scheduled) could keep calling session/usage after the turn is
      // effectively over.
      heartbeat?.stop();

      // requirement 4: a genuinely dead connection ends the turn immediately
      // instead of waiting out the rest of `timeoutMs` for nothing — see
      // `createHeartbeatMonitor`'s doc comment for what counts as "dead".
      if (outcome.type === "dead") {
        throw new Error(
          `ZCode app-server stopped responding: ${outcome.consecutiveFailedProbes} consecutive ` +
            `session/usage probes failed after the turn had been waiting for ${formatDurationMs(outcome.elapsedMs)} ` +
            `(sessionId=${sessionId}). Last probe error: ${outcome.probeError ?? "unknown"}.`,
        );
      }

      // 9. Cancellation: stop, wait briefly for a terminal event, but always
      // report resultType "cancelled" regardless of what (if anything) arrives.
      if (outcome.type === "aborted") {
        try {
          await client.call("session/stop", { sessionId });
        } catch {
          // Best-effort — the turn is being cancelled either way.
        }

        let cancelTimer;
        const graceTimeoutPromise = new Promise((resolve) => {
          cancelTimer = setTimeout(() => resolve({ type: "timeout" }), cancelGraceMs);
          cancelTimer.unref?.();
        });
        const afterStop = await Promise.race([
          terminalPromise.then((result) => ({ type: "terminal", ...result })),
          graceTimeoutPromise,
        ]);
        clearTimeout(cancelTimer);

        let response = null;
        let usage = null;
        if (afterStop.type === "terminal" && afterStop.kind === "completed") {
          response = afterStop.params?.payload?.response ?? null;
          usage = afterStop.params?.payload?.usage ?? null;
        }
        // Follow-up requirement 4: sessionUsage on the cancellation path too.
        const sessionUsage = await fetchSessionUsage(client, sessionId);
        return { sessionId, response, usage, sessionUsage, events, resultType: "cancelled" };
      }

      if (outcome.type === "timeout") {
        throw new Error(
          `ZCode turn timed out after ${timeoutMs}ms waiting for turn.completed/turn.failed ` +
            `(sessionId=${sessionId}).`,
        );
      }

      // outcome.type === "terminal"
      if (outcome.kind === "failed") {
        // 11. Surface payload.error whole, plus attribution.retryable — no
        // retry logic here, just the flag for the caller to act on.
        const errorPayload = /** @type {TurnErrorPayload} */ (outcome.params?.payload?.error ?? {});
        const err = new Error(errorPayload.message || "ZCode turn failed.");
        err.code = errorPayload.code;
        err.detail = errorPayload.detail;
        err.attribution = errorPayload.attribution;
        err.retryable = errorPayload.attribution?.retryable ?? false;
        err.zcodeTurnError = errorPayload;
        throw err;
      }

      // 6. turn.completed.payload.response is already the whole answer.
      const payload = outcome.params?.payload ?? {};
      // Follow-up requirement 1: a second, independent metric — see the
      // RunTurnResult doc comment above for why this is not merged into
      // `usage`.
      const sessionUsage = await fetchSessionUsage(client, sessionId);
      return {
        sessionId,
        response: payload.response ?? null,
        usage: payload.usage ?? null,
        sessionUsage,
        events,
        resultType: payload.resultType ?? "completed",
      };
    } catch (err) {
      // Follow-up requirement 4: attach sessionUsage to the error itself —
      // once this throws, the caller has no other way to learn what the
      // (failed or timed-out) turn's session cost.
      err.sessionUsage = await fetchSessionUsage(client, sessionId);
      throw err;
    }
  } finally {
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Never let listener teardown mask the real outcome.
      }
    }

    // 10. Cleanup on every exit path — success, thrown error, or cancellation.
    if (sessionId) {
      try {
        await client.call("session/close", { sessionId });
      } catch {
        // Best-effort — must not shadow the primary result/error.
      }
    }
    try {
      await client.close();
    } catch {
      // Best-effort — nothing else to do if close() itself fails.
    }
  }
}
