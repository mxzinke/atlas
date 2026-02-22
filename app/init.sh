#!/bin/bash
set -euo pipefail

LOG="/atlas/logs/init.log"
exec > >(tee -a "$LOG") 2>&1

echo "[$(date)] Atlas init starting..."

WORKSPACE=/atlas/workspace

# ── Phase 1: Auth Check ──
echo "[$(date)] Phase 1: Auth check"
if [ -f "$HOME/.claude/.credentials.json" ]; then
  echo "  OAuth credentials found"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  API key configured"
else
  echo "  ⚠ No authentication configured!"
  echo "  Run: docker run -it --rm -v \$(pwd)/atlas-home:/root atlas claude login"
  echo "  Or set ANTHROPIC_API_KEY in docker-compose.yml"
  # Don't exit - web-ui should still start for setup instructions
fi

# ── Phase 2: Directory Setup ──
echo "[$(date)] Phase 2: Directory setup"
mkdir -p "$WORKSPACE/memory/projects" \
         "$WORKSPACE/inbox/replies" \
         "$WORKSPACE/skills" \
         "$WORKSPACE/agents" \
         "$WORKSPACE/mcps" \
         "$WORKSPACE/triggers" \
         "$WORKSPACE/secrets" \
         "$WORKSPACE/bin" \
         "$WORKSPACE/.qmd-cache" \
         /atlas/logs

# ── Phase 3: Default Config ──
echo "[$(date)] Phase 3: Default config"
if [ ! -f "$WORKSPACE/config.yml" ]; then
  cp /atlas/app/defaults/config.yml "$WORKSPACE/config.yml"
  echo "  Created default config.yml"
fi

# ── Phase 4: Default Crontab ──
echo "[$(date)] Phase 4: Crontab"
if [ ! -f "$WORKSPACE/crontab" ]; then
  cp /atlas/app/defaults/crontab "$WORKSPACE/crontab"
  echo "  Created default crontab"
fi

# ── Phase 5: First-Run Check ──
echo "[$(date)] Phase 5: First-run check"
FIRST_RUN=false
if [ ! -f "$WORKSPACE/identity.md" ]; then
  FIRST_RUN=true
  echo "  First run detected - identity.md missing"
  # Create a minimal default identity so the system can start
  cat > "$WORKSPACE/identity.md" << 'IDENTITY'
# Identity

## Name
Atlas

## Behavior & Personality
You are a helpful, structured agent. You communicate clearly and directly.

## User
(Please configure in the Web-UI at /settings)

## Primary Language
English

## Capabilities
- Internet: yes (Playwright MCP)
- Filesystem: yes (/atlas/workspace/)
- Team spawning: yes (unlimited)
- Signal: no

## Restrictions
- No purchases without explicit confirmation
- Do not read the secrets directory
IDENTITY
  echo "  Created default identity.md"
fi

# ── Phase 6: Initialize SQLite DB ──
echo "[$(date)] Phase 6: Database init"
DB="$WORKSPACE/inbox/atlas.db"
if [ ! -f "$DB" ]; then
  sqlite3 "$DB" << 'SQL'
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  sender TEXT,
  content TEXT NOT NULL,
  reply_to TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done')),
  response_summary TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('cron','webhook','manual')),
  description TEXT DEFAULT '',
  channel TEXT DEFAULT 'internal',
  schedule TEXT,
  webhook_secret TEXT,
  prompt TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  run_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signal_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Default trigger: daily cleanup
INSERT INTO triggers (name, type, description, channel, schedule, prompt) VALUES (
  'daily-cleanup',
  'cron',
  'Daily memory flush and session cleanup',
  'internal',
  '0 6 * * *',
  ''
);
SQL
  echo "  Database initialized with new trigger schema"
else
  echo "  Database already exists (migrations handled by inbox-mcp)"
fi

# ── Phase 7: User Extensions ──
echo "[$(date)] Phase 7: User extensions"
if [ -f "$WORKSPACE/user-extensions.sh" ]; then
  echo "  Running user-extensions.sh..."
  bash "$WORKSPACE/user-extensions.sh" || echo "  ⚠ user-extensions.sh failed (non-fatal)"
else
  # Create empty template
  cat > "$WORKSPACE/user-extensions.sh" << 'EXTENSIONS'
#!/bin/bash
# Atlas User Extensions
# This script runs on every container start.
# Use it to install custom tools, e.g.:
#
# apt-get install -y signal-cli
# pip install some-package
#
# Changes to this file take effect on next container restart.
EXTENSIONS
  echo "  Created user-extensions.sh template"
fi

# ── Phase 8: Claude Code Settings ──
echo "[$(date)] Phase 8: Claude Code settings"
CLAUDE_SETTINGS_DIR="/atlas/app/.claude"
mkdir -p "$CLAUDE_SETTINGS_DIR"
# The settings.json with hooks is already in the image at /atlas/app/.claude/settings.json
# Copy it if not already there
if [ ! -f "$CLAUDE_SETTINGS_DIR/settings.json" ]; then
  cat > "$CLAUDE_SETTINGS_DIR/settings.json" << 'SETTINGS'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "/atlas/app/hooks/session-start.sh" }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "/atlas/app/hooks/stop.sh" }]
    }],
    "PreCompact": [
      { "matcher": "auto",
        "hooks": [{ "type": "command", "command": "/atlas/app/hooks/pre-compact-auto.sh" }] },
      { "matcher": "manual",
        "hooks": [{ "type": "command", "command": "/atlas/app/hooks/pre-compact-manual.sh" }] }
    ],
    "SubagentStop": [{
      "hooks": [{ "type": "command", "command": "/atlas/app/hooks/subagent-stop.sh" }]
    }]
  }
}
SETTINGS
  echo "  Created Claude Code settings"
fi

# ── Phase 9: Sync Crontab from Triggers ──
echo "[$(date)] Phase 9: Crontab sync"
bun run /atlas/app/triggers/sync-crontab.ts || echo "  ⚠ Crontab sync failed (non-fatal)"

# ── Phase 10: Start Services ──
echo "[$(date)] Phase 10: Starting services"
supervisorctl start inbox-mcp || true
sleep 1
supervisorctl start qmd || true
supervisorctl start web-ui || true
supervisorctl start watcher || true
supervisorctl start supercronic || true

echo "[$(date)] Atlas init complete. First run: $FIRST_RUN"
echo "[$(date)] Dashboard: http://127.0.0.1:8080"
