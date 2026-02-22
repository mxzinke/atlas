#!/bin/bash
# PreCompact (manual) Hook: Same as auto but with user context
set -euo pipefail

TODAY=$(date +%Y-%m-%d)

cat << 'EOF'
=== MANUELLE COMPACTION ANGEFORDERT ===

Der Nutzer hat manuell eine Context-Compaction ausgelöst.

Konsolidiere ALLE wichtigen Erkenntnisse aus dieser Session:

1. Schreibe dauerhafte Fakten, Entscheidungen und Präferenzen in memory/MEMORY.md
2. Schreibe Task-Ergebnisse und Kontext in memory/JOURNAL_DATE.md
3. Falls ein Projekt-Thema relevant ist, erstelle/aktualisiere memory/projects/

Sei gründlich - nach der Compaction geht der detaillierte Context verloren.
EOF

echo ""
echo "(Journal-Datei: memory/${TODAY}.md)"
