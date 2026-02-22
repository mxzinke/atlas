#!/bin/bash
# PreCompact (auto) Hook: Memory flush before context compaction
set -euo pipefail

TODAY=$(date +%Y-%m-%d)

cat << 'EOF'
=== CONTEXT COMPACTION STEHT BEVOR ===

Bevor der Context compacted wird, konsolidiere wichtige Erkenntnisse:

1. Schreibe dauerhafte Fakten, Entscheidungen und Präferenzen in memory/MEMORY.md
2. Schreibe Task-Ergebnisse und Tageskontext in memory/JOURNAL_DATE.md
3. Falls ein Projekt-Thema relevant ist, erstelle/aktualisiere eine Datei in memory/projects/

Wichtig:
- MEMORY.md ist für langfristige, zeitlose Informationen
- Das Journal ist für tagesaktuelle Details (append-only)
- Schreibe NUR was wirklich relevant ist, kein Noise

Führe den Memory-Flush jetzt durch.
EOF

# Replace placeholder with actual date
echo ""
echo "(Journal-Datei: memory/${TODAY}.md)"
