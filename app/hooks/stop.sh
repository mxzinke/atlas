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

# Trigger session mode
if [ -n "${ATLAS_TRIGGER:-}" ]; then
  AWAIT_FILE="/tmp/trigger-${ATLAS_TRIGGER}-await"
  WAKE_FILE="/tmp/trigger-${ATLAS_TRIGGER}-wake"

  if [ -f "$AWAIT_FILE" ]; then
    TASK_ID=$(cat "$AWAIT_FILE" | tr -d '[:space:]')
    STATUS=$(sqlite3 "$DB" "SELECT status FROM messages WHERE id=${TASK_ID};" 2>/dev/null || echo "")

    if [ "$STATUS" = "done" ]; then
      SUMMARY=$(sqlite3 "$DB" "SELECT response_summary FROM messages WHERE id=${TASK_ID};" 2>/dev/null || echo "")
      # Cleanup await/wake/mapping files
      rm -f "$AWAIT_FILE" "$WAKE_FILE" "/tmp/trigger-await-${TASK_ID}"
      {
        echo "<task-result task_id=\"${TASK_ID}\">"
        echo "$SUMMARY"
        echo "</task-result>"
        echo "<task-instruction>"
        echo "The worker session completed task #${TASK_ID}. Relay the result above to the original sender now."
        echo "</task-instruction>"
      } >&2
      exit 2
    else
      # Task still in progress — wait for wake event (inbox_mark touches wake file on done)
      inotifywait -qq -t 30 -e modify -e attrib "$WAKE_FILE" 2>/dev/null || true
      {
        echo "<task-status task_id=\"${TASK_ID}\">Status: ${STATUS:-pending}. Waiting for worker.</task-status>"
      } >&2
      exit 2
    fi
  fi

  exit 0
fi

# === Main session logic below ===

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

# Check for pending inbox messages
if [ -f "$DB" ]; then
  PENDING=$(sqlite3 "$DB" "SELECT count(*) FROM messages WHERE status='pending';" 2>/dev/null || echo "0")

  if [ "$PENDING" -gt 0 ]; then
    # Get next pending message
    NEXT_MSG=$(sqlite3 -json "$DB" "SELECT id, channel, sender, content, created_at FROM messages WHERE status='pending' ORDER BY created_at ASC LIMIT 1;" 2>/dev/null || echo "")

    if [ -n "$NEXT_MSG" ]; then
      # Exit 2 = block stopping, stderr becomes feedback to Claude
      {
        echo "<inbox-message>"
        echo "$NEXT_MSG"
        echo "</inbox-message>"
        echo "<task-instruction>"
        echo "Process this inbox message:"
        echo "1. inbox_mark(message_id=<id>, status=\"processing\")"
        echo "2. Do the work described in the message content"
        echo "3. inbox_mark(message_id=<id>, status=\"done\", response_summary=\"<result>\")"
        echo ""
        echo "The response_summary is critical — the trigger session relays it to the original sender."
        echo "Write it as the actual reply: clear, complete, in a tone suitable for the channel."
        echo "For example, if a user asked to fix a bug, write: \"Fixed the null pointer in auth.ts — the issue was..."
        echo "not: \"Marked as done.\""
        echo ""
        echo "$((PENDING - 1)) more messages pending."
        echo "</task-instruction>"
      } >&2
      exit 2
    fi
  fi
fi

# No pending messages - write journal reminder and sleep
echo "No pending messages. Write a short journal entry to memory/$(date +%Y-%m-%d).md if you accomplished something relevant today."
exit 0
