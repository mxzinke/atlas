# Triggers

Triggers are the event system that wakes Atlas. Every trigger, regardless of type, follows the same pattern: write a message to the inbox, touch the `.wake` file, and Claude processes it.

## Trigger Types

### Cron

Scheduled execution via supercronic. The schedule uses standard cron syntax.

**Examples:**
| Schedule | Meaning |
|----------|---------|
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * 1-5` | Weekdays at 9:00 |
| `0 6 * * *` | Daily at 6:00 |
| `0 8 * * 1` | Mondays at 8:00 |

When a cron trigger fires, `trigger.sh` reads the prompt from the database, writes it as a message to the inbox, and touches `.wake` to resume Claude.

The crontab at `workspace/crontab` is auto-generated from the triggers database. Static entries (like the daily cleanup) are preserved above the `AUTO-GENERATED` marker. You don't need to edit the crontab manually — manage cron triggers via the web-ui or MCP tools.

### Webhook

HTTP endpoints that accept POST requests from external services. Each webhook trigger gets a URL:

```
POST /api/webhook/<trigger-name>
```

The request payload is injected into the prompt template via the `{{payload}}` placeholder. Webhooks support optional authentication via the `X-Webhook-Secret` header.

### Manual

On-demand triggers with no automatic schedule. Fire them via the "Run" button in the web-ui or by asking Claude to run them.

## Creating Triggers

### Via Web-UI

1. Navigate to `/triggers`
2. Click **+ New Trigger**
3. Fill in the form:
   - **Name:** Lowercase slug (e.g. `github-check`)
   - **Type:** Cron, Webhook, or Manual
   - **Schedule:** Cron expression (for cron triggers)
   - **Webhook Secret:** Optional auth token (for webhooks)
   - **Channel:** Inbox channel for generated messages (default: `internal`)
   - **Prompt:** What Claude should do when triggered. Use `{{payload}}` for webhook data.
4. Click **Create Trigger**

### Via MCP (Claude creates it)

Ask Claude in natural language:

```
"Set up an hourly check of my GitHub repos for new issues"
```

Claude will use the `trigger_create` MCP tool:
```json
{
  "name": "github-issues",
  "type": "cron",
  "schedule": "0 * * * *",
  "description": "Hourly GitHub issue check",
  "prompt": "Check the GitHub repos for new issues. Report any updates and suggest actions."
}
```

### Via curl

Create via the web-ui form endpoint:
```bash
curl -X POST http://localhost:8080/triggers \
  -d "name=my-trigger" \
  -d "type=manual" \
  -d "description=Test trigger" \
  -d "prompt=Hello, this is a test trigger."
```

## Webhook Integration

### Setup

1. Create a webhook trigger (via web-ui or MCP):
   - Name: `github-push`
   - Type: Webhook
   - Secret: `my-secret-token` (optional)
   - Prompt: `A push event was received:\n\n{{payload}}\n\nSummarize the changes.`

2. Configure the external service to POST to your Atlas instance:
   ```
   URL:    https://your-atlas-host:8080/api/webhook/github-push
   Secret: my-secret-token  (as X-Webhook-Secret header)
   ```

### Request Format

Webhooks accept any content type:

**JSON:**
```bash
curl -X POST http://localhost:8080/api/webhook/github-push \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"ref": "refs/heads/main", "commits": [{"message": "fix: resolve login bug"}]}'
```

**Form data:**
```bash
curl -X POST http://localhost:8080/api/webhook/contact-form \
  -H "X-Webhook-Secret: my-secret-token" \
  -d "name=Alice&email=alice@example.com&message=Hello"
```

**Plain text:**
```bash
curl -X POST http://localhost:8080/api/webhook/alert \
  -H "X-Webhook-Secret: my-secret-token" \
  -d "Server CPU at 95%"
```

### Response

Success:
```json
{ "ok": true, "trigger": "github-push", "message": "Webhook received, Claude will process it" }
```

Error:
```json
{ "error": "Invalid secret" }     // 401
{ "error": "Webhook disabled" }   // 403
{ "error": "Webhook not found" }  // 404
```

### Authentication

If `webhook_secret` is set, the webhook validates the `X-Webhook-Secret` header (or `?secret=` query parameter) against the stored secret. Requests without a matching secret are rejected with 401.

If no secret is configured, the webhook accepts all requests. Use this for trusted internal networks or services that don't support custom headers.

### Payload in Prompts

The `{{payload}}` placeholder in the prompt template is replaced with the request body:

| Content-Type | Payload Format |
|-------------|----------------|
| `application/json` | Pretty-printed JSON |
| `application/x-www-form-urlencoded` | JSON of parsed form fields |
| Anything else | Raw text body |

**Example prompt template:**
```
A deployment notification was received:

{{payload}}

Check if the deployment was successful. If it failed, investigate the logs.
```

## Integration Examples

### GitHub Webhooks

```
Name:     github-push
Type:     Webhook
Secret:   (generate one)
Prompt:   New push to repository:

          {{payload}}

          Review the commit messages. If there are any issues worth noting, summarize them.
```

In GitHub: Settings > Webhooks > Add webhook, set the Payload URL and Secret.

### Slack Slash Commands

```
Name:     slack-command
Type:     Webhook
Channel:  web
Prompt:   Slack command received:

          {{payload}}

          Parse the command and respond appropriately.
```

In Slack: Create a Slash Command, set the Request URL to your webhook endpoint.

### Daily Standup Reminder

```
Name:     standup-reminder
Type:     Cron
Schedule: 0 9 * * 1-5
Prompt:   It's 9 AM on a weekday. Prepare a standup summary:
          - What was accomplished yesterday (check journal)
          - What's planned for today (check inbox and pending tasks)
          - Any blockers or concerns
```

### Health Check

```
Name:     health-check
Type:     Cron
Schedule: */30 * * * *
Prompt:   Run a system health check:
          - Check disk space with df -h
          - Check memory with free -m
          - Verify all services are running
          Report only if something needs attention.
```

### Monitoring Alert

```
Name:     uptime-alert
Type:     Webhook
Prompt:   An uptime monitoring alert was received:

          {{payload}}

          Investigate the issue. Check if the service is still down.
          If critical, write a summary to MEMORY.md.
```

## Managing Triggers

### Web-UI

The `/triggers` page provides full CRUD:
- **List** all triggers with type, status, schedule/URL, last run, run count
- **Toggle** enable/disable (HTMX live update)
- **Run** any trigger manually (even cron triggers)
- **Edit** description, schedule, prompt, secret, channel
- **Delete** with confirmation

### MCP Tools

| Tool | Description |
|------|-------------|
| `trigger_list` | List all triggers (optional filter by type) |
| `trigger_create` | Create with name, type, schedule, prompt, secret |
| `trigger_update` | Update fields by name |
| `trigger_delete` | Delete by name |

### Prompt Fallback

If a trigger's `prompt` field is empty, `trigger.sh` looks for a prompt file at:
```
workspace/triggers/cron/<trigger-name>/event-prompt.md
```

This allows storing long or complex prompts as files instead of database fields.

## Crontab Sync

When cron triggers are created, updated, or deleted, the crontab is automatically regenerated:

1. Static entries (above `AUTO-GENERATED` marker) are preserved
2. All enabled cron triggers from the database are appended
3. supercronic detects the file change and reloads

The sync runs:
- After any trigger create/update/delete (via MCP or web-ui)
- During container init (Phase 9)

You can also run it manually:
```bash
bun run /atlas/app/triggers/sync-crontab.ts
```

## How It All Connects

```
                           ┌─────────────┐
                           │  supercronic │
                           │  (crontab)   │
                           └──────┬──────┘
                                  │ schedule fires
                                  ▼
┌───────────┐         ┌──────────────────┐         ┌──────────────┐
│ External   │  POST   │    Web-UI        │  button  │  Claude      │
│ Service    │────────▸│  /api/webhook/   │◂────────│  MCP: inbox_ │
└───────────┘         │  /triggers/:id/  │         │  write       │
                      │  run             │         └──────────────┘
                      └────────┬─────────┘
                               │
                               ▼
                    ┌────────────────────┐
                    │ INSERT INTO inbox  │
                    │ touch .wake        │
                    └────────┬───────────┘
                             │
                             ▼
                    ┌────────────────────┐
                    │ watcher.sh         │
                    │ inotifywait        │
                    └────────┬───────────┘
                             │
                             ▼
                    ┌────────────────────┐
                    │ Claude Code        │
                    │ resumes session    │
                    │ processes message  │
                    └────────────────────┘
```
