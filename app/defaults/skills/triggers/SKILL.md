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

The Signal Communication Add-on (`app/integrations/signal/signal-addon.py`) consolidates all Signal operations into a single module with its own per-number SQLite database.

Quick setup — 4 steps:

1. **Install**: Add `apt-get install -y signal-cli` to `workspace/user-extensions.sh`
2. **Configure** `workspace/config.yml`:
   ```yaml
   signal:
     number: "+491701234567"
     whitelist: ["+491709876543"]  # empty = accept all
   ```
3. **Create trigger**:
   ```
   trigger_create:
     name: "signal-chat"
     type: "webhook"
     session_mode: "persistent"
     channel: "signal"
     prompt: "New Signal message:\n\n{{payload}}\n\nRespond conversationally. Escalate complex tasks via inbox_write."
   ```
4. **Start services**: `signal-receiver.sh` + `reply-delivery.sh` (see `app/integrations/`)

Flow: signal-cli → signal-addon.py → trigger.sh (per contact, non-blocking) → reply_send → reply-delivery → signal-addon.py deliver → signal-cli send

### Direct messaging

```bash
# Send a message
signal-addon.py send +491701234567 "Hello!"

# List contacts
signal-addon.py contacts

# Conversation history
signal-addon.py history +491701234567
```

## Email Integration (Add-on)

The Email Communication Add-on (`app/integrations/email/email-addon.py`) consolidates all email operations into a single module with its own per-account SQLite database.

Quick setup — 4 steps:

1. **Configure** `workspace/config.yml`:
   ```yaml
   email:
     imap_host: "imap.gmail.com"
     smtp_host: "smtp.gmail.com"
     username: "atlas@example.com"
     password_file: "/atlas/workspace/secrets/email-password"
   ```
2. **Store password**: `echo "app-password" > /atlas/workspace/secrets/email-password`
3. **Create trigger**:
   ```
   trigger_create:
     name: "email-handler"
     type: "webhook"
     session_mode: "persistent"
     channel: "email"
     prompt: "New email:\n\n{{payload}}\n\nRespond professionally. Escalate complex tasks via inbox_write."
   ```
4. **Start services**: `email-receiver.sh` + `reply-delivery.sh` (see `app/integrations/`)

Flow: IMAP poll → email-addon.py → trigger.sh (per thread, non-blocking) → reply_send → reply-delivery → email-addon.py deliver → SMTP

Thread tracking uses `In-Reply-To`/`References` headers — replies in the same thread share one session.

### Direct email sending

```bash
# Send a new email
email-addon.py send recipient@example.com "Subject" "Body text"

# Reply to an existing thread
email-addon.py reply <thread_id> "Reply body"

# List threads
email-addon.py threads
```

## Prompt Fallback

If a trigger's `prompt` field is empty, the system looks for:
```
workspace/triggers/cron/<trigger-name>/event-prompt.md
```

## Crontab Sync

Cron triggers are automatically synced to `workspace/crontab`:
- **Static** (above `# AUTO-GENERATED`): manual entries
- **Dynamic** (below): auto-generated from enabled cron triggers

No manual crontab editing needed — just use the MCP tools.
