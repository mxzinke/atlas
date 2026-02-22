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
#
# For persistent sessions: if the session is already running (IPC socket alive),
# the message is injected directly into the running session via the Claude Code
# IPC socket. No new process is spawned — the message arrives mid-run.
set -euo pipefail

TRIGGER_NAME="${1:?Usage: trigger.sh <trigger-name> [payload] [session-key]}"
DB="/atlas/workspace/inbox/atlas.db"
WORKSPACE="/atlas/workspace"
PROMPT_DIR="/atlas/app/prompts"
LOG="/atlas/logs/trigger-${TRIGGER_NAME}.log"

if [ ! -f "$DB" ]; then
  echo "[$(date)] ERROR: Database not found: $DB" >&2
  exit 1
fi

# Safe template substitution using Python (no sed injection risk from payload content)
safe_replace() {
  python3 -c "
import sys
template = sys.stdin.read()
for i in range(1, len(sys.argv), 2):
    template = template.replace(sys.argv[i], sys.argv[i+1])
print(template, end='')
" "$@"
}

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
  PROMPT=$(echo -n "$PROMPT" | safe_replace "{{payload}}" "$PAYLOAD")
fi

# Update trigger stats
sqlite3 "$DB" "UPDATE triggers SET last_run = datetime('now'), run_count = run_count + 1 WHERE name = '${TRIGGER_NAME//\'/\'\'}';"

# --- Persistent session: try IPC socket injection first ---
if [ "$SESSION_MODE" = "persistent" ]; then
  EXISTING_SESSION=$(sqlite3 "$DB" \
    "SELECT session_id FROM trigger_sessions WHERE trigger_name='${TRIGGER_NAME//\'/\'\'}' AND session_key='${SESSION_KEY//\'/\'\'}' LIMIT 1;" 2>/dev/null || echo "")

  if [ -n "$EXISTING_SESSION" ]; then
    SOCKET="/tmp/claudec-${EXISTING_SESSION}.sock"

    if [ -S "$SOCKET" ]; then
      # Session is running — inject message directly via IPC socket
      # Load channel-specific inject template
      INJECT_TEMPLATE=""
      for candidate in "$PROMPT_DIR/trigger-${CHANNEL}-inject.md" "$PROMPT_DIR/trigger-session-inject.md"; do
        if [ -f "$candidate" ]; then
          INJECT_TEMPLATE="$candidate"
          break
        fi
      done

      if [ -n "$INJECT_TEMPLATE" ]; then
        INJECT_MSG=$(safe_replace "{{trigger_name}}" "$TRIGGER_NAME" \
                                  "{{channel}}" "$CHANNEL" \
                                  "{{sender}}" "$SESSION_KEY" \
                                  "{{payload}}" "${PAYLOAD:-$PROMPT}" \
                                  < "$INJECT_TEMPLATE")
      else
        INJECT_MSG="New message arrived:

${PAYLOAD:-$PROMPT}

Process this message using inbox_mark and the channel CLI tools (signal send / email reply)."
      fi

      if echo "$INJECT_MSG" | python3 -c "
import socket, json, sys
msg = sys.stdin.read()
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.sendall(json.dumps({'action': 'send', 'text': msg, 'submit': True}).encode() + b'\n')
s.close()
" "$SOCKET" 2>/dev/null; then
        echo "[$(date)] Injected into running session $EXISTING_SESSION (key=$SESSION_KEY)" | tee -a "$LOG"
        exit 0
      fi
      # Socket exists but connection failed — session is stale, fall through to spawn
      echo "[$(date)] Stale socket for $EXISTING_SESSION, spawning new session" | tee -a "$LOG"
    fi
  fi
fi

echo "[$(date)] Trigger firing: $TRIGGER_NAME (mode=$SESSION_MODE, key=$SESSION_KEY, channel=$CHANNEL)" | tee -a "$LOG"

# Build system prompt from channel-specific template (fallback to generic)
PROMPT_TEMPLATE=""
for candidate in "$PROMPT_DIR/trigger-${CHANNEL}.md" "$PROMPT_DIR/trigger-session.md"; do
  if [ -f "$candidate" ]; then
    PROMPT_TEMPLATE="$candidate"
    break
  fi
done

SYSTEM_PROMPT=""
if [ -n "$PROMPT_TEMPLATE" ]; then
  SYSTEM_PROMPT=$(safe_replace "{{trigger_name}}" "$TRIGGER_NAME" \
                               "{{channel}}" "$CHANNEL" \
                               < "$PROMPT_TEMPLATE")
fi

# Build Claude command
CLAUDE_ARGS=(-p --max-turns 25)

if [ "$SESSION_MODE" = "persistent" ] && [ -n "${EXISTING_SESSION:-}" ]; then
  CLAUDE_ARGS+=(--resume "$EXISTING_SESSION")
  echo "[$(date)] Resuming session for key=$SESSION_KEY: $EXISTING_SESSION" | tee -a "$LOG"
elif [ "$SESSION_MODE" = "persistent" ]; then
  echo "[$(date)] New persistent session for key=$SESSION_KEY" | tee -a "$LOG"
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
# Use --output-format json to reliably capture the session ID (avoids race with concurrent triggers)
TRIGGER_OUT=$(mktemp /tmp/trigger-out-XXXXXX.json)

ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
  claude "${CLAUDE_ARGS[@]}" --output-format json "$FULL_PROMPT" > "$TRIGGER_OUT" 2>>"$LOG" || true

# Log the text result from JSON output
python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data.get('result', ''))
except: pass
" "$TRIGGER_OUT" >> "$LOG"

# For persistent sessions: extract session ID from structured output (race-free)
if [ "$SESSION_MODE" = "persistent" ]; then
  NEW_SESSION_ID=$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data.get('session_id', ''))
except: print('')
" "$TRIGGER_OUT" 2>/dev/null)

  if [ -n "$NEW_SESSION_ID" ]; then
    sqlite3 "$DB" "INSERT INTO trigger_sessions (trigger_name, session_key, session_id) \
      VALUES ('${TRIGGER_NAME//\'/\'\'}', '${SESSION_KEY//\'/\'\'}', '${NEW_SESSION_ID//\'/\'\'}') \
      ON CONFLICT(trigger_name, session_key) DO UPDATE SET session_id='${NEW_SESSION_ID//\'/\'\'}', updated_at=datetime('now');"
    echo "[$(date)] Saved session for key=$SESSION_KEY: $NEW_SESSION_ID" | tee -a "$LOG"
  fi
fi

rm -f "$TRIGGER_OUT"

echo "[$(date)] Trigger done: $TRIGGER_NAME (key=$SESSION_KEY)" | tee -a "$LOG"
