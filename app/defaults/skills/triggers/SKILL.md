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

Then create the prompt file at `~/triggers/daily-report/prompt.md`.

After creation, the crontab is synced automatically — supercronic picks it up. **Nothing else needed.**

### Webhook Trigger

```bash
trigger create \
  --name=deploy-hook \
  --type=webhook \
  --secret=my-secret-token \
  --description="Post-deploy notification"
```

Prompt file: `~/triggers/deploy-hook/prompt.md`
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
~/triggers/<name>/prompt.md
```

The `trigger create` command creates the directory automatically. Write the full trigger instruction in this file. If the `prompt` field in DB is empty (default after CLI create), this file is used automatically.

Example `~/triggers/daily-report/prompt.md`:
```
Check the inbox for any unread messages and summarize activity from the past 24 hours.
Escalate anything urgent to the main session via task_create.
```

## Adding Custom Background Services

Some integrations need a persistent background process instead of a cron job — for example, a messaging listener that reacts instantly rather than polling every minute.

Atlas supports this via `~/supervisor.d/`. Any `.conf` file placed there is picked up by supervisord. Services can be added or removed without rebuilding the container.

**Add a service** — create `~/supervisor.d/myservice.conf`:
```ini
[program:myservice]
command=/path/to/command --args
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/myservice.log
stderr_logfile=/atlas/logs/myservice-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
```

**Python processes** — avoid stdout buffering by wrapping in a shell script that sets `PYTHONUNBUFFERED=1` and uses `python3 -u`. Without this, Python buffers ~8KB before writing to disk; if the process restarts before the buffer flushes, all recent logs are silently lost. The built-in `email` and `signal` bin wrappers already handle this.

Then reload:
```bash
supervisorctl reread && supervisorctl update
```

Manage it normally after that:
```bash
supervisorctl start myservice
supervisorctl stop myservice
supervisorctl status myservice
```

---

## Signal Integration Setup

Signal uses `signal-cli` in **daemon mode** — a persistent process that pushes messages in real-time via a UNIX socket. This is lower-latency and more reliable than cron polling.

**Install signal-cli** (add to `workspace/user-extensions.sh` so it survives rebuilds):
```bash
SIGNAL_VERSION="0.13.10"  # check https://github.com/AsamK/signal-cli/releases for latest
ARCH=$(dpkg --print-architecture)
curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_VERSION}/signal-cli-${SIGNAL_VERSION}-Linux-${ARCH}.tar.gz" \
  | tar -xz -C /usr/local
ln -sf /usr/local/signal-cli-${SIGNAL_VERSION}/bin/signal-cli /usr/local/bin/signal-cli
```

**One-time registration** (run once manually inside the container, not in user-extensions.sh):
```bash
signal-cli -a +491701234567 register
# If a captcha is required:
#   1. Visit https://signalcaptchas.org/registration/generate and complete it
#   2. Copy the URL (format: signalcaptcha://<token>)
#   3. Re-run: signal-cli -a +491701234567 register --captcha <token>
signal-cli -a +491701234567 verify 123-456  # code from SMS
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

Write `~/triggers/signal-chat/prompt.md`:
```
<message from="{{sender}}">
{{payload}}
</message>

Please respond directly using `signal send "{{sender}}" "..."`.
```

**Step 3: Add supervisor services**

Create `~/supervisor.d/signal.conf` (replace number with your own):
```ini
[program:signal-daemon]
command=signal-cli -a +491701234567 daemon --socket /tmp/signal.sock
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/signal-daemon.log
stderr_logfile=/atlas/logs/signal-daemon-error.log

[program:signal-listen]
command=/atlas/app/bin/signal listen
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/signal-listen.log
stderr_logfile=/atlas/logs/signal-listen-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
```

Activate:
```bash
supervisorctl reread && supervisorctl update
```

The listener connects to the socket and calls `signal incoming` for each message, which stores it in the inbox and fires the trigger. Each sender gets their own persistent session automatically.

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
  password_file: "/home/atlas/secrets/email-password"
  folder: "INBOX"
  whitelist: []   # empty = accept all; or ["alice@example.com", "example.org"]
  mark_read: true
```

**Step 2: Store password**

```bash
echo "your-app-password" > /home/atlas/secrets/email-password
chmod 600 /home/atlas/secrets/email-password
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

Then write `~/triggers/email-handler/prompt.md`:
```
New email received:

{{payload}}

The payload contains inbox_message_id and thread_id.
Reply directly via CLI: email reply <thread_id> "message"
Escalate complex tasks via task_create.
```

**Step 4: Add polling**

Option A — supervisord (recommended):

Create `~/supervisor.d/email-poller.conf`:
```ini
[program:email-poller]
command=/atlas/app/bin/email poll
autostart=true
autorestart=true
stdout_logfile=/atlas/logs/email-poller.log
stderr_logfile=/atlas/logs/email-poller-error.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=1MB
stderr_logfile_backups=1
```

Then: `supervisorctl reread && supervisorctl update`

Option B — crontab:

Edit `~/crontab` and add **above** the marker:
```
*/2 * * * *  email poll --once
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

The crontab at `~/crontab` has two sections:

- **Static** (above `# === AUTO-GENERATED TRIGGERS`): Manual cron entries (e.g. email polling)
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
