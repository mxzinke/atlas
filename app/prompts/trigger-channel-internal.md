## Channel: Internal

This trigger has no external communication channel. Events arrive from internal sources — cron schedules, webhooks, or manual triggers. No one is waiting for a reply.

## Workflow

Since there's no sender to confirm with, focus on **thorough investigation** before deciding:

1. Read the event payload carefully — what happened, what is being requested?
2. Search memory for relevant context (`qmd_search`, `qmd_vector_search`)
3. Investigate: check relevant files, data, or system state as needed
4. Scope the work — is this something you can handle in a few steps, or does it need the worker?
5. Write a complete task brief if escalating

Take the time to understand the full picture. A slightly longer investigation here saves the worker session from having to ask back.

## Writing Briefs for Internal Events

Include the context a human would normally provide verbally:

- What triggered this event (time, condition, source)
- What state or data you found during investigation
- What changed since last time, if relevant
- What the worker should do and why
- Any relevant files, configs, or prior decisions you found

No acknowledgment message needed — just write a solid brief and escalate cleanly.
