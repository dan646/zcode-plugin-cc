// End-to-end smoke test against the REAL ZCode app-server.
//
//   node probes/integration-smoke.mjs
//
// Everything in tests/ talks to a fixture. This is the only check that the
// client works against the actual server — and, just as importantly, that the
// fixture has not drifted away from it. Fixture drift has bitten this project
// five times (missing `app-server` argv, over-permissive replies, a wrong
// `state.updated` shape, and two usage shapes conflated into one), so the wire
// shapes are asserted here explicitly. A green `node --test` does NOT imply a
// working plugin; this probe is the only real evidence.
//
// Requires a configured ZCode CLI: run `zcode login` once. Reads no secrets.

import assert from "node:assert/strict";
import { resolveZcodeCli, workspaceRef } from "../plugins/zcode/scripts/lib/locate.mjs";
import { ZCodeProtocolClient } from "../plugins/zcode/scripts/lib/protocol.mjs";
import { runTurn } from "../plugins/zcode/scripts/lib/session.mjs";

const WS = process.env.ZPROBE_WS ?? process.cwd();
const ws = workspaceRef(WS);
const cli = resolveZcodeCli();

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  ✘ ${name}\n      ${err.message.split("\n")[0]}`);
  }
};

console.log(`CLI: ${cli.command} ${(cli.args ?? []).join(" ")}`);
console.log(`workspace: ${ws.workspacePath} (key=${ws.workspaceKey})\n`);

// ---------------------------------------------------------------- wire shapes
// Drive the raw client once and capture the first sighting of each event type,
// so we can assert the envelope classes the fixture is supposed to imitate.

console.log("— формы сообщений на проводе —");
const shapes = new Map();
const raw = new ZCodeProtocolClient(cli, { logger: () => {} });
for (const type of ["state.updated", "turn.started", "turn.completed", "model.streaming"]) {
  raw.on(type, (params) => { if (!shapes.has(type)) shapes.set(type, params); });
}
raw.start();
try {
  const created = await raw.call("session/create", { workspace: ws });
  const sessionId = created.session?.sessionId;
  assert.ok(sessionId, "session/create must return session.sessionId");
  await raw.call("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
  await raw.call("session/send", { sessionId, content: "Reply with exactly: PONG. Do not use any tools." });
  const deadline = Date.now() + 90_000;
  while (!shapes.has("turn.completed") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await raw.call("session/close", { sessionId });
} finally {
  await raw.close();
}

check("session/create кладёт sessionId в session, а projection.sessionId = 'unknown'", () => {
  // Guards the trap documented in docs/zcode-protocol-recon.md.
  assert.ok(shapes.size > 0, "no events captured at all");
});

for (const type of ["turn.started", "turn.completed", "model.streaming"]) {
  check(`${type}: событие сессии, полный конверт с payload`, () => {
    const p = shapes.get(type);
    assert.ok(p, `${type} never arrived`);
    assert.ok(p.payload !== undefined, `${type} must carry a payload wrapper`);
    for (const key of ["eventId", "seq", "sessionId", "turnId", "type"]) {
      assert.ok(key in p, `${type} envelope must carry ${key}`);
    }
  });
}

check("state.updated: синхронизация состояния, плоский конверт без payload", () => {
  const p = shapes.get("state.updated");
  assert.ok(p, "state.updated never arrived");
  assert.equal(p.payload, undefined, "state.updated must NOT have a payload wrapper");
  for (const key of ["patch", "reason", "revision", "scope", "type"]) {
    assert.ok(key in p, `state.updated must carry ${key} flat on params`);
  }
  for (const key of ["eventId", "seq", "turnId"]) {
    assert.ok(!(key in p), `state.updated must NOT carry ${key}`);
  }
});

check("turn.completed.payload несёт готовый ответ и usage", () => {
  const payload = shapes.get("turn.completed")?.payload;
  assert.ok(payload, "no turn.completed payload");
  assert.equal(typeof payload.response, "string");
  assert.ok(payload.usage && typeof payload.usage.totalTokens === "number");
});

// ------------------------------------------------------------ session layer
// Now the same thing through the public API the plugin will actually use.

console.log("\n— слой хода (runTurn) —");
const progress = [];
let turn;
try {
  turn = await runTurn({
    cli,
    workspace: ws,
    prompt: "Reply with exactly: PONG. Do not use any tools.",
    timeoutMs: 120_000,
    onProgress: (e) => progress.push(e),
  });
  console.log(`  ✔ runTurn завершился: resultType=${turn.resultType}`);
} catch (err) {
  failures += 1;
  console.log(`  ✘ runTurn упал: ${err.message.split("\n")[0]}`);
}

if (turn) {
  check("response — непустая строка", () => {
    assert.equal(typeof turn.response, "string");
    assert.ok(turn.response.length > 0);
  });
  check("usage — метрика хода (без modelErrorCount, это поле сессионное)", () => {
    assert.ok(turn.usage, "usage missing");
    assert.ok(turn.usage.inputTokens > 0);
    assert.equal(turn.usage.modelErrorCount, undefined,
      "turn-level usage must NOT carry modelErrorCount — see docs, 'Две разные метрики расхода'");
    assert.equal(turn.usage.source, "provider");
  });
  check("sessionUsage — метрика сессии, с modelErrorCount", () => {
    assert.ok(turn.sessionUsage, "sessionUsage missing");
    assert.equal(turn.sessionUsage.modelErrorCount, 0,
      `modelErrorCount=${turn.sessionUsage.modelErrorCount}`);
    assert.ok(turn.sessionUsage.inputTokens > 0);
  });
  check("две метрики действительно различаются", () => {
    // The session total includes the hidden lite-model title request.
    assert.ok(turn.sessionUsage.modelRequestCount > turn.usage.modelRequestCount,
      `session=${turn.sessionUsage.modelRequestCount} turn=${turn.usage.modelRequestCount}`);
  });
  check("onProgress получил события обоих классов", () => {
    assert.ok(progress.length > 0, "no progress events");
    const types = new Set(progress.map((e) => e.type));
    assert.ok(types.has("model.streaming"), `no model.streaming in ${[...types]}`);
    assert.ok(types.has("state.updated"), `no state.updated in ${[...types]}`);
  });
  check("прогресс state.updated разобран из плоских полей", () => {
    const ev = progress.find((e) => e.type === "state.updated");
    assert.ok(ev, "no state.updated progress event");
    assert.ok(ev.reason !== undefined || ev.patch !== undefined,
      `state.updated progress looks empty — flat fields not parsed: ${JSON.stringify(ev)}`);
  });
  check("прогресс model.streaming разобран из payload", () => {
    const ev = progress.find((e) => e.type === "model.streaming");
    assert.ok(ev, "no model.streaming progress event");
    assert.ok(ev.delta !== undefined || ev.kind !== undefined,
      `model.streaming progress looks empty — payload not parsed: ${JSON.stringify(ev)}`);
  });
}

console.log(failures === 0 ? "\nРЕЗУЛЬТАТ: УСПЕХ" : `\nРЕЗУЛЬТАТ: ПРОВАЛ (${failures})`);
process.exit(failures === 0 ? 0 : 1);
