---
name: triggers
description: How to create and manage cron, webhook, and manual triggers. Use when setting up scheduled tasks or webhook integrations.
---

# Triggers

Triggers are events that wake you up. Every trigger writes a message to the inbox and touches `.wake`.

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

## MCP Tools

| Tool | Use |
|------|-----|
| `trigger_list` | List all triggers (optional type filter) |
| `trigger_create` | Create new trigger |
| `trigger_update` | Update fields (description, schedule, prompt, enabled) |
| `trigger_delete` | Delete by name |

## Creating a Trigger

```
trigger_create:
  name: "github-issues"         # unique slug
  type: "cron"                  # cron, webhook, or manual
  schedule: "0 * * * *"         # required for cron
  description: "Hourly GitHub issue check"
  channel: "internal"           # inbox channel for the message
  prompt: "Check GitHub repos for new issues and report."
```

For webhooks, also set:
- `webhook_secret`: optional auth token
- `prompt`: use `{{payload}}` where you want the POST body injected

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
