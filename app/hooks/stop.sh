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

# Save current session ID
# Try multiple methods to find the active session ID
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
        echo "Process this message. Use inbox_mark to set status to 'processing', handle it, then use reply_send to respond."
        echo "$((PENDING - 1)) more messages pending in the inbox."
      } >&2
      exit 2
    fi
  fi
fi

# No pending messages - write journal reminder and sleep
echo "No pending messages. Write a short journal entry to memory/$(date +%Y-%m-%d).md if you accomplished something relevant today."
exit 0
