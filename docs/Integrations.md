# Integrations

Atlas supports Signal and Email as communication channels. Each integration writes incoming messages to the inbox, then spawns a trigger session (persistent, keyed per contact/thread) that can reply directly or escalate to the main session.

## Architecture

```
External Channel          Atlas
═══════════════           ═════

Signal message ──▸ signal-addon.py incoming <sender> <message>
                    │                     (or: signal-addon.py poll)
                    ├─▸ UPDATE signal.db contacts + messages
                    ├─▸ INSERT INTO atlas inbox (channel=signal, reply_to=sender)
                    │
                    └─▸ trigger.sh signal-chat <payload> <sender>
                          │
                          ├─▸ IPC socket alive? → inject directly into running session
                          │
                          └─▸ No socket? → spawn new claude -p session
                                                │
                                          Trigger session
                                          (persistent, per sender)
                                                │
                                    ┌───────────┴───────────┐
                                    │                       │
                          signal-addon.py send          inbox_write
                          (direct CLI call)             (escalate)
                                    │                       │
                                    ▼                       ▼
                            signal-cli send         Main session


Email (IMAP) ──▸ email-addon.py poll
                    │
                    ├─▸ UPDATE email.db threads + emails
                    ├─▸ INSERT INTO atlas inbox (channel=email, reply_to=thread_id)
                    │
                    └─▸ trigger.sh email-handler <payload> <thread_id>
                          │
                          ├─▸ IPC socket alive? → inject into running session
                          │
                          └─▸ No socket? → spawn new session
                                                │
                                          Trigger session
                                          (persistent, per thread)
                                                │
                                    ┌───────────┴───────────┐
                                    │                       │
                          email-addon.py reply           inbox_write
                          (direct CLI call)              (escalate)
                                    │                       │
                                    ▼                       ▼
                            SMTP with threading     Main session
                            headers
```

## IPC Socket Injection

When a message arrives while a trigger session is already running for the same contact/thread, `trigger.sh` injects it directly into the running session via Claude Code's IPC socket:

```
Session running (claude -p --resume <id>)
  → IPC socket exists at /tmp/claudec-<session_id>.sock
  → trigger.sh sends: {"action":"send","text":"<message>","submit":true}
  → Message is queued in the session, processed after current turn
  → No new process, no restart
```

If the socket doesn't exist (session not running), `trigger.sh` spawns a new `claude -p` process as usual.

This works identically for Signal (per contact), Email (per thread), and any future integration.

## Signal Add-on

The Signal Add-on (`app/integrations/signal/signal-addon.py`) handles all Signal operations: polling signal-cli, injecting messages, sending, replying, and contact tracking. One SQLite database per phone number.

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

    The payload contains inbox_message_id and sender. Use inbox_mark to claim it,
    then reply via CLI: signal-addon.py send. Escalate complex tasks via inbox_write.
```

**3. Start polling** (add to supervisord or crontab):

```bash
# Continuous (supervisord):
python3 /atlas/app/integrations/signal/signal-addon.py poll

# Cron (every minute):
* * * * *  python3 /atlas/app/integrations/signal/signal-addon.py poll --once
```

### CLI Usage

```bash
# Poll signal-cli for new messages
signal-addon.py poll --once
signal-addon.py poll                               # continuous

# Inject a message directly (e.g., from external webhook)
signal-addon.py incoming +491701234567 "Hello!" --name "Alice"

# Send a message
signal-addon.py send +491701234567 "Hi!"

# List known contacts
signal-addon.py contacts

# Show conversation history
signal-addon.py history +491701234567
```

### Signal Database

Each configured number gets its own SQLite database at `workspace/inbox/signal/<number>.db` with WAL mode:

| Table | Purpose |
|-------|---------|
| `contacts` | Known contacts: number, name, message_count, first/last_seen |
| `messages` | All messages (in + out): body, timestamp, contact association |

### Whitelist

If `signal.whitelist` is set, only listed numbers can reach Atlas. Others are silently dropped. Empty list = accept all.

## Email Add-on

The Email Add-on (`app/integrations/email/email-addon.py`) handles all email operations: IMAP polling, SMTP sending/replying, and thread tracking. One SQLite database per account.

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

    The payload contains inbox_message_id and thread_id. Use inbox_mark to claim it,
    then reply via CLI: email-addon.py reply. Escalate complex tasks via inbox_write.
```

**4. Start polling**:

```bash
# Continuous (supervisord):
python3 /atlas/app/integrations/email/email-addon.py poll

# Cron (every 2 minutes):
*/2 * * * *  python3 /atlas/app/integrations/email/email-addon.py poll --once
```

### CLI Usage

```bash
# Poll IMAP for new emails
email-addon.py poll --once
email-addon.py poll              # continuous mode

# Send a new email
email-addon.py send alice@example.com "Subject line" "Body text"

# Reply to an existing thread (uses proper In-Reply-To + References headers)
email-addon.py reply <thread_id> "Reply body"

# List tracked threads
email-addon.py threads

# Show thread detail (participants, message history)
email-addon.py thread <thread_id>
```

### Email Database

Each configured account gets its own SQLite database at `workspace/inbox/email/<username>.db` with WAL mode:

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

### Whitelist

`email.whitelist` accepts full addresses (`alice@example.com`) or domains (`example.org`). Empty = accept all.

## Reply Flow

Trigger sessions reply directly via CLI tools — no intermediate delivery layer:

- **Signal**: `python3 /atlas/app/integrations/signal/signal-addon.py send "<number>" "<message>"`
  - Sends via signal-cli, tracks in signal.db
- **Email**: `python3 /atlas/app/integrations/email/email-addon.py reply "<thread_id>" "<body>"`
  - Sends via SMTP with proper threading headers, tracks in email.db
- **Web/Internal**: `inbox_mark` with status=`done` and response_summary

After replying, trigger sessions mark the inbox message as done via `inbox_mark`.

## Quick Reference

### Enable Signal in 2 Steps

```bash
# 1. Install signal-cli + configure workspace/config.yml (signal section)
# 2. Create trigger: "Create a persistent Signal chat trigger" + start polling
```

### Enable Email in 2 Steps

```bash
# 1. Configure workspace/config.yml (email section) + store password
# 2. Create trigger: "Create a persistent email handler trigger" + start polling
```

### Direct Usage

```bash
# Signal
python3 /atlas/app/integrations/signal/signal-addon.py incoming +49170123 "Hello!"
python3 /atlas/app/integrations/signal/signal-addon.py send +49170123 "Hi!"
python3 /atlas/app/integrations/signal/signal-addon.py contacts

# Email
python3 /atlas/app/integrations/email/email-addon.py send alice@x.com "Subject" "Body"
python3 /atlas/app/integrations/email/email-addon.py reply <thread_id> "Reply body"
python3 /atlas/app/integrations/email/email-addon.py threads
```
