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
  echo "  Run: docker run -it --rm -v \$(pwd)/atlas-home:/home/atlas atlas claude login"
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

if [ ! -f "$WORKSPACE/IDENTITY.md" ]; then
    FIRST_RUN=true
    echo "  First run detected - creating placeholder IDENTITY.md"

    cp /atlas/app/defaults/IDENTITY.md "$WORKSPACE/IDENTITY.md"

    echo "  Created placeholder IDENTITY.md"
fi

# Soul (separate from identity — internal behavioral philosophy)
if [ ! -f "$WORKSPACE/SOUL.md" ]; then
  cp /atlas/app/defaults/SOUL.md "$WORKSPACE/SOUL.md"
  echo "  Created default SOUL.md"
fi

# Default skills (Claude Code convention: <name>/SKILL.md)
# Migrate old flat files → directory structure
for old_skill in "$WORKSPACE"/skills/*.md; do
  [ -f "$old_skill" ] || continue
  OLD_NAME=$(basename "$old_skill" .md)
  if [ -d "$WORKSPACE/skills/$OLD_NAME" ]; then
    rm "$old_skill"
    echo "  Migrated skill: removed old $OLD_NAME.md (replaced by $OLD_NAME/SKILL.md)"
  fi
done

# Always refresh system skills from defaults (single source of truth)
for skill_dir in /atlas/app/defaults/skills/*/; do
  [ -d "$skill_dir" ] || continue
  SKILL_NAME=$(basename "$skill_dir")
  DEST="$WORKSPACE/skills/$SKILL_NAME"
  cp -r "$skill_dir" "$DEST"
  echo "  Refreshed skill: $SKILL_NAME"
done

# ── Phase 6: Initialize SQLite DB ──
echo "[$(date)] Phase 6: Database init"
DB="$WORKSPACE/inbox/atlas.db"
FIRST_DB=false
if [ ! -f "$DB" ]; then
  FIRST_DB=true
fi

# Always run canonical schema init + migrations (idempotent)
bun -e "import { initDb } from '/atlas/app/inbox-mcp/db'; initDb();" || {
  echo "  ⚠ Database init via bun failed (non-fatal)"
}

# Seed default trigger on first run
if [ "$FIRST_DB" = true ] && [ -f "$DB" ]; then
  sqlite3 "$DB" "INSERT OR IGNORE INTO triggers (name, type, description, channel, schedule, prompt) VALUES (
    'daily-cleanup', 'cron', 'Daily memory flush and session cleanup', 'internal', '0 6 * * *', '');"
  echo "  Database initialized with default trigger"
else
  echo "  Database ready (schema + migrations applied)"
fi

# Ensure web-chat trigger exists (idempotent migration)
sqlite3 "$DB" "INSERT OR IGNORE INTO triggers (name, type, description, channel, prompt, session_mode) VALUES (
  'web-chat', 'manual', 'Web UI chat message handler', 'web', '', 'persistent');" || echo "  ⚠ web-chat trigger insert failed (non-fatal)"

# Create web-chat spawn prompt (used when session is not running and must be started/resumed)
# The {{payload}} placeholder is substituted with the JSON message by trigger.sh
mkdir -p "$WORKSPACE/triggers/web-chat"
if [ ! -f "$WORKSPACE/triggers/web-chat/prompt.md" ]; then
  cat > "$WORKSPACE/triggers/web-chat/prompt.md" << 'WCPROMPT'
New web UI message:

{{payload}}

Reply to the user's "message" field conversationally.
WCPROMPT
  echo "  Created web-chat trigger prompt"
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
# Regenerated on every start to pick up model changes from config.yml
echo "[$(date)] Phase 8: Claude Code settings (from config.yml)"
bun run /atlas/app/hooks/generate-settings.ts || echo "  ⚠ Settings generation failed (non-fatal)"

# Symlink MCP config so Claude Code discovers servers in the workspace
ln -sf /atlas/app/.mcp.json "$WORKSPACE/.mcp.json"
echo "  MCP config symlinked: $WORKSPACE/.mcp.json -> /atlas/app/.mcp.json"

# Symlink Claude Code settings (hooks, env, permissions) into workspace project dir
mkdir -p "$WORKSPACE/.claude"
ln -sf /atlas/app/.claude/settings.json "$WORKSPACE/.claude/settings.json"
echo "  Settings symlinked: $WORKSPACE/.claude/settings.json -> /atlas/app/.claude/settings.json"
ln -sf "$WORKSPACE/skills" "$WORKSPACE/.claude/skills"
echo "  Skills symlinked: $WORKSPACE/.claude/skills -> $WORKSPACE/skills"

# Disable remote MCP connectors (claudeai-mcp) that cause session hangs.
# Claude Code caches the gate value from .claude.json on startup.
if [ -f "$HOME/.claude.json" ] && command -v jq &>/dev/null; then
  jq '.cachedGrowthBookFeatures.tengu_claudeai_mcp_connectors = false' \
    "$HOME/.claude.json" > "$HOME/.claude.json.tmp" && mv "$HOME/.claude.json.tmp" "$HOME/.claude.json"
  echo "  Remote MCP connectors disabled in .claude.json"
fi

# ── Phase 9: Sync Crontab from Triggers ──
echo "[$(date)] Phase 9: Crontab sync"
bun run /atlas/app/triggers/sync-crontab.ts || echo "  ⚠ Crontab sync failed (non-fatal)"

# ── Phase 10: Start Services ──
echo "[$(date)] Phase 10: Starting services"
supervisorctl start inbox-mcp || true
sleep 1
supervisorctl start qmd || true
supervisorctl start playwright-mcp || true
supervisorctl start web-ui || true
supervisorctl start watcher || true
supervisorctl start supercronic || true

echo "[$(date)] Atlas init complete. First run: $FIRST_RUN"
echo "[$(date)] Dashboard: http://127.0.0.1:8080"

exit 0
