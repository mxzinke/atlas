import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, closeSync, openSync } from "fs";
import { getDb } from "./db";

const server = new McpServer({
  name: "inbox-mcp",
  version: "1.0.0",
});

// --- Tool: inbox_list ---
server.tool(
  "inbox_list",
  "Liste ausstehende Nachrichten aus der Inbox",
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
  "Markiere eine Nachricht als bearbeitet",
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
  "Schreibe eine neue Nachricht in die Inbox",
  {
    channel: z.string().describe("Channel: signal, email, web, internal"),
    sender: z.string().optional().describe("Sender identifier"),
    content: z.string().describe("Message content"),
    reply_to: z.string().optional().describe("Reference to original message or contact"),
  },
  async ({ channel, sender, content, reply_to }) => {
    const db = getDb();
    const result = db
      .prepare("INSERT INTO messages (channel, sender, content, reply_to) VALUES (?, ?, ?, ?)")
      .run(channel, sender ?? null, content, reply_to ?? null);

    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(result.lastInsertRowid);

    // Touch wake file to trigger watcher
    const wakePath = "/atlas/workspace/inbox/.wake";
    mkdirSync("/atlas/workspace/inbox", { recursive: true });
    closeSync(openSync(wakePath, "w"));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(message, null, 2) }],
    };
  }
);

// --- Tool: reply_send ---
server.tool(
  "reply_send",
  "Sende eine Antwort über den ursprünglichen Kanal",
  {
    message_id: z.number().describe("ID of the original message to reply to"),
    content: z.string().describe("Reply content"),
  },
  async ({ message_id, content }) => {
    const db = getDb();
    const original = db.prepare("SELECT * FROM messages WHERE id = ?").get(message_id) as
      | { id: number; channel: string; reply_to: string | null }
      | undefined;

    if (!original) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Message not found" }) }],
      };
    }

    let delivery = "";

    switch (original.channel) {
      case "web":
        db.prepare(
          "UPDATE messages SET status = 'done', response_summary = ?, processed_at = datetime('now') WHERE id = ?"
        ).run(content, message_id);
        delivery = "Reply stored in response_summary (web channel)";
        break;

      case "signal":
      case "email": {
        const repliesDir = "/atlas/workspace/inbox/replies";
        mkdirSync(repliesDir, { recursive: true });
        const replyData = {
          channel: original.channel,
          reply_to: original.reply_to,
          content,
          timestamp: new Date().toISOString(),
        };
        writeFileSync(`${repliesDir}/${message_id}.json`, JSON.stringify(replyData, null, 2));
        db.prepare(
          "UPDATE messages SET status = 'done', response_summary = ?, processed_at = datetime('now') WHERE id = ?"
        ).run(content, message_id);
        delivery = `Reply written to replies/${message_id}.json (${original.channel} channel)`;
        break;
      }

      case "internal":
        db.prepare(
          "UPDATE messages SET status = 'done', response_summary = ?, processed_at = datetime('now') WHERE id = ?"
        ).run(content, message_id);
        delivery = "Marked as done (internal channel)";
        break;

      default:
        delivery = `Unknown channel: ${original.channel}`;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ message_id, channel: original.channel, delivery }, null, 2),
        },
      ],
    };
  }
);

// --- Tool: inbox_stats ---
server.tool(
  "inbox_stats",
  "Inbox-Statistiken abrufen",
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

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
