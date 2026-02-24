---
name: triggers
description: How to create and manage triggers via the CLI. Covers cron, webhook, manual, Signal and Email integration.
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
- Payload replaces `{{payload}}` in the prompt file
- Optional authentication via `X-Webhook-Secret` header

### Manual
No schedule, no endpoint. Fired via the web-ui "Run" button or by request.

## Session Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `ephemeral` | New session per run | Cron jobs, one-off webhooks |
| `persistent` | Resume by session key | Signal contacts, email threads |

Persistent triggers maintain separate sessions per key (e.g., per contact, per thread). If no key is provided, a single default session is used per trigger.

## CLI Commands

| Command | Use |
|---------|-----|
| `trigger create ...` | Create trigger |
| `trigger update ...` | Update trigger fields |
| `trigger delete --name=foo` | Delete trigger |
| `trigger enable --name=foo` | Enable trigger |
| `trigger disable --name=foo` | Disable trigger |
| `trigger list` | List all triggers |

## Creating Triggers

### Cron Trigger

```bash
trigger create \
  --name=daily-report \
  --type=cron \
  --schedule="0 9 * * *" \
  --description="Daily morning report" \
  --channel=internal
```

Then create the prompt file at `workspace/triggers/daily-report/prompt.md`.

After creation, the crontab is synced automatically — supercronic picks it up. **Nothing else needed.**

### Webhook Trigger

```bash
trigger create \
  --name=deploy-hook \
  --type=webhook \
  --secret=my-secret-token \
  --description="Post-deploy notification"
```

Prompt file: `workspace/triggers/deploy-hook/prompt.md`
Use `{{payload}}` in prompt for the webhook body.

The endpoint `http://<host>:8080/api/webhook/deploy-hook` is live immediately. External services POST to this URL with the optional `X-Webhook-Secret` header.

### Manual Trigger

```bash
trigger create \
  --name=weekly-report \
  --type=manual \
  --description="Generate weekly summary"
```

Fired via the web-ui dashboard "Run" button.

## Prompt Files

Each trigger's prompt lives at:
```
workspace/triggers/<name>/prompt.md
```

The `trigger create` command creates the directory automatically. Write the full trigger instruction in this file. If the `prompt` field in DB is empty (default after CLI create), this file is used automatically.

Example `workspace/triggers/daily-report/prompt.md`:
```
Check the inbox for any unread messages and summarize activity from the past 24 hours.
Escalate anything urgent to the main session via task_create.
```

## Signal Integration Setup

**Prerequisites:** `signal-cli` installed and registered (add install to `workspace/user-extensions.sh`):
```bash
apt-get install -y signal-cli
```

One-time interactive registration (run manually inside the container):
```bash
signal-cli -a +491701234567 register
# If Signal requires a captcha, the above will fail with a captcha error.
# In that case:
#   1. Let human visit https://signalcaptchas.org/registration/generate and complete the captcha
#   2. Copy the captcha url (format: "signalcaptcha://<signal-recaptcha-token>")
#   3. Re-run: signal-cli -a +491701234567 register --captcha <signal-recaptcha-token>
signal-cli -a +491701234567 verify 123-456 # Code from SMS
```

**Step 1: Configure `workspace/config.yml`**

```yaml
signal:
  number: "+491701234567"
  whitelist: []   # empty = accept all contacts
```

**Step 2: Create the trigger**

```bash
trigger create \
  --name=signal-chat \
  --type=webhook \
  --session-mode=persistent \
  --channel=signal \
  --description="Signal messenger conversations"
```

Then write `workspace/triggers/signal-chat/prompt.md`:
```
New Signal message received:

{{payload}}

The payload contains inbox_message_id and sender (phone number).
Reply directly via CLI: signal send <number> "message"
Escalate complex tasks via task_create.
```

**Step 3: Add polling to crontab**

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

**Step 1: Configure `workspace/config.yml`**

```yaml
email:
  imap_host: "imap.gmail.com"
  imap_port: 993
  smtp_host: "smtp.gmail.com"
  smtp_port: 587
  username: "atlas@example.com"
  password_file: "/atlas/workspace/secrets/email-password"
  folder: "INBOX"
  whitelist: []   # empty = accept all; or ["alice@example.com", "example.org"]
  mark_read: true
```

**Step 2: Store password**

```bash
echo "your-app-password" > /atlas/workspace/secrets/email-password
chmod 600 /atlas/workspace/secrets/email-password
```

For Gmail: use an App Password, not your main password.

**Step 3: Create the trigger**

```bash
trigger create \
  --name=email-handler \
  --type=webhook \
  --session-mode=persistent \
  --channel=email \
  --description="Email conversations (IMAP)"
```

Then write `workspace/triggers/email-handler/prompt.md`:
```
New email received:

{{payload}}

The payload contains inbox_message_id and thread_id.
Reply directly via CLI: email reply <thread_id> "message"
Escalate complex tasks via task_create.
```

**Step 4: Add polling to crontab**

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
2. **Complex events**: Escalate to the main session via `task_create`

```
# Single task escalation
task_create(content="Review critical issue #42 from GitHub")

# Multi-task escalation
task_create(content="Update CHANGELOG for v2.3.0")
task_create(content="Run post-deploy smoke tests")
```

The main session wakes automatically when new tasks arrive.

## Managing Triggers

```bash
# List all triggers
trigger list

# List only cron triggers
trigger list --type=cron

# Disable a trigger
trigger disable --name=github-issues

# Enable a trigger
trigger enable --name=github-issues

# Change schedule
trigger update --name=daily-report --schedule="0 8 * * *"

# Delete a trigger
trigger delete --name=old-hook
```
