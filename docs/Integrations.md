# Integrations

Atlas supports Signal and Email as communication channels. Each integration writes incoming messages to the inbox, then spawns a trigger session (persistent, keyed per contact/thread) that can reply directly or escalate to the main session.

## Architecture

```
External Channel          Atlas
═══════════════           ═════

Signal message ──▸ signal-receiver.sh
                    │
                    ├─▸ INSERT INTO inbox (channel=signal, reply_to=sender)
                    │
                    └─▸ trigger.sh signal-chat <payload+inbox_msg_id> <sender>
                                          │
                                    Trigger session
                                    (persistent, per sender)
                                          │
                              ┌───────────┴───────────┐
                              │                       │
                    reply_send(inbox_msg_id)      inbox_write
                              │                  (escalate)
                              ▼                       │
                      replies/N.json                  ▼
                              │               Main session
                   reply-delivery.sh
                              │
                              ▼
                      signal-cli send


Email (IMAP) ──▸ email-addon.py poll
                    │
                    ├─▸ UPDATE email.db threads + emails tables
                    ├─▸ INSERT INTO atlas inbox (channel=email, reply_to=thread_id)
                    │
                    └─▸ trigger.sh email-handler <payload+inbox_msg_id> <thread_id>
                         (non-blocking, parallel per thread)
                                          │
                                    Trigger session
                                    (persistent, per thread)
                                          │
                              ┌───────────┴───────────┐
                              │                       │
                    reply_send(inbox_msg_id)      inbox_write
                              │                  (escalate)
                              ▼                       │
                      replies/N.json                  ▼
                              │               Main session
                   reply-delivery.sh
                      └─▸ email-addon.py deliver → SMTP with threading headers
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

    The payload contains inbox_message_id. Use inbox_mark to claim it,
    then reply_send to respond. Escalate complex tasks via inbox_write.
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

1. `signal-receiver.sh` polls `signal-cli receive --json`
2. Each message is written to the inbox (channel=signal, reply_to=sender number)
3. `trigger.sh signal-chat '<payload>' '<sender>'` fires with `inbox_message_id` in payload
4. Trigger session calls `inbox_mark(inbox_message_id, "processing")` then `reply_send(inbox_message_id, "response")`
5. `reply_send` writes `replies/N.json` with `reply_to=<sender number>`
6. `reply-delivery.sh` sends via `signal-cli send -m <content> <sender>`

### Whitelist

If `signal.whitelist` is set, only listed numbers can reach Atlas. Others are silently dropped. Empty list = accept all.

## Email Add-on

The Email Communication Add-on (`app/integrations/email/email-addon.py`) is a unified module for all email operations. It has its own SQLite database per account for thread tracking and email history.

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

    The payload contains inbox_message_id. Use inbox_mark to claim it,
    then reply_send to respond. Escalate complex tasks via inbox_write.
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

### CLI Usage

The add-on provides a unified CLI for all email operations:

```bash
# Poll IMAP for new emails (fires triggers non-blocking)
email-addon.py poll --once
email-addon.py poll              # continuous mode

# Send a new email
email-addon.py send alice@example.com "Subject line" "Body text"

# Reply to an existing thread (uses proper In-Reply-To + References headers)
email-addon.py reply <thread_id> "Reply body"

# List tracked threads
email-addon.py threads
email-addon.py threads --limit 50

# Show thread detail (participants, message history)
email-addon.py thread <thread_id>
```

### Email Database

Each configured account gets its own SQLite database at `workspace/inbox/email/<username>.db` with WAL mode for concurrent access:

| Table | Purpose |
|-------|---------|
| `threads` | Thread state: subject, last_message_id, references_chain, participants, message_count |
| `emails` | All emails (in + out): sender, recipient, subject, body, thread association |
| `state` | Key-value state (e.g., `last_uid` for IMAP polling position) |

Legacy JSON thread files (`email-threads/*.json`) and UID state are automatically migrated on first run.

### Email Thread Tracking

Thread state is tracked in the `threads` table:

```
thread_id        | subject        | last_message_id  | references_chain           | last_sender
abc123_mail.com  | Project Update | <789@mail.com>   | ["<abc@>","<def@>","<789@>"] | alice@example.com
```

**Incoming**: `poll` updates the thread and stores each email in the `emails` table.

**Outgoing**: `reply` reads the thread to construct proper headers:
- `In-Reply-To`: the `last_message_id` (what we're replying to)
- `References`: the accumulated chain (preserves thread in all mail clients)
- `Subject`: `Re: <original subject>`
- `To`: `last_sender` (the person who sent the most recent message)

After sending, `reply` appends its own `Message-ID` to the references chain so subsequent replies stay threaded.

**Thread ID derivation** from email headers:

| Header Present | Thread ID Source |
|----------------|-----------------|
| `References` | First entry (thread root Message-ID) |
| `In-Reply-To` only | That Message-ID |
| Neither | Own `Message-ID` (new thread) |

This means all emails in a thread share the same session key → same persistent trigger session → full conversational context.

### Concurrency

When multiple emails from different threads arrive in the same poll cycle:
1. All emails are fetched and stored sequentially (fast — DB writes only)
2. Triggers are fired **non-blocking** via `Popen` (no `subprocess.run` waiting)
3. Each trigger runs in its own process with its own persistent session per thread
4. SQLite WAL mode + `busy_timeout` prevents locking issues

### Whitelist

`email.whitelist` accepts full addresses (`alice@example.com`) or domains (`example.org`). Empty = accept all.

## Reply Delivery

Both Signal and Email use the same delivery mechanism:

1. Trigger session calls `reply_send(inbox_message_id, content)`
2. inbox-mcp writes `workspace/inbox/replies/<message_id>.json`:
   ```json
   {
     "channel": "email",
     "reply_to": "abc123_mail.com",
     "content": "Here's what I found...",
     "timestamp": "2026-02-22T10:30:00Z"
   }
   ```
3. `reply-delivery.sh` picks up the file and routes by channel:
   - `signal` → `signal-cli send -m <content> <reply_to>`
   - `email` → `email-addon.py deliver` sends SMTP with proper threading headers
4. Delivered files are moved to `replies/archive/`

Start the delivery daemon:

```bash
# Continuous (recommended):
/atlas/app/integrations/reply-delivery.sh
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

### Send an Email Directly

```bash
# Send a new email (SMTP must be configured):
python3 /atlas/app/integrations/email/email-addon.py send recipient@example.com "Subject" "Body"

# Reply to a thread:
python3 /atlas/app/integrations/email/email-addon.py reply <thread_id> "Reply body"

# List threads:
python3 /atlas/app/integrations/email/email-addon.py threads
```
