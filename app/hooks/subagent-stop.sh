#!/bin/bash
# SubagentStop Hook: Quality gate for team member results
set -euo pipefail

# The subagent's output is available via stdin or environment variables
# Claude Code passes subagent context through the hook environment

cat << 'EOF'
=== SUBAGENT ERGEBNIS-BEWERTUNG ===

Ein Team-Mitglied hat seine Aufgabe abgeschlossen. Prüfe:

1. Wurde die ursprüngliche Aufgabe vollständig erledigt?
2. Gibt es offensichtliche Fehler oder Lücken im Ergebnis?
3. Muss nachgebessert werden oder ist das Ergebnis akzeptabel?

Falls das Ergebnis unvollständig oder fehlerhaft ist:
- Beschreibe was fehlt
- Entscheide ob der Subagent neu beauftragt werden soll

Falls das Ergebnis gut ist:
- Integriere es in den Hauptkontext
- Markiere die zugehörige Aufgabe als erledigt
EOF
