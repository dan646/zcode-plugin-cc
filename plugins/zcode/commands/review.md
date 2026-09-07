---
description: Send a diff (working tree, or an explicit base branch/commit/path) to ZCode (GLM) for review
argument-hint: '[base-branch|base-commit|path] [--model <id>] [--cwd <path>] [--timeout <seconds>] [--mode <build|edit|plan|yolo>] [--quiet]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run a ZCode review of the current changes, or of the explicit target below if one was given.

A branch/commit target is the BASE to compare against, not the thing being reviewed: `/zcode:review main` reviews the current branch's changes since it diverged from `main`, the same way a pull request review works. It does not review `main` itself.

Raw arguments: `$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zcode-companion.mjs" review "$ARGUMENTS"
```

This is review-only: do not apply any fixes yourself, and do not treat ZCode's findings as already applied. Return ZCode's review output to the user as-is.

If the command fails because there is nothing to review or the directory is not a git repository, relay that message directly rather than retrying with different arguments.

A real review is several model round-trips (tool calls to read the diffed files, reason about them, etc.), so `review` defaults to a 1800-second (30-minute) turn timeout rather than a single-request 180s — scaled down from `code`'s 2700s default (see `code.md`) since a review is one pass over an existing diff rather than an open-ended implement-and-fix loop. If a large diff still times out, retry with a higher `--timeout <seconds>` — the timeout error names the current timeout and suggests a concrete higher one.

`--mode <build|edit|plan|yolo>` switches ZCode's own operating mode for this turn (via `session/setMode`) — it is **not** this plugin's write permission. `review` always runs with `permissionPolicy: "allow"` so ZCode can actually use its tools to read the files a diff touches, with or without `--mode`. `--mode` instead changes how ZCode's own agent behaves once it has that access (e.g. `plan` proposes rather than acts); it does not add or remove a review-only guarantee.

Progress (state changes, and one line per tool call ZCode makes, e.g. `[zcode] tool: Bash git log -p`) goes to stderr as the turn runs; pass `--quiet` to suppress it and print only the final review and usage summary.

Because the first 10-15 minutes of a real run produce no visible output at all, the turn also self-checks that it is still alive rather than just hung: whenever the server has gone quiet for a while it actively probes `session/usage` and prints one compact line, e.g. `[zcode] 12m30s · жив · запросов 4 (+1) · токенов 210k (+48k)` (growing request/token counts) or `[zcode] 18m00s · жив · без прогресса 5m — модель думает` (server alive, model just thinking — this never aborts the turn). If the server stops answering these probes for several tries in a row, the turn ends right away with a clear "stopped responding" error instead of waiting out the rest of the timeout. `--quiet` suppresses these lines the same way it suppresses everything else.
