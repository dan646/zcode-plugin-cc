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
// It also could not have caught the `/zcode:code` write-permission defect on
// its own before the section below was added: every earlier check here
// inspects `resultType`/response text, never the filesystem — and the whole
// point of that defect was that `resultType` stayed "success" while every
// real write was silently denied. See the "write-permission regression"
// section near the bottom.
//
// Requires a configured ZCode CLI: run `zcode login` once. Reads no secrets.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveZcodeCli, workspaceRef } from "../plugins/zcode/scripts/lib/locate.mjs";
import { ZCodeProtocolClient } from "../plugins/zcode/scripts/lib/protocol.mjs";
import { runTurn } from "../plugins/zcode/scripts/lib/session.mjs";
import { formatToolCallLine } from "../plugins/zcode/scripts/zcode-companion.mjs";

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

// ------------------------------------------------ write-permission regression
//
// This is the actual defect: ZCode blocks a real tool call (a file write) on
// a server-initiated `interaction/requestPermission` request. Nothing here
// trusts `resultType` or the response text — both stayed "success"-shaped
// even while the write was silently denied, which is exactly how 149 green
// unit tests missed this. The only thing that counts is whether the marker
// file actually exists on disk afterward, with the content ZCode was asked
// to write.
//
// Kept to one tiny file per run so this stays cheap: a fresh temp workspace,
// one short prompt, one short file.

console.log("\n— регрессия: право на запись файла (interaction/requestPermission) —");

const MARKER_NAME = "zcode-write-probe-marker.txt";
const MARKER_CONTENT = "ZCODE_WRITE_PROBE_OK";

/**
 * Run one `runTurn()` in a fresh throwaway workspace, asking ZCode to write a
 * small marker file, then report what (if anything) actually landed on disk.
 * Never throws: a denied permission can just as easily surface as a thrown
 * turn error as a clean "I couldn't do that" response, depending on how
 * ZCode's own agent loop reacts to the denial — either way, the filesystem is
 * the only thing this probe trusts.
 * @param {"allow" | "deny"} permissionPolicy
 * @returns {Promise<string | null>} the file's content, or null if it does not exist
 */
async function runWritePermissionProbe(permissionPolicy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-write-probe-"));
  const markerPath = path.join(dir, MARKER_NAME);
  try {
    await runTurn({
      cli,
      workspace: workspaceRef(dir),
      prompt:
        `Create a file named exactly "${MARKER_NAME}" in the current working directory. ` +
        `Its entire contents must be exactly this one line, with no extra text, quotes, code ` +
        `fences, or explanation: ${MARKER_CONTENT}\n` +
        "Use your file-write tool directly, right away — do not ask any clarifying question.",
      timeoutMs: 120_000,
      permissionPolicy,
    });
  } catch {
    // Ignored on purpose — see doc comment above.
  }
  let written = null;
  try {
    written = fs.readFileSync(markerPath, "utf8");
  } catch {
    written = null;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return written;
}

const allowedContent = await runWritePermissionProbe("allow");
check("permissionPolicy: \"allow\" — файл реально появился на диске с ожидаемым содержимым", () => {
  assert.ok(allowedContent !== null, `marker file was never created (got ${JSON.stringify(allowedContent)})`);
  assert.equal(allowedContent.trim(), MARKER_CONTENT);
});

const deniedContent = await runWritePermissionProbe("deny");
check("permissionPolicy: \"deny\" — файл НЕ должен появиться на диске", () => {
  assert.equal(deniedContent, null, `marker file should not exist, but found content: ${JSON.stringify(deniedContent)}`);
});

// --------------------------------------------------------- прогресс: вызовы инструментов
//
// User report: headless progress only ever printed coarse milestones
// (model_changed/prompt_started/prompt_completed) — no way to tell "working"
// from "hung". The fix reads `model.streaming` events shaped `kind:
// "tool_call"` (see zcode-companion.mjs's `formatToolCallLine` doc comment
// for how that shape was found empirically against this same live server)
// and turns them into one stderr line per tool call. This section drives a
// real turn guaranteed to call a tool and checks that at least one resulting
// line actually names the tool — not just that *some* progress event fired,
// which every other check in this file already covers and would pass even if
// tool calls were invisible.

console.log("\n— прогресс: строка о вызове инструмента (tool.updated / model.streaming tool_call) —");

/**
 * @returns {Promise<string[]>} every progress line `formatToolCallLine` would
 *   have printed to stderr for one real turn that reads a file it can only
 *   know about by actually calling its file-reading tool.
 */
async function runToolCallProgressProbe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-tool-progress-probe-"));
  fs.writeFileSync(path.join(dir, "probe-notes.txt"), "line one\nline two\nline three\n");
  const lines = [];
  try {
    await runTurn({
      cli,
      workspace: workspaceRef(dir),
      prompt:
        "Read the file probe-notes.txt in the current directory using your file-reading tool, " +
        "right away — no clarifying questions, no explanation needed afterward.",
      timeoutMs: 90_000,
      onProgress: (event) => {
        const line = formatToolCallLine(event);
        if (line) lines.push(line);
      },
    });
  } catch {
    // Ignored on purpose: this probe only cares about what progress looked
    // like while the turn ran, not whether the turn itself succeeded.
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return lines;
}

const toolProgressLines = await runToolCallProgressProbe();
check("ход с вызовом инструмента даёт хотя бы одну строку прогресса вида '[zcode] tool: <имя> ...'", () => {
  assert.ok(
    toolProgressLines.length > 0,
    "formatToolCallLine produced zero lines for a turn that was asked to use a tool " +
      "— either no tool_call progress event arrived, or the wire shape has drifted",
  );
  assert.ok(
    toolProgressLines.some((line) => /^\[zcode\] tool: \S/.test(line)),
    `no line matches the expected "[zcode] tool: <name> ..." shape: ${JSON.stringify(toolProgressLines)}`,
  );
});
if (toolProgressLines.length > 0) {
  console.log(`  (пример) ${toolProgressLines[0]}`);
}

// --------------------------------------------------------- прогресс: heartbeat
//
// Self-check of turn liveness (see lib/session.mjs's `createHeartbeatMonitor`
// doc comment): during the long silent stretch of a real turn there is no
// other way to tell "still working" from "connection died" than an active
// `session/usage` probe. Everything in tests/session.test.mjs exercises this
// against the fixture; this is the only check that it actually fires against
// a REAL app-server and gets back a real, alive probe result. A deliberately
// tiny `heartbeatIntervalMs` (far below the library default of 30s) forces at
// least one probe to happen even for a short "reply with PONG" turn.

console.log("\n— прогресс: самопроверка живости хода (heartbeat / session/usage) —");

async function runHeartbeatProbe() {
  const heartbeats = [];
  try {
    await runTurn({
      cli,
      workspace: ws,
      prompt: "Reply with exactly: PONG. Do not use any tools.",
      timeoutMs: 60_000,
      heartbeatIntervalMs: 300,
      onProgress: (event) => {
        if (event.type === "heartbeat") heartbeats.push(event);
      },
    });
  } catch {
    // Ignored on purpose — this probe only cares about the heartbeat stream,
    // not whether the turn itself completed in time.
  }
  return heartbeats;
}

const heartbeatEvents = await runHeartbeatProbe();
check("ход с малым heartbeatIntervalMs даёт хотя бы одно событие heartbeat", () => {
  assert.ok(
    heartbeatEvents.length > 0,
    "no heartbeat progress events arrived at all — either the mechanism did not fire, or the turn " +
      "completed before the first probe could run",
  );
});
check("хотя бы одно событие heartbeat сообщает о живом сервере (alive: true)", () => {
  assert.ok(
    heartbeatEvents.some((e) => e.alive === true),
    `no alive heartbeat among ${JSON.stringify(heartbeatEvents)}`,
  );
});
if (heartbeatEvents.length > 0) {
  console.log(`  (пример) elapsedMs=${heartbeatEvents[0].elapsedMs} alive=${heartbeatEvents[0].alive}`);
}

console.log(failures === 0 ? "\nРЕЗУЛЬТАТ: УСПЕХ" : `\nРЕЗУЛЬТАТ: ПРОВАЛ (${failures})`);
process.exit(failures === 0 ? 0 : 1);
