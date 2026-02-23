import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, closeSync, openSync, writeFileSync } from "fs";
import { getDb } from "./db";

// --- Session context from environment ---
const ATLAS_TRIGGER = process.env.ATLAS_TRIGGER || "";
const ATLAS_TRIGGER_SESSION_KEY = process.env.ATLAS_TRIGGER_SESSION_KEY || "_default";
const IS_TRIGGER = !!ATLAS_TRIGGER;

/** Touch a file (create or update mtime) */
function touchFile(path: string): void {
  closeSync(openSync(path, "w"));
}

/** JSON MCP response helper */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

/** Wake a trigger session if it's awaiting this task */
function wakeTriggerIfAwaiting(taskId: number, responseSummary: string): void {
  const db = getDb();

  const awaiter = db.prepare(
    "SELECT trigger_name, session_key FROM task_awaits WHERE task_id = ?"
  ).get(taskId) as { trigger_name: string; session_key: string } | undefined;

  if (!awaiter) return;

  // Look up session ID for resuming
  const session = db.prepare(
    "SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?"
  ).get(awaiter.trigger_name, awaiter.session_key) as { session_id: string } | undefined;

  // Look up channel for env var passthrough
  const triggerInfo = db.prepare(
    "SELECT channel FROM triggers WHERE name = ?"
  ).get(awaiter.trigger_name) as { channel: string } | undefined;

  // Write wake file for watcher — JSON with everything needed to re-awaken the trigger
  const wakeData = JSON.stringify({
    task_id: taskId,
    trigger_name: awaiter.trigger_name,
    session_key: awaiter.session_key,
    session_id: session?.session_id ?? "",
    channel: triggerInfo?.channel ?? "internal",
    response_summary: responseSummary,
  });

  mkdirSync("/atlas/workspace/inbox", { recursive: true });
  writeFileSync(`/atlas/workspace/inbox/.wake-${awaiter.trigger_name}`, wakeData);

  // Cleanup await record
  db.prepare("DELETE FROM task_awaits WHERE task_id = ?").run(taskId);
}

function syncCrontab(): void {
  try {
    Bun.spawnSync(["bun", "run", "/atlas/app/triggers/sync-crontab.ts"]);
  } catch {}
}

const server = new McpServer({
  name: "inbox-mcp",
  version: "2.0.0",
});

// =============================================================================
// TRIGGER TOOLS — only registered when ATLAS_TRIGGER is set
// =============================================================================
if (IS_TRIGGER) {

  // --- task_create: Create a task for the worker session ---
  server.tool(
    "task_create",
    "Create a task for the worker session. Automatically wakes the worker and registers for re-awakening when done.",
    {
      content: z.string().describe("Task brief with full context (self-contained — worker has no access to this conversation)"),
      reply_to: z.string().optional().describe("Reference to original message or contact"),
    },
    async ({ content, reply_to }) => {
      const db = getDb();
      const sender = `trigger:${ATLAS_TRIGGER}`;

      db.prepare(
        "INSERT INTO messages (channel, sender, content, reply_to) VALUES ('task', ?, ?, ?)"
      ).run(sender, content, reply_to ?? null);

      const message = db.prepare("SELECT * FROM messages WHERE id = last_insert_rowid()").get() as any;
      const taskId = message.id;

      // Auto-register for re-awakening
      db.prepare(
        "INSERT OR REPLACE INTO task_awaits (task_id, trigger_name, session_key) VALUES (?, ?, ?)"
      ).run(taskId, ATLAS_TRIGGER, ATLAS_TRIGGER_SESSION_KEY);

      // Touch wake file to wake the worker session
      mkdirSync("/atlas/workspace/inbox", { recursive: true });
      touchFile("/atlas/workspace/inbox/.wake");

      return ok(message);
    }
  );

  // --- task_get: Check task status ---
  server.tool(
    "task_get",
    "Get a specific task by ID — check its status and response_summary",
    {
      task_id: z.number().describe("ID of the task to retrieve"),
    },
    async ({ task_id }) => {
      const db = getDb();
      const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(task_id);
      if (!message) return err(`Task ${task_id} not found`);
      return ok(message);
    }
  );

  // --- task_update: Update a pending task ---
  server.tool(
    "task_update",
    "Update the content of a pending task. Only works if the worker hasn't picked it up yet (status='pending').",
    {
      task_id: z.number().describe("ID of the task to update"),
      content: z.string().describe("New task brief content"),
    },
    async ({ task_id, content }) => {
      const db = getDb();
      const msg = db.prepare("SELECT status FROM messages WHERE id = ?").get(task_id) as { status: string } | undefined;
      if (!msg) return err(`Task ${task_id} not found`);
      if (msg.status !== "pending") return err(`Task ${task_id} is '${msg.status}' — can only update pending tasks`);
      db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(content, task_id);
      return ok(db.prepare("SELECT * FROM messages WHERE id = ?").get(task_id));
    }
  );

  // --- task_cancel: Cancel a pending task ---
  server.tool(
    "task_cancel",
    "Cancel a pending task. Only works if the worker hasn't picked it up yet (status='pending').",
    {
      task_id: z.number().describe("ID of the task to cancel"),
      reason: z.string().optional().describe("Reason for cancellation"),
    },
    async ({ task_id, reason }) => {
      const db = getDb();
      const msg = db.prepare("SELECT status FROM messages WHERE id = ?").get(task_id) as { status: string } | undefined;
      if (!msg) return err(`Task ${task_id} not found`);
      if (msg.status !== "pending") return err(`Task ${task_id} is '${msg.status}' — can only cancel pending tasks`);
      db.prepare(
        "UPDATE messages SET status = 'cancelled', response_summary = ?, processed_at = datetime('now') WHERE id = ?"
      ).run(reason ? `Cancelled: ${reason}` : "Cancelled", task_id);
      db.prepare("DELETE FROM task_awaits WHERE task_id = ?").run(task_id);
      return ok(db.prepare("SELECT * FROM messages WHERE id = ?").get(task_id));
    }
  );

  // --- inbox_mark: Mark incoming messages (trigger's own inbox) ---
  server.tool(
    "inbox_mark",
    "Mark an incoming message as processing or done",
    {
      message_id: z.number().describe("ID of the message to update"),
      status: z.enum(["processing", "done"]).describe("New status"),
      response_summary: z.string().optional().describe("Summary of how the message was handled"),
    },
    async ({ message_id, status, response_summary }) => {
      const db = getDb();
      db.prepare(
        "UPDATE messages SET status = ?, response_summary = ?, processed_at = datetime('now') WHERE id = ?"
      ).run(status, response_summary ?? null, message_id);
      return ok(db.prepare("SELECT * FROM messages WHERE id = ?").get(message_id));
    }
  );

  // --- inbox_list: Browse inbox ---
  server.tool(
    "inbox_list",
    "List messages from the inbox",
    {
      status: z.string().optional().default("pending").describe("Filter by status: pending, processing, done, cancelled"),
      limit: z.number().optional().default(20).describe("Max number of messages to return"),
      channel: z.string().optional().describe("Filter by channel: signal, email, web, internal, task"),
    },
    async ({ status, limit, channel }) => {
      const db = getDb();
      let sql = "SELECT * FROM messages WHERE status = ?";
      const params: unknown[] = [status];
      if (channel) {
        sql += " AND channel = ?";
        params.push(channel);
      }
      sql += " ORDER BY created_at ASC LIMIT ?";
      params.push(limit);
      return ok(db.prepare(sql).all(...params));
    }
  );

}

// =============================================================================
// WORKER TOOLS — only registered when ATLAS_TRIGGER is NOT set
// =============================================================================
if (!IS_TRIGGER) {

  // --- get_next_task: Atomically get and claim next pending task ---
  server.tool(
    "get_next_task",
    "Get the next pending task and mark it as processing. Warns if you already have an active task.",
    {},
    async () => {
      const db = getDb();

      // Check for stuck active task first
      const active = db.prepare(
        "SELECT * FROM messages WHERE status = 'processing' ORDER BY created_at ASC LIMIT 1"
      ).get();
      if (active) {
        return ok({
          warning: "You already have an active task. Complete it before starting the next.",
          active_task: active,
        });
      }

      // Atomically claim next pending
      const next = db.prepare(
        "SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
      ).get() as any;
      if (!next) {
        return ok({ next_task: null, message: "No pending tasks." });
      }

      db.prepare(
        "UPDATE messages SET status = 'processing', processed_at = datetime('now') WHERE id = ?"
      ).run(next.id);

      return ok({ next_task: db.prepare("SELECT * FROM messages WHERE id = ?").get(next.id) });
    }
  );

  // --- task_complete: Mark task done and wake trigger ---
  server.tool(
    "task_complete",
    "Mark a task as done with a response summary. The summary is relayed directly to the original sender — write it as the actual reply.",
    {
      task_id: z.number().describe("ID of the task to complete"),
      response_summary: z.string().describe("Result to relay to the sender. Write as a real reply, not 'Done.'"),
    },
    async ({ task_id, response_summary }) => {
      const db = getDb();
      db.prepare(
        "UPDATE messages SET status = 'done', response_summary = ?, processed_at = datetime('now') WHERE id = ?"
      ).run(response_summary, task_id);

      // Wake the trigger session that created this task
      wakeTriggerIfAwaiting(task_id, response_summary);

      return ok(db.prepare("SELECT * FROM messages WHERE id = ?").get(task_id));
    }
  );

  // --- task_list: View task queue ---
  server.tool(
    "task_list",
    "List tasks in the queue",
    {
      status: z.string().optional().default("pending").describe("Filter: pending, processing, done, cancelled"),
      limit: z.number().optional().default(20).describe("Max results"),
    },
    async ({ status, limit }) => {
      const db = getDb();
      return ok(
        db.prepare("SELECT * FROM messages WHERE status = ? ORDER BY created_at ASC LIMIT ?").all(status, limit)
      );
    }
  );

  // --- task_get: Inspect specific task ---
  server.tool(
    "task_get",
    "Get a specific task by ID — check its status and response_summary",
    {
      task_id: z.number().describe("ID of the task to retrieve"),
    },
    async ({ task_id }) => {
      const db = getDb();
      const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(task_id);
      if (!message) return err(`Task ${task_id} not found`);
      return ok(message);
    }
  );

  // --- inbox_stats: Queue statistics ---
  server.tool(
    "inbox_stats",
    "Get task queue statistics",
    {},
    async () => {
      const db = getDb();
      const byStatus = db
        .prepare("SELECT status, COUNT(*) as count FROM messages GROUP BY status")
        .all() as { status: string; count: number }[];
      const byChannel = db
        .prepare("SELECT channel, COUNT(*) as count FROM messages GROUP BY channel")
        .all() as { channel: string; count: number }[];
      const total = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      return ok({
        total: total.count,
        by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
        by_channel: Object.fromEntries(byChannel.map((r) => [r.channel, r.count])),
      });
    }
  );

}

// =============================================================================
// SHARED TOOLS — always registered (trigger management)
// =============================================================================

// --- trigger_list ---
server.tool(
  "trigger_list",
  "List all configured triggers (cron, webhook, manual)",
  {
    type: z.string().optional().describe("Filter by type: cron, webhook, manual"),
  },
  async ({ type }) => {
    const db = getDb();
    let sql = "SELECT * FROM triggers";
    const params: unknown[] = [];
    if (type) {
      sql += " WHERE type = ?";
      params.push(type);
    }
    sql += " ORDER BY created_at ASC";
    return ok(db.prepare(sql).all(...params));
  }
);

// --- trigger_create ---
server.tool(
  "trigger_create",
  "Create a new trigger (cron, webhook, or manual). Webhooks get URL: /api/webhook/<name>",
  {
    name: z.string().describe("Unique trigger slug (e.g. 'github-check', 'daily-report')"),
    type: z.enum(["cron", "webhook", "manual"]).describe("Trigger type"),
    description: z.string().optional().default("").describe("Human-readable description"),
    channel: z.string().optional().default("internal").describe("Inbox channel for messages"),
    schedule: z.string().optional().describe("Cron expression for type=cron (e.g. '0 * * * *')"),
    webhook_secret: z.string().optional().describe("Secret for webhook validation (X-Webhook-Secret header)"),
    prompt: z.string().optional().default("").describe("Prompt template. Use {{payload}} for webhook data"),
    session_mode: z.enum(["ephemeral", "persistent"]).optional().default("ephemeral").describe("Session mode: ephemeral (new session per run) or persistent (resume across runs)"),
  },
  async ({ name, type, description, channel, schedule, webhook_secret, prompt, session_mode }) => {
    const db = getDb();

    if (!/^[a-z0-9_-]+$/.test(name)) {
      return err("Trigger name must be lowercase alphanumeric, dashes, underscores only");
    }
    if (type === "cron" && !schedule) {
      return err("Cron triggers require a schedule");
    }
    if (schedule && !/^[\d\s*\/,-]+$/.test(schedule)) {
      return err("Invalid cron schedule format");
    }

    try {
      db.prepare(
        `INSERT INTO triggers (name, type, description, channel, schedule, webhook_secret, prompt, session_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(name, type, description, channel, schedule ?? null, webhook_secret ?? null, prompt, session_mode);
    } catch (e: any) {
      return err(e.message);
    }

    const trigger = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name);
    if (type === "cron") syncCrontab();

    const info: Record<string, string> = {};
    if (type === "webhook") {
      info.webhook_url = `/api/webhook/${name}`;
      info.hint = "Configure external service to POST to this URL. Payload becomes {{payload}} in prompt.";
      if (webhook_secret) info.auth = "Set X-Webhook-Secret header to the configured secret.";
    }

    return ok({ trigger, ...info });
  }
);

// --- trigger_update ---
server.tool(
  "trigger_update",
  "Update an existing trigger",
  {
    name: z.string().describe("Trigger name to update"),
    description: z.string().optional().describe("New description"),
    channel: z.string().optional().describe("New inbox channel"),
    schedule: z.string().optional().describe("New cron schedule"),
    webhook_secret: z.string().optional().describe("New webhook secret"),
    prompt: z.string().optional().describe("New prompt template"),
    session_mode: z.enum(["ephemeral", "persistent"]).optional().describe("Session mode: ephemeral or persistent"),
    enabled: z.boolean().optional().describe("Enable or disable trigger"),
  },
  async ({ name, description, channel, schedule, webhook_secret, prompt, session_mode, enabled }) => {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name) as any;
    if (!existing) return err(`Trigger '${name}' not found`);

    const updates: string[] = [];
    const params: unknown[] = [];

    if (description !== undefined) { updates.push("description = ?"); params.push(description); }
    if (channel !== undefined) { updates.push("channel = ?"); params.push(channel); }
    if (schedule !== undefined) { updates.push("schedule = ?"); params.push(schedule); }
    if (webhook_secret !== undefined) { updates.push("webhook_secret = ?"); params.push(webhook_secret); }
    if (prompt !== undefined) { updates.push("prompt = ?"); params.push(prompt); }
    if (session_mode !== undefined) { updates.push("session_mode = ?"); params.push(session_mode); }
    if (enabled !== undefined) { updates.push("enabled = ?"); params.push(enabled ? 1 : 0); }

    if (updates.length === 0) return err("No fields to update");

    params.push(name);
    db.prepare(`UPDATE triggers SET ${updates.join(", ")} WHERE name = ?`).run(...params);

    if (existing.type === "cron") syncCrontab();
    return ok(db.prepare("SELECT * FROM triggers WHERE name = ?").get(name));
  }
);

// --- trigger_delete ---
server.tool(
  "trigger_delete",
  "Delete a trigger",
  {
    name: z.string().describe("Trigger name to delete"),
  },
  async ({ name }) => {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name) as any;
    if (!existing) return err(`Trigger '${name}' not found`);

    db.prepare("DELETE FROM triggers WHERE name = ?").run(name);
    db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = ?").run(name);

    if (existing.type === "cron") syncCrontab();
    return ok({ deleted: name, type: existing.type });
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
