---
name: back-to-claude-code
description: Leave inkwire mode. Replies go back to the terminal, and any pending session_send returns mode_off.
disable-model-invocation: true
allowed-tools: mcp__plugin_inkwire_inkwire__session_mode
---

Call `session_mode` with `on: false`. The server releases any pending `session_send` and brings the terminal forward. This turns off the mode of this Claude Code session only. Other Claude Code sessions keep their mode, and you stay the author of the board. From now on reply in the terminal as usual, with no `session_send`.
