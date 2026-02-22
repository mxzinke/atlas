#!/bin/bash
# PreCompact (auto) Hook: Memory flush before context compaction
set -euo pipefail

TODAY=$(date +%Y-%m-%d)

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
