#!/bin/sh
set -u

API_BASE="${KNOWLEDGE_API_BASE_URL:-http://127.0.0.1:9831/api/local/v1}"
LIMIT="${KNOWLEDGE_SEARCH_LIMIT:-5}"

escape_json() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

print_results() {
  KB_ID="$1"
  RESPONSE="$2"
  RESPONSE_JSON="$RESPONSE" KB_ID="$KB_ID" node <<'NODE'
const responseText = process.env.RESPONSE_JSON || '';
const kbId = process.env.KB_ID || 'unknown';

try {
  const payload = JSON.parse(responseText);
  const results = Array.isArray(payload?.data?.results)
    ? payload.data.results
    : Array.isArray(payload?.results)
      ? payload.results
      : null;

  if (!results) {
    console.log('Error: invalid response payload');
    console.log('');
    process.exit(0);
  }

  if (results.length === 0) {
    console.log('No results');
    console.log('');
    process.exit(0);
  }

  for (const item of results) {
    const title = String(item?.title || kbId);
    const fileName = String(item?.fileName || 'unknown');
    const score = typeof item?.score === 'number' ? item.score : 0;
    const snippet = String(item?.snippet || '').trim();
    console.log(`- Title: ${title}`);
    console.log(`  File: ${fileName}`);
    console.log(`  Score: ${score}`);
    console.log(`  Snippet: ${snippet || '(empty)'}`);
  }
  console.log('');
} catch (error) {
  console.log(`Error: ${error instanceof Error ? error.message : String(error)}`);
  console.log('');
}
NODE
  echo
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

  print_results "$KB_ID" "$RESPONSE"
done
