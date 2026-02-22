---
name: triggers
description: How to create and manage cron, webhook, and manual triggers. Also covers Signal and Email integration setup.
---

# Triggers

Triggers are autonomous agent sessions that fire on events — scheduled (cron), HTTP (webhook), or on-demand (manual). Each trigger runs its own Claude session that can handle the event directly or escalate to the main session.

## Trigger Types

### Cron
Scheduled execution using standard cron syntax.

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

Persistent triggers maintain separate sessions per key (e.g., per contact, per thread). If no key is provided, a single default session is used per trigger.

## MCP Tools

| Tool | Use |
|------|-----|
| `trigger_list` | List all triggers (optional type filter) |
| `trigger_create` | Create new trigger |
| `trigger_update` | Update fields (description, schedule, prompt, session_mode, enabled) |
| `trigger_delete` | Delete by name |

## Creating Triggers

### Cron Trigger (fully automatic)

```
trigger_create(
  name="github-issues",
  type="cron",
  schedule="0 * * * *",
  session_mode="ephemeral",
  description="Hourly GitHub issue check",
  channel="internal",
  prompt="Check GitHub repos for new issues. Escalate critical ones to main session."
)
```

After creation, the crontab is synced automatically — supercronic picks it up. **Nothing else needed.**

### Webhook Trigger (endpoint ready immediately)

```
trigger_create(
  name="deploy-hook",
  type="webhook",
  session_mode="ephemeral",
  description="Post-deploy notification",
  channel="internal",
  webhook_secret="my-secret-token",
  prompt="Deployment event received:\n\n{{payload}}\n\nCheck status and escalate failures."
)
```

The endpoint `http://<host>:8080/api/webhook/deploy-hook` is live immediately. External services POST to this URL with the optional `X-Webhook-Secret` header.

### Manual Trigger

```
trigger_create(
  name="weekly-report",
  type="manual",
  session_mode="ephemeral",
  description="Generate weekly summary report",
  channel="internal",
  prompt="Generate a summary of this week's activity from memory and inbox."
)
```

Fired via the web-ui dashboard or programmatically.

## Signal Integration Setup

The Signal add-on requires a trigger plus a polling cron entry.

**Step 1: Create the trigger**

```
trigger_create(
  name="signal-chat",
  type="webhook",
  session_mode="persistent",
  channel="signal",
  prompt="New Signal message:\n\n{{payload}}"
)
```

**Step 2: Add polling to crontab**

Edit `/atlas/workspace/crontab` and add this line **above** the `# === AUTO-GENERATED TRIGGERS` marker:

```
* * * * *  signal poll --once 2>&1 >> /atlas/logs/signal.log
```

The poller checks for new Signal messages every minute. When a message arrives, it fires the trigger with the sender's number as the session key — so each contact gets their own persistent session.

**CLI tools available in trigger sessions:**

```bash
signal send +491701234567 "Hello!"
signal contacts
signal history +491701234567
```

## Email Integration Setup

The Email add-on follows the same pattern.

**Step 1: Create the trigger**

```
trigger_create(
  name="email-handler",
  type="webhook",
  session_mode="persistent",
  channel="email",
  prompt="New email:\n\n{{payload}}"
)
```

**Step 2: Add polling to crontab**

Edit `/atlas/workspace/crontab` and add **above** the marker:

```
*/2 * * * *  email poll --once 2>&1 >> /atlas/logs/email.log
```

Thread tracking uses `In-Reply-To`/`References` headers — replies in the same thread share one persistent session.

**CLI tools available in trigger sessions:**

```bash
email reply <thread_id> "Reply body"
email send recipient@example.com "Subject" "Body text"
email threads
email thread <thread_id>
```

## Crontab Structure

The crontab at `/atlas/workspace/crontab` has two sections:

- **Static** (above `# === AUTO-GENERATED TRIGGERS`): Manual entries like Signal/Email pollers
- **Dynamic** (below the marker): Auto-generated from enabled cron triggers

Never edit below the marker — those entries are managed by `sync-crontab.ts`. Poller entries and custom cron jobs go above it.

## Escalation Pattern

Trigger sessions act as first-line filters:

1. **Simple events**: Handle directly with CLI tools (`signal send`, `email reply`) or MCP actions
2. **Complex events**: Escalate to the main session via `inbox_write`

```
# Single task escalation
inbox_write(channel="task", sender="trigger:github-issues", content="Review critical issue #42")

# Multi-task escalation
inbox_write(channel="task", sender="trigger:deploy", content="Update CHANGELOG for v2.3.0")
inbox_write(channel="task", sender="trigger:deploy", content="Run post-deploy smoke tests")
```

The main session wakes automatically when new inbox messages arrive.

## Prompt Fallback

If a trigger's `prompt` field is empty, the system looks for:
```
workspace/triggers/cron/<trigger-name>/event-prompt.md
```

## Managing Triggers

```
# List all triggers
trigger_list()

# List only cron triggers
trigger_list(type="cron")

# Disable a trigger
trigger_update(name="github-issues", enabled=false)

# Change schedule
trigger_update(name="daily-report", schedule="0 8 * * *")

# Delete a trigger
trigger_delete(name="old-hook")
```
