#!/bin/sh
# Claude Code hook forwarder. Every event's JSON goes to the inkwire server,
# which holds the mode flag and decides. The reply is plain text:
#   ok | block\n<reason> | context\n<text>
# A block becomes exit 2 with the reason on stderr (Claude Code feeds it back
# to the model). When the server is down, allow — never wedge the session.
port="${INKWIRE_PORT:-4691}"
bg="${CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS:-unset}"

# The Claude Code pid: the nearest ancestor whose comm or first args word has
# the basename claude (Claude Code can run as node, and macOS ps can cut comm).
# The server keys its Client record on it. Stop at pid 1 or after 16 levels;
# with no claude ancestor, send no pid.
claude_pid=""
p="$PPID"
i=0
while [ "$i" -lt 16 ] && [ "$p" -gt 1 ] 2>/dev/null; do
  comm=$(ps -o comm= -p "$p" 2>/dev/null </dev/null)
  args=$(ps -o args= -p "$p" 2>/dev/null </dev/null)
  first="${args%% *}"
  if [ "${comm##*/}" = claude ] || [ "${first##*/}" = claude ]; then
    claude_pid="$p"
    break
  fi
  p=$(ps -o ppid= -p "$p" 2>/dev/null </dev/null | tr -d ' ')
  i=$((i + 1))
done
query="bg=$bg"
[ -n "$claude_pid" ] && query="$query&pid=$claude_pid"

out=$(curl -s --max-time 5 -X POST "http://127.0.0.1:$port/api/hook?$query" \
  -H 'content-type: application/json' --data-binary @- 2>/dev/null) || exit 0
verdict=$(printf '%s\n' "$out" | head -n 1)
body=$(printf '%s\n' "$out" | tail -n +2)
case "$verdict" in
  block) printf '%s\n' "$body" >&2; exit 2 ;;
  context) printf '%s\n' "$body"; exit 0 ;;
  *) exit 0 ;;
esac
