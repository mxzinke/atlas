# Integrations

Atlas supports Signal and Email as communication channels. Each integration uses the trigger system: incoming messages spawn a trigger session (persistent, keyed per contact/thread) that can reply directly or escalate to the main session.

## Architecture

```
External Channel          Atlas
═══════════════           ═════

Signal message ──▸ signal-receiver.sh ──▸ trigger.sh signal-chat <payload> <sender>
                                                │
                                          Trigger session
                                          (persistent, per sender)
                                                │
                                    ┌───────────┴───────────┐
                                    │                       │
                               reply_send              inbox_write
                                    │                  (escalate)
                                    ▼                       │
                            replies/N.json                  ▼
                                    │               Main session
                         reply-delivery.sh          (read/write)
                                    │
                                    ▼
                            signal-cli send


Email (IMAP) ──▸ email-poller.py ──▸ trigger.sh email-handler <payload> <thread-id>
                                                │
                                          Trigger session
                                          (persistent, per thread)
                                                │
                                    ┌───────────┴───────────┐
                                    │                       │
                               reply_send              inbox_write
                                    │                  (escalate)
                                    ▼                       │
                            replies/N.json                  ▼
                                    │               Main session
                         reply-delivery.sh          (read/write)
                                    │
                                    ▼
                             SMTP sendmail
```

## Signal

### Prerequisites

```bash
# In workspace/user-extensions.sh:
apt-get install -y signal-cli

# Register your number (one-time, interactive):
signal-cli -a +491701234567 register
signal-cli -a +491701234567 verify 123-456
```

### Setup

**1. Configure** `workspace/config.yml`:

```yaml
signal:
  number: "+491701234567"
  whitelist: ["+491709876543", "+491701111111"]   # empty = accept all
```

**2. Create trigger** (ask Claude or via web-ui):

```
trigger_create:
  name: "signal-chat"
  type: "webhook"
  session_mode: "persistent"
  channel: "signal"
  description: "Signal messenger conversations"
  prompt: |
    New Signal message received:

    {{payload}}

    You are chatting with this person via Signal. Respond conversationally.
    If they ask for something complex (code changes, research, long tasks),
    escalate to main session via inbox_write and let them know you'll get back to them.
```

**3. Start receiver** (add to supervisord or crontab):

```bash
# Continuous mode (supervisord):
/atlas/app/integrations/signal-receiver.sh

# Cron mode (every minute):
* * * * *  /atlas/app/integrations/signal-receiver.sh --once
```

**4. Start reply delivery**:

```bash
/atlas/app/integrations/reply-delivery.sh
```

### How It Works

1. `signal-receiver.sh` polls `signal-cli receive --json` for new messages
2. Each message fires `trigger.sh signal-chat '<json>' '<sender-number>'`
3. Session key = sender phone number → persistent session per contact
4. Trigger session responds via `reply_send` → writes to `replies/N.json`
5. `reply-delivery.sh` picks up the JSON and sends via `signal-cli send`

### Whitelist

If `signal.whitelist` is set, only listed numbers can reach Atlas. Others are silently dropped. Empty list = accept all.

## Email

### Prerequisites

Python3 with `imaplib` (built-in) and `pyyaml`.

### Setup

**1. Configure** `workspace/config.yml`:

```yaml
email:
  imap_host: "imap.gmail.com"
  imap_port: 993
  smtp_host: "smtp.gmail.com"
  smtp_port: 587
  username: "atlas@example.com"
  password_file: "/atlas/workspace/secrets/email-password"
  folder: "INBOX"
  whitelist: ["alice@example.com", "example.org"]   # or empty
  mark_read: true
```

**2. Store password**:

```bash
echo "your-app-password" > /atlas/workspace/secrets/email-password
chmod 600 /atlas/workspace/secrets/email-password
```

For Gmail: use an [App Password](https://myaccount.google.com/apppasswords), not your main password.

**3. Create trigger**:

```
trigger_create:
  name: "email-handler"
  type: "webhook"
  session_mode: "persistent"
  channel: "email"
  description: "Email conversations (IMAP)"
  prompt: |
    New email received:

    {{payload}}

    You are responding to an email thread. Be professional and concise.
    If the email asks for complex work (code changes, deployments, research),
    escalate to main session via inbox_write. Reply with a brief acknowledgment
    and let them know it's being handled.
```

**4. Start poller** (cron or continuous):

```bash
# Cron mode (every 2 minutes):
*/2 * * * *  /atlas/app/integrations/email-receiver.sh --once

# Continuous mode (supervisord):
/atlas/app/integrations/email-receiver.sh
```

**5. Start reply delivery**:

```bash
/atlas/app/integrations/reply-delivery.sh
```

### Thread Tracking

Emails are threaded by `In-Reply-To` / `References` / `Message-ID` headers:

- Reply to an existing thread → same session key → resumes conversation
- New email without references → new session key → new conversation

The session key is a sanitized version of the thread's root Message-ID. This means the trigger session has full conversational context across all replies in a thread.

### Whitelist

`email.whitelist` accepts full addresses (`alice@example.com`) or domains (`example.org`). Empty = accept all.

## Reply Delivery

Both Signal and Email use the same reply delivery mechanism:

1. Trigger session calls `reply_send(message_id, content)`
2. inbox-mcp writes `workspace/inbox/replies/<message_id>.json`:
   ```json
   {
     "channel": "signal",
     "reply_to": "+491701234567",
     "content": "Here's what I found...",
     "timestamp": "2026-02-22T10:30:00Z"
   }
   ```
3. `reply-delivery.sh` picks up the file and routes by channel:
   - `signal` → `signal-cli send`
   - `email` → SMTP
4. Delivered files are moved to `replies/archive/`

Start the delivery daemon:

```bash
# Continuous (recommended):
/atlas/app/integrations/reply-delivery.sh

# Or via cron (every 30 seconds is not possible, use continuous):
* * * * *  /atlas/app/integrations/reply-delivery.sh --once
```

## Quick Reference

### Enable Signal in 4 Steps

```bash
# 1. Install signal-cli
echo 'apt-get install -y signal-cli' >> /atlas/workspace/user-extensions.sh

# 2. Configure number + whitelist
# Edit workspace/config.yml → signal section

# 3. Create trigger (ask Claude):
# "Create a persistent Signal chat trigger"

# 4. Start services (add to supervisord):
# /atlas/app/integrations/signal-receiver.sh
# /atlas/app/integrations/reply-delivery.sh
```

### Enable Email in 4 Steps

```bash
# 1. Configure IMAP/SMTP
# Edit workspace/config.yml → email section

# 2. Store password
echo "app-password" > /atlas/workspace/secrets/email-password

# 3. Create trigger (ask Claude):
# "Create a persistent email handler trigger"

# 4. Start services (add to crontab or supervisord):
# /atlas/app/integrations/email-receiver.sh
# /atlas/app/integrations/reply-delivery.sh
```
