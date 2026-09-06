---
description: Check whether the local ZCode CLI is ready (model provider configured)
argument-hint: '[--json] [--cwd <path>]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zcode-companion.mjs" setup "$ARGUMENTS"
```

Present the output to the user as-is.

If it says ZCode is not ready, relay the exact `zcode login` instruction from the output. Do not run `zcode login` yourself, do not ask for or handle any API key or credential, and do not attempt to configure a provider on the user's behalf — this plugin never touches secrets, only diagnoses.
