import { Hono } from "hono";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  closeSync,
  openSync,
  statSync,
} from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { getDb } from "../inbox-mcp/db";

// --- Config ---
const WS = process.env.HOME!;
const MEMORY = `${WS}/memory`;
const IDENTITY = `${WS}/IDENTITY.md`;
const CONFIG = `${WS}/config.yml`;
const EXTENSIONS = `${WS}/user-extensions.sh`;
const LOCK = `${WS}/.index/.session-running`;
const WAKE = `${WS}/.index/.wake`;

function syncCrontab(): void {
  try {
    Bun.spawnSync(["bun", "run", "/atlas/app/triggers/sync-crontab.ts"]);
  } catch {}
}

const db = getDb();

// --- Helpers ---
function safe(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readFile(p: string): string {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

function channelIcon(ch: string): string {
  const icons: Record<string, string> = {
    signal: "S",
    email: "@",
    web: "W",
    internal: "I",
  };
  return icons[ch] || "?";
}

function statusColor(s: string): string {
  return s === "pending"
    ? "#ff9800"
    : s === "processing"
      ? "#5c9cf5"
      : s === "cancelled"
        ? "#999"
        : "#4caf50"; // done → green
}

function timeAgo(dt: string): string {
  if (!dt) return "";
  const diff = Date.now() - new Date(dt.endsWith("Z") ? dt : dt + "Z").getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// --- Layout ---
function layout(
  title: string,
  content: string,
  active: string = "",
  mainStyle: string = "",
): string {
  const nav = [
    ["/", "Dashboard", "dashboard"],
    ["/inbox", "Inbox", "inbox"],
    ["/tasks", "Tasks", "tasks"],
    ["/triggers", "Triggers", "triggers"],
    ["/analytics", "Analytics", "analytics"],
    ["/memory", "Memory", "memory"],
    ["/journal", "Journal", "journal"],
    ["/chat", "Chat", "chat"],
    ["/settings", "Settings", "settings"],
  ];
  const links = nav
    .map(
      ([href, label, id]) =>
        `<a href="${href}" class="${active === id ? "active" : ""}">${label}</a>`,
    )
    .join("");

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safe(title)} - Atlas</title>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1b2e;color:#e0e0e0;font:14px/1.5 'SF Mono','Cascadia Code','Consolas',monospace;display:flex;min-height:100vh}
nav{width:180px;background:#151625;padding:16px 0;border-right:1px solid #3a3b55;flex-shrink:0;position:fixed;height:100vh;overflow-y:auto}
nav .logo{padding:12px 16px;font-size:16px;font-weight:700;color:#7c6ef0;border-bottom:1px solid #3a3b55;margin-bottom:8px}
nav a{display:block;padding:8px 16px;color:#999;text-decoration:none;font-size:13px;transition:all .15s}
nav a:hover{color:#e0e0e0;background:#252640}
nav a.active{color:#7c6ef0;background:#252640;border-right:2px solid #7c6ef0}
main{margin-left:180px;flex:1;padding:24px;max-width:960px}
h1{font-size:20px;margin-bottom:16px;color:#e0e0e0;font-weight:600}
.card{background:#252640;border:1px solid #3a3b55;border-radius:6px;padding:16px;margin-bottom:12px}
.card h3{font-size:14px;color:#7c6ef0;margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.stat{background:#252640;border:1px solid #3a3b55;border-radius:6px;padding:12px;text-align:center}
.stat .num{font-size:28px;font-weight:700;color:#7c6ef0}
.stat .label{font-size:11px;color:#999;text-transform:uppercase}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #3a3b55;font-size:13px}
th{color:#999;font-size:11px;text-transform:uppercase}
tr:hover{background:#2a2b45}
.ch-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:4px;background:#3a3b55;font-size:11px;font-weight:700;color:#7c6ef0}
input,textarea,select{background:#1a1b2e;color:#e0e0e0;border:1px solid #3a3b55;border-radius:4px;padding:8px 10px;font:13px/1.4 inherit;width:100%}
input:focus,textarea:focus{outline:none;border-color:#7c6ef0}
textarea{resize:vertical;min-height:120px}
button,.btn{background:#7c6ef0;color:#fff;border:none;border-radius:4px;padding:8px 16px;font:13px/1 inherit;cursor:pointer;transition:background .15s}
button:hover,.btn:hover{background:#6b5cd9}
.btn-sm{padding:4px 10px;font-size:12px}
.btn-outline{background:transparent;border:1px solid #3a3b55;color:#e0e0e0}
.btn-outline:hover{border-color:#7c6ef0;color:#7c6ef0}
.msg-row{cursor:pointer}
.msg-detail{padding:12px;background:#1e1f35;border-radius:4px;margin-top:8px;white-space:pre-wrap;font-size:13px}
.flash{padding:10px 14px;border-radius:4px;margin-bottom:12px;font-size:13px}
.flash-ok{background:#1b3a1b;border:1px solid #4caf50;color:#4caf50}
.flash-err{background:#3a1b1b;border:1px solid #f44336;color:#f44336}
pre{background:#1a1b2e;border:1px solid #3a3b55;border-radius:4px;padding:12px;overflow-x:auto;font-size:13px;white-space:pre-wrap;word-break:break-word}
.search-box{display:flex;gap:8px;margin-bottom:12px}
.search-box input{flex:1}
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:4px;background:#3a3b55;color:#ccc}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.mt-8{margin-top:8px}.mb-8{margin-bottom:8px}.mb-16{margin-bottom:16px}
.flex{display:flex;align-items:center;gap:8px}
.text-muted{color:#999;font-size:12px}
.chat-container{display:flex;flex-direction:column;height:calc(100vh - 48px)}
.chat-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column}
.chat-bubble{max-width:75%;border-radius:12px;padding:10px 14px;margin-bottom:4px;word-break:break-word;white-space:pre-wrap}
.chat-bubble.user{align-self:flex-end;background:#7c6ef0;color:#fff}
.chat-bubble.bot{align-self:flex-start;background:#252640;border-left:2px solid #7c6ef0}
.chat-time{font-size:11px;color:#666;margin-bottom:12px}
.chat-time.user{text-align:right}
.chat-input{border-top:1px solid #3a3b55;padding:12px 16px;display:flex;gap:8px}
.chat-input input{flex:1}
.typing-dots{align-self:flex-start;background:#252640;border-left:2px solid #7c6ef0;border-radius:12px;padding:10px 14px;margin-bottom:4px}
.typing-dots span{display:inline-block;width:8px;height:8px;border-radius:50%;background:#7c6ef0;margin:0 2px;animation:dotPulse 1.4s infinite ease-in-out both}
.typing-dots span:nth-child(1){animation-delay:0s}
.typing-dots span:nth-child(2){animation-delay:.2s}
.typing-dots span:nth-child(3){animation-delay:.4s}
@keyframes dotPulse{0%,80%,100%{opacity:.3;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
.chat-tool{align-self:flex-start;max-width:85%;margin-bottom:4px}
.chat-tool details{background:#1e1f35;border:1px solid #3a3b55;border-radius:8px;overflow:hidden}
.chat-tool summary{padding:8px 12px;cursor:pointer;color:#999;font-size:12px;user-select:none}
.chat-tool summary:hover{color:#7c6ef0}
.tool-call-item{padding:8px 12px;border-top:1px solid #3a3b55}
.tool-call-name{font-size:12px;color:#7c6ef0;font-weight:600;margin-bottom:4px}
.tool-call-input,.tool-call-result{margin:4px 0;padding:6px 8px;font-size:11px;max-height:200px;overflow-y:auto}
.tool-call-result{border-left:2px solid #4caf50}
.chat-thinking{align-self:flex-start;max-width:85%;margin-bottom:4px}
.chat-thinking details{background:#1a1b2e;border:1px solid #2a2b45;border-radius:8px;overflow:hidden;opacity:0.6}
.chat-thinking summary{padding:6px 12px;cursor:pointer;color:#666;font-size:11px;font-style:italic}
.chat-thinking pre{margin:0;padding:8px 12px;font-size:11px;max-height:200px;overflow-y:auto;color:#888}
</style></head><body>
<nav><div class="logo">ATLAS</div>${links}</nav>
<main${mainStyle ? ` style="${mainStyle}"` : ""}>${content}</main>
</body></html>`;
}

// --- Session JSONL helpers ---

interface ParsedMessage {
  type: "user-text" | "user-tool-result" | "assistant-text" | "assistant-tool-use" | "assistant-thinking";
  content: string;
  timestamp?: string;
  toolName?: string;
  toolInput?: string;
}

function findSessionFile(sessionId: string): string | null {
  const home = homedir();
  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  try {
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function parseSessionMessages(filePath: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return messages;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = obj.timestamp;

    if (obj.type === "user") {
      // Support both old format (obj.message: string|array) and new format (obj.message: {role,content})
      const rawMsg = obj.message;
      const msgContent = (rawMsg && typeof rawMsg === "object" && !Array.isArray(rawMsg) && rawMsg.content !== undefined)
        ? rawMsg.content : rawMsg;

      if (typeof msgContent === "string") {
        // Try to extract clean user text from inject template payload JSON
        let text = msgContent;
        try {
          const parsed = JSON.parse(text);
          if (parsed.message) text = parsed.message;
        } catch {}
        // Skip if this looks like a system/inject template (starts with "New event for trigger")
        if (/^New event for trigger /.test(text)) {
          const payloadMatch = text.match(/\n\n(\{[\s\S]*\})\n\n/);
          if (payloadMatch) {
            try {
              const payload = JSON.parse(payloadMatch[1]);
              if (payload.message) text = payload.message;
            } catch {}
          }
        }
        messages.push({ type: "user-text", content: text, timestamp: ts });
      } else if (Array.isArray(msgContent)) {
        // Could contain tool_result blocks
        for (const block of msgContent) {
          if (block.type === "tool_result") {
            const resultContent = Array.isArray(block.content)
              ? block.content.map((c: any) => c.text || "").join("\n")
              : typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
            messages.push({
              type: "user-tool-result",
              content: resultContent,
              timestamp: ts,
              toolName: block.tool_use_id,
            });
          }
        }
      }
    } else if (obj.type === "assistant") {
      // Support both old format (obj.message: array) and new format (obj.message: {role,content})
      const rawMsg = obj.message;
      const msgBlocks = (rawMsg && typeof rawMsg === "object" && !Array.isArray(rawMsg) && Array.isArray(rawMsg.content))
        ? rawMsg.content : rawMsg;
      if (!Array.isArray(msgBlocks)) continue;
      for (const block of msgBlocks) {
        if (block.type === "text" && block.text) {
          messages.push({ type: "assistant-text", content: block.text, timestamp: ts });
        } else if (block.type === "tool_use") {
          const inputStr = typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input, null, 2);
          messages.push({
            type: "assistant-tool-use",
            content: block.name || "tool",
            timestamp: ts,
            toolName: block.name,
            toolInput: inputStr.length > 2000 ? inputStr.slice(0, 2000) + "..." : inputStr,
          });
        } else if (block.type === "thinking" && block.thinking) {
          messages.push({
            type: "assistant-thinking",
            content: block.thinking.length > 1000
              ? block.thinking.slice(0, 1000) + "..."
              : block.thinking,
            timestamp: ts,
          });
        }
      }
    }
    // Skip system, progress, file-history-snapshot, etc.
  }

  return messages;
}

function renderConversation(messages: ParsedMessage[]): string {
  let html = "";
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.type === "user-text") {
      html += `<div class="chat-bubble user">${safe(msg.content)}</div>`;
      if (msg.timestamp) html += `<div class="chat-time user">${timeAgo(msg.timestamp)}</div>`;
      i++;
    } else if (msg.type === "assistant-text") {
      html += `<div class="chat-bubble bot">${safe(msg.content)}</div>`;
      if (msg.timestamp) html += `<div class="chat-time">${timeAgo(msg.timestamp)}</div>`;
      i++;
    } else if (msg.type === "assistant-tool-use") {
      // Aggregate consecutive tool calls and their results
      const toolGroup: { name: string; input: string; result?: string }[] = [];
      while (i < messages.length && (messages[i].type === "assistant-tool-use" || messages[i].type === "user-tool-result")) {
        if (messages[i].type === "assistant-tool-use") {
          toolGroup.push({ name: messages[i].toolName || "tool", input: messages[i].toolInput || "" });
        } else if (messages[i].type === "user-tool-result" && toolGroup.length > 0) {
          // Attach result to the most recent tool call without a result
          const last = toolGroup[toolGroup.length - 1];
          if (!last.result) {
            last.result = messages[i].content;
          }
        }
        i++;
      }
      const summary = toolGroup.length === 1
        ? `${toolGroup[0].name}`
        : `${toolGroup.length} tool calls: ${toolGroup.map(t => t.name).join(", ")}`;
      html += `<div class="chat-tool"><details><summary>${safe(summary)}</summary>`;
      for (const t of toolGroup) {
        html += `<div class="tool-call-item"><div class="tool-call-name">${safe(t.name)}</div>`;
        html += `<pre class="tool-call-input">${safe(t.input.length > 500 ? t.input.slice(0, 500) + "..." : t.input)}</pre>`;
        if (t.result) {
          html += `<pre class="tool-call-result">${safe(t.result.length > 500 ? t.result.slice(0, 500) + "..." : t.result)}</pre>`;
        }
        html += `</div>`;
      }
      html += `</details></div>`;
    } else if (msg.type === "assistant-thinking") {
      html += `<div class="chat-thinking"><details><summary>thinking</summary><pre>${safe(msg.content)}</pre></details></div>`;
      i++;
    } else {
      // user-tool-result without preceding tool call — skip
      i++;
    }
  }
  return html;
}

// --- App ---
const app = new Hono();

// ============ DASHBOARD ============
app.get("/", (c) => {
  const sessionRunning = existsSync(LOCK);

  // Task statistics (from tasks table)
  const taskStatusCounts = db
    .prepare("SELECT status, COUNT(*) as c FROM tasks GROUP BY status")
    .all() as any[];
  const taskCounts: Record<string, number> = {};
  for (const row of taskStatusCounts) {
    taskCounts[row.status] = row.c;
  }

  // Inbox message count
  const inboxTotal = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any)?.c || 0;

  // Active tasks (pending or processing)
  const activeTasks = db
    .prepare("SELECT * FROM tasks WHERE status IN ('pending', 'processing') ORDER BY created_at DESC LIMIT 10")
    .all() as any[];

  // Recent completed tasks (done or cancelled)
  const recentCompleted = db
    .prepare("SELECT * FROM tasks WHERE status IN ('done', 'cancelled') ORDER BY created_at DESC LIMIT 5")
    .all() as any[];

  // Recent journal files (YYYY-MM-DD.md directly in memory/)
  let journals: string[] = [];
  if (existsSync(MEMORY)) {
    journals = readdirSync(MEMORY)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 5);
  }

  const html = `
    <h1>Dashboard</h1>
    <div class="grid">
      <div class="stat">
        <div class="num" style="color:${sessionRunning ? "#4caf50" : "#999"}">${sessionRunning ? "ON" : "OFF"}</div>
        <div class="label">Session</div>
      </div>
      <div class="stat"><div class="num" style="color:#ff9800">${taskCounts["pending"] || 0}</div><div class="label">Pending</div></div>
      <div class="stat"><div class="num" style="color:#5c9cf5">${taskCounts["processing"] || 0}</div><div class="label">Processing</div></div>
      <div class="stat"><div class="num" style="color:#4caf50">${taskCounts["done"] || 0}</div><div class="label">Done</div></div>
      <div class="stat"><div class="num" style="color:#999">${taskCounts["cancelled"] || 0}</div><div class="label">Cancelled</div></div>
      <div class="stat"><div class="num">${inboxTotal}</div><div class="label">Inbox</div></div>
    </div>

    ${activeTasks.length > 0 ? `
    <div class="card"><h3>Active Tasks</h3>
    <table>
      <tr><th>ID</th><th>Trigger</th><th>Content</th><th>Status</th><th>Time</th></tr>
      ${activeTasks.map((t) => `<tr>
        <td>#${t.id}</td>
        <td><span class="badge" style="background:#7c6ef020;color:#7c6ef0">${safe(t.trigger_name)}</span></td>
        <td>${safe((t.content || "").slice(0, 60))}${t.content?.length > 60 ? "..." : ""}</td>
        <td><span class="badge" style="background:${statusColor(t.status)}20;color:${statusColor(t.status)}">${t.status}</span></td>
        <td class="text-muted">${timeAgo(t.created_at)}</td>
      </tr>`).join("")}
    </table></div>` : ""}

    ${recentCompleted.length > 0 ? `
    <div class="card"><h3>Recent Completed Tasks</h3>
    <table>
      <tr><th>ID</th><th>Trigger</th><th>Content</th><th>Status</th><th>Time</th></tr>
      ${recentCompleted.map((t) => `<tr>
        <td>#${t.id}</td>
        <td><span class="badge" style="background:#7c6ef020;color:#7c6ef0">${safe(t.trigger_name)}</span></td>
        <td>${safe((t.content || "").slice(0, 60))}${t.content?.length > 60 ? "..." : ""}</td>
        <td><span class="badge" style="background:${statusColor(t.status)}20;color:${statusColor(t.status)}">${t.status}</span></td>
        <td class="text-muted">${timeAgo(t.created_at)}</td>
      </tr>`).join("")}
    </table></div>` : ""}

    <div class="card"><h3>Recent Journals</h3>
    ${
      journals.length === 0
        ? '<div class="text-muted">No journal entries yet.</div>'
        : `<ul style="list-style:none">${journals
            .map((j) => {
              const d = j.replace(".md", "");
              return `<li style="padding:4px 0"><a href="/journal?date=${d}" style="color:#7c6ef0;text-decoration:none">${d}</a></li>`;
            })
            .join("")}</ul>`
    }
    </div>`;

  return c.html(layout("Dashboard", html, "dashboard"));
});

// ============ INBOX ============
app.get("/inbox", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = 100;
  const offset = (page - 1) * limit;

  const countSql = "SELECT COUNT(*) as c FROM messages";
  const sql = "SELECT * FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?";

  const total = (db.prepare(countSql).get() as any)?.c || 0;
  const msgs = db.prepare(sql).all(limit, offset) as any[];
  const totalPages = Math.ceil(total / limit);

  const qs = "";
  const paginationHtml =
    totalPages > 1
      ? `<div class="flex mt-8" style="justify-content:space-between">
    <span class="text-muted">Page ${page} of ${totalPages} (${total} messages)</span>
    <span>${page > 1 ? `<a href="/inbox?page=${page - 1}${qs}" class="btn btn-sm btn-outline">Prev</a> ` : ""}${page < totalPages ? `<a href="/inbox?page=${page + 1}${qs}" class="btn btn-sm btn-outline">Next</a>` : ""}</span>
  </div>`
      : "";

  const html = `
    <h1>Inbox</h1>
    <table>
      <tr><th>Channel</th><th>Sender</th><th>Content</th><th>Time</th></tr>
      ${msgs
        .map(
          (m) => `
        <tr class="msg-row" hx-get="/inbox/${m.id}" hx-target="#detail-${m.id}" hx-swap="innerHTML">
          <td><span class="ch-icon" title="${safe(m.channel)}">${channelIcon(m.channel)}</span></td>
          <td>${safe(m.sender || "-")}</td>
          <td>${safe((m.content || "").slice(0, 80))}${m.content?.length > 80 ? "..." : ""}</td>
          <td class="text-muted">${timeAgo(m.created_at)}</td>
        </tr>
        <tr id="detail-${m.id}"></tr>
      `,
        )
        .join("")}
    </table>
    ${msgs.length === 0 ? '<div class="card text-muted">No messages found.</div>' : ""}
    ${paginationHtml}`;

  return c.html(layout("Inbox", html, "inbox"));
});

app.get("/inbox/:id", (c) => {
  const msg = db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(c.req.param("id")) as any;
  if (!msg) return c.html("<td colspan=5>Not found</td>");
  return c.html(`<td colspan="4"><div class="msg-detail">
    <strong>ID:</strong> ${msg.id} | <strong>Channel:</strong> ${msg.channel} | <strong>Sender:</strong> ${safe(msg.sender || "-")} | <strong>Created:</strong> ${msg.created_at}
    <hr style="border-color:#3a3b55;margin:8px 0">
    <strong>Content:</strong>
${safe(msg.content)}
  </div></td>`);
});

// ============ TRIGGERS ============

function triggerTypeIcon(type: string): string {
  return type === "cron"
    ? "&#9200;"
    : type === "webhook"
      ? "&#9889;"
      : "&#9654;";
}

function triggerRow(t: any): string {
  return `<tr>
    <td>${triggerTypeIcon(t.type)} ${safe(t.type)}</td>
    <td><strong>${safe(t.name)}</strong>${t.description ? `<br><span class="text-muted">${safe(t.description)}</span>` : ""}</td>
    <td>${
      t.type === "cron"
        ? `<code>${safe(t.schedule || "-")}</code>`
        : t.type === "webhook"
          ? `<code>/api/webhook/${safe(t.name)}</code>`
          : "-"
    }</td>
    <td><span class="dot" style="background:${t.enabled ? "#4caf50" : "#999"}"></span>${t.enabled ? "On" : "Off"}</td>
    <td class="text-muted">${t.last_run ? timeAgo(t.last_run) : "never"} (${t.run_count || 0}x)</td>
    <td class="flex">
      <button class="btn btn-sm btn-outline" hx-post="/triggers/${t.id}/toggle" hx-target="#trigger-list" hx-swap="innerHTML">
        ${t.enabled ? "Disable" : "Enable"}</button>
      <button class="btn btn-sm btn-outline" hx-post="/triggers/${t.id}/run" hx-target="#trigger-list" hx-swap="innerHTML">
        Run</button>
      <button class="btn btn-sm btn-outline" style="color:#f44336;border-color:#f44336"
        hx-delete="/triggers/${t.id}" hx-target="#trigger-list" hx-swap="innerHTML"
        hx-confirm="Delete trigger '${safe(t.name)}'?">Del</button>
    </td>
  </tr>`;
}

app.get("/triggers", (c) => {
  const flash = c.req.query("msg");
  const triggers = db
    .prepare("SELECT * FROM triggers ORDER BY type, name")
    .all() as any[];

  const html = `
    <h1>Triggers</h1>
    ${flash ? `<div class="flash flash-ok">${safe(flash)}</div>` : ""}
    <div class="card" id="trigger-list">
      ${
        triggers.length === 0
          ? '<div class="text-muted">No triggers configured. Use the AI skill to create one.</div>'
          : `<table>
          <tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
          ${triggers.map((t) => triggerRow(t)).join("")}
        </table>`
      }
    </div>

    <div class="card"><h3>How Triggers Work</h3>
      <div class="text-muted" style="font-size:12px;line-height:1.6">
        <strong>Cron:</strong> Runs on schedule via supercronic. Example: <code>0 * * * *</code> = every hour.<br>
        <strong>Webhook:</strong> POST to <code>/api/webhook/&lt;name&gt;</code> with optional <code>X-Webhook-Secret</code> header. Payload replaces <code>{{payload}}</code> in prompt.<br>
        <strong>Manual:</strong> Click "Run" to trigger immediately.<br>
        Triggers are configured via the <strong>triggers</strong> AI skill — ask Claude to create or modify triggers.
      </div>
    </div>`;

  return c.html(layout("Triggers", html, "triggers"));
});

app.post("/triggers/:id/toggle", (c) => {
  const id = c.req.param("id");
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (!t) return c.html('<div class="text-muted">Not found</div>');

  db.prepare("UPDATE triggers SET enabled = ? WHERE id = ?").run(
    t.enabled ? 0 : 1,
    id,
  );
  if (t.type === "cron") syncCrontab();

  const triggers = db
    .prepare("SELECT * FROM triggers ORDER BY type, name")
    .all() as any[];
  return c.html(
    triggers.length === 0
      ? '<div class="text-muted">No triggers.</div>'
      : `<table><tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
     ${triggers.map((t) => triggerRow(t)).join("")}</table>`,
  );
});

app.post("/triggers/:id/run", (c) => {
  const id = c.req.param("id");
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (!t) return c.html('<div class="text-muted">Not found</div>');

  // Fire through trigger.sh for consistent behavior (session_mode, prompts, IPC)
  Bun.spawn(["/atlas/app/triggers/trigger.sh", t.name], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const triggers = db
    .prepare("SELECT * FROM triggers ORDER BY type, name")
    .all() as any[];
  return c.html(
    `<table><tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
     ${triggers.map((t) => triggerRow(t)).join("")}</table>`,
  );
});

app.delete("/triggers/:id", (c) => {
  const id = c.req.param("id");
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (t) {
    db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
    if (t.type === "cron") syncCrontab();
  }

  const triggers = db
    .prepare("SELECT * FROM triggers ORDER BY type, name")
    .all() as any[];
  return c.html(
    triggers.length === 0
      ? '<div class="text-muted">No triggers configured.</div>'
      : `<table><tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
     ${triggers.map((t) => triggerRow(t)).join("")}</table>`,
  );
});

// ============ WEBHOOK API ============
app.post("/api/webhook/:name", async (c) => {
  const name = c.req.param("name");
  const t = db
    .prepare("SELECT * FROM triggers WHERE name = ? AND type = 'webhook'")
    .get(name) as any;

  if (!t) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  if (!t.enabled) {
    return c.json({ error: "Webhook disabled" }, 403);
  }

  // Validate secret if configured
  if (t.webhook_secret) {
    const secret = c.req.header("X-Webhook-Secret") || c.req.query("secret");
    if (secret !== t.webhook_secret) {
      return c.json({ error: "Invalid secret" }, 401);
    }
  }

  // Read payload
  let payload = "";
  try {
    const ct = c.req.header("content-type") || "";
    if (ct.includes("application/json")) {
      payload = JSON.stringify(await c.req.json(), null, 2);
    } else if (ct.includes("form")) {
      payload = JSON.stringify(await c.req.parseBody(), null, 2);
    } else {
      payload = await c.req.text();
    }
  } catch {
    payload = "(could not parse payload)";
  }

  // Fire through trigger.sh for consistent behavior (session_mode, prompts, IPC)
  Bun.spawn(["/atlas/app/triggers/trigger.sh", t.name, payload], {
    stdout: "ignore",
    stderr: "ignore",
  });

  return c.json({
    ok: true,
    trigger: name,
    message: "Webhook received, Claude will process it",
  });
});

// ============ MEMORY ============
app.get("/memory", (c) => {
  const memoryMd =
    readFile(`${MEMORY}/MEMORY.md`) || readFile(`${WS}/MEMORY.md`);

  let files: string[] = [];
  if (existsSync(MEMORY)) {
    const walk = (dir: string, prefix = ""): string[] => {
      let out: string[] = [];
      try {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${f.name}` : f.name;
          if (f.isDirectory()) out.push(...walk(join(dir, f.name), rel));
          else out.push(rel);
        }
      } catch {}
      return out;
    };
    files = walk(MEMORY)
      .filter((f) => f.endsWith(".md"))
      .sort();
  }

  const html = `
    <h1>Memory</h1>
    <div class="card"><h3>MEMORY.md</h3>
      <pre>${memoryMd ? safe(memoryMd) : '<span class="text-muted">No MEMORY.md found.</span>'}</pre>
    </div>

    <div class="card"><h3>Search Memory Files</h3>
      <form class="search-box" hx-get="/memory/search" hx-target="#search-results" hx-swap="innerHTML">
        <input type="text" name="q" placeholder="Search memory files...">
        <button type="submit">Search</button>
      </form>
      <div id="search-results"></div>
    </div>

    <div class="card"><h3>Memory Files (${files.length})</h3>
      ${
        files.length === 0
          ? '<div class="text-muted">No memory files found.</div>'
          : `<ul style="list-style:none">${files
              .map(
                (f) =>
                  `<li style="padding:3px 0"><span class="tag">${f.split("/")[0]}</span>
           <a href="/memory/view?file=${encodeURIComponent(f)}" style="color:#7c6ef0;text-decoration:none" hx-get="/memory/view?file=${encodeURIComponent(f)}" hx-target="#file-view" hx-swap="innerHTML">${safe(f)}</a></li>`,
              )
              .join("")}</ul>`
      }
    </div>
    <div id="file-view"></div>`;

  return c.html(layout("Memory", html, "memory"));
});

app.get("/memory/search", (c) => {
  const q = c.req.query("q") || "";
  if (!q) return c.html('<div class="text-muted">Enter a search term.</div>');

  const MAX_RESULTS = 20;
  const MAX_FILE_SIZE = 100 * 1024; // 100KB
  const results: { file: string; lines: string[] }[] = [];
  if (existsSync(MEMORY)) {
    const qLower = q.toLowerCase();
    const walk = (dir: string, prefix = ""): void => {
      if (results.length >= MAX_RESULTS) return;
      try {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= MAX_RESULTS) return;
          const rel = prefix ? `${prefix}/${f.name}` : f.name;
          if (f.isDirectory()) {
            walk(join(dir, f.name), rel);
            continue;
          }
          if (!f.name.endsWith(".md")) continue;
          const fullPath = join(dir, f.name);
          try {
            if (statSync(fullPath).size > MAX_FILE_SIZE) continue;
          } catch {
            continue;
          }
          const content = readFile(fullPath);
          const matching = content
            .split("\n")
            .filter((l) => l.toLowerCase().includes(qLower));
          if (matching.length > 0)
            results.push({ file: rel, lines: matching.slice(0, 3) });
        }
      } catch {}
    };
    walk(MEMORY);
  }

  if (results.length === 0)
    return c.html(`<div class="text-muted">No results for "${safe(q)}".</div>`);
  const capped =
    results.length >= MAX_RESULTS
      ? `<div class="text-muted mb-8">Showing first ${MAX_RESULTS} results. Use QMD search for comprehensive results.</div>`
      : "";
  return c.html(
    capped +
      results
        .map(
          (r) => `
    <div class="card" style="padding:10px;margin-bottom:8px">
      <strong style="color:#7c6ef0">${safe(r.file)}</strong>
      <pre style="margin-top:4px;padding:8px;font-size:12px">${r.lines.map((l) => safe(l)).join("\n")}</pre>
    </div>`,
        )
        .join(""),
  );
});

app.get("/memory/view", (c) => {
  const file = c.req.query("file") || "";
  if (!file) return c.html("");
  const resolved = resolve(join(MEMORY, file));
  if (!resolved.startsWith(MEMORY + "/"))
    return c.html('<div class="text-muted">Invalid path.</div>');
  const content = readFile(resolved);
  return c.html(
    `<div class="card"><h3>${safe(file)}</h3><pre>${safe(content) || '<span class="text-muted">Empty file.</span>'}</pre></div>`,
  );
});

// ============ JOURNAL ============
app.get("/journal", (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const date = c.req.query("date") || today;

  const html = `
    <h1>Journal</h1>
    <div class="card">
      <div class="flex mb-8">
        <input type="date" value="${date}" hx-get="/journal/content" hx-target="#journal-content" hx-swap="innerHTML"
               hx-trigger="change" hx-include="this" name="date" style="width:200px">
      </div>
      <div id="journal-content" hx-get="/journal/content?date=${date}" hx-trigger="load" hx-swap="innerHTML"></div>
    </div>`;

  return c.html(layout("Journal", html, "journal"));
});

app.get("/journal/content", (c) => {
  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);
  const path = `${MEMORY}/${date}.md`;
  const content = readFile(path);
  if (!content)
    return c.html(
      `<div class="text-muted">No journal entry for ${safe(date)}.</div>`,
    );
  return c.html(`<pre>${safe(content)}</pre>`);
});

// ============ CHAT ============
app.get("/chat", (c) => {
  const html = `
    <div class="chat-container">
      <div class="chat-messages" id="chat-messages" hx-get="/chat/conversation" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
      <form class="chat-input" hx-post="/chat" hx-target="#chat-messages" hx-swap="innerHTML" hx-on::after-request="this.reset()">
        <input type="text" name="content" placeholder="Type a message..." autocomplete="off" required>
        <button type="submit">Send</button>
      </form>
    </div>
    <script>
    document.body.addEventListener('htmx:afterSwap', function(e) {
      if (e.detail.target.id === 'chat-messages') {
        var el = e.detail.target;
        var isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
        var isPost = e.detail.requestConfig.verb === 'post';
        var isInitial = !el.dataset.loaded;
        if (isInitial) el.dataset.loaded = '1';
        if (isNearBottom || isPost || isInitial) {
          el.scrollTop = el.scrollHeight;
        }
      }
    });
    </script>`;

  return c.html(layout("Chat", html, "chat", "padding:0;max-width:none"));
});

app.get("/chat/conversation", (c) => {
  const TYPING = '<div class="typing-dots"><span></span><span></span><span></span></div><div class="chat-time">&nbsp;</div>';

  // User messages: always from DB (ground truth — JSONL entries are just trigger boilerplate)
  const dbMessages = db
    .prepare("SELECT content, created_at FROM messages WHERE channel='web' ORDER BY created_at ASC, id ASC")
    .all() as { content: string; created_at: string }[];

  // Assistant messages: from JSONL session file
  const session = db
    .prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name='web-chat' AND session_key='_default' LIMIT 1")
    .get() as any;

  let assistantMsgs: ParsedMessage[] = [];
  let isRunning = false;
  if (session) {
    const filePath = findSessionFile(session.session_id);
    if (filePath) {
      const all = parseSessionMessages(filePath);
      // Drop user-text entries from JSONL — those are trigger boilerplate, not real user text
      assistantMsgs = all.filter(m => m.type !== "user-text");
      isRunning = existsSync(`/tmp/claudec-${session.session_id}.sock`);
    }
  }

  if (dbMessages.length === 0 && assistantMsgs.length === 0) {
    return c.html('<div class="chat-bubble bot" style="opacity:0.5">Send a message to start a conversation.</div>');
  }

  // Merge: DB user messages + JSONL assistant/tool messages, sorted by timestamp
  // SQLite timestamps are "YYYY-MM-DD HH:MM:SS"; JSONL are ISO "YYYY-MM-DDTHH:MM:SS.mmmZ" — both sort correctly after normalising the space
  const combined: ParsedMessage[] = [
    ...dbMessages.map(m => ({
      type: "user-text" as const,
      content: m.content,
      timestamp: m.created_at.replace(" ", "T"),
    })),
    ...assistantMsgs,
  ];
  combined.sort((a, b) => {
    const ta = a.timestamp || "";
    const tb = b.timestamp || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    // Same timestamp: user before assistant
    return (a.type === "user-text" ? 0 : 1) - (b.type === "user-text" ? 0 : 1);
  });

  const html = renderConversation(combined);
  const lastMsg = combined[combined.length - 1];
  const isAssistantLast = lastMsg.type.startsWith("assistant-");

  // Show typing while session is being set up or actively running
  const showTyping = (!session && dbMessages.length > 0) || (!!session && isRunning);
  if (showTyping && !isAssistantLast) {
    return c.html(html + TYPING);
  }

  return c.html(html);
});

app.post("/chat", async (c) => {
  const body = await c.req.parseBody();
  const content = ((body.content as string) || "").trim();
  if (!content) return c.html("");

  const msg = db
    .prepare(
      "INSERT INTO messages (channel, sender, content) VALUES ('web', 'web-ui', ?) RETURNING *",
    )
    .get(content) as any;

  // Touch wake file
  try {
    mkdirSync(`${WS}/inbox`, { recursive: true });
    closeSync(openSync(WAKE, "w"));
  } catch {}

  // Fire trigger (like signal/email addons do)
  const payload = JSON.stringify({
    inbox_message_id: msg.id,
    sender: "web-ui",
    message: content.slice(0, 4000),
    timestamp: msg.created_at,
  });
  Bun.spawn(
    ["/atlas/app/triggers/trigger.sh", "web-chat", payload, "_default"],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  // Return all DB messages (includes the just-inserted one) + any prior assistant responses + typing indicator
  const TYPING = '<div class="typing-dots"><span></span><span></span><span></span></div><div class="chat-time">&nbsp;</div>';
  const dbMessages = db
    .prepare("SELECT content, created_at FROM messages WHERE channel='web' ORDER BY created_at ASC, id ASC")
    .all() as { content: string; created_at: string }[];

  const session = db
    .prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name='web-chat' AND session_key='_default' LIMIT 1")
    .get() as any;

  let assistantMsgs: ParsedMessage[] = [];
  if (session) {
    const filePath = findSessionFile(session.session_id);
    if (filePath) {
      const all = parseSessionMessages(filePath);
      assistantMsgs = all.filter(m => m.type !== "user-text");
    }
  }

  const combined: ParsedMessage[] = [
    ...dbMessages.map(m => ({ type: "user-text" as const, content: m.content, timestamp: m.created_at.replace(" ", "T") })),
    ...assistantMsgs,
  ];
  combined.sort((a, b) => {
    const ta = a.timestamp || "", tb = b.timestamp || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.type === "user-text" ? 0 : 1) - (b.type === "user-text" ? 0 : 1);
  });

  return c.html(renderConversation(combined) + TYPING);
});

// ============ TASKS ============
app.get("/tasks", (c) => {
  const status = c.req.query("status") || "";
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = 50;
  const offset = (page - 1) * limit;

  // Stats from tasks table
  const taskStatusCounts = db
    .prepare("SELECT status, COUNT(*) as c FROM tasks GROUP BY status")
    .all() as any[];
  const tc: Record<string, number> = {};
  for (const row of taskStatusCounts) {
    tc[row.status] = row.c;
  }

  // Filtered query
  let countSql = "SELECT COUNT(*) as c FROM tasks";
  let sql = "SELECT * FROM tasks";
  const params: any[] = [];
  if (status) {
    countSql += " WHERE status = ?";
    sql += " WHERE status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

  const total = (db.prepare(countSql).get(...params) as any)?.c || 0;
  const tasks = db.prepare(sql).all(...params, limit, offset) as any[];
  const totalPages = Math.ceil(total / limit);

  // Active awaits
  const awaits = db
    .prepare(
      `SELECT ta.task_id, ta.trigger_name, ta.session_key, ta.created_at, t.status as task_status, t.content
     FROM task_awaits ta JOIN tasks t ON ta.task_id = t.id
     WHERE t.status IN ('pending', 'processing')
     ORDER BY ta.created_at DESC`,
    )
    .all() as any[];

  const filters = ["", "pending", "processing", "done", "cancelled"];
  const filterHtml = filters
    .map(
      (f) =>
        `<a href="/tasks${f ? "?status=" + f : ""}" class="btn btn-sm ${status === f ? "" : "btn-outline"}" style="margin-right:4px">${f || "All"}</a>`,
    )
    .join("");

  const qs = status ? `&status=${status}` : "";
  const paginationHtml =
    totalPages > 1
      ? `<div class="flex mt-8" style="justify-content:space-between">
    <span class="text-muted">Page ${page} of ${totalPages} (${total} tasks)</span>
    <span>${page > 1 ? `<a href="/tasks?page=${page - 1}${qs}" class="btn btn-sm btn-outline">Prev</a> ` : ""}${page < totalPages ? `<a href="/tasks?page=${page + 1}${qs}" class="btn btn-sm btn-outline">Next</a>` : ""}</span>
  </div>`
      : "";

  const html = `
    <h1>Tasks</h1>
    <div class="grid">
      <div class="stat"><div class="num" style="color:#ff9800">${tc["pending"] || 0}</div><div class="label">Pending</div></div>
      <div class="stat"><div class="num" style="color:#5c9cf5">${tc["processing"] || 0}</div><div class="label">Processing</div></div>
      <div class="stat"><div class="num" style="color:#4caf50">${tc["done"] || 0}</div><div class="label">Done</div></div>
      <div class="stat"><div class="num" style="color:#999">${tc["cancelled"] || 0}</div><div class="label">Cancelled</div></div>
    </div>

    ${
      awaits.length > 0
        ? `<div class="card mb-16"><h3>Active Awaits</h3>
      <table>
        <tr><th>Task</th><th>Trigger</th><th>Key</th><th>Status</th><th>Waiting Since</th></tr>
        ${awaits
          .map(
            (a) => `<tr>
          <td>#${a.task_id}</td>
          <td>${safe(a.trigger_name)}</td>
          <td><code>${safe(a.session_key)}</code></td>
          <td><span class="badge" style="background:${statusColor(a.task_status)}20;color:${statusColor(a.task_status)}">${a.task_status}</span></td>
          <td class="text-muted">${timeAgo(a.created_at)}</td>
        </tr>`,
          )
          .join("")}
      </table>
    </div>`
        : ""
    }

    <div class="mb-16">${filterHtml}</div>
    <table>
      <tr><th>ID</th><th>Trigger</th><th>Content</th><th>Status</th><th>Response</th><th>Created</th></tr>
      ${tasks
        .map(
          (t) => `
        <tr class="msg-row" hx-get="/tasks/${t.id}" hx-target="#task-detail-${t.id}" hx-swap="innerHTML">
          <td>#${t.id}</td>
          <td><span class="badge" style="background:#7c6ef020;color:#7c6ef0">${safe(t.trigger_name)}</span></td>
          <td>${safe((t.content || "").slice(0, 80))}${t.content?.length > 80 ? "..." : ""}</td>
          <td><span class="badge" style="background:${statusColor(t.status)}20;color:${statusColor(t.status)}">${t.status}</span></td>
          <td class="text-muted">${t.response_summary ? safe(t.response_summary.slice(0, 60)) + (t.response_summary.length > 60 ? "..." : "") : "-"}</td>
          <td class="text-muted">${timeAgo(t.created_at)}</td>
        </tr>
        <tr id="task-detail-${t.id}"></tr>
      `,
        )
        .join("")}
    </table>
    ${tasks.length === 0 ? '<div class="card text-muted">No tasks found.</div>' : ""}
    ${paginationHtml}`;

  return c.html(layout("Tasks", html, "tasks"));
});

app.get("/tasks/:id", (c) => {
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(c.req.param("id")) as any;
  if (!task) return c.html("<td colspan=6>Not found</td>");

  const awaiter = db
    .prepare("SELECT * FROM task_awaits WHERE task_id = ?")
    .get(task.id) as any;

  return c.html(`<td colspan="6"><div class="msg-detail">
    <strong>ID:</strong> ${task.id} | <strong>Trigger:</strong> ${safe(task.trigger_name)} | <strong>Status:</strong> ${task.status}
    <br><strong>Created:</strong> ${task.created_at}
    ${task.processed_at ? `| <strong>Processed:</strong> ${task.processed_at}` : ""}
    ${awaiter ? `<br><strong>Awaited by:</strong> ${safe(awaiter.trigger_name)} (key: ${safe(awaiter.session_key)})` : ""}
    <hr style="border-color:#3a3b55;margin:8px 0">
    <strong>Content:</strong>
<pre style="margin:4px 0;white-space:pre-wrap">${safe(task.content)}</pre>
    ${
      task.response_summary
        ? `<hr style="border-color:#3a3b55;margin:8px 0"><strong>Response:</strong>
<pre style="margin:4px 0;white-space:pre-wrap">${safe(task.response_summary)}</pre>`
        : ""
    }
  </div></td>`);
});

// ============ SETTINGS ============
app.get("/settings", (c) => {
  const flash = c.req.query("saved");
  const identity = readFile(IDENTITY);
  const config = readFile(CONFIG);
  const extensions = readFile(EXTENSIONS);

  const triggerCount =
    (db.prepare("SELECT COUNT(*) as c FROM triggers").get() as any)?.c || 0;

  const html = `
    <h1>Settings</h1>
    ${flash ? `<div class="flash flash-ok">Saved ${safe(flash)} successfully.</div>` : ""}

    <div class="card"><h3>IDENTITY.md</h3>
      <form method="POST" action="/settings/identity">
        <textarea name="content" rows="8">${safe(identity)}</textarea>
        <button type="submit" class="mt-8">Save Identity</button>
      </form>
    </div>

    <div class="card"><h3>config.yml</h3>
      <form method="POST" action="/settings/config">
        <textarea name="content" rows="8">${safe(config)}</textarea>
        <button type="submit" class="mt-8">Save Config</button>
      </form>
    </div>

    <div class="card"><h3>user-extensions.sh</h3>
      <form method="POST" action="/settings/extensions">
        <textarea name="content" rows="8">${safe(extensions)}</textarea>
        <button type="submit" class="mt-8">Save Extensions</button>
      </form>
    </div>

    <div class="card"><h3>Triggers</h3>
      <div class="text-muted">${triggerCount} trigger(s) configured. <a href="/triggers" style="color:#7c6ef0">Manage Triggers &rarr;</a></div>
    </div>`;

  return c.html(layout("Settings", html, "settings"));
});

app.post("/settings/identity", async (c) => {
  const body = await c.req.parseBody();
  const content = (body.content as string) || "";
  mkdirSync(WS, { recursive: true });
  writeFileSync(IDENTITY, content);
  return c.redirect("/settings?saved=identity");
});

app.post("/settings/config", async (c) => {
  const body = await c.req.parseBody();
  const content = (body.content as string) || "";
  mkdirSync(WS, { recursive: true });
  writeFileSync(CONFIG, content);
  return c.redirect("/settings?saved=config");
});

app.post("/settings/extensions", async (c) => {
  const body = await c.req.parseBody();
  const content = (body.content as string) || "";
  mkdirSync(WS, { recursive: true });
  writeFileSync(EXTENSIONS, content);
  return c.redirect("/settings?saved=extensions");
});

// --- Analytics ---
app.get("/analytics", (c) => {
  let metrics: any[] = [];
  let totals: any = { total_cost: 0, total_tokens: 0, total_sessions: 0 };
  let week: any = { week_cost: 0 };
  try {
    metrics = db.prepare(
      `SELECT * FROM session_metrics ORDER BY created_at DESC LIMIT 100`
    ).all() as any[];
    totals = db.prepare(`
      SELECT
        SUM(cost_usd) as total_cost,
        SUM(input_tokens + output_tokens) as total_tokens,
        COUNT(*) as total_sessions
      FROM session_metrics
    `).get() as any || totals;
    week = db.prepare(`
      SELECT SUM(cost_usd) as week_cost
      FROM session_metrics
      WHERE created_at >= datetime('now', '-7 days')
    `).get() as any || week;
  } catch {}

  function fmtCost(v: number | null): string {
    return v != null ? `$${(v).toFixed(4)}` : "$0.0000";
  }
  function fmtNum(v: number | null): string {
    if (!v) return "0";
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(v);
  }
  function fmtDuration(ms: number): string {
    if (!ms) return "—";
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  function typeBadge(t: string): string {
    const colors: Record<string, string> = {
      worker: "#5c9cf5",
      trigger: "#7c6ef0",
      "trigger-relay": "#ff9800",
    };
    return `<span class="badge" style="background:${colors[t] || "#3a3b55"};color:#fff">${safe(t)}</span>`;
  }

  const rows = metrics.map((m) => `
    <tr>
      <td class="text-muted">${safe(timeAgo(m.created_at))}</td>
      <td>${typeBadge(m.session_type)}</td>
      <td>${m.trigger_name ? safe(m.trigger_name) : '<span class="text-muted">—</span>'}</td>
      <td>${fmtDuration(m.duration_ms)}</td>
      <td>${fmtNum(m.input_tokens)}</td>
      <td>${fmtNum(m.output_tokens)}</td>
      <td>${fmtNum(m.cache_read_tokens)}</td>
      <td>${fmtCost(m.cost_usd)}</td>
      <td><span class="dot" style="background:${m.is_error ? '#f44336' : '#4caf50'}"></span>${m.is_error ? 'error' : 'ok'}</td>
    </tr>`).join("");

  const html = `
    <h1>Analytics</h1>
    <div class="grid" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat"><div class="num">${fmtCost(totals.total_cost)}</div><div class="label">Total Cost</div></div>
      <div class="stat"><div class="num">${fmtCost(week.week_cost)}</div><div class="label">Cost (7d)</div></div>
      <div class="stat"><div class="num">${totals.total_sessions || 0}</div><div class="label">Total Sessions</div></div>
      <div class="stat"><div class="num">${fmtNum(totals.total_tokens)}</div><div class="label">Total Tokens</div></div>
    </div>
    <div class="card">
      <h3>Recent Sessions</h3>
      ${metrics.length === 0
        ? '<div class="text-muted">No session metrics yet. Sessions are recorded after the first Claude invocation.</div>'
        : `<table>
        <thead><tr>
          <th>Time</th><th>Type</th><th>Trigger</th><th>Duration</th>
          <th>Input</th><th>Output</th><th>Cache Hits</th><th>Cost</th><th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`}
    </div>`;

  return c.html(layout("Analytics", html, "analytics"));
});

// --- Start ---
export default {
  port: 3000,
  fetch: app.fetch,
};

console.log("Atlas Web-UI running on http://localhost:3000");
