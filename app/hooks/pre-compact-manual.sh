#!/bin/bash
# PreCompact (manual) Hook: Same as auto but with user context
set -euo pipefail

TODAY=$(date +%Y-%m-%d)

cat << 'EOF'
=== MANUAL COMPACTION REQUESTED ===

The user has manually triggered a context compaction.

Consolidate ALL important findings from this session:

1. Write lasting facts, decisions, and preferences to memory/MEMORY.md
2. Write task results and context to memory/JOURNAL_DATE.md
3. If a project topic is relevant, create/update memory/projects/

Be thorough - detailed context will be lost after compaction.
EOF

echo ""
echo "(Journal file: memory/${TODAY}.md)"
