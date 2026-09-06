// Event-driven walk of the ZCode Protocol turn lifecycle.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const Z = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const WSPATH = process.env.ZPROBE_WS ?? process.cwd();
const ws = { workspacePath: WSPATH, workspaceKey: createHash("sha256").update(WSPATH).digest("hex").slice(0, 12) };
const MODEL = process.env.ZPROBE_MODEL ?? "GLM-5.3-Flash";
const PROVIDER_ID = process.env.ZPROBE_PROVIDER ?? "builtin:zai-coding-plan";

const proc = spawn("node", [Z, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let nextId = 0;

const call = (method, params) =>
  new Promise((resolve) => {
    const id = `c${++nextId}`;
    pending.set(id, resolve);
    console.log(`\n>>> ${method}`);
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });

let buf = "";
proc.stdout.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }

    if (m.id !== undefined && m.method) {                              // server -> client request
      console.log(`SRVREQ ${m.method} ${JSON.stringify(m.params).slice(0, 220)}`);
      const result = m.method === "session/requestRuntimePreferences"
        ? { nativeSearchEnhancementsEnabled: false } : {};
      proc.stdin.write(JSON.stringify({ id: m.id, result }) + "\n");
      continue;
    }
    if (m.id === undefined && m.method) {                              // notification
      if (/mcpTelemetry/.test(m.method)) continue;
      const t = m.params?.type ?? m.method;
      console.log(`  EVT ${t}  ${JSON.stringify(m.params).slice(0, 420)}`);
      continue;
    }
    const r = pending.get(m.id); pending.delete(m.id);
    if (m.error) console.log(`  ERR ${String(m.error.data?.message ?? m.error.message).replace(/\s+/g, " ").slice(0, 320)}`);
    else console.log(`  OK  ${JSON.stringify(m.result).slice(0, 300)}`);
    r?.(m);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(700);

await call("workspace/upsertModelProvider", {
  workspace: ws,
  provider: { providerId: PROVIDER_ID, kind: "anthropic", models: [{ modelId: MODEL }] },
});

await call("workspace/setDefaultModel", { workspace: ws, model: { providerId: PROVIDER_ID, modelId: MODEL } });

const created = await call("session/create", { workspace: ws });
const sessionId = created.result?.sessionId ?? created.result?.session?.sessionId;
console.log("\n=== sessionId:", sessionId, "===");

if (sessionId) {
  await call("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
  await call("session/send", { sessionId, content: "Reply with exactly: PONG" });
  await sleep(25000);                                                  // watch the event stream
  await call("session/usage", { sessionId });
  await call("session/close", { sessionId });
}
proc.kill("SIGTERM");
