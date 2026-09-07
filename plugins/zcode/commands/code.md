---
description: Delegate a coding task to ZCode (GLM), implemented directly in the working directory
argument-hint: '<task description> [--model <id>] [--cwd <path>] [--timeout <seconds>] [--mode <build|edit|plan|yolo>] [--quiet]'
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

`code` is a multi-round-trip, tool-using operation, so it defaults to a 900-second turn timeout (not the 180s a single request/response would need). If a run still times out on a large task, retry with a higher `--timeout <seconds>`; the error message says how long it waited.

`--mode <build|edit|plan|yolo>` switches ZCode's own operating mode for this turn (via `session/setMode`) — it is **not** this plugin's write permission. `code` always runs with write access granted (`permissionPolicy: "allow"`), with or without `--mode`, because that is the whole point of the command. `--mode` instead changes how ZCode's own agent behaves once it has that access: `plan` makes it propose a plan without touching files, `edit` restricts it to editing existing files, `yolo` skips its own internal confirmations, `build` is the default. Do not reach for `--mode plan` expecting a guaranteed read-only run — that guarantee does not exist at this layer.

Progress (state changes, and one line per tool call ZCode makes, e.g. `[zcode] tool: Read /path/to/file`) goes to stderr as the turn runs; pass `--quiet` to suppress it and print only the final response and usage summary.
