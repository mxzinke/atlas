#!/bin/bash
# SessionStart Hook: Loads identity + memory into Claude's context
set -euo pipefail

WORKSPACE=/atlas/workspace
IDENTITY="$WORKSPACE/identity.md"
MEMORY="$WORKSPACE/memory/MEMORY.md"
MEMORY_DIR="$WORKSPACE/memory"
DB="$WORKSPACE/inbox/atlas.db"

echo "=== ATLAS SESSION START ==="
echo ""

# Load identity
if [ -f "$IDENTITY" ]; then
  echo "--- IDENTITY ---"
  cat "$IDENTITY"
  echo ""
fi

# Load curated long-term memory
if [ -f "$MEMORY" ]; then
  echo "--- LANGZEIT-MEMORY ---"
  cat "$MEMORY"
  echo ""
fi

# Show recent journal entries (titles only, not full content)
if [ -d "$MEMORY_DIR" ]; then
  JOURNALS=$(ls -1 "$MEMORY_DIR"/*.md 2>/dev/null | grep -E '/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$' | sort -r | head -7)
  if [ -n "$JOURNALS" ]; then
    echo "--- JOURNAL-EINTRÄGE (letzte 7 Tage) ---"
    for j in $JOURNALS; do
      FNAME=$(basename "$j" .md)
      LINES=$(wc -l < "$j" 2>/dev/null || echo "0")
      FIRST=$(head -1 "$j" 2>/dev/null | sed 's/^#\+\s*//')
      echo "  $FNAME ($LINES Zeilen) — $FIRST"
    done
    echo ""
    echo "Nutze qmd_search oder lies die Datei direkt bei Bedarf."
    echo ""
  fi
fi

# Show pending inbox count
if [ -f "$DB" ]; then
  PENDING=$(sqlite3 "$DB" "SELECT count(*) FROM messages WHERE status='pending';" 2>/dev/null || echo "0")
  if [ "$PENDING" -gt 0 ]; then
    echo "--- INBOX ---"
    echo "Du hast $PENDING ausstehende Nachrichten. Nutze inbox_list um sie zu sehen."
    echo ""
  fi
fi

echo "=== SESSION BEREIT ==="
