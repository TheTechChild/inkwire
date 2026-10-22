# inkwire

Inkwire is a local MCP server and a browser canvas panel. You draw a system freehand in the panel. The server infers the structure: closed shapes become nodes, and connecting lines become edges. Claude reads the board as data over MCP and edits it. You and Claude write to the same board.

## Install

Inkwire needs Node 26 or later. The plugin uses the `node` on PATH when it is Node 26 or later. Else it uses `mise x node@26` when [mise](https://mise.jdx.dev) is installed.

```sh
claude plugin marketplace add TheTechChild/inkwire
claude plugin install inkwire@inkwire
```

You do not run a build or `yarn install`. Claude Code installs the runtime dependencies.

## Use

1. Ask Claude to create a board (`boards_create`). Give the absolute path of your checkout as the `project_root`.
2. Open the panel URL from the tool result in your browser: `http://127.0.0.1:4691/?board=<board id>`. You can also type `/inkwire` to see the panel URL.
3. Draw with the pen (P). Then click **infer_structure**, or ask Claude to run it.

Type `/use-inkwire` to talk with Claude in the SESSION tab of the panel. Type `/back-to-claude-code` to send the replies to the terminal again.

## Updates

The plugin has no version number. Each commit on `main` is an update. Turn on auto-update for the `inkwire` marketplace in `/plugin`. Or run `claude plugin marketplace update inkwire`, then `claude plugin update inkwire@inkwire`.

The daemon does not restart by itself. After a change to the daemon, click **Restart** in the stale-build notice of the panel. A restart drops the undo history on every board.

## More

For the full documentation, see the [README on GitHub](https://github.com/TheTechChild/inkwire).

## License

MIT. See [LICENSE](LICENSE).
