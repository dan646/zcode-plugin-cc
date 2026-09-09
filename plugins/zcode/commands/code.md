---
description: Delegate a coding task to ZCode (GLM), implemented directly in the working directory
argument-hint: '<task description> [--model <id>] [--cwd <path>] [--timeout <seconds>] [--mode <build|edit|plan|yolo>] [--quiet] [--no-stream]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Delegate the task below to ZCode, a separate agentic process with its own model and its own tools. It has no access to this conversation — only the task text and whatever it reads for itself in the working directory (it looks for `AGENTS.md`/`CLAUDE.md` on its own).

Raw arguments: `$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zcode-companion.mjs" code "$ARGUMENTS"
```

Return ZCode's final response to the user as-is. Do not redo, second-guess, or silently patch its work — if the result looks wrong or incomplete, tell the user plainly and suggest a follow-up `/zcode:code` (with a more specific task) or `/zcode:review`.

`code` is a multi-round-trip, tool-using operation, so it defaults to a 2700-second (45-minute) turn timeout (not the 180s a single request/response would need). That default comes from real usage against an actual project (a dockerized Laravel app): a single unit of work took 20-30 minutes end to end, with the first 10-15 minutes producing no visible output before the rest streams back in a burst — 2700s covers the upper end of that range plus room for a slow start and a correction round. If a run still times out on a large task, retry with a higher `--timeout <seconds>`; the error message names the current timeout and suggests a concrete higher one.

`--mode <build|edit|plan|yolo>` switches ZCode's own operating mode for this turn (via `session/setMode`) — it is **not** this plugin's write permission. `code` always runs with write access granted (`permissionPolicy: "allow"`), with or without `--mode`, because that is the whole point of the command. `--mode` instead changes how ZCode's own agent behaves once it has that access: `plan` makes it propose a plan without touching files, `edit` restricts it to editing existing files, `yolo` skips its own internal confirmations, `build` is the default. Do not reach for `--mode plan` expecting a guaranteed read-only run — that guarantee does not exist at this layer.

Progress (state changes, and one line per tool call ZCode makes with relative paths, e.g. `[zcode] tool: Read src/index.mjs`) and streaming model text go to stderr as the turn runs. After the turn finishes, a git-based summary of created, modified, and deleted files is printed to stderr.
Pass `--no-stream` to suppress streaming model text while keeping tool calls, heartbeats, and the changes summary intact. Pass `--quiet` to suppress all progress and summaries, printing only the final response on stdout and usage metrics on stderr.

Because the first 10-15 minutes of a real run produce no visible output at all, the turn also self-checks that it is still alive rather than just hung: whenever the server has gone quiet for a while it actively probes `session/usage` and prints one compact line, e.g. `[zcode] 12m30s · жив · запросов 4 (+1) · токенов 210k (+48k)` (growing request/token counts) or `[zcode] 18m00s · жив · без прогресса 5m — модель думает` (server alive, model just thinking — this never aborts the turn). If the server stops answering these probes for several tries in a row, the turn ends right away with a clear "stopped responding" error instead of waiting out the rest of the timeout. `--quiet` suppresses these lines the same way it suppresses everything else.
