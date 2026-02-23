---
name: inbox
description: How to process inbox messages — list, claim, work, reply. Use when handling pending messages or sending replies.
---

# Inbox

The inbox is your message queue. Messages arrive from web chat, webhooks, cron triggers, Signal, email, or internal sources.

## Processing Messages

1. **List pending**: `inbox_list` (default: status=pending)
2. **Claim**: `inbox_mark` with status=`processing` — prevents duplicate processing
3. **Work**: Do whatever the message asks
4. **Reply via CLI** (external channels):
   - Signal: `signal send "<identifier>" "<message>"` (identifier = UUID, phone, or group ID)
   - Email: `email reply "<thread_id>" "<body>"`
   - Web/internal: `inbox_mark` with status=`done` and response_summary
5. **Mark done**: `inbox_mark` with status=`done` and response_summary

## Channels

| Channel | Source | Reply behavior |
|---------|--------|----------------|
| `web` | Web-ui chat | Stored in DB, shown in chat |
| `internal` | Cron triggers, self-messages | Marked done, no delivery |
| `signal` | Signal messenger | CLI: `signal send` |
| `email` | Email integration | CLI: `email reply` |
| `webhook` | External webhook POST | Marked done |

## Writing Messages

Use `inbox_write` to create messages for yourself (reminders, follow-ups):
- channel: `internal`
- content: what you need to do
- This touches `.wake`, so you'll be woken to process it

## Stats

`inbox_stats` returns counts by status and channel.

## Important

- Always mark messages as `processing` before working on them
- Reply via CLI tools for external channels, then `inbox_mark` with status=`done`
- Process messages in order (oldest first)
- The stop hook automatically delivers the next pending message after each response
