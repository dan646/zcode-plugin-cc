// Tests for plugins/zcode/scripts/lib/session.mjs — the turn-lifecycle layer
// on top of ZCodeProtocolClient. Everything here talks to
// tests/fake-app-server.mjs (no network, no real ZCode CLI) via the
// `/scenario/<name>` workspace paths that fixture recognizes:
//   success, failure, no-providers, timeout, stop, usage-fail
// See that file's "Unit-3 turn-lifecycle scenarios" section for the wire
// shapes each one produces.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { ZCodeProtocolClient } from "../plugins/zcode/scripts/lib/protocol.mjs";
import { workspaceRef } from "../plugins/zcode/scripts/lib/locate.mjs";
import {
  runTurn,
  readWorkspaceState,
  isProviderConfigured,
  DEFAULT_PERMISSION_POLICY,
} from "../plugins/zcode/scripts/lib/session.mjs";
import { createWriteScopePolicy } from "../plugins/zcode/scripts/lib/write-scope.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fake-app-server.mjs");
const FIXTURE_CLI = { command: process.execPath, args: [FIXTURE_PATH] };

/** @param {string} name */
function scenarioWorkspace(name) {
  return workspaceRef(`/scenario/${name}`);
}

/**
 * Spy on `ZCodeProtocolClient.prototype.call`, recording every
 * `{method, params}` pair sent by *any* client instance for the lifetime of
 * the spy. Needed because `runTurn()`/`readWorkspaceState()` construct their
 * own client internally — there is no other way to observe exactly what they
 * sent, in what order, with what params.
 */
function spyOnCalls() {
  const calls = [];
  const original = ZCodeProtocolClient.prototype.call;
  ZCodeProtocolClient.prototype.call = function (method, params, callOptions) {
    calls.push({ method, params });
    return original.call(this, method, params, callOptions);
  };
  return {
    calls,
    restore() {
      ZCodeProtocolClient.prototype.call = original;
    },
  };
}

/** Spy on `ZCodeProtocolClient.prototype.close`, counting invocations across
 * all instances — the only way to verify requirement 10 (cleanup on every
 * exit path) without reaching into session.mjs's private client. */
function spyOnClose() {
  let count = 0;
  const original = ZCodeProtocolClient.prototype.close;
  ZCodeProtocolClient.prototype.close = function (...args) {
    count += 1;
    return original.apply(this, args);
  };
  return {
    get count() {
      return count;
    },
    restore() {
      ZCodeProtocolClient.prototype.close = original;
    },
  };
}

describe("runTurn — successful path", () => {
  test("resolves with response/usage/sessionId, forwards progress, registers no provider", async () => {
    const callSpy = spyOnCalls();
    const progressEvents = [];
    try {
      const result = await runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("success"),
        prompt: "hi",
        onProgress: (event) => progressEvents.push(event),
      });

      assert.equal(result.resultType, "completed");
      assert.equal(result.response, "Hello!");
      assert.equal(result.usage.totalTokens, 15);

      // Follow-up requirement 1/6: sessionUsage is a distinct, additional
      // field — not a rename or a merge of `usage`.
      assert.ok(result.sessionUsage, "sessionUsage must be present on a successful turn");
      assert.equal(result.sessionUsage.totalTokens, 64997);

      // requirement 3: sessionId comes from `session`, never `projection`
      // (which the fixture sets to the literal "unknown" trap).
      assert.match(result.sessionId, /^fake-session-\d+$/);
      assert.notEqual(result.sessionId, "unknown");

      // requirement 7: onProgress fires for both streaming kinds and for
      // state.updated's status change.
      const streamingKinds = progressEvents.filter((e) => e.type === "model.streaming").map((e) => e.kind);
      assert.deepEqual(streamingKinds, ["reasoning_delta", "text_delta"]);
      assert.ok(progressEvents.some((e) => e.type === "state.updated" && e.reason === "prompt_started"));

      // requirement 4: both requestRuntimePreferences round trips actually
      // happened — the fixture only stamps this list onto turn.completed
      // once *both* scopes have been answered by the client.
      const completedEvent = result.events.find((e) => e.type === "turn.completed");
      assert.ok(completedEvent, "turn.completed must be recorded in events");
      assert.deepEqual(completedEvent.params.payload.debugScopesSeen, [
        "runtime-materialization",
        "user-execution",
      ]);

      // requirement 1: no provider registration/config calls, ever.
      const methods = callSpy.calls.map((c) => c.method);
      assert.ok(!methods.includes("workspace/upsertModelProvider"));
      assert.ok(!methods.includes("workspace/setDefaultModel"));

      // requirement 5: subscribe/send never carry a stray `workspace` key.
      const subscribeCall = callSpy.calls.find((c) => c.method === "session/subscribe");
      assert.deepEqual(Object.keys(subscribeCall.params).sort(), ["deliveryKind", "sessionId"]);
      assert.equal(subscribeCall.params.deliveryKind, "desktop-continuous");
      const sendCall = callSpy.calls.find((c) => c.method === "session/send");
      assert.deepEqual(Object.keys(sendCall.params).sort(), ["content", "sessionId"]);
    } finally {
      callSpy.restore();
    }
  });

  test("calls session/setModel only when a model is given, and never otherwise", async () => {
    const noModelSpy = spyOnCalls();
    try {
      await runTurn({ cli: FIXTURE_CLI, workspace: scenarioWorkspace("success"), prompt: "hi" });
      assert.ok(!noModelSpy.calls.some((c) => c.method === "session/setModel"));
    } finally {
      noModelSpy.restore();
    }

    const withModelSpy = spyOnCalls();
    try {
      const result = await runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("success"),
        prompt: "hi",
        model: { providerId: "zai", modelId: "glm-5.3" },
      });
      assert.equal(result.resultType, "completed");
      const setModelCall = withModelSpy.calls.find((c) => c.method === "session/setModel");
      assert.ok(setModelCall, "session/setModel must be called when model is provided");
      assert.deepEqual(setModelCall.params, {
        sessionId: result.sessionId,
        model: { providerId: "zai", modelId: "glm-5.3" },
      });
    } finally {
      withModelSpy.restore();
    }
  });

  test("calls session/setMode only when a mode is given, including build", async () => {
    const noModeSpy = spyOnCalls();
    try {
      await runTurn({ cli: FIXTURE_CLI, workspace: scenarioWorkspace("success"), prompt: "hi" });
      assert.ok(!noModeSpy.calls.some((c) => c.method === "session/setMode"));
    } finally {
      noModeSpy.restore();
    }

    const withModeSpy = spyOnCalls();
    try {
      const result = await runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("success"),
        prompt: "hi",
        mode: "plan",
      });
      assert.equal(result.resultType, "completed");
      const setModeCall = withModeSpy.calls.find((c) => c.method === "session/setMode");
      assert.ok(setModeCall, "session/setMode must be called when mode is provided");
      assert.deepEqual(setModeCall.params, { sessionId: result.sessionId, mode: "plan" });
    } finally {
      withModeSpy.restore();
    }

    const buildModeSpy = spyOnCalls();
    try {
      const result = await runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("success"),
        prompt: "hi",
        mode: "build",
      });
      const setModeCall = buildModeSpy.calls.find((c) => c.method === "session/setMode");
      assert.ok(setModeCall, "session/setMode must be called for explicit build mode");
      assert.deepEqual(setModeCall.params, { sessionId: result.sessionId, mode: "build" });
    } finally {
      buildModeSpy.restore();
    }
  });

  test("a throwing onProgress does not break the turn", async () => {
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("success"),
      prompt: "hi",
      onProgress: () => {
        throw new Error("boom from onProgress");
      },
    });
    assert.equal(result.resultType, "completed");
    assert.equal(result.response, "Hello!");
  });
});

describe("runTurn — sessionUsage (docs/zcode-protocol-recon.md, \"Две разные метрики расхода — не путать\")", () => {
  test("sessionUsage is a distinct session-level shape, not the turn-level `usage` shape", async () => {
    const result = await runTurn({ cli: FIXTURE_CLI, workspace: scenarioWorkspace("success"), prompt: "hi" });
    assert.equal(result.resultType, "completed");

    // Fields that exist ONLY on the turn-level `usage` (docs table, "поля
    // только здесь" column 1) must be absent from `sessionUsage`.
    assert.equal(result.sessionUsage.source, undefined);
    assert.equal(result.sessionUsage.cacheWriteTokens, undefined);
    assert.equal(result.sessionUsage.webFetchRequests, undefined);
    assert.equal(result.sessionUsage.webSearchRequests, undefined);

    // Fields that exist ONLY on `session/usage` (docs table, "поля только
    // здесь" column 2) must be present on `sessionUsage` and absent from the
    // turn-level `usage`. A fixture bug that models the same shape for both
    // calls (the exact defect class called out in the task) would make these
    // fail because `sessionUsage.modelErrorCount` etc. would be undefined.
    assert.equal(typeof result.sessionUsage.modelErrorCount, "number");
    assert.equal(typeof result.sessionUsage.cacheCreationTokens, "number");
    assert.ok(result.sessionUsage.inputBaselineBySource && typeof result.sessionUsage.inputBaselineBySource === "object");
    assert.equal(result.sessionUsage.sessionId, result.sessionId);

    assert.equal(result.usage.modelErrorCount, undefined);
    assert.equal(result.usage.cacheCreationTokens, undefined);
    assert.equal(result.usage.inputBaselineBySource, undefined);

    // The two calls also disagree on modelRequestCount/totalTokens, matching
    // the live-server measurement in the recon doc (hidden title-generation
    // request).
    assert.notEqual(result.sessionUsage.modelRequestCount, result.usage.modelRequestCount);
    assert.notEqual(result.sessionUsage.totalTokens, result.usage.totalTokens);
  });

  test("sessionUsage is null (not a thrown error) when session/usage fails on an otherwise-successful turn", async () => {
    const result = await runTurn({ cli: FIXTURE_CLI, workspace: scenarioWorkspace("usage-fail"), prompt: "hi" });
    assert.equal(result.resultType, "completed", "the turn's own result must not be affected");
    assert.equal(result.response, "Hello!");
    assert.equal(result.sessionUsage, null);
  });
});

describe("runTurn — preflight", () => {
  test("throws a clear error mentioning zcode login, and never reaches session/create", async () => {
    const callSpy = spyOnCalls();
    try {
      await assert.rejects(
        runTurn({ cli: FIXTURE_CLI, workspace: scenarioWorkspace("no-providers"), prompt: "hi" }),
        /zcode login/,
      );
      assert.ok(!callSpy.calls.some((c) => c.method === "session/create"));
    } finally {
      callSpy.restore();
    }
  });

  test("close() is still called (exactly once) when the preflight check throws", async () => {
    const closeSpy = spyOnClose();
    try {
      await assert.rejects(runTurn({ cli: FIXTURE_CLI, workspace: scenarioWorkspace("no-providers"), prompt: "hi" }));
      assert.equal(closeSpy.count, 1);
    } finally {
      closeSpy.restore();
    }
  });

  test("readWorkspaceState returns the raw workspace/readState result and closes its client", async () => {
    const closeSpy = spyOnClose();
    try {
      const configured = await readWorkspaceState({ cli: FIXTURE_CLI, workspace: scenarioWorkspace("success") });
      assert.equal(isProviderConfigured(configured), true);

      const unconfigured = await readWorkspaceState({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("no-providers"),
      });
      assert.equal(isProviderConfigured(unconfigured), false);
      assert.equal(unconfigured.model.current.providerId, "zcode-unconfigured");

      assert.equal(closeSpy.count, 2);
    } finally {
      closeSpy.restore();
    }
  });
});

describe("runTurn — turn.failed", () => {
  test("surfaces code/message/detail/attribution.retryable, and still cleans up", async () => {
    const closeSpy = spyOnClose();
    const callSpy = spyOnCalls();
    try {
      let caught = null;
      try {
        await runTurn({ cli: FIXTURE_CLI, workspace: scenarioWorkspace("failure"), prompt: "hi" });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "runTurn must reject when the server sends turn.failed");
      assert.equal(caught.code, "E_MODEL_UNAVAILABLE");
      assert.equal(caught.message, "The model provider rejected the request.");
      assert.equal(caught.detail, "upstream rate limit exceeded");
      assert.equal(caught.retryable, true);
      assert.equal(caught.attribution.reason, "rate_limit");

      // Follow-up requirement 4: sessionUsage is attached to the thrown
      // error itself — this is the only place a caller can still see it once
      // the turn has failed.
      assert.ok(caught.sessionUsage, "sessionUsage must be attached to the turn.failed error");
      assert.equal(caught.sessionUsage.modelErrorCount, 0);

      assert.ok(callSpy.calls.some((c) => c.method === "session/close"));
      assert.equal(closeSpy.count, 1);
    } finally {
      closeSpy.restore();
      callSpy.restore();
    }
  });
});

describe("runTurn — mid-turn failure cleanup", () => {
  test("session/close and client.close() still run when session/setModel is rejected mid-turn", async () => {
    const closeSpy = spyOnClose();
    const callSpy = spyOnCalls();
    try {
      await assert.rejects(
        runTurn({
          cli: FIXTURE_CLI,
          workspace: scenarioWorkspace("success"),
          prompt: "hi",
          model: { providerId: "zai" }, // missing modelId — fixture rejects this with -32602
        }),
      );
      // session/send must never have been reached...
      assert.ok(!callSpy.calls.some((c) => c.method === "session/send"));
      // ...but the session that WAS created must still be closed.
      const closeCall = callSpy.calls.find((c) => c.method === "session/close");
      assert.ok(closeCall, "session/close must be called even though the turn never sent");
      assert.match(closeCall.params.sessionId, /^fake-session-\d+$/);
      assert.equal(closeSpy.count, 1);
    } finally {
      closeSpy.restore();
      callSpy.restore();
    }
  });
});

describe("runTurn — timeout", () => {
  test("rejects with a clear message once timeoutMs elapses", { timeout: 5000 }, async () => {
    const callSpy = spyOnCalls();
    try {
      await assert.rejects(
        runTurn({
          cli: FIXTURE_CLI,
          workspace: scenarioWorkspace("timeout"),
          prompt: "hi",
          timeoutMs: 150,
        }),
        /timed out after 150ms/,
      );
      assert.ok(callSpy.calls.some((call) => call.method === "session/stop"), "timeout must stop the remote turn");
    } finally {
      callSpy.restore();
    }
  });
});

describe("runTurn — two message classes (docs/zcode-protocol-recon.md, \"Два класса сообщений — не путать\")", () => {
  test("state.updated progress is read from flat params, never through a payload wrapper", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("success"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    // The wire message itself: state.updated must be flat, with no
    // `payload` and none of the session-event envelope fields. If this
    // regresses (e.g. the fixture starts wrapping it in `payload` again),
    // this is testing the wrong thing before session.mjs even gets a look.
    const rawStateUpdated = result.events.find((e) => e.type === "state.updated");
    assert.ok(rawStateUpdated, "state.updated must be recorded in events");
    assert.equal(rawStateUpdated.params.payload, undefined);
    assert.equal(rawStateUpdated.params.eventId, undefined);
    assert.equal(rawStateUpdated.params.seq, undefined);
    assert.equal(rawStateUpdated.params.turnId, undefined);

    // What onProgress actually handed the caller. Pinned as an exact object
    // (not a `.some()` predicate) so that a regression to reading through
    // `params.payload` — which is `undefined` on this message class — turns
    // every field into `undefined` and fails this assertion outright.
    const stateEvent = progressEvents.find((e) => e.type === "state.updated");
    assert.ok(stateEvent, "onProgress must be called for state.updated");
    assert.deepEqual(stateEvent, {
      type: "state.updated",
      reason: "prompt_started",
      revision: 1,
      scope: "session",
      patch: { status: "running" },
    });
  });

  test("session events (model.streaming) are read from the payload envelope, never flat params", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("success"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    // The wire message: model.streaming carries the full session-event
    // envelope, with the type-specific data nested under `payload` — not
    // flat on `params` the way state.updated is.
    const rawStreaming = result.events.find((e) => e.type === "model.streaming");
    assert.ok(rawStreaming, "model.streaming must be recorded in events");
    assert.equal(typeof rawStreaming.params.eventId, "string");
    assert.equal(typeof rawStreaming.params.seq, "number");
    assert.equal(typeof rawStreaming.params.turnId, "string");
    assert.equal(rawStreaming.params.kind, undefined); // not flat
    assert.equal(rawStreaming.params.delta, undefined); // not flat
    assert.ok(rawStreaming.params.payload && typeof rawStreaming.params.payload === "object");

    // What onProgress actually handed the caller. Pinned as exact objects so
    // that a regression to reading model.streaming flat off `params`
    // (instead of `params.payload`) — which would find nothing, since none
    // of these fields exist outside `payload` — turns every field into
    // `undefined` and fails this assertion.
    const streamingEvents = progressEvents.filter((e) => e.type === "model.streaming");
    assert.deepEqual(streamingEvents, [
      { type: "model.streaming", kind: "reasoning_delta", delta: "Hel", done: false, assistantMessageId: "m1" },
      { type: "model.streaming", kind: "text_delta", delta: "lo!", done: true, assistantMessageId: "m1" },
    ]);
  });
});

describe("runTurn — tool-call progress (headless visibility)", () => {
  test("a model.streaming kind:'tool_call' event surfaces toolName/toolCallId/input on the progress event", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("tool-call"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    const toolCallEvent = progressEvents.find((e) => e.type === "model.streaming" && e.kind === "tool_call");
    assert.ok(toolCallEvent, "onProgress must receive the tool_call event");
    assert.deepEqual(toolCallEvent, {
      type: "model.streaming",
      kind: "tool_call",
      delta: "",
      done: false,
      assistantMessageId: "m1",
      toolCallId: "call_fake1",
      toolName: "Bash",
      input: { command: "wc -l notes.txt", description: "Count lines in notes.txt" },
    });

    // Every OTHER model.streaming kind must be completely unaffected — no
    // stray toolCallId/toolName/input keys leaking onto text/reasoning
    // deltas (this is what the exact deepEqual in the "two message classes"
    // describe block above already pins; this just double-checks the
    // negative here too).
    const textEvent = progressEvents.find((e) => e.type === "model.streaming" && e.kind === "text_delta");
    assert.ok(textEvent);
    assert.equal(textEvent.toolCallId, undefined);
    assert.equal(textEvent.toolName, undefined);
    assert.equal(textEvent.input, undefined);
  });
});

describe("runTurn — cancellation", () => {
  test("aborting mid-turn calls session/stop (sessionId only) and resolves resultType 'cancelled'", { timeout: 5000 }, async () => {
    const callSpy = spyOnCalls();
    const controller = new AbortController();
    try {
      const promise = runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("stop"),
        prompt: "hi",
        signal: controller.signal,
        cancelGraceMs: 300,
        timeoutMs: 1000,
      });
      setTimeout(() => controller.abort(), 40);

      const result = await promise;
      assert.equal(result.resultType, "cancelled");

      // Follow-up requirement 4: sessionUsage is filled on the cancellation
      // path too, not just on a normal completion.
      assert.ok(result.sessionUsage, "sessionUsage must be present on a cancelled turn");

      const stopCall = callSpy.calls.find((c) => c.method === "session/stop");
      assert.ok(stopCall, "session/stop must be called on cancellation");
      assert.deepEqual(Object.keys(stopCall.params), ["sessionId"]);
    } finally {
      callSpy.restore();
    }
  });
});

// --- Regression coverage for the `/zcode:code` write-permission defect -----
//
// The bug: ZCode asks permission through a server-initiated
// `interaction/requestPermission` request; nothing answered it with a
// schema-valid reply, so the transport's generic `{}` fallback (a validation
// failure from ZCode's point of view) was silently treated as a denial —
// while the turn itself still reported `resultType: "success"`. These tests
// drive the fixture's "permission" scenario (see fake-app-server.mjs), which
// echoes the client's actual reply back on
// `turn.completed.payload.debugInteractionReply`, so the assertions below are
// checking the real reply `runTurn` sent over the wire, not a mock.
describe("runTurn — permissionPolicy (interaction/requestPermission)", () => {
  test("defaults to \"deny\" when the caller does not pass permissionPolicy", async () => {
    assert.equal(DEFAULT_PERMISSION_POLICY, "deny");

    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("permission"),
      prompt: "please write a file",
    });

    const completed = result.events.find((e) => e.type === "turn.completed");
    assert.deepEqual(completed.params.payload.debugInteractionReply.result, {
      decision: "deny",
      reason: 'Denied by zcode-companion (runTurn permissionPolicy: "deny", the library default).',
    });
    assert.equal(result.response, "could not write the file");
  });

  test("permissionPolicy: \"allow\" answers interaction/requestPermission with decision: \"allow\"", async () => {
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("permission"),
      prompt: "please write a file",
      permissionPolicy: "allow",
    });

    const completed = result.events.find((e) => e.type === "turn.completed");
    assert.deepEqual(completed.params.payload.debugInteractionReply.result, {
      decision: "allow",
      reason: 'Approved by zcode-companion (runTurn permissionPolicy: "allow").',
    });
    assert.equal(result.response, "wrote the file");
  });

  test("permissionPolicy: \"deny\" answers interaction/requestPermission with decision: \"deny\"", async () => {
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("permission"),
      prompt: "please write a file",
      permissionPolicy: "deny",
    });

    const completed = result.events.find((e) => e.type === "turn.completed");
    assert.equal(completed.params.payload.debugInteractionReply.result.decision, "deny");
  });

  test("a write-scope policy answers Write/ Edit requests through the protocol handler", async () => {
    const policy = createWriteScopePolicy({ cwd: "/scope", allow: ["src/**"] });
    const write = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("permission-write"),
      prompt: "please write a file",
      permissionPolicy: policy,
    });
    const edit = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("permission-edit"),
      prompt: "please edit a file",
      permissionPolicy: policy,
    });
    assert.equal(write.events.find((event) => event.type === "turn.completed").params.payload.debugInteractionReply.result.decision, "allow");
    assert.equal(edit.events.find((event) => event.type === "turn.completed").params.payload.debugInteractionReply.result.decision, "deny");
  });

  test("an invalid permissionPolicy is rejected before any call is made", async () => {
    const callSpy = spyOnCalls();
    try {
      await assert.rejects(
        () =>
          runTurn({
            cli: FIXTURE_CLI,
            workspace: scenarioWorkspace("permission"),
            prompt: "hi",
            permissionPolicy: "escalate",
          }),
        /invalid permissionPolicy/,
      );
      assert.equal(callSpy.calls.length, 0, "no protocol call should happen once permissionPolicy fails validation");
    } finally {
      callSpy.restore();
    }
  });
});

// --- Heartbeat (active liveness self-check while waiting for a turn) -------
//
// See lib/session.mjs's `createHeartbeatMonitor` doc comment for the design:
// during the long silent stretch of a real turn (first 10-15 minutes with no
// streamed output at all), a caller cannot otherwise tell "still working"
// from "the connection died". These scenarios (heartbeat-growth,
// heartbeat-flaky, heartbeat-dead — see fake-app-server.mjs) never emit a
// terminal event on their own, so each test drives the run to its own end
// via a short `timeoutMs`, with small heartbeat thresholds so the whole
// suite stays fast.
describe("runTurn — heartbeat (active liveness self-check)", () => {
  test("silence triggers a session/usage probe, reported as an alive heartbeat event", { timeout: 5000 }, async () => {
    const progressEvents = [];
    await assert.rejects(
      runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("timeout"),
        prompt: "hi",
        timeoutMs: 200,
        heartbeatIntervalMs: 30,
        onProgress: (e) => progressEvents.push(e),
      }),
      /timed out after 200ms/,
    );
    const heartbeats = progressEvents.filter((e) => e.type === "heartbeat");
    assert.ok(heartbeats.length > 0, `expected at least one heartbeat event, got ${JSON.stringify(heartbeats)}`);
    assert.ok(heartbeats.every((e) => e.alive === true));
    assert.ok(heartbeats.every((e) => typeof e.elapsedMs === "number" && e.elapsedMs >= 0));
    assert.ok(heartbeats.every((e) => typeof e.sinceLastEventMs === "number" && e.sinceLastEventMs >= 0));
  });

  test("growing modelRequestCount/totalTokens across probes are reported as progress", { timeout: 5000 }, async () => {
    const progressEvents = [];
    await assert.rejects(
      runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("heartbeat-growth"),
        prompt: "hi",
        timeoutMs: 250,
        heartbeatIntervalMs: 30,
        onProgress: (e) => progressEvents.push(e),
      }),
    );
    const heartbeats = progressEvents.filter((e) => e.type === "heartbeat");
    // The very first probe has nothing to compare against (`progressed`
    // must be `null`, not `false`) — only probes after it can show growth.
    const withComparison = heartbeats.filter((e) => e.progressed !== null);
    assert.ok(withComparison.length > 0, `need at least one probe with a prior comparison: ${JSON.stringify(heartbeats)}`);
    assert.ok(withComparison.every((e) => e.progressed === true));
    assert.ok(withComparison.every((e) => e.stalled === false));
    assert.ok(withComparison.every((e) => (e.modelRequestCountDelta ?? 0) > 0 || (e.totalTokensDelta ?? 0) > 0));
  });

  test("unchanged counters are reported as no progress, then stalled after stallWarnMs", { timeout: 5000 }, async () => {
    const progressEvents = [];
    await assert.rejects(
      runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("timeout"),
        prompt: "hi",
        timeoutMs: 300,
        heartbeatIntervalMs: 30,
        stallWarnMs: 40,
        onProgress: (e) => progressEvents.push(e),
      }),
    );
    const heartbeats = progressEvents.filter((e) => e.type === "heartbeat");
    const withComparison = heartbeats.filter((e) => e.progressed !== null);
    assert.ok(withComparison.length > 0, "need at least one probe with a prior comparison");
    assert.ok(withComparison.every((e) => e.progressed === false), "the fixture's default session/usage reply never changes");
    assert.ok(heartbeats.some((e) => e.stalled === true), `expected a stalled heartbeat: ${JSON.stringify(heartbeats)}`);
  });

  test("three consecutive failed probes end the turn early, naming the reason", { timeout: 5000 }, async () => {
    const start = Date.now();
    await assert.rejects(
      runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("heartbeat-dead"),
        prompt: "hi",
        // Deliberately large — the point is that the heartbeat ends the turn
        // long before this would ever be reached.
        timeoutMs: 5000,
        heartbeatIntervalMs: 30,
        heartbeatProbeTimeoutMs: 500,
        deadProbeThreshold: 3,
      }),
      /stopped responding/,
    );
    assert.ok(
      Date.now() - start < 2000,
      "must end early on 3 consecutive dead probes, not wait out the full 5000ms timeoutMs",
    );
  });

  test("one failed probe followed by a successful one does not end the turn (counter resets)", { timeout: 5000 }, async () => {
    const progressEvents = [];
    await assert.rejects(
      runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("heartbeat-flaky"),
        prompt: "hi",
        timeoutMs: 250,
        heartbeatIntervalMs: 30,
        deadProbeThreshold: 3,
        onProgress: (e) => progressEvents.push(e),
      }),
      // The ordinary timeout, NOT the "stopped responding" early-exit error —
      // one blip must never be enough to end the turn.
      /timed out after 250ms/,
    );
    const heartbeats = progressEvents.filter((e) => e.type === "heartbeat");
    assert.ok(heartbeats.some((e) => e.alive === false), "the one failed probe must be reported");
    assert.ok(
      heartbeats.some((e) => e.alive === true && e.consecutiveFailedProbes === 0),
      "a successful probe after a failure must reset the consecutive-failure counter",
    );
  });

  test("heartbeatIntervalMs: 0 disables the mechanism entirely", { timeout: 5000 }, async () => {
    const callSpy = spyOnCalls();
    const progressEvents = [];
    try {
      await assert.rejects(
        runTurn({
          cli: FIXTURE_CLI,
          workspace: scenarioWorkspace("timeout"),
          prompt: "hi",
          timeoutMs: 100,
          heartbeatIntervalMs: 0,
          onProgress: (e) => progressEvents.push(e),
        }),
      );
      assert.ok(!progressEvents.some((e) => e.type === "heartbeat"));
      // The only `session/usage` call allowed here is the mandatory,
      // heartbeat-independent `fetchSessionUsage` attached to the thrown
      // error (see lib/session.mjs's follow-up requirement 4) — never more
      // than that one.
      const usageCalls = callSpy.calls.filter((c) => c.method === "session/usage");
      assert.ok(usageCalls.length <= 1, `expected no heartbeat-driven session/usage calls, got ${usageCalls.length}`);
    } finally {
      callSpy.restore();
    }
  });

  test("the probe does not interfere with a normal turn reaching turn.completed", async () => {
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("success"),
      prompt: "hi",
      heartbeatIntervalMs: 1,
    });
    assert.equal(result.resultType, "completed");
    assert.equal(result.response, "Hello!");
  });
});

describe("runTurn — externally stopped turns", () => {
  test("a turn with a Write tool call follows AbortSignal through session/stop", { timeout: 5000 }, async () => {
    const controller = new AbortController();
    const progressEvents = [];
    const callSpy = spyOnCalls();
    try {
      const result = await runTurn({
        cli: FIXTURE_CLI,
        workspace: scenarioWorkspace("write-stop"),
        prompt: "hi",
        signal: controller.signal,
        timeoutMs: 1000,
        onProgress: (event) => {
          progressEvents.push(event);
          if (event.kind === "tool_call" && event.toolName === "Write") controller.abort();
        },
      });
      assert.equal(result.resultType, "cancelled");
      assert.ok(progressEvents.some((event) => event.kind === "text_delta" && event.delta === "unfinished visible response"));
      assert.ok(progressEvents.some((event) => event.kind === "tool_call" && event.toolName === "Write"));
      assert.ok(callSpy.calls.some((call) => call.method === "session/stop"));
    } finally {
      callSpy.restore();
    }
  });
});

describe("runTurn — interaction/requestUserInput (headless, no human to answer)", () => {
  test("answers with a schema-valid decline instead of falling through to the transport's {} default", async () => {
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("user-input"),
      prompt: "ask the user something",
    });

    const completed = result.events.find((e) => e.type === "turn.completed");
    const reply = completed.params.payload.debugInteractionReply.result;
    assert.equal(reply.action, "decline");
    assert.equal(typeof reply.reason, "string");
    assert.ok(reply.reason.length > 0);
    assert.equal(result.response, "handled without a human");
  });
});

// --- Issue #4: tool-call fallback chain coverage ---
// The fixture's tool-call-* scenarios each emit a single tool_call event
// using one alternative field form. These tests verify that
// lib/session.mjs's toProgressEvent normalizes every form to the canonical
// field names. Removing any chain (e.g. `?? payload.id`) makes the
// corresponding test fail — zero coverage without them.
describe("runTurn — tool-call fallback chains", () => {
  test("tool-call-id: payload.id is used when toolCallId is absent", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("tool-call-id"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    const ev = progressEvents.find((e) => e.type === "model.streaming" && e.kind === "tool_call");
    assert.ok(ev, "tool_call event must be emitted");
    assert.equal(ev.toolCallId, "call_id_form");
    assert.equal(ev.toolName, "Bash");
    assert.deepEqual(ev.input, { command: "echo id-form" });
  });

  test("tool-call-name: payload.name is used when toolName is absent", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("tool-call-name"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    const ev = progressEvents.find((e) => e.type === "model.streaming" && e.kind === "tool_call");
    assert.ok(ev, "tool_call event must be emitted");
    assert.equal(ev.toolCallId, "call_name_form");
    assert.equal(ev.toolName, "Read");
    assert.deepEqual(ev.input, { file_path: "/src/test.js" });
  });

  test("tool-call-tool: payload.tool is used when toolName and name are absent", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("tool-call-tool"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    const ev = progressEvents.find((e) => e.type === "model.streaming" && e.kind === "tool_call");
    assert.ok(ev, "tool_call event must be emitted");
    assert.equal(ev.toolCallId, "call_tool_form");
    assert.equal(ev.toolName, "Glob");
    assert.deepEqual(ev.input, { pattern: "*.js" });
  });

  test("tool-call-arguments: payload.arguments is used when input is absent", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("tool-call-arguments"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    const ev = progressEvents.find((e) => e.type === "model.streaming" && e.kind === "tool_call");
    assert.ok(ev, "tool_call event must be emitted");
    assert.equal(ev.toolCallId, "call_arguments_form");
    assert.equal(ev.toolName, "Bash");
    assert.deepEqual(ev.input, { command: "echo arguments" });
  });

  test("tool-call-args: payload.args is used when input and arguments are absent", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("tool-call-args"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    const ev = progressEvents.find((e) => e.type === "model.streaming" && e.kind === "tool_call");
    assert.ok(ev, "tool_call event must be emitted");
    assert.equal(ev.toolCallId, "call_args_form");
    assert.equal(ev.toolName, "Bash");
    assert.deepEqual(ev.input, { command: "echo args" });
  });

  test("tool-call-params: payload.params is used when all other input keys are absent", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("tool-call-params"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    const ev = progressEvents.find((e) => e.type === "model.streaming" && e.kind === "tool_call");
    assert.ok(ev, "tool_call event must be emitted");
    assert.equal(ev.toolCallId, "call_params_form");
    assert.equal(ev.toolName, "Bash");
    assert.deepEqual(ev.input, { command: "echo params" });
  });

  // Issue #5: a tool_call event with no tool-name field at all must still
  // surface as a visible fallback line (not silently dropped).
  test("tool-call-no-name: tool_call without any name key surfaces toolName as undefined", async () => {
    const progressEvents = [];
    const result = await runTurn({
      cli: FIXTURE_CLI,
      workspace: scenarioWorkspace("tool-call-no-name"),
      prompt: "hi",
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(result.resultType, "completed");

    const ev = progressEvents.find((e) => e.type === "model.streaming" && e.kind === "tool_call");
    assert.ok(ev, "tool_call event must be emitted even without a name");
    // All three name keys are absent → toolName is undefined (not "null").
    assert.equal(ev.toolName, undefined);
    assert.equal(ev.toolCallId, "call_no_name_form");
    assert.deepEqual(ev.input, { command: "echo no-name" });
  });
});
