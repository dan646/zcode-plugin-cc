# ZCode plugin for Claude Code

**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

![version](https://img.shields.io/badge/version-0.5.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-lightgrey)

Hand coding and code review off from Claude Code to
**[ZCode](https://zcode.z.ai/en)**, the agentic coding environment from
[Z.ai](https://z.ai) that runs on GLM models (GLM-5.3, GLM-5.3-Flash,
GLM-5-Turbo).

Claude stays the orchestrator: it plans, delegates, and checks the result. ZCode
does the typing or gives a second opinion on a diff. Same idea as
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), with
ZCode/GLM in place of Codex/GPT.

```text
/zcode:code add input validation to the signup form and cover it with tests
/zcode:review main
```

## Features

- **`/zcode:code`**: ZCode implements a task directly in your working tree,
  runs the project's tests, and reports what it changed.
- **`/zcode:review`**: sends a git diff (working tree, branch, commit, or path)
  to ZCode for a correctness- and security-focused review.
- **Write scope**: `--allow` / `--deny` globs limit which files ZCode's file
  tools may touch.
- **Live progress**: one line per tool call (`Read src/index.mjs`,
  `Bash npm test`), plus a heartbeat that tells a long-thinking model apart
  from a dead connection.
- **Changes summary**: after a `code` turn, a git-based list of created,
  modified, and deleted files, with ZCode's own writes separated from other
  changes.
- **Safety stops**: turn timeout, `--idle-after-write`, and `--max-tool-calls`,
  each with its own exit code.
- **No dependencies**: plain Node.js, no `npm install`. The plugin never reads,
  stores, or prints your API key.

## Requirements

- **[Claude Code](https://claude.com/claude-code)** with plugin support.
- **ZCode.app**, available from [zcode.z.ai](https://zcode.z.ai/en). The `zcode`
  CLI ships inside the app, so there is nothing else to install. A standalone
  `zcode` on `PATH` works too.
- **Node.js 18.18+**.
- A **Z.ai API key**, exported as `ZAI_API_KEY`.

Developed and tested on macOS.

## Installation

In Claude Code, add this repository as a plugin marketplace and install the
plugin:

```text
/plugin marketplace add dan646/zcode-plugin-cc
/plugin install zcode@zcode-plugin-cc
/reload-plugins
```

To install from a local clone, pass the path instead:
`/plugin marketplace add /path/to/zcode-plugin-cc`.

## Setup

1. Export your key **before** starting Claude Code. ZCode runs as a child
   process and inherits the environment. The plugin only passes it through.

   ```bash
   export ZAI_API_KEY="your-key"
   ```

2. Authorize ZCode once, if you haven't already:

   ```bash
   zcode login
   ```

   If `zcode` isn't on your `PATH`, run the CLI bundled with the app:
   `node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs login`.

3. Check that everything is wired up:

   ```text
   /zcode:setup
   ```

   ```text
   ZCode CLI: /usr/local/bin/node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
   Provider configured: yes
   Current model: zai/glm-5.3-flash
   ```

`/zcode:setup` only diagnoses. It never runs `zcode login` or touches
credentials; it tells you what to do instead.

## Usage

### Delegate a task

```text
/zcode:code add a slugify() helper to src/utils and cover it with tests
```

ZCode is a separate process. It **cannot see your Claude Code conversation**,
only the task text and whatever it reads in the working directory (it picks up
`AGENTS.md` / `CLAUDE.md` on its own). Write the task so it stands alone.

Restrict where ZCode may write:

```text
/zcode:code --allow 'app/**' --allow 'tests/**' --deny 'app/secrets/**' add the email check
```

### Review changes

```text
/zcode:review               # working tree vs HEAD (staged + unstaged)
/zcode:review main          # what this branch introduced since it diverged from main
/zcode:review a1b2c3d       # changes since a commit
/zcode:review src/billing   # working-tree changes under one path
```

A branch or commit is the **base** to compare against, the same way a pull
request works. `/zcode:review main` reviews your branch, not `main`.

New untracked files are listed for ZCode but aren't part of `git diff`. To get
their contents reviewed as a diff, `git add` them first.

### Check status

```text
/zcode:status
```

Shows the resolved CLI path, whether a provider is configured, the current
model, and the models in the catalog.

## Commands

| Command | What it does |
|---|---|
| `/zcode:setup` | Diagnose readiness: locate the CLI and check that a model provider is configured. |
| `/zcode:code <task>` | Implement a task in the working directory. |
| `/zcode:review [base\|path]` | Review a diff. Defaults to working tree vs `HEAD`. |
| `/zcode:status` | Show CLI path, provider readiness, current model, and model catalog. |

## Options

| Option | Applies to | Description |
|---|---|---|
| `--model <id>` | all | Model for this session, e.g. `glm-5.3` or `zai/glm-5.3`. Defaults: `code` → `glm-5.3-flash`, `review` → `glm-5.3`. |
| `--cwd <path>` | all | Working directory. Defaults to the current one. |
| `--json` | `setup`, `status` | Machine-readable output. |
| `--timeout <sec>` | `code`, `review` | Turn timeout. Defaults: `code` 2700 s (45 min), `review` 1800 s (30 min). |
| `--idle-after-write <sec>` | `code`, `review` | Stop if no new file write happens for this long after the first one. Off by default. |
| `--max-tool-calls <n>` | `code`, `review` | Stop after more than `n` tool calls. Off by default. |
| `--mode <build\|edit\|plan\|yolo>` | `code`, `review` | ZCode's own operating mode for the turn. |
| `--allow <glob>` | `code` | Repeatable. Allow file tools only under matching paths. |
| `--deny <glob>` | `code` | Repeatable. Deny matching paths. Wins over `--allow`. |
| `--no-stream` | `code`, `review` | Hide streamed model text; keep tool calls, heartbeats, and summary. |
| `--quiet` | `code`, `review` | Hide all progress; print only the final answer and usage footer. |

Progress goes to **stderr** and ZCode's final answer to **stdout**, so the output
pipes cleanly.

### Why the timeouts are so long

`code` and `review` are multi-round, tool-using turns, not a single request.
Measured on a real project (a dockerized Laravel app), one unit of work took
20–30 minutes. The first 10–15 minutes printed nothing at all while the model
was thinking, and then everything arrived in a burst. The defaults cover the top
of that range plus a correction round. Your own `--timeout` always wins.

### Safety stops

- **`--idle-after-write <sec>`** stops the turn if, after the first accepted
  `Write`/`Edit`, no new write happens for that long. Set it **longer than your
  slowest test or linter run**: the protocol has no "command finished" event, so
  a model waiting on a long `Bash` looks exactly like an idle one. A turn with no
  writes is never stopped by this flag.
- **`--max-tool-calls <n>`** stops after more than `n` declared tool calls,
  counting calls rejected by the write scope.

When a turn is stopped, stderr gets one line with the reason, the threshold, the
tool-call count, and the time since the last write. stdout gets the tail of the
model's unfinished text, clearly marked as incomplete.

## Write scope: `--allow` and `--deny`

Patterns are relative to `--cwd` and support `**`, `*`, and `?`: for example
`app/**`, `*.md`, `database/migrations/*.php`.

- With at least one `--allow`, any tool whose input carries `file_path`,
  `notebook_path`, or `path` is allowed only on matching paths.
- `--deny` wins over `--allow`.
- With a scope active, paths outside `--cwd` are always denied.
- On macOS, matching is case-insensitive, so `Resources/JS/…` can't slip past
  a `resources/js/**` deny.
- The active scope is printed at the start of the turn, and denied attempts are
  listed in the summary.

> [!WARNING]
> The scope is **not a sandbox for `Bash`**. Shell commands stay allowed so
> ZCode can run tests and linters, and a shell command can modify files outside
> the scope. Write targets can't be extracted reliably from shell text.

A scope works only with `--mode build` or `--mode plan`. Without `--mode`, the
plugin explicitly selects `build`. `edit` and `yolo` are rejected before the
turn starts, because in those modes ZCode approves writes itself and the scope
couldn't be enforced.

## `--mode` isn't a permission switch

`--mode` sets **ZCode's own behavior** for the turn through `session/setMode`:

| Mode | Behavior |
|---|---|
| `build` | ZCode's default working mode. |
| `edit` | Edit existing files only. |
| `plan` | Propose a plan without touching files. |
| `yolo` | Skip ZCode's internal confirmations. |

It doesn't decide whether the plugin grants write access. `review` and unscoped
`code` always grant it, because ZCode needs its tools to read the code under
review. `--mode plan` makes ZCode *choose* not to edit; it isn't a guaranteed
read-only run.

## Output

A running turn prints progress to stderr:

```text
[zcode] prompt_started
[zcode] tool: Read src/index.mjs
[zcode] tool: Write tests/slug.test.mjs
[zcode] tool: Bash npm test
```

Paths inside `--cwd` are shown relative; paths elsewhere under your home
directory are shortened to `~/…`. Tool arguments are truncated and scrubbed of
secret-looking `"apiKey"` fields.

**Heartbeat.** If the server has sent nothing for 30 s, the plugin probes
`session/usage` and prints a status line. It keeps probing while the turn stays
quiet:

```text
[zcode] 12m30s · жив · запросов 4 (+1) · токенов 210k (+48k) · последняя запись 2m10s назад
[zcode] 18m00s · жив · без прогресса 5m — модель думает · записей ещё не было
```

The second line is **not an error**. The server is answering, and the model has
simply been thinking for 5 minutes. The plugin never stops a turn for that. If 3
probes in a row go unanswered, the connection really is gone, and the turn ends
immediately with a `stopped responding` error instead of waiting out the
timeout.

**Changes summary.** After a `code` turn:

```text
[zcode] изменённые файлы:
[zcode]   src/slug.mjs (создан)
[zcode]   tests/slug.test.mjs (создан)
```

> [!NOTE]
> Progress and summary lines are currently printed in Russian. The final answer
> is in whatever language ZCode replies in.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Command error: CLI not found, provider not configured, missing task, not a git repo, or nothing to review. |
| `2` | The ZCode turn failed (`turn.failed`). |
| `3` | Turn stopped (timeout, `--idle-after-write`, `--max-tool-calls`) with **no** file writes. |
| `4` | Turn stopped **after** file writes. The work may be partly done, so check the diff. |

## Troubleshooting

**`Could not locate the ZCode CLI`**: the CLI is looked up in this order:
`$ZCODE_CLI` → the CLI bundled in `/Applications/ZCode.app` → `zcode` on `PATH`.
Install ZCode.app, put `zcode` on `PATH`, or set `ZCODE_CLI` to the absolute
path of `zcode` / `zcode.cjs`. It must point to the file, not to the `.app`
bundle.

**`Provider configured: no`**: run `zcode login` once with `ZAI_API_KEY`
exported, then `/zcode:setup` again.

**Unknown model from `session/setModel`**: a fresh `zcode login` may register
only `glm-5.1` / `glm-4.7`, not the `glm-5.3` defaults. Run `/zcode:status`
to see your catalog, then pass a model you have: `--model glm-5.1`.

**`ZCode app-server stopped responding`**: several heartbeat probes in a row
failed, which means the connection really dropped. The model wasn't just
thinking. Check that ZCode is still running and retry.

**`review`: "is not inside a git repository"**: run Claude Code from inside a
repository, or pass one with `--cwd`.

**`review`: "No changes to review"**: the working tree matches `HEAD` and there
are no untracked files. Check `--cwd`.

**`ZCode turn failed`** (exit code 2): stderr shows `code` and `retryable`.
If `retryable: true`, retry. If it fails every time, check that `ZAI_API_KEY`
was set before Claude Code started and that the key is valid.

## How it works

```text
/zcode:<command>   (slash command in Claude Code)
      │
      ▼
scripts/zcode-companion.mjs        argument parsing, output, exit codes
      │
      ▼
lib/session.mjs                    runTurn(): one turn, heartbeat, stop rules
      │
      ▼
lib/protocol.mjs                   ZCode Protocol client
      │   newline-delimited JSON over stdio
      ▼
zcode app-server                   ZCode's agent, running GLM
```

The plugin spawns `zcode app-server` and speaks the ZCode Protocol:
newline-delimited JSON over stdio (not JSON-RPC 2.0). It creates a session, sets
the model and mode, sends a self-contained prompt from `prompts/`, answers
`interaction/requestPermission` requests according to the write scope, and
streams events back as progress. The protocol notes are in
[`docs/zcode-protocol-recon.md`](docs/zcode-protocol-recon.md) (in Russian).

## Development

Tests use Node's built-in runner, so no packages are needed:

```bash
npm test
```

```text
.claude-plugin/marketplace.json   marketplace manifest
plugins/zcode/
  .claude-plugin/plugin.json      plugin manifest
  commands/                       slash commands (setup, code, review, status)
  prompts/                        prompt templates sent to ZCode
  scripts/zcode-companion.mjs     entry point
  scripts/lib/                    protocol, session, diff, write scope, CLI lookup
tests/                            unit tests + a fake app-server
probes/                           manual scripts for a live ZCode
docs/                             protocol notes
```

## Disclaimer

This is an unofficial community project. It isn't affiliated with or endorsed by
Z.ai or Anthropic. ZCode, GLM, and Claude are trademarks of their respective
owners.

## Author

Daniyar Yergaliyev · Instagram [@ergalievdk](https://www.instagram.com/ergalievdk)

## Buy me a coffee

If the plugin saves you time, you can buy me a coffee in USDT on the Tron
network (TRC-20):

```text
TBzXtk9M6k6VM4j1WWnTaSgokRrGGr8cAp
```

<img src="docs/images/usdt-trc20-qr.png" alt="USDT TRC-20 QR code" width="220">

> [!IMPORTANT]
> Send only **USDT on TRC-20 (Tron)** to this address. Funds sent on another
> network or in another token may be lost.

## License

[MIT](LICENSE)
