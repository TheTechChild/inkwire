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

`openCore` (`bootstrap.ts`) opens the store, builds `Sessions` and `Clients`, the panel hub and
the screenshot broker, and attaches the HTTP request handler and `routeUpgrades` to an http server.
The plugin runs the relay (`dist/link/relay.js`, see The link); the daemon is the one server entry.
`daemon.ts` `startDaemon` is the daemon entry: it binds the port first, then calls `openCore` in
the listen callback, and serves one McpServer per relay link (see The link). `routeUpgrades` sends `/ws` to `PanelHub.handleUpgrade`
and `/mcp` to the link endpoint, and destroys every other upgrade.

The port race is now between two daemons: two relays that start at the same time can each spawn
one, and the daemon that loses the port exits before it opens the store (see Daemon lifetime and
builds). On EADDRINUSE the daemon calls `probeHealth` (`src/link/probe.ts`), which tells an
inkwire (a daemon or an old server) from another process.

```
src/server/bootstrap.ts:46   openCore
src/server/daemon.ts:102     startDaemon
src/link/probe.ts:49         probeHealth
src/server/config.ts:18      loadConfig
src/server/upgrade.ts:11     routeUpgrades
src/server/http.ts:67        requestHandler
src/server/http.ts:77        createHttpServer
src/server/http.ts:81        handle
src/server/http.ts:260       serveFile
src/server/origin.ts:12      checkBrowserRequest
src/server/ws.ts:30          PanelHub
src/server/ws.ts:84          handleUpgrade
src/server/mcp.ts:82         buildMcpServer
```

Env: `INKWIRE_PORT`, `INKWIRE_DATA_DIR`, `INKWIRE_IDLE_GRACE_MS` (daemon only; default 30000, `off`
turns the idle stop off). There is no project-root env (see Project root). HTTP serves the panel
from `dist/ui/` and the routes `/healthz`, `/api/boards` (each entry has `project_root`, the unset
mark and `author: { label, pid } | null`), `/api/boards/:id/export`,
`/api/boards/import`, `/api/capture/:id`, `/api/hook`, and on the daemon `POST /api/daemon/restart`.

Beware: the Origin and Host check (`checkBrowserRequest`, M4.11). Every `POST`, `PUT`, `DELETE`
and `PATCH`, the `/ws` upgrade (`verifyClient` in `ws.ts`) and the `/mcp` upgrade need `Host`
`127.0.0.1:<port>` or `localhost:<port>`, and, when an `Origin` is present, the same origin over
`http`. A request with no `Origin` passes (the hook's curl, `yarn daemon:restart`). A refusal is a
403 and one stderr line.

Beware: stdout is the MCP transport of the relay. Log to stderr only. Only the spawned smoke test
(relay plus daemon) catches a stray `console.log`. The daemon writes nothing to stdout; a relay
that starts it sends its stdout and stderr to `daemon.log`.

Tests: `tests/integration/server.test.ts`, `tests/integration/daemon-port.test.ts`,
`tests/tools/stdio-smoke.test.ts`, `tests/integration/origin.test.ts`,
`tests/integration/port-conflict.test.ts` (two sessions share one daemon), and the health suite
`tests/health/` (`yarn health`, see The link).

## The link (relay and daemon)

Each Claude Code session runs the relay (`src/link/relay.ts`), which pipes MCP between stdio and the
daemon's `/mcp` WebSocket (ADR 0001). The link is a replaceable layer: its whole contract with the
daemon is a `Link` — an MCP SDK `Transport` (`WsTransport`, one JSON-RPC message per text frame),
the `hello` value, and a `closed` promise. The first frame must be the hello (`helloSchema`: pid
(the relay's `ppid`), session id, cwd, build, optional `term_program`, and `current_board` after a
reconnect). The daemon's `createLinkHost` makes or fills the Client of the hello's pid, attaches the
link, and connects a new McpServer to it. Reconnect lives only in `RelayCore`.

```
src/link/hello.ts:14          helloSchema
src/link/hello.ts:7           LINK_VERSION
src/link/ws-transport.ts:8    WsTransport
src/link/endpoint.ts:11       Link
src/link/endpoint.ts:34       createLinkEndpoint
src/link/ws-client.ts:7       connectLink
src/link/relay.ts:14          main
src/link/relay-core.ts:63     RelayCore
src/link/relay-core.ts:161    attach
src/link/relay-core.ts:201    fromDown
src/link/relay-core.ts:228    fromUp
src/link/relay-core.ts:246    track
src/link/relay-core.ts:255    upClosed
src/link/relay-core.ts:297    fatal
src/link/relay-core.ts:49     LOST_TEXT
src/server/daemon.ts:34       createLinkHost
src/server/clients.ts:452     restoreCurrentBoard
```

Beware: close codes. No hello in 5 s, or a first frame that is not a hello: 4400. A hello of
another `v`: 4426 "link version mismatch: run yarn daemon:restart". A restart: 1012.

Beware: the reconnect (M4.7). On an upstream close that the relay did not cause, `upClosed` answers
every in-flight request with -32000 (`LOST_TEXT`) and reconnects with backoff (250 ms, doubling to
5 s). `attach` sends the hello with `current_board`, then replays the cached `initialize` with the
id `inkwire-relay-reinit-<n>`; `fromUp` drops its response, then sends `notifications/initialized`
and the queued requests in order (at most 100; after 60 s with no daemon, requests get the error at
once). A reconnect to another build sends `notifications/tools/list_changed` downstream. `track`
keeps the board id from the first line of each tool result (`^board (b_…) `); `board: none` clears
it; any other first line (an SDK argument error) keeps it. The daemon restores the current board
only (`restoreCurrentBoard`), never authorship or `inkwire` mode, and queues the reconnect notice.

Beware: no loop on a state that no retry can fix. A link closed with 4426 or 4400, or a connect
that throws a fatal `DaemonUnavailable` (an old inkwire server or another process on the port),
goes to `fatal`: every open request gets -32000 with the reason, the relay stops, and `relay.ts`
exits 1. The backoff resets only when the link sends a message, so a daemon that accepts the link
and closes it at once gets a growing delay. The first connect (`start`) tries a failure that is not
fatal again for up to 10 s: a daemon that stops between the probe and the connect is replaced.

Beware: the boundary. Nothing outside `src/link/` imports `ws` for MCP; `src/server/ws.ts` (the
panel hub) is the one other `ws` user and must not touch `/mcp`. The relay must not import the
store, `session.ts` or better-sqlite3. `tests/link/boundary.test.ts` enforces all three.

Tests: `tests/link/boundary.test.ts`, `tests/link/endpoint.test.ts`, `tests/link/relay-core.test.ts`,
`tests/link/relay-spawn.test.ts`, `tests/integration/daemon.test.ts`.

Health suite (`yarn health`, plan M8): `yarn build`, then `tests/health/` with the link, daemon and
gate tests. `startRelays` (`tests/health/harness.ts`) spawns n relays at one time, each under its own
`sh -c` wrapper so each has its own Claude Code pid, on a random port with a temp dir; the first
relay autostarts the daemon. `tools.test.ts` has one case for each name in `WRITE_TOOLS`,
`READ_TOOLS` and `OWN_RULE_TOOLS` and checks the set against `tools/list`, so a new tool with no
health case fails. `lifecycle.test.ts` covers autostart, the race, release on close, `/clear`,
SIGKILL and reconnect, a stale build, both restarts, the idle grace and the dist relay.

```
tests/health/harness.ts:155   startRelays
tests/health/harness.ts:78    startRelay
tests/health/harness.ts:114   openPanel
tests/health/harness.ts:235   distSkipReason
```

Beware: the dist-relay case needs `dist/`. `yarn test` does not build, so the case skips (the
reason is in its name) when `dist/build.json` is missing or older than a file or directory under
`src/` (a directory mtime catches a rename or a delete). `yarn health` builds first and sets
`INKWIRE_HEALTH=1`, so there the case never skips: a stale `dist/` fails it.

Beware: `yarn health` runs `yarn build`, which deletes and rebuilds `dist/`. Run it in a worktree,
never in the checkout that live Claude Code sessions use as the plugin.

## Daemon lifetime and builds

The relay finds or starts the daemon (`ensureDaemon`): it probes `/healthz`, and when no inkwire
answers, it spawns a detached daemon (`daemonEntry`: `src/server/daemon.ts` under tsx,
`dist/server/daemon.js` from dist) that logs to `<dataDir>/daemon.log`, then polls for 10 s. A
racing second daemon loses the port before it opens the store and exits 0. `yarn build` writes
`dist/build.json` (`scripts/write-build-id.mjs`: `{ id, built_at }`, the id hashes `dist/` server,
core, shared, link and ui, and `built_at` is not in the hash). The daemon reads it one time, at
boot (`readBuildInfo`), and `/healthz` reports `{ ok, name, pid, build, clients, boards }`. The
`IdleTimer` stops the daemon `INKWIRE_IDLE_GRACE_MS` after its last link closes (at boot it waits
at least 10 s). Only the person restarts it: the panel's Restart (the `daemon_restart` intent, accepted only for
the build id that the stale notice showed) or `POST /api/daemon/restart` (`yarn daemon:restart`,
`scripts/daemon-restart.mjs`). Both run `createRestart` — persist every board, stop listening, close
every link, exit 0 — and the relays reconnect and autostart the current build.

```
src/link/autostart.ts:35      ensureDaemon
src/link/autostart.ts:28      daemonEntry
src/link/probe.ts:26          probeDaemon
src/server/build-info.ts:18   readBuildInfo
src/server/build-info.ts:32   isNewerBuild
src/server/idle.ts:22         IdleTimer
src/server/restart.ts:22      createRestart
src/server/http.ts:62         defaultStats
src/server/clients.ts:472     markStale
src/server/clients.ts:480     STALE_NOTICE
```

Beware: bind first. `startDaemon` listens on the port before it opens the store. On EADDRINUSE it
exits 0 when an inkwire answers (no DB opened) and 1 when another process holds the port. It has
no stdin close handler: a detached daemon has stdin set to `ignore`.

Beware: `/healthz` with `name: "inkwire"` and no `build` is an old inkwire server (a build from
before the daemon sends no build). `ensureDaemon` then stops the relay with "port N is held by an old inkwire
server; close the old Claude Code sessions" and does not reconnect.

Beware: stale builds (Decision 7). A hello whose build id differs and whose `built_at` is later
sets `clients.staleBuild` and puts `STALE_NOTICE` on that Client's next tool result. Nothing
restarts by itself. There is no MCP tool for restart; agents must not call the restart route or
`yarn daemon:restart`.

Beware: `yarn dev` runs the dev daemon on 4692 with `~/.inkwire-dev` and `INKWIRE_IDLE_GRACE_MS=off`.
Tests use random ports and temp dirs and never bind 4691 or 4692.

Tests: `tests/server/idle.test.ts`, `tests/integration/daemon-port.test.ts`,
`tests/integration/daemon.test.ts`, `tests/link/relay-spawn.test.ts`, `yarn build-id:test`.

## The write path

Every mutation, from an MCP tool or a WS intent, goes through `BoardSession.mutate`. It diffs,
appends to history, refolds, bumps revisions, schedules a 500 ms persist, and notifies listeners.
MCP handlers pass author `"ai"`, WS handlers pass `"human"`. Authorship is never a tool argument.

```
src/server/session.ts:70     class BoardSession
src/server/session.ts:59     MutationSpec
src/server/session.ts:166    mutate
src/server/session.ts:150    refold
src/server/session.ts:402    schedulePersist
src/server/session.ts:408    persistNow
src/server/session.ts:393    onChange
src/server/session.ts:450    class Sessions
src/server/session.ts:499    open
src/server/session.ts:483    onBoards
src/server/mutations.ts:49   addNode
src/server/mutations.ts:125  addEdge
src/server/mutations.ts:202  deleteElement
src/server/mutations.ts:225  moveElement
```

`mutations.ts` holds one function per element edit, each building a `MutationSpec` (label, optional
coalescing key, ids, `apply`). `Sessions` holds the open boards only. The current board and the
session mode of each Claude Code session are in `Clients` (see Clients and authorship).

Beware: revisions are derived, per board (`BoardSession`). `refold` fingerprints the fold's graph and layout
sections and bumps each counter only on content change. A move must never touch `graph.revision`.
Revisions reset only when the daemon loads the board for the first time; `boards_open` on a board
that is already open keeps its history and counters.

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
src/server/session.ts:361 state
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
src/server/session.ts:379 historyRows
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
name into an underscore name, takes the input shape from `toolArgs`, and runs the handler inside a
per-call slot (`callCtx`, an `AsyncLocalStorage`). After the handler it claims the written board
(`commitClaim`), turns thrown errors into `isError` results, records a `call` row, and puts the
board context line and the Client's notices first in the result (M3.5). The handlers call into
`mutations.ts`, `layers.ts`, `drafts.ts`, `notebooks.ts`, `session-mode.ts`, `lint.ts`,
`bindcode.ts`, `board-file.ts`.

```
src/server/mcp.ts:82    buildMcpServer
src/server/mcp.ts:50    WRITE_TOOLS
src/server/mcp.ts:61    READ_TOOLS
src/server/mcp.ts:71    OWN_RULE_TOOLS
src/server/mcp.ts:80    callCtx
src/server/mcp.ts:87    resolve
src/server/mcp.ts:105   writable
src/server/mcp.ts:121   created
src/server/mcp.ts:141   recordCall
src/server/mcp.ts:172   register
src/server/mcp.ts:249   register("boards.list"
src/server/mcp.ts:255   boards.open
src/server/mcp.ts:291   register("boards.release"
src/server/mcp.ts:375   get_state
src/server/mcp.ts:403   screenshot
src/server/mcp.ts:422   infer_structure
src/server/mcp.ts:430   register("canvas.add_node"
src/server/mcp.ts:486   bind_code
src/server/mcp.ts:549   lint
src/server/mcp.ts:566   history.get
src/server/mcp.ts:578   layers.list
src/server/mcp.ts:649   paths.create
src/server/mcp.ts:698   paths.play
src/server/mcp.ts:719   drafts.create
src/server/mcp.ts:765   notebooks.create
```

Families, in file order: `session_*` (207, 214), `boards_*` (249-372: list, open, delete, release,
update, create, clone, import), `canvas_*` (374-563), `history_get` (565), `layers_*` (577-630),
`paths_*` (648-716), `drafts_*` (718-762), `notebooks_*` (764-814).

Beware: every write handler resolves its board with `writable()`, not `resolve()`. `writable()`
fails when another Client is the Author, when the person released this Client from the board, or
(a claiming write) when the Client talks in `inkwire` mode on another board. The wrapper claims
the board only after the handler returns with no error, so a failed write never claims and never
releases. From `writable()` to its last mutation a handler must be synchronous: do awaited work
first. The wrapper runs a synchronous handler and its claim in one turn of the event loop, which
makes the claim atomic. `boards_delete` uses `writable(id, { claim: false })`: delete is a write,
not a claim. `boards_create`, `boards_clone` and `boards_import` call `checkSwitch(client, null)`
first and `created()` after: the new board is claimed and becomes current.

Beware: a new tool goes into exactly one of `WRITE_TOOLS`, `READ_TOOLS` or `OWN_RULE_TOOLS`.
`tests/tools/authorship.test.ts` fails when the three sets differ from `listTools()`, and runs
every write tool as a reader (it must fail and change nothing) and as the Author. It also needs a
case in `CASES` in `tests/health/tools.test.ts`: `CASES` is a `Record` over the three sets, so a
missing case fails `yarn typecheck` and `yarn health`.

Beware: only the Author's calls go into a board's Thread. `recordCall` writes the row on the
board the call wrote, else the board it read (`resolve()` fills the slot), else the current board,
and only when `clients.authorOf(board) === client.pid`. Readers' calls are not recorded.

Beware: every result starts with one text block: the context line
(`board <id> "<name>" · you: author|reader · mode: pty|inkwire`, or `board: none · mode: pty`), then
one line for each queued notice. The body follows. An argument error that the SDK makes before the
handler runs has no context line. Tests read the body with `toolBody` (`tests/helpers.ts`).

Beware: `boards_open` does not move an Author. The Author of A that opens B gets B's state, its
current board stays A, and a second text block says so. A Client that authors no board gets B as
its current board. So `session_mode(on)` after `boards_open(B)` by the Author of A acts on A: the
`use-inkwire` skill releases A (`boards_release`) and opens B again before it turns the mode on.

Beware: tool names use underscores (`canvas_add_node`) because the tool-name charset forbids dots.
The spec's dotted names appear in descriptions only. The `toolArgs` keys are still dotted.

Beware: `SELF_RECORDING` (session send and mode) write their own thread rows; `BIG_RESULTS` drop the
result body from the call row. Add a new big-result tool to that set.

Beware: adding a tool means a zod shape in `toolArgs`, a `register` call, a place in one of the
three tool sets, a case in `CASES` in `tests/health/tools.test.ts` (a missing case fails typecheck
and `yarn health`), a regenerated schema (`yarn gen:schemas`), a row in the panel's `MCP_TOOLS`, and
an edit to the hand-written fixture in `tests/fixtures/contract/` if a `get_state` read changes.

Tests: `tests/tools/contract.test.ts` (real `McpServer` over `InMemoryTransport`; the M3.5
context line and notices), `tests/tools/authorship.test.ts` (two Clients: the gate, claims,
release), `tests/tools/session.test.ts`, `tests/health/tools.test.ts` (every tool through real
relays and a real daemon). `tests/tools/harness.ts` builds many Clients over one
`Sessions` + `Clients`.

## WebSocket protocol

The panel sends intents, the server answers with full pushes. Intents are validated against a zod
discriminated union, then dispatched by `type` in `PanelHub.handle`.

The push (`state`) carries the board, its history rows, `session` and `daemon`. `session` has the
board's `author` (`{ pid, label, mode, pending, notice }` or null), `readers` (a count of the
other Clients whose current board it is), `released_from` (`{ pid, label }` or null), and the
board's `thread`, `highlight` and `trace`. Nothing in it is server-wide. `daemon` is
`{ build_id, stale }`; `stale` is `{ newer_build_id, built_at, boards, clients }` while a relay
with a newer build has said hello (Decision 7). `clients` lists only Clients with an open link
(`Clients.peekLinked`): a hook-only record is not a session a restart affects. When only `daemon`
changed, the hub sends the light `{ type: "daemon", daemon }` message in place of a full push. The person-only intents: `board_release { pid }`
(acts only when `pid` is the Author now, else `error` and a re-sync: the race guard),
`board_allow { pid }` (acts only when `released_from` is `pid`), `daemon_restart { build_id }`
(acts only when `build_id` is `daemon.stale.newer_build_id`, then calls the injected `restart`,
which is `createRestart` on the daemon), and `session_mode_off` (turns off the board's Author only).

```
src/shared/protocol.ts:15     clientIntentSchema
src/shared/protocol.ts:154    clientMessageSchema
src/shared/protocol.ts:171    captureRequestSchema
src/shared/protocol.ts:195    SessionPush
src/shared/protocol.ts:220    ServerMessage
src/server/ws.ts:134          handle
src/server/ws.ts:141          case "add_node":
src/server/ws.ts:192          case "board_release": {
src/server/ws.ts:202          case "board_allow":
src/server/ws.ts:207          case "daemon_restart": {
src/server/ws.ts:20           HubDeps
src/server/ws.ts:272          strip
src/server/ws.ts:294          daemon
src/server/ws.ts:318          fanOut
src/server/ws.ts:331          push
src/server/ws.ts:354          requestCapture
src/server/clients.ts:188     peekLinked
src/shared/protocol.ts:179    AuthorPush
src/shared/protocol.ts:208    DaemonPush
src/ui/ws-client.ts:8         connectWs
src/ui/ws-client.ts:120       answerCapture
src/ui/app.ts:91              isServerMessage
```

A rejected intent triggers a re-sync push to that client. On board delete the socket closes with
code 4010.

Beware: the fan-out. `Clients.notify` runs `fanOut`, which pushes a board only when its strip
fields (`author`, `readers`, `released_from`) differ from what its panels got last. When
`daemon` changed, every other panel gets only the `daemon` message (no ink geometry). A hello or a
close on board X does not push the state of board Y. While a newer build waits,
`Sessions.onBoards` (a board opened, created or deleted) also runs `fanOut`, so every Restart
confirm lists the open boards. A
change of a Client's current board must call `clients.notify()` (`boards_open`,
`restoreCurrentBoard`, `commitClaim` and the link host do), or the reader count goes stale. The
push reads Clients with `peek`/`peekAll`, never `get`/`all`: those sweep, and a sweep can notify
inside the push.

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
src/shared/schemas.ts:95      layerSchema
src/shared/schemas.ts:151     canvasStateSchema
src/shared/schemas.ts:193     toolArgs
src/shared/schemas.ts:369     ToolName
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
src/ui/main.ts:65           showBoardPicker
src/ui/app.ts:73            KIND_META
src/ui/app.ts:106           focusLayer
src/ui/canvas.ts:57         setupCanvas
src/ui/canvas.ts:628        renderWorld
src/ui/canvas.ts:565        hitNode
src/ui/canvas.ts:619        deleteSelection
src/ui/panel.ts:176         setupPanel
src/ui/panel.ts:347         renderPanel
src/ui/panel.ts:374         renderInspector
src/ui/panel.ts:641         staleStrip
src/ui/panel.ts:939         renderFooter
src/ui/panel.ts:620         renderAsideStrip
src/ui/panel.ts:666         renderLayers
src/ui/panel.ts:511         renderHistory
src/ui/panel.ts:108         loadPanelPrefs
```

The aside strip (`renderAsideStrip`) shows the stale-build notice (`staleStrip`, with Restart:
the confirm lists every open board and every Claude Code session and says that undo history and
every pending `session_send` are lost) above the highlight strip. Nothing draws over the graph.
The board picker (`showBoardPicker`) shows each board's `project_root` (or `root: unset`) and its
Author from `GET /api/boards`. The panel treats `author`, `readers`, `released_from`, `daemon` and
the picker's `author` as optional: a new bundle can load from an older running daemon.

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

A flag on each Client moves replies from the terminal into the panel's Session tab. `session_send`
blocks until the human answers. The plugin's hook script forwards Claude Code events to the server,
which blocks `Stop` while that Client's mode is on. Every function takes `(clients, client, …)`.

```
src/server/session-mode.ts:41    sessionMode
src/server/session-mode.ts:133   sessionSend
src/server/session-mode.ts:240   sessionReply
src/server/session-mode.ts:325   hookEvent
src/server/session-mode.ts:24    BLOCK_CEILING
src/server/session-mode.ts:25    AUTO_MODES
src/server/session-mode.ts:116   releaseAuthorship
src/server/session-mode.ts:385   terminalProgram
src/server/session-mode.ts:390   focusTerminal
src/server/clients.ts:15         HookReport
src/server/http.ts:116           /api/hook
src/ui/session.ts:73             setupSession
src/ui/session.ts:169            renderSession
src/ui/session.ts:372            messageCard
src/ui/session.ts:38             stripView
src/ui/session.ts:67             agentState
src/ui/session.ts:352            authorRow
```

Hook files (not `.ts`): `hooks/hooks.json` wires `Stop`, `PreToolUse` on the `session_mode` tool,
and `SessionStart` with matcher `compact|clear|resume`. `hooks/forward.sh` finds the Claude Code
pid (the nearest ancestor whose `comm` or first `args` word is `claude`), POSTs the event to
`/api/hook?pid=<n>`, and prints the verdict (`block`, `context`, or `ok`). It exits 0 on every
failure.

Beware: session mode is per Client (one flag on each Client record). At most one Client per board
is in `inkwire` mode, and it is the board's Author (`talkingOn`). `hookEvent` finds the Client by `claude_pid`
(and makes it when it is new), else by `session_id`, else ignores the event. `SessionStart` `clear`
or `resume` rekeys the Client to the new session id, but only when the hook has a pid: with no pid,
the new id matches no Client and the rekey cannot happen. The panel push (`ws.ts` `push`) shows the mode
and the pending send of the board's Author (`session.author`) and the board's notice from
`noticeByBoard`, so a panel on another board does not see a mode change. The thread and the active highlight are per
board, shared by every panel, and never persisted. The mode is not persisted either.

Beware: `session_mode(on)` needs a current board. It fails when another Client is the Author or
the person released this Client from the board (`checkWrite`), and on a board with no Author it
claims the board. In `inkwire` mode it fails for any board but the one the Client talks on
(`checkSwitch`), and `boards_open` does not move an Author's current board. Only the Author writes a `session_mode` row. A panel
reply (`sessionReply`) goes only to the Client that talks on that board. `session_send` must go to
the board that the Client authors and talks on.

Beware: `session_mode(on)` fails unless a hook event was seen, the permission mode is `auto` or
`bypassPermissions`, and `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` is `0`. `session_send` times out after
20 min, returns `idle`, and turns the mode off. The server gives up blocking `Stop` after 3 in a row.

Beware: `SessionStart` `compact` returns the Client's board context line (`contextLine`), plus
the mode instruction while the mode is on, so the agent knows its board after compaction.

Beware: there is no `/use-inkwire` button in the panel. The user types it in the terminal.

Beware: the Session strip (M5). It shows the Author as `label · pid N` and its mode, `NO AUTHOR`
("the next AI write claims this board") when there is none, and `N readers`. Release confirms
with the label and pid (and says that the pending `session_send` returns `mode_off` when one is
pending), then sends `board_release`. While `released_from` is set, **Allow pid N** sends
`board_allow`. The reply box works only while the Author is in `inkwire` mode. Thread call rows
named `author` (the M3.5 switch rows) render as their own line (`authorRow`), never folded into
the tool calls.

Tests: `tests/tools/session.test.ts`, `tests/tools/forward-hook.test.ts`.

## Clients and authorship

`Clients` (`src/server/clients.ts`, no I/O, clock from `Sessions.now`) keeps one `Client` for each
Claude Code pid (ADR 0001): `sessionId`, `cwd`, `label`, `termProgram`, `currentBoardId`, `mode`,
`hook`, `pending`, `blocks`. It also keeps the Author of each board (`authors`, ADR 0002), the
pid the person released from each board (`releasedFrom`), the panel notice of each board
(`noticeByBoard`), and the one-time notices of each Client (M3.5). The daemon makes one Client per
hello pid (`createLinkHost`).

```
src/server/clients.ts:32         Client
src/server/clients.ts:66         class Clients
src/server/clients.ts:112        ensure
src/server/clients.ts:145        attach
src/server/clients.ts:159        detach
src/server/clients.ts:215        remove
src/server/clients.ts:229        sweep
src/server/clients.ts:242        boardDeleted
src/server/clients.ts:293        talkingOn
src/server/clients.ts:309        checkWrite
src/server/clients.ts:341        commitClaim
src/server/clients.ts:431        release
src/server/session.ts:477        onDelete
src/server/session.ts:562        resolve
src/server/clients.ts:81         releasedFrom
src/server/clients.ts:327        checkSwitch
src/server/clients.ts:373        allowAgain
src/server/clients.ts:381        addNotice
src/server/clients.ts:285        readerCount
src/server/clients.ts:176        peek
src/server/clients.ts:388        takeNotices
src/server/clients.ts:399        contextLine
src/server/mcp.ts:87             resolve
src/server/mcp.ts:105            writable
```

Beware: a hook can make a Client before its link connects. With no `attach` for that pid within
`HOOK_ONLY_TTL_MS` (60 s), `sweep` removes it. `detach` removes the Client only when its last link
closes, and ignores a link that the record does not hold.

Beware: claims (ADR 0002). The first successful write claims an unclaimed board (the `register`
wrapper in `mcp.ts` calls `commitClaim`); reads never claim. `boards_create`, `boards_clone`,
`boards_import` and `session_mode(on)` claim too. `commitClaim` makes the board the Client's
current board. One board per Client: a claim of B releases A with reason `switch`, writes "claude
moved to B" on A's Thread and "claude is now the author" on B's, and queues the switch notice.
`checkSwitch` refuses any claim of another board while the Client talks in `inkwire` mode.
`commitClaim` runs `checkSwitch` and `checkWrite` again as a backstop.

Beware: release. `release(board, reason)` runs `releaseAuthorship`, which turns off a talking
Author (its pending send returns `mode_off`). Reasons: `client` (`boards_release`), `person` (the
panel `board_release` intent, M5), `disconnect`, `switch`, `deleted`. A `person` release sets `releasedFrom`: that pid's
writes and `session_mode(on)` on the board fail with "no longer the author" until another Client
claims it, the pid disconnects (`remove`), or the person calls `allowAgain(board, pid)`.

Beware: notices (M3.5). `addNotice` queues a line for one Client: claim, switch, lost (person
release) and deleted (every Client whose current board it was). The `register` wrapper takes them
with `takeNotices` and shows each once, after `contextLine`. `Sessions.delete` fires `onDelete`,
and `boardDeleted` releases the board, clears it as the current board of every Client, and
resolves a send blocked on it with `idle`.

Beware: `Sessions.resolve(board_id, currentBoardId)` takes the caller's current board. In
`mcp.ts`, use the local `resolve`, which passes `client.currentBoardId`.

Tests: `tests/tools/clients.test.ts`, `tests/tools/session.test.ts` (per-client state),
`tests/tools/authorship.test.ts` (the gate over MCP), `tests/tools/contract.test.ts` (M3.5).

## Layers and focus

A layer is a named set of nodes. Focus picks one layer; the panel shows its members as "in", their
neighbours as "rim", and the rest as "out". Focus is per board, shared by every panel, and never
persisted.

```
src/core/layers.ts:15      Tier
src/core/layers.ts:42      liveMembers
src/core/layers.ts:51      tiers
src/core/layers.ts:74      scopeState
src/core/layers.ts:28      downstream
src/server/layers.ts:36    createLayer
src/server/layers.ts:58    updateLayer
src/server/layers.ts:82    deleteLayer
src/server/session.ts:246  updateLayers
src/server/session.ts:257  setFocus
src/ui/panel.ts:666        renderLayers
```

Beware: layer members are never pruned when a node is deleted; `liveMembers` filters at read time.
Scoped reads (`get_state` with a scope) go through `scopeState`. Screenshots ignore focus.

Beware: no panel draws over the graph. Layer, draft and scrubber UI live in the aside; focus and draft state show in the canvas hint line; the canvas shows only nodes, edges, ink and the gold front (product decision, 2026-09-30).

Tests: `tests/core/layers.test.ts`.

## Paths and trace

A path is an ordered walk over a layer's edges with one caption per hop. `openTrace` puts it in the
board's trace, and the panel plays it as a vertical walk in the Layers tab (`renderLayers` mounts `renderWalk`). The `trace-path` skill writes one.

```
src/core/layers.ts:139    nextPathId
src/core/layers.ts:162    validateWalk
src/core/layers.ts:182    resolveNodesToSteps
src/core/layers.ts:210    pathsAffected
src/core/layers.ts:244    traceT
src/server/layers.ts:108  createPath
src/server/layers.ts:196  getPath
src/server/layers.ts:227  openTrace
src/server/session.ts:338 setTrace
src/server/session.ts:345 updateTrace
src/ui/canvas.ts:928      effectiveTrace
src/ui/canvas.ts:1093     renderTrace
src/ui/canvas.ts:1172     renderWalk
```

Each step with a ref carries a server-written `ref_hash`; `paths_update` takes `verify` to restamp hops (see Code binding and lint). The trace rides in `SessionPush`. The WS intents are `trace_set`, `trace_seek`, `trace_run`.

Beware: a delete or remove breaks paths (collateral); `pathsAffected` reports it. Only delete and
remove do this. A peek (holding a path row's play button) is panel-local and never sent to the server.

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
src/server/session.ts:270  updateDrafts
src/server/session.ts:278  setActiveDraft
src/ui/panel.ts:794        renderDrafts
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
src/server/session.ts:287    updateNotebooks
src/ui/notebook.ts:41        setupNotebook
src/ui/notebook.ts:136       renderNotebook
src/ui/notebook.ts:338       buildChip
```

Beware: prose is not a board element. A legacy `note` node is a lint error until `migrateNotes`
moves it into the `notes` notebook (`notes_migrate` WS intent). The panel tracks its own sends
(`noteOwnSend`) so it does not show a "changed" notice for its own edit.

Tests: `tests/core/notebooks.test.ts`.

## Code binding and lint

`canvas_bind_code` attaches a `file:symbol` ref to a node. `validateRef` checks it against the
board's `project_root` (see Project root). `lintBoard` reports findings for `canvas_lint`.

```
src/server/bindcode.ts:16   splitRef
src/server/bindcode.ts:42   validateRef
src/server/bindcode.ts:58   stampRef
src/server/bindcode.ts:67   refStatus
src/core/symbols.ts:19      findSymbol
src/core/symbols.ts:66      blockText
src/server/lint.ts:11       LintFinding
src/server/lint.ts:34       lintPath
src/server/lint.ts:67       lintBoard
```

Checks include `note_node`, `ref_missing`, `symbol_missing`, `unbound`, `path_broken`, `path_ref_changed`, `path_ref_unverified`, `path_hop_unbound`, `draft_mark_gone` and `notebook_ref_gone`. Add a check inside `lintBoard`; the path checks live in `lintPath`, which `paths_play` also calls.

`findSymbol` (pure) finds the declaration line and an indentation-plus-bracket-depth block end; `validateRef` returns `line` and `end`; `stampRef` returns the `blockText` hash for a ref (null when the symbol is gone). `refStatus` is the one step check (`ok`, `ref_missing`, `symbol_missing`, `changed`, `unverified`) shared by lint, `paths_get` and `paths_play`.

Beware: every ref operation takes its root from the board: `writeRoot` for `bind_code` with a ref, path stamps, `verify` and `canvas_lint` (these fail on an unset or gone root, and refuse the main-checkout fallback); `readRoot` for `paths_get` and `paths_play` (these stay readable, with `ref_status: null` and a warning). `resolveRef` throws on a `''` root as a backstop. `lintPath` takes a null root and then skips the ref checks.

Beware: a path step's `ref_hash` is written by the server, never a tool argument. An unchanged step (same edge, caption and ref) keeps its old stamp on `paths_update`; a new or changed step is stamped fresh. `verify: [hop]` is the only way to restamp without a change. A ref whose symbol is not found gets no stamp.

Beware: `canvas_bind_code`, `paths_create`, `paths_update` and `paths_play` are writes (`writable()`), so a
Reader cannot run them. `canvas_lint` and `paths_get` are reads.

Tests: `tests/core/symbols.test.ts`, `tests/tools/contract.test.ts`, `tests/tools/project-root.test.ts`.

## Board files and Mermaid

A board exports to a versioned JSON file with bitmaps embedded, and imports back as a new board.
Mermaid export is a pure function.

```
src/shared/board-file.ts:19   BOARD_FILE_VERSION
src/shared/board-file.ts:21   boardFileSchema
src/server/board-file.ts:21   exportBoard
src/server/board-file.ts:80   importBoard
src/server/board-file.ts:19   ImportError
src/core/mermaid.ts:22        exportMermaid
```

Beware: raise `BOARD_FILE_VERSION` when the board shape changes, and keep old versions importable.

Tests: `tests/core/mermaid.test.ts`, `tests/integration/server.test.ts`.

## Project root

Each board stores its own `project_root` (ADR 0003); every code ref on the board resolves against
it, for every caller and for the panel. `''` means unset: only a migrated row holds it. Each board
also stores `main_root`, the main checkout when the root is inside a linked git worktree (`''`
otherwise, and on any git failure). When the root is gone and `main_root` exists, reads fall back to
it with a warning; ref writes and lint refuse until `boards_update` sets a new root.

```
src/server/project-root.ts:20   checkRootArg
src/server/project-root.ts:32   mainRootOf
src/server/project-root.ts:71   boardRoot
src/server/project-root.ts:84   writeRoot
src/server/project-root.ts:91   readRoot
src/server/project-root.ts:109  canonicalPath
src/server/project-root.ts:118  rootOverlaps
src/server/project-root.ts:130  listBoards
src/shared/import-root.ts:9     importNeedsRoot
src/server/session.ts:512       create
src/server/session.ts:531       uniqueName
src/server/session.ts:547       clone
src/server/session.ts:234       updateMeta
src/server/mcp.ts:249           register("boards.list"
src/server/mcp.ts:302           register("boards.update"
src/server/mcp.ts:318           register("boards.create"
src/server/mcp.ts:330           register("boards.clone"
src/server/mcp.ts:345           register("boards.import"
src/server/board-file.ts:60     importRoot
```

The five board tools: `boards_list` (overlap filter: the root equals, contains, or is inside the
caller's cwd; unset and gone roots always show, marked `root: "unset"`; `all: true` shows every
board), `boards_create` (requires `project_root`), `boards_clone` (root defaults to the source's;
content only, at step 0), `boards_update` (name or root; not a history step), and `boards_import`
(explicit root, else the file's root when it exists here, else an error). Create, clone and import
share `uniqueName`: an exact name that exists on any board gets the lowest free ` (N)`, and the
result says `name_check: "OK"` or gives a `warning`. `GET /api/boards` lists every board (the panel
has no cwd); `POST /api/boards/import?project_root=` gives a 400 that the panel answers with a prompt
for the root, then retries. Only the root errors prompt (`importNeedsRoot` in
`src/shared/import-root.ts`): a file that is not valid fails without a prompt.

Reads: `paths_get` and `paths_play` give a `warnings` entry for an unset, gone or fallback root.
`canvas_get_board` gives the fallback warning as a second text content block (`warning: …`) after
the state JSON, only when a root resolved (fallback); it gives no warning for an unset or gone root.

Migration: `Store` adds the `project_root` and `main_root` columns (`NOT NULL DEFAULT ''`) with the
same try/catch `ALTER TABLE` style as the older columns.

Beware: the root argument rule is one message, `project_root must be an existing absolute directory:
<p>`. `checkRootArg` returns `path.resolve(p)`, not the real path; zod rejects only a missing
key. Compare roots through `canonicalPath` (the real path and, on macOS, the real case), as
`rootOverlaps` and the `boards_clone` default name do, because `process.cwd()` is a real path.
`mainRootOf` gives `''` for a bare repo cloned into `.git`.

Tests: `tests/tools/project-root.test.ts`, `tests/integration/store.test.ts`,
`tests/tools/contract.test.ts` ("project root (ADR 0003)"), `tests/integration/server.test.ts`.

## Persistence

SQLite (`store.ts`) stores board content and bitmaps. `BoardSession` saves with a 500 ms debounce.
History is not stored.

```
src/server/store.ts:35    class Store
src/server/store.ts:110   load
src/server/store.ts:164   save
src/server/store.ts:198   saveImage
```

One data dir for each daemon, and one daemon for each port. Every Claude Code session on that port
shares the database through the daemon. The default data dir is `~/.inkwire` (`INKWIRE_DATA_DIR`) on port 4691. The dev
daemon (`yarn dev`) uses `~/.inkwire-dev` on port 4692. A daemon that a relay autostarts logs to
`daemon.log` in its data dir. Tests use temp dirs.

Beware: a daemon binds the port before it opens the store (`startDaemon`). A daemon that loses the
port race exits before it opens the DB.

## The plugin

Inkwire ships as a Claude Code plugin and as its own one-plugin marketplace. None of this is `.ts`;
build first, because the manifest runs `dist/link/relay.js`. A relay change needs `yarn build`.

- `.claude-plugin/plugin.json` — manifest and the `mcpServers` entry (`node ${CLAUDE_PLUGIN_ROOT}/dist/link/relay.js`).
- `.claude-plugin/marketplace.json` — the marketplace listing.
- `hooks/hooks.json`, `hooks/forward.sh` — see Session mode and hooks.
- `skills/use-inkwire`, `skills/back-to-claude-code`, `skills/trace-path` — `trace-path` is
  model-invocable.
- `.claude/skills/ship` — dev-only, not part of the plugin.
- `.claude/settings.json` — the Session tab's two requirements for this repo
  (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, permission mode `auto`).
