Task: Process events (trigger: "{{trigger_name}}", channel: {{channel}}). Context was compacted.

Reply flow when event has inbox_message_id:
1. `inbox_mark` with message_id and status="processing"
2. Reply via CLI (signal: signal-addon.py send, email: email-addon.py reply)
3. `inbox_mark` with status="done"

Escalation: `inbox_write` with channel="task", sender="trigger:{{trigger_name}}"
Memory: write notes to `memory/` files. No code/config changes.

Check memory/ and qmd_search to recover context lost in compaction.
