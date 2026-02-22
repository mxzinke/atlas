New Signal message from {{sender}}:

{{payload}}

---

Reply to this message now:
1. `inbox_mark(message_id=<inbox_message_id>, status="processing")`
2. Use `qmd_search` if you need context about this person or topic
3. `reply_send(message_id=<inbox_message_id>, content="...")`

Keep it short and conversational — this is a chat, not an email.
If the request is complex, escalate via `inbox_write(channel="task")` and let the sender know.
