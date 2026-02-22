#!/bin/bash
# Trigger runner: spawns own Claude session per trigger (read-only, filter/escalation)
set -euo pipefail

TRIGGER_NAME="${1:?Usage: trigger.sh <trigger-name>}"
DB="/atlas/workspace/inbox/atlas.db"
WORKSPACE="/atlas/workspace"
PROMPT_TEMPLATE="/atlas/app/prompts/trigger-session.md"
LOG="/atlas/logs/trigger-${TRIGGER_NAME}.log"

if [ ! -f "$DB" ]; then
  echo "[$(date)] ERROR: Database not found: $DB" >&2
  exit 1
fi

# Read trigger from DB
ROW=$(sqlite3 -json "$DB" \
  "SELECT id, name, type, channel, prompt, session_mode, session_id, enabled FROM triggers WHERE name='${TRIGGER_NAME//\'/\'\'}' LIMIT 1" 2>/dev/null || echo "[]")

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
SESSION_MODE=$(echo "$ROW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0]['session_mode'] or 'ephemeral')" 2>/dev/null || echo "ephemeral")
SESSION_ID=$(echo "$ROW" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[0]['session_id'] or '')" 2>/dev/null || echo "")

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

# Build system prompt from template
SYSTEM_PROMPT=""
if [ -f "$PROMPT_TEMPLATE" ]; then
  SYSTEM_PROMPT=$(cat "$PROMPT_TEMPLATE" | sed "s|{{trigger_name}}|${TRIGGER_NAME}|g" | sed "s|{{channel}}|${CHANNEL}|g")
fi

# Update trigger stats
sqlite3 "$DB" "UPDATE triggers SET last_run = datetime('now'), run_count = run_count + 1 WHERE name = '${TRIGGER_NAME//\'/\'\'}';"

echo "[$(date)] Trigger firing: $TRIGGER_NAME (mode=$SESSION_MODE, channel=$CHANNEL)" | tee -a "$LOG"

# Build Claude command
CLAUDE_ARGS=(-p --max-turns 25)

# Resume persistent session if available
if [ "$SESSION_MODE" = "persistent" ] && [ -n "$SESSION_ID" ]; then
  CLAUDE_ARGS+=(--resume "$SESSION_ID")
  echo "[$(date)] Resuming persistent session: $SESSION_ID" | tee -a "$LOG"
fi

# Combine system prompt + trigger prompt
FULL_PROMPT=""
if [ -n "$SYSTEM_PROMPT" ]; then
  FULL_PROMPT="${SYSTEM_PROMPT}

---

${PROMPT}"
else
  FULL_PROMPT="$PROMPT"
fi

# Spawn trigger's own Claude session
# ATLAS_TRIGGER env var tells hooks this is a trigger session (read-only)
ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" \
  claude "${CLAUDE_ARGS[@]}" "$FULL_PROMPT" 2>&1 | tee -a "$LOG" || true

# For persistent sessions: capture and store the session ID
if [ "$SESSION_MODE" = "persistent" ]; then
  # Find the most recent session ID from Claude's session files
  NEW_SESSION_ID=$(find ~/.claude/projects/ -name "*.json" -path "*/sessions/*" -printf '%T@ %f\n' 2>/dev/null \
    | sort -rn | head -1 | awk '{print $2}' | sed 's/\.json$//' || echo "")

  if [ -n "$NEW_SESSION_ID" ]; then
    sqlite3 "$DB" "UPDATE triggers SET session_id = '${NEW_SESSION_ID}' WHERE name = '${TRIGGER_NAME//\'/\'\'}';"
    echo "[$(date)] Saved persistent session: $NEW_SESSION_ID" | tee -a "$LOG"
  fi
fi

echo "[$(date)] Trigger done: $TRIGGER_NAME" | tee -a "$LOG"
