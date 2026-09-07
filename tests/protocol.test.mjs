import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, describe, test } from "node:test";

import {
  ZCodeProtocolClient,
  buildAppServerArgs,
  explainProtocolError,
  PROTOCOL_ERROR_CODES,
} from "../plugins/zcode/scripts/lib/protocol.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fake-app-server.mjs");

/** Silence-by-default logger, but captures lines so tests can assert on them. */
function makeLogger() {
  const lines = [];
  const logger = (line) => lines.push(line);
  logger.lines = lines;
  return logger;
}

/** @type {ZCodeProtocolClient[]} */
const clientsToClose = [];

function spawnFakeClient(options = {}) {
  const client = new ZCodeProtocolClient(
    { command: process.execPath, args: [FIXTURE_PATH] },
    { logger: makeLogger(), ...options },
  );
  client.start();
  clientsToClose.push(client);
  return client;
}

/** Read stdout from a raw child process line by line, resolving with each
 * parsed JSON message as it arrives. Used by the fixture-hardening tests
 * below, which talk to fake-app-server.mjs directly instead of going through
 * ZCodeProtocolClient — they are testing the fixture itself (see defect #6:
 * a fixture that validates nothing can't catch a broken client). */
function lineReader(child) {
  let buffer = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(JSON.parse(line));
      newlineIndex = buffer.indexOf("\n");
    }
  });
  return {
    next() {
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

/**
 * Wait for a raw child process to exit, with a timeout — so a fixture
 * regression that fails to crash (and would otherwise leave the process
 * waiting on stdin forever) fails the test loudly instead of hanging the
 * whole suite.
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} [ms]
 * @returns {Promise<{code: number|null, signal: string|null}>}
 */
function waitForExit(child, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fixture did not exit within ${ms}ms — expected it to crash on an invalid reply envelope`));
    }, ms);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

afterEach(async () => {
  while (clientsToClose.length > 0) {
    const client = clientsToClose.pop();
    await client.close();
  }
});

describe("ZCodeProtocolClient", () => {
  test("call() resolves with the server's result", async () => {
    const client = spawnFakeClient();
    const result = await client.call("test/echo", { foo: 1 });
    assert.deepEqual(result, { echoed: { foo: 1 } });
  });

  test("call() rejects with the raw error and explainProtocolError unpacks a nested ZodError", async () => {
    const client = spawnFakeClient();
    await assert.rejects(
      client.call("test/zodError", {}),
      /** @param {any} err */ (err) => {
        assert.equal(err.code, -32602);
        const explained = explainProtocolError(err);
        assert.match(explained, /provider\.apiKey\.name: want string, got undefined/);
        assert.match(explained, /provider\.apiKey: extra \["extra"\]/);
        return true;
      },
    );
  });

  test("explainProtocolError falls back to code+message when there is no issue list", () => {
    const explained = explainProtocolError({ code: -32601, message: "Method not found" });
    assert.match(explained, /-32601/);
    assert.match(explained, /Method not found/);
  });

  test("explainProtocolError never leaks apiKey content", () => {
    const explained = explainProtocolError({
      code: -32603,
      message: 'boom while handling {"apiKey":{"source":"inline","value":"sk-super-secret"}}',
    });
    assert.doesNotMatch(explained, /sk-super-secret/);
  });

  // Round-2 defect #1: a previous version of this file also tried to scan
  // arbitrary error text for `KEY=value` assignments and `Bearer <token>`
  // values. That pattern-matching approach is gone — a tightened pattern was
  // still trivially bypassable (bare `KEY=...`, or `"KEY":` JSON syntax
  // instead of `=`), and a broadened one exhibited quadratic backtracking on
  // adversarial input. `explainProtocolError` now only redacts the one
  // bounded, known-shape case (`"apiKey"` JSON fields — see the test above)
  // and otherwise relies on capping length *before* any regex ever runs, so
  // arbitrary server-supplied text can never cause pathological slowdown —
  // see the two tests below.
  describe("round 2 defect #1: no more regex arms race over arbitrary secret text", () => {
    test("explainProtocolError no longer scrubs KEY=value/Bearer text — only the length cap and the apiKey JSON pattern remain", () => {
      const explained = explainProtocolError({
        code: -32603,
        message: "provider init failed: ZAI_API_KEY=sk-not-scrubbed-1234, Authorization: Bearer sk-also-not-scrubbed",
      });
      // Documenting the accepted trade-off: this text is no longer altered.
      // Secrets must never reach this path as arbitrary text in the first
      // place (see `_logDiag`'s doc comment) — a generic scrubber over
      // freeform text is not a defense this codebase relies on any more.
      assert.match(explained, /ZAI_API_KEY=sk-not-scrubbed-1234/);
      assert.match(explained, /Bearer sk-also-not-scrubbed/);
    });

    test("explainProtocolError caps message length before processing, so a huge adversarial message is still fast", () => {
      // The exact shape cited as a quadratic-backtracking trigger for a
      // broadened env-secret regex: many repeats of a KEY-shaped token with
      // no "=" at all, so a naive fix scanning for "KEY" boundaries would
      // still have to walk the whole string doing failed match attempts.
      const adversarial = "AKEY".repeat(16_000); // 64,000 characters
      const start = performance.now();
      const explained = explainProtocolError({ code: -32603, message: adversarial });
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 200, `expected explainProtocolError to stay fast on a 64k-char message, took ${elapsed}ms`);
      assert.ok(
        explained.length < adversarial.length,
        "the fallback message must be capped, not the full 64k input",
      );
    });
  });

  test("a server-initiated request is answered by the client's default handler", async () => {
    const client = spawnFakeClient();
    const result = await client.call("test/serverRequest", {});
    assert.equal(result.clientReplied.id, "srv1");
    assert.deepEqual(result.clientReplied.result, { nativeSearchEnhancementsEnabled: false });
  });

  test("an unhandled server request gets a default {} reply", async () => {
    const client = spawnFakeClient();
    const result = await client.call("test/unhandledServerRequest", {});
    assert.deepEqual(result.clientReplied.result, {});
  });

  test("an unhandled interaction/* request still gets {} (not a hang), but is logged as a loud warning naming the method", async () => {
    const logger = makeLogger();
    const client = spawnFakeClient({ logger });
    const result = await client.call("test/unknownInteractionRequest", {});

    // The turn is never left hanging — this is still the transport's own
    // fallback, unchanged in shape from the generic case above.
    assert.deepEqual(result.clientReplied.result, {});

    // But unlike a routine diagnostic, this must be unmissable: it names the
    // real method and says outright that the reply may be silently wrong.
    const joined = logger.lines.join("\n");
    assert.match(joined, /WARNING/);
    assert.match(joined, /interaction\/browserList/);
    assert.match(joined, /silently deny|silently wrong|no-op/i);
  });

  test("onRequest() lets the caller override the default handler", async () => {
    const client = spawnFakeClient();
    client.onRequest("session/requestRuntimePreferences", () => ({ nativeSearchEnhancementsEnabled: true }));
    const result = await client.call("test/serverRequest", {});
    assert.deepEqual(result.clientReplied.result, { nativeSearchEnhancementsEnabled: true });
  });

  test("notifications reach on() subscribers, keyed by params.type or method, with noisy channels filtered", async () => {
    const client = spawnFakeClient();

    const turnEvents = [];
    const titleEvents = [];
    const noisyEvents = [];
    client.on("turn.started", (params) => turnEvents.push(params));
    client.on("session.titleUpdated", (params) => titleEvents.push(params));
    client.on("process/mcpTelemetry", (params) => noisyEvents.push(params));

    const result = await client.call("test/notify", {});
    assert.deepEqual(result, { ok: true });

    assert.equal(turnEvents.length, 1);
    assert.equal(turnEvents[0].turnNumber, 1);
    assert.equal(titleEvents.length, 1);
    assert.equal(titleEvents[0].title, "hi");
    assert.equal(noisyEvents.length, 0, "noisy process/mcpTelemetry must be filtered by default");
  });

  test("quietNotificationTypes: [] lets noisy channels through", async () => {
    const client = spawnFakeClient({ quietNotificationTypes: [] });
    const noisyEvents = [];
    client.on("process/mcpTelemetry", (params) => noisyEvents.push(params));
    await client.call("test/notify", {});
    assert.equal(noisyEvents.length, 1);
  });

  test("a thrown notification handler's message never reaches the diagnostic log at all, redacted or not", async () => {
    const logger = makeLogger();
    const client = spawnFakeClient({ logger });
    client.on("turn.started", () => {
      throw new Error("leaking ZAI_API_KEY=sk-handler-secret and Bearer sk-another-handler-secret");
    });
    await client.call("test/notify", {});

    const joined = logger.lines.join("\n");
    // The old contract was "redact the secret in the log line". The new one
    // is stricter: `err.message` from a caller-supplied handler must never
    // be logged in the first place — not verbatim, not redacted, not in any
    // form — because there is no pattern-matching scheme that reliably tells
    // secret-shaped text apart from arbitrary text. Only a safe fact (the
    // error's constructor name) may appear.
    assert.doesNotMatch(joined, /sk-handler-secret/);
    assert.doesNotMatch(joined, /sk-another-handler-secret/);
    assert.doesNotMatch(joined, /ZAI_API_KEY/);
    assert.doesNotMatch(joined, /Bearer/);
    assert.match(joined, /notification handler for "turn\.started" threw \(Error\)/);
  });

  test("call() times out when the server never responds", async () => {
    const client = spawnFakeClient();
    await assert.rejects(client.call("test/timeout", {}, { timeoutMs: 150 }), /Timed out after 150ms/);
  });

  test("process death rejects all pending calls", async () => {
    const client = spawnFakeClient();
    const stuck = client.call("test/timeout", {}, { timeoutMs: 10_000 });
    const crashing = client.call("test/crash", {});

    await assert.rejects(stuck, /exited unexpectedly/);
    await assert.rejects(crashing, /exited unexpectedly/);
  });

  test("a response split across two stdout writes is reassembled before parsing", async () => {
    const client = spawnFakeClient();
    const result = await client.call("test/chunked", {});
    assert.equal(result.big.length, 50);
    assert.equal(result.big, "x".repeat(50));
  });

  test("close() is idempotent and terminates the process", async () => {
    const client = spawnFakeClient();
    await client.call("test/echo", {});
    await client.close();
    await client.close();
    assert.equal(client.closed, true);
    await assert.rejects(client.call("test/echo", {}), /closed/);
  });

  // --- Defect #1: `app-server` must always be passed to spawn() -----------

  describe("defect #1: app-server subcommand", () => {
    test("buildAppServerArgs() always appends the app-server subcommand", () => {
      assert.deepEqual(buildAppServerArgs({ args: [] }), ["app-server"]);
      assert.deepEqual(buildAppServerArgs({ args: ["--foo", "bar"] }), ["--foo", "bar", "app-server"]);
      assert.deepEqual(buildAppServerArgs({}), ["app-server"]);
    });

    test("start() actually spawns the child process with app-server in argv", () => {
      const client = spawnFakeClient();
      assert.ok(
        client.proc.spawnargs.includes("app-server"),
        `expected "app-server" in spawnargs, got: ${JSON.stringify(client.proc.spawnargs)}`,
      );
    });
  });

  // --- Defect #2: secrets must never reach diagnostics ---------------------

  describe("defect #2: secret redaction in diagnostics", () => {
    test("an unparseable stdout line is never logged with its content, only length/position", async () => {
      const logger = makeLogger();
      const client = spawnFakeClient({ logger });
      // Force a raw, deliberately invalid line containing a secret-shaped
      // fragment straight onto the client's stdin-reading path by writing to
      // the underlying stream the client listens on. We do this indirectly:
      // trigger the "chunked" style raw write via the fixture would only
      // produce valid JSON, so instead we exercise _handleChunk directly.
      client._handleChunk('not-json-with-ZAI_API_KEY=sk-super-secret-content\n');
      await new Promise((resolve) => setImmediate(resolve));

      const joined = logger.lines.join("\n");
      assert.doesNotMatch(joined, /sk-super-secret-content/);
      assert.match(joined, /ignoring unparseable line/);
      assert.match(joined, /length=\d+/);
    });

    test("a handler for a server-initiated request that throws a secret-bearing error never logs the secret", async () => {
      const logger = makeLogger();
      const client = spawnFakeClient({ logger });
      client.onRequest("session/requestRuntimePreferences", () => {
        throw new Error("provider init failed: ZAI_API_KEY=sk-serverreq-secret and Bearer sk-serverreq-bearer");
      });
      const result = await client.call("test/serverRequest", {});
      // The error's `message` legitimately travels back to the server in the
      // reply payload itself — that's not a log, it's protocol data.
      assert.match(result.clientReplied.error.message, /sk-serverreq-secret/);

      const joined = logger.lines.join("\n");
      assert.doesNotMatch(joined, /sk-serverreq-secret/);
      assert.doesNotMatch(joined, /sk-serverreq-bearer/);
      assert.doesNotMatch(joined, /ZAI_API_KEY/);
      assert.match(joined, /handler for server request "session\/requestRuntimePreferences" threw \(Error\)/);
    });

    test("_logDiag caps its input length before any regex runs, so a 64k-char adversarial line stays fast", () => {
      const logger = makeLogger();
      const client = spawnFakeClient({ logger });
      // The exact shape the round-2 review cited as a quadratic-backtracking
      // trigger for a broadened env-secret-style regex: no "=" at all, so a
      // naive fix trying to also catch bare `KEY=...` (not just prefixed
      // names) would still walk the whole string doing failed matches.
      const adversarial = "AKEY".repeat(16_000); // 64,000 characters
      const start = performance.now();
      client._logDiag(adversarial);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 200, `expected _logDiag to stay fast on a 64k-char line, took ${elapsed}ms`);
      assert.ok(logger.lines[0].length < adversarial.length, "the logged line must be capped, not the full 64k input");
    });
  });

  // --- Defect #3: a stdin write error must not crash the client -----------

  describe("defect #3: stdin write errors", () => {
    test("an EPIPE-style stdin error rejects pending calls instead of crashing the host process", async () => {
      const client = spawnFakeClient();
      const pending = client.call("test/timeout", {}, { timeoutMs: 10_000 });

      const sawError = new Promise((resolve) => client.proc.stdin.once("error", resolve));
      client.proc.stdin.destroy(new Error("write EPIPE"));
      await sawError;

      await assert.rejects(pending, /EPIPE/);
      // The transport must now report itself unusable cleanly, not hang or
      // throw asynchronously and crash the test runner.
      await assert.rejects(client.call("test/echo", {}), /stdin is not writable|closed/);
    });
  });

  // --- Defect #4: a bare JSON scalar/array must not crash the handler -----

  describe("defect #4: invalid envelope shapes on stdout", () => {
    test("null/number/array/string lines are ignored, and the next valid response still resolves", async () => {
      const client = spawnFakeClient();
      const result = await client.call("test/invalidEnvelopeThenValid", {});
      assert.deepEqual(result, { ok: true });
    });

    test("a bare `null` line logs a diagnostic instead of throwing inside the handler", async () => {
      const logger = makeLogger();
      const client = spawnFakeClient({ logger });
      client._handleChunk("null\n");
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(logger.lines.join("\n"), /invalid ZCode Protocol envelope shape/);
    });
  });

  // --- Defect #5: a server request must always get *some* reply -----------

  describe("defect #5: server requests always get a reply", () => {
    test("a handler returning a circular (unserializable) result still produces an error reply, not a hang", async () => {
      const client = spawnFakeClient();
      client.onRequest("session/requestRuntimePreferences", () => {
        const circular = {};
        circular.self = circular;
        return circular;
      });
      const result = await client.call("test/serverRequest", {});
      assert.ok(result.clientReplied.error, "expected an error envelope in place of the unserializable result");
      assert.equal(result.clientReplied.error.code, PROTOCOL_ERROR_CODES.INTERNAL_ERROR);
    });

    test("a handler that throws still produces a valid error reply", async () => {
      const client = spawnFakeClient();
      client.onRequest("session/requestRuntimePreferences", () => {
        throw new Error("handler boom");
      });
      const result = await client.call("test/serverRequest", {});
      assert.ok(result.clientReplied.error);
      assert.equal(result.clientReplied.error.code, PROTOCOL_ERROR_CODES.INTERNAL_ERROR);
      assert.match(result.clientReplied.error.message, /handler boom/);
    });
  });

  // --- Round 2 defect #2: JSON.stringify silently dropping `result` --------

  describe("round 2 defect #2: JSON.stringify silently losing the result/error field", () => {
    test("a handler returning a function produces an error reply, not a truncated envelope", async () => {
      const client = spawnFakeClient();
      // `JSON.stringify({id, result: fn})` drops the `result` key with no
      // exception — the server would otherwise receive a bare `{"id":...}`,
      // which is none of the four valid envelope shapes and stalls the turn.
      client.onRequest("some/unknownMethod", () => function notSerializable() {});
      const result = await client.call("test/unhandledServerRequest", {});
      assert.ok(result.clientReplied.error, "expected an error envelope, not a fragment missing result/error");
      assert.equal(result.clientReplied.error.code, PROTOCOL_ERROR_CODES.INTERNAL_ERROR);
    });

    test("a handler returning a Symbol() produces an error reply, not a truncated envelope", async () => {
      const client = spawnFakeClient();
      client.onRequest("some/unknownMethod", () => Symbol("not serializable"));
      const result = await client.call("test/unhandledServerRequest", {});
      assert.ok(result.clientReplied.error, "expected an error envelope, not a fragment missing result/error");
      assert.equal(result.clientReplied.error.code, PROTOCOL_ERROR_CODES.INTERNAL_ERROR);
    });

    test("a handler returning undefined still produces a valid, non-fragment reply", async () => {
      const client = spawnFakeClient();
      // `undefined` is coalesced to `{}` before serialization ever happens,
      // so this is not the JSON.stringify-drops-a-key bug — this just checks
      // the common case still yields one of the four valid shapes, not a
      // hang or a fragment.
      client.onRequest("some/unknownMethod", () => undefined);
      const result = await client.call("test/unhandledServerRequest", {});
      assert.deepEqual(result.clientReplied.result, {});
    });
  });

  // --- Round 2 defect #3: envelope validation must match all four shapes ---

  describe("round 2 defect #3: strict envelope validation", () => {
    test("`{id, error: null}` does not resolve the pending call, but the next valid response for the same id does", async () => {
      const client = spawnFakeClient();
      const callPromise = client.call("test/timeout", {}, { timeoutMs: 10_000 });
      const usedId = client.nextId - 1;

      // Simulates the pre-fix bug: `{id, error: null}` used to be accepted
      // as a valid error response and resolved the pending call with `{}`.
      client._handleChunk(JSON.stringify({ id: usedId, error: null }) + "\n");

      let settled = false;
      callPromise.then(
        () => (settled = true),
        () => (settled = true),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "an invalid envelope must not settle the pending call");

      client._handleChunk(JSON.stringify({ id: usedId, result: { ok: true } }) + "\n");
      const result = await callPromise;
      assert.deepEqual(result, { ok: true });
    });

    test("a response carrying both result and error is rejected as invalid, not accepted", async () => {
      const client = spawnFakeClient();
      const callPromise = client.call("test/timeout", {}, { timeoutMs: 10_000 });
      const usedId = client.nextId - 1;

      client._handleChunk(JSON.stringify({ id: usedId, result: { ok: true }, error: { code: -32603 } }) + "\n");

      let settled = false;
      callPromise.then(
        () => (settled = true),
        () => (settled = true),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "a response with both result and error must not settle the pending call");

      client._handleChunk(JSON.stringify({ id: usedId, result: { ok: true } }) + "\n");
      const result = await callPromise;
      assert.deepEqual(result, { ok: true });
    });
  });

  // --- Round 2 defect #4: close() must escalate to SIGKILL after EPIPE -----

  describe("round 2 defect #4: close() waits for the real exit, not just transport failure", () => {
    test("a child that ignores SIGTERM is still SIGKILLed and reaped by close(), even after an earlier stdin EPIPE", async () => {
      // A child that ignores SIGTERM and never touches its own stdin, so an
      // `end()` on it produces no reaction either — the only way it ever
      // exits is via SIGKILL. It reports readiness on stdout so the test
      // doesn't race the child installing its SIGTERM handler.
      const client = new ZCodeProtocolClient(
        {
          command: process.execPath,
          args: [
            "-e",
            "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
          ],
        },
        { logger: makeLogger() },
      );
      client.start();
      clientsToClose.push(client);

      await new Promise((resolve) => {
        const onData = (chunk) => {
          if (String(chunk).includes("ready")) {
            client.proc.stdout.off("data", onData);
            resolve();
          }
        };
        client.proc.stdout.on("data", onData);
      });

      const sawError = new Promise((resolve) => client.proc.stdin.once("error", resolve));
      client.proc.stdin.destroy(new Error("write EPIPE"));
      await sawError;

      // Before the fix, the stdin error alone resolved the promise close()
      // raced against, so close() believed the process had already exited
      // and never escalated to SIGKILL — leaving this child running forever.
      await client.close({ timeoutMs: 100 });

      // close() must not resolve until the process has actually exited —
      // and the only way this particular child ever exits is via SIGKILL.
      assert.equal(client.proc.signalCode, "SIGKILL");
    });
  });

  // --- Round 3 defects #1 and #2: close()/call() must not hang forever when
  // spawn() itself fails (e.g. ENOENT) ---------------------------------------

  describe("round 3 defects #1 and #2: a failed spawn() must not hang the transport", () => {
    // Own timeout: if the fix regresses, `proc.kill()` on a pid-less process
    // has been observed (Node v26.8.1/darwin) to never return at all — the
    // call itself blocks, not just a promise. A per-test timeout at least
    // ensures the test *runner* fails loudly instead of this one test taking
    // the entire suite down with it silently.
    test(
      "close() resolves promptly even when the CLI binary does not exist",
      { timeout: 5000 },
      async () => {
        const client = new ZCodeProtocolClient(
          { command: "/nonexistent/zcode-binary-that-does-not-exist", args: [] },
          { logger: makeLogger() },
        );
        client.start();
        await client.close({ timeoutMs: 200 });
        assert.equal(client.closed, true);
      },
    );

    test(
      "call() on a client whose spawn() failed rejects instead of hanging forever",
      { timeout: 5000 },
      async () => {
        const client = new ZCodeProtocolClient(
          { command: "/nonexistent/zcode-binary-that-does-not-exist", args: [] },
          { logger: makeLogger() },
        );
        client.start();
        clientsToClose.push(client);
        await assert.rejects(client.call("test/echo", {}), /Failed to start ZCode CLI/);
      },
    );

    test(
      "_processExitPromise settles even though no 'exit' event is ever emitted for a failed spawn",
      { timeout: 5000 },
      async () => {
        const client = new ZCodeProtocolClient(
          { command: "/nonexistent/zcode-binary-that-does-not-exist", args: [] },
          { logger: makeLogger() },
        );
        client.start();
        clientsToClose.push(client);
        // If `_processExitPromise` is never resolved for this case, this
        // `await` hangs forever — the per-test timeout above is what turns
        // that into a clean failure instead of wedging the whole run.
        await client._processExitPromise;
        assert.ok(true, "_processExitPromise settled");
      },
    );
  });

  // --- Round 3 defect #3: unbounded stderr accumulation --------------------

  describe("round 3 defect #3: stderr is capped, not accumulated without bound", () => {
    test("stderrByteCount tracks total length while stderrTail stays bounded", async () => {
      const client = new ZCodeProtocolClient(
        {
          command: process.execPath,
          args: [
            "-e",
            "for (let i = 0; i < 20; i++) process.stderr.write('x'.repeat(1000)); " +
              "process.stdout.write(JSON.stringify({method:'done'})+'\\n');",
          ],
        },
        { logger: makeLogger() },
      );
      client.start();
      clientsToClose.push(client);

      await new Promise((resolve) => {
        const onData = (chunk) => {
          if (String(chunk).includes('"done"')) {
            client.proc.stdout.off("data", onData);
            resolve();
          }
        };
        client.proc.stdout.on("data", onData);
      });
      // Give the stderr "data" events a moment to land too.
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(client.stderrByteCount, 20_000);
      assert.ok(
        client.stderrTail.length <= 4096,
        `expected stderrTail to stay bounded, got length ${client.stderrTail.length}`,
      );
    });
  });

  // --- Round 3 defect #4: strict-type pending lookup, with a fallback ------

  describe("round 3 defect #4: pending lookup tolerates an id type mismatch", () => {
    test("a response whose id arrives as a string still resolves a call sent with a numeric id", async () => {
      const client = spawnFakeClient();
      const callPromise = client.call("test/timeout", {}, { timeoutMs: 10_000 });
      const usedId = client.nextId - 1;
      assert.equal(typeof usedId, "number");

      // Simulate a server that echoes the id back as a string instead of
      // preserving its numeric type.
      client._handleChunk(JSON.stringify({ id: String(usedId), result: { ok: true } }) + "\n");
      const result = await callPromise;
      assert.deepEqual(result, { ok: true });
    });

    test("the fallback lookup does not resolve the wrong call when ids merely share a string form", async () => {
      const client = spawnFakeClient();
      const callPromise = client.call("test/timeout", {}, { timeoutMs: 10_000 });
      const usedId = client.nextId - 1;

      // An unrelated id that happens not to collide should not resolve this
      // pending call.
      client._handleChunk(JSON.stringify({ id: String(usedId + 1000), result: { wrong: true } }) + "\n");

      let settled = false;
      callPromise.then(
        () => (settled = true),
        () => (settled = true),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "an unrelated id must not resolve this call");

      client._handleChunk(JSON.stringify({ id: usedId, result: { ok: true } }) + "\n");
      assert.deepEqual(await callPromise, { ok: true });
    });
  });

  // --- Round 3 defect #5: a server-request handler that never settles ------

  describe("round 3 defect #5: server-request handlers are bound by a timeout", () => {
    test(
      "a handler whose promise never settles still produces a timeout error reply, not a permanent hang",
      { timeout: 5000 },
      async () => {
        const client = spawnFakeClient({ serverRequestHandlerTimeoutMs: 100 });
        client.onRequest("session/requestRuntimePreferences", () => new Promise(() => {}));
        const result = await client.call("test/serverRequest", {});
        assert.ok(result.clientReplied.error, "expected a timeout error reply instead of a hang");
        assert.equal(result.clientReplied.error.code, PROTOCOL_ERROR_CODES.INTERNAL_ERROR);
        assert.match(result.clientReplied.error.message, /did not settle within 100ms/);
      },
    );

    test("serverRequestHandlerTimeoutMs <= 0 disables the timeout, mirroring call()'s convention", async () => {
      const client = spawnFakeClient({ serverRequestHandlerTimeoutMs: 0 });
      client.onRequest("session/requestRuntimePreferences", () => {
        return new Promise((resolve) => setTimeout(() => resolve({ nativeSearchEnhancementsEnabled: true }), 50));
      });
      const result = await client.call("test/serverRequest", {});
      assert.deepEqual(result.clientReplied.result, { nativeSearchEnhancementsEnabled: true });
    });
  });

  // --- Round 3 defect #6: isValidEnvelope must reject method+result/error --

  describe("round 3 defect #6: isValidEnvelope rejects hybrids", () => {
    test("a {method, result} hybrid (no id) is ignored, not delivered as a notification", async () => {
      const logger = makeLogger();
      const client = spawnFakeClient({ logger });
      const events = [];
      client.on("some/method", (params) => events.push(params));
      client._handleChunk(JSON.stringify({ method: "some/method", result: { ok: true } }) + "\n");
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(events.length, 0, "a method+result hybrid must not be delivered as a notification");
      assert.match(logger.lines.join("\n"), /invalid ZCode Protocol envelope shape/);
    });

    test("an {id, method, error} hybrid is ignored, not treated as a server request needing a reply", async () => {
      const client = spawnFakeClient();
      const sendSpy = [];
      const originalSend = client._send.bind(client);
      client._send = (message) => {
        sendSpy.push(message);
        return originalSend(message);
      };

      client._handleChunk(
        JSON.stringify({ id: "hybrid-1", method: "some/serverRequest", error: { code: -32603 } }) + "\n",
      );
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(sendSpy.length, 0, "the client must not send a spurious reply for an invalid hybrid envelope");
    });
  });

  // --- Round 3 defect #7: no arbitrary wire text in log lines; logger errors
  // must never crash the host --------------------------------------------

  describe("round 3 defect #7: logging only safe facts, and never crashing on a bad logger", () => {
    test("an overlong/unshaped method name is never logged verbatim, even for an unhandled server request", async () => {
      // Bypass the fixture (which only ever sends well-formed method names)
      // and inject a hostile "server request" directly, the same way other
      // tests in this file exercise internal handlers.
      const logger = makeLogger();
      const client = spawnFakeClient({ logger });
      const hostileMethod = "A".repeat(5000);
      client._handleChunk(JSON.stringify({ id: "srv-hostile", method: hostileMethod }) + "\n");
      await new Promise((resolve) => setImmediate(resolve));

      const joined = logger.lines.join("\n");
      assert.doesNotMatch(joined, /A{200}/, "the raw method text must never reach the log");
      assert.match(joined, /unhandled server request/);
      assert.match(joined, /<unrecognized method name>/);
    });

    test("a known, well-shaped method name is still logged in full (allowlist-by-shape, not a blanket ban)", async () => {
      const logger = makeLogger();
      const client = spawnFakeClient({ logger });
      client.onRequest("session/requestRuntimePreferences", () => {
        throw new Error("boom");
      });
      await client.call("test/serverRequest", {});
      assert.match(logger.lines.join("\n"), /handler for server request "session\/requestRuntimePreferences" threw/);
    });

    test("a logger that throws never crashes the host process", async () => {
      const client = spawnFakeClient({
        logger: () => {
          throw new Error("logger is broken");
        },
      });
      // Force at least one _logDiag call (an unparseable line) and confirm
      // the client is still alive and usable afterwards.
      client._handleChunk("not-json-at-all\n");
      await new Promise((resolve) => setImmediate(resolve));
      const result = await client.call("test/echo", { still: "alive" });
      assert.deepEqual(result, { echoed: { still: "alive" } });
    });
  });

  // --- Round 3 defect #8: notify() is guarded like call(), and tested ------

  describe("round 3 defect #8: notify()", () => {
    test("notify() sends a fire-and-forget message the fixture accepts silently", async () => {
      const client = spawnFakeClient();
      // Deleting notify() entirely makes this line throw a TypeError,
      // failing this test — see the acceptance-criteria requirement that
      // notify()'s removal must not leave the suite green.
      client.notify("test/clientNotification", { hello: true });
      // The transport must still be healthy afterwards — a bad notify()
      // implementation that corrupts the stream would surface here.
      const result = await client.call("test/echo", { after: true });
      assert.deepEqual(result, { echoed: { after: true } });
    });

    test("notify() throws when the client has not been started", () => {
      const client = new ZCodeProtocolClient(
        { command: process.execPath, args: [FIXTURE_PATH] },
        { logger: makeLogger() },
      );
      assert.throws(() => client.notify("test/x", {}), /has not been started/);
    });

    test("notify() throws when the client is closed", async () => {
      const client = spawnFakeClient();
      await client.close();
      assert.throws(() => client.notify("test/x", {}), /closed/);
    });

    test("notify() throws a clear ProtocolError instead of letting a raw stream error escape, once stdin is destroyed", async () => {
      const client = spawnFakeClient();
      const sawError = new Promise((resolve) => client.proc.stdin.once("error", resolve));
      client.proc.stdin.destroy(new Error("write EPIPE"));
      await sawError;
      assert.throws(() => client.notify("test/x", {}), /stdin is not writable|closed/);
    });

    test("the fixture does not reply to a client notification for an unknown method (previously replied with an id-less {error} envelope)", async () => {
      const child = spawn(process.execPath, [FIXTURE_PATH, "app-server"]);
      try {
        const reader = lineReader(child);
        child.stdin.write(JSON.stringify({ method: "test/unknownNotification", params: {} }) + "\n");
        child.stdin.write(JSON.stringify({ id: "1", method: "test/echo", params: {} }) + "\n");
        const reply = await reader.next();
        assert.deepEqual(reply, { id: "1", result: { echoed: {} } });
      } finally {
        // Always kill the raw child, even on assertion failure — otherwise a
        // failing assertion here leaves the fixture process alive with its
        // stdio pipes open, which keeps `node --test`'s event loop alive and
        // hangs the whole run instead of just failing this one test.
        child.kill();
      }
    });
  });

  // --- Round 3 defect #10: unbounded line buffer growth ---------------------

  describe("round 3 defect #10: a line with no newline is bounded", () => {
    test(
      "an overlong line with no trailing newline is dropped, logged safely, and does not grow the buffer unbounded",
      { timeout: 5000 },
      async () => {
        const logger = makeLogger();
        const client = spawnFakeClient({ logger, maxLineBufferLength: 1000 });
        client._handleChunk("x".repeat(2000)); // no newline at all
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(client.buffer, "");
        const joined = logger.lines.join("\n");
        assert.match(joined, /discarding buffered stdout data/);
        assert.doesNotMatch(joined, /x{50}/, "the buffered content itself must never be logged");

        // The client must still be usable afterwards.
        const result = await client.call("test/echo", { after: true });
        assert.deepEqual(result, { echoed: { after: true } });
      },
    );
  });

  // --- Round 3 gaps in test coverage (item 11) ------------------------------

  describe("round 3 item 11: closing test-coverage gaps", () => {
    test("a whitespace-only line is silently ignored", async () => {
      const logger = makeLogger();
      const client = spawnFakeClient({ logger });
      client._handleChunk("   \t  \n");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(logger.lines.length, 0, "a whitespace-only line must produce no diagnostic at all");
    });

    test("a CRLF-terminated line is parsed correctly (trailing \\r is legal JSON whitespace)", async () => {
      const client = spawnFakeClient();
      const callPromise = client.call("test/timeout", {}, { timeoutMs: 10_000 });
      const usedId = client.nextId - 1;
      client._handleChunk(JSON.stringify({ id: usedId, result: { ok: true } }) + "\r\n");
      assert.deepEqual(await callPromise, { ok: true });
    });

    test("a multi-byte UTF-8 character split across chunk boundaries (not an ASCII boundary) is reassembled correctly", async () => {
      const client = spawnFakeClient();
      const result = await client.call("test/multibyteSplit", {});
      assert.equal(result.emoji, "\u{1F389}");
    });

    test("the terminal _replyToServerRequest branch (both real and fallback replies fail to send) closes the transport", async () => {
      const client = spawnFakeClient();
      const sawError = new Promise((resolve) => client.proc.stdin.once("error", resolve));
      client.proc.stdin.destroy(new Error("write EPIPE"));
      await sawError;
      assert.equal(client.closed, false, "an EPIPE alone must not mark the client closed");

      await client._handleServerRequest({
        id: "srv-terminal",
        method: "session/requestRuntimePreferences",
        params: {},
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        client.closed,
        true,
        "the transport must be torn down when neither the real nor the fallback reply can be sent",
      );
    });
  });

  // --- Defect #8: start() after close() must not resurrect a "closed" client

  describe("defect #8: start() after close()", () => {
    test("close(); start(); close() — start() refuses to run on a closed client, close() stays idempotent", async () => {
      const client = spawnFakeClient();
      await client.call("test/echo", {});
      await client.close();

      assert.throws(() => client.start(), /closed/);

      // A second close() must remain a safe no-op — start() refused to spawn
      // a replacement process for it to have missed cleaning up.
      await client.close();
      assert.equal(client.closed, true);
    });
  });
});

// --- Defect #6: the fixture itself must behave like a real server ---------

describe("fake-app-server.mjs fixture hardening", () => {
  test("refuses to start without the app-server argument", async () => {
    const child = spawn(process.execPath, [FIXTURE_PATH]); // deliberately no "app-server"
    const [code] = await new Promise((resolve) => child.on("exit", (c, s) => resolve([c, s])));
    assert.notEqual(code, 0, "fixture must fail loudly when spawned without app-server, like the real CLI would");
  });

  test("rejects a message carrying a jsonrpc field, like the real server (-32600)", async () => {
    const child = spawn(process.execPath, [FIXTURE_PATH, "app-server"]);
    const reader = lineReader(child);
    child.stdin.write(JSON.stringify({ id: "1", jsonrpc: "2.0", method: "test/echo", params: {} }) + "\n");
    const reply = await reader.next();
    assert.equal(reply.error?.code, -32600);
    assert.match(reply.error.message, /Invalid ZCode Protocol message/);
    child.kill();
  });

  test("fails loudly if the client's reply to requestRuntimePreferences lacks a boolean flag", async () => {
    const child = spawn(process.execPath, [FIXTURE_PATH, "app-server"]);
    const reader = lineReader(child);
    child.stdin.write(JSON.stringify({ id: "1", method: "test/serverRequest", params: {} }) + "\n");
    const serverRequest = await reader.next();
    assert.equal(serverRequest.method, "session/requestRuntimePreferences");

    // Reply with a payload that does NOT carry the required boolean flag.
    child.stdin.write(JSON.stringify({ id: serverRequest.id, result: { wrong: "shape" } }) + "\n");

    const [code] = await new Promise((resolve) => child.on("exit", (c, s) => resolve([c, s])));
    assert.notEqual(code, 0, "fixture must fail when the client's reply is not the documented shape");
  });

  // --- Round 2 defect #6: the fixture must validate *any* reply, not just
  // replies to the one method it has a specific shape check for.

  test("fails loudly if the client's reply to ANY server-initiated request is a truncated envelope (neither result nor error)", async () => {
    const child = spawn(process.execPath, [FIXTURE_PATH, "app-server"]);
    const reader = lineReader(child);
    child.stdin.write(JSON.stringify({ id: "1", method: "test/unhandledServerRequest", params: {} }) + "\n");
    const serverRequest = await reader.next();
    assert.equal(serverRequest.method, "some/unknownMethod");

    // Exactly the shape a client produces when `JSON.stringify` silently
    // drops an unserializable `result` (round 2 defect #2): a reply carrying
    // neither "result" nor "error". A fixture that only validates known
    // methods (like `session/requestRuntimePreferences`) would let this pass
    // straight through.
    child.stdin.write(JSON.stringify({ id: serverRequest.id }) + "\n");

    const { code } = await waitForExit(child);
    assert.notEqual(code, 0, "fixture must fail on a truncated reply envelope for any method, not just known ones");
  });

  test("session/create then session/send each trigger a runtime-preferences round trip, and the turn completes end to end", async () => {
    const client = spawnFakeClient();
    const scopesSeen = [];
    client.onRequest("session/requestRuntimePreferences", (params) => {
      scopesSeen.push(params.scope);
      return { nativeSearchEnhancementsEnabled: false };
    });

    const created = await client.call("session/create", { workspace: {} });
    assert.equal(created.sessionId, "fake-session-1");

    const sent = await client.call("session/send", { sessionId: created.sessionId, content: {} });
    assert.equal(sent.accepted, true);

    assert.deepEqual(scopesSeen, ["runtime-materialization", "user-execution"]);
  });
});

after(async () => {
  while (clientsToClose.length > 0) {
    const client = clientsToClose.pop();
    await client.close();
  }
});
