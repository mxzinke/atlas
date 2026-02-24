# Inbox-MCP

The Inbox-MCP server provides MCP (Model Context Protocol) tools for message and trigger management. It runs as a stdio-based MCP server that Claude Code connects to directly.

## Database Schema

Atlas uses SQLite with WAL mode at `workspace/inbox/atlas.db`.

### messages

The task queue. Messages flow through statuses: `pending` → `processing` → `done`/`cancelled`.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment primary key |
| channel | TEXT | Source: web, internal, signal, email, task, ... |
| sender | TEXT | Sender identifier (nullable) |
| content | TEXT | Message body |
| status | TEXT | pending, processing, done, cancelled |
| response_summary | TEXT | Task result for relay to sender |
| created_at | TEXT | ISO datetime |
| processed_at | TEXT | ISO datetime |

Index: `(status, created_at)` for efficient queue queries.

### task_awaits

Tracks which trigger session is waiting for a task result. When a task completes, the watcher uses this to re-awaken the trigger.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment primary key |
| task_id | INTEGER | References messages(id) |
| trigger_name | TEXT | Trigger waiting for result |
| session_key | TEXT | Session key for persistent triggers |
| created_at | TEXT | ISO datetime |

### trigger_sessions

Maps `(trigger_name, session_key)` to Claude session IDs for persistent triggers.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment primary key |
| trigger_name | TEXT | Trigger identifier |
| session_key | TEXT | Session key (e.g., thread ID, sender) |
| session_id | TEXT | Claude session ID to resume |
| updated_at | TEXT | ISO datetime |

Unique constraint: `(trigger_name, session_key)`

### triggers

Trigger definitions for cron, webhook, and manual triggers.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment primary key |
| name | TEXT | Unique slug (e.g., `github-check`) |
| type | TEXT | cron, webhook, manual |
| description | TEXT | Human-readable description |
| channel | TEXT | Inbox channel for messages |
| schedule | TEXT | Cron expression (for type=cron) |
| webhook_secret | TEXT | Optional auth secret |
| prompt | TEXT | Prompt template (`{{payload}}` for webhooks) |
| session_mode | TEXT | ephemeral or persistent |
| enabled | INTEGER | 1=active, 0=disabled |
| last_run | TEXT | Last execution timestamp |
| run_count | INTEGER | Total executions |
| created_at | TEXT | ISO datetime |

## Tool Specifications

Tools are registered conditionally based on the `ATLAS_TRIGGER` environment variable.

### Trigger Tools (ATLAS_TRIGGER is set)

These tools are available to trigger sessions (read-only, filtering/escalation role):

#### task_create

Create a task for the worker session. Automatically wakes the worker and registers for re-awakening when done.

```typescript
{
  content: string  // Task brief with full context
}
```

Returns the created message with ID. The trigger session is automatically registered in `task_awaits` to be re-awakened when the task completes.

#### task_get

Get a specific task by ID to check status and response.

```typescript
{
  task_id: number
}
```

#### task_update

Update a pending task's content. Only works if status is `pending`.

```typescript
{
  task_id: number,
  content: string
}
```

#### task_cancel

Cancel a pending task. Only works if status is `pending`.

```typescript
{
  task_id: number,
  reason?: string
}
```

### Worker Tools (ATLAS_TRIGGER is not set)

These tools are available to the main worker session (read/write):

#### get_next_task

Atomically get and claim the next pending task. Updates status from `pending` to `processing`. Warns if you already have an active task.

Returns the next task or `{ next_task: null }` if empty.

#### task_complete

Mark a task as done with a response summary. The summary is relayed to the original sender, so write it as an actual reply.

```typescript
{
  task_id: number,
  response_summary: string
}
```

When a task completes, the server checks `task_awaits` and writes a `.wake-<trigger>-<task_id>` file to re-awaken the trigger session.

#### task_list

List tasks in the queue.

```typescript
{
  status?: string  // pending, processing, done, cancelled (default: pending)
  limit?: number   // Default: 20
}
```

#### task_get

Get a specific task by ID (same as trigger version).

#### inbox_stats

Get queue statistics: total count, breakdown by status, breakdown by channel.

### Shared Tools (always available)

#### trigger_list

List all configured triggers.

```typescript
{
  type?: string  // Filter: cron, webhook, manual
}
```

#### trigger_create

Create a new trigger.

```typescript
{
  name: string,              // Unique slug (lowercase, alphanumeric, -_)
  type: "cron" | "webhook" | "manual",
  description?: string,
  channel?: string,          // Default: "internal"
  schedule?: string,         // Required for cron (e.g., "0 * * * *")
  webhook_secret?: string,   // For webhook auth
  prompt?: string,           // Use {{payload}} for webhook data
  session_mode?: "ephemeral" | "persistent"  // Default: "ephemeral"
}
```

Returns trigger details plus `webhook_url` and auth hints for webhook types.

#### trigger_update

Update an existing trigger. Only specified fields are changed.

```typescript
{
  name: string,
  description?: string,
  channel?: string,
  schedule?: string,
  webhook_secret?: string,
  prompt?: string,
  session_mode?: "ephemeral" | "persistent",
  enabled?: boolean
}
```

#### trigger_delete

Delete a trigger and clean up associated sessions and awaits.

```typescript
{
  name: string
}
```

## Message Lifecycle

1. **Creation**: A message is INSERTed with `status='pending'`
2. **Wake**: The `.wake` file is touched, signaling the watcher
3. **Claim**: Worker calls `get_next_task()` → status becomes `processing`
4. **Processing**: Worker processes the task
5. **Completion**: Worker calls `task_complete()` → status becomes `done'`
6. **Trigger Wake**: If a trigger was waiting, a `.wake-<trigger>-<id>` file is created
7. **Re-awaken**: The trigger session resumes and receives the response

## Source

`app/inbox-mcp/index.ts` — Main MCP server
`app/inbox-mcp/db.ts` — Database initialization and schema
