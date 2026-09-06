// Reusable ZCode Protocol probe harness.
// Usage: node zprobe.mjs <plan.json>   where plan.json = [{id, method, params, delayMs?}, ...]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

const ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

export const wsRef = (p) => ({
  workspacePath: p,
  workspaceKey: createHash("sha256").update(p).digest("hex").slice(0, 12),
});

// Collapse a ZodError blob into one line per issue: path + what it wants.
function explainZod(err) {
  const raw = err?.data?.message ?? err?.data?.issues ?? null;
  let issues = null;
  if (typeof raw === "string") { try { issues = JSON.parse(raw); } catch { /* not json */ } }
  else if (Array.isArray(raw)) issues = raw;
  if (!issues) return `${err?.code} ${String(err?.message).replace(/\s+/g, " ").slice(0, 260)}`;

  const flat = [];
  const walk = (list) => {
    for (const i of list) {
      if (i.errors) { for (const sub of i.errors) walk(sub); continue; }
      const path = (i.path ?? []).join(".") || "(root)";
      if (i.code === "unrecognized_keys") flat.push(`  ~ ${path}: extra ${JSON.stringify(i.keys)}`);
      else if (i.code === "invalid_type") flat.push(`  ! ${path}: want ${i.expected}, got ${i.received ?? "undefined"}`);
      else if (i.code === "invalid_value" || i.code === "invalid_literal")
        flat.push(`  = ${path}: must be ${JSON.stringify(i.values ?? i.expected)}`);
      else if (i.code === "invalid_union") flat.push(`  | ${path}: union mismatch`);
      else flat.push(`  ? ${path}: ${i.code} ${i.message ?? ""}`.trim());
    }
  };
  walk(issues);
  return [...new Set(flat)].join("\n");
}

export function runPlan(plan, { quietNotifications = true, tailMs = 4000, onServerRequest = null } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", [ZCODE, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    const results = new Map();
    const notes = [];
    let buf = "", stderr = "";

    proc.stderr.on("data", (d) => { stderr += d; });
    proc.stdout.on("data", (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, n); buf = buf.slice(n + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }

        if (m.id === undefined && m.method) {                      // server notification
          notes.push(m);
          if (!quietNotifications && !/mcpTelemetry/.test(m.method))
            console.log(`  ~note ${m.method}  ${JSON.stringify(m.params).slice(0, 600)}`);
          continue;
        }
        if (m.id !== undefined && m.method) {                      // server -> client REQUEST
          console.log(`\n<<< SERVER REQUEST [${m.id}] ${m.method}`);
          console.log("  params: " + JSON.stringify(m.params).slice(0, 900));
          notes.push(m);
          const reply = onServerRequest ? onServerRequest(m) : { result: {} };
          proc.stdin.write(JSON.stringify({ id: m.id, ...reply }) + "\n");
          console.log(`  -> replied ${JSON.stringify(reply).slice(0, 200)}`);
          continue;
        }
        results.set(m.id, m);
        if (m.error) {
          console.log(`\n[${m.id}] ${m.method ?? ""} ERROR ${m.error.code}`);
          console.log(explainZod(m.error));
        } else {
          const keys = Object.keys(m.result ?? {});
          console.log(`\n[${m.id}] OK  keys: ${keys.join(", ") || "(empty)"}`);
          console.log("  " + JSON.stringify(m.result).slice(0, 700));
        }
      }
    });

    let t = 400;
    for (const step of plan) {
      t += step.delayMs ?? 700;
      setTimeout(() => {
        console.log(`\n>>> [${step.id}] ${step.method} ${JSON.stringify(step.params).slice(0, 180)}`);
        proc.stdin.write(JSON.stringify({ id: step.id, method: step.method, params: step.params }) + "\n");
      }, t);
    }
    setTimeout(() => {
      proc.kill("SIGTERM");
      if (stderr.trim()) console.log("\n=== STDERR ===\n" + stderr.slice(0, 1200));
      resolve({ results, notes });
    }, t + tailMs);
  });
}

if (process.argv[2]) {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  await runPlan(plan);
}
