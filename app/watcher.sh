#!/bin/bash
set -euo pipefail

export PATH=/atlas/app/bin:/usr/local/bin:/usr/bin:/bin:$PATH

SESSION_FILE=/atlas/workspace/.last-session-id
WATCH_DIR=/atlas/workspace/inbox
LOCK_FILE=/atlas/workspace/.session-running
FLOCK_FILE=/atlas/workspace/.session.flock
CLAUDE_JSON="$HOME/.claude.json"

source /atlas/app/hooks/failure-handler.sh

# Disable remote MCP connectors that hang on startup.
# Claude Code caches the gate value from .claude.json; patching it
# before each invocation prevents the remote MCP connection attempt.
disable_remote_mcp() {
  [ -f "$CLAUDE_JSON" ] || return 0
  jq '.cachedGrowthBookFeatures.tengu_claudeai_mcp_connectors = false' \
    "$CLAUDE_JSON" > "${CLAUDE_JSON}.tmp" && mv "${CLAUDE_JSON}.tmp" "$CLAUDE_JSON"
}

# Process a single .wake-<trigger>-<task_id> file: parse JSON, resume trigger session.
# Runs in a backgrounded subshell with per-trigger flock.
process_trigger_wake() {
  local WAKE_FILE="$1"
  local FNAME
  FNAME=$(basename "$WAKE_FILE")
  local _WAKE_BODY="${FNAME#.wake-}"
  local TRIG_NAME="${_WAKE_BODY%-*}"

  echo "[$(date)] Trigger wake event: $TRIG_NAME (file=$FNAME)"

  (
    # Per-trigger flock: prevents concurrent sessions for the same trigger
    flock -n 200 || { echo "[$(date)] Trigger $TRIG_NAME already running, skipping"; exit 0; }

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

    LOG="/atlas/logs/trigger-${TRIG_NAME}.log"

    disable_remote_mcp

    if [ -n "$SESSION_ID" ]; then
      echo "[$(date)] Resuming trigger $TRIG_NAME (session=$SESSION_ID)" | tee -a "$LOG"
      ATLAS_TRIGGER="$TRIG_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
        claude-atlas --mode trigger --resume "$SESSION_ID" --dangerously-skip-permissions -p "$RESUME_MSG" 2>&1 | tee -a "$LOG" || true
    elif [ -n "$TRIG_NAME" ]; then
      echo "[$(date)] No session ID for $TRIG_NAME — re-spawning via trigger.sh" | tee -a "$LOG"
      /atlas/app/triggers/trigger.sh "$TRIG_NAME" "$RESUME_MSG" "$SESSION_KEY" 2>&1 | tee -a "$LOG" || true
    fi

    echo "[$(date)] Trigger $TRIG_NAME re-awakening done" | tee -a "$LOG"
  ) 200>"/atlas/workspace/.trigger-${TRIG_NAME}.flock" &
}

# Scan for any .wake-* files and process them. Handles missed inotify events
# (e.g. kernel queue overflow during long worker sessions) and watcher restarts.
process_pending_trigger_wakes() {
  for wf in "$WATCH_DIR"/.wake-*; do
    [ -f "$wf" ] || continue
    process_trigger_wake "$wf"
  done
}

# Ensure watch directory exists
mkdir -p "$WATCH_DIR"
touch "$WATCH_DIR/.wake"

echo "[$(date)] Watcher started. Monitoring $WATCH_DIR"

# Process any trigger wake files left over from before watcher (re)started
process_pending_trigger_wakes

inotifywait -m "$WATCH_DIR" -e create,modify,attrib --exclude '\.(db(-wal|-shm)?|wal|shm)$' --format '%f' | while read FILENAME; do

  # --- Main session wake (.wake file) ---
  if [ "$FILENAME" = ".wake" ]; then
    echo "[$(date)] Main session wake event"

    # Atomic lock via flock: prevents concurrent sessions and auto-releases on crash/kill.
    (
      flock -n 9 || { echo "[$(date)] Session already running, skipping"; exit 0; }

      touch "$LOCK_FILE"  # web-ui status indicator

      SESSION_ID=$(cat "$SESSION_FILE" 2>/dev/null || echo "")

      disable_remote_mcp

      set +e
      if [ -n "$SESSION_ID" ]; then
        echo "[$(date)] Resuming session: $SESSION_ID"
        claude-atlas --mode worker --resume "$SESSION_ID" --dangerously-skip-permissions \
          -p "You have new tasks. Use get_next_task() to process them." 2>&1 | tee -a /atlas/logs/session.log
      else
        echo "[$(date)] Starting new session"
        claude-atlas --mode worker --dangerously-skip-permissions \
          -p "You have new tasks. Use get_next_task() to process them." 2>&1 | tee -a /atlas/logs/session.log
      fi
      CLAUDE_EXIT=${PIPESTATUS[0]}
      set -e

      rm -f "$LOCK_FILE"

      if [ "$CLAUDE_EXIT" -eq 0 ]; then
        on_session_success
        echo "[$(date)] Session ended, back to sleep"
      else
        echo "[$(date)] Session failed with exit $CLAUDE_EXIT, entering backoff"
        on_session_failure "$CLAUDE_EXIT"
      fi

      # After worker exits, process any trigger wake files that were written
      # during the session. inotify events may have been lost if the kernel
      # event queue overflowed while the while-read loop was blocked.
      process_pending_trigger_wakes
    ) 9>"$FLOCK_FILE"

  # --- Trigger session re-awakening (.wake-<trigger>-<task_id> file) ---
  elif [[ "$FILENAME" == .wake-* ]]; then
    WAKE_FILE="$WATCH_DIR/$FILENAME"
    [ -f "$WAKE_FILE" ] || continue  # Already handled by post-session scan
    process_trigger_wake "$WAKE_FILE"
  fi

done
