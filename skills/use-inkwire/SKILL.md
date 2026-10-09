---
name: use-inkwire
description: Move the conversation into the inkwire Session tab. Replies go to the panel through session_send until /back-to-claude-code.
disable-model-invocation: true
allowed-tools: mcp__plugin_inkwire_inkwire__session_mode mcp__plugin_inkwire_inkwire__session_send mcp__plugin_inkwire_inkwire__boards_list mcp__plugin_inkwire_inkwire__boards_open mcp__plugin_inkwire_inkwire__boards_create mcp__plugin_inkwire_inkwire__boards_release mcp__plugin_inkwire_inkwire__canvas_get_state
---

The human is about to leave the terminal for the inkwire panel in the browser.

1. If no board is open, or your current board is not the board the human means, call `boards_list`, then `boards_open` on the board the human means (ask in the terminal if it is not obvious). Print the panel URL from the result.
   - `boards_list` shows the boards whose `project_root` overlaps this cwd (the root is the cwd, contains it, or is inside it), plus the boards with `root: unset`. If the board that the human names is not there, call `boards_list` with `all: true`.
   - If no board fits, `boards_create` needs a name and a `project_root`: the absolute path of the checkout that the board is a drawing of. Ask the human for the root. Do not assume the cwd.
   - Opening a board does not make you its author. Only one Claude Code session at a time is the author of a board. The first line of each tool result tells you the current board and if you are its author or a reader.
   - Before step 2, make sure that the first line of the last result names the board the human means. `session_mode` acts on your current board, and opening a board does not move an author. If the result says "You are the author of <A>. Your current board is still <A>" and the human means a different board, call `boards_release` (with no `board_id`, it releases A). Then call `boards_open` on the board the human means again.
2. Call `session_mode` with `on: true`. On a board with no author, this makes you the author.
   - If it fails, print the error message as it is and stop. An error about the hook, the permission mode or `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` says how to relaunch.
   - If it fails because another Claude Code session is the author of the board, print the error as it is and stop. Do not try again. Do not clone the board unless the human tells you to.
   - If it fails because the person released you from the board, print the error as it is and stop. Only the person can allow you again, in the panel. Do not try again.
   - If it succeeds, inkwire mode is on. Follow the `instruction` in the result for the rest of the session.
3. Deliver every reply with `session_send(text, highlight?, path?, draft?, notebook?)`, and end your turn only after it returns. Open with a short `session_send` that asks what to look at. Four pointers: `highlight: { label, nodes, edges }` points at a set, a layer keeps a cut, `path: { layer_id, path_id, hop? }` explains an order (see the `trace-path` skill), `draft` proposes a change. A notebook is where you write about them: markdown on the board, with `[[id]]` refs that resolve live. Never put prose on the canvas — there is no note kind.
4. A `reply` result carries `ctx` as ids only: the focused layer, the selected element, the scrubber position (`trace: { path, hop }`), and `graph.revision`. Call `canvas_get_state` when you need the bodies.
5. On `mode_off` or `idle`, reply in the terminal and end your turn. `session_send` returns `mode_off` when the human turned the mode off, when the person released the board in the panel, and when inkwire mode is no longer on for you. The mode is per Claude Code session and is not kept when the inkwire server restarts.
   - If `session_send` fails with "inkwire daemon connection lost", call `session_send` one more time. It then returns `mode_off`: reply in the terminal. If it fails again, print the error in the terminal and stop.

Do not call the inkwire HTTP API, the panel WebSocket, `/api/hook` or `yarn daemon:restart`. Only the human uses them. Use only the MCP tools.
