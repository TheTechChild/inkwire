---
status: proposed
---

# One shared daemon owns all boards

Each Claude Code session used to spawn its own inkwire server, and a second session on the same port exited with EADDRINUSE. We will run one long-lived inkwire daemon that owns the database, every open board, and the panel HTTP/WS port, and every Claude Code session connects to it as a client. The limit was never SQLite (the store already runs in WAL mode): a board's live state and its history exist only in the memory of the process that opened it, and are persisted on a 500 ms debounce, so two processes editing one board would silently overwrite each other.

## Considered Options

- **Peer servers coordinating through SQLite.** Rejected: needs persisted history, cross-process merge of concurrent edits, and a shared panel port — a rewrite of the write path.
- **First session becomes leader, later sessions proxy to it.** Rejected: boards and the panel die with the leader's session unless we also build leader handover.

## How sessions reach the daemon

The plugin's stdio entry becomes a thin relay: it probes `/healthz`, starts a detached daemon if none answers (a racing second daemon loses the port and both relays use the winner), then relays MCP between stdio and the daemon. At connect it sends its cwd, build version, and `CLAUDE_CODE_SESSION_ID` (verified present in the env Claude Code gives MCP servers). We rejected the MCP HTTP transport because the daemon would not learn each session's project root and a session would fail whenever the daemon was down.

The daemon keys per-session state on the Claude Code process id, not the session id. Tested 2026-10-08 on Claude Code 2.1.294: `/clear` and `/resume` each start a new session id (`SessionEnd` reason `clear`/`resume`, then `SessionStart` source `clear`/`resume` with the new id) while the MCP process keeps running with the old `CLAUDE_CODE_SESSION_ID` in its env. The Claude Code pid is stable across both: it is the relay's `ppid` and the nearest `claude` ancestor of every hook. So the relay sends its `ppid`, `hooks/forward.sh` sends its `claude` ancestor's pid, and the session id is a mutable field that `SessionStart` updates. Either side may create the record first (the relay started 0.24 s before the first hook); it is removed when the relay disconnects, which rules out pid reuse.

## The link between relay and daemon

The relay and daemon talk over a WebSocket (`/mcp`, apart from the panel's `/ws`) that carries newline-delimited MCP JSON-RPC, after a first `hello` frame (pid, session id, cwd, build, optional `term_program` so the right terminal app comes forward when that session leaves `inkwire` mode, and, after a reconnect, optional `current_board`). We chose it over MCP Streamable HTTP because authorship is released on disconnect, and a socket close is immediate and reliable where an HTTP session only ends on a timeout; the 20-minute blocking `session_send` is also just a pending frame.

The link is a replaceable layer (`src/link/`). Its whole contract with the rest of the daemon is: an MCP SDK `Transport`, a `hello` value, and a `closed` event. Nothing outside the link imports the socket library for MCP, and a test enforces that. Reconnect — re-sending `hello` and the cached `initialize`, and hiding the second `initialize` response from Claude Code — lives only in the relay. A reconnect loses authorship, `inkwire` mode, and any pending `session_send`, which are in-memory. It keeps the current board: the relay remembers the board id from the context line that starts every tool result and sends it in the reconnect `hello`, so an agent mid-task is not left with no board.

## Lifetime and stale builds

The daemon exits on its own when its last relay has been gone for a grace period (`INKWIRE_IDLE_GRACE_MS`, default 30 s, tuned by feel), after persisting every board; the next session starts the current build. A relay with a newer build than the daemon never triggers a restart: the panel and the next tool result say the daemon is stale and will restart when all sessions close, or now on an explicit restart. A build is identified by `dist/build.json`, which `yarn build` writes: `{ id, built_at }`, where `id` is a hash of the built server and panel, so a rebuild with identical output is not "newer". The relay sends its `id` in `hello`; the daemon reports its own in `/healthz`. Only the person restarts the daemon — a Restart control in the panel's stale-build notice (confirming how many boards and sessions it affects) or `yarn daemon:restart`; there is no MCP tool for it. We rejected restart-on-newer-build because history is in-memory only, so any restart wipes undo/rewind on every open board and releases every pending `session_send`, for every session, not just the one that rebuilt.

## Consequences

- State that `Sessions` holds for the whole server (current board, session mode, bound Claude Code session, pending `session_send`) must become per-connection state.
- The daemon outlives any one session, so running stale code after a rebuild becomes a problem the design must solve, not an accident.
