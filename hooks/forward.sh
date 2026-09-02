#!/bin/sh
# Claude Code hook forwarder. Every event's JSON goes to the inkwire server,
# which holds the mode flag and decides. The reply is plain text:
#   ok | block\n<reason> | context\n<text>
# A block becomes exit 2 with the reason on stderr (Claude Code feeds it back
# to the model). When the server is down, allow — never wedge the session.
port="${INKWIRE_PORT:-4691}"
bg="${CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS:-unset}"
out=$(curl -s --max-time 5 -X POST "http://127.0.0.1:$port/api/hook?bg=$bg" \
  -H 'content-type: application/json' --data-binary @- 2>/dev/null) || exit 0
verdict=$(printf '%s\n' "$out" | head -n 1)
body=$(printf '%s\n' "$out" | tail -n +2)
case "$verdict" in
  block) printf '%s\n' "$body" >&2; exit 2 ;;
  context) printf '%s\n' "$body"; exit 0 ;;
  *) exit 0 ;;
esac
