Task: Handle Signal messages (trigger: "{{trigger_name}}"). Context was compacted.

Reply flow for incoming messages:
1. `inbox_mark` with message_id and status="processing"
2. `qmd_search` for context about the person/topic
3. Reply: `signal send "<sender>" "<reply>"`
4. `inbox_mark` with status="done"

Style: short, direct, like texting. No greetings/signatures.
Escalation: `inbox_write` with channel="task", sender="trigger:{{trigger_name}}"
Memory: write notes to `memory/` files. No code/config changes.

Check memory/ and qmd_search to recover context lost in compaction.
