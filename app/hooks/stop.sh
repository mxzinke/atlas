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

# Trigger session mode — check for queued messages before exiting
if [ -n "${ATLAS_TRIGGER:-}" ]; then
  TRIGGER_CHANNEL="${ATLAS_TRIGGER_CHANNEL:-}"
  TRIGGER_KEY="${ATLAS_TRIGGER_SESSION_KEY:-}"

  # Check if more messages arrived for this trigger's channel + key
  if [ -f "$DB" ] && [ -n "$TRIGGER_CHANNEL" ] && [ -n "$TRIGGER_KEY" ]; then
    PENDING=$(sqlite3 "$DB" \
      "SELECT count(*) FROM messages WHERE channel='${TRIGGER_CHANNEL//\'/\'\'}' AND reply_to='${TRIGGER_KEY//\'/\'\'}' AND status='pending';" \
      2>/dev/null || echo "0")

    if [ "$PENDING" -gt 0 ]; then
      NEXT_MSG=$(sqlite3 -json "$DB" \
        "SELECT id, channel, sender, content, created_at FROM messages WHERE channel='${TRIGGER_CHANNEL//\'/\'\'}' AND reply_to='${TRIGGER_KEY//\'/\'\'}' AND status='pending' ORDER BY created_at ASC LIMIT 1;" \
        2>/dev/null || echo "")

      if [ -n "$NEXT_MSG" ]; then
        {
          echo "--- NEW MESSAGE (same channel) ---"
          echo "$NEXT_MSG"
          echo ""
          echo "Another message arrived while you were processing. Use inbox_mark to claim it, then reply_send to respond."
          echo "$((PENDING - 1)) more messages pending for this channel."
        } >&2
        exit 2
      fi
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
