#!/bin/bash
# Sourced by watcher.sh inside the main session flock subshell.
# Provides: on_session_success, on_session_failure

WORKSPACE=/atlas/workspace
DB="$WORKSPACE/inbox/atlas.db"
FAILURE_COUNT_FILE="$WORKSPACE/.failure-count"
FAILURE_TS_FILE="$WORKSPACE/.failure-first-ts"
NOTIFIED_FILE="$WORKSPACE/.failure-notified"

# Defaults — overridden when .failure-env is sourced
ATLAS_BACKOFF_INITIAL=30
ATLAS_BACKOFF_MAX=900
ATLAS_NOTIFY_THRESHOLD_MINUTES=30
ATLAS_NOTIFY_COMMAND=""

if [ -f "$WORKSPACE/.failure-env" ]; then
  # shellcheck source=/dev/null
  source "$WORKSPACE/.failure-env"
fi

reset_processing_tasks() {
  [ -f "$DB" ] || return 0
  local COUNT
  COUNT=$(sqlite3 "$DB" \
    "UPDATE tasks SET status='pending', processed_at=NULL WHERE status='processing'; SELECT changes();" \
    2>/dev/null || echo "0")
  echo "[$(date)] Reset $COUNT processing task(s) to pending"
}

on_session_success() {
  local OLD_COUNT=0
  [ -f "$FAILURE_COUNT_FILE" ] && OLD_COUNT=$(cat "$FAILURE_COUNT_FILE" 2>/dev/null || echo "0")
  [ "$OLD_COUNT" -gt 0 ] && echo "[$(date)] API recovered after $OLD_COUNT consecutive failure(s)"
  rm -f "$FAILURE_COUNT_FILE" "$FAILURE_TS_FILE" "$NOTIFIED_FILE"
}

on_session_failure() {
  local EXIT_CODE="${1:-1}"

  # Increment failure count
  local FAIL_COUNT=0
  [ -f "$FAILURE_COUNT_FILE" ] && FAIL_COUNT=$(cat "$FAILURE_COUNT_FILE" 2>/dev/null || echo "0")
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '%s' "$FAIL_COUNT" > "$FAILURE_COUNT_FILE"

  # Record first failure timestamp
  [ -f "$FAILURE_TS_FILE" ] || date +%s > "$FAILURE_TS_FILE"
  local FIRST_TS NOW_TS ELAPSED_MINUTES
  FIRST_TS=$(cat "$FAILURE_TS_FILE")
  NOW_TS=$(date +%s)
  ELAPSED_MINUTES=$(( (NOW_TS - FIRST_TS) / 60 ))

  echo "[$(date)] Session failed (exit=$EXIT_CODE, consecutive=$FAIL_COUNT, elapsed=${ELAPSED_MINUTES}min)"

  # Notification: once per failure streak, after threshold
  if [ "$ELAPSED_MINUTES" -ge "$ATLAS_NOTIFY_THRESHOLD_MINUTES" ] \
     && [ ! -f "$NOTIFIED_FILE" ] \
     && [ -n "$ATLAS_NOTIFY_COMMAND" ]; then
    echo "[$(date)] Sending failure notification (${ELAPSED_MINUTES}min elapsed)"
    touch "$NOTIFIED_FILE"
    eval "$ATLAS_NOTIFY_COMMAND" 2>&1 | tee -a /atlas/logs/watcher.log || true
  fi

  # Exponential backoff: initial * 2^(failures-1), capped at max
  # Pure bash integer arithmetic, no bc/awk required
  local BACKOFF=$ATLAS_BACKOFF_INITIAL
  local i=1
  while [ "$i" -lt "$FAIL_COUNT" ]; do
    BACKOFF=$((BACKOFF * 2))
    [ "$BACKOFF" -gt "$ATLAS_BACKOFF_MAX" ] && BACKOFF=$ATLAS_BACKOFF_MAX && break
    i=$((i + 1))
  done

  echo "[$(date)] Backing off ${BACKOFF}s before retry (attempt $((FAIL_COUNT + 1)))"

  # Sleep in background so the caller's flock is released immediately.
  # This prevents the backoff from blocking all incoming wake events.
  (
    sleep "$BACKOFF"
    reset_processing_tasks
    touch "$WORKSPACE/inbox/.wake"
    echo "[$(date)] Retry triggered via .wake touch (after ${BACKOFF}s backoff)" >> /atlas/logs/watcher.log
  ) &
}
