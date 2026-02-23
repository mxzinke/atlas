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
- **Watcher** (`app/watcher.sh`): inotifywait-based event watcher, wakes worker session on `.wake` and re-awakens trigger sessions via `.wake-<trigger>-<taskId>` files
- **Hooks** (`app/hooks/`): SessionStart, Stop, PreCompact, SubagentStop (trigger-aware)
- **Triggers** (`app/triggers/`): Autonomous agent sessions per trigger (read-only, filter/escalation)
- **QMD**: Memory search (BM25/vector/hybrid) as HTTP MCP daemon

### Data Flow
1. Trigger receives event → spawns own Claude session (read-only, with MCP access)
2. Trigger session processes event: handles directly or escalates via `task_create`
3. Escalated tasks → `.wake` → watcher resumes worker session (read/write)
4. Worker session processes tasks from inbox sequentially
5. Worker completes task → `.wake-<trigger>-<taskId>` → watcher re-awakens trigger session
6. Memory is written as Markdown, QMD indexes automatically

## Tech Stack
- **Runtime**: Bun (TypeScript, no build step)
- **Database**: SQLite (bun:sqlite)
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

**Trigger tools** (when `ATLAS_TRIGGER` is set): `task_create`, `task_get`, `task_update`, `task_cancel`, `inbox_mark`, `inbox_list`

**Worker tools** (when `ATLAS_TRIGGER` is not set): `get_next_task`, `task_complete`, `task_list`, `task_get`, `inbox_stats`

**Shared tools** (always available): `trigger_list`, `trigger_create`, `trigger_update`, `trigger_delete`

**Tables**: `messages` (task queue with statuses: pending/processing/done/cancelled), `task_awaits` (tracks which trigger session is waiting for a task result), `trigger_sessions` (maps triggers to persistent Claude session IDs), `triggers` (cron/webhook/manual trigger definitions)

### QMD-MCP (HTTP, port 8181)
Tools: `qmd_search`, `qmd_vector_search`, `qmd_deep_search`, `qmd_get`, `qmd_multi_get`, `qmd_status`
