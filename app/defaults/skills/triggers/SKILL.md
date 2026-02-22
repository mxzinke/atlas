---
name: triggers
description: How to create and manage cron, webhook, and manual triggers. Also covers Signal and Email integration setup.
---

# Triggers

Triggers are autonomous agent sessions that process events independently. Each trigger spawns its own Claude session (read-only, with MCP access) and acts as a first-line filter.

## Trigger Types

### Cron
Scheduled execution. Uses standard cron syntax.

| Schedule | Meaning |
|----------|---------|
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * 1-5` | Weekdays at 9:00 |
| `0 6 * * *` | Daily at 6:00 |

### Webhook
HTTP endpoints at `/api/webhook/<trigger-name>`. External services POST data here.
- Payload replaces `{{payload}}` in the prompt template
- Optional authentication via `X-Webhook-Secret` header

### Manual
No schedule, no endpoint. Fired via the web-ui "Run" button or by request.

## Session Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `ephemeral` | New session per run | Cron jobs, one-off webhooks |
| `persistent` | Resume by session key | Signal contacts, email threads |

Persistent triggers use a **session key** to track which session to resume.
The key is the 3rd argument to `trigger.sh`:

```
trigger.sh <trigger-name> [payload] [session-key]
```

Examples:
- `trigger.sh signal-chat '{"msg":"Hi"}' '+49170123456'` → session per contact
- `trigger.sh email-handler '{"body":"..."}' 'thread-4821'` → session per thread
- No key → `_default` (one session per trigger)

## MCP Tools

| Tool | Use |
|------|-----|
| `trigger_list` | List all triggers (optional type filter) |
| `trigger_create` | Create new trigger |
| `trigger_update` | Update fields (description, schedule, prompt, session_mode, enabled) |
| `trigger_delete` | Delete by name |

## Activation: What Happens After trigger_create

### Cron Triggers → fully automatic

1. `trigger_create(type="cron", ...)` inserts the trigger in DB
2. `sync-crontab.ts` is called automatically → writes cron entry to `workspace/crontab`
3. supercronic detects the file change → trigger runs on schedule
4. **Nothing else needed.** Claude just calls `trigger_create`.

### Webhook Triggers → endpoint ready immediately

1. `trigger_create(type="webhook", ...)` inserts the trigger in DB
2. HTTP endpoint is live at `http://<host>:8080/api/webhook/<name>`
3. External services POST to this URL → message goes to inbox → main session wakes
4. **Nothing else needed** for pure webhooks.

### Signal / Email Triggers → need polling cron entry

For Signal and Email, a **poll process** must run to check for new messages. This is NOT automatic — Claude must add a cron entry after creating the trigger.

**Signal setup (3 steps Claude performs):**

```bash
# Step 1: Create trigger
trigger_create(
  name="signal-chat",
  type="webhook",
  session_mode="persistent",
  channel="signal",
  prompt="New Signal message:\n\n{{payload}}"
)

# Step 2: Add poll to crontab (above the auto-generated marker)
# Edit /atlas/workspace/crontab and add BEFORE the marker line:
* * * * *  python3 /atlas/app/integrations/signal/signal-addon.py poll --once 2>&1 >> /atlas/logs/signal.log

# Step 3: Add reply delivery to crontab:
* * * * *  /atlas/app/integrations/reply-delivery.sh --once 2>&1 >> /atlas/logs/reply-delivery.log
```

**Email setup (3 steps Claude performs):**

```bash
# Step 1: Create trigger
trigger_create(
  name="email-handler",
  type="webhook",
  session_mode="persistent",
  channel="email",
  prompt="New email:\n\n{{payload}}"
)

# Step 2: Add poll to crontab:
*/2 * * * *  python3 /atlas/app/integrations/email/email-addon.py poll --once 2>&1 >> /atlas/logs/email.log

# Step 3: Add reply delivery to crontab (if not already there):
* * * * *  /atlas/app/integrations/reply-delivery.sh --once 2>&1 >> /atlas/logs/reply-delivery.log
```

**Important**: Cron entries go **above** the `# === AUTO-GENERATED TRIGGERS` marker in `workspace/crontab`. sync-crontab.ts preserves everything above the marker.

## Prompt Lifecycle

A persistent trigger session goes through three prompt phases. Each has channel-specific templates (`signal`, `email`, fallback `session`):

### 1. Initial Spawn (`trigger-{channel}.md`)

When a new session is created (no existing session for this key):

```
[session-start.sh hook output: identity + trigger role]
[trigger-{channel}.md: full role, reply flow, style, tools, rules]
---
[trigger prompt field with {{payload}} replaced]
```

| Channel | Template | Style |
|---------|----------|-------|
| `signal` | `trigger-signal.md` | Conversational, short, mobile-friendly |
| `email` | `trigger-email.md` | Professional, structured, greeting/sign-off |
| *(other)* | `trigger-session.md` | Generic filter/escalation |

### 2. IPC Injection (`trigger-{channel}-inject.md`)

When a message arrives while the session is already running (IPC socket alive):

| Channel | Template | Content |
|---------|----------|---------|
| `signal` | `trigger-signal-inject.md` | Sender, payload, short reply reminder |
| `email` | `trigger-email-inject.md` | Payload, professional reply reminder |
| *(other)* | `trigger-session-inject.md` | Payload, generic process instructions |

The inject template is a short context prompt — the session already has its role from the initial spawn. The key point: **the user is waiting for a reply**.

### 3. Pre/Post-Compaction (`trigger-{channel}-pre-compact.md` + `trigger-{channel}-compact.md`)

When context approaches the limit, the PreCompact hook fires and outputs two phases:

**Pre-Compaction** (`trigger-{channel}-pre-compact.md`):
- "Save conversation state, notes, and pending work to memory NOW"
- Channel-specific: Signal saves contact notes, Email saves thread summaries

**Post-Compaction** (`trigger-{channel}-compact.md`):
- Re-establishes role, tools, reply flow, and style rules
- Marked `=== POST-COMPACTION CONTEXT — PRESERVE THIS ===` for compaction survival
- Tells Claude to check `memory/` and `qmd_search` to recover lost context

Both are output sequentially by the hook. Claude acts on pre-compact (saves to memory), then compaction preserves the post-compact context as best it can.

### Template File Overview

```
app/prompts/
├── trigger-signal.md              # Initial: Signal session setup
├── trigger-signal-inject.md       # Inject: new Signal message arrived
├── trigger-signal-pre-compact.md  # Pre-compact: save Signal conversation state
├── trigger-signal-compact.md      # Post-compact: re-establish Signal context
├── trigger-email.md               # Initial: Email session setup
├── trigger-email-inject.md        # Inject: new email arrived
├── trigger-email-pre-compact.md   # Pre-compact: save email correspondence state
├── trigger-email-compact.md       # Post-compact: re-establish Email context
├── trigger-session.md             # Initial: generic fallback
├── trigger-session-inject.md      # Inject: generic fallback
├── trigger-session-pre-compact.md # Pre-compact: generic fallback
└── trigger-session-compact.md     # Post-compact: generic fallback
```

### Adding a New Channel

To add a new channel (e.g., `telegram`):
1. Create `trigger-telegram.md` (initial session prompt)
2. Create `trigger-telegram-inject.md` (IPC injection template)
3. Create `trigger-telegram-pre-compact.md` (pre-compaction memory flush)
4. Create `trigger-telegram-compact.md` (post-compaction context)
5. Set `channel: "telegram"` in `trigger_create` — trigger.sh picks the templates automatically

## IPC Socket Injection

When a message arrives while a trigger session is already running for the same key, trigger.sh injects it directly via Claude Code's IPC socket (`/tmp/claudec-<session_id>.sock`). The inject template (see above) is used instead of a hardcoded message. No new process is spawned.

## Creating a Trigger

```
trigger_create:
  name: "github-issues"
  type: "cron"
  schedule: "0 * * * *"
  session_mode: "ephemeral"
  description: "Hourly GitHub issue check"
  channel: "internal"
  prompt: "Check GitHub repos for new issues. Escalate critical ones to main session."
```

For webhooks, also set:
- `webhook_secret`: optional auth token
- `prompt`: use `{{payload}}` where you want the POST body injected

## Escalation Pattern

Trigger sessions act as filters:
1. **Simple events**: Handle directly with reply_send or MCP actions
2. **Complex events**: Escalate to main session via inbox_write (one or more tasks)

```
# Single task escalation
inbox_write(channel="task", sender="trigger:github-issues", content="Review critical issue #42")

# Multi-task escalation
inbox_write(channel="task", sender="trigger:deploy", content="Update CHANGELOG for v2.3.0")
inbox_write(channel="task", sender="trigger:deploy", content="Run post-deploy smoke tests")
```

## Signal Integration (Add-on)

The Signal Add-on (`app/integrations/signal/signal-addon.py`) handles all Signal operations in one module.

```bash
# Poll signal-cli for new messages
signal-addon.py poll --once

# Inject a message directly (e.g., for testing)
signal-addon.py incoming +491701234567 "Hello!" --name "Alice"

# Send / contacts / history
signal-addon.py send +491701234567 "Hello!"
signal-addon.py contacts
signal-addon.py history +491701234567
```

## Email Integration (Add-on)

The Email Add-on (`app/integrations/email/email-addon.py`) handles all email operations in one module.

```bash
# Poll IMAP for new emails
email-addon.py poll --once

# Send / reply / threads
email-addon.py send recipient@example.com "Subject" "Body text"
email-addon.py reply <thread_id> "Reply body"
email-addon.py threads
```

Thread tracking uses `In-Reply-To`/`References` headers — replies in the same thread share one persistent session.

## Prompt Fallback

If a trigger's `prompt` field is empty, the system looks for:
```
workspace/triggers/cron/<trigger-name>/event-prompt.md
```

## Crontab Sync

Cron triggers are automatically synced to `workspace/crontab`:
- **Static** (above `# AUTO-GENERATED`): manual entries, poller cron jobs
- **Dynamic** (below): auto-generated from enabled cron triggers

No manual crontab editing needed for cron triggers — just use `trigger_create`.
For Signal/Email pollers, add entries to the static section above the marker.
