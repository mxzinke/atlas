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

handle_trigger_wake() {
  local WAKE_FILE="$1"
  [ -f "$WAKE_FILE" ] || return 0
  local FILENAME
  FILENAME=$(basename "$WAKE_FILE")
  local _WAKE_BODY="${FILENAME#.wake-}"
  local TRIGGER_NAME="${_WAKE_BODY%-*}"

  echo "[$(date)] Trigger wake event: $TRIGGER_NAME (file=$FILENAME)"

  (
    exec </dev/null >>/atlas/logs/watcher.log 2>&1
    flock -n 200 || { echo "[$(date)] Trigger $TRIGGER_NAME already running, skipping"; exit 0; }

    TEMP_WAKE=$(mktemp /tmp/wake-XXXXXX.json)
    mv "$WAKE_FILE" "$TEMP_WAKE" 2>/dev/null || { rm -f "$TEMP_WAKE"; exit 0; }

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

    disable_remote_mcp

    if [ -n "$SESSION_ID" ]; then
      echo "[$(date)] Resuming trigger $TRIGGER_NAME (session=$SESSION_ID)" | tee -a "$LOG"
      ATLAS_TRIGGER="$TRIGGER_NAME" ATLAS_TRIGGER_CHANNEL="$CHANNEL" ATLAS_TRIGGER_SESSION_KEY="$SESSION_KEY" \
        claude-atlas --mode trigger --resume "$SESSION_ID" --dangerously-skip-permissions -p "$RESUME_MSG" 2>&1 | tee -a "$LOG" || true
    elif [ -n "$TRIGGER_NAME" ]; then
      echo "[$(date)] No session ID for $TRIGGER_NAME — re-spawning via trigger.sh" | tee -a "$LOG"
      /atlas/app/triggers/trigger.sh "$TRIGGER_NAME" "$RESUME_MSG" "$SESSION_KEY" 2>&1 | tee -a "$LOG" || true
    fi

    echo "[$(date)] Trigger $TRIGGER_NAME re-awakening done" | tee -a "$LOG"
  ) 200>"/atlas/workspace/.trigger-${TRIGGER_NAME}.flock" &
}

startup_recovery() {
  # Pass 1: process any .wake-* files left on disk from a previous watcher run
  for f in "$WATCH_DIR"/.wake-*; do
    [ -f "$f" ] || continue
    echo "[$(date)] Startup recovery: stale wake file $(basename "$f")"
    handle_trigger_wake "$f"
  done

  # Pass 2: re-create wake files for done tasks whose wake file was never written
  # (covers the case where wakeTriggerIfAwaiting was interrupted before writeFileSync)
  [ -f "$DB" ] || return 0
  sqlite3 -json "$DB" \
    "SELECT ta.task_id, ta.trigger_name, ta.session_key,
            COALESCE(ts.session_id,'') AS session_id,
            COALESCE(t.channel,'internal') AS channel,
            COALESCE(tk.response_summary,'') AS response_summary
     FROM task_awaits ta
     JOIN tasks tk ON tk.id = ta.task_id AND tk.status = 'done'
     LEFT JOIN trigger_sessions ts ON ts.trigger_name = ta.trigger_name
                                   AND ts.session_key = ta.session_key
     LEFT JOIN triggers t ON t.name = ta.trigger_name" 2>/dev/null \
  | jq -c '.[]' 2>/dev/null \
  | while IFS= read -r row; do
      local task_id trigger_name
      task_id=$(printf '%s' "$row" | jq -r '.task_id')
      trigger_name=$(printf '%s' "$row" | jq -r '.trigger_name')
      local WAKE_FILE="$WATCH_DIR/.wake-${trigger_name}-${task_id}"
      [ -f "$WAKE_FILE" ] && continue  # already handled in Pass 1
      echo "[$(date)] Startup recovery: recreating wake for task $task_id ($trigger_name)"
      printf '%s' "$row" > "$WAKE_FILE"
      sqlite3 "$DB" "DELETE FROM task_awaits WHERE task_id = $task_id" 2>/dev/null || true
      handle_trigger_wake "$WAKE_FILE"
    done
}

# Ensure watch directory exists
mkdir -p "$WATCH_DIR"
touch "$WATCH_DIR/.wake"

echo "[$(date)] Watcher started. Monitoring $WATCH_DIR"

startup_recovery

inotifywait -m "$WATCH_DIR" -e create,modify,attrib --exclude '\.(db|wal|shm)$' --format '%f' | while read FILENAME; do

  # --- Main session wake (.wake file) ---
  if [ "$FILENAME" = ".wake" ]; then
    echo "[$(date)] Main session wake event"

    # Atomic lock via flock: prevents concurrent sessions and auto-releases on crash/kill.
    (
      exec </dev/null >>/atlas/logs/watcher.log 2>&1
      flock -n 9 || { echo "[$(date)] Session already running, skipping"; exit 0; }

      touch "$LOCK_FILE"  # web-ui status indicator

      SESSION_ID=$(cat "$SESSION_FILE" 2>/dev/null || echo "")

      disable_remote_mcp

      set +e
      if [ -n "$SESSION_ID" ]; then
        echo "[$(date)] Resuming session: $SESSION_ID"
        claude-atlas --mode worker --resume "$SESSION_ID" --dangerously-skip-permissions \
          -p "You have new tasks. Use get_next_task() to process them." >> /atlas/logs/session.log 2>&1
      else
        echo "[$(date)] Starting new session"
        claude-atlas --mode worker --dangerously-skip-permissions \
          -p "You have new tasks. Use get_next_task() to process them." >> /atlas/logs/session.log 2>&1
      fi
      CLAUDE_EXIT=$?
      set -e

      rm -f "$LOCK_FILE"

      if [ "$CLAUDE_EXIT" -eq 0 ]; then
        on_session_success
        echo "[$(date)] Session ended, back to sleep"
      else
        echo "[$(date)] Session failed with exit $CLAUDE_EXIT, entering backoff"
        on_session_failure "$CLAUDE_EXIT"
      fi
    ) 9>"$FLOCK_FILE" &

  # --- Trigger session re-awakening (.wake-<trigger>-<task_id> file) ---
  elif [[ "$FILENAME" == .wake-* ]]; then
    handle_trigger_wake "$WATCH_DIR/$FILENAME"
  fi

done
