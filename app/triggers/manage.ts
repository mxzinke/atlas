#!/usr/bin/env bun
/**
 * Trigger management CLI
 * Usage: bun /atlas/app/triggers/manage.ts <command> [flags]
 *
 * Commands:
 *   create  --name=<slug> --type=<cron|webhook|manual> [--schedule=...] [--secret=...] [--channel=internal] [--description=...] [--session-mode=ephemeral|persistent]
 *   update  --name=<slug> [--schedule=...] [--description=...] [--channel=...] [--secret=...] [--session-mode=...]
 *   delete  --name=<slug>
 *   enable  --name=<slug>
 *   disable --name=<slug>
 *   list    [--type=cron|webhook|manual]
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

const DB_PATH = "/atlas/workspace/inbox/atlas.db";

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function syncCrontab(): void {
  try {
    Bun.spawnSync(["bun", "/atlas/app/triggers/sync-crontab.ts"]);
  } catch {}
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/s);
    if (m) {
      flags[m[1]] = m[2] ?? "true";
    }
  }
  return flags;
}

function printTable(triggers: any[]): void {
  if (triggers.length === 0) {
    console.log("No triggers found.");
    return;
  }
  const cols = ["name", "type", "enabled", "schedule", "channel", "session_mode", "description"];
  const widths = cols.map((c) =>
    Math.max(c.length, ...triggers.map((t) => String(t[c] ?? "").length))
  );
  const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  console.log(header);
  console.log(sep);
  for (const t of triggers) {
    const row = cols
      .map((c, i) => String(t[c] ?? "").padEnd(widths[i]))
      .join("  ");
    console.log(row);
  }
}

// --- Main ---

const argv = Bun.argv.slice(2); // skip bun + script path
const command = argv[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`Usage: bun /atlas/app/triggers/manage.ts <command> [flags]

Commands:
  create  --name=<slug> --type=<cron|webhook|manual> [--schedule=...] [--secret=...] [--channel=internal] [--description=...] [--session-mode=ephemeral|persistent]
  update  --name=<slug> [--schedule=...] [--description=...] [--channel=...] [--secret=...] [--session-mode=...]
  delete  --name=<slug>
  enable  --name=<slug>
  disable --name=<slug>
  list    [--type=cron|webhook|manual]`);
  process.exit(0);
}

const flags = parseFlags(argv.slice(1));
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode=WAL");

switch (command) {
  case "create": {
    const name = flags["name"] || "";
    const type = flags["type"] || "";
    const schedule = flags["schedule"] || null;
    const secret = flags["secret"] || null;
    const channel = flags["channel"] || "internal";
    const description = flags["description"] || "";
    const sessionMode = flags["session-mode"] || "ephemeral";

    if (!name) die("--name is required");
    if (!/^[a-z0-9_-]+$/.test(name))
      die("--name must be lowercase alphanumeric, dashes, underscores only");
    if (!type) die("--type is required (cron|webhook|manual)");
    if (!["cron", "webhook", "manual"].includes(type))
      die("--type must be cron, webhook, or manual");
    if (type === "cron" && !schedule) die("--schedule is required for cron triggers");
    if (schedule && !/^[\d\s*/,-]+$/.test(schedule)) die("Invalid cron schedule format");
    if (!["ephemeral", "persistent"].includes(sessionMode))
      die("--session-mode must be ephemeral or persistent");

    try {
      db.prepare(
        `INSERT INTO triggers (name, type, description, channel, schedule, webhook_secret, prompt, session_mode)
         VALUES (?, ?, ?, ?, ?, ?, '', ?)`
      ).run(name, type, description, channel, schedule, secret, sessionMode);
    } catch (e: any) {
      die(e.message);
    }

    // Create trigger directory for prompt.md
    mkdirSync(`/atlas/workspace/triggers/${name}`, { recursive: true });

    if (type === "cron") syncCrontab();

    const trigger = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name) as any;
    console.log(`Created trigger '${name}' (${type})`);
    if (type === "webhook") {
      console.log(`Webhook URL: /api/webhook/${name}`);
      if (secret) console.log(`Auth: Set X-Webhook-Secret: ${secret}`);
    }
    console.log(`Prompt file: workspace/triggers/${name}/prompt.md`);
    console.log(JSON.stringify(trigger, null, 2));
    break;
  }

  case "update": {
    const name = flags["name"] || "";
    if (!name) die("--name is required");

    const existing = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name) as any;
    if (!existing) die(`Trigger '${name}' not found`);

    const updates: string[] = [];
    const params: unknown[] = [];

    if (flags["description"] !== undefined) {
      updates.push("description = ?");
      params.push(flags["description"]);
    }
    if (flags["channel"] !== undefined) {
      updates.push("channel = ?");
      params.push(flags["channel"]);
    }
    if (flags["schedule"] !== undefined) {
      if (flags["schedule"] && !/^[\d\s*/,-]+$/.test(flags["schedule"]))
        die("Invalid cron schedule format");
      updates.push("schedule = ?");
      params.push(flags["schedule"] || null);
    }
    if (flags["secret"] !== undefined) {
      updates.push("webhook_secret = ?");
      params.push(flags["secret"] || null);
    }
    if (flags["session-mode"] !== undefined) {
      if (!["ephemeral", "persistent"].includes(flags["session-mode"]))
        die("--session-mode must be ephemeral or persistent");
      updates.push("session_mode = ?");
      params.push(flags["session-mode"]);
    }

    if (updates.length === 0) die("No fields to update. Use --description, --channel, --schedule, --secret, --session-mode");

    params.push(name);
    db.prepare(`UPDATE triggers SET ${updates.join(", ")} WHERE name = ?`).run(...params);

    if (existing.type === "cron") syncCrontab();

    const updated = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name);
    console.log(`Updated trigger '${name}'`);
    console.log(JSON.stringify(updated, null, 2));
    break;
  }

  case "delete": {
    const name = flags["name"] || "";
    if (!name) die("--name is required");

    const existing = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name) as any;
    if (!existing) die(`Trigger '${name}' not found`);

    db.prepare("DELETE FROM triggers WHERE name = ?").run(name);
    db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = ?").run(name);
    db.prepare("DELETE FROM task_awaits WHERE trigger_name = ?").run(name);

    if (existing.type === "cron") syncCrontab();

    console.log(`Deleted trigger '${name}' (${existing.type})`);
    break;
  }

  case "enable": {
    const name = flags["name"] || "";
    if (!name) die("--name is required");

    const existing = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name) as any;
    if (!existing) die(`Trigger '${name}' not found`);

    db.prepare("UPDATE triggers SET enabled = 1 WHERE name = ?").run(name);
    if (existing.type === "cron") syncCrontab();

    console.log(`Enabled trigger '${name}'`);
    break;
  }

  case "disable": {
    const name = flags["name"] || "";
    if (!name) die("--name is required");

    const existing = db.prepare("SELECT * FROM triggers WHERE name = ?").get(name) as any;
    if (!existing) die(`Trigger '${name}' not found`);

    db.prepare("UPDATE triggers SET enabled = 0 WHERE name = ?").run(name);
    if (existing.type === "cron") syncCrontab();

    console.log(`Disabled trigger '${name}'`);
    break;
  }

  case "list": {
    let sql = "SELECT * FROM triggers";
    const params: string[] = [];
    if (flags["type"]) {
      sql += " WHERE type = ?";
      params.push(flags["type"]);
    }
    sql += " ORDER BY type, name";
    const triggers = db.prepare(sql).all(...params) as any[];
    printTable(triggers);
    break;
  }

  default:
    die(`Unknown command '${command}'. Run with --help for usage.`);
}
