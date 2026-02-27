# Architecture

Atlas is a single-container system that turns Claude Code into a persistent, event-driven agent. This document provides a high-level component overview. For detailed information, see the focused documentation files.

## System Overview

```
┌─────────────────── Docker Container (supervisord) ────────────────────┐
│                                                                        │
│  ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌───────────────────┐   │
│  │  nginx   │──▸│  web-ui  │   │ inbox-mcp│   │     watcher.sh    │   │
│  │  :8080   │   │  :3000   │   │  (stdio) │   │  (inotifywait)    │   │
│  └─────────┘   └──────────┘   └──────────┘   └───────────────────┘   │
│                      │               │               │                 │
│                      ▼               ▼               ▼                 │
│               ┌──────────────────────────────────────────┐            │
│               │          atlas.db (SQLite)                │            │
│               │  messages │ triggers │ trigger_sessions    │            │
│               └──────────────────────────────────────────┘            │
│                                      │                                 │
│                               touch .wake                              │
│                                      │                                 │
│                                      ▼                                 │
│                          ┌───────────────────┐                         │
│                          │   Claude Code      │                         │
│                          │   (resumed via     │                         │
│                          │    watcher.sh)     │                         │
│                          └───────────────────┘                         │
│                                                                        │
│  ┌────────────┐   ┌────────────┐                                      │
│  │ supercronic│   │    qmd     │                                      │
│  │ (cron)     │   │   :8181    │                                      │
│  └────────────┘   └────────────┘                                      │
└────────────────────────────────────────────────────────────────────────┘
```

## Component Summary

| Component | Port | Purpose | Documentation |
|-----------|------|---------|---------------|
| **nginx** | 8080 | Reverse proxy to web-ui | [web-ui.md](web-ui.md) |
| **web-ui** | 3000 | Hono.js + HTMX dashboard | [web-ui.md](web-ui.md) |
| **inbox-mcp** | stdio | MCP server for inbox/trigger tools | [inbox-mcp.md](inbox-mcp.md) |
| **watcher** | — | inotifywait loop, resumes Claude | [watcher.md](watcher.md) |
| **supercronic** | — | Cron job runner | [Triggers.md](Triggers.md) |
| **qmd** | 8181 | Memory search daemon | [qmd-memory.md](qmd-memory.md) |

## Data Flow

1. **Event arrives** — Cron fires, webhook POSTs, or message sent
2. **Write to inbox** — Event stored in SQLite with `status='pending'`
3. **Wake signal** — `.wake` file touched
4. **Watcher detects** — `inotifywait` sees the change
5. **Resume Claude** — Main session resumes with `get_next_task()`
6. **Process** — Claude claims task, processes, completes
7. **Re-awaken trigger** — If task had trigger, `.wake-<trigger>-<id>` wakes it
8. **Sleep** — Stop hook checks inbox; if empty, session exits

## Session Types

### Main Session (Worker)
- **Spawned by**: watcher.sh on `.wake`
- **Access**: Read/write workspace
- **Tools**: Worker tools (get_next_task, task_complete, etc.)
- **Purpose**: Processes escalated tasks, writes memory

### Trigger Session
- **Spawned by**: trigger.sh per event
- **Access**: Read-only workspace
- **Tools**: Trigger tools (task_create, task_get, etc.)
- **Purpose**: Filters events, escalates when needed

See [Triggers.md](Triggers.md) for details.

## Filesystem Layout

| Location | Access | Contents |
|----------|--------|----------|
| `/atlas/app/` | Read-only | Core code, hooks, MCP server |
| `/home/atlas/` | Read-write | Memory, system state, config, identity, skills |

See [directory-structure.md](directory-structure.md) for details.

## Hook System

Hooks inject context at lifecycle events:

| Hook | Runs When | Purpose |
|------|-----------|---------|
| session-start.sh | Session starts | Load memory, identity, inbox status |
| stop.sh | After response | Check inbox, continue or sleep |
| pre-compact-*.sh | Before compaction | Prompt memory flush |
| subagent-stop.sh | Subagent finishes | Quality gate |

See [hooks.md](hooks.md) for details.

## Detailed Documentation

- [inbox-mcp.md](inbox-mcp.md) — Database schema, MCP tools, message lifecycle
- [hooks.md](hooks.md) — Lifecycle hook system
- [watcher.md](watcher.md) — Event-driven wake system
- [qmd-memory.md](qmd-memory.md) — Memory and search system
- [web-ui.md](web-ui.md) — Dashboard and API
- [directory-structure.md](directory-structure.md) — Filesystem layout
- [development.md](development.md) — Developer guide
- [Triggers.md](Triggers.md) — Triggers system
- [Integrations.md](Integrations.md) — Signal and Email channels
