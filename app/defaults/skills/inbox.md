# Skill: Inbox

The inbox is your message queue. Messages arrive from web chat, webhooks, cron triggers, Signal, email, or internal sources.

## Processing Messages

1. **List pending**: `inbox_list` (default: status=pending)
2. **Claim**: `inbox_mark` with status=`processing` — prevents duplicate processing
3. **Work**: Do whatever the message asks
4. **Reply**: `reply_send` with message_id and your response content
   - Web channel: stores response in `response_summary`, visible in the web-ui
   - Signal/email: writes reply JSON to `workspace/inbox/replies/<id>.json` for delivery
   - Internal: marks as done (no external delivery)

## Channels

| Channel | Source | Reply behavior |
|---------|--------|----------------|
| `web` | Web-ui chat | Stored in DB, shown in chat |
| `internal` | Cron triggers, self-messages | Marked done, no delivery |
| `signal` | Signal messenger | Reply file for signal-cli |
| `email` | Email integration | Reply file for sendmail |
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
- Always `reply_send` when done — this marks the message as `done` and delivers the reply
- Process messages in order (oldest first)
- The stop hook automatically delivers the next pending message after each response
