#!/bin/bash
# Generic trigger runner: looks up trigger by name, writes to inbox, wakes Claude
set -euo pipefail

TRIGGER_NAME="${1:?Usage: trigger.sh <trigger-name>}"
DB="/atlas/workspace/inbox/atlas.db"
WAKE="/atlas/workspace/inbox/.wake"
WORKSPACE="/atlas/workspace"

if [ ! -f "$DB" ]; then
  echo "[$(date)] ERROR: Database not found: $DB" >&2
  exit 1
fi

# Read trigger from DB
ROW=$(sqlite3 -json "$DB" \
  "SELECT id, name, type, channel, prompt, enabled FROM triggers WHERE name='${TRIGGER_NAME//\'/\'\'}' LIMIT 1" 2>/dev/null || echo "[]")

if [ "$ROW" = "[]" ] || [ -z "$ROW" ]; then
  echo "[$(date)] Trigger not found: $TRIGGER_NAME" >&2
  exit 1
fi

ENABLED=$(echo "$ROW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0]['enabled'])" 2>/dev/null || echo "0")
if [ "$ENABLED" != "1" ]; then
  echo "[$(date)] Trigger disabled: $TRIGGER_NAME"
  exit 0
fi

CHANNEL=$(echo "$ROW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0]['channel'])" 2>/dev/null || echo "internal")
PROMPT=$(echo "$ROW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0]['prompt'])" 2>/dev/null || echo "")

# Fallback: load prompt from workspace file
if [ -z "$PROMPT" ]; then
  PROMPT_FILE="$WORKSPACE/triggers/cron/${TRIGGER_NAME}/event-prompt.md"
  if [ -f "$PROMPT_FILE" ]; then
    PROMPT=$(cat "$PROMPT_FILE")
  else
    PROMPT="Trigger '${TRIGGER_NAME}' was fired."
  fi
fi

# Optional: second argument is payload (for webhook relay)
PAYLOAD="${2:-}"
if [ -n "$PAYLOAD" ]; then
  PROMPT=$(echo "$PROMPT" | sed "s|{{payload}}|${PAYLOAD}|g")
fi

# Write message to inbox
sqlite3 "$DB" "INSERT INTO messages (channel, sender, content) VALUES ('${CHANNEL}', 'trigger:${TRIGGER_NAME}', '${PROMPT//\'/\'\'}');"

# Update trigger stats
sqlite3 "$DB" "UPDATE triggers SET last_run = datetime('now'), run_count = run_count + 1 WHERE name = '${TRIGGER_NAME//\'/\'\'}';"

# Wake Claude
touch "$WAKE"

echo "[$(date)] Trigger fired: $TRIGGER_NAME (channel=$CHANNEL)"
