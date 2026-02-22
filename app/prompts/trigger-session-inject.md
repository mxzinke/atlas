New event received:

{{payload}}

---

Process this event:
1. If it contains `inbox_message_id`: `inbox_mark(message_id=..., status="processing")` → process → `reply_send`
2. If simple: handle directly
3. If complex: escalate via `inbox_write(channel="task", sender="trigger:{{trigger_name}}")`
