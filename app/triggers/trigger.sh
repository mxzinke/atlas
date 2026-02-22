#!/bin/bash
# Trigger runner: spawns own Claude session per trigger (read-only, filter/escalation)
# Usage: trigger.sh <trigger-name> [payload] [session-key]
#
# Session key determines WHICH session to resume for persistent triggers:
#   - Email: thread ID       → trigger.sh email-handler '{"body":"..."}' 'thread-4821'
#   - Signal: sender number  → trigger.sh signal-chat '{"msg":"Hi"}' '+49170123456'
#   - Webhook: event group   → trigger.sh deploy-hook '{"ref":"main"}' 'repo-myapp'
#   - No key + persistent    → uses "_default" (one global session per trigger)
#   - Ephemeral triggers     → key is ignored, always a new session
set -euo pipefail

TRIGGER_NAME="${1:?Usage: trigger.sh <trigger-name> [payload] [session-key]}"
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
  "SELECT id, name, type, channel, prompt, session_mode, enabled FROM triggers WHERE name='${TRIGGER_NAME//\'/\'\'}' LIMIT 1" 2>/dev/null || echo "[]")

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

# Session key: 3rd argument, defaults to "_default" for persistent triggers
SESSION_KEY="${3:-_default}"

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

# --- Session lock: prevent concurrent sessions for the same (trigger, key) ---
# If a session is already running, skip — the message is already in the inbox
# and the running session will pick it up via the stop hook.
LOCK_HASH=$(echo "${TRIGGER_NAME}:${SESSION_KEY}" | md5sum | cut -d' ' -f1)
LOCK_DIR="/atlas/workspace/inbox/.trigger-lock-${LOCK_HASH}"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date)] Session already running for $TRIGGER_NAME (key=$SESSION_KEY) — message queued in inbox" | tee -a "$LOG"
  exit 0
fi
# Store PID for stale lock detection
echo "$$" > "$LOCK_DIR/pid"

# Ensure lock is always released
cleanup_lock() {
  rm -rf "$LOCK_DIR" 2>/dev/null
}
trap cleanup_lock EXIT

echo "[$(date)] Trigger firing: $TRIGGER_NAME (mode=$SESSION_MODE, key=$SESSION_KEY, channel=$CHANNEL)" | tee -a "$LOG"

# Build Claude command
CLAUDE_ARGS=(-p --max-turns 25)

# Look up existing session for persistent triggers
if [ "$SESSION_MODE" = "persistent" ]; then
  EXISTING_SESSION=$(sqlite3 "$DB" \
    "SELECT session_id FROM trigger_sessions WHERE trigger_name='${TRIGGER_NAME//\'/\'\'}' AND session_key='${SESSION_KEY//\'/\'\'}' LIMIT 1;" 2>/dev/null || echo "")

  if [ -n "$EXISTING_SESSION" ]; then
    CLAUDE_ARGS+=(--resume "$EXISTING_SESSION")
    echo "[$(date)] Resuming session for key=$SESSION_KEY: $EXISTING_SESSION" | tee -a "$LOG"
  else
    echo "[$(date)] New persistent session for key=$SESSION_KEY" | tee -a "$LOG"
  fi
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
ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
  claude "${CLAUDE_ARGS[@]}" "$FULL_PROMPT" 2>&1 | tee -a "$LOG" || true

# For persistent sessions: capture and store the session ID
if [ "$SESSION_MODE" = "persistent" ]; then
  NEW_SESSION_ID=$(find ~/.claude/projects/ -name "*.json" -path "*/sessions/*" -printf '%T@ %f\n' 2>/dev/null \
    | sort -rn | head -1 | awk '{print $2}' | sed 's/\.json$//' || echo "")

  if [ -n "$NEW_SESSION_ID" ]; then
    sqlite3 "$DB" "INSERT INTO trigger_sessions (trigger_name, session_key, session_id) \
      VALUES ('${TRIGGER_NAME//\'/\'\'}', '${SESSION_KEY//\'/\'\'}', '${NEW_SESSION_ID}') \
      ON CONFLICT(trigger_name, session_key) DO UPDATE SET session_id='${NEW_SESSION_ID}', updated_at=datetime('now');"
    echo "[$(date)] Saved session for key=$SESSION_KEY: $NEW_SESSION_ID" | tee -a "$LOG"
  fi
fi

echo "[$(date)] Trigger done: $TRIGGER_NAME (key=$SESSION_KEY)" | tee -a "$LOG"
