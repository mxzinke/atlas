import { Hono } from "hono";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, closeSync, openSync, statSync } from "fs";
import { join, resolve } from "path";
import { getDb } from "../inbox-mcp/db";

// --- Config ---
const WS = "/atlas/workspace";
const MEMORY = `${WS}/memory`;
const IDENTITY = `${WS}/identity.md`;
const CONFIG = `${WS}/config.yml`;
const EXTENSIONS = `${WS}/user-extensions.sh`;
const LOCK = `${WS}/.session-running`;
const WAKE = `${WS}/inbox/.wake`;

function syncCrontab(): void {
  try { Bun.spawnSync(["bun", "run", "/atlas/app/triggers/sync-crontab.ts"]); } catch {}
}

const db = getDb();

// --- Helpers ---
function safe(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function readFile(p: string): string {
  try { return readFileSync(p, "utf-8"); } catch { return ""; }
}

function channelIcon(ch: string): string {
  const icons: Record<string, string> = { signal: "S", email: "@", web: "W", internal: "I" };
  return icons[ch] || "?";
}

function statusColor(s: string): string {
  return s === "pending" ? "#ff9800" : s === "processing" ? "#5c9cf5" : s === "cancelled" ? "#999" : "#4caf50";
}

function timeAgo(dt: string): string {
  if (!dt) return "";
  const diff = Date.now() - new Date(dt + "Z").getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// --- Layout ---
function layout(title: string, content: string, active: string = ""): string {
  const nav = [
    ["/", "Dashboard", "dashboard"],
    ["/inbox", "Inbox", "inbox"],
    ["/tasks", "Tasks", "tasks"],
    ["/triggers", "Triggers", "triggers"],
    ["/memory", "Memory", "memory"],
    ["/journal", "Journal", "journal"],
    ["/chat", "Chat", "chat"],
    ["/settings", "Settings", "settings"],
  ];
  const links = nav.map(([href, label, id]) =>
    `<a href="${href}" class="${active === id ? "active" : ""}">${label}</a>`
  ).join("");

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
</style></head><body>
<nav><div class="logo">ATLAS</div>${links}</nav>
<main>${content}</main>
</body></html>`;
}

// --- App ---
const app = new Hono();

// ============ DASHBOARD ============
app.get("/", (c) => {
  const sessionRunning = existsSync(LOCK);
  const statusCounts = db.prepare("SELECT status, COUNT(*) as c FROM messages GROUP BY status").all() as any[];
  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of statusCounts) { counts[row.status] = row.c; total += row.c; }
  const pending = counts["pending"] || 0;
  const done = counts["done"] || 0;

  // Recent journal files (YYYY-MM-DD.md directly in memory/)
  let journals: string[] = [];
  if (existsSync(MEMORY)) {
    journals = readdirSync(MEMORY)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort().reverse().slice(0, 5);
  }

  // Recent messages
  const recent = db.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 5").all() as any[];

  const html = `
    <h1>Dashboard</h1>
    <div class="grid">
      <div class="stat">
        <div class="num" style="color:${sessionRunning ? '#4caf50' : '#999'}">${sessionRunning ? "ON" : "OFF"}</div>
        <div class="label">Session</div>
      </div>
      <div class="stat"><div class="num">${pending}</div><div class="label">Pending</div></div>
      <div class="stat"><div class="num">${done}</div><div class="label">Done</div></div>
      <div class="stat"><div class="num">${total}</div><div class="label">Total Messages</div></div>
    </div>

    <div class="card"><h3>Recent Messages</h3>
    ${recent.length === 0 ? '<div class="text-muted">No messages yet.</div>' : `<table>
      <tr><th>CH</th><th>Sender</th><th>Content</th><th>Status</th><th>Time</th></tr>
      ${recent.map(m => `<tr>
        <td><span class="ch-icon">${channelIcon(m.channel)}</span></td>
        <td>${safe(m.sender || "-")}</td>
        <td>${safe((m.content || "").slice(0, 60))}${m.content?.length > 60 ? "..." : ""}</td>
        <td><span class="badge" style="background:${statusColor(m.status)}20;color:${statusColor(m.status)}">${m.status}</span></td>
        <td class="text-muted">${timeAgo(m.created_at)}</td>
      </tr>`).join("")}
    </table>`}</div>

    <div class="card"><h3>Recent Journals</h3>
    ${journals.length === 0 ? '<div class="text-muted">No journal entries yet.</div>' :
      `<ul style="list-style:none">${journals.map(j => {
        const d = j.replace(".md", "");
        return `<li style="padding:4px 0"><a href="/journal?date=${d}" style="color:#7c6ef0;text-decoration:none">${d}</a></li>`;
      }).join("")}</ul>`}
    </div>`;

  return c.html(layout("Dashboard", html, "dashboard"));
});

// ============ INBOX ============
app.get("/inbox", (c) => {
  const status = c.req.query("status") || "";
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = 100;
  const offset = (page - 1) * limit;

  let countSql = "SELECT COUNT(*) as c FROM messages";
  let sql = "SELECT * FROM messages";
  const params: any[] = [];
  if (status) { countSql += " WHERE status = ?"; sql += " WHERE status = ?"; params.push(status); }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

  const total = (db.prepare(countSql).get(...params) as any)?.c || 0;
  const msgs = db.prepare(sql).all(...params, limit, offset) as any[];
  const totalPages = Math.ceil(total / limit);

  const filters = ["", "pending", "processing", "done", "cancelled"];
  const filterHtml = filters.map(f =>
    `<a href="/inbox${f ? '?status='+f : ''}" class="btn btn-sm ${status === f ? '' : 'btn-outline'}" style="margin-right:4px">${f || "All"}</a>`
  ).join("");

  const qs = status ? `&status=${status}` : "";
  const paginationHtml = totalPages > 1 ? `<div class="flex mt-8" style="justify-content:space-between">
    <span class="text-muted">Page ${page} of ${totalPages} (${total} messages)</span>
    <span>${page > 1 ? `<a href="/inbox?page=${page - 1}${qs}" class="btn btn-sm btn-outline">Prev</a> ` : ""}${page < totalPages ? `<a href="/inbox?page=${page + 1}${qs}" class="btn btn-sm btn-outline">Next</a>` : ""}</span>
  </div>` : "";

  const html = `
    <h1>Inbox</h1>
    <div class="mb-16">${filterHtml}</div>
    <table>
      <tr><th>CH</th><th>Sender</th><th>Content</th><th>Status</th><th>Time</th></tr>
      ${msgs.map(m => `
        <tr class="msg-row" hx-get="/inbox/${m.id}" hx-target="#detail-${m.id}" hx-swap="innerHTML">
          <td><span class="ch-icon">${channelIcon(m.channel)}</span></td>
          <td>${safe(m.sender || "-")}</td>
          <td>${safe((m.content || "").slice(0, 80))}${m.content?.length > 80 ? "..." : ""}</td>
          <td><span class="badge" style="background:${statusColor(m.status)}20;color:${statusColor(m.status)}">${m.status}</span></td>
          <td class="text-muted">${timeAgo(m.created_at)}</td>
        </tr>
        <tr id="detail-${m.id}"></tr>
      `).join("")}
    </table>
    ${msgs.length === 0 ? '<div class="card text-muted">No messages found.</div>' : ''}
    ${paginationHtml}`;

  return c.html(layout("Inbox", html, "inbox"));
});

app.get("/inbox/:id", (c) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(c.req.param("id")) as any;
  if (!msg) return c.html("<td colspan=5>Not found</td>");
  return c.html(`<td colspan="5"><div class="msg-detail">
    <strong>ID:</strong> ${msg.id} | <strong>Channel:</strong> ${msg.channel} | <strong>Sender:</strong> ${safe(msg.sender || "-")}
    <strong>Created:</strong> ${msg.created_at} | <strong>Status:</strong> ${msg.status}
    ${msg.processed_at ? `| <strong>Processed:</strong> ${msg.processed_at}` : ""}
    <hr style="border-color:#3a3b55;margin:8px 0">
    <strong>Content:</strong>
${safe(msg.content)}
    ${msg.response_summary ? `<hr style="border-color:#3a3b55;margin:8px 0"><strong>Response:</strong>\n${safe(msg.response_summary)}` : ""}
  </div></td>`);
});

// ============ TRIGGERS ============

function triggerTypeIcon(type: string): string {
  return type === "cron" ? "&#9200;" : type === "webhook" ? "&#9889;" : "&#9654;";
}

function triggerRow(t: any): string {
  return `<tr>
    <td>${triggerTypeIcon(t.type)} ${safe(t.type)}</td>
    <td><strong>${safe(t.name)}</strong>${t.description ? `<br><span class="text-muted">${safe(t.description)}</span>` : ""}</td>
    <td>${t.type === "cron" ? `<code>${safe(t.schedule || "-")}</code>` :
         t.type === "webhook" ? `<code>/api/webhook/${safe(t.name)}</code>` : "-"}</td>
    <td><span class="dot" style="background:${t.enabled ? '#4caf50' : '#999'}"></span>${t.enabled ? 'On' : 'Off'}</td>
    <td class="text-muted">${t.last_run ? timeAgo(t.last_run) : "never"} (${t.run_count || 0}x)</td>
    <td class="flex">
      <button class="btn btn-sm btn-outline" hx-post="/triggers/${t.id}/toggle" hx-target="#trigger-list" hx-swap="innerHTML">
        ${t.enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn btn-sm btn-outline" hx-post="/triggers/${t.id}/run" hx-target="#trigger-list" hx-swap="innerHTML">
        Run</button>
      <a href="/triggers/${t.id}/edit" class="btn btn-sm btn-outline">Edit</a>
      <button class="btn btn-sm btn-outline" style="color:#f44336;border-color:#f44336"
        hx-delete="/triggers/${t.id}" hx-target="#trigger-list" hx-swap="innerHTML"
        hx-confirm="Delete trigger '${safe(t.name)}'?">Del</button>
    </td>
  </tr>`;
}

app.get("/triggers", (c) => {
  const flash = c.req.query("msg");
  const triggers = db.prepare("SELECT * FROM triggers ORDER BY type, name").all() as any[];

  const html = `
    <h1>Triggers</h1>
    ${flash ? `<div class="flash flash-ok">${safe(flash)}</div>` : ""}
    <div class="flex mb-16">
      <a href="/triggers/new" class="btn">+ New Trigger</a>
    </div>
    <div class="card" id="trigger-list">
      ${triggers.length === 0 ? '<div class="text-muted">No triggers configured. Create one to get started.</div>' :
        `<table>
          <tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
          ${triggers.map(t => triggerRow(t)).join("")}
        </table>`}
    </div>

    <div class="card"><h3>How Triggers Work</h3>
      <div class="text-muted" style="font-size:12px;line-height:1.6">
        <strong>Cron:</strong> Runs on schedule via supercronic. Example: <code>0 * * * *</code> = every hour.<br>
        <strong>Webhook:</strong> POST to <code>/api/webhook/&lt;name&gt;</code> with optional <code>X-Webhook-Secret</code> header. Payload replaces <code>{{payload}}</code> in prompt.<br>
        <strong>Manual:</strong> Click "Run" to trigger immediately.<br>
        All triggers write a message to the inbox and wake Claude.
      </div>
    </div>`;

  return c.html(layout("Triggers", html, "triggers"));
});

app.get("/triggers/new", (c) => {
  const html = `
    <h1>New Trigger</h1>
    <div class="card">
      <form method="POST" action="/triggers">
        <div class="mb-8">
          <label class="text-muted">Name (slug)</label>
          <input type="text" name="name" placeholder="github-check" required pattern="[a-z0-9_-]+" title="Lowercase, dashes, underscores only">
        </div>
        <div class="mb-8">
          <label class="text-muted">Type</label>
          <select name="type" id="trigger-type" onchange="document.getElementById('cron-field').style.display=this.value==='cron'?'block':'none';document.getElementById('webhook-field').style.display=this.value==='webhook'?'block':'none'">
            <option value="cron">Cron (scheduled)</option>
            <option value="webhook">Webhook (HTTP endpoint)</option>
            <option value="manual">Manual (run on demand)</option>
          </select>
        </div>
        <div class="mb-8">
          <label class="text-muted">Description</label>
          <input type="text" name="description" placeholder="What does this trigger do?">
        </div>
        <div class="mb-8" id="cron-field">
          <label class="text-muted">Cron Schedule</label>
          <input type="text" name="schedule" placeholder="0 * * * *">
          <div class="text-muted" style="font-size:11px;margin-top:4px">min hour dom month dow — Examples: <code>*/15 * * * *</code> (every 15min), <code>0 9 * * 1-5</code> (weekdays 9am)</div>
        </div>
        <div class="mb-8" id="webhook-field" style="display:none">
          <label class="text-muted">Webhook Secret (optional)</label>
          <div class="flex">
            <input type="text" name="webhook_secret" id="ws-input" placeholder="Leave empty for no auth">
            <button type="button" class="btn btn-sm btn-outline" onclick="document.getElementById('ws-input').value=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('')">Generate</button>
          </div>
        </div>
        <div class="mb-8">
          <label class="text-muted">Channel</label>
          <input type="text" name="channel" value="internal" placeholder="internal">
        </div>
        <div class="mb-8">
          <label class="text-muted">Prompt Template</label>
          <textarea name="prompt" rows="6" placeholder="What should Claude do when this trigger fires? Use {{payload}} for webhook data."></textarea>
        </div>
        <button type="submit">Create Trigger</button>
      </form>
    </div>`;

  return c.html(layout("New Trigger", html, "triggers"));
});

app.post("/triggers", async (c) => {
  const body = await c.req.parseBody();
  const name = (body.name as string || "").trim();
  const type = body.type as string || "manual";
  const description = (body.description as string || "").trim();
  const channel = (body.channel as string || "internal").trim();
  const schedule = (body.schedule as string || "").trim() || null;
  const webhook_secret = (body.webhook_secret as string || "").trim() || null;
  const prompt = (body.prompt as string || "").trim();

  if (!name || !/^[a-z0-9_-]+$/.test(name)) return c.redirect("/triggers/new?err=name");
  if (schedule && !/^[\d\s*\/,-]+$/.test(schedule)) return c.redirect("/triggers/new?err=schedule");

  try {
    db.prepare(
      `INSERT INTO triggers (name, type, description, channel, schedule, webhook_secret, prompt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(name, type, description, channel, schedule, webhook_secret, prompt);
  } catch (err: any) {
    return c.redirect(`/triggers?msg=Error: ${err.message}`);
  }

  if (type === "cron") syncCrontab();

  return c.redirect(`/triggers?msg=Trigger '${name}' created`);
});

app.get("/triggers/:id/edit", (c) => {
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(c.req.param("id")) as any;
  if (!t) return c.redirect("/triggers?msg=Trigger not found");

  const html = `
    <h1>Edit: ${safe(t.name)}</h1>
    <div class="card">
      <form method="POST" action="/triggers/${t.id}/update">
        <div class="mb-8">
          <label class="text-muted">Name</label>
          <input type="text" value="${safe(t.name)}" disabled>
          <input type="hidden" name="name" value="${safe(t.name)}">
        </div>
        <div class="mb-8">
          <label class="text-muted">Type: ${safe(t.type)}</label>
        </div>
        <div class="mb-8">
          <label class="text-muted">Description</label>
          <input type="text" name="description" value="${safe(t.description || "")}">
        </div>
        ${t.type === "cron" ? `<div class="mb-8">
          <label class="text-muted">Cron Schedule</label>
          <input type="text" name="schedule" value="${safe(t.schedule || "")}">
        </div>` : ""}
        ${t.type === "webhook" ? `<div class="mb-8">
          <label class="text-muted">Webhook Secret</label>
          <input type="text" name="webhook_secret" value="${safe(t.webhook_secret || "")}">
          <div class="text-muted" style="font-size:11px;margin-top:4px">URL: <code>/api/webhook/${safe(t.name)}</code></div>
        </div>` : ""}
        <div class="mb-8">
          <label class="text-muted">Channel</label>
          <input type="text" name="channel" value="${safe(t.channel || "internal")}">
        </div>
        <div class="mb-8">
          <label class="text-muted">Prompt Template</label>
          <textarea name="prompt" rows="6">${safe(t.prompt || "")}</textarea>
        </div>
        <div class="flex">
          <button type="submit">Save</button>
          <a href="/triggers" class="btn btn-outline">Cancel</a>
        </div>
      </form>
    </div>`;

  return c.html(layout(`Edit ${t.name}`, html, "triggers"));
});

app.post("/triggers/:id/update", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (!t) return c.redirect("/triggers?msg=Trigger not found");

  const updates: string[] = [];
  const params: unknown[] = [];

  for (const field of ["description", "channel", "schedule", "webhook_secret", "prompt"]) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`);
      params.push((body[field] as string || "").trim() || null);
    }
  }

  if (updates.length > 0) {
    params.push(id);
    db.prepare(`UPDATE triggers SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    if (t.type === "cron") syncCrontab();
  }

  return c.redirect(`/triggers?msg=Trigger '${t.name}' updated`);
});

app.post("/triggers/:id/toggle", (c) => {
  const id = c.req.param("id");
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (!t) return c.html('<div class="text-muted">Not found</div>');

  db.prepare("UPDATE triggers SET enabled = ? WHERE id = ?").run(t.enabled ? 0 : 1, id);
  if (t.type === "cron") syncCrontab();

  const triggers = db.prepare("SELECT * FROM triggers ORDER BY type, name").all() as any[];
  return c.html(triggers.length === 0 ? '<div class="text-muted">No triggers.</div>' :
    `<table><tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
     ${triggers.map(t => triggerRow(t)).join("")}</table>`);
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

  const triggers = db.prepare("SELECT * FROM triggers ORDER BY type, name").all() as any[];
  return c.html(
    `<table><tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
     ${triggers.map(t => triggerRow(t)).join("")}</table>`);
});

app.delete("/triggers/:id", (c) => {
  const id = c.req.param("id");
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (t) {
    db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
    if (t.type === "cron") syncCrontab();
  }

  const triggers = db.prepare("SELECT * FROM triggers ORDER BY type, name").all() as any[];
  return c.html(triggers.length === 0 ? '<div class="text-muted">No triggers configured.</div>' :
    `<table><tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
     ${triggers.map(t => triggerRow(t)).join("")}</table>`);
});

// ============ WEBHOOK API ============
app.post("/api/webhook/:name", async (c) => {
  const name = c.req.param("name");
  const t = db.prepare("SELECT * FROM triggers WHERE name = ? AND type = 'webhook'").get(name) as any;

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

  return c.json({ ok: true, trigger: name, message: "Webhook received, Claude will process it" });
});

// ============ MEMORY ============
app.get("/memory", (c) => {
  const memoryMd = readFile(`${MEMORY}/MEMORY.md`) || readFile(`${WS}/MEMORY.md`);

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
    files = walk(MEMORY).filter(f => f.endsWith(".md")).sort();
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
      ${files.length === 0 ? '<div class="text-muted">No memory files found.</div>' :
        `<ul style="list-style:none">${files.map(f =>
          `<li style="padding:3px 0"><span class="tag">${f.split("/")[0]}</span>
           <a href="/memory/view?file=${encodeURIComponent(f)}" style="color:#7c6ef0;text-decoration:none" hx-get="/memory/view?file=${encodeURIComponent(f)}" hx-target="#file-view" hx-swap="innerHTML">${safe(f)}</a></li>`
        ).join("")}</ul>`}
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
          if (f.isDirectory()) { walk(join(dir, f.name), rel); continue; }
          if (!f.name.endsWith(".md")) continue;
          const fullPath = join(dir, f.name);
          try { if (statSync(fullPath).size > MAX_FILE_SIZE) continue; } catch { continue; }
          const content = readFile(fullPath);
          const matching = content.split("\n").filter(l => l.toLowerCase().includes(qLower));
          if (matching.length > 0) results.push({ file: rel, lines: matching.slice(0, 3) });
        }
      } catch {}
    };
    walk(MEMORY);
  }

  if (results.length === 0) return c.html(`<div class="text-muted">No results for "${safe(q)}".</div>`);
  const capped = results.length >= MAX_RESULTS ? `<div class="text-muted mb-8">Showing first ${MAX_RESULTS} results. Use QMD search for comprehensive results.</div>` : "";
  return c.html(capped + results.map(r => `
    <div class="card" style="padding:10px;margin-bottom:8px">
      <strong style="color:#7c6ef0">${safe(r.file)}</strong>
      <pre style="margin-top:4px;padding:8px;font-size:12px">${r.lines.map(l => safe(l)).join("\n")}</pre>
    </div>`).join(""));
});

app.get("/memory/view", (c) => {
  const file = c.req.query("file") || "";
  if (!file) return c.html("");
  const resolved = resolve(join(MEMORY, file));
  if (!resolved.startsWith(MEMORY + "/")) return c.html('<div class="text-muted">Invalid path.</div>');
  const content = readFile(resolved);
  return c.html(`<div class="card"><h3>${safe(file)}</h3><pre>${safe(content) || '<span class="text-muted">Empty file.</span>'}</pre></div>`);
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
  if (!content) return c.html(`<div class="text-muted">No journal entry for ${safe(date)}.</div>`);
  return c.html(`<pre>${safe(content)}</pre>`);
});

// ============ CHAT ============
app.get("/chat", (c) => {
  const html = `
    <h1>Chat</h1>
    <div class="card">
      <form hx-post="/chat" hx-target="#chat-messages" hx-swap="innerHTML" hx-on::after-request="this.reset()">
        <div class="flex">
          <input type="text" name="content" placeholder="Type a message..." autocomplete="off" required style="flex:1">
          <button type="submit">Send</button>
        </div>
      </form>
    </div>
    <div id="chat-messages" hx-get="/chat/messages" hx-trigger="load, every 3s" hx-swap="innerHTML"></div>`;

  return c.html(layout("Chat", html, "chat"));
});

app.get("/chat/messages", (c) => {
  const msgs = db.prepare(
    "SELECT * FROM messages WHERE channel='web' ORDER BY created_at DESC LIMIT 30"
  ).all() as any[];
  return c.html(msgs.map(m => chatBubble(m)).join(""));
});

function chatBubble(m: any): string {
  const isWaiting = m.sender === "web-ui" && (m.status === "pending" || m.status === "processing") && !m.response_summary;
  return `<div class="card" style="margin-bottom:8px">
    <div class="flex" style="justify-content:space-between">
      <span class="flex"><span class="dot" style="background:${statusColor(m.status)}"></span>
        <strong>${safe(m.sender || "You")}</strong></span>
      <span class="text-muted">${timeAgo(m.created_at)}</span>
    </div>
    <div style="margin-top:6px">${safe(m.content)}</div>
    ${isWaiting ? `<div style="margin-top:8px;padding:8px;background:#1a1b2e;border-radius:4px;border-left:2px solid #ff9800">
      <span style="color:#ff9800">Thinking...</span></div>` : ""}
    ${m.response_summary ? `<div style="margin-top:8px;padding:8px;background:#1a1b2e;border-radius:4px;border-left:2px solid #7c6ef0">
      <span class="text-muted">Response:</span><br>${safe(m.response_summary)}</div>` : ""}
  </div>`;
}

app.post("/chat", async (c) => {
  const body = await c.req.parseBody();
  const content = (body.content as string || "").trim();
  if (!content) return c.html("");

  const msg = db.prepare(
    "INSERT INTO messages (channel, sender, content) VALUES ('web', 'web-ui', ?) RETURNING *"
  ).get(content) as any;

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
  Bun.spawn(["/atlas/app/triggers/trigger.sh", "web-chat", payload, "_default"], {
    stdout: "ignore", stderr: "ignore",
  });

  // Return updated message list (polling will keep it fresh)
  const msgs = db.prepare(
    "SELECT * FROM messages WHERE channel='web' ORDER BY created_at DESC LIMIT 30"
  ).all() as any[];
  return c.html(msgs.map(m => chatBubble(m)).join(""));
});

// ============ TASKS ============
app.get("/tasks", (c) => {
  const status = c.req.query("status") || "";
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = 50;
  const offset = (page - 1) * limit;

  // Stats
  const taskCounts = db.prepare(
    "SELECT status, COUNT(*) as c FROM messages WHERE channel='task' GROUP BY status"
  ).all() as any[];
  const tc: Record<string, number> = {};
  let taskTotal = 0;
  for (const row of taskCounts) { tc[row.status] = row.c; taskTotal += row.c; }

  // Filtered query
  let countSql = "SELECT COUNT(*) as c FROM messages WHERE channel='task'";
  let sql = "SELECT * FROM messages WHERE channel='task'";
  const params: any[] = [];
  if (status) { countSql += " AND status = ?"; sql += " AND status = ?"; params.push(status); }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

  const total = (db.prepare(countSql).get(...params) as any)?.c || 0;
  const tasks = db.prepare(sql).all(...params, limit, offset) as any[];
  const totalPages = Math.ceil(total / limit);

  // Active awaits
  const awaits = db.prepare(
    `SELECT ta.task_id, ta.trigger_name, ta.session_key, ta.created_at, m.status as task_status, m.content
     FROM task_awaits ta JOIN messages m ON ta.task_id = m.id
     WHERE m.status IN ('pending', 'processing')
     ORDER BY ta.created_at DESC`
  ).all() as any[];

  const filters = ["", "pending", "processing", "done", "cancelled"];
  const filterHtml = filters.map(f =>
    `<a href="/tasks${f ? '?status='+f : ''}" class="btn btn-sm ${status === f ? '' : 'btn-outline'}" style="margin-right:4px">${f || "All"}</a>`
  ).join("");

  const qs = status ? `&status=${status}` : "";
  const paginationHtml = totalPages > 1 ? `<div class="flex mt-8" style="justify-content:space-between">
    <span class="text-muted">Page ${page} of ${totalPages} (${total} tasks)</span>
    <span>${page > 1 ? `<a href="/tasks?page=${page - 1}${qs}" class="btn btn-sm btn-outline">Prev</a> ` : ""}${page < totalPages ? `<a href="/tasks?page=${page + 1}${qs}" class="btn btn-sm btn-outline">Next</a>` : ""}</span>
  </div>` : "";

  const html = `
    <h1>Tasks</h1>
    <div class="grid">
      <div class="stat"><div class="num" style="color:#ff9800">${tc["pending"] || 0}</div><div class="label">Pending</div></div>
      <div class="stat"><div class="num" style="color:#5c9cf5">${tc["processing"] || 0}</div><div class="label">Processing</div></div>
      <div class="stat"><div class="num" style="color:#4caf50">${tc["done"] || 0}</div><div class="label">Done</div></div>
      <div class="stat"><div class="num" style="color:#999">${tc["cancelled"] || 0}</div><div class="label">Cancelled</div></div>
    </div>

    ${awaits.length > 0 ? `<div class="card mb-16"><h3>Active Awaits</h3>
      <table>
        <tr><th>Task</th><th>Trigger</th><th>Key</th><th>Status</th><th>Waiting Since</th></tr>
        ${awaits.map(a => `<tr>
          <td>#${a.task_id}</td>
          <td>${safe(a.trigger_name)}</td>
          <td><code>${safe(a.session_key)}</code></td>
          <td><span class="badge" style="background:${statusColor(a.task_status)}20;color:${statusColor(a.task_status)}">${a.task_status}</span></td>
          <td class="text-muted">${timeAgo(a.created_at)}</td>
        </tr>`).join("")}
      </table>
    </div>` : ""}

    <div class="mb-16">${filterHtml}</div>
    <table>
      <tr><th>ID</th><th>Content</th><th>Status</th><th>Response</th><th>Created</th></tr>
      ${tasks.map(t => `
        <tr class="msg-row" hx-get="/tasks/${t.id}" hx-target="#task-detail-${t.id}" hx-swap="innerHTML">
          <td>#${t.id}</td>
          <td>${safe((t.content || "").slice(0, 100))}${t.content?.length > 100 ? "..." : ""}</td>
          <td><span class="badge" style="background:${statusColor(t.status)}20;color:${statusColor(t.status)}">${t.status}</span></td>
          <td class="text-muted">${t.response_summary ? safe(t.response_summary.slice(0, 60)) + (t.response_summary.length > 60 ? "..." : "") : "-"}</td>
          <td class="text-muted">${timeAgo(t.created_at)}</td>
        </tr>
        <tr id="task-detail-${t.id}"></tr>
      `).join("")}
    </table>
    ${tasks.length === 0 ? '<div class="card text-muted">No tasks found.</div>' : ''}
    ${paginationHtml}`;

  return c.html(layout("Tasks", html, "tasks"));
});

app.get("/tasks/:id", (c) => {
  const task = db.prepare("SELECT * FROM messages WHERE id = ? AND channel='task'").get(c.req.param("id")) as any;
  if (!task) return c.html("<td colspan=5>Not found</td>");

  const awaiter = db.prepare(
    "SELECT * FROM task_awaits WHERE task_id = ?"
  ).get(task.id) as any;

  return c.html(`<td colspan="5"><div class="msg-detail">
    <strong>ID:</strong> ${task.id} | <strong>Status:</strong> ${task.status}
    <strong>Created:</strong> ${task.created_at}
    ${task.processed_at ? `| <strong>Processed:</strong> ${task.processed_at}` : ""}
    ${awaiter ? `<br><strong>Awaited by:</strong> ${safe(awaiter.trigger_name)} (key: ${safe(awaiter.session_key)})` : ""}
    <hr style="border-color:#3a3b55;margin:8px 0">
    <strong>Content:</strong>
<pre style="margin:4px 0;white-space:pre-wrap">${safe(task.content)}</pre>
    ${task.response_summary ? `<hr style="border-color:#3a3b55;margin:8px 0"><strong>Response:</strong>
<pre style="margin:4px 0;white-space:pre-wrap">${safe(task.response_summary)}</pre>` : ""}
  </div></td>`);
});

// ============ SETTINGS ============
app.get("/settings", (c) => {
  const flash = c.req.query("saved");
  const identity = readFile(IDENTITY);
  const config = readFile(CONFIG);
  const extensions = readFile(EXTENSIONS);

  const triggerCount = (db.prepare("SELECT COUNT(*) as c FROM triggers").get() as any)?.c || 0;

  const html = `
    <h1>Settings</h1>
    ${flash ? `<div class="flash flash-ok">Saved ${safe(flash)} successfully.</div>` : ""}

    <div class="card"><h3>identity.md</h3>
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
  const content = body.content as string || "";
  mkdirSync(WS, { recursive: true });
  writeFileSync(IDENTITY, content);
  return c.redirect("/settings?saved=identity");
});

app.post("/settings/config", async (c) => {
  const body = await c.req.parseBody();
  const content = body.content as string || "";
  mkdirSync(WS, { recursive: true });
  writeFileSync(CONFIG, content);
  return c.redirect("/settings?saved=config");
});

app.post("/settings/extensions", async (c) => {
  const body = await c.req.parseBody();
  const content = body.content as string || "";
  mkdirSync(WS, { recursive: true });
  writeFileSync(EXTENSIONS, content);
  return c.redirect("/settings?saved=extensions");
});


// --- Start ---
export default {
  port: 3000,
  fetch: app.fetch,
};

console.log("Atlas Web-UI running on http://localhost:3000");
