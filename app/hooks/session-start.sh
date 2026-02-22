#!/bin/bash
# SessionStart Hook: Loads identity + memory into Claude's context
set -euo pipefail

WORKSPACE=/atlas/workspace
IDENTITY="$WORKSPACE/identity.md"
MEMORY="$WORKSPACE/memory/MEMORY.md"
TODAY=$(date +%Y-%m-%d)
YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d 2>/dev/null || echo "")
CONFIG="$WORKSPACE/config.yml"

echo "=== ATLAS SESSION START ==="
echo ""

# Load identity
if [ -f "$IDENTITY" ]; then
  echo "--- IDENTITY ---"
  cat "$IDENTITY"
  echo ""
fi

# Load config summary
if [ -f "$CONFIG" ]; then
  echo "--- CONFIG ---"
  cat "$CONFIG"
  echo ""
fi

# Load curated memory
if [ -f "$MEMORY" ]; then
  echo "--- LANGZEIT-MEMORY ---"
  cat "$MEMORY"
  echo ""
fi

# Load today's journal
JOURNAL_TODAY="$WORKSPACE/memory/${TODAY}.md"
if [ -f "$JOURNAL_TODAY" ]; then
  echo "--- JOURNAL HEUTE ($TODAY) ---"
  cat "$JOURNAL_TODAY"
  echo ""
fi

# Load yesterday's journal
if [ -n "$YESTERDAY" ]; then
  JOURNAL_YESTERDAY="$WORKSPACE/memory/${YESTERDAY}.md"
  if [ -f "$JOURNAL_YESTERDAY" ]; then
    echo "--- JOURNAL GESTERN ($YESTERDAY) ---"
    cat "$JOURNAL_YESTERDAY"
    echo ""
  fi
fi

# Show pending inbox count
DB="$WORKSPACE/inbox/atlas.db"
if [ -f "$DB" ]; then
  PENDING=$(sqlite3 "$DB" "SELECT count(*) FROM messages WHERE status='pending';" 2>/dev/null || echo "0")
  if [ "$PENDING" -gt 0 ]; then
    echo "--- INBOX ---"
    echo "Du hast $PENDING ausstehende Nachrichten. Nutze inbox_list um sie zu sehen."
    echo ""
  fi
fi

echo "=== SESSION BEREIT ==="
