---
description: Show what this plugin knows about the ZCode CLI, provider readiness, and current model
argument-hint: '[--json] [--cwd <path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zcode-companion.mjs" status "$ARGUMENTS"`
