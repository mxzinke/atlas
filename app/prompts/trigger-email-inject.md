New email received:

{{payload}}

---

Reply to this email now:
1. `inbox_mark(message_id=<inbox_message_id>, status="processing")`
2. Use `qmd_search` if you need context about this person or topic
3. `reply_send(message_id=<inbox_message_id>, content="...")`

Write a professional reply — greeting, clear body, sign-off. Plain text, no HTML.
If the request is complex, escalate via `inbox_write(channel="task")` and send an acknowledgment reply.
