#!/bin/bash
# Stop Hook: Inbox check + sleep orchestration
set -euo pipefail

WORKSPACE=/atlas/workspace
DB="$WORKSPACE/inbox/atlas.db"
SESSION_FILE="$WORKSPACE/.last-session-id"
CLEANUP_DONE="$WORKSPACE/.cleanup-done"

# Daily cleanup mode - just signal done and exit
if [ "${ATLAS_CLEANUP:-}" = "1" ]; then
  touch "$CLEANUP_DONE"
  exit 0
fi

# Trigger session mode — just exit, watcher handles re-awakening
if [ -n "${ATLAS_TRIGGER:-}" ]; then
  exit 0
fi

# === Main/worker session logic below ===

# Save current session ID
CURRENT_SESSION=""

# Method 1: Environment variable (if set by Claude Code)
if [ -n "${CLAUDE_SESSION_ID:-}" ]; then
  CURRENT_SESSION="$CLAUDE_SESSION_ID"
fi

# Method 2: Most recently modified session file
if [ -z "$CURRENT_SESSION" ]; then
  CURRENT_SESSION=$(find ~/.claude/projects/ -name "*.json" -path "*/sessions/*" -printf '%T@ %f\n' 2>/dev/null \
    | sort -rn | head -1 | awk '{print $2}' | sed 's/\.json$//' || echo "")
fi

if [ -n "$CURRENT_SESSION" ]; then
  echo "$CURRENT_SESSION" > "$SESSION_FILE"
fi

# Check for active (processing) tasks — safety net if worker forgot to mark done
if [ -f "$DB" ]; then
  ACTIVE=$(sqlite3 "$DB" "SELECT count(*) FROM messages WHERE status='processing';" 2>/dev/null || echo "0")

  if [ "$ACTIVE" -gt 0 ]; then
    ACTIVE_TASK=$(sqlite3 -json "$DB" \
      "SELECT id, sender, content FROM messages WHERE status='processing' ORDER BY created_at ASC LIMIT 1;" \
      2>/dev/null || echo "[]")

    if [ -n "$ACTIVE_TASK" ] && [ "$ACTIVE_TASK" != "[]" ]; then
      {
        echo "<active-task-warning>"
        echo "$ACTIVE_TASK"
        echo "</active-task-warning>"
        echo "<task-instruction>"
        echo "You have an active task still in 'processing' status."
        echo "Complete it with task_complete(task_id=<id>, response_summary=\"<result>\") before stopping."
        echo "The response_summary is relayed directly to the original sender — write it as a real reply."
        echo "</task-instruction>"
      } >&2
      exit 2
    fi
  fi
fi

# Check for pending tasks
if [ -f "$DB" ]; then
  PENDING=$(sqlite3 "$DB" "SELECT count(*) FROM messages WHERE status='pending';" 2>/dev/null || echo "0")

  if [ "$PENDING" -gt 0 ]; then
    {
      echo "<pending-tasks>"
      echo "You have $PENDING pending task(s) in the queue."
      echo "</pending-tasks>"
      echo "<task-instruction>"
      echo "Use get_next_task() to pick up and process the next task."
      echo "</task-instruction>"
    } >&2
    exit 2
  fi
fi

# No pending or active tasks — sleep
echo "No pending tasks. Write a short journal entry to memory/$(date +%Y-%m-%d).md if you accomplished something relevant today."
exit 0
