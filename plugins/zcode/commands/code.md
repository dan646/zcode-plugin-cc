---
description: Delegate a coding task to ZCode (GLM), implemented directly in the working directory
argument-hint: '<task description> [--model <id>] [--cwd <path>] [--timeout <seconds>]'
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
