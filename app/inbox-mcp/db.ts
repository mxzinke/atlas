import Database from "better-sqlite3";
import { mkdirSync } from "fs";

const DB_PATH = "/atlas/workspace/inbox/atlas.db";

let db: Database.Database | null = null;

function createTables(database: Database.Database): void {
  // Messages: channel is open TEXT (no CHECK) for extensibility
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender TEXT,
      content TEXT NOT NULL,
      reply_to TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done')),
      response_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS signal_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
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
      session_id TEXT,
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      run_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function migrateSchema(database: Database.Database): void {
  // Migrate old messages table (had CHECK constraint on channel)
  const msgInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get() as { sql: string } | undefined;

  if (msgInfo?.sql?.includes("CHECK(channel IN")) {
    database.exec(`
      ALTER TABLE messages RENAME TO _messages_old;
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        sender TEXT,
        content TEXT NOT NULL,
        reply_to TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done')),
        response_summary TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        processed_at TEXT
      );
      INSERT INTO messages SELECT * FROM _messages_old;
      DROP TABLE _messages_old;
    `);
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
        session_id TEXT,
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        run_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // Add session_mode and session_id columns if missing (upgrade from pre-session triggers)
  if (trigInfo && trigInfo.sql.includes("name TEXT") && !trigInfo.sql.includes("session_mode")) {
    database.exec(`ALTER TABLE triggers ADD COLUMN session_mode TEXT DEFAULT 'ephemeral'`);
    database.exec(`ALTER TABLE triggers ADD COLUMN session_id TEXT`);
  }
}

export function initDb(): Database.Database {
  mkdirSync("/atlas/workspace/inbox", { recursive: true });
  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  migrateSchema(database);
  createTables(database);
  return database;
}

export function getDb(): Database.Database {
  if (!db) {
    db = initDb();
  }
  return db;
}
