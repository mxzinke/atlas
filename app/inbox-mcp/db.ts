import Database from "better-sqlite3";
import { mkdirSync } from "fs";

const DB_PATH = "/atlas/workspace/inbox/atlas.db";

let db: Database.Database | null = null;

function createTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL CHECK(channel IN ('signal','email','web','internal')),
      sender TEXT,
      content TEXT NOT NULL,
      reply_to TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done')),
      response_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      config TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS signal_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function initDb(): Database.Database {
  mkdirSync("/atlas/workspace/inbox", { recursive: true });
  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  createTables(database);
  return database;
}

export function getDb(): Database.Database {
  if (!db) {
    db = initDb();
  }
  return db;
}
