---
name: use-inkwire
description: Move the conversation into the inkwire Session tab. Replies go to the panel through session_send until /back-to-claude-code.
disable-model-invocation: true
allowed-tools: mcp__plugin_inkwire_inkwire__session_mode mcp__plugin_inkwire_inkwire__session_send mcp__plugin_inkwire_inkwire__boards_list mcp__plugin_inkwire_inkwire__boards_open
---

The human is about to leave the terminal for the inkwire panel in the browser.

1. If no board is open, call `boards_list`, then `boards_open` on the board the human means (ask in the terminal if it is not obvious). Print the panel URL from the result.
2. Call `session_mode` with `on: true`.
   - If it fails, print the error message as it is. It says how to relaunch. Stop.
   - If it succeeds, inkwire mode is on. Follow the `instruction` in the result for the rest of the session.
3. Deliver every reply with `session_send(text, highlight?, path?, draft?)`, and end your turn only after it returns. Open with a short `session_send` that asks what to look at. Four pointers: `highlight: { label, nodes, edges }` points at a set, a layer keeps a cut, `path: { layer_id, path_id, hop? }` explains an order (see the `trace-path` skill), `draft` proposes a change.
4. A `reply` result carries `ctx` as ids only: the focused layer, the selected element, the scrubber position (`trace: { path, hop }`), and `graph.revision`. Call `canvas_get_state` when you need the bodies.
5. On `mode_off` or `idle`, the human is back in the terminal. Reply there and end your turn.
