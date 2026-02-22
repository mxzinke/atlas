# Atlas – Autonomous Agent System

## Projektübersicht

Atlas ist ein containerisiertes Autonomous-Agent-System basierend auf Claude Code. Es nutzt ein Inbox-basiertes Kommunikationsmodell mit event-driven Wakeup (kein Polling).

## Architektur

```
/atlas/app/       (read-only)  – Core: Hooks, Inbox-MCP, Web-UI, Watcher
/atlas/workspace/ (read-write) – Memory, Identity, Config, Skills, Triggers
/root/            (read-write) – Home: ~/.claude/, ~/.ssh/, git-Config
```

### Kernkomponenten
- **Inbox-MCP** (`app/inbox-mcp/`): SQLite-basierter MCP-Server für Nachrichtenverwaltung
- **Web-UI** (`app/web-ui/`): Hono.js + HTMX Dashboard auf Port 3000 (nginx Proxy: 8080)
- **Watcher** (`app/watcher.sh`): inotifywait-basierter Event-Watcher, weckt Claude bei neuen Nachrichten
- **Hooks** (`app/hooks/`): SessionStart, Stop, PreCompact, SubagentStop
- **QMD**: Memory-Suche (BM25/Vektor/Hybrid) als HTTP-MCP-Daemon

### Datenfluss
1. Trigger empfängt Nachricht → schreibt in Inbox-DB → touch `.wake`
2. Watcher erkennt `.wake` → resumt Claude Session
3. Stop-Hook prüft Inbox → liefert nächste Nachricht oder lässt Claude schlafen
4. Memory wird als Markdown geschrieben, QMD indexiert automatisch

## Tech-Stack
- **Runtime**: Bun (TypeScript, kein Build-Step)
- **Database**: SQLite (better-sqlite3)
- **Web**: Hono.js + HTMX (SSR, kein SPA)
- **Process Manager**: supervisord
- **Cron**: supercronic
- **Container**: Ubuntu 24.04

## Verzeichnisstruktur

| Pfad | Beschreibung |
|------|-------------|
| `app/hooks/session-start.sh` | Lädt Identity + Memory beim Session-Start |
| `app/hooks/stop.sh` | Inbox-Check nach jeder Antwort, Schlaf-Orchestrierung |
| `app/hooks/pre-compact-auto.sh` | Memory-Flush vor Context-Compaction |
| `app/hooks/pre-compact-manual.sh` | Memory-Flush bei manueller Compaction |
| `app/hooks/subagent-stop.sh` | Quality-Gate für Team-Ergebnisse |
| `app/inbox-mcp/` | Inbox-MCP Server (TypeScript, stdio) |
| `app/web-ui/` | Web-Dashboard (Hono + HTMX) |
| `app/watcher.sh` | inotifywait Event-Watcher |
| `app/init.sh` | Container-Startup-Script |
| `app/triggers/cron/` | Cron-Trigger Scripts |
| `app/prompts/` | Prompt-Templates |
| `app/defaults/` | Default config.yml und crontab |

## Denylist

Die folgenden Pfade dürfen NICHT gelesen oder modifiziert werden:
- `/atlas/workspace/secrets/` – API-Keys, Credentials
- `/atlas/app/` – Read-only Core-Code (im Container)

## Entwicklung

```bash
# Build
docker compose build

# Start
docker compose up -d

# Logs
docker compose logs -f

# OAuth Login (einmalig)
docker run -it --rm -v $(pwd)/atlas-home:/root atlas claude login
```

## MCP-Server

### Inbox-MCP (stdio)
Tools: `inbox_list`, `inbox_mark`, `inbox_write`, `reply_send`, `inbox_stats`

### QMD-MCP (HTTP, Port 8181)
Tools: `qmd_search`, `qmd_vector_search`, `qmd_deep_search`, `qmd_get`, `qmd_multi_get`, `qmd_status`
