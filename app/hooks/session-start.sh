#!/bin/bash
# SessionStart Hook: Loads identity + memory into Claude's context
set -euo pipefail

WORKSPACE=/atlas/workspace
IDENTITY="$WORKSPACE/identity.md"
SOUL="$WORKSPACE/soul.md"
MEMORY="$WORKSPACE/memory/MEMORY.md"
MEMORY_DIR="$WORKSPACE/memory"
DB="$WORKSPACE/inbox/atlas.db"

# --- Trigger session: minimal context ---
if [ -n "${ATLAS_TRIGGER:-}" ]; then
  echo "=== TRIGGER SESSION: ${ATLAS_TRIGGER} ==="
  echo ""
  echo "You are running as a trigger session (read-only). Your role:"
  echo "- Process the event described in the prompt"
  echo "- Handle simple tasks directly (reply_send, MCP actions)"
  echo "- Escalate complex or write-heavy tasks to the main session via inbox_write"
  echo "- You can use qmd_search for research and inbox tools for communication"
  echo "- Do NOT modify workspace files directly"
  echo ""

  # Load identity (triggers need to know who they are)
  if [ -f "$IDENTITY" ]; then
    echo "--- IDENTITY ---"
    cat "$IDENTITY"
    echo ""
  fi

  echo "=== TRIGGER READY ==="
  exit 0
fi

# --- Main session: full context ---

echo "=== ATLAS SESSION START ==="
echo ""

# Load identity
if [ -f "$IDENTITY" ]; then
  echo "--- IDENTITY ---"
  cat "$IDENTITY"
  echo ""
fi

# Load soul
if [ -f "$SOUL" ]; then
  echo "--- SOUL ---"
  cat "$SOUL"
  echo ""
fi

# Load curated long-term memory
if [ -f "$MEMORY" ]; then
  echo "--- LONG-TERM MEMORY ---"
  cat "$MEMORY"
  echo ""
fi

# Show recent journal entries (titles only, not full content)
if [ -d "$MEMORY_DIR" ]; then
  JOURNALS=$(ls -1 "$MEMORY_DIR"/*.md 2>/dev/null | grep -E '/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$' | sort -r | head -7)
  if [ -n "$JOURNALS" ]; then
    echo "--- RECENT JOURNALS (last 7 days) ---"
    for j in $JOURNALS; do
      FNAME=$(basename "$j" .md)
      LINES=$(wc -l < "$j" 2>/dev/null || echo "0")
      FIRST=$(head -1 "$j" 2>/dev/null | sed 's/^#\+\s*//')
      echo "  $FNAME ($LINES lines) — $FIRST"
    done
    echo ""
    echo "Use qmd_search or read files directly as needed."
    echo ""
  fi
fi

# Show pending inbox count
if [ -f "$DB" ]; then
  PENDING=$(sqlite3 "$DB" "SELECT count(*) FROM messages WHERE status='pending';" 2>/dev/null || echo "0")
  if [ "$PENDING" -gt 0 ]; then
    echo "--- INBOX ---"
    echo "You have $PENDING pending messages. Use inbox_list to view them."
    echo ""
  fi
fi

echo "=== SESSION READY ==="
