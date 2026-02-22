# Atlas – Autonomous Agent System

## Project Overview

Atlas is a containerized autonomous agent system built on Claude Code. It uses an inbox-based communication model with event-driven wakeup (no polling).

## Architecture

```
/atlas/app/       (read-only)  – Core: Hooks, Inbox-MCP, Web-UI, Watcher
/atlas/workspace/ (read-write) – Memory, Identity, Config, Skills, Triggers
/root/            (read-write) – Home: ~/.claude/, ~/.ssh/, git config
```

### Core Components
- **Inbox-MCP** (`app/inbox-mcp/`): SQLite-based MCP server for message and trigger management
- **Web-UI** (`app/web-ui/`): Hono.js + HTMX dashboard on port 3000 (nginx proxy: 8080)
- **Watcher** (`app/watcher.sh`): inotifywait-based event watcher, wakes main session on new messages
- **Hooks** (`app/hooks/`): SessionStart, Stop, PreCompact, SubagentStop (trigger-aware)
- **Triggers** (`app/triggers/`): Autonomous agent sessions per trigger (read-only, filter/escalation)
- **QMD**: Memory search (BM25/vector/hybrid) as HTTP MCP daemon

### Data Flow
1. Trigger receives event → spawns own Claude session (read-only, with MCP access)
2. Trigger session processes event: handles directly or escalates via `inbox_write`
3. Escalated tasks → `.wake` → watcher resumes main session (read/write)
4. Main session processes tasks from inbox sequentially
5. Memory is written as Markdown, QMD indexes automatically

## Tech Stack
- **Runtime**: Bun (TypeScript, no build step)
- **Database**: SQLite (better-sqlite3)
- **Web**: Hono.js + HTMX (SSR, no SPA)
- **Process Manager**: supervisord
- **Cron**: supercronic
- **Container**: Ubuntu 24.04

## Directory Structure

| Path | Description |
|------|-------------|
| `app/hooks/session-start.sh` | Loads identity + memory on session start |
| `app/hooks/stop.sh` | Inbox check after each response, sleep orchestration |
| `app/hooks/pre-compact-auto.sh` | Memory flush before context compaction |
| `app/hooks/pre-compact-manual.sh` | Memory flush on manual compaction |
| `app/hooks/subagent-stop.sh` | Quality gate for team member results |
| `app/inbox-mcp/` | Inbox-MCP server (TypeScript, stdio) |
| `app/web-ui/` | Web dashboard (Hono + HTMX) |
| `app/watcher.sh` | inotifywait event watcher |
| `app/init.sh` | Container startup script |
| `app/triggers/trigger.sh` | Trigger runner: IPC socket inject or spawn Claude session |
| `app/triggers/sync-crontab.ts` | Auto-generates crontab from DB triggers |
| `app/triggers/cron/` | Cron-specific scripts (daily-cleanup, event) |
| `app/integrations/` | Channel CLI tools (signal, email) |
| `app/integrations/signal/` | Signal Add-on (poll, incoming, send, contacts, history) |
| `app/integrations/email/` | Email Add-on (poll, send, reply, thread tracking) |
| `app/prompts/` | Prompt templates: trigger-signal.md, trigger-email.md, trigger-session.md |
| `app/defaults/` | Default config.yml and crontab |

## Denylist

The following paths must NOT be read or modified:
- `/atlas/workspace/secrets/` – API keys, credentials
- `/atlas/app/` – Read-only core code (inside the container)

## Development

```bash
# Build
docker compose build

# Start
docker compose up -d

# Logs
docker compose logs -f

# OAuth login (one-time)
docker run -it --rm -v $(pwd)/atlas-home:/root atlas claude login
```

## MCP Servers

### Inbox-MCP (stdio)
Tools: `inbox_list`, `inbox_mark`, `inbox_write`, `inbox_stats`, `trigger_list`, `trigger_create`, `trigger_update`, `trigger_delete`

### QMD-MCP (HTTP, port 8181)
Tools: `qmd_search`, `qmd_vector_search`, `qmd_deep_search`, `qmd_get`, `qmd_multi_get`, `qmd_status`
