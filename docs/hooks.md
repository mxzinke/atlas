# Lifecycle Hooks

Claude Code hooks inject context at lifecycle events. Hooks are shell scripts that output text — the output becomes part of Claude's context.

## session-start.sh

Runs when Claude wakes up. Loads memory context and inbox status.

### Behavior

Outputs XML-wrapped sections:

1. **Long-term memory** — Full `memory/MEMORY.md` content:
   ```xml
   <long-term-memory>
   (content of MEMORY.md)
   </long-term-memory>
   ```

2. **Recent journals** — List of recent journal files (last 7 days):
   ```xml
   <recent-journals>
     2026-02-24 (45 lines) — Daily standup and project updates
     2026-02-23 (12 lines) — Code review session
   </recent-journals>
   ```

3. **Inbox status** — Pending task count (only if > 0):
   ```xml
   <inbox-status>
   You have 3 pending task(s). Use get_next_task() to process them.
   </inbox-status>
   ```

Note: Identity is loaded separately via CLAUDE.md system prompt injection.

## stop.sh

Runs after Claude finishes a response. Handles inbox checking and sleep orchestration.

### Daily Cleanup Mode

If `ATLAS_CLEANUP=1`, touches `.cleanup-done` and exits immediately.

### Trigger Session Mode

If `ATLAS_TRIGGER` is set, exits immediately with code 0. Trigger sessions don't loop on inbox; the watcher handles re-awakening via `.wake-<trigger>-<task_id>` files.

### Main Session Mode

1. **Save session ID**: Writes `CLAUDE_SESSION_ID` (or finds most recent session file) to `.last-session-id`

2. **Check for active tasks**: If any task has `status='processing'`, outputs a warning and exits code 2 (continue processing):
   ```xml
   <active-task-warning>
   [{"id": 42, "sender": "trigger:email", "content": "..."}]
   </active-task-warning>
   <task-instruction>
   You have an active task still in 'processing' status.
   Complete it with task_complete(task_id=<id>, response_summary="<result>") before stopping.
   </task-instruction>
   ```

3. **Check for pending tasks**: If any task has `status='pending'`, outputs instruction and exits code 2:
   ```xml
   <pending-tasks>
   You have 3 pending task(s) in the queue.
   </pending-tasks>
   <task-instruction>
   Use get_next_task() to pick up and process the next task.
   </task-instruction>
   ```

4. **Sleep**: If no active or pending tasks, outputs a journal reminder and exits code 0:
   ```
   No pending tasks. Write a short journal entry to memory/YYYY-MM-DD.md if you accomplished something relevant today.
   ```

Exit codes: 0 = sleep, 2 = continue processing

## pre-compact-auto.sh

Runs before automatic context compaction. Prompts memory flush.

### Trigger Session Mode

For trigger sessions (`ATLAS_TRIGGER` set), uses channel-specific templates:

- `app/prompts/trigger-{CHANNEL}-pre-compact.md`
- `app/prompts/trigger-pre-compact.md` (fallback)

Outputs `<system-notice>` with pre-compaction instructions.

Then outputs `<system-reminder>` with post-compaction context from:
- `app/prompts/trigger-{CHANNEL}-compact.md`
- `app/prompts/trigger-compact.md` (fallback)

### Main Session Mode

Outputs generic memory flush instructions:

```xml
<system-notice>
Context is about to be compressed. Consolidate important findings:

1. Write lasting facts, decisions, and preferences to memory/MEMORY.md
2. Write task results and daily context to memory/{TODAY}.md
3. If a project topic is relevant, create/update a file in memory/projects/

MEMORY.md is for long-term, timeless information. The journal is for daily details.
</system-notice>
```

## pre-compact-manual.sh

Runs before manual context compaction (when user runs `/compact`). Same behavior as `pre-compact-auto.sh`.

## subagent-stop.sh

Runs when a team member (subagent) finishes. Quality gate that prompts evaluation:

```
=== SUBAGENT RESULT REVIEW ===

A team member has completed their task. Review:

1. Was the original task fully completed?
2. Are there obvious errors or gaps in the result?
3. Does it need rework or is the result acceptable?

If the result is incomplete or flawed:
- Describe what is missing
- Decide whether to re-assign the subagent

If the result is good:
- Integrate it into the main context
- Mark the related task as done
```

## Source

`app/hooks/session-start.sh` — Context loading
`app/hooks/stop.sh` — Inbox checking and sleep
`app/hooks/pre-compact-auto.sh` — Memory flush (auto compaction)
`app/hooks/pre-compact-manual.sh` — Memory flush (manual compaction)
`app/hooks/subagent-stop.sh` — Quality gate
