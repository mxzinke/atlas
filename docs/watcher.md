# Watcher

The watcher is an event-driven wake system that monitors for filesystem events and resumes Claude sessions when work arrives. It uses `inotifywait` for efficient monitoring without polling.

## Implementation

Source: `app/watcher.sh`

The watcher runs as a continuous loop:

```bash
inotifywait -m "$WATCH_DIR" -e create,modify,attrib \
  --exclude '\.(db|wal|shm)$' \
  --format '%f' | while read FILENAME; do
  # Handle wake events
 done
```

## .wake File Mechanism

The main session is awakened by touching `.wake` in `/home/atlas/.index/`:

```bash
touch /home/atlas/.index/.wake
```

When the watcher detects `.wake`:

1. Acquires exclusive lock via `flock` (prevents concurrent sessions)
2. Creates `.session-running` lock file (web-ui status indicator)
3. Reads session ID from `.last-session-id`
4. Disables remote MCP connectors (patches `~/.claude.json`)
5. Resumes or starts Claude session:
   ```bash
   claude-atlas --mode worker --resume "$SESSION_ID" -p \
     "You have new tasks. Use get_next_task() to process them."
   ```
6. Removes `.session-running` when done

## Concurrency Control

### Main Session Lock

Uses `flock` on `.session.flock` for atomic locking:

```bash
(
  flock -n 9 || { echo "Session already running"; exit 0; }
  # ... run session
) 9>".session.flock"
```

The lock automatically releases if the process crashes or is killed.

### Trigger Session Locks

Each trigger has its own lock file to prevent concurrent runs:

```bash
flock -n 200 || { echo "Trigger $TRIGGER_NAME already running"; exit 0; }
# ... run trigger
) 200>".trigger-${TRIGGER_NAME}.flock"
```

## Trigger Re-awakening

When a worker completes a task created by a trigger, the trigger session is re-awakened via `.wake-<trigger>-<task_id>` files.

### Wake File Format

JSON file at `.wake-<trigger_name>-<task_id>`:

```json
{
  "task_id": 42,
  "trigger_name": "email-handler",
  "session_key": "thread-123",
  "session_id": "abc-def-123",
  "channel": "email",
  "response_summary": "Task completed. Here's the result..."
}
```

### Re-awakening Process

1. Watcher detects `.wake-*` file pattern
2. Runs in background (doesn't block main watcher)
3. Acquires per-trigger flock
4. Atomically moves wake file to temp (prevents race conditions)
5. Parses JSON fields
6. Resumes trigger session with result message:
   ```
   Task #42 completed. Here is the worker's result:

   <response_summary>

   Relay this result to the original sender now.
   ```

7. If no session ID exists, falls back to spawning via `trigger.sh`

### Environment Variables for Trigger Sessions

When re-awakening, these are set:

- `ATLAS_TRIGGER=<trigger_name>`
- `ATLAS_TRIGGER_CHANNEL=<channel>`
- `ATLAS_TRIGGER_SESSION_KEY=<session_key>`

## Log Files

- `/atlas/logs/session.log` — Main session output
- `/atlas/logs/trigger-<name>.log` — Per-trigger session output

## Files

| File | Purpose |
|------|---------|
| `.wake` | Signals main session wake |
| `.wake-<trigger>-<id>` | Signals trigger re-awakening with result |
| `.last-session-id` | Stores last main session ID for resume |
| `.session-running` | Lock file indicating active main session |
| `.session.flock` | flock file for main session concurrency |
| `.trigger-<name>.flock` | flock file per trigger |
