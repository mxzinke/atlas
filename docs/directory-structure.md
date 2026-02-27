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
│   ├── SOUL.md                # Default agent soul
│   └── skills/                # System skills (symlinked into .claude/skills/)
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

## /home/atlas/ (Read-Write)

Persistent home directory. Mounted as a Docker volume (`./home:/home/atlas`). Contains all user data.

```
home/
├── .claude/                    # Claude Code configuration
│   ├── settings.json          # Hooks config, MCP servers (written by generate-settings.ts)
│   ├── skills/                # Merged skill directory (per-skill symlinks)
│   │   └── <skill-name> →     # Symlinks to system or user skills
│   └── agents/ →              # Symlink to ~/agents
├── .index/                     # System state (was inbox/)
│   ├── atlas.db               # SQLite database (WAL mode)
│   ├── .wake                  # Wake signal file
│   ├── .wake-*                # Trigger re-awakening files
│   ├── .last-session-id       # Last main session ID
│   ├── .session-running       # Session lock indicator
│   ├── .session.flock         # flock file for main session concurrency
│   ├── signal/                # Signal databases (per number)
│   └── email/                 # Email databases (per account)
├── memory/                     # Long-term memory
│   ├── MEMORY.md              # Persistent knowledge base
│   ├── journal/               # Daily journal entries
│   │   └── YYYY-MM-DD.md
│   └── projects/              # Project-specific notes
├── projects/                   # Working directories
├── skills/                     # Atlas-created skills
├── agents/                     # Atlas-created agents
├── triggers/                   # Custom trigger prompts (optional)
│   └── cron/
│       └── <trigger-name>/
│           └── event-prompt.md
├── mcps/                       # User-installed MCP servers
├── secrets/                    # API keys, credentials (denylist)
├── bin/                        # User scripts
├── supervisor.d/               # Supervisord config overrides
├── logs/                       # Runtime logs
├── IDENTITY.md                 # Agent personality
├── SOUL.md                     # Agent soul (core values)
├── config.yml                  # System configuration
├── crontab                     # Generated crontab
└── user-extensions.sh          # Custom package installs
```

## Key Files Reference

| Path | Description |
|------|-------------|
| `app/hooks/session-start.sh` | Loads memory context on wake |
| `app/hooks/stop.sh` | Inbox checking and sleep orchestration |
| `app/inbox-mcp/index.ts` | MCP server with inbox/trigger tools |
| `app/watcher.sh` | inotifywait loop for wake events |
| `app/web-ui/index.ts` | Hono.js dashboard server |
| `app/defaults/skills/` | System skills (symlinked into `.claude/skills/`) |
| `/home/atlas/.index/atlas.db` | SQLite database (messages, triggers, sessions) |
| `/home/atlas/memory/MEMORY.md` | Long-term memory storage |
| `/home/atlas/IDENTITY.md` | Agent identity/personality |
| `/home/atlas/config.yml` | Runtime configuration |
