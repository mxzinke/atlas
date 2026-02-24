# Development Guide

Building and running Atlas for development.

## Build

```bash
docker compose build
```

## Start

```bash
docker compose up -d
```

The Web-UI is available at http://localhost:8080.

## OAuth Login (One-Time)

```bash
docker run -it --rm -v $(pwd)/atlas-home:/root atlas claude login
```

This stores credentials in `atlas-home/.claude/` for persistence across restarts.

## View Logs

```bash
# All logs
docker compose logs -f

# Specific services
docker compose logs -f atlas

# Inside container
docker compose exec atlas tail -f /atlas/logs/session.log
docker compose exec atlas tail -f /atlas/logs/init.log
docker compose exec atlas tail -f /atlas/logs/qmd.log
```

## Service Status

```bash
docker compose exec atlas supervisorctl status
```

Services managed by supervisord:
- `nginx` — Reverse proxy (port 8080)
- `web-ui` — Dashboard (port 3000)
- `qmd` — Memory search (port 8181)
- `watcher` — Event watcher
- `supercronic` — Cron runner

## Rebuild After Code Changes

```bash
docker compose build && docker compose up -d
```

## Access Container Shell

```bash
docker compose exec atlas bash
```

## Database Access

```bash
docker compose exec atlas sqlite3 /atlas/workspace/inbox/atlas.db
```

## Test Webhook Locally

```bash
curl -X POST http://localhost:8080/api/webhook/test-trigger \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from curl"}'
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ATLAS_TRIGGER` | Set when running as trigger session |
| `ATLAS_TRIGGER_CHANNEL` | Channel for trigger context |
| `ATLAS_TRIGGER_SESSION_KEY` | Session key for persistent triggers |
| `CLAUDE_SESSION_ID` | Current session ID (set by Claude Code) |

## File Locations in Container

| Path | Purpose |
|------|---------|
| `/atlas/app/` | Core code (read-only) |
| `/atlas/workspace/` | Persistent data |
| `/atlas/logs/` | Log files |
| `/root/.claude/` | Claude Code config |
