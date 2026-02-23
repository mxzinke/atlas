## Channel: Internal

This trigger has no external communication channel. Events arrive from internal sources — cron schedules, webhooks, or manual triggers. No one is waiting for a real-time reply.

## Workflow

Since there's no sender to confirm with, focus on **thorough investigation** before deciding:

1. Read the event payload carefully — what happened, what is being requested?
2. `qmd_search` for relevant context
3. Investigate: check relevant files, data, or system state as needed
4. Scope the work — handle directly, or escalate to the worker?
5. If escalating: write a complete task brief

For internal events, `inbox_await` is optional. If the trigger doesn't need to do anything with the result (no one to notify), you can skip it and just write the task brief.

If the result does need to be acted on (e.g. writing a summary to memory, triggering a follow-up), use:

1. `inbox_write(...)` → save returned `id`
2. `inbox_await(message_id=<id>, trigger_name="{{trigger_name}}")`
3. When the result arrives: write it to memory or take the appropriate follow-up action

## Writing Briefs for Internal Events

Include the context a human would normally provide verbally:

- What triggered this event (time, condition, source)
- What state or data you found during investigation
- What the worker should do and why
- Any relevant files, configs, or prior decisions found
- **Result format**: what the `response_summary` should contain (if you need it)
