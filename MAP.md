# inkwire — code map

Where each task surface starts and which files it runs through. Read the entry for what you are
changing, then open those files. Do not grep first.

Anchors are `path:line  symbol`. A Stop hook (`scripts/map-anchor-check.mjs`, run by hand with
`yarn map-anchors`) re-reads every anchor that points into a file your branch changed and blocks if
the symbol moved. Keep them current, and add an entry when you add a task surface.

Anchor declarations in hand-written source only — a function, class, type, constant, `case` or
`register` line. Never anchor a generated file (`schema/*.generated.json`), and prefer a
distinctive identifier over a word that also occurs inside a string: the check is whole-word, so a
near-miss rename still trips it, but a vague anchor buys little. Describe those files in prose
instead. The plugin files (`plugin/.claude-plugin/`, `plugin/hooks/`, `plugin/skills/`), the
marketplace (`.claude-plugin/marketplace.json`) and `plugin/src/ui/styles.css` are not `.ts`, so
they are described in prose too.

The plugin root is `plugin/`. It holds the manifest, the hooks, the skills, the fonts and the
source (`plugin/src/`). Node runs the TypeScript source directly (type stripping): there is no
build step and no `dist/`. Relative imports use the `.ts` extension, and only syntax that Node can
strip is allowed (`erasableSyntaxOnly`: no `enum`, `namespace` or constructor parameter
properties). Import each type with `import type`. `tests/`, `scripts/`, `schema/` and the docs stay
at the repo root.

Product rules and the test list are in `CLAUDE.md`. The authority for behaviour is
`design_handoff_inkwire/` (local only): `SPEC.md` wins over the prototype.

## Server bootstrap

`openCore` (`bootstrap.ts`) opens the store, builds `Sessions` and `Clients`, the panel hub and
the screenshot broker (with the fonts that `installFonts` copies to the data dir), and attaches the
HTTP request handler and `routeUpgrades` to an http server.
The plugin runs the relay (`sh plugin/src/link/relay.sh`, which runs `relay.ts` with a Node 26, see
The link); the daemon is the one server entry.
`daemon.ts` `startDaemon` is the daemon entry: it hashes and registers its build (see Daemon
lifetime and builds), binds the port first, then calls `openCore` in the listen callback, and
serves one McpServer per relay link (see The link). The entry starts the panel bundle at boot, in
memory (see Panel UI). `routeUpgrades` sends `/ws` to `PanelHub.handleUpgrade`
and `/mcp` to the link endpoint, and destroys every other upgrade.

The port race is now between two daemons: two relays that start at the same time can each spawn
one, and the daemon that loses the port exits before it opens the store (see Daemon lifetime and
builds). On EADDRINUSE the daemon calls `probeHealth` (`plugin/src/link/probe.ts`), which tells an
inkwire (a daemon or an old server) from another process.

```
plugin/src/server/bootstrap.ts:50  openCore
plugin/src/server/daemon.ts:114    startDaemon
plugin/src/link/probe.ts:49        probeHealth
plugin/src/server/config.ts:18     loadConfig
plugin/src/server/upgrade.ts:11    routeUpgrades
plugin/src/server/http.ts:84       requestHandler
plugin/src/server/http.ts:94       createHttpServer
plugin/src/server/http.ts:98       handle
plugin/src/server/http.ts:431      serveFile
plugin/src/server/origin.ts:12     checkBrowserRequest
plugin/src/server/ws.ts:30         PanelHub
plugin/src/server/ws.ts:87         handleUpgrade
plugin/src/server/mcp.ts:82        buildMcpServer
```

Env: `INKWIRE_PORT`, `INKWIRE_DATA_DIR`, `INKWIRE_IDLE_GRACE_MS` (daemon only; default 30000, `off`
turns the idle stop off). There is no project-root env (see Project root). HTTP serves the panel
(`uiFiles`, see Panel UI) and the routes `/healthz`, `/api/boards` (each entry has `project_root`, the unset
mark and `author: { label, pid } | null`), `/api/boards/:id/export`,
`/api/boards/import`, `/api/capture/:id`, `/api/hook`, the mod's routes `GET /api/mod/view`
and `POST /api/mod/take` (see The mod), and on the daemon
`POST /api/daemon/restart`.

Beware: the Origin and Host check (`checkBrowserRequest`, M4.11). Every `POST`, `PUT`, `DELETE`
and `PATCH`, every `/api/mod/*` request (also `GET`: the view holds the board), the `/ws` upgrade (`verifyClient` in `ws.ts`) and the `/mcp` upgrade need `Host`
`127.0.0.1:<port>` or `localhost:<port>`, and, when an `Origin` is present, the same origin over
`http`. A request with no `Origin` passes (the hook's curl, the mod, `yarn daemon:restart`). A refusal is a
403 and one stderr line.

Beware: stdout is the MCP transport of the relay. Log to stderr only. Only the spawned smoke test
(relay plus daemon) catches a stray `console.log`. The daemon writes nothing to stdout; a relay
that starts it sends its stdout and stderr to `daemon.log`.

Tests: `tests/integration/server.test.ts`, `tests/integration/daemon-port.test.ts`,
`tests/tools/stdio-smoke.test.ts`, `tests/integration/origin.test.ts`,
`tests/integration/port-conflict.test.ts` (two sessions share one daemon), and the health suite
`tests/health/` (`yarn health`, see The link).

## The link (relay and daemon)

Each Claude Code session runs the relay (`plugin/src/link/relay.ts`), which pipes MCP between stdio and the
daemon's `/mcp` WebSocket (ADR 0001). The link is a replaceable layer: its whole contract with the
daemon is a `Link` — an MCP SDK `Transport` (`WsTransport`, one JSON-RPC message per text frame),
the `hello` value, and a `closed` promise. The first frame must be the hello (`helloSchema`: pid
(the relay's `ppid`), session id, cwd, build, optional `term_program`, and `current_board` after a
reconnect). The daemon's `createLinkHost` makes or fills the Client of the hello's pid, attaches the
link, and connects a new McpServer to it. Reconnect lives only in `RelayCore`.

```
plugin/src/link/hello.ts:14        helloSchema
plugin/src/link/hello.ts:7         LINK_VERSION
plugin/src/link/ws-transport.ts:8  WsTransport
plugin/src/link/endpoint.ts:11     Link
plugin/src/link/endpoint.ts:34     createLinkEndpoint
plugin/src/link/ws-client.ts:7     connectLink
plugin/src/link/relay.ts:15        main
plugin/src/link/relay-core.ts:63   RelayCore
plugin/src/link/relay-core.ts:161  attach
plugin/src/link/relay-core.ts:201  fromDown
plugin/src/link/relay-core.ts:228  fromUp
plugin/src/link/relay-core.ts:246  track
plugin/src/link/relay-core.ts:255  upClosed
plugin/src/link/relay-core.ts:297  fatal
plugin/src/link/relay-core.ts:49   LOST_TEXT
plugin/src/server/daemon.ts:35     createLinkHost
plugin/src/server/clients.ts:530   restoreCurrentBoard
```

Beware: the Node version. `plugin.json` runs `sh plugin/src/link/relay.sh`, not `node relay.ts`:
Claude Code starts the server in the cwd of the session, and the `node` on PATH can come from the
`.nvmrc` of that project. `relay.sh` runs the `node` on PATH when it is 26 or later, else `mise x
node@26 -- node`, else it stops with a message on stderr. Each step uses `exec`, so the relay's
`ppid` (the hello pid) stays the Claude Code pid. `relay.ts` imports `node-version.ts` first
(`NODE_MAJOR`), which stops an older Node that can read `.ts` with a clear message.
Tests: `tests/link/relay-launcher.test.ts`.

```
plugin/src/link/node-version.ts:7  NODE_MAJOR
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

Beware: the boundary. Nothing outside `plugin/src/link/` imports `ws` for MCP; `plugin/src/server/ws.ts` (the
panel hub) is the one other `ws` user and must not touch `/mcp`. The relay must not import the
store, `session.ts` or better-sqlite3. `tests/link/boundary.test.ts` enforces all three.

Tests: `tests/link/boundary.test.ts`, `tests/link/endpoint.test.ts`, `tests/link/relay-core.test.ts`,
`tests/link/relay-spawn.test.ts`, `tests/integration/daemon.test.ts`.

Health suite (`yarn health`, plan M8): `tests/health/` with the link, daemon and gate tests. No
build step: every relay runs from the source. `startRelays` (`tests/health/harness.ts`) spawns n relays at one time, each under its own
`sh -c` wrapper so each has its own Claude Code pid, on a random port with a temp dir; the first
relay autostarts the daemon. `tools.test.ts` has one case for each name in `WRITE_TOOLS`,
`READ_TOOLS` and `OWN_RULE_TOOLS` and checks the set against `tools/list`, so a new tool with no
health case fails. `lifecycle.test.ts` covers autostart, the race, release on close, `/clear`,
SIGKILL and reconnect, a stale build (a copy of `plugin/src/` with one more file, so another
build id), both restarts, the idle grace, and the relay as the plugin runs it (`relayEntry`: `sh
<plugin root>/src/link/relay.sh`, from a cwd outside the repo, with the test's node first on PATH).

```
tests/health/harness.ts:157  startRelays
tests/health/harness.ts:79   startRelay
tests/health/harness.ts:116  openPanel
tests/health/harness.ts:67   relayEntry
```

Beware: the relay runs with `node` and no loader (no tsx), as the manifest runs it through `relay.sh`. A relative
import without `.ts`, a type import without `import type`, or syntax that Node cannot strip stops
the relay at startup. `yarn typecheck` finds all three; `tests/tools/stdio-smoke.test.ts` and the
health suite find them at run time.

## Daemon lifetime and builds

The relay finds or starts the daemon (`ensureDaemon`): it probes `/healthz`, and when no inkwire
answers, it spawns a detached daemon with the relay's `process.execPath`, which logs to
`<dataDir>/daemon.log`, then polls for 10 s. A racing second daemon loses the port before it opens
the store and exits 0. Only the person restarts the daemon: the panel's Restart (the
`daemon_restart` intent, accepted only for the build id that the stale notice showed) or `POST
/api/daemon/restart` (`yarn daemon:restart`, `scripts/daemon-restart.mjs`). Both run
`createRestart` — persist every board, stop listening, close every link, exit 0 — and the relays
reconnect and autostart the newest build. The `IdleTimer` stops the daemon `INKWIRE_IDLE_GRACE_MS`
after its last link closes (at boot it waits at least 10 s).

The build is the source. `readBuildInfo` hashes every file under `plugin/src/` server, core,
shared, link and ui (`BUILD_DIRS`), and `package.json`, `package-lock.json` and `assets/fonts/` of
the plugin root (`BUILD_ROOT_PARTS`), so a release that changes only a dependency is a new build. It
hashes relative paths and content, not the folder path, so the same plugin in two cache folders is
one build. Claude Code installs each update into a new cache folder
(`~/.claude/plugins/cache/inkwire/inkwire/<sha>/`; no `version` field, so the sha is the version)
and removes an old folder 14 days later. The order of the builds comes from the build registry,
`<dataDir>/builds.json` (`REGISTRY_FILE`): build id → `{ root, first_seen, last_seen, pids }`,
where `root` is the plugin root and `pids` are the Claude Code pids of its relays (the last
`PIDS_KEPT`). `currentBuild` hashes and registers (`registerBuild`): each relay at its start with
its `ppid`, and each daemon at boot with `touch: false`. A known build keeps its `first_seen` and
gets the new root. `last_seen` changes only when a relay of a new pid registers it: a relay that
starts again in the same Claude Code process, and a daemon, do not change the order. Other entries
are removed when their daemon entry is gone or when they have the same root (one folder holds one
build at a time). The `BuildInfo` of a relay or daemon is `{ id, built_at }`, where `built_at` is
the registry's `last_seen` (the hello keeps the name, so an old daemon reads a new relay's hello).
The daemon reads its build one time, at boot (Decision 10), and `/healthz` reports `{ ok, name,
pid, build, clients, boards }`.

"Newer" (`liveBuilds`, `isNewerBuild`): an installed build (`isInstalledRoot`: a root in the
Claude Code plugin cache) comes before a checkout build, then the later `last_seen`. So a
`--plugin-dir` run or `yarn start` on the default data dir does not take over the daemon of the
installed plugin, and a downgrade (a new session of an older installed build) makes the older build
the newest. The daemon that a relay starts is the first of `daemonRoots`: the registered builds
whose daemon entry is still on disk, newest first, then the relay's own root (`daemonEntry`), with
the cwd at that root. `ensureDaemon` calls the relay's `register` first (it puts a lost entry back
with the relay's own time). When a daemon exits with an error before it answers, `ensureDaemon`
starts the next root; exit 0 is the loser of a port race, and the poll goes on.

```
plugin/src/link/autostart.ts:65     ensureDaemon
plugin/src/link/autostart.ts:44     daemonEntry
plugin/src/link/autostart.ts:53     daemonRoots
plugin/src/link/autostart.ts:59     pickDaemonRoot
plugin/src/link/probe.ts:26         probeDaemon
plugin/src/server/build-info.ts:109 readBuildInfo
plugin/src/server/build-info.ts:68  BUILD_DIRS
plugin/src/server/build-info.ts:71  BUILD_ROOT_PARTS
plugin/src/server/build-info.ts:74  REGISTRY_FILE
plugin/src/server/build-info.ts:77  PIDS_KEPT
plugin/src/server/build-info.ts:90  isInstalledRoot
plugin/src/server/build-info.ts:160 readRegistry
plugin/src/server/build-info.ts:263 registerBuild
plugin/src/server/build-info.ts:305 currentBuild
plugin/src/server/build-info.ts:329 liveBuilds
plugin/src/server/build-info.ts:342 isNewerBuild
plugin/src/server/idle.ts:22        IdleTimer
plugin/src/server/restart.ts:22     createRestart
plugin/src/server/http.ts:79        defaultStats
plugin/src/server/clients.ts:550    markStale
plugin/src/server/clients.ts:558    STALE_NOTICE
```

Beware: bind first. `startDaemon` listens on the port before it opens the store. On EADDRINUSE it
exits 0 when an inkwire answers (no DB opened) and 1 when another process holds the port. It has
no stdin close handler: a detached daemon has stdin set to `ignore`.

Beware: `/healthz` with `name: "inkwire"` and no `build` is an old inkwire server (a build from
before the daemon sends no build). `ensureDaemon` then stops the relay with "port N is held by an old inkwire
server; close the old Claude Code sessions" and does not reconnect.

Beware: stale builds (Decision 7). A hello whose build id differs and whose build is newer
(`isNewerBuild`: the order above from the registry; a build that is not registered is a checkout
build at the hello's `built_at`) sets `clients.staleBuild` and puts `STALE_NOTICE` on that Client's next tool
result. Nothing restarts by itself. There is no MCP tool for restart; agents must not call the
restart route or `yarn daemon:restart`.

Beware: a running daemon must not read its plugin folder after boot: the folder can be gone. The
panel comes from memory (see Panel UI) and the fonts from the data dir (see Rendering). Node loads
every server module at boot, so the source is not read again.

Beware: the registry write is read-modify-write with a rename, under a lock file
(`builds.json.lock`, made with the `wx` flag; a lock older than 5 s is removed, and after 2 s the
write goes on with no lock). A `builds.json` that is there but bad is not written over: it moves to
`builds.json.bad`, and a new registry starts.

Beware: `yarn dev` runs the dev daemon on 4692 with `~/.inkwire-dev`, `INKWIRE_IDLE_GRACE_MS=off`
and `INKWIRE_UI_WATCH=1`. Tests use random ports and temp dirs and never bind 4691 or 4692.

Tests: `tests/server/idle.test.ts`, `tests/integration/daemon-port.test.ts`,
`tests/integration/daemon.test.ts`, `tests/link/relay-spawn.test.ts`, `tests/server/build-info.test.ts`
(the registry, the lock, the order, a downgrade, a checkout run and the autostart choice),
`tests/link/autostart.test.ts` (the fallback when the newest daemon cannot start), `tests/server/ui-bundle.test.ts`, and the
health case for a stale build (`tests/health/lifecycle.test.ts`: a restart starts the newer build,
and the build before it when the newer folder is gone).

## The write path

Every mutation, from an MCP tool or a WS intent, goes through `BoardSession.mutate`. It diffs,
appends to history, refolds, bumps revisions, schedules a 500 ms persist, and notifies listeners.
MCP handlers pass author `"ai"`, WS handlers pass `"human"`. Authorship is never a tool argument.

```
plugin/src/server/session.ts:70     class BoardSession
plugin/src/server/session.ts:59     MutationSpec
plugin/src/server/session.ts:166    mutate
plugin/src/server/session.ts:150    refold
plugin/src/server/session.ts:402    schedulePersist
plugin/src/server/session.ts:408    persistNow
plugin/src/server/session.ts:393    onChange
plugin/src/server/session.ts:452    class Sessions
plugin/src/server/session.ts:507    open
plugin/src/server/session.ts:491    onBoards
plugin/src/server/mutations.ts:49   addNode
plugin/src/server/mutations.ts:125  addEdge
plugin/src/server/mutations.ts:202  deleteElement
plugin/src/server/mutations.ts:225  moveElement
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
plugin/src/core/fold.ts:65        fold
plugin/src/core/fold.ts:19        applyCollOps
plugin/src/core/fold.ts:37        applyLayoutOps
plugin/src/core/fold.ts:96        applyStep
plugin/src/core/state.ts:80       buildCanvasState
plugin/src/core/state.ts:36       historySummary
plugin/src/core/state.ts:63       strokeSummaries
plugin/src/server/session.ts:361  state
```

A step whose op missed (add over an existing id, set or del of an absent id) is flagged conflict.
Dropping the add-B step prunes the edge and flags the step that added it.

Beware: `plugin/src/core/` is pure: no I/O, no clock, no randomness. Clock and id-gen are injected.
`tests/core/purity.test.ts` enforces it.

Tests: `tests/core/fold.test.ts` (drop-node regression), `tests/core/properties.test.ts` (the eight
TESTS.md invariants, fast-check).

## History: coalesce, rewind, skip, drop, undo

Whole-item `set` ops, not field patches. `append` records a step, or coalesces into the tip.

```
plugin/src/core/history.ts:6      COALESCE_WINDOW_MS
plugin/src/core/history.ts:34     append
plugin/src/core/history.ts:88     rewindTo
plugin/src/core/history.ts:94     toggleSkip
plugin/src/core/history.ts:103    dropStep
plugin/src/core/history.ts:117    undo
plugin/src/core/history.ts:129    redo
plugin/src/core/diff.ts:39        diffCollections
plugin/src/core/diff.ts:49        isEmptyOps
plugin/src/server/session.ts:202  historyOp
plugin/src/server/session.ts:379  historyRows
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
plugin/src/core/infer.ts:36         inferStructure
plugin/src/core/geometry.ts:11      bbox
plugin/src/core/geometry.ts:30      isClosed
plugin/src/core/geometry.ts:46      nearestNode
plugin/src/core/geometry.ts:83      edgeEndpoints
plugin/src/server/mutations.ts:293  inferFromInk
plugin/src/server/mutations.ts:247  addStroke
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
plugin/src/server/mcp.ts:82   buildMcpServer
plugin/src/server/mcp.ts:50   WRITE_TOOLS
plugin/src/server/mcp.ts:61   READ_TOOLS
plugin/src/server/mcp.ts:71   OWN_RULE_TOOLS
plugin/src/server/mcp.ts:80   callCtx
plugin/src/server/mcp.ts:87   resolve
plugin/src/server/mcp.ts:105  writable
plugin/src/server/mcp.ts:121  created
plugin/src/server/mcp.ts:141  recordCall
plugin/src/server/mcp.ts:172  register
plugin/src/server/mcp.ts:249   register("boards.list"
plugin/src/server/mcp.ts:255   boards.open
plugin/src/server/mcp.ts:291   register("boards.release"
plugin/src/server/mcp.ts:375  get_state
plugin/src/server/mcp.ts:403  screenshot
plugin/src/server/mcp.ts:422  infer_structure
plugin/src/server/mcp.ts:430   register("canvas.add_node"
plugin/src/server/mcp.ts:486  bind_code
plugin/src/server/mcp.ts:549  lint
plugin/src/server/mcp.ts:566   history.get
plugin/src/server/mcp.ts:578   layers.list
plugin/src/server/mcp.ts:649   paths.create
plugin/src/server/mcp.ts:698   paths.play
plugin/src/server/mcp.ts:719   drafts.create
plugin/src/server/mcp.ts:765   notebooks.create
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

The push (`state`) carries the board (with ink geometry), its history rows, `session` and `daemon`
(`PanelHub.push` builds it). The mod's view reads only the `author` field (`PanelHub.author`). `session` has the
board's `author` (`{ pid, label, mode, pending, awaiting, notice }` or null; `pending` is true while the
Author's send blocks on this board or, with mod delivery, while it awaits the reply; `awaiting` is
true only in the second case, for the Release confirm text), `readers` (a count of the
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
plugin/src/shared/protocol.ts:15   clientIntentSchema
plugin/src/shared/protocol.ts:154  clientMessageSchema
plugin/src/shared/protocol.ts:171  captureRequestSchema
plugin/src/shared/protocol.ts:200  SessionPush
plugin/src/shared/protocol.ts:226  ServerMessage
plugin/src/server/ws.ts:137        handle
plugin/src/server/ws.ts:141          case "add_node":
plugin/src/server/ws.ts:195          case "board_release": {
plugin/src/server/ws.ts:205          case "board_allow":
plugin/src/server/ws.ts:210          case "daemon_restart": {
plugin/src/server/ws.ts:20         HubDeps
plugin/src/server/ws.ts:275        strip
plugin/src/server/ws.ts:299        daemon
plugin/src/server/ws.ts:323        fanOut
plugin/src/server/ws.ts:341        push
plugin/src/server/ws.ts:364        requestCapture
plugin/src/server/clients.ts:254   peekLinked
plugin/src/shared/protocol.ts:179  AuthorPush
plugin/src/shared/protocol.ts:213  DaemonPush
plugin/src/ui/ws-client.ts:8       connectWs
plugin/src/ui/ws-client.ts:120     answerCapture
plugin/src/ui/app.ts:91            isServerMessage
```

A rejected intent triggers a re-sync push to every panel of the board. On board delete the socket
closes with code 4010.

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

`plugin/src/shared/schemas.ts` is the single zod source for elements, `CanvasState`, and every tool's args.
JSON Schema is generated from it into `schema/canvas-state.generated.json` and
`schema/tools.generated.json` (never hand-edit). The design-authored oracle is
`tests/fixtures/contract/`.

```
plugin/src/shared/schemas.ts:26   nodeSchema
plugin/src/shared/schemas.ts:36   edgeSchema
plugin/src/shared/schemas.ts:95   layerSchema
plugin/src/shared/schemas.ts:151  canvasStateSchema
plugin/src/shared/schemas.ts:193  toolArgs
plugin/src/shared/schemas.ts:369  ToolName
plugin/src/shared/types.ts:10     NODE_KINDS
scripts/gen-schemas.ts:11         toJSONSchema
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
plugin/src/ui/main.ts:17     boot
plugin/src/ui/main.ts:65     showBoardPicker
plugin/src/ui/app.ts:73      KIND_META
plugin/src/ui/app.ts:106     focusLayer
plugin/src/ui/canvas.ts:57   setupCanvas
plugin/src/ui/canvas.ts:628  renderWorld
plugin/src/ui/canvas.ts:565  hitNode
plugin/src/ui/canvas.ts:619  deleteSelection
plugin/src/ui/panel.ts:176   setupPanel
plugin/src/ui/panel.ts:347   renderPanel
plugin/src/ui/panel.ts:374   renderInspector
plugin/src/ui/panel.ts:641   staleStrip
plugin/src/ui/panel.ts:939   renderFooter
plugin/src/ui/panel.ts:620   renderAsideStrip
plugin/src/ui/panel.ts:666   renderLayers
plugin/src/ui/panel.ts:511   renderHistory
plugin/src/ui/panel.ts:108   loadPanelPrefs
```

The aside strip (`renderAsideStrip`) shows the stale-build notice (`staleStrip`, with Restart:
the confirm lists every open board and every Claude Code session and says that undo history and
every pending `session_send` are lost) above the highlight strip. Nothing draws over the graph.
The board picker (`showBoardPicker`) shows each board's `project_root` (or `root: unset`) and its
Author from `GET /api/boards`. The panel treats `author`, `readers`, `released_from`, `daemon` and
the picker's `author` as optional: a new bundle can load from an older running daemon.

Styles are in `plugin/src/ui/styles.css`; `plugin/src/ui/index.html` is the shell. A browser cannot
run `.ts`, so the daemon bundles `plugin/src/ui/main.ts` with esbuild in memory
(`createUiBundle`, no `dist/`), keeps `index.html` and `styles.css` with it, and serves `/`
(`index.html`), `/main.js`, `/main.js.map` and `/styles.css` from memory only. The daemon entry
starts the bundle at boot (`Daemon.ui`, passed to the HTTP handler as `ui`); each later call gets
the same files, and a failed bundle is tried again on the next request. `uiFiles` is the bundle of
this copy for a server that was given none (in-process tests). esbuild is a runtime dependency, and
it loads through a dynamic import, so the relay does not load it.

`yarn dev` sets `INKWIRE_UI_WATCH=1`: the bundle then uses an esbuild watch context and makes the
files in memory again after each change to the panel source (`index.html` and `styles.css` have
their own `fs.watch`). The dev daemon restarts only on a change under `plugin/src/` server, core,
shared or link. Reload the page to see a panel change. In other daemons, a change to the panel
shows after a daemon restart.

```
plugin/src/server/ui-bundle.ts:56  createUiBundle
plugin/src/server/ui-bundle.ts:148 uiFiles
```

Beware: no request reads the plugin folder. Claude Code installs each update into a new cache
folder (`~/.claude/plugins/cache/inkwire/inkwire/<sha>/`) and removes an old folder 14 days later,
while a daemon of that build can still run. Keep every panel file in the bundle, and read nothing
from `plugin/` after boot. `tests/server/ui-bundle.test.ts` serves the panel after it renames the
source folder away.

Beware: `plugin/src/shared/tokens.ts` holds the canvas colors both renderers read, because resvg cannot
read CSS variables. Keep it in step with `plugin/src/ui/styles.css`.

Beware: a path like `_ds/industry-*/` inside a CSS comment ends the comment at `*/` and silently
swallows the rules after it.

Beware: the panel is browser-only. Do not add MCP Apps embedding without a spike on iframe to
127.0.0.1 WebSocket access.

## Rendering, screenshots, LOD

`canvas_screenshot` has two routes. The server renders an SVG and rasterizes it with resvg. When a
panel is connected, the server can ask it for a capture over WS. Level of detail (zoom steps, label
wrapping) is shared code in `core/lod.ts`.

```
plugin/src/server/render-svg.ts:25   renderBoardSvg
plugin/src/server/render-svg.ts:150  fitViewport
plugin/src/server/rasterize.ts:54    rasterizeSvg
plugin/src/server/rasterize.ts:73   rasterizeIsolated
plugin/src/server/render-svg.ts:138  arrowHead
plugin/src/server/screenshot.ts:9    CaptureBroker
plugin/src/server/screenshot.ts:26   Screenshots
plugin/src/ui/capture.ts:10          captureBoard
plugin/src/core/lod.ts:18            lodFor
plugin/src/core/lod.ts:48            wrapText
plugin/src/shared/tokens.ts:53       RENDER
```

Fonts are in `plugin/assets/fonts/`. At boot, `openCore` calls `installFonts`, which copies them
to `<dataDir>/fonts/` (it writes a file only when it is missing or its content differs) and gives
their paths to `Screenshots`; each render loads them from there. The native `@resvg/resvg-js`
2.6.2 reads fonts from files only (`fontBuffers` is in its WASM build only), so the fonts go to the
data dir, not to memory. A render never reads the plugin folder, which Claude Code can remove after
an update. A capture that the client does not answer within `CLIENT_TIMEOUT_MS` falls back to the
server render.

```
plugin/src/server/rasterize.ts:26    installFonts
```

Beware: the daemon never runs resvg itself. `Screenshots` calls `rasterizeIsolated`, which runs
`rasterizeSvg` in a child process (`rasterize-child.ts`): a Rust panic in resvg aborts the whole
process, and no try/catch stops it. A failed render is an error of the tool call. The server render
draws arrowheads as plain paths (`arrowHead`), never SVG markers: resvg 2.6.2 panics on a marker
whose edge ends far outside the image.

Beware: screenshots ignore focus (layers). Tokens must match in both renderers.

Tests: `tests/core/lod.test.ts`, `tests/server/fonts.test.ts`.

## Session mode and hooks

A flag on each Client moves replies from the terminal into the panel's Session tab. `session_send`
blocks until the human answers, except with mod delivery (ADR 0004, see The mod): while the Client
has a live mod, it returns `delivered` at once and the reply comes back as the next user prompt. The plugin's hook script forwards Claude Code events to the server,
which blocks `Stop` while that Client's mode is on. Every function takes `(clients, client, …)`.

```
plugin/src/server/session-mode.ts:56   sessionMode
plugin/src/server/session-mode.ts:165  sessionSend
plugin/src/server/session-mode.ts:295  sessionReply
plugin/src/server/session-mode.ts:403  hookEvent
plugin/src/server/session-mode.ts:27   BLOCK_CEILING
plugin/src/server/session-mode.ts:28   AUTO_MODES
plugin/src/server/session-mode.ts:145  releaseAuthorship
plugin/src/server/session-mode.ts:500  terminalProgram
plugin/src/server/session-mode.ts:505  focusTerminal
plugin/src/server/clients.ts:16        HookReport
plugin/src/server/http.ts:135           /api/hook
plugin/src/ui/session.ts:73            setupSession
plugin/src/ui/session.ts:169           renderSession
plugin/src/ui/session.ts:373           messageCard
plugin/src/ui/session.ts:38            stripView
plugin/src/ui/session.ts:67            agentState
plugin/src/ui/session.ts:353           authorRow
```

Hook files (not `.ts`): `plugin/hooks/hooks.json` wires `Stop`, `PreToolUse` on the `session_mode` tool,
`UserPromptSubmit` (it clears `awaiting` and `delivered` when the mod is gone), and `SessionStart`
with matcher `compact|clear|resume`. `plugin/hooks/forward.sh` finds the Claude Code
pid (the nearest ancestor whose `comm` or first `args` word is `claude`), POSTs the event to
`/api/hook?pid=<n>`, and prints the verdict (`block`, `context`, or `ok`). It exits 0 on every
failure. `plugin/hooks/hooks.json` also names the mod module (`"modules": ["./mod/register.tsx"]`).
`forward.sh` stays as the fallback when mods are off.

Hook events can also come from the mod (`/api/hook?via=mod`, no pid). `hookEvent` finds a mod
event's Client by `session_id`, else by `prev_session_id`, and never makes a Client; it marks
`client.modHookAt`. A `forward.sh` event with a pid first sets the Client's session id to the
event's (the pid is the true key). A `forward.sh` event for a Client whose hooks the mod answers
(`modAnswersHooks`) only rekeys and returns `ok`: no hook report change and no block count,
because the mod already sent the same event. `UserPromptSubmit` clears `awaiting` and `delivered`.

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
`bypassPermissions`, and `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` is `0` (`blockingProblem`). With a live mod, only the
hook event is necessary: nothing blocks. The result has `delivery: "mod" | "block"`. A repeated
`on` keeps `awaiting`, `delivered` and the inbox. `session_send` times out after
20 min, returns `idle`, and turns the mode off. Without a live mod, in a session that
`blockingProblem` refuses, `session_send` does not block: it turns the mode off and returns
`mode_off`. The server gives up blocking `Stop` after 3 in a row. `Stop` passes while the Client
is `awaiting` or `delivered` and its mod is live (mod delivery: the turn ends); with no live mod it
clears both and blocks as usual. Every way out of the mode (`modeOff`, and
`boardDeleted`) clears `awaiting`, `delivered` and the inbox (`clearMod`).

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

Tests: `tests/tools/session.test.ts`, `tests/tools/forward-hook.test.ts`, `tests/tools/mod.test.ts`.

## The mod

ADR 0004. A Claude Code mod (a hooks module) beside the transcript. The browser stays the ink
surface. The mod does three things: mod delivery for session mode, the hook events in place of
`plugin/hooks/forward.sh`, and one status line (`inkwire · <board> · <state>`) with the `/inkwire` command
(the status and the panel URL; `send` and `discard` for refused replies). The mod is person-side
UI. It uses only the daemon's HTTP routes, never `$.mcp.call`. It names its Client by the Claude Code
session id (`Clients.bySessionId`), because the mods API has no pid. A session id that two Clients
hold names no Client. The mod's own files are under
`plugin/hooks/mod/` (not `.ts` in `plugin/src/`); `plugin/hooks/mod/register.tsx` is the module.

```
plugin/src/server/clients.ts:34        ModReply
plugin/src/server/clients.ts:42        MOD_TTL_MS
plugin/src/server/clients.ts:178       markMod
plugin/src/server/clients.ts:183       markModHook
plugin/src/server/clients.ts:191       hasLiveMod
plugin/src/server/clients.ts:199       modAnswersHooks
plugin/src/server/clients.ts:204       clearMod
plugin/src/server/clients.ts:264       bySessionId
plugin/src/server/session-mode.ts:107  blockingProblem
plugin/src/server/session-mode.ts:165  sessionSend
plugin/src/server/session-mode.ts:295  sessionReply
plugin/src/server/session-mode.ts:373  modPrompt
plugin/src/server/session-mode.ts:403  hookEvent
plugin/src/server/http.ts:295          handleMod
plugin/src/server/http.ts:346          modView
plugin/src/server/http.ts:369          waitForChange
plugin/src/server/http.ts:63           ModHub
plugin/src/server/ws.ts:337            author
```

Routes (all take the session id; only the view marks `client.mod.at`):

- `POST /api/hook?via=mod&bg=…` — the classic event's JSON plus `prev_session_id?`. The same text
  verdict as for `forward.sh`. The mod sends it only after a view answered `200`: a daemon from
  before ADR 0004 answers `404`, and the mod then leaves each event to `forward.sh`.
- `GET /api/mod/view?session=&alias=&since=&wait=` — long poll. `alias` is the mod's launch id:
  when no Client has `session`, the Client with `alias` is rekeyed to `session` (a hello after
  `/clear` sends the launch id). `200 { key, client, board }`. It answers
  at once when the key is not `since`, else on a change, else after `wait` (at most 25000 ms) with
  the same key. The key is a hash of the body. `client` is `{ pid, label, mode, awaiting, inbox,
  current_board }` or null; `board` is `{ id, name, author }` (`author` is the push's
  `AuthorPush`, from `PanelHub.author`) or null. An edit of the board does not change the key.
- `POST /api/mod/take` — `{ session }`. `{ replies: [{ id, prompt }] }`, and the inbox empties.
  `400` for a bad body, `404` for an unknown session.

Beware: liveness. A Client has a live mod while the mod's view loop polled for it in the last
`MOD_TTL_MS` (45 s); the long poll waits at most 25 s, so a running loop stays live. A mod hook
event does not make the mod live (a mod whose loop stopped cannot take the inbox); it only makes
the mod answer the hooks (`modAnswersHooks`). Liveness picks the delivery model at `session_send` time.

Beware: mod delivery. `session_send` with a live mod sets `awaiting` and `delivered` and returns `delivered`. No
timer, no pending send. A panel reply with no pending send but `awaiting` adds the `you`
row and puts `{ id, prompt }` in the inbox (`modPrompt`: the reply, `inkwire ctx: <json ids and
board>`, `Answer with session_send.`). With `awaiting` but no live mod, the reply fails and tells
the person to type in the terminal. A reply that waits in the inbox while the mod is gone stays
there until the mod takes it or the mode goes off.

Beware: the long poll listens to `Sessions.onChange` (every `Clients.notify`) and to the current
board's `onChange`, checks one time per burst (`setImmediate`), and removes its listeners and timer
when the response closes. A change that the view does not show (for example a hook report) does
not change the key.

Beware: the mod's outbox (`live.ts`). The mod marks a reply in `$.state` before
`$.prompt.submit`, so a reload never submits it twice. A reply leaves when the submit resolves or
when `classic.UserPromptSubmit` shows its text. A refused reply, or one that did not start a turn
within two main turns, waits for the person (`/inkwire send`, `/inkwire discard`); it is never
submitted again by itself. The outbox empties when the view shows a mode that is not `inkwire`.
The host refuses `$.prompt.submit` from a `command.run` hook: `/inkwire send` marks the reply new
again, and a `$.clock.after` timer runs `deliver` after the command returns.

Beware: the status line (`statusText` in `live.ts`, pure). The mod sets it on each view and on each
outbox change (`refreshStatus`), and only after the first view (`link.checked`). An outbox reply
wins over the mode: refused, then queued, then `pty`, `waiting on you`, `claude is working`.
A daemon that answers 404 on `/api/mod/view` (from before ADR 0004) is not a down daemon:
`fetchView` returns `OLD_DAEMON`, the link has `old`, and the status line says to restart it in
the panel. `/inkwire` then gives the panel URL with no board.

Mod files (not in `plugin/src/`, so no anchors): `register.tsx` (the hooks: `session.start`, `/inkwire`,
`classic.Stop|SessionStart|UserPromptSubmit|PreToolUse`, `turn.complete`),
`daemon.ts` (every HTTP call, each one in a race with a timeout; `DEFAULT_PORT`), `live.ts` (the
long-poll loop, take, `$.prompt.submit` of the outbox, the status line and `inkwireCommand`),
`contract.d.ts` (the state contract and copies of the daemon's wire types: change them when the
view shape changes). `plugin/.claude-plugin/plugin.json` names `contract.d.ts` as its `types`.

Beware: the mod cannot import `plugin/src/shared/` (zod). Keep the `Inkwire*` types a copy of
`ModViewBody` in `plugin/src/server/http.ts` and of `AuthorPush`.

Tests: `tests/tools/mod.test.ts`, `tests/integration/mod-routes.test.ts`, and
`tests/integration/mod-link.test.ts` (the mod's HTTP flow through a real relay that carries
`CLAUDE_CODE_SESSION_ID`). The mod's own tests: `plugin/hooks/mod/inkwire.test.tsx`, run with
`yarn plugin:test`; `yarn plugin:validate` runs `claude plugin validate` on the repo root (the
marketplace) and on `plugin/`. `yarn plugin:test` runs `claude plugin test plugin`, which collects every
`*.test.ts` and `*.test.tsx` under `plugin/`. Do not run `claude plugin test .` at the repo root: it
also collects `tests/**`. Keep test files out of `plugin/src/`.

## Clients and authorship

`Clients` (`plugin/src/server/clients.ts`, no I/O, clock from `Sessions.now`) keeps one `Client` for each
Claude Code pid (ADR 0001): `sessionId`, `cwd`, `label`, `termProgram`, `currentBoardId`, `mode`,
`hook`, `pending`, `blocks`, and the mod state (`mod`, `awaiting`, `inbox`; see The mod). It also keeps the Author of each board (`authors`, ADR 0002), the
pid the person released from each board (`releasedFrom`), the panel notice of each board
(`noticeByBoard`), and the one-time notices of each Client (M3.5). The daemon makes one Client per
hello pid (`createLinkHost`).

```
plugin/src/server/clients.ts:44   Client
plugin/src/server/clients.ts:92         class Clients
plugin/src/server/clients.ts:140  ensure
plugin/src/server/clients.ts:211  attach
plugin/src/server/clients.ts:225  detach
plugin/src/server/clients.ts:292  remove
plugin/src/server/clients.ts:306  sweep
plugin/src/server/clients.ts:319  boardDeleted
plugin/src/server/clients.ts:371  talkingOn
plugin/src/server/clients.ts:387  checkWrite
plugin/src/server/clients.ts:419  commitClaim
plugin/src/server/clients.ts:509  release
plugin/src/server/session.ts:485  onDelete
plugin/src/server/session.ts:570  resolve
plugin/src/server/clients.ts:107  releasedFrom
plugin/src/server/clients.ts:405  checkSwitch
plugin/src/server/clients.ts:451  allowAgain
plugin/src/server/clients.ts:459  addNotice
plugin/src/server/clients.ts:363  readerCount
plugin/src/server/clients.ts:242  peek
plugin/src/server/clients.ts:466  takeNotices
plugin/src/server/clients.ts:477  contextLine
plugin/src/server/mcp.ts:87       resolve
plugin/src/server/mcp.ts:105      writable
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
plugin/src/core/layers.ts:15      Tier
plugin/src/core/layers.ts:42      liveMembers
plugin/src/core/layers.ts:51      tiers
plugin/src/core/layers.ts:74      scopeState
plugin/src/core/layers.ts:28      downstream
plugin/src/server/layers.ts:36    createLayer
plugin/src/server/layers.ts:58    updateLayer
plugin/src/server/layers.ts:82    deleteLayer
plugin/src/server/session.ts:246  updateLayers
plugin/src/server/session.ts:257  setFocus
plugin/src/ui/panel.ts:666        renderLayers
```

Beware: layer members are never pruned when a node is deleted; `liveMembers` filters at read time.
Scoped reads (`get_state` with a scope) go through `scopeState`. Screenshots ignore focus.

Beware: no panel draws over the graph. Layer, draft and scrubber UI live in the aside; focus and draft state show in the canvas hint line; the canvas shows only nodes, edges, ink and the gold front (product decision, 2026-09-30).

Tests: `tests/core/layers.test.ts`.

## Paths and trace

A path is an ordered walk over a layer's edges with one caption per hop. `openTrace` puts it in the
board's trace, and the panel plays it as a vertical walk in the Layers tab (`renderLayers` mounts `renderWalk`). The `trace-path` skill writes one.

```
plugin/src/core/layers.ts:139     nextPathId
plugin/src/core/layers.ts:162     validateWalk
plugin/src/core/layers.ts:182     resolveNodesToSteps
plugin/src/core/layers.ts:210     pathsAffected
plugin/src/core/layers.ts:244     traceT
plugin/src/server/layers.ts:108   createPath
plugin/src/server/layers.ts:196   getPath
plugin/src/server/layers.ts:227   openTrace
plugin/src/server/session.ts:338  setTrace
plugin/src/server/session.ts:345  updateTrace
plugin/src/ui/canvas.ts:928       effectiveTrace
plugin/src/ui/canvas.ts:1093      renderTrace
plugin/src/ui/canvas.ts:1172      renderWalk
```

Each step with a ref carries a server-written `ref_hash`; `paths_update` takes `verify` to restamp hops (see Code binding and lint). The trace rides in `SessionPush`. The WS intents are `trace_set`, `trace_seek`, `trace_run`.

Beware: a delete or remove breaks paths (collateral); `pathsAffected` reports it. Only delete and
remove do this. A peek (holding a path row's play button) is panel-local and never sent to the server.

Tests: `tests/core/layers.test.ts`.

## Drafts

A draft is a view, like a layer. Creating, marking or activating one changes nothing on the board.
Marks give a node or edge a role (hue). `active_draft` is per board and shared by every panel.

```
plugin/src/core/drafts.ts:7       nextDraftId
plugin/src/core/drafts.ts:30      goneMarks
plugin/src/server/drafts.ts:23    createDraft
plugin/src/server/drafts.ts:42    updateDraft
plugin/src/server/drafts.ts:101   markElement
plugin/src/server/session.ts:270  updateDrafts
plugin/src/server/session.ts:278  setActiveDraft
plugin/src/ui/panel.ts:794        renderDrafts
```

Beware: `active_draft` is never persisted. The error hue is shared between draft roles and lint. Draft
hue tokens are mirrored in `tokens.ts` but the renderers do not read them. Scoped reads return whole
drafts.

Tests: `tests/core/drafts.test.ts`.

## Notebooks

Notebooks are prose panes beside the canvas. They replace note nodes. Bodies use a small markdown
subset with `[[ref]]` chips that resolve to nodes.

```
plugin/src/core/notebooks.ts:59     parseNotebook
plugin/src/core/notebooks.ts:85     refsIn
plugin/src/core/notebooks.ts:94     toggleTaskLine
plugin/src/core/notebooks.ts:111    goneRefs
plugin/src/core/notebooks.ts:142    resolveNotebookRefs
plugin/src/server/notebooks.ts:16   createNotebook
plugin/src/server/notebooks.ts:69   appendToNotebook
plugin/src/server/notebooks.ts:112  migrateNotes
plugin/src/server/session.ts:287    updateNotebooks
plugin/src/ui/notebook.ts:41        setupNotebook
plugin/src/ui/notebook.ts:136       renderNotebook
plugin/src/ui/notebook.ts:338       buildChip
```

Beware: prose is not a board element. A legacy `note` node is a lint error until `migrateNotes`
moves it into the `notes` notebook (`notes_migrate` WS intent). The panel tracks its own sends
(`noteOwnSend`) so it does not show a "changed" notice for its own edit.

Tests: `tests/core/notebooks.test.ts`.

## Code binding and lint

`canvas_bind_code` attaches a `file:symbol` ref to a node. `validateRef` checks it against the
board's `project_root` (see Project root). `lintBoard` reports findings for `canvas_lint`.

```
plugin/src/server/bindcode.ts:16  splitRef
plugin/src/server/bindcode.ts:42  validateRef
plugin/src/server/bindcode.ts:58  stampRef
plugin/src/server/bindcode.ts:67  refStatus
plugin/src/core/symbols.ts:24     findSymbol
plugin/src/core/symbols.ts:91     blockText
plugin/src/server/lint.ts:11      LintFinding
plugin/src/server/lint.ts:34      lintPath
plugin/src/server/lint.ts:67      lintBoard
```

Checks include `note_node`, `ref_missing`, `symbol_missing`, `unbound`, `path_broken`, `path_ref_changed`, `path_ref_unverified`, `path_hop_unbound`, `draft_mark_gone` and `notebook_ref_gone`. Add a check inside `lintBoard`; the path checks live in `lintPath`, which `paths_play` also calls.

`findSymbol` (pure) finds a dotted symbol (`Class.method`) part by part, each part inside the block of the part before, then as a whole; it finds the declaration line and an indentation-plus-bracket-depth block end; `validateRef` returns `line` and `end`; `stampRef` returns the `blockText` hash for a ref (null when the symbol is gone). `refStatus` is the one step check (`ok`, `ref_missing`, `symbol_missing`, `changed`, `unverified`) shared by lint, `paths_get` and `paths_play`.

Beware: every ref operation takes its root from the board: `writeRoot` for `bind_code` with a ref, path stamps, `verify` and `canvas_lint` (these fail on an unset or gone root, and refuse the main-checkout fallback); `readRoot` for `paths_get` and `paths_play` (these stay readable, with `ref_status: null` and a warning). `resolveRef` throws on a `''` root as a backstop. `lintPath` takes a null root and then skips the ref checks.

Beware: a path step's `ref_hash` is written by the server, never a tool argument. An unchanged step (same edge, caption and ref) keeps its old stamp on `paths_update`; a new or changed step is stamped fresh. `verify: [hop]` is the only way to restamp without a change. A ref whose symbol is not found gets no stamp.

Beware: `canvas_bind_code`, `paths_create`, `paths_update` and `paths_play` are writes (`writable()`), so a
Reader cannot run them. `canvas_lint` and `paths_get` are reads.

Tests: `tests/core/symbols.test.ts`, `tests/tools/contract.test.ts`, `tests/tools/project-root.test.ts`.

## Board files and Mermaid

A board exports to a versioned JSON file with bitmaps embedded, and imports back as a new board.
Mermaid export is a pure function.

```
plugin/src/shared/board-file.ts:19  BOARD_FILE_VERSION
plugin/src/shared/board-file.ts:21  boardFileSchema
plugin/src/server/board-file.ts:22  exportBoard
plugin/src/server/board-file.ts:81  importBoard
plugin/src/server/board-file.ts:20  ImportError
plugin/src/core/mermaid.ts:22       exportMermaid
```

Beware: raise `BOARD_FILE_VERSION` when the board shape changes, and keep old versions importable.

Import stamps each path step that has a ref and no `ref_hash` against the board's root (as `paths_create` does); a stamp in the file stays.

Tests: `tests/core/mermaid.test.ts`, `tests/integration/server.test.ts`.

## Project root

Each board stores its own `project_root` (ADR 0003); every code ref on the board resolves against
it, for every caller and for the panel. `''` means unset: only a migrated row holds it. Each board
also stores `main_root`, the main checkout when the root is inside a linked git worktree (`''`
otherwise, and on any git failure). When the root is gone and `main_root` exists, reads fall back to
it with a warning; ref writes and lint refuse until `boards_update` sets a new root.

```
plugin/src/server/project-root.ts:20   checkRootArg
plugin/src/server/project-root.ts:32   mainRootOf
plugin/src/server/project-root.ts:71   boardRoot
plugin/src/server/project-root.ts:84   writeRoot
plugin/src/server/project-root.ts:91   readRoot
plugin/src/server/project-root.ts:109  canonicalPath
plugin/src/server/project-root.ts:118  rootOverlaps
plugin/src/server/project-root.ts:130  listBoards
plugin/src/shared/import-root.ts:9     importNeedsRoot
plugin/src/server/session.ts:520       create
plugin/src/server/session.ts:539       uniqueName
plugin/src/server/session.ts:555       clone
plugin/src/server/session.ts:234       updateMeta
plugin/src/server/mcp.ts:249           register("boards.list"
plugin/src/server/mcp.ts:302           register("boards.update"
plugin/src/server/mcp.ts:318           register("boards.create"
plugin/src/server/mcp.ts:330           register("boards.clone"
plugin/src/server/mcp.ts:345           register("boards.import"
plugin/src/server/board-file.ts:61     importRoot
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
`plugin/src/shared/import-root.ts`): a file that is not valid fails without a prompt.

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
plugin/src/server/store.ts:35    class Store
plugin/src/server/store.ts:110  load
plugin/src/server/store.ts:164  save
plugin/src/server/store.ts:198  saveImage
```

One data dir for each daemon, and one daemon for each port. Every Claude Code session on that port
shares the database through the daemon. The default data dir is `~/.inkwire` (`INKWIRE_DATA_DIR`) on port 4691. The dev
daemon (`yarn dev`) uses `~/.inkwire-dev` on port 4692. A daemon that a relay autostarts logs to
`daemon.log` in its data dir. Tests use temp dirs.

Beware: a daemon binds the port before it opens the store (`startDaemon`). A daemon that loses the
port race exits before it opens the DB.

## The plugin

Inkwire ships as a Claude Code plugin and as its own one-plugin marketplace. None of this is `.ts`.
The plugin root is `plugin/`: the marketplace entry has the source `./plugin`, and Claude Code
copies only that folder. There is no build step: the manifest runs the relay from the source. The
manifest and the marketplace entry have no `version`, so Claude Code uses the commit SHA, and each
merge to `main` that changes `plugin/` is an update.

- `plugin/.claude-plugin/plugin.json` — manifest and the `mcpServers` entry (`sh ${CLAUDE_PLUGIN_ROOT}/src/link/relay.sh`, which runs `relay.ts` with a Node 26; see The link).
- `.claude-plugin/marketplace.json` — the marketplace listing (at the repo root, not in `plugin/`).
- `plugin/hooks/hooks.json`, `plugin/hooks/forward.sh` — see Session mode and hooks.
- `plugin/hooks/mod/` — the Claude Code mod (`plugin/hooks/mod/register.tsx` is the module) — see The mod.
- `plugin/skills/use-inkwire`, `plugin/skills/back-to-claude-code`, `plugin/skills/trace-path` — `trace-path` is
  model-invocable.
- `plugin/package.json`, `plugin/package-lock.json` — the runtime deps that Claude Code installs
  in the cache folder (`npm ci --ignore-scripts`: exact registry versions, no install scripts).
  `yarn lock-plugin` writes both from the root `dependencies` at the versions that `yarn.lock`
  resolves, also for each transitive package. They are not a Yarn workspace: the root `package.json` has no `workspaces`, so Yarn
  ignores them. In dev, `plugin/node_modules` does not exist and Node finds the packages in the
  root `node_modules`.
- `.claude/skills/ship` — dev-only, not part of the plugin.
- `.claude/settings.json` — the Session tab's two requirements for this repo
  (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, permission mode `auto`).

The checks of the plugin are scripts at the repo root (ADR 0005). `checkPlugin` (`yarn
check-plugin`, a CI job) fails on a `version`, a marketplace source other than `./plugin`, plugin
deps that are not the root runtime deps at exact `yarn.lock` versions (`runtimeDependencies`,
`yarnResolutions`), a lockfile that is not v3 or does not match, a lock entry (also a transitive
one) at a version that `yarn.lock` does not resolve for its name (`yarnVersionsByName`), a file that `plugin.json` or
`hooks.json` names and that is missing (a hook script must also be executable), and a
`plugin/node_modules` or `plugin/dist`. `yarn lock-plugin` writes the two files
(`pluginPackageJson`, then npm in a temp folder: `writeLockfile`) and runs the check. npm makes
the lockfile from a yarn v1 lockfile that `yarnV1Lockfile` writes from `yarn.lock` (npm reads a
yarn v1 lockfile, not the Yarn 4 format), with no old `package-lock.json`, so npm takes Yarn's
version of each package.
`yarn check-install` (also a CI job) copies the files of `plugin/` that git tracks
(`trackedPluginFiles`; it stops when `plugin/` has a file that git does not track and does not
ignore) to a temp folder outside the repo, runs `npm ci --ignore-scripts` there (60 s limit),
starts the relay with the command of `plugin.json` (`manifestCommand`) from the copy with a clean
env, a random port and a temp data dir, calls `boards_create`, checks that the daemon runs from the copy and gets
`/`, `/main.js` and `/styles.css`.

```
scripts/check-plugin.ts:162    checkPlugin
scripts/plugin-package.ts:130   runtimeDependencies
scripts/plugin-package.ts:55   yarnResolutions
scripts/plugin-package.ts:81   yarnVersionsByName
scripts/plugin-package.ts:104  yarnV1Lockfile
scripts/check-install.ts:72    trackedPluginFiles
scripts/check-install.ts:85    manifestCommand
scripts/plugin-package.ts:154   pluginPackageJson
scripts/lock-plugin.ts:24      writeLockfile
scripts/check-install.ts:100    main
```

Tests: `tests/scripts/check-plugin.test.ts` (each rule on a temp copy of the files).

Beware: a runtime import of a package that is only in the root `devDependencies` passes the type
check and every test (the root `node_modules` has it) but fails in the installed plugin. Put it in
`dependencies` and run `yarn lock-plugin`. A native package must ship prebuilt binaries
(`better-sqlite3`, `@resvg/resvg-js` and `esbuild` do): Claude Code runs no install scripts.
