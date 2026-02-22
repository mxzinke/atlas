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
      echo "--- NEUE INBOX-NACHRICHT ---"
      echo "$NEXT_MSG"
      echo ""
      echo "Verarbeite diese Nachricht. Nutze inbox_mark um sie als 'processing' zu markieren, bearbeite sie, und nutze dann reply_send für die Antwort."
      echo "Noch $((PENDING - 1)) weitere Nachrichten in der Inbox."
      # Exit 1 = continue processing (don't sleep)
      exit 1
    fi
  fi
fi

# No pending messages - write journal reminder and sleep
echo "Keine ausstehenden Nachrichten. Schreibe ein kurzes Journal-Entry in memory/$(date +%Y-%m-%d).md falls du heute etwas Relevantes erledigt hast."
exit 0
