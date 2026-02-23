#!/bin/bash
set -euo pipefail

SESSION_FILE=/atlas/workspace/.last-session-id
WATCH_DIR=/atlas/workspace/inbox
LOCK_FILE=/atlas/workspace/.session-running
FLOCK_FILE=/atlas/workspace/.session.flock

# Ensure watch directory exists
mkdir -p "$WATCH_DIR"
touch "$WATCH_DIR/.wake"

echo "[$(date)] Watcher started. Monitoring $WATCH_DIR"

inotifywait -m "$WATCH_DIR" -e create,modify,attrib --exclude '\.(db|wal|shm)$' --format '%f' | while read FILENAME; do

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
        claude -p --dangerously-skip-permissions --resume "$SESSION_ID" "You have new tasks. Use get_next_task() to process them." 2>&1 | tee -a /atlas/logs/session.log || true
      else
        echo "[$(date)] Starting new session"
        claude -p --dangerously-skip-permissions "You have new tasks. Use get_next_task() to process them." 2>&1 | tee -a /atlas/logs/session.log || true
      fi

      rm -f "$LOCK_FILE"
      echo "[$(date)] Session ended, back to sleep"
    ) 9>"$FLOCK_FILE"

  # --- Trigger session re-awakening (.wake-<trigger>-<task_id> file) ---
  elif [[ "$FILENAME" == .wake-* ]]; then
    # Extract trigger name: strip .wake- prefix, then remove the -<task_id> suffix
    _WAKE_BODY="${FILENAME#.wake-}"
    TRIGGER_NAME="${_WAKE_BODY%-*}"
    WAKE_FILE="$WATCH_DIR/$FILENAME"
    echo "[$(date)] Trigger wake event: $TRIGGER_NAME (file=$FILENAME)"

    # Run in background — don't block watcher while trigger session runs
    (
      # Per-trigger flock: prevents concurrent sessions for the same trigger
      flock -n 200 || { echo "[$(date)] Trigger $TRIGGER_NAME already running, skipping"; exit 0; }

      # Atomically move to temp to prevent race conditions
      TEMP_WAKE=$(mktemp /tmp/wake-XXXXXX.json)
      mv "$WAKE_FILE" "$TEMP_WAKE" 2>/dev/null || { rm -f "$TEMP_WAKE"; exit 0; }

      # Parse all JSON fields in a single jq call
      eval "$(jq -r '{
        task_id: (.task_id // ""),
        session_id: (.session_id // ""),
        session_key: (.session_key // ""),
        channel: (.channel // "internal"),
        summary: (.response_summary // "")
      } | to_entries | map("WAKE_\(.key | ascii_upcase)=\(.value | @sh)") | .[]' "$TEMP_WAKE" 2>/dev/null)" || true
      TASK_ID="${WAKE_TASK_ID:-}"
      SESSION_ID="${WAKE_SESSION_ID:-}"
      SESSION_KEY="${WAKE_SESSION_KEY:-}"
      CHANNEL="${WAKE_CHANNEL:-internal}"
      SUMMARY="${WAKE_SUMMARY:-}"
      rm -f "$TEMP_WAKE"

      RESUME_MSG="Task #${TASK_ID} completed. Here is the worker's result:

${SUMMARY}

Relay this result to the original sender now."

      LOG="/atlas/logs/trigger-${TRIGGER_NAME}.log"

      if [ -n "$SESSION_ID" ]; then
        echo "[$(date)] Resuming trigger $TRIGGER_NAME (session=$SESSION_ID)" | tee -a "$LOG"
        ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
          claude -p --dangerously-skip-permissions --resume "$SESSION_ID" "$RESUME_MSG" 2>&1 | tee -a "$LOG" || true
      elif [ -n "$TRIGGER_NAME" ]; then
        echo "[$(date)] No session ID for $TRIGGER_NAME — re-spawning via trigger.sh" | tee -a "$LOG"
        /atlas/app/triggers/trigger.sh "$TRIGGER_NAME" "$RESUME_MSG" "$SESSION_KEY" 2>&1 | tee -a "$LOG" || true
      fi

      echo "[$(date)] Trigger $TRIGGER_NAME re-awakening done" | tee -a "$LOG"
    ) 200>"/atlas/workspace/.trigger-${TRIGGER_NAME}.flock" &
  fi

done
