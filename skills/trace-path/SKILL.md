---
name: trace-path
description: Explain an order of execution on the inkwire board — "walk me through", "what happens when", "how does X reach Y", "show me the code path". Traces the code, writes the walk as a path on a layer, and plays it in the panel with a caption per hop.
allowed-tools: mcp__plugin_inkwire_inkwire__layers_list mcp__plugin_inkwire_inkwire__layers_create mcp__plugin_inkwire_inkwire__layers_update mcp__plugin_inkwire_inkwire__canvas_get_board mcp__plugin_inkwire_inkwire__canvas_get_state mcp__plugin_inkwire_inkwire__paths_create mcp__plugin_inkwire_inkwire__paths_update mcp__plugin_inkwire_inkwire__paths_get mcp__plugin_inkwire_inkwire__paths_play mcp__plugin_inkwire_inkwire__session_send mcp__plugin_inkwire_inkwire__canvas_bind_code mcp__plugin_inkwire_inkwire__drafts_create mcp__plugin_inkwire_inkwire__drafts_update mcp__plugin_inkwire_inkwire__drafts_delete mcp__plugin_inkwire_inkwire__drafts_get mcp__plugin_inkwire_inkwire__drafts_activate Read Grep Glob
---

The human asked about an order: what runs first, what calls what, where a request goes. Answer with a **path**, not a paragraph.

Four pointers, four jobs. Do not mix them up:
- **highlight** — point at a set of elements. `session_send(highlight)`.
- **layer** — keep a cut of the board. `layers_create`.
- **path** — explain an order. `paths_create`, then `session_send(path)`.
- **draft** — propose a change. `drafts_create`, then `session_send(draft)`.
- **notebook** — write the finding down. `notebooks_create`, then `session_send(notebook)`.

## Steps

1. **Find the layer.** `layers_list`. If the question is about an existing layer, use it. If not, `layers_create` with the nodes the walk will touch and a title that names the question ("second admin hit", not "path 1").

2. **Trace in the code, not on the board.** The board is an index; the repo is the truth. Read each node's `ref` (`canvas_get_board` carries them), follow the calls with Read/Grep, and note the file and symbol where one hop hands off to the next. If a node has no `ref`, bind one first with `canvas_bind_code` — a hop between two unbound nodes is a guess.

3. **Write the walk.** One hop per call boundary. Prefer `nodes: [...]` over `steps` — the server resolves the edges and fails naming both candidates when a pair is joined twice, so you can pick. Rules the server enforces:
   - every hop's `to` is the next hop's `from` (revisits are fine; a retry loop is `a→b, b→a, a→b`)
   - every edge is inside the layer (`extend_layer: true` adds missing endpoints instead of failing)
   - at least one hop
   Branches are not a path. Two alternatives are two paths on the same layer (`hit`, `miss`).

4. **Caption each hop with what you verified.** ≤160 characters. Put the `ref` on the hop (`path/to/file.ts:symbol`) so the caption is a claim with a citation. Where you verified nothing, write no caption — an empty hop tells the human where to look themselves. Never caption with what the edge label already says.

5. **Send it.** `paths_create`, then one `session_send` with `path: { layer_id, path_id }` and a short text: what the walk shows and the one hop that matters. Do not narrate the hops in the text; the captions are the narration. The scrubber opens in the panel and plays once.

6. **Answer at a hop.** The human's reply carries `ctx.trace: { path, hop }` when the scrubber is open. Call `paths_get` for that path — it is small — and answer about *that* hop. To point at a place in the order, send `path: { layer_id, path_id, hop }`; the scrubber seeks there paused. Do not replay from 0 to say "here".

7. **Keep it true.** If you change the board (`canvas_delete`, `layers_update` with `remove`), the result names `paths_affected`. Fix the path with `paths_update` (steps replace whole) or delete it. `canvas_lint` reports broken hops.

## Don't

- Don't write a path for a set with no order. That is a highlight.
- Don't `paths_play` twice in a turn. It moves someone else's screen.
- Don't put more than ~12 hops in one path. Split at the boundary where the story changes.
