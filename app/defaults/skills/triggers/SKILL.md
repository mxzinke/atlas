---
name: triggers
description: How to create and manage cron, webhook, and manual triggers. Use when setting up scheduled tasks or webhook integrations.
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
| `persistent` | Resume by session key | Signal channels, email threads |

Persistent triggers use a **session key** to track which session to resume:
- `trigger.sh signal-chat '{"msg":"Hi"}' '+49170123456'` → resumes session for that contact
- `trigger.sh email-handler '{"body":"..."}' 'thread-4821'` → resumes session for that thread
- No key provided → defaults to `_default` (one session per trigger)

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
  name: "github-issues"         # unique slug
  type: "cron"                  # cron, webhook, or manual
  schedule: "0 * * * *"         # required for cron
  session_mode: "ephemeral"     # ephemeral or persistent
  description: "Hourly GitHub issue check"
  channel: "internal"           # inbox channel for the message
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

## Prompt Fallback

If a trigger's `prompt` field is empty, the system looks for:
```
workspace/triggers/cron/<trigger-name>/event-prompt.md
```
Use this for long or complex prompts that don't fit in a database field.

## Crontab Sync

Cron triggers are automatically synced to `workspace/crontab`. The crontab has two sections:
- **Static** (above `# AUTO-GENERATED`): manual entries, don't touch
- **Dynamic** (below): auto-generated from enabled cron triggers

No manual crontab editing needed — just use the MCP tools.
