# Directory Structure

Atlas uses three main filesystem locations with different access patterns.

## /atlas/app/ (Read-Only)

Core application code. Copied into the container image at build time. Not modified at runtime.

```
app/
├── bin/                        # CLI wrappers
│   ├── claude-atlas           # Main claude wrapper with mode handling
│   ├── email                  # Email CLI wrapper
│   └── signal                 # Signal CLI wrapper
├── defaults/                   # Default configs seeded on first run
│   ├── config.yml             # Default configuration
│   ├── crontab                # Default cron entries
│   ├── IDENTITY.md            # Default agent identity
│   └── SOUL.md                # Default agent soul
├── hooks/                      # Claude Code lifecycle hooks
│   ├── session-start.sh       # Loads identity + memory on wake
│   ├── stop.sh                # Checks inbox, continues or sleeps
│   ├── pre-compact-auto.sh    # Memory flush before compaction
│   ├── pre-compact-manual.sh  # Memory flush on manual compaction
│   └── subagent-stop.sh       # Quality gate for team results
├── inbox-mcp/                  # MCP server (inbox + trigger tools)
│   ├── index.ts               # Main MCP server
│   └── db.ts                  # Database initialization
├── web-ui/                     # Hono.js dashboard
│   └── index.ts               # Web server
├── triggers/                   # Trigger runner scripts
│   ├── trigger.sh             # Generic trigger runner
│   ├── sync-crontab.ts        # Crontab auto-generation from DB
│   └── cron/                  # Cron-specific scripts
├── integrations/               # Channel CLI tools
│   ├── signal/                # Signal add-on
│   └── email/                 # Email add-on
├── prompts/                    # Prompt templates
│   ├── trigger-*.md           # Trigger-specific prompts
│   └── system-*.md            # System prompts
├── nginx.conf                  # nginx reverse proxy config
├── watcher.sh                  # inotifywait event watcher
├── entrypoint.sh               # Container entrypoint
└── init.sh                     # Container startup script
```

## /atlas/workspace/ (Read-Write)

Persistent workspace. Mounted as a Docker volume. Contains all user data.

```
workspace/
├── inbox/                      # Inbox database and wake files
│   ├── atlas.db               # SQLite database (WAL mode)
│   ├── .wake                  # Wake signal file
│   ├── .wake-*                # Trigger re-awakening files
│   ├── .last-session-id       # Last main session ID
│   ├── .session-running       # Session lock indicator
│   ├── signal/                # Signal databases (per number)
│   └── email/                 # Email databases (per account)
├── memory/                     # Long-term memory
│   ├── MEMORY.md              # Persistent knowledge base
│   ├── YYYY-MM-DD.md          # Daily journal entries
│   └── projects/              # Project-specific notes
├── triggers/                   # Custom trigger prompts (optional)
│   └── cron/
│       └── <trigger-name>/
│           └── event-prompt.md
├── IDENTITY.md                 # Agent personality
├── SOUL.md                     # Agent soul (core values)
├── config.yml                  # System configuration
├── crontab                     # Generated crontab
├── user-extensions.sh          # Custom package installs
└── secrets/                    # API keys, credentials (denylist)
```

## /root/ (Read-Write)

Home directory. Mounted as a Docker volume for persistence.

```
root/
├── .claude/                    # Claude Code configuration
│   ├── settings.json          # Hooks config, MCP servers
│   └── projects/              # Session history
├── .claude.json               # Claude Code cached features
└── .ssh/                      # SSH keys
```

## Key Files Reference

| Path | Description |
|------|-------------|
| `app/hooks/session-start.sh` | Loads memory context on wake |
| `app/hooks/stop.sh` | Inbox checking and sleep orchestration |
| `app/inbox-mcp/index.ts` | MCP server with inbox/trigger tools |
| `app/watcher.sh` | inotifywait loop for wake events |
| `app/web-ui/index.ts` | Hono.js dashboard server |
| `workspace/inbox/atlas.db` | SQLite database (messages, triggers, sessions) |
| `workspace/memory/MEMORY.md` | Long-term memory storage |
| `workspace/IDENTITY.md` | Agent identity/personality |
| `workspace/config.yml` | Runtime configuration |
