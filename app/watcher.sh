#!/bin/bash
set -euo pipefail

SESSION_FILE=/atlas/workspace/.last-session-id
WATCH_DIR=/atlas/workspace/inbox
LOCK_FILE=/atlas/workspace/.session-running
FLOCK_FILE=/atlas/workspace/.session.flock
MCP_CONFIG=/atlas/workspace/.mcp.json

# Ensure watch directory exists
mkdir -p "$WATCH_DIR"
touch "$WATCH_DIR/.wake"

echo "[$(date)] Watcher started. Monitoring $WATCH_DIR"

inotifywait -m "$WATCH_DIR" -e create,modify,attrib --format '%f' | while read FILENAME; do

  # --- Main session wake (.wake file) ---
  if [ "$FILENAME" = ".wake" ]; then
    echo "[$(date)] Main session wake event"

    # Atomic lock via flock: prevents concurrent sessions and auto-releases on crash/kill.
    (
      flock -n 9 || { echo "[$(date)] Session already running, skipping"; exit 0; }

      touch "$LOCK_FILE"  # web-ui status indicator

      SESSION_ID=$(cat "$SESSION_FILE" 2>/dev/null || echo "")

      if [ -n "$SESSION_ID" ]; then
        echo "[$(date)] Resuming session: $SESSION_ID"
        claude -p --mcp-config "$MCP_CONFIG" --resume "$SESSION_ID" "You have new tasks. Use get_next_task() to process them." 2>&1 | tee -a /atlas/logs/session.log || true
      else
        echo "[$(date)] Starting new session"
        claude -p --mcp-config "$MCP_CONFIG" "You have new tasks. Use get_next_task() to process them." 2>&1 | tee -a /atlas/logs/session.log || true
      fi

      rm -f "$LOCK_FILE"
      echo "[$(date)] Session ended, back to sleep"
    ) 9>"$FLOCK_FILE"

  # --- Trigger session re-awakening (.wake-<trigger_name> file) ---
  elif [[ "$FILENAME" == .wake-* ]]; then
    TRIGGER_NAME="${FILENAME#.wake-}"
    WAKE_FILE="$WATCH_DIR/$FILENAME"
    echo "[$(date)] Trigger wake event: $TRIGGER_NAME"

    # Run in background — don't block watcher while trigger session runs
    (
      # Atomically move to temp to prevent race conditions
      TEMP_WAKE=$(mktemp /tmp/wake-XXXXXX.json)
      mv "$WAKE_FILE" "$TEMP_WAKE" 2>/dev/null || { rm -f "$TEMP_WAKE"; exit 0; }

      # Parse JSON fields
      TASK_ID=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('task_id',''))" "$TEMP_WAKE" 2>/dev/null || echo "")
      SESSION_ID=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('session_id',''))" "$TEMP_WAKE" 2>/dev/null || echo "")
      SESSION_KEY=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('session_key',''))" "$TEMP_WAKE" 2>/dev/null || echo "")
      CHANNEL=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('channel','internal'))" "$TEMP_WAKE" 2>/dev/null || echo "internal")
      SUMMARY=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('response_summary',''))" "$TEMP_WAKE" 2>/dev/null || echo "")
      rm -f "$TEMP_WAKE"

      RESUME_MSG="Task #${TASK_ID} completed. Here is the worker's result:

${SUMMARY}

Relay this result to the original sender now."

      LOG="/atlas/logs/trigger-${TRIGGER_NAME}.log"

      if [ -n "$SESSION_ID" ]; then
        echo "[$(date)] Resuming trigger $TRIGGER_NAME (session=$SESSION_ID)" | tee -a "$LOG"
        ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
          claude -p --mcp-config "$MCP_CONFIG" --resume "$SESSION_ID" "$RESUME_MSG" 2>&1 | tee -a "$LOG" || true
      elif [ -n "$TRIGGER_NAME" ]; then
        echo "[$(date)] No session ID for $TRIGGER_NAME — re-spawning via trigger.sh" | tee -a "$LOG"
        /atlas/app/triggers/trigger.sh "$TRIGGER_NAME" "$RESUME_MSG" "$SESSION_KEY" 2>&1 | tee -a "$LOG" || true
      fi

      echo "[$(date)] Trigger $TRIGGER_NAME re-awakening done" | tee -a "$LOG"
    ) &
  fi

done
