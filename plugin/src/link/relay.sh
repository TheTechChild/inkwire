#!/bin/sh
# Start the inkwire relay with Node 26 or later (ADR 0005). plugin.json runs
# this file. Claude Code starts it in the cwd of the session, so the node on
# PATH can come from a version manager that reads the .nvmrc of that project,
# and an older Node cannot run the TypeScript source.
#   1. The node on PATH, when its major version is 26 or later.
#   2. Else mise, when it is installed: mise x node@26 -- node.
#   3. Else stop with a message on stderr.
# Each step uses exec, so the relay keeps the Claude Code pid as its parent
# pid (the hello pid). stdout is the MCP transport: write to stderr only.
need=26
relay="$(dirname "$0")/relay.ts"
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null </dev/null)
if [ -n "$have" ] && [ "$have" -ge "$need" ] 2>/dev/null; then
  exec node "$relay"
fi
if command -v mise >/dev/null 2>&1; then
  exec mise x "node@$need" -- node "$relay"
fi
echo "inkwire relay: Node $need or later is necessary, but the node on PATH is ${have:-not available} (cwd $(pwd)). Install Node $need, or install mise (https://mise.jdx.dev)." >&2
exit 1
