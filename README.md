# inkwire

A local MCP server with a shared drawing canvas, for collaborating visually with an AI agent on a codebase. You draw a system freehand in the browser; the server infers structure; Claude reads the board as data over MCP, edits it, and discusses it. Both of you write to the same board.

## Quick start

```sh
yarn install
yarn build
```

Inkwire ships as a Claude Code plugin: the MCP server, a `Stop` hook, and the `/use-inkwire` and `/back-to-claude-code` commands. Install it once; it then loads in every session:

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

Then ask Claude to create a board (`boards_create`). The tool result contains the panel URL — open it in your browser:

```
http://127.0.0.1:4691/?board=<board id>
```

Draw with the pen (P), then press **infer_structure** (or ask Claude to run it). Closed shapes become nodes; connecting lines become edges. Claude renames the nodes after reading a screenshot.

## Session tab: talking in the panel

Type `/use-inkwire` in the terminal. Claude flips a server-held mode flag, and from then on delivers replies through the blocking `session_send` tool into the panel's SESSION tab, where you answer from the composer. A reply can carry a **highlight**: node and edge ids the canvas lights up. `/back-to-claude-code` (typed, or the button in the strip) brings replies back to the terminal.

Two requirements, both checked by the server when the mode goes on, and both covered by the settings above:

- Permission mode `auto` or `bypassPermissions` — nobody is at the terminal to approve prompts. Switching modes inside the session works too; the check runs when `/use-inkwire` does.
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` — otherwise Claude Code moves the blocking call to a background task after two minutes.

The mode is not persisted; a server restart returns to the terminal. A `session_send` that waits 20 minutes with no answer returns `idle` and flips the mode back.

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
