# inkwire

A local MCP server with a shared drawing canvas, for collaborating visually with an AI agent on a codebase. You draw a system freehand in the browser; the server infers structure; Claude reads the board as data over MCP, edits it, and discusses it. Both of you write to the same board.

## Quick start

```sh
yarn install
yarn build
```

Inkwire ships as a Claude Code plugin: the MCP server, a `Stop` hook, the `/use-inkwire` and `/back-to-claude-code` commands, and the model-invocable `trace-path` skill. Install it once; it then loads in every session:

```sh
claude plugin marketplace add /path/to/inkwire
claude plugin install inkwire@inkwire
```

Adjust `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` to 0 in your `~/.claude/settings.json`

For a one-off run without installing, `claude --plugin-dir /path/to/inkwire` does the same for that session. Tool names carry the plugin prefix: `mcp__plugin_inkwire_inkwire__boards_create`.

The Session tab (below) needs two settings. Put them in `~/.claude/settings.json` to make them permanent, or in the `.claude/settings.json` of the project you use inkwire from:

```json
{
  "env": { "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0" },
  "permissions": { "defaultMode": "auto" }
}
```

The canvas works without them. This repo's own `.claude/settings.json` already carries both.

Inkwire runs as one daemon. The first Claude Code session starts it, and it stops 30 s after the last session closes. All sessions share the daemon and port 4691. Each session runs a small relay (`dist/link/relay.js`) that connects to the daemon.

Then ask Claude to create a board (`boards_create`). `boards_create` needs a `project_root`: the absolute path of the checkout that the board's code refs point into. The tool result contains the panel URL — open it in your browser:

```
http://127.0.0.1:4691/?board=<board id>
```

Draw with the pen (P), then press **infer_structure** (or ask Claude to run it). Closed shapes become nodes; connecting lines become edges. Claude renames the nodes after reading a screenshot.

## Many sessions

Many Claude Code sessions can use inkwire at the same time, in different repos. Each board has a maximum of one AI Author. The first Claude Code session that writes to a board becomes its Author. The other sessions are readers: they can read the board, but a write fails and names the Author. The panel shows the Author and the number of readers.

To give the board to a different session, click **Release** in the panel. Then the next write from a different session claims the board. The released session cannot claim that board again until a different session claims it, the released session closes, or you click **Allow pid N** in the panel. No agent can take authorship away from a different session.

For a git worktree, use `boards_clone` with the worktree as the new `project_root`. The session that clones the board becomes the Author of the clone.

## After a rebuild

The daemon does not restart by itself after `yarn build`. When a Claude Code session starts with a newer build, the panel shows a stale-build notice. To use the new build, click **Restart** in the panel, or run `yarn daemon:restart`. When all Claude Code sessions close, the daemon stops after 30 s, and the next session starts the new build. A restart drops the undo history and every pending `session_send` on every board.

After a reconnect or a restart, each session keeps its current board. It does not keep its authorship or its `inkwire` mode. The next write claims the board again if the board is free (see [Many sessions](#many-sessions)).

## Session tab: talking in the panel

Type `/use-inkwire` in the terminal. Claude flips a server-held mode flag, and from then on delivers replies through the blocking `session_send` tool into the panel's SESSION tab, where you answer from the composer. A reply can carry a **highlight**: node and edge ids the canvas lights up. It can also carry a **path**: an ordered walk over a layer's edges, one caption per hop, that plays in the panel. The Layers tab lists each layer's paths; click `▸` on a path row to open the scrubber as a vertical walk under the row, one row per node and one per hop with its caption. Hold `▸` to peek the walk on the canvas. Drag the walk or press ← → to step; `esc` closes it. The `/trace-path` skill writes one when you ask "walk me through" or "what happens when". `/back-to-claude-code` (typed, or the button in the strip) brings replies back to the terminal.

Two requirements, both checked by the server when the mode goes on, and both covered by the settings above:

- Permission mode `auto` or `bypassPermissions` — nobody is at the terminal to approve prompts. Switching modes inside the session works too; the check runs when `/use-inkwire` does.
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` — otherwise Claude Code moves the blocking call to a background task after two minutes.

The mode is per Claude Code session, and only the board's Author can turn it on. The mode is not persisted: after a reconnect or a daemon restart, the session is in the terminal again. A `session_send` that waits 20 minutes with no answer returns `idle` and flips the mode back.

## Development

```sh
yarn dev          # dev daemon (tsx watch) + panel bundle (esbuild watch)
yarn dev:claude   # Claude Code with this repo as the plugin, on the dev daemon
yarn test         # full vitest suite
yarn typecheck
```

`yarn dev` runs the dev daemon on port 4692 with `~/.inkwire-dev` and `INKWIRE_IDLE_GRACE_MS=off`, so it does not touch the daemon on 4691 or the data in `~/.inkwire`. Panel URL: `http://127.0.0.1:4692/?board=<id>`.

`yarn dev:claude` starts Claude Code with `--plugin-dir .` and the dev port and data dir. The relay and the hook use the dev daemon. If `yarn dev` does not run, the relay starts a daemon from `dist/` on 4692. The relay always runs from `dist/`, so after a change to the relay, run `yarn build`.

Tests use random ports and temp data dirs. They never use 4691, 4692, `~/.inkwire` or `~/.inkwire-dev`.

Configuration (env vars): `INKWIRE_PORT` (default 4691), `INKWIRE_DATA_DIR` (default `~/.inkwire` — SQLite plus an images/ directory), `INKWIRE_IDLE_GRACE_MS` (daemon only; default 30000, `off` turns the idle stop off). There is no project-root env var: each board stores its own `project_root` (set it with `boards_create`, `boards_clone`, `boards_import` or `boards_update`), and every code ref on the board resolves against it.

The design handoff that specifies this project lives in `design_handoff_inkwire/`. See `CLAUDE.md` for architecture notes.

## Upgrade notes

### To the shared daemon

1. Close all Claude Code sessions that use the old inkwire server. If an old session holds port 4691, the new relay stops with "port 4691 is held by an old inkwire server; close the old Claude Code sessions".
2. Run `yarn build` and install the plugin update. `yarn build` deletes `dist/` first, so the old `dist/server/index.js` is gone and an old `.mcp.json` (step 3) fails with a missing-file error. It does not start a hidden old server.
3. A project `.mcp.json` that starts inkwire with `node .../dist/server/index.js` must change its args to `.../dist/link/relay.js`. Also remove `INKWIRE_PROJECT_ROOT` from its env: it has no effect now.
4. Start one new Claude Code session and do the post-migration step.

**Post-migration step:** run `boards_list` and set a root on every `root: unset` board with `boards_update`. At migration time this is one board, `b_8946f6` "Discover Config API — generateDiscoverConfig", root `/Users/clayton.noyes/angel-studios` (its 8 refs all start with `content-collections/`; verified 2026-10-08).

## License

MIT
