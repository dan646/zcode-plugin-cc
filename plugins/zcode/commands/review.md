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

A real review is several model round-trips (tool calls to read the diffed files, reason about them, etc.), so `review` defaults to a 600-second turn timeout rather than a single-request 180s. If a large diff still times out, retry with a higher `--timeout <seconds>` — the timeout error names how long it waited and that this is the flag to raise.

`--mode <build|edit|plan|yolo>` switches ZCode's own operating mode for this turn (via `session/setMode`) — it is **not** this plugin's write permission. `review` always runs with `permissionPolicy: "allow"` so ZCode can actually use its tools to read the files a diff touches, with or without `--mode`. `--mode` instead changes how ZCode's own agent behaves once it has that access (e.g. `plan` proposes rather than acts); it does not add or remove a review-only guarantee.

Progress (state changes, and one line per tool call ZCode makes, e.g. `[zcode] tool: Bash git log -p`) goes to stderr as the turn runs; pass `--quiet` to suppress it and print only the final review and usage summary.
