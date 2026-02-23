import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, closeSync, openSync } from "fs";
import { getDb } from "./db";

function syncCrontab(): void {
  try {
    Bun.spawnSync(["bun", "run", "/atlas/app/triggers/sync-crontab.ts"]);
  } catch {}
}

const server = new McpServer({
  name: "inbox-mcp",
  version: "1.0.0",
});

// --- Tool: inbox_list ---
server.tool(
  "inbox_list",
  "List pending messages from the inbox",
  {
    status: z.string().optional().default("pending").describe("Filter by status: pending, processing, done"),
    limit: z.number().optional().default(20).describe("Max number of messages to return"),
    channel: z.string().optional().describe("Filter by channel: signal, email, web, internal"),
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

    const rows = db.prepare(sql).all(...params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
    };
  }
);

// --- Tool: inbox_mark ---
server.tool(
  "inbox_mark",
  "Mark a message as processed",
  {
    message_id: z.number().describe("ID of the message to update"),
    status: z.enum(["processing", "done"]).describe("New status"),
    response_summary: z.string().optional().describe("Optional summary of the response"),
  },
  async ({ message_id, status, response_summary }) => {
    const db = getDb();
    db.prepare(
      "UPDATE messages SET status = ?, response_summary = ?, processed_at = datetime('now') WHERE id = ?"
    ).run(status, response_summary ?? null, message_id);

    const updated = db.prepare("SELECT * FROM messages WHERE id = ?").get(message_id);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }],
    };
  }
);

// --- Tool: inbox_write ---
server.tool(
  "inbox_write",
  "Write a new task to the inbox (wakes main session)",
  {
    sender: z.string().optional().describe("Sender identifier (e.g. 'trigger:github-issues')"),
    content: z.string().describe("Task description with full context"),
    reply_to: z.string().optional().describe("Reference to original message or contact"),
  },
  async ({ sender, content, reply_to }) => {
    const db = getDb();
    db.prepare("INSERT INTO messages (channel, sender, content, reply_to) VALUES ('task', ?, ?, ?)")
      .run(sender ?? null, content, reply_to ?? null);

    const message = db.prepare("SELECT * FROM messages WHERE id = last_insert_rowid()").get();

    // Touch wake file to trigger watcher
    const wakePath = "/atlas/workspace/inbox/.wake";
    mkdirSync("/atlas/workspace/inbox", { recursive: true });
    closeSync(openSync(wakePath, "w"));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(message, null, 2) }],
    };
  }
);

// --- Tool: inbox_stats ---
server.tool(
  "inbox_stats",
  "Get inbox statistics",
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

    const stats = {
      total: total.count,
      by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
      by_channel: Object.fromEntries(byChannel.map((r) => [r.channel, r.count])),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
    };
  }
);

// --- Tool: trigger_list ---
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
    const rows = db.prepare(sql).all(...params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
    };
  }
);

// --- Tool: trigger_create ---
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
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Trigger name must be lowercase alphanumeric, dashes, underscores only" }) }],
      };
    }

    if (type === "cron" && !schedule) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Cron triggers require a schedule" }) }],
      };
    }

    if (schedule && !/^[\d\s*\/,-]+$/.test(schedule)) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid cron schedule format" }) }],
      };
    }

    try {
      db.prepare(
        `INSERT INTO triggers (name, type, description, channel, schedule, webhook_secret, prompt, session_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(name, type, description, channel, schedule ?? null, webhook_secret ?? null, prompt, session_mode);
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
      };
    }

    const trigger = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name);

    if (type === "cron") syncCrontab();

    const info: Record<string, string> = {};
    if (type === "webhook") {
      info.webhook_url = `/api/webhook/${name}`;
      info.hint = "Configure external service to POST to this URL. Payload becomes {{payload}} in prompt.";
      if (webhook_secret) info.auth = "Set X-Webhook-Secret header to the configured secret.";
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ trigger, ...info }, null, 2) }],
    };
  }
);

// --- Tool: trigger_update ---
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
    if (!existing) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Trigger '${name}' not found` }) }],
      };
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (description !== undefined) { updates.push("description = ?"); params.push(description); }
    if (channel !== undefined) { updates.push("channel = ?"); params.push(channel); }
    if (schedule !== undefined) { updates.push("schedule = ?"); params.push(schedule); }
    if (webhook_secret !== undefined) { updates.push("webhook_secret = ?"); params.push(webhook_secret); }
    if (prompt !== undefined) { updates.push("prompt = ?"); params.push(prompt); }
    if (session_mode !== undefined) { updates.push("session_mode = ?"); params.push(session_mode); }
    if (enabled !== undefined) { updates.push("enabled = ?"); params.push(enabled ? 1 : 0); }

    if (updates.length === 0) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "No fields to update" }) }],
      };
    }

    params.push(name);
    db.prepare(`UPDATE triggers SET ${updates.join(", ")} WHERE name = ?`).run(...params);

    const updated = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name);

    if (existing.type === "cron") syncCrontab();

    return {
      content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }],
    };
  }
);

// --- Tool: trigger_delete ---
server.tool(
  "trigger_delete",
  "Delete a trigger",
  {
    name: z.string().describe("Trigger name to delete"),
  },
  async ({ name }) => {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name) as any;
    if (!existing) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Trigger '${name}' not found` }) }],
      };
    }

    db.prepare("DELETE FROM triggers WHERE name = ?").run(name);
    db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = ?").run(name);

    if (existing.type === "cron") syncCrontab();

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ deleted: name, type: existing.type }) }],
    };
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
