---
description: Delegate a coding task to ZCode (GLM), implemented directly in the working directory
argument-hint: '<task description> [--model <id>] [--cwd <path>] [--timeout <seconds>] [--idle-after-write <seconds>] [--max-tool-calls <n>] [--mode <build|edit|plan|yolo>] [--allow <glob>] [--deny <glob>] [--quiet] [--no-stream]'
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

`code` is a multi-round-trip, tool-using operation, so it defaults to a 2700-second (45-minute) turn timeout (not the 180s a single request/response would need). That default comes from real usage against an actual project (a dockerized Laravel app): a single unit of work took 20-30 minutes end to end, with the first 10-15 minutes producing no visible output before the rest streams back in a burst — 2700s covers the upper end of that range plus room for a slow start and a correction round. A timeout is reported as a stopped turn, with a distinct exit code depending on whether ZCode made an accepted file write.

`--idle-after-write <seconds>` is off by default. After the first accepted `Write`/`Edit`, it stops the turn when that many seconds pass without a new accepted write. Set it **longer than the longest test and linter run in the project**: after edits, a model reading files and a model waiting for a long `Bash` command are indistinguishable in the protocol, because it has no command-finished event. A turn with no writes is never stopped by this flag. `--max-tool-calls <n>` is also off by default and stops after more than `n` declared tool calls; rejected calls count too.

`--mode <build|edit|plan|yolo>` switches ZCode's own operating mode for this turn (via `session/setMode`) — it is **not** this plugin's write permission. Without a write scope, `code` runs with write access granted (`permissionPolicy: "allow"`), with or without `--mode`; with `--allow`/`--deny`, it uses the scoped policy described below. A scoped run supports only `build` and `plan`: if omitted, the companion explicitly sets `build`; `edit` and `yolo` are rejected before the turn because ZCode auto-approves writes in those modes before the scoped permission handler can run. `plan` makes ZCode propose a plan without touching files, `edit` restricts it to editing existing files, and `yolo` skips its own internal confirmations. Do not reach for `--mode plan` expecting a guaranteed read-only run — that guarantee does not exist at this layer.

`--allow <glob>` and `--deny <glob>` are repeatable, cwd-relative write scopes for every permission request whose input contains `file_path`, `notebook_path`, or `path`: with any `--allow`, only matching paths are permitted; `--deny` always wins; paths outside `--cwd` are denied. On macOS these comparisons ignore case, preventing aliases of the same file from bypassing a denied pattern. Supported glob tokens are `**`, `*`, and `?` (for example `app/**`, `tests/**`, `*.md`). A denied attempt is reported in the changes summary. This is deliberately **not** a sandbox for `Bash`: commands without one of those path inputs remain permitted so ZCode can run tests and linters, and may change files in bypass of the scope because their write targets cannot be reliably parsed from command text. Use a scoped run with `--mode build`, `--mode plan`, or no `--mode` (which explicitly selects `build`).

Progress (state changes, and one line per tool call ZCode makes with relative paths, e.g. `[zcode] tool: Read src/index.mjs`) and streaming model text go to stderr as the turn runs. After the turn finishes, a git-based summary of created, modified, and deleted files is printed to stderr. On a stopped turn, stdout instead includes the buffered tail of `text_delta` marked as an unfinished response, never as a final summary.
Pass `--no-stream` to suppress streaming model text while keeping tool calls, heartbeats, and the changes summary intact. Pass `--quiet` to suppress all progress and summaries, printing only the final response on stdout and usage metrics on stderr.

Because the first 10-15 minutes of a real run produce no visible output at all, the turn also self-checks that it is still alive rather than just hung: whenever the server has gone quiet for a while it actively probes `session/usage` and prints one compact line, e.g. `[zcode] 12m30s · жив · запросов 4 (+1) · токенов 210k (+48k) · последняя запись 2m10s назад` or `[zcode] 18m00s · жив · без прогресса 5m — модель думает · записей ещё не было`. If the server stops answering these probes for several tries in a row, the turn ends right away with a clear "stopped responding" error instead of waiting out the rest of the timeout. `--quiet` suppresses these lines the same way it suppresses everything else.
