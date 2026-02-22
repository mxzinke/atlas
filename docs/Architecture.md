# Architecture

Atlas is a single-container system that turns Claude Code into a persistent, event-driven agent. This document explains how the components fit together.

## Overview

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
│               │  messages │ triggers │ signal_sessions    │            │
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

## Components

### nginx (Port 8080)

Reverse proxy that forwards all traffic to the web-ui on port 3000. Includes rate limiting (10 req/s with burst of 20).

**Config:** `app/nginx.conf`

### Web-UI (Port 3000)

Hono.js server with HTMX for live updates. Server-side rendered, no SPA build step.

**Pages:**
- `/` — Dashboard with session status, pending messages, recent activity
- `/inbox` — Message list with status filters
- `/triggers` — Trigger management (CRUD, toggle, run)
- `/memory` — MEMORY.md viewer and file browser
- `/journal` — Date-based journal viewer
- `/chat` — Web chat interface
- `/settings` — Identity, config, extensions editor
- `/api/webhook/:name` — Webhook receiver endpoint

**Stack:** Bun + Hono.js + HTMX + better-sqlite3

**Source:** `app/web-ui/index.ts`

### Inbox-MCP (stdio)

MCP server that gives Claude tools to manage its inbox and triggers. Communicates via stdio (not HTTP) — Claude Code connects directly.

**Tools:**
| Tool | Purpose |
|------|---------|
| `inbox_list` | List messages by status/channel |
| `inbox_mark` | Mark message as processing/done |
| `inbox_write` | Write new message (touches `.wake`) |
| `reply_send` | Reply via the original channel |
| `inbox_stats` | Message statistics |
| `trigger_list` | List all triggers |
| `trigger_create` | Create new trigger |
| `trigger_update` | Update trigger settings |
| `trigger_delete` | Delete trigger |

**Source:** `app/inbox-mcp/index.ts`, `app/inbox-mcp/db.ts`

### Watcher (inotifywait)

Monitors `/atlas/workspace/inbox/.wake` for filesystem events. When the file is touched:

1. Check `.session-running` lock (prevent concurrent sessions)
2. Read session ID from `.last-session-id`
3. Resume Claude: `claude -p --resume <session-id> "Du hast neue Nachrichten."`
4. Fall back to new session if no prior session exists
5. After session ends, remove lock and return to watching

**Source:** `app/watcher.sh`

### QMD (Port 8181)

Memory search daemon. Indexes all Markdown files in `workspace/memory/` and provides BM25, vector, and hybrid search via HTTP MCP.

**Tools:** `qmd_search`, `qmd_vector_search`, `qmd_deep_search`, `qmd_get`, `qmd_multi_get`, `qmd_status`

### supercronic

Cron replacement that reads `workspace/crontab`. Auto-detects file changes without restart.

The crontab is auto-generated from database triggers by `sync-crontab.ts`. Static entries (like daily-cleanup) sit above the `AUTO-GENERATED` marker; dynamic entries from the triggers table are appended below.

## Database Schema

Atlas uses a single SQLite database at `workspace/inbox/atlas.db` (WAL mode).

### messages

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment primary key |
| channel | TEXT | Source: web, internal, webhook, signal, email, ... |
| sender | TEXT | Sender identifier (nullable) |
| content | TEXT | Message body |
| reply_to | TEXT | Reference to original contact/message |
| status | TEXT | pending, processing, done |
| response_summary | TEXT | Claude's response (for web channel) |
| created_at | TEXT | ISO datetime |
| processed_at | TEXT | ISO datetime |

### triggers

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment primary key |
| name | TEXT | Unique slug (e.g. `github-check`) |
| type | TEXT | cron, webhook, manual |
| description | TEXT | Human-readable description |
| channel | TEXT | Inbox channel for generated messages |
| schedule | TEXT | Cron expression (for type=cron) |
| webhook_secret | TEXT | Optional secret for webhook auth |
| prompt | TEXT | Prompt template (`{{payload}}` for webhooks) |
| session_mode | TEXT | `ephemeral` (new per run) or `persistent` (resume by session key) |
| enabled | INTEGER | 1=active, 0=disabled |
| last_run | TEXT | Last execution timestamp |
| run_count | INTEGER | Total execution count |
| created_at | TEXT | ISO datetime |

### trigger_sessions

Maps `(trigger_name, session_key)` to a Claude session ID for persistent triggers.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment primary key |
| trigger_name | TEXT | References trigger name |
| session_key | TEXT | Key that identifies the session (e.g. thread ID, sender, `_default`) |
| session_id | TEXT | Claude session ID to resume |
| updated_at | TEXT | ISO datetime |

Unique constraint on `(trigger_name, session_key)`.

## Hook System

Claude Code hooks inject context at lifecycle events. Hooks are shell scripts that output text — the output becomes part of Claude's context.

### SessionStart (`app/hooks/session-start.sh`)

Runs when Claude wakes up. Behavior depends on session type:

**Main session** outputs:
1. **Identity** — Full `identity.md` (name, style, tools, restrictions)
2. **Soul** — Full `soul.md` (behavioral philosophy, boundaries)
3. **Long-term memory** — Full `MEMORY.md`
4. **Recent journals** — List of recent journal filenames with line counts (not full content)
5. **Inbox status** — Number of pending messages

**Trigger session** (detected via `ATLAS_TRIGGER` env var) outputs:
1. **Role instructions** — Read-only filter role, escalation guidelines
2. **Identity** — `identity.md` (minimal context)

Does **not** inject config.yml (Claude can read it when needed).

### Stop (`app/hooks/stop.sh`)

Runs after Claude finishes a response. Behavior depends on session type:

**Main session:**
1. Saves current session ID to `.last-session-id`
2. Queries pending messages
3. If pending: outputs next message JSON, exits 2 (continue processing)
4. If none: reminds Claude to write a journal entry, exits 0 (sleep)

**Trigger session** (detected via `ATLAS_TRIGGER` env var):
1. Exits 0 immediately — trigger sessions don't loop on inbox

### PreCompact (`app/hooks/pre-compact-auto.sh`, `pre-compact-manual.sh`)

Runs before context compaction. Reminds Claude to flush important information to MEMORY.md or journal before the context window is compressed.

### SubagentStop (`app/hooks/subagent-stop.sh`)

Runs when a team member (subagent) finishes. Quality gate that prompts Claude to evaluate the subagent's output for completeness and errors.

## Startup Flow

`init.sh` runs as the first supervisord process (priority 10):

| Phase | Action |
|-------|--------|
| 1 | Check Claude Code authentication (OAuth or API key) |
| 2 | Create workspace directories |
| 3 | Copy default config.yml (if missing) |
| 4 | Copy default crontab (if missing) |
| 5 | Create default identity.md, soul.md, skills (if missing) |
| 6 | Initialize SQLite database + seed default triggers |
| 7 | Run user-extensions.sh (custom installs) |
| 8 | Create Claude Code settings.json (hooks config) |
| 9 | Sync crontab from database triggers |
| 10 | Start services: inbox-mcp, qmd, web-ui, watcher, supercronic |

## Message Flow

### Web Chat (Main Session)

```
User types in /chat
  → POST /chat → INSERT message (channel=web) → touch .wake
  → watcher detects .wake → resume main Claude session
  → SessionStart hook loads identity + memory
  → Claude calls inbox_list → sees pending message
  → Claude calls inbox_mark(status=processing)
  → Claude processes and generates response
  → Claude calls reply_send → response stored in response_summary
  → Stop hook → no more pending → Claude writes journal → sleep
  → Web-UI shows response on refresh
```

### Trigger (Cron / Webhook / Manual)

Triggers spawn their own Claude session. They act as a first-line filter with
read-only workspace access and MCP tools.

```
Event arrives (cron schedule / webhook POST / manual run)
  → trigger.sh <name>
  → Read trigger config from DB (prompt, session_mode, session_id)
  → Spawn trigger Claude session:
    - ephemeral: new session every run
    - persistent: resume stored session_id
  → SessionStart hook detects ATLAS_TRIGGER → loads minimal context
  → Trigger session processes the event:
    Option A: Handles directly (reply_send, MCP actions) → done
    Option B: Escalates to main via inbox_write (1..N tasks)
  → inbox_write touches .wake → watcher resumes main session
  → Stop hook detects ATLAS_TRIGGER → saves session_id if persistent → exit
```

### Escalation Flow

```
Trigger session                          Main session
     │                                        │
     │  inbox_write(channel="task",           │
     │    content="Fix issue #42")            │
     │  ──────────────────────────────────▸   │
     │                              .wake ──▸ │ wakes up
     │  inbox_write(channel="task",           │
     │    content="Update CHANGELOG")         │
     │  ──────────────────────────────────▸   │
     │                                        │ processes tasks
     │  done                                  │ sequentially
```

## Filesystem Layout

### Read-Only (`/atlas/app/`)

Core application code, copied into the container image at build time. Not modified at runtime.

### Read-Write (`/atlas/workspace/`)

Persistent workspace, mounted as a Docker volume. Contains all user data: memory, inbox, triggers, config, identity.

### Home (`/root/`)

Claude Code config directory (`~/.claude/`), SSH keys, git config. Mounted as a Docker volume for persistence across restarts.
