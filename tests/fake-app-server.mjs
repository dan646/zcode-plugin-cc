#!/usr/bin/env node
/**
 * Fake `<cli> app-server` for testing ZCodeProtocolClient without spawning
 * the real ZCode CLI. Speaks the same newline-delimited JSON transport and
 * exercises the behaviors protocol.mjs must handle: plain success/error
 * responses, a ZodError-shaped error payload, a server-initiated request the
 * client must answer, notifications (including noisy channels that should be
 * filtered by the client), a response split across two stdout writes, an
 * unanswered method (for timeout tests), an unconditional crash (for
 * "process dies while calls are pending" tests), and raw non-envelope lines
 * (for the "malformed line must not crash the client" tests).
 *
 * This fixture also enforces the parts of the real server's contract that a
 * transport bug could otherwise violate silently:
 *   - it refuses to run unless invoked with the `app-server` subcommand,
 *     the same way the real CLI distinguishes the protocol server from its
 *     interactive TUI (docs/zcode-protocol-recon.md, "Транспорт");
 *   - it rejects any incoming message carrying a `jsonrpc` field, the same
 *     way the real server does (-32600 "Invalid ZCode Protocol message");
 *   - it validates that the client's reply to `session/requestRuntimePreferences`
 *     actually carries a boolean `nativeSearchEnhancementsEnabled`, rather
 *     than accepting anything shaped like a reply;
 *   - it validates that *every* reply to *any* server-initiated request is a
 *     structurally valid envelope — exactly one of `result`/`error`, `error`
 *     (when present) an object with a numeric `code` — not just replies to
 *     `session/requestRuntimePreferences`. See `assertValidReplyEnvelope`.
 * A prior version of this fixture ignored argv and accepted any reply as
 * valid, which is why 20 green tests never caught protocol.mjs's `start()`
 * omitting `app-server` entirely. A later version validated replies only for
 * the one method it had a specific shape check for, which is why it could
 * not have caught `JSON.stringify` silently dropping `result` for any other
 * server-initiated request (round 2 defect #2).
 *
 * Every case is driven by the `method` name of the incoming request, so a
 * single fixture process serves every test in tests/protocol.test.mjs.
 */
import readline from "node:readline";

if (!process.argv.includes("app-server")) {
  process.stderr.write('fake-app-server: refusing to start without the "app-server" argument\n');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

/** @type {Map<string, (reply: any) => void>} */
const pendingServerRequests = new Map();
let nextServerRequestId = 1;

// --- Unit-3 turn-lifecycle scenarios -------------------------------------
//
// `session.mjs` drives a full turn: workspace/readState -> session/create ->
// session/subscribe -> [session/setModel] -> session/send -> event stream ->
// session/close. The scenario is picked from `workspace.workspacePath`
// (`/scenario/<name>`, built via `workspaceRef()` in the tests) and is
// remembered per-sessionId from `session/create` onward, since later calls
// (`subscribe`/`send`/`stop`/`close`) carry only `sessionId`, never
// `workspace` — matching the real protocol's params, which reject an extra
// `workspace` key on those methods.
//
// A `workspace` shaped like `{}` (no `workspacePath` string) yields `null`
// here, which keeps `session/create`/`session/send` on their original,
// pre-unit-3 behavior below — this is what protects the older
// tests/protocol.test.mjs assertions (`created.sessionId === "fake-session-1"`)
// from this extension.
//
// Recognized scenarios: success, failure, no-providers, timeout, stop,
// usage-fail, permission, user-input (see scheduleTurnEvents, the
// `session/send` case's own `interaction/*` branches, and the session/usage
// case below), plus four heartbeat-specific scenarios (see both places
// below): heartbeat-growth, heartbeat-flaky, heartbeat-dead. Like "timeout",
// all three never emit a terminal event on their own — the heartbeat tests in
// tests/session.test.mjs control the run's end via `timeoutMs` instead, so
// the fixture doesn't need to model a real completion for them.
/**
 * @param {any} workspace
 * @returns {string | null}
 */
function scenarioFromWorkspace(workspace) {
  const p = workspace?.workspacePath;
  if (typeof p !== "string") return null;
  const match = /^\/scenario\/([a-z-]+)/.exec(p);
  return match ? match[1] : null;
}

/** @type {Map<string, string>} sessionId -> scenario name */
const sessionScenarios = new Map();
/** @type {Map<string, string[]>} sessionId -> ordered list of requestRuntimePreferences scopes answered */
const scopesSeenBySession = new Map();
/** @type {Map<string, number>} sessionId -> number of `session/usage` calls seen so far (1-based on
 * first call) — used by the heartbeat scenarios (heartbeat-flaky, heartbeat-growth) below to vary
 * their reply per call. */
const usageCallCountBySession = new Map();
let sessionCounter = 0;
let eventSeqCounter = 0;

/**
 * Emit a *session event*-shaped notification the way the real server does:
 * envelope fields (`eventId`, `seq`, `sessionId`, `turnId`, `traceId`,
 * `timestamp`, `type`, `deliveryKind`) at the top level, everything
 * type-specific under `payload` — see docs/zcode-protocol-recon.md's
 * "turn.completed.payload.response" / "payload.error" wording.
 *
 * This is only for the session-event class (`turn.*`, `model.streaming`,
 * `session.*`) — see docs/zcode-protocol-recon.md, "Два класса сообщений —
 * не путать". `state.updated` is a *different* message class with no
 * `payload` and no `eventId`/`seq`/`turnId`; it is emitted by
 * `emitStateUpdated` below, never through this function.
 * @param {string} sessionId
 * @param {string} type
 * @param {any} payload
 */
function emitEvent(sessionId, type, payload) {
  eventSeqCounter += 1;
  send({
    method: "session/event",
    params: {
      type,
      eventId: `evt-${eventSeqCounter}`,
      seq: eventSeqCounter,
      sessionId,
      turnId: `turn-${sessionId}`,
      traceId: `trace-${sessionId}`,
      timestamp: Date.now(),
      deliveryKind: "desktop-continuous",
      payload,
    },
  });
}

/**
 * Emit a `state.updated` notification the way the real server does: a flat
 * message with **no `payload` wrapper** and none of the session-event
 * envelope fields (`eventId`, `seq`, `turnId`, `traceId`, `timestamp`,
 * `deliveryKind`) — confirmed against a live server by dumping
 * `Object.keys(params)` per event type (docs/zcode-protocol-recon.md, "Два
 * класса сообщений — не путать"). `patch`/`reason`/`revision`/`scope` sit
 * directly on `params`, alongside `sessionId`/`type`/`workspace`.
 *
 * A prior version of this fixture wrapped `state.updated` in `payload` via
 * `emitEvent` above, modeling a server behavior that does not exist — the
 * same class of fixture/reality drift already caught twice elsewhere in this
 * test suite.
 * @param {string} sessionId
 * @param {{ patch: any, reason: string, revision: number, scope: string }} fields
 */
function emitStateUpdated(sessionId, { patch, reason, revision, scope }) {
  send({
    method: "session/event",
    params: {
      type: "state.updated",
      sessionId,
      patch,
      reason,
      revision,
      scope,
      workspace: null,
    },
  });
}

/**
 * Schedule the event stream for a turn, per scenario:
 *   - "success": state.updated -> model.streaming (x2) -> turn.completed
 *   - "failure": state.updated -> model.streaming (x2) -> turn.failed (retryable)
 *   - "timeout": nothing is ever emitted — the caller must time out
 *   - "stop": a single model.streaming delta, then silence until the client
 *     calls session/stop (handled in the switch below), which is the only
 *     thing that ever produces a terminal event for this scenario.
 *   - "usage-fail": identical event stream to "success" — only `session/usage`
 *     behaves differently for this scenario (see the `session/usage` case
 *     below), to exercise the caller's fallback when that call fails.
 *   - "tool-call": identical to "success", plus one extra `model.streaming`
 *     event with `kind: "tool_call"` between the two text deltas — the shape
 *     confirmed against a live app-server (see zcode-companion.mjs's
 *     `formatToolCallLine` doc comment) that carries a tool's name and its
 *     fully-assembled arguments in one message.
 * @param {string} sessionId
 * @param {string} scenario
 * @param {() => string[]} getScopesSeen
 */
function scheduleTurnEvents(sessionId, scenario, getScopesSeen) {
  if (
    scenario === "timeout" ||
    scenario === "heartbeat-growth" ||
    scenario === "heartbeat-flaky" ||
    scenario === "heartbeat-dead"
  ) {
    // Never emit a terminal event — the heartbeat tests drive these purely
    // through `runTurn`'s `timeoutMs`/liveness monitor, not a real
    // completion (see the "Unit-3 turn-lifecycle scenarios" comment above).
    return;
  }

  if (scenario === "stop") {
    setTimeout(
      () =>
        emitEvent(sessionId, "model.streaming", {
          assistantMessageId: "m1",
          delta: "Thinking about it",
          done: false,
          kind: "reasoning_delta",
        }),
      10,
    );
    return;
  }

  setTimeout(
    () =>
      emitStateUpdated(sessionId, {
        patch: { status: "running" },
        reason: "prompt_started",
        revision: 1,
        scope: "session",
      }),
    5,
  );
  setTimeout(
    () =>
      emitEvent(sessionId, "model.streaming", {
        assistantMessageId: "m1",
        delta: "Hel",
        done: false,
        kind: "reasoning_delta",
      }),
    10,
  );
  setTimeout(
    () =>
      emitEvent(sessionId, "model.streaming", {
        assistantMessageId: "m1",
        delta: "lo!",
        done: true,
        kind: "text_delta",
      }),
    15,
  );

  if (scenario === "tool-call") {
    setTimeout(
      () =>
        emitEvent(sessionId, "model.streaming", {
          assistantMessageId: "m1",
          delta: "",
          done: false,
          kind: "tool_call",
          toolCallId: "call_fake1",
          toolName: "Bash",
          input: { command: "wc -l notes.txt", description: "Count lines in notes.txt" },
        }),
      17,
    );
  }

  // --- Issue #4: alternative field forms for tool-call progress events ---
  // Each scenario emits one `kind: "tool_call"` event using a single
  // alternative field name instead of the canonical one, so tests can verify
  // that lib/session.mjs's fallback chains (toolCallId ?? id, toolName ??
  // name ?? tool, input ?? arguments ?? args ?? params) normalize every form.
  // Removing any chain makes the corresponding test fail.
  if (scenario.startsWith("tool-call-")) {
    const form = scenario.slice("tool-call-".length);
    const altPayloads = {
      id: { id: "call_id_form", toolName: "Bash", input: { command: "echo id-form" } },
      name: { toolCallId: "call_name_form", name: "Read", input: { file_path: "/src/test.js" } },
      tool: { toolCallId: "call_tool_form", tool: "Glob", input: { pattern: "*.js" } },
      arguments: { toolCallId: "call_arguments_form", toolName: "Bash", arguments: { command: "echo arguments" } },
      args: { toolCallId: "call_args_form", toolName: "Bash", args: { command: "echo args" } },
      params: { toolCallId: "call_params_form", toolName: "Bash", params: { command: "echo params" } },
      "no-name": { toolCallId: "call_no_name_form", input: { command: "echo no-name" } },
    };
    const fields = altPayloads[form];
    if (fields) {
      setTimeout(
        () =>
          emitEvent(sessionId, "model.streaming", {
            assistantMessageId: "m1",
            delta: "",
            done: false,
            kind: "tool_call",
            ...fields,
          }),
        17,
      );
    }
  }

  if (scenario === "failure") {
    setTimeout(
      () =>
        emitEvent(sessionId, "turn.failed", {
          error: {
            type: "model_error",
            code: "E_MODEL_UNAVAILABLE",
            message: "The model provider rejected the request.",
            detail: "upstream rate limit exceeded",
            attribution: { source: "provider", reason: "rate_limit", retryable: true },
          },
          debugScopesSeen: getScopesSeen(),
        }),
      20,
    );
  } else {
    setTimeout(
      () =>
        emitEvent(sessionId, "turn.completed", {
          response: "Hello!",
          tokenCount: 42,
          usage: {
            source: "model",
            modelRequestCount: 1,
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            webFetchRequests: 0,
            webSearchRequests: 0,
          },
          toolCallCount: 0,
          historyRoundCount: 1,
          duration: 100,
          resultType: "completed",
          cacheStats: {},
          debugScopesSeen: getScopesSeen(),
        }),
      20,
    );
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

/** Write a raw line to stdout, bypassing JSON.stringify — for emitting
 * deliberately non-envelope scalars (`null`, `123`, `[]`, `"str"`). */
function sendRaw(text) {
  process.stdout.write(text + "\n");
}

/**
 * Structural check applied to *every* reply this fixture receives for a
 * server-initiated request, regardless of method: it must be one of the two
 * response envelope shapes from docs/zcode-protocol-recon.md's "Транспорт"
 * section — `{id, result}` xor `{id, error}`, with `error` (when present) an
 * object carrying a numeric `code`. A client bug that produces a truncated
 * envelope — e.g. `{"id":"srv1"}` with neither `result` nor `error`, from
 * `JSON.stringify` silently dropping an unserializable `result` value — must
 * be caught here even for a method this fixture has no special-cased shape
 * check for. A prior version of this function only validated replies to
 * `session/requestRuntimePreferences`, so it could not have caught that bug
 * for any other server-initiated request.
 * @param {any} reply
 */
function assertValidReplyEnvelope(reply) {
  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
    throw new Error(`fake-app-server: reply is not an object: ${JSON.stringify(reply)}`);
  }
  const hasResult = "result" in reply;
  const hasError = "error" in reply;
  if (hasResult === hasError) {
    throw new Error(
      `fake-app-server: reply must carry exactly one of "result"/"error", got: ${JSON.stringify(reply)}`,
    );
  }
  if (hasError) {
    const err = reply.error;
    if (typeof err !== "object" || err === null || Array.isArray(err) || typeof err.code !== "number") {
      throw new Error(
        `fake-app-server: reply "error" must be an object with a numeric code, got: ${JSON.stringify(reply)}`,
      );
    }
  }
}

/**
 * The one server-initiated request the real protocol sends unconditionally
 * during the turn lifecycle. A client that answers with a `result` must
 * carry a proper `{ nativeSearchEnhancementsEnabled: boolean }` — anything
 * else (missing the flag, wrong type) is broken in a way that would silently
 * stall a real turn, so this fixture fails loudly (an uncaught throw,
 * non-zero exit) instead of accepting anything shaped like a `result`.
 * A well-formed `{id, error}` reply is a legitimate answer too (e.g. when the
 * client's own handler failed and it correctly reported that instead of
 * hanging — see defect #5) and is not held to the `result` shape.
 * @param {any} reply
 */
function assertValidRuntimePreferencesReply(reply) {
  if (reply && typeof reply === "object" && "error" in reply) return;
  const value = reply?.result?.nativeSearchEnhancementsEnabled;
  if (typeof value !== "boolean") {
    throw new Error(
      "fake-app-server: invalid reply to session/requestRuntimePreferences — " +
        `expected result.nativeSearchEnhancementsEnabled: boolean, got ${JSON.stringify(reply)}`,
    );
  }
}

/**
 * Send a server-initiated request and register a handler for the client's
 * reply. Every reply is checked against `assertValidReplyEnvelope` first,
 * regardless of method; requests named `session/requestRuntimePreferences`
 * additionally get the stricter, method-specific shape check.
 * @param {string} method
 * @param {any} params
 * @param {(reply: any) => void} onReply
 */
function sendServerRequest(method, params, onReply) {
  const requestId = `srv${nextServerRequestId++}`;
  send({ id: requestId, method, params });
  pendingServerRequests.set(requestId, (reply) => {
    assertValidReplyEnvelope(reply);
    if (method === "session/requestRuntimePreferences") {
      assertValidRuntimePreferencesReply(reply);
    }
    onReply(reply);
  });
}

rl.on("line", (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // The real server rejects any message carrying a `jsonrpc` field outright
  // — this is not JSON-RPC 2.0 (docs/zcode-protocol-recon.md, "Транспорт").
  if (message !== null && typeof message === "object" && Object.prototype.hasOwnProperty.call(message, "jsonrpc")) {
    if (message.id !== undefined) {
      send({ id: message.id, error: { code: -32600, message: "Invalid ZCode Protocol message" } });
    }
    return;
  }

  // A reply to a request *we* (the fake server) sent to the client.
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingServerRequests.get(message.id);
    if (resolve) {
      pendingServerRequests.delete(message.id);
      resolve(message);
    }
    return;
  }

  const { id, method, params } = message;

  switch (method) {
    case "test/echo": {
      send({ id, result: { echoed: params } });
      break;
    }

    case "test/zodError": {
      // Mirrors a real ZodError blob: `error.data.message` is a JSON string
      // (not a plain array) containing the issues, and an `invalid_union`
      // issue nests full sub-issue lists in `errors`.
      const issues = [
        {
          code: "invalid_union",
          path: ["provider"],
          errors: [
            [
              {
                code: "invalid_type",
                path: ["provider", "apiKey", "name"],
                expected: "string",
                received: "undefined",
              },
            ],
            [
              {
                code: "unrecognized_keys",
                path: ["provider", "apiKey"],
                keys: ["extra"],
              },
            ],
          ],
        },
      ];
      send({
        id,
        error: {
          code: -32602,
          message: "Invalid params",
          data: { message: JSON.stringify(issues) },
        },
      });
      break;
    }

    case "test/serverRequest": {
      sendServerRequest("session/requestRuntimePreferences", { scope: "test" }, (reply) => {
        send({ id, result: { clientReplied: reply } });
      });
      break;
    }

    case "test/unhandledServerRequest": {
      const requestId = `srv${nextServerRequestId++}`;
      send({ id: requestId, method: "some/unknownMethod", params: {} });
      pendingServerRequests.set(requestId, (reply) => {
        assertValidReplyEnvelope(reply);
        send({ id, result: { clientReplied: reply } });
      });
      break;
    }

    // Same shape as "test/unhandledServerRequest" above, but with a real
    // `interaction/*` method name that neither the client's built-in
    // defaults nor `session.mjs`'s `runTurn` register a handler for (unlike
    // `interaction/requestPermission`/`interaction/requestUserInput`, which
    // now do). Exercises the "an unknown interaction/* request still gets a
    // reply, logged as a loud warning naming the method" requirement without
    // needing a real ZCode-specific method this fixture would have to keep
    // in sync forever.
    case "test/unknownInteractionRequest": {
      const requestId = `srv${nextServerRequestId++}`;
      send({ id: requestId, method: "interaction/browserList", params: {} });
      pendingServerRequests.set(requestId, (reply) => {
        assertValidReplyEnvelope(reply);
        send({ id, result: { clientReplied: reply } });
      });
      break;
    }

    case "test/notify": {
      // Noisy channel: must be filtered from `on()` delivery by default.
      send({ method: "process/mcpTelemetry", params: { noisy: true } });
      // Typed event: dispatched under params.type.
      send({ method: "session/event", params: { type: "turn.started", turnNumber: 1 } });
      // Method-only notification: dispatched under the method name itself.
      send({ method: "session.titleUpdated", params: { title: "hi" } });
      send({ id, result: { ok: true } });
      break;
    }

    case "test/chunked": {
      // Write the JSON response across two separate stdout writes with a
      // delay, so the client must reassemble it from its buffer before
      // parsing — no trailing newline in the first half.
      const payload = JSON.stringify({ id, result: { big: "x".repeat(50) } });
      const mid = Math.floor(payload.length / 2);
      process.stdout.write(payload.slice(0, mid));
      setTimeout(() => {
        process.stdout.write(payload.slice(mid) + "\n");
      }, 30);
      break;
    }

    case "test/invalidEnvelopeThenValid": {
      // Bare JSON scalars and an array all parse successfully but are not
      // valid envelopes — the client must ignore each and keep processing
      // subsequent lines, including the valid response that follows.
      sendRaw("null");
      sendRaw("123");
      sendRaw("[]");
      sendRaw('"str"');
      send({ id, result: { ok: true } });
      break;
    }

    case "test/multibyteSplit": {
      // Emit a response containing a 4-byte UTF-8 character (an emoji), with
      // the underlying write split in the *middle* of that character's byte
      // sequence — not at an ASCII byte boundary, unlike "test/chunked"
      // above. This is the only way to actually exercise whether the
      // client's `proc.stdout.setEncoding("utf8")` correctly buffers a
      // partial multi-byte sequence across two separate "data" events
      // (Node's own StringDecoder does this at the stream level, before
      // `_handleChunk` ever sees the bytes) rather than mangling it.
      const payload = Buffer.from(JSON.stringify({ id, result: { emoji: "\u{1F389}" } }) + "\n", "utf8");
      const emojiStart = payload.indexOf(Buffer.from("\u{1F389}", "utf8"));
      const splitPoint = emojiStart + 2; // inside the 4-byte emoji encoding
      process.stdout.write(payload.subarray(0, splitPoint));
      setTimeout(() => {
        process.stdout.write(payload.subarray(splitPoint));
      }, 30);
      break;
    }

    case "test/timeout": {
      // Deliberately never respond.
      break;
    }

    case "test/crash": {
      // Exit immediately without responding to this or any other pending call.
      process.exit(1);
      break;
    }

    case "workspace/readState": {
      // Unit-3 preflight check: `session.mjs` must refuse to proceed to
      // session/create when modelCatalog.providers is empty (the
      // "zcode-unconfigured" trap from docs/zcode-protocol-recon.md's
      // "Блокер и его решение" section).
      const scenario = scenarioFromWorkspace(params?.workspace);
      if (scenario === "no-providers") {
        send({
          id,
          result: {
            modelCatalog: { available: [], providers: [], revision: 0 },
            settings: {},
            slashCommands: [],
            workspace: params?.workspace,
            model: { current: { modelId: "missing-model", providerId: "zcode-unconfigured" } },
          },
        });
      } else {
        send({
          id,
          result: {
            modelCatalog: {
              available: ["zai/glm-5.3"],
              providers: [{ providerId: "zai", kind: "anthropic" }],
              revision: 1,
            },
            settings: {},
            slashCommands: [],
            workspace: params?.workspace,
            model: { current: { modelId: "glm-5.3", providerId: "zai" } },
          },
        });
      }
      break;
    }

    case "session/create": {
      const scenario = scenarioFromWorkspace(params?.workspace);
      if (!scenario) {
        // Pre-unit-3 shape, kept verbatim for tests/protocol.test.mjs's
        // `created.sessionId === "fake-session-1"` assertion.
        sendServerRequest("session/requestRuntimePreferences", { scope: "runtime-materialization" }, () => {
          send({ id, result: { sessionId: "fake-session-1" } });
        });
        break;
      }

      const sessionId = `fake-session-${++sessionCounter}`;
      sessionScenarios.set(sessionId, scenario);
      scopesSeenBySession.set(sessionId, []);
      sendServerRequest("session/requestRuntimePreferences", { scope: "runtime-materialization" }, () => {
        scopesSeenBySession.get(sessionId)?.push("runtime-materialization");
        send({
          id,
          result: {
            // The real trap (docs/zcode-protocol-recon.md, "Ловушка"):
            // `projection.sessionId` is the literal string "unknown" at
            // create time — a client reading sessionId from there instead of
            // `session.sessionId` must break loudly, not silently.
            session: { sessionId },
            projection: { sessionId: "unknown" },
            protocol: { protocolVersion: 1 },
            runtime: {},
            messages: [],
          },
        });
      });
      break;
    }

    case "session/subscribe": {
      send({ id, result: { eventSeq: 0, events: [] } });
      break;
    }

    case "session/setModel": {
      const model = params?.model;
      if (!model || typeof model.modelId !== "string" || typeof model.providerId !== "string") {
        send({
          id,
          error: {
            code: -32602,
            message: "Invalid params",
            data: {
              message: JSON.stringify([
                { code: "invalid_type", path: ["model", "modelId"], expected: "string", received: typeof model?.modelId },
              ]),
            },
          },
        });
      } else {
        send({ id, result: { ok: true } });
      }
      break;
    }

    case "session/setMode": {
      send({ id, result: { ok: true } });
      break;
    }

    case "session/send": {
      const sessionId = params?.sessionId;
      const scenario = sessionScenarios.get(sessionId);
      sendServerRequest("session/requestRuntimePreferences", { scope: "user-execution" }, () => {
        if (scenario) scopesSeenBySession.get(sessionId)?.push("user-execution");
        send({ id, result: { accepted: true, sessionId: sessionId ?? "fake-session-1", stateRevision: 1 } });

        // "permission" / "user-input" model the actual defect this project
        // is fixing: a real tool call blocked on a two-way
        // `interaction/requestPermission` (or `interaction/requestUserInput`)
        // request mid-turn. The client's reply is echoed back on
        // `turn.completed.payload.debugInteractionReply` so tests can assert
        // on exactly what `session.mjs`'s handler answered, the same way
        // `debugScopesSeen` lets other scenarios assert on the
        // requestRuntimePreferences round trips.
        if (scenario === "permission") {
          sendServerRequest(
            "interaction/requestPermission",
            { toolName: "write_file", reason: "test scenario: write a file", riskLevel: "medium" },
            (reply) => {
              emitEvent(sessionId, "turn.completed", {
                response: reply.result?.decision === "allow" ? "wrote the file" : "could not write the file",
                usage: {
                  source: "provider",
                  modelRequestCount: 1,
                  inputTokens: 10,
                  outputTokens: 5,
                  totalTokens: 15,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  reasoningTokens: 0,
                  webFetchRequests: 0,
                  webSearchRequests: 0,
                },
                toolCallCount: 1,
                historyRoundCount: 1,
                duration: 10,
                resultType: "completed",
                cacheStats: {},
                debugInteractionReply: reply,
              });
            },
          );
        } else if (scenario === "user-input") {
          sendServerRequest(
            "interaction/requestUserInput",
            { requestId: "req1", prompt: "Pick one", questions: [] },
            (reply) => {
              emitEvent(sessionId, "turn.completed", {
                response: "handled without a human",
                usage: {
                  source: "provider",
                  modelRequestCount: 1,
                  inputTokens: 10,
                  outputTokens: 5,
                  totalTokens: 15,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  reasoningTokens: 0,
                  webFetchRequests: 0,
                  webSearchRequests: 0,
                },
                toolCallCount: 1,
                historyRoundCount: 1,
                duration: 10,
                resultType: "completed",
                cacheStats: {},
                debugInteractionReply: reply,
              });
            },
          );
        } else if (scenario) {
          scheduleTurnEvents(sessionId, scenario, () => scopesSeenBySession.get(sessionId) ?? []);
        }
      });
      break;
    }

    case "session/stop": {
      const sessionId = params?.sessionId;
      send({ id, result: { stopped: true } });
      const scenario = sessionScenarios.get(sessionId);
      if (scenario === "stop") {
        // Only session/stop ever produces a terminal event for this
        // scenario — simulates a turn that hangs until explicitly cancelled.
        setTimeout(
          () =>
            emitEvent(sessionId, "turn.failed", {
              error: {
                type: "cancelled",
                code: "E_CANCELLED",
                message: "Turn cancelled by client.",
                detail: null,
                attribution: { source: "client", reason: "user_cancelled", retryable: false },
              },
            }),
          10,
        );
      }
      break;
    }

    case "session/usage": {
      // Unit-3 follow-up: `session/usage` must model the SESSION-level shape
      // from docs/zcode-protocol-recon.md's "Две разные метрики расхода — не
      // путать" — `modelErrorCount`, `cacheCreationTokens`,
      // `inputBaselineBySource`, `sessionId` — which is NOT the shape used
      // for `turn.completed.payload.usage` above (`source`,
      // `cacheWriteTokens`, `webFetchRequests`, `webSearchRequests`). Modeling
      // the same shape for both here would hide the real server's behavior
      // from every test built on top of this fixture — exactly the class of
      // fixture/reality drift already caught elsewhere in this file.
      const sessionId = params?.sessionId;
      const scenario = sessionScenarios.get(sessionId);
      const callCount = (usageCallCountBySession.get(sessionId) ?? 0) + 1;
      usageCallCountBySession.set(sessionId, callCount);

      if (scenario === "usage-fail") {
        send({ id, error: { code: -32000, message: "session/usage failed (test scenario)" } });
        break;
      }

      // --- heartbeat-specific behaviors (see the scheduleTurnEvents note) ---
      if (scenario === "heartbeat-dead") {
        // Every probe fails — exercises the "N consecutive failed probes end
        // the turn early" path (`deadProbeThreshold` in lib/session.mjs).
        send({ id, error: { code: -32000, message: "session/usage unavailable (test scenario: heartbeat-dead)" } });
        break;
      }
      if (scenario === "heartbeat-flaky") {
        // The FIRST probe fails, every one after succeeds with fixed counts
        // — exercises "one failed probe followed by a success resets the
        // consecutive-failure counter (does not end the turn)".
        if (callCount === 1) {
          send({
            id,
            error: { code: -32000, message: "session/usage transient failure (test scenario: heartbeat-flaky)" },
          });
          break;
        }
        send({
          id,
          result: {
            sessionId,
            modelRequestCount: 2,
            modelErrorCount: 0,
            totalTokens: 1000,
            inputTokens: 900,
            outputTokens: 100,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            inputBaselineBySource: {},
          },
        });
        break;
      }
      if (scenario === "heartbeat-growth") {
        // modelRequestCount/totalTokens climb on every successful call —
        // exercises "growing counters are reported as progress".
        send({
          id,
          result: {
            sessionId,
            modelRequestCount: callCount,
            modelErrorCount: 0,
            totalTokens: callCount * 1000,
            inputTokens: callCount * 900,
            outputTokens: callCount * 100,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            inputBaselineBySource: {},
          },
        });
        break;
      }

      send({
        id,
        result: {
          sessionId,
          modelRequestCount: 2,
          modelErrorCount: 0,
          totalTokens: 64997,
          inputTokens: 64959,
          outputTokens: 38,
          reasoningTokens: 0,
          cacheReadTokens: 192,
          cacheCreationTokens: 0,
          inputBaselineBySource: { main_turn: 64720 },
        },
      });
      break;
    }

    case "session/close": {
      send({ id, result: { closed: true } });
      break;
    }

    default: {
      // A message with no `id` is a client-to-server *notification* — the
      // real server never replies to those, and replying anyway with
      // `{error, ...}` but no `id` (since `id` is `undefined` here) would
      // itself be an invalid envelope: neither a request, a notification, nor
      // a response. Only reply when this was actually a request.
      if (id !== undefined) {
        send({ id, error: { code: -32601, message: `Unsupported method: ${method}` } });
      }
    }
  }
});
