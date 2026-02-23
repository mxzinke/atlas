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

  if [ -f "$AWAIT_FILE" ]; then
    TASK_ID=$(cat "$AWAIT_FILE" | tr -d '[:space:]')
    STATUS=$(sqlite3 "$DB" "SELECT status FROM messages WHERE id=${TASK_ID};" 2>/dev/null || echo "")
    SUMMARY=$(sqlite3 "$DB" "SELECT response_summary FROM messages WHERE id=${TASK_ID};" 2>/dev/null || echo "")

    if [ "$STATUS" = "done" ]; then
      rm -f "$AWAIT_FILE"
      {
        echo "--- TASK #${TASK_ID} COMPLETED ---"
        echo ""
        echo "$SUMMARY"
        echo ""
        echo "Relay this result to the original sender now."
      } >&2
      exit 2
    else
      # Task still in progress — sleep and check again next turn
      sleep 5
      {
        echo "--- AWAITING TASK #${TASK_ID} ---"
        echo "Status: ${STATUS:-pending}. Still waiting for the worker to complete."
        echo "Check again."
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
        echo "--- NEW INBOX MESSAGE ---"
        echo "$NEXT_MSG"
        echo ""
        echo "Process this message. Use inbox_mark to set status to 'processing', do the work, then mark done with a response_summary that clearly describes the result — the trigger session will relay it back to the original sender."
        echo "$((PENDING - 1)) more messages pending in the inbox."
      } >&2
      exit 2
    fi
  fi
fi

# No pending messages - write journal reminder and sleep
echo "No pending messages. Write a short journal entry to memory/$(date +%Y-%m-%d).md if you accomplished something relevant today."
exit 0
