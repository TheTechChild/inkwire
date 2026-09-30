# inkwire — code map

Where each task surface starts and which files it runs through. Read the entry for what you are
changing, then open those files. Do not grep first.

Anchors are `path:line  symbol`. A Stop hook (`scripts/map-anchor-check.mjs`, run by hand with
`yarn map-anchors`) re-reads every anchor that points into a file your branch changed and blocks if
the symbol moved. Keep them current, and add an entry when you add a task surface.

Anchor declarations in hand-written source only — a function, class, type, constant, `case` or
`register` line. Never anchor a generated file (`schema/*.generated.json`, `dist/`), and prefer a
distinctive identifier over a word that also occurs inside a string: the check is whole-word, so a
near-miss rename still trips it, but a vague anchor buys little. Describe those files in prose
instead. The plugin files (`.claude-plugin/`, `hooks/`, `skills/`) and `src/ui/styles.css` are not
`.ts`, so they are described in prose too.

Product rules and the test list are in `CLAUDE.md`. The authority for behaviour is
`design_handoff_inkwire/` (local only): `SPEC.md` wins over the prototype.

## Server bootstrap

`main` loads config, opens the store, builds `Sessions`, starts HTTP + WebSocket on 127.0.0.1, then
connects the MCP server to stdio. The port may already be taken by a sibling server, which
`probeHealth` detects.

```
src/server/index.ts:14     main
src/server/index.ts:72     probeHealth
src/server/config.ts:13    loadConfig
src/server/http.ts:33      createHttpServer
src/server/http.ts:43      handle
src/server/http.ts:187     serveFile
src/server/ws.ts:16        PanelHub
src/server/mcp.ts:38       buildMcpServer
```

Env: `INKWIRE_PORT`, `INKWIRE_DATA_DIR`, `INKWIRE_PROJECT_ROOT`. HTTP serves the panel from
`dist/ui/` and the routes `/api/boards`, `/api/boards/:id/export`, `/api/boards/import`,
`/api/capture/:id`, `/api/hook`.

Beware: stdout is the MCP transport. Log to stderr only. Only the spawned-stdio smoke test catches
a stray `console.log`.

Tests: `tests/integration/server.test.ts`, `tests/integration/port-conflict.test.ts`,
`tests/tools/stdio-smoke.test.ts`.

## The write path

Every mutation, from an MCP tool or a WS intent, goes through `BoardSession.mutate`. It diffs,
appends to history, refolds, bumps revisions, schedules a 500 ms persist, and notifies listeners.
MCP handlers pass author `"ai"`, WS handlers pass `"human"`. Authorship is never a tool argument.

```
src/server/session.ts:70     class BoardSession
src/server/session.ts:59     MutationSpec
src/server/session.ts:166    mutate
src/server/session.ts:150    refold
src/server/session.ts:390    schedulePersist
src/server/session.ts:396    persistNow
src/server/session.ts:381    onChange
src/server/session.ts:445    class Sessions
src/server/session.ts:491    open
src/server/mutations.ts:49   addNode
src/server/mutations.ts:125  addEdge
src/server/mutations.ts:202  deleteElement
src/server/mutations.ts:225  moveElement
```

`mutations.ts` holds one function per element edit, each building a `MutationSpec` (label, optional
coalescing key, ids, `apply`). `Sessions` owns the open boards, the current board id, and the
server-wide session mode.

Beware: revisions are derived, per session. `refold` fingerprints the fold's graph and layout
sections and bumps each counter only on content change. A move must never touch `graph.revision`.
`boards.open` resets both counters.

Beware: `mutate` reports edges the fold pruned (from `canvas_delete`) in `ids`, and discards steps
ahead of head when you edit behind it (`truncated`).

Tests: `tests/tools/contract.test.ts`, `tests/helpers.ts` (`Sim`).

## Fold and integrity

`fold` replays history steps over `history.base` up to `head` and returns the board plus conflicts.
The result never holds a dangling edge.

```
src/core/fold.ts:65       fold
src/core/fold.ts:19       applyCollOps
src/core/fold.ts:37       applyLayoutOps
src/core/fold.ts:96       applyStep
src/core/state.ts:80      buildCanvasState
src/core/state.ts:36      historySummary
src/core/state.ts:63      strokeSummaries
src/server/session.ts:349 state
```

A step whose op missed (add over an existing id, set or del of an absent id) is flagged conflict.
Dropping the add-B step prunes the edge and flags the step that added it.

Beware: `src/core/` is pure: no I/O, no clock, no randomness. Clock and id-gen are injected.
`tests/core/purity.test.ts` enforces it.

Tests: `tests/core/fold.test.ts` (drop-node regression), `tests/core/properties.test.ts` (the eight
TESTS.md invariants, fast-check).

## History: coalesce, rewind, skip, drop, undo

Whole-item `set` ops, not field patches. `append` records a step, or coalesces into the tip.

```
src/core/history.ts:6     COALESCE_WINDOW_MS
src/core/history.ts:34    append
src/core/history.ts:88    rewindTo
src/core/history.ts:94    toggleSkip
src/core/history.ts:103   dropStep
src/core/history.ts:117   undo
src/core/history.ts:129   redo
src/core/diff.ts:39       diffCollections
src/core/diff.ts:49       isEmptyOps
src/server/session.ts:202 historyOp
src/server/session.ts:367 historyRows
```

Beware: coalescing re-diffs from the tip step's original `before` snapshot. Never concatenate op
lists: a skipped coalesced step must revert the whole gesture. Gestures commit once, on pointer
release.

Beware: history is in-memory only. SQLite stores board content, so a reopened board starts at step 0.

Tests: `tests/core/history.test.ts`, `tests/core/fold.test.ts`, `tests/helpers.ts` (`Sim` uses a
fixed-step clock; control time with `advanceMs`).

## Ink inference

The heuristic turns strokes into nodes (closed shapes) and edges (lines that snap to nodes).
`inferFromInk` is the mutation wrapper, used by `canvas_infer_structure` and the `infer` WS intent.

```
src/core/infer.ts:36        inferStructure
src/core/geometry.ts:11     bbox
src/core/geometry.ts:30     isClosed
src/core/geometry.ts:46     nearestNode
src/core/geometry.ts:83     edgeEndpoints
src/server/mutations.ts:293 inferFromInk
src/server/mutations.ts:247 addStroke
```

Thresholds are the constants at the top of `infer.ts` (`SNAP_DIST`, `MIN_NODE_W`, and others).

Tests: `tests/core/infer.test.ts`, `tests/core/geometry.test.ts`, `tests/fixtures/ink/`.

## MCP tools

All tools register through one untyped `register` wrapper in `buildMcpServer`. It turns the dotted
name into an underscore name, takes the input shape from `toolArgs`, turns thrown errors into
`isError` results, and records a `call` row in the current board's thread. The handlers call into
`mutations.ts`, `layers.ts`, `drafts.ts`, `notebooks.ts`, `session-mode.ts`, `lint.ts`,
`bindcode.ts`, `board-file.ts`.

```
src/server/mcp.ts:38    buildMcpServer
src/server/mcp.ts:101   register
src/server/mcp.ts:142   register("boards.list"
src/server/mcp.ts:199   get_state
src/server/mcp.ts:222   screenshot
src/server/mcp.ts:241   infer_structure
src/server/mcp.ts:249   register("canvas.add_node"
src/server/mcp.ts:305   bind_code
src/server/mcp.ts:368   lint
src/server/mcp.ts:384   history.get
src/server/mcp.ts:396   layers.list
src/server/mcp.ts:458   paths.create
src/server/mcp.ts:503   drafts.create
src/server/mcp.ts:549   notebooks.create
```

Families, in file order: `session_*` (102, 109), `boards_*` (142-172), `canvas_*` (199-368),
`history_get` (384), `layers_*` (396-442), `paths_*` (458-492), `drafts_*` (503-539),
`notebooks_*` (549-591).

Beware: tool names use underscores (`canvas_add_node`) because the tool-name charset forbids dots.
The spec's dotted names appear in descriptions only. The `toolArgs` keys are still dotted.

Beware: `SELF_RECORDING` (session send and mode) write their own thread rows; `BIG_RESULTS` drop the
result body from the call row. Add a new big-result tool to that set.

Beware: adding a tool means a zod shape in `toolArgs`, a `register` call, a regenerated schema
(`yarn gen:schemas`), and an edit to the hand-written fixture in `tests/fixtures/contract/` if a
`get_state` read changes.

Tests: `tests/tools/contract.test.ts` (real `McpServer` over `InMemoryTransport`),
`tests/tools/session.test.ts`.

## WebSocket protocol

The panel sends intents, the server answers with full pushes. Intents are validated against a zod
discriminated union, then dispatched by `type` in `PanelHub.handle`.

```
src/shared/protocol.ts:15     clientIntentSchema
src/shared/protocol.ts:147    clientMessageSchema
src/shared/protocol.ts:164    captureRequestSchema
src/shared/protocol.ts:173    SessionPush
src/shared/protocol.ts:186    ServerMessage
src/server/ws.ts:96           handle
src/server/ws.ts:103          case "add_node":
src/server/ws.ts:203          push
src/server/ws.ts:224          requestCapture
src/ui/ws-client.ts:7         connectWs
src/ui/ws-client.ts:99        answerCapture
src/ui/app.ts:91              isServerMessage
```

A rejected intent triggers a re-sync push to that client. On board delete the socket closes with
code 4010.

Beware: a new intent needs the zod variant in `protocol.ts`, a `case` in `ws.ts`, and a sender in
the UI. Gestures send one intent on pointer release, not per move.

Tests: `tests/integration/server.test.ts`.

## The contract

`src/shared/schemas.ts` is the single zod source for elements, `CanvasState`, and every tool's args.
JSON Schema is generated from it into `schema/canvas-state.generated.json` and
`schema/tools.generated.json` (never hand-edit). The design-authored oracle is
`tests/fixtures/contract/`.

```
src/shared/schemas.ts:26      nodeSchema
src/shared/schemas.ts:36      edgeSchema
src/shared/schemas.ts:94      layerSchema
src/shared/schemas.ts:150     canvasStateSchema
src/shared/schemas.ts:189     toolArgs
src/shared/schemas.ts:361     ToolName
src/shared/types.ts:10        NODE_KINDS
src/scripts/gen-schemas.ts:11 toJSONSchema
```

Node kinds are the spec's five plus `state` and `lifeline`. `offeredNodeKindSchema` is what tools
offer; `nodeKindSchema` also accepts legacy kinds.

Beware: every `get_state` read in the contract tests is validated against the hand-edited fixture,
so contract drift fails tests. Hand-edit that fixture when the contract grows; only
`schema/*.generated.json` is emitted.

Tests: `tests/core/schema-parity.test.ts`, `tests/tools/contract.test.ts`.

## Panel UI

The panel is a view. State comes from server pushes, edits go out as intents. `main.ts` boots the
app, `canvas.ts` draws and handles pointer input, `panel.ts` renders the side tabs, `app.ts` holds
shared UI state.

```
src/ui/main.ts:17           boot
src/ui/main.ts:64           showBoardPicker
src/ui/app.ts:73            KIND_META
src/ui/app.ts:106           focusLayer
src/ui/canvas.ts:57         setupCanvas
src/ui/canvas.ts:663        renderWorld
src/ui/canvas.ts:600        hitNode
src/ui/canvas.ts:654        deleteSelection
src/ui/panel.ts:171         setupPanel
src/ui/panel.ts:324         renderPanel
src/ui/panel.ts:350         renderInspector
src/ui/panel.ts:487         renderHistory
src/ui/panel.ts:103         loadPanelPrefs
```

Styles are in `src/ui/styles.css`; `src/ui/index.html` is the shell. `yarn build` bundles the UI to
`dist/ui/` with esbuild (`esbuild.ui.mjs`).

Beware: `src/shared/tokens.ts` holds the canvas colors both renderers read, because resvg cannot
read CSS variables. Keep it in step with `src/ui/styles.css`.

Beware: a path like `_ds/industry-*/` inside a CSS comment ends the comment at `*/` and silently
swallows the rules after it.

Beware: the panel is browser-only. Do not add MCP Apps embedding without a spike on iframe to
127.0.0.1 WebSocket access.

## Rendering, screenshots, LOD

`canvas_screenshot` has two routes. The server renders an SVG and rasterizes it with resvg. When a
panel is connected, the server can ask it for a capture over WS. Level of detail (zoom steps, label
wrapping) is shared code in `core/lod.ts`.

```
src/server/render-svg.ts:25   renderBoardSvg
src/server/render-svg.ts:135  fitViewport
src/server/rasterize.ts:11    rasterizeSvg
src/server/screenshot.ts:9    CaptureBroker
src/server/screenshot.ts:26   Screenshots
src/ui/capture.ts:10          captureBoard
src/core/lod.ts:18            lodFor
src/core/lod.ts:48            wrapText
src/shared/tokens.ts:53       RENDER
```

Fonts are in `assets/fonts/`. A capture that the client does not answer within `CLIENT_TIMEOUT_MS`
falls back to the server render.

Beware: screenshots ignore focus (layers). Tokens must match in both renderers.

Tests: `tests/core/lod.test.ts`.

## Session mode and hooks

A server-wide flag moves replies from the terminal into the panel's Session tab. `session_send`
blocks until the human answers. The plugin's hook script forwards Claude Code events to the server,
which blocks `Stop` while the mode is on.

```
src/server/session-mode.ts:35    sessionMode
src/server/session-mode.ts:103   sessionSend
src/server/session-mode.ts:203   sessionReply
src/server/session-mode.ts:283   hookEvent
src/server/session-mode.ts:23    BLOCK_CEILING
src/server/session-mode.ts:24    AUTO_MODES
src/server/session-mode.ts:338   focusTerminal
src/server/session.ts:435        HookReport
src/server/http.ts:55            /api/hook
src/ui/session.ts:22             setupSession
src/ui/session.ts:117            renderSession
src/ui/session.ts:252            messageCard
```

Hook files (not `.ts`): `hooks/hooks.json` wires `Stop`, `PreToolUse` on the `session_mode` tool,
and `SessionStart` with matcher `compact`. `hooks/forward.sh` only POSTs the event to `/api/hook`
and prints the verdict (`block`, `context`, or `ok`).

Beware: session mode is per server, not per board. The thread and the active highlight are per
board, shared by every panel, and never persisted. The mode is not persisted either.

Beware: `session_mode(on)` fails unless a hook event was seen, the permission mode is `auto` or
`bypassPermissions`, and `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` is `0`. `session_send` times out after
20 min, returns `idle`, and turns the mode off. The server gives up blocking `Stop` after 3 in a row.

Beware: there is no `/use-inkwire` button in the panel. The user types it in the terminal.

Tests: `tests/tools/session.test.ts`.

## Layers and focus

A layer is a named set of nodes. Focus picks one layer; the panel shows its members as "in", their
neighbours as "rim", and the rest as "out". Focus is per session and shared by every panel.

```
src/core/layers.ts:15      Tier
src/core/layers.ts:42      liveMembers
src/core/layers.ts:51      tiers
src/core/layers.ts:74      scopeState
src/core/layers.ts:28      downstream
src/server/layers.ts:36    createLayer
src/server/layers.ts:58    updateLayer
src/server/layers.ts:82    deleteLayer
src/server/session.ts:234  updateLayers
src/server/session.ts:245  setFocus
src/ui/canvas.ts:922       renderLayerBar
src/ui/panel.ts:592        renderLayers
```

Beware: layer members are never pruned when a node is deleted; `liveMembers` filters at read time.
Scoped reads (`get_state` with a scope) go through `scopeState`. Screenshots ignore focus.

Tests: `tests/core/layers.test.ts`.

## Paths and trace

A path is an ordered walk over a layer's edges with one caption per hop. `openTrace` puts it in the
session's trace, and the panel plays it with a scrubber. The `trace-path` skill writes one.

```
src/core/layers.ts:139    nextPathId
src/core/layers.ts:162    validateWalk
src/core/layers.ts:182    resolveNodesToSteps
src/core/layers.ts:210    pathsAffected
src/core/layers.ts:244    traceT
src/server/layers.ts:108  createPath
src/server/layers.ts:178  getPath
src/server/layers.ts:208  openTrace
src/server/session.ts:326 setTrace
src/server/session.ts:333 updateTrace
src/ui/canvas.ts:1122     effectiveTrace
src/ui/canvas.ts:1274     renderTrace
src/ui/canvas.ts:1422     renderScrubber
```

The trace rides in `SessionPush`. The WS intents are `trace_set`, `trace_seek`, `trace_run`.

Beware: a delete or remove breaks paths (collateral); `pathsAffected` reports it. Only delete and
remove do this. A peek (holding a layer chip) is panel-local and never sent to the server.

Tests: `tests/core/layers.test.ts`.

## Drafts

A draft is a view, like a layer. Creating, marking or activating one changes nothing on the board.
Marks give a node or edge a role (hue). `active_draft` is per board and shared by every panel.

```
src/core/drafts.ts:7       nextDraftId
src/core/drafts.ts:30      goneMarks
src/server/drafts.ts:23    createDraft
src/server/drafts.ts:42    updateDraft
src/server/drafts.ts:101   markElement
src/server/session.ts:258  updateDrafts
src/server/session.ts:266  setActiveDraft
src/ui/canvas.ts:1029      renderDraftChips
src/ui/canvas.ts:1058      renderDraftStrip
src/ui/panel.ts:690        renderDrafts
```

Beware: `active_draft` is never persisted. The error hue is shared between draft roles and lint. Draft
hue tokens are mirrored in `tokens.ts` but the renderers do not read them. Scoped reads return whole
drafts.

Tests: `tests/core/drafts.test.ts`.

## Notebooks

Notebooks are prose panes beside the canvas. They replace note nodes. Bodies use a small markdown
subset with `[[ref]]` chips that resolve to nodes.

```
src/core/notebooks.ts:59     parseNotebook
src/core/notebooks.ts:85     refsIn
src/core/notebooks.ts:94     toggleTaskLine
src/core/notebooks.ts:111    goneRefs
src/core/notebooks.ts:142    resolveNotebookRefs
src/server/notebooks.ts:16   createNotebook
src/server/notebooks.ts:69   appendToNotebook
src/server/notebooks.ts:112  migrateNotes
src/server/session.ts:275    updateNotebooks
src/ui/notebook.ts:41        setupNotebook
src/ui/notebook.ts:136       renderNotebook
src/ui/notebook.ts:338       buildChip
```

Beware: prose is not a board element. A legacy `note` node is a lint error until `migrateNotes`
moves it into the `notes` notebook (`notes_migrate` WS intent). The panel tracks its own sends
(`noteOwnSend`) so it does not show a "changed" notice for its own edit.

Tests: `tests/core/notebooks.test.ts`.

## Code binding and lint

`canvas_bind_code` attaches a `file:symbol` ref to a node. `validateRef` checks it against
`INKWIRE_PROJECT_ROOT`. `lintBoard` reports findings for `canvas_lint`.

```
src/server/bindcode.ts:12   splitRef
src/server/bindcode.ts:20   validateRef
src/server/lint.ts:11       LintFinding
src/server/lint.ts:29       lintBoard
```

Checks include `note_node`, `ref_missing`, `symbol_missing`, `unbound`, `path_broken`, `draft_mark_gone` and `notebook_ref_gone`. Add a check inside `lintBoard`.

## Board files and Mermaid

A board exports to a versioned JSON file with bitmaps embedded, and imports back as a new board.
Mermaid export is a pure function.

```
src/shared/board-file.ts:19   BOARD_FILE_VERSION
src/shared/board-file.ts:21   boardFileSchema
src/server/board-file.ts:20   exportBoard
src/server/board-file.ts:57   importBoard
src/server/board-file.ts:18   ImportError
src/core/mermaid.ts:22        exportMermaid
```

Beware: raise `BOARD_FILE_VERSION` when the board shape changes, and keep old versions importable.

Tests: `tests/core/mermaid.test.ts`, `tests/integration/server.test.ts`.

## Persistence

SQLite (`store.ts`) stores board content and bitmaps. `BoardSession` saves with a 500 ms debounce.
History is not stored.

```
src/server/store.ts:31    class Store
src/server/store.ts:91    load
src/server/store.ts:142   save
src/server/store.ts:173   saveImage
```

Default data dir is `~/.inkwire` (`INKWIRE_DATA_DIR`).

## The plugin

Inkwire ships as a Claude Code plugin and as its own one-plugin marketplace. None of this is `.ts`;
build first, because the manifest runs `dist/server/index.js`.

- `.claude-plugin/plugin.json` — manifest and the `mcpServers` entry (`node ${CLAUDE_PLUGIN_ROOT}/dist/server/index.js`).
- `.claude-plugin/marketplace.json` — the marketplace listing.
- `hooks/hooks.json`, `hooks/forward.sh` — see Session mode and hooks.
- `skills/use-inkwire`, `skills/back-to-claude-code`, `skills/trace-path` — `trace-path` is
  model-invocable.
- `.claude/skills/ship` — dev-only, not part of the plugin.
- `.claude/settings.json` — the Session tab's two requirements for this repo
  (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, permission mode `auto`).
