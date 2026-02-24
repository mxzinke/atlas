# Atlas

Containerized autonomous agent system powered by Claude Code. Made to enable communication from other tools and optimized heavily for long horizon projects and complicated tasks.

## Goals

- **Event-driven**: No polling, no wasted compute — sleeps until work arrives
- **Multi-channel**: Signal, Email, Web, Webhooks — unified inbox via trigger sessions
- **Autonomous**: Triggers handle events, escalate to worker when needed
- **Persistent**: Memory, identity, and sessions survive restarts of container

## Overview

```
Trigger Event → Inbox (SQLite) → .wake file → watcher → Claude resumes
                                                  ↓
                                         Process task → Write memory
                                                  ↓
                                        Stop hook → More tasks? Sleep
```

## Tech Stack

- **Runtime**: Bun (TypeScript, no build)
- **Database**: SQLite (bun:sqlite)
- **Web**: Hono.js + HTMX
- **Process Manager**: supervisord
- **Container**: Ubuntu 24.04



## Documentation

- [docs/Architecture.md](docs/Architecture.md) — Component overview
- [docs/inbox-mcp.md](docs/inbox-mcp.md) — Inbox system and MCP tools
- [docs/hooks.md](docs/hooks.md) — Lifecycle hooks
- [docs/watcher.md](docs/watcher.md) — Event-driven wake system
- [docs/qmd-memory.md](docs/qmd-memory.md) — Memory and search
- [docs/web-ui.md](docs/web-ui.md) — Dashboard and API
- [docs/directory-structure.md](docs/directory-structure.md) — Filesystem layout
- [docs/development.md](docs/development.md) — Developer guide
- [docs/Triggers.md](docs/Triggers.md) — Triggers guide
- [docs/Integrations.md](docs/Integrations.md) — Signal and Email
