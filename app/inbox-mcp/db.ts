import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

const DB_PATH = "/atlas/workspace/inbox/atlas.db";

let db: Database | null = null;

function createTables(database: Database): void {
  // Messages: channel is open TEXT (no CHECK) for extensibility
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender TEXT,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done','cancelled')),
      response_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_status_created ON messages(status, created_at);

    CREATE TABLE IF NOT EXISTS task_awaits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL UNIQUE,
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES messages(id)
    );

    CREATE TABLE IF NOT EXISTS trigger_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(trigger_name, session_key)
    );
  `);

  // Triggers: plugin system for cron, webhook, manual triggers
  database.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('cron','webhook','manual')),
      description TEXT DEFAULT '',
      channel TEXT DEFAULT 'internal',
      schedule TEXT,
      webhook_secret TEXT,
      prompt TEXT DEFAULT '',
      session_mode TEXT DEFAULT 'ephemeral' CHECK(session_mode IN ('ephemeral','persistent')),
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      run_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function migrateSchema(database: Database): void {
  // Migrate old messages table (had CHECK constraint on channel)
  let msgInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get() as { sql: string } | undefined;

  if (msgInfo?.sql?.includes("CHECK(channel IN")) {
    database.exec("BEGIN");
    try {
      database.exec(`
        ALTER TABLE messages RENAME TO _messages_old;
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          sender TEXT,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done','cancelled')),
          response_summary TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          processed_at TEXT
        );
        INSERT INTO messages (id, channel, sender, content, status, response_summary, created_at, processed_at)
          SELECT id, channel, sender, content, status, response_summary, created_at, processed_at FROM _messages_old;
        DROP TABLE _messages_old;
      `);
      database.exec("COMMIT");
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  }

  // Re-query after potential channel migration
  msgInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get() as { sql: string } | undefined;

  // Migrate: add 'cancelled' to messages status constraint
  if (msgInfo?.sql && !msgInfo.sql.includes("'cancelled'")) {
    database.exec("BEGIN");
    try {
      database.exec(`
        ALTER TABLE messages RENAME TO _messages_status_mig;
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          sender TEXT,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done','cancelled')),
          response_summary TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          processed_at TEXT
        );
        INSERT INTO messages (id, channel, sender, content, status, response_summary, created_at, processed_at)
          SELECT id, channel, sender, content, status, response_summary, created_at, processed_at FROM _messages_status_mig;
        DROP TABLE _messages_status_mig;
      `);
      database.exec("COMMIT");
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  }

  // Migrate old triggers table (lacked name/schedule/prompt columns)
  const trigInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='triggers'"
  ).get() as { sql: string } | undefined;

  if (trigInfo && !trigInfo.sql.includes("name TEXT")) {
    database.exec(`DROP TABLE triggers`);
    database.exec(`
      CREATE TABLE triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('cron','webhook','manual')),
        description TEXT DEFAULT '',
        channel TEXT DEFAULT 'internal',
        schedule TEXT,
        webhook_secret TEXT,
        prompt TEXT DEFAULT '',
        session_mode TEXT DEFAULT 'ephemeral' CHECK(session_mode IN ('ephemeral','persistent')),
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        run_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // Add session_mode column if missing (upgrade from pre-session triggers)
  if (trigInfo && trigInfo.sql.includes("name TEXT") && !trigInfo.sql.includes("session_mode")) {
    database.exec(`ALTER TABLE triggers ADD COLUMN session_mode TEXT DEFAULT 'ephemeral'`);
  }

  // Drop session_id from triggers if present (moved to trigger_sessions table)
  if (trigInfo?.sql?.includes("session_id")) {
    // SQLite doesn't support DROP COLUMN before 3.35.0, so recreate the table
    database.exec("BEGIN");
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS _triggers_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK(type IN ('cron','webhook','manual')),
          description TEXT DEFAULT '',
          channel TEXT DEFAULT 'internal',
          schedule TEXT,
          webhook_secret TEXT,
          prompt TEXT DEFAULT '',
          session_mode TEXT DEFAULT 'ephemeral' CHECK(session_mode IN ('ephemeral','persistent')),
          enabled INTEGER DEFAULT 1,
          last_run TEXT,
          run_count INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO _triggers_new (id, name, type, description, channel, schedule, webhook_secret, prompt, session_mode, enabled, last_run, run_count, created_at)
          SELECT id, name, type, description, channel, schedule, webhook_secret, prompt, COALESCE(session_mode, 'ephemeral'), enabled, last_run, run_count, created_at FROM triggers;
        DROP TABLE triggers;
        ALTER TABLE _triggers_new RENAME TO triggers;
      `);
      database.exec("COMMIT");
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  }

  // Migrate old signal_sessions to trigger_sessions (if signal_sessions exists)
  const signalInfo = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='signal_sessions'"
  ).get();
  if (signalInfo) {
    database.exec(`DROP TABLE signal_sessions`);
  }

  // Remove reply_to column if present (no longer needed — use env vars + content instead)
  const latestMsgInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get() as { sql: string } | undefined;

  if (latestMsgInfo?.sql?.includes("reply_to")) {
    database.exec(`ALTER TABLE messages DROP COLUMN reply_to`);
  }
}

export function initDb(): Database {
  mkdirSync("/atlas/workspace/inbox", { recursive: true });
  const database = new Database(DB_PATH, { create: true });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  migrateSchema(database);
  createTables(database);
  return database;
}

export function getDb(): Database {
  if (!db) {
    db = initDb();
  }
  return db;
}
