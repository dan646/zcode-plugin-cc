// Verify a SUCCESSFUL ZCode Protocol turn and dump every event type it emits.
//
//   export ZAI_API_KEY=<твой ключ Z.AI>
//   node verify-turn.mjs
//
// The key is never read, printed or stored by this script — the provider is
// registered with { source: "env", name: "ZAI_API_KEY" } and ZCode resolves it itself.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const ENV_VAR = process.env.ZPROBE_ENV_VAR ?? "ZAI_API_KEY";
const MODEL = process.env.ZPROBE_MODEL ?? "GLM-5.3-Flash";
const PROVIDER_ID = "builtin:zai-coding-plan";
const WSPATH = process.env.ZPROBE_WS ?? process.cwd();

if (!process.env[ENV_VAR]) {
  console.error(`нет переменной ${ENV_VAR} — экспортируй ключ Z.AI и запусти снова`);
  process.exit(1);
}

const ws = { workspacePath: WSPATH, workspaceKey: createHash("sha256").update(WSPATH).digest("hex").slice(0, 12) };
const proc = spawn("node", [ZCODE, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });

const pending = new Map();
let nextId = 0, buf = "";
const seenEvents = new Map();

const call = (method, params) =>
  new Promise((resolve) => {
    const id = `c${++nextId}`;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });

proc.stdout.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }

    if (m.id !== undefined && m.method) {
      proc.stdin.write(JSON.stringify({
        id: m.id,
        result: m.method === "session/requestRuntimePreferences" ? { nativeSearchEnhancementsEnabled: false } : {},
      }) + "\n");
      continue;
    }
    if (m.id === undefined && m.method) {
      if (/mcpTelemetry|telemetry\/event|computer-use/.test(m.method)) continue;
      const t = m.params?.type ?? m.method;
      seenEvents.set(t, (seenEvents.get(t) ?? 0) + 1);
      console.log(`EVT ${t}\n    ${JSON.stringify(m.params?.payload ?? m.params).slice(0, 500)}`);
      continue;
    }
    const r = pending.get(m.id); pending.delete(m.id);
    if (m.error) console.log(`ERR ${String(m.error.data?.message ?? m.error.message).replace(/\s+/g, " ").slice(0, 300)}`);
    r?.(m);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(700);

await call("workspace/upsertModelProvider", {
  workspace: ws,
  provider: {
    providerId: PROVIDER_ID,
    kind: "anthropic",
    baseURL: "https://api.z.ai/api/anthropic",
    apiKey: { source: "env", name: ENV_VAR },
    models: [{ modelId: MODEL }],
  },
});
await call("workspace/setDefaultModel", { workspace: ws, model: { providerId: PROVIDER_ID, modelId: MODEL } });

const created = await call("session/create", { workspace: ws });
const sessionId = created.result?.sessionId;
console.log("\n=== sessionId:", sessionId, "===\n");

await call("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
await call("session/send", { sessionId, content: "Reply with exactly: PONG. Do not use any tools." });

await sleep(45000);

const usage = await call("session/usage", { sessionId });
console.log("\n=== usage ===\n", JSON.stringify(usage.result, null, 1));
console.log("\n=== event types seen ===");
for (const [t, c] of [...seenEvents].sort()) console.log(`  ${String(c).padStart(3)}x  ${t}`);

await call("session/close", { sessionId });
proc.kill("SIGTERM");
