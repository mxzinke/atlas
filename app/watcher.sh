#!/bin/bash
set -euo pipefail

SESSION_FILE=/atlas/workspace/.last-session-id
WAKE_FILE=/atlas/workspace/inbox/.wake
LOCK_FILE=/atlas/workspace/.session-running
FLOCK_FILE=/atlas/workspace/.session.flock

# Ensure wake file directory exists
mkdir -p "$(dirname "$WAKE_FILE")"

# Create wake file if not exists
touch "$WAKE_FILE"

echo "[$(date)] Watcher started. Monitoring $WAKE_FILE"

inotifywait -m "$WAKE_FILE" -e create,modify,attrib | while read; do
  echo "[$(date)] Wake event detected"

  # Atomic lock via flock: prevents concurrent sessions and auto-releases on crash/kill.
  # The subshell holds FD 9 open; flock -n fails immediately if another session holds it.
  (
    flock -n 9 || { echo "[$(date)] Session already running, skipping"; exit 0; }

    touch "$LOCK_FILE"  # web-ui status indicator

    SESSION_ID=$(cat "$SESSION_FILE" 2>/dev/null || echo "")

    if [ -n "$SESSION_ID" ]; then
      echo "[$(date)] Resuming session: $SESSION_ID"
      claude -p --resume "$SESSION_ID" "You have new messages." 2>&1 | tee -a /atlas/logs/session.log || true
    else
      echo "[$(date)] Starting new session"
      claude -p "You have new messages." 2>&1 | tee -a /atlas/logs/session.log || true
    fi

    rm -f "$LOCK_FILE"
    echo "[$(date)] Session ended, back to sleep"
  ) 9>"$FLOCK_FILE"
done
