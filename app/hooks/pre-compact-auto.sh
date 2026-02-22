#!/bin/bash
# PreCompact (auto) Hook: Memory flush before context compaction
# For trigger sessions: uses channel-specific pre-compact + compact templates
# For main session: uses generic memory flush instructions
set -euo pipefail

TODAY=$(date +%Y-%m-%d)
PROMPT_DIR="/atlas/app/prompts"

# --- Trigger session: channel-specific compaction ---
if [ -n "${ATLAS_TRIGGER:-}" ]; then
  CHANNEL="${ATLAS_TRIGGER_CHANNEL:-internal}"
  TRIGGER_NAME="$ATLAS_TRIGGER"

  # Phase 1: Pre-compaction — save state to memory
  PRE_COMPACT=""
  for candidate in "$PROMPT_DIR/trigger-${CHANNEL}-pre-compact.md" "$PROMPT_DIR/trigger-session-pre-compact.md"; do
    if [ -f "$candidate" ]; then
      PRE_COMPACT="$candidate"
      break
    fi
  done

  if [ -n "$PRE_COMPACT" ]; then
    sed -e "s|{{trigger_name}}|${TRIGGER_NAME}|g" \
        -e "s|{{channel}}|${CHANNEL}|g" \
        -e "s|{{today}}|${TODAY}|g" \
        "$PRE_COMPACT"
  fi

  echo ""
  echo "(Journal file: memory/${TODAY}.md)"
  echo ""

  # Phase 2: Post-compaction context — should survive compaction
  COMPACT=""
  for candidate in "$PROMPT_DIR/trigger-${CHANNEL}-compact.md" "$PROMPT_DIR/trigger-session-compact.md"; do
    if [ -f "$candidate" ]; then
      COMPACT="$candidate"
      break
    fi
  done

  if [ -n "$COMPACT" ]; then
    sed -e "s|{{trigger_name}}|${TRIGGER_NAME}|g" \
        -e "s|{{channel}}|${CHANNEL}|g" \
        "$COMPACT"
  fi

  exit 0
fi

# --- Main session: generic memory flush ---

cat << 'EOF'
=== CONTEXT COMPACTION IMMINENT ===

Before the context is compacted, consolidate important findings:

1. Write lasting facts, decisions, and preferences to memory/MEMORY.md
2. Write task results and daily context to memory/JOURNAL_DATE.md
3. If a project topic is relevant, create/update a file in memory/projects/

Important:
- MEMORY.md is for long-term, timeless information
- The journal is for daily details (append-only)
- Only write what is truly relevant, no noise

Perform the memory flush now.
EOF

echo ""
echo "(Journal file: memory/${TODAY}.md)"
