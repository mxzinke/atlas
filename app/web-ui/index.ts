import { Hono } from "hono";
import Database from "better-sqlite3";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, closeSync, openSync } from "fs";
import { join } from "path";

// --- Config ---
const WS = "/atlas/workspace";
const DB_PATH = `${WS}/inbox/atlas.db`;
const MEMORY = `${WS}/memory`;
const IDENTITY = `${WS}/identity.md`;
const CONFIG = `${WS}/config.yml`;
const EXTENSIONS = `${WS}/user-extensions.sh`;
const LOCK = `${WS}/.session-running`;
const WAKE = `${WS}/inbox/.wake`;

// --- DB ---
function getDb(): Database.Database {
  mkdirSync(`${WS}/inbox`, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL CHECK(channel IN ('signal','email','web','internal')),
      sender TEXT, content TEXT NOT NULL, reply_to TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done')),
      response_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, config TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
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
  return s === "pending" ? "#ff9800" : s === "processing" ? "#5c9cf5" : "#4caf50";
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
  const pending = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='pending'").get() as any)?.c || 0;
  const total = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any)?.c || 0;
  const done = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='done'").get() as any)?.c || 0;

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
  let sql = "SELECT * FROM messages";
  const params: any[] = [];
  if (status) { sql += " WHERE status = ?"; params.push(status); }
  sql += " ORDER BY created_at DESC";
  const msgs = db.prepare(sql).all(...params) as any[];

  const filters = ["", "pending", "processing", "done"];
  const filterHtml = filters.map(f =>
    `<a href="/inbox${f ? '?status='+f : ''}" class="btn btn-sm ${status === f ? '' : 'btn-outline'}" style="margin-right:4px">${f || "All"}</a>`
  ).join("");

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
    ${msgs.length === 0 ? '<div class="card text-muted">No messages found.</div>' : ''}`;

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

  const results: { file: string; lines: string[] }[] = [];
  if (existsSync(MEMORY)) {
    const walk = (dir: string, prefix = ""): void => {
      try {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${f.name}` : f.name;
          if (f.isDirectory()) walk(join(dir, f.name), rel);
          else if (f.name.endsWith(".md")) {
            const content = readFile(join(dir, f.name));
            const matching = content.split("\n").filter(l => l.toLowerCase().includes(q.toLowerCase()));
            if (matching.length > 0) results.push({ file: rel, lines: matching.slice(0, 3) });
          }
        }
      } catch {}
    };
    walk(MEMORY);
  }

  if (results.length === 0) return c.html(`<div class="text-muted">No results for "${safe(q)}".</div>`);
  return c.html(results.map(r => `
    <div class="card" style="padding:10px;margin-bottom:8px">
      <strong style="color:#7c6ef0">${safe(r.file)}</strong>
      <pre style="margin-top:4px;padding:8px;font-size:12px">${r.lines.map(l => safe(l)).join("\n")}</pre>
    </div>`).join(""));
});

app.get("/memory/view", (c) => {
  const file = c.req.query("file") || "";
  if (!file) return c.html("");
  const content = readFile(join(MEMORY, file));
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
  const msgs = db.prepare(
    "SELECT * FROM messages WHERE channel='web' ORDER BY created_at DESC LIMIT 30"
  ).all() as any[];

  const html = `
    <h1>Chat</h1>
    <div class="card">
      <form hx-post="/chat" hx-target="#chat-messages" hx-swap="afterbegin" hx-on::after-request="this.reset()">
        <div class="flex">
          <input type="text" name="content" placeholder="Type a message..." autocomplete="off" required style="flex:1">
          <button type="submit">Send</button>
        </div>
      </form>
    </div>
    <div id="chat-messages">
      ${msgs.map(m => chatBubble(m)).join("")}
    </div>`;

  return c.html(layout("Chat", html, "chat"));
});

function chatBubble(m: any): string {
  return `<div class="card" style="margin-bottom:8px">
    <div class="flex" style="justify-content:space-between">
      <span class="flex"><span class="dot" style="background:${statusColor(m.status)}"></span>
        <strong>${safe(m.sender || "You")}</strong></span>
      <span class="text-muted">${timeAgo(m.created_at)}</span>
    </div>
    <div style="margin-top:6px">${safe(m.content)}</div>
    ${m.response_summary ? `<div style="margin-top:8px;padding:8px;background:#1a1b2e;border-radius:4px;border-left:2px solid #7c6ef0">
      <span class="text-muted">Response:</span><br>${safe(m.response_summary)}</div>` : ""}
  </div>`;
}

app.post("/chat", async (c) => {
  const body = await c.req.parseBody();
  const content = (body.content as string || "").trim();
  if (!content) return c.html("");

  const result = db.prepare(
    "INSERT INTO messages (channel, sender, content) VALUES ('web', 'web-ui', ?)"
  ).run(content);

  // Touch wake file
  try {
    mkdirSync(`${WS}/inbox`, { recursive: true });
    closeSync(openSync(WAKE, "w"));
  } catch {}

  const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(result.lastInsertRowid) as any;
  return c.html(chatBubble(msg));
});

// ============ SETTINGS ============
app.get("/settings", (c) => {
  const flash = c.req.query("saved");
  const identity = readFile(IDENTITY);
  const config = readFile(CONFIG);
  const extensions = readFile(EXTENSIONS);

  const triggers = db.prepare("SELECT * FROM triggers ORDER BY id").all() as any[];

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
      ${triggers.length === 0 ? '<div class="text-muted">No triggers configured.</div>' :
        `<table><tr><th>ID</th><th>Type</th><th>Config</th><th>Enabled</th><th></th></tr>
        ${triggers.map(t => `<tr>
          <td>${t.id}</td><td>${safe(t.type)}</td>
          <td><code style="font-size:12px">${safe((t.config || "").slice(0, 50))}</code></td>
          <td><span class="dot" style="background:${t.enabled ? '#4caf50' : '#999'}"></span>${t.enabled ? 'Yes' : 'No'}</td>
          <td><button class="btn btn-sm btn-outline" hx-post="/settings/trigger/${t.id}/toggle" hx-swap="outerHTML" hx-target="closest tr">
            ${t.enabled ? 'Disable' : 'Enable'}</button></td>
        </tr>`).join("")}</table>`}
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

app.post("/settings/trigger/:id/toggle", (c) => {
  const id = c.req.param("id");
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (!t) return c.html("Not found");
  db.prepare("UPDATE triggers SET enabled = ? WHERE id = ?").run(t.enabled ? 0 : 1, id);
  const updated = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  return c.html(`<tr>
    <td>${updated.id}</td><td>${safe(updated.type)}</td>
    <td><code style="font-size:12px">${safe((updated.config || "").slice(0, 50))}</code></td>
    <td><span class="dot" style="background:${updated.enabled ? '#4caf50' : '#999'}"></span>${updated.enabled ? 'Yes' : 'No'}</td>
    <td><button class="btn btn-sm btn-outline" hx-post="/settings/trigger/${updated.id}/toggle" hx-swap="outerHTML" hx-target="closest tr">
      ${updated.enabled ? 'Disable' : 'Enable'}</button></td>
  </tr>`);
});

// --- Start ---
export default {
  port: 3000,
  fetch: app.fetch,
};

console.log("Atlas Web-UI running on http://localhost:3000");
