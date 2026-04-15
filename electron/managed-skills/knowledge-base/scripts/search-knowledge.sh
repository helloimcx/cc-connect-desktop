#!/bin/sh
set -u

API_BASE="${KNOWLEDGE_API_BASE_URL:-http://127.0.0.1:9831/api/local/v1}"
LIMIT="${KNOWLEDGE_SEARCH_LIMIT:-5}"

escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ "$#" -lt 2 ]; then
  echo "Usage: search-knowledge.sh \"<query>\" \"<kb_id_1>\" [kb_id_2 ...]" >&2
  exit 1
fi

QUERY="$1"
shift
ESCAPED_QUERY=$(escape_json "$QUERY")

for KB_ID in "$@"; do
  echo "=== Knowledge Base: $KB_ID ==="
  RESPONSE=$(curl -fsS -X POST "$API_BASE/knowledge/bases/$KB_ID/search" \
    -H 'Content-Type: application/json' \
    --data "{\"query\":\"$ESCAPED_QUERY\",\"limit\":$LIMIT}" 2>&1)
  STATUS=$?

  if [ "$STATUS" -ne 0 ]; then
    echo "Error: $RESPONSE"
    echo
    continue
  fi

  if printf '%s' "$RESPONSE" | grep -q '"results":[[:space:]]*\[\]'; then
    echo "No results"
    echo
    continue
  fi

  printf '%s\n' "$RESPONSE"
  echo
done
