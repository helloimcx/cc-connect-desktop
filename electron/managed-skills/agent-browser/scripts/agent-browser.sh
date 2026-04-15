#!/bin/sh
set -eu

AI_WORKSTATION_HOME="${AI_WORKSTATION_HOME:-$HOME/.ai-workstation}"
TOOL_BIN="$AI_WORKSTATION_HOME/tools/agent-browser/current/bin/agent-browser"

if [ ! -x "$TOOL_BIN" ]; then
  echo "Managed tool not available: $TOOL_BIN" >&2
  echo "AI-WorkStation could not find a ready agent-browser installation." >&2
  exit 1
fi

exec "$TOOL_BIN" "$@"
