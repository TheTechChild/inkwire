# inkwire

A local MCP server with a shared drawing canvas, for collaborating visually with an AI agent on a codebase. You draw a system freehand in the browser; the server infers structure; Claude reads the board as data over MCP, edits it, and discusses it. Both of you write to the same board.

## Quick start

```sh
yarn install
yarn build
```

Add the server to Claude Code:

```sh
claude mcp add inkwire -- node /path/to/inkwire/dist/server/index.js
```

Then ask Claude to create a board (`boards_create`). The tool result contains the panel URL — open it in your browser:

```
http://127.0.0.1:4691/?board=<board id>
```

Draw with the pen (P), then press **infer_structure** (or ask Claude to run it). Closed shapes become nodes; connecting lines become edges. Claude renames the nodes after reading a screenshot.

## Development

```sh
yarn dev        # server (tsx watch) + panel bundle (esbuild watch)
yarn test       # full vitest suite
yarn typecheck
```

Configuration (env vars): `INKWIRE_PORT` (default 4691), `INKWIRE_DATA_DIR` (default `~/.inkwire` — SQLite plus an images/ directory), `INKWIRE_PROJECT_ROOT` (the root that `canvas_bind_code` refs resolve against).

The design handoff that specifies this project lives in `design_handoff_inkwire/`. See `CLAUDE.md` for architecture notes.

## License

MIT
