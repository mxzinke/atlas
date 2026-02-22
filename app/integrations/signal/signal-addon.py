#!/usr/bin/env python3
"""
Signal Communication Add-on for Atlas.

Unified module for all Signal operations: receiving messages via signal-cli,
sending/replying, and contact/conversation tracking. Uses its own SQLite
database per Signal number.

Subcommands:
  receive [--once]           Poll signal-cli for new messages, write to inbox, fire triggers
  send    <number> <message> Send a new Signal message
  deliver <reply-json-file>  Deliver a reply from reply-delivery.sh pipeline
  contacts [--limit N]       List known contacts
  history <number> [--limit] Show message history with a contact

Concurrency: receive fires triggers non-blocking (Popen) so messages from
different contacts are processed in parallel. The trigger session lock
in trigger.sh prevents duplicate sessions; the stop hook picks up queued
messages for running sessions.
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# --- Paths ---
CONFIG_PATH = "/atlas/workspace/config.yml"
ATLAS_DB_PATH = "/atlas/workspace/inbox/atlas.db"
SIGNAL_DB_DIR = "/atlas/workspace/inbox/signal"
TRIGGER_SCRIPT = "/atlas/app/triggers/trigger.sh"
TRIGGER_NAME = "signal-chat"


# --- Config ---

def load_config():
    """Load Signal config from config.yml, with env overrides."""
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            import yaml
            with open(CONFIG_PATH) as f:
                data = yaml.safe_load(f) or {}
            cfg = data.get("signal", {})
        except ImportError:
            pass

    config = {
        "number": os.environ.get("SIGNAL_NUMBER", cfg.get("number", "")),
        "history_turns": int(cfg.get("history_turns", 20)),
        "whitelist": cfg.get("whitelist", []),
    }

    return config


# --- Signal Database ---

def get_signal_db(config):
    """Open (or create) the per-number Signal database."""
    os.makedirs(SIGNAL_DB_DIR, exist_ok=True)

    # Sanitize number for filename
    number = re.sub(r"[^0-9+]", "", config.get("number", "default"))
    db_path = os.path.join(SIGNAL_DB_DIR, f"{number}.db")

    db = sqlite3.connect(db_path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")

    db.executescript("""
        CREATE TABLE IF NOT EXISTS contacts (
            number          TEXT PRIMARY KEY,
            name            TEXT NOT NULL DEFAULT '',
            message_count   INTEGER NOT NULL DEFAULT 0,
            first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_number  TEXT NOT NULL,
            direction       TEXT NOT NULL DEFAULT 'in',
            body            TEXT NOT NULL DEFAULT '',
            timestamp       TEXT NOT NULL DEFAULT '',
            inbox_msg_id    INTEGER,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (contact_number) REFERENCES contacts(number)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_number);
        CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
    """)

    return db


def update_contact(db, number, name=""):
    """Update or create contact in the Signal DB."""
    db.execute("""
        INSERT INTO contacts (number, name, message_count, last_seen)
        VALUES (?, ?, 1, datetime('now'))
        ON CONFLICT(number) DO UPDATE SET
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
            message_count = contacts.message_count + 1,
            last_seen = datetime('now')
    """, (number, name))


def is_whitelisted(sender, whitelist):
    if not whitelist:
        return True
    return sender in whitelist


# --- Atlas inbox helper ---

def write_to_atlas_inbox(sender, content, reply_to):
    """Write Signal message to the main Atlas inbox. Returns message ID."""
    atlas_db = sqlite3.connect(ATLAS_DB_PATH)
    atlas_db.execute("PRAGMA busy_timeout=5000")
    cursor = atlas_db.execute(
        "INSERT INTO messages (channel, sender, content, reply_to) VALUES (?, ?, ?, ?)",
        ("signal", sender, content, reply_to),
    )
    msg_id = cursor.lastrowid
    atlas_db.commit()
    atlas_db.close()
    return msg_id


# --- RECEIVE command ---

def cmd_receive(config, once=False):
    """Poll signal-cli for new messages, store in DB, write to inbox, fire triggers."""
    number = config["number"]
    if not number:
        print(f"[{datetime.now()}] ERROR: No Signal number configured. "
              "Set signal.number in config.yml or SIGNAL_NUMBER env", file=sys.stderr)
        sys.exit(1)

    db = get_signal_db(config)

    try:
        result = subprocess.run(
            ["signal-cli", "-a", number, "receive", "--json"],
            capture_output=True, text=True, timeout=30,
        )
        output = result.stdout.strip()
    except FileNotFoundError:
        print(f"[{datetime.now()}] ERROR: signal-cli not installed", file=sys.stderr)
        db.close()
        sys.exit(1)
    except subprocess.TimeoutExpired:
        output = ""

    if not output:
        db.close()
        return

    trigger_queue = []

    for line in output.splitlines():
        if not line.strip():
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        envelope = msg.get("envelope", {})
        dm = envelope.get("dataMessage", {})
        sender = envelope.get("source", envelope.get("sourceNumber", ""))
        body = dm.get("message", "")
        ts = str(envelope.get("timestamp", ""))
        sender_name = envelope.get("sourceName", "")

        if not sender or not body:
            continue

        if not is_whitelisted(sender, config["whitelist"]):
            print(f"[{datetime.now()}] Blocked message from {sender}")
            continue

        print(f"[{datetime.now()}] Signal from {sender}: {body[:80]}...")

        # 1. Update contact in Signal DB
        update_contact(db, sender, sender_name)

        # 2. Store message in Signal DB
        db.execute("""
            INSERT INTO messages (contact_number, direction, body, timestamp)
            VALUES (?, 'in', ?, ?)
        """, (sender, body[:8000], ts))

        # 3. Write to Atlas inbox (reply_to = sender number for reply routing)
        inbox_msg_id = write_to_atlas_inbox(sender, body, sender)

        # Update message record with inbox msg id
        db.execute("UPDATE messages SET inbox_msg_id = ? WHERE rowid = last_insert_rowid()",
                   (inbox_msg_id,))

        # 4. Queue trigger (fire non-blocking after all messages stored)
        payload = json.dumps({
            "inbox_message_id": inbox_msg_id,
            "sender": sender,
            "sender_name": sender_name,
            "message": body[:4000],
            "timestamp": ts,
        })
        trigger_queue.append((payload, sender))

    db.commit()

    # Fire triggers non-blocking (each contact gets its own trigger session)
    for payload, sender in trigger_queue:
        try:
            subprocess.Popen(
                [TRIGGER_SCRIPT, TRIGGER_NAME, payload, sender],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            print(f"[{datetime.now()}] Trigger fired for contact {sender}")
        except Exception as e:
            print(f"[{datetime.now()}] Failed to fire trigger for {sender}: {e}")

    db.close()


# --- SEND command ---

def cmd_send(config, to, message):
    """Send a Signal message."""
    number = config["number"]
    if not number:
        print("ERROR: No Signal number configured", file=sys.stderr)
        sys.exit(1)

    db = get_signal_db(config)

    try:
        result = subprocess.run(
            ["signal-cli", "-a", number, "send", "-m", message, to],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            print(f"ERROR: signal-cli send failed: {result.stderr}", file=sys.stderr)
            db.close()
            sys.exit(1)

        # Update contact and store message
        update_contact(db, to)
        db.execute("""
            INSERT INTO messages (contact_number, direction, body, timestamp)
            VALUES (?, 'out', ?, ?)
        """, (to, message[:8000], datetime.now().isoformat()))

        db.commit()
        print(f"Signal message sent to {to}")

    except FileNotFoundError:
        print("ERROR: signal-cli not installed", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


# --- DELIVER command (called by reply-delivery.sh) ---

def cmd_deliver(config, reply_file):
    """Deliver a reply from reply-delivery.sh pipeline."""
    with open(reply_file) as f:
        reply = json.load(f)

    to = reply.get("reply_to", "")
    content = reply.get("content", "")

    if not to or not content:
        print("ERROR: Missing reply_to or content", file=sys.stderr)
        sys.exit(1)

    cmd_send(config, to, content)


# --- CONTACTS command ---

def cmd_contacts(config, limit=20):
    """List known Signal contacts."""
    db = get_signal_db(config)
    rows = db.execute("""
        SELECT number, name, message_count, last_seen
        FROM contacts ORDER BY last_seen DESC LIMIT ?
    """, (limit,)).fetchall()

    if not rows:
        print("No Signal contacts found.")
        db.close()
        return

    print(f"{'Number':<20} {'Name':<25} {'Messages':>8}  {'Last Seen'}")
    print("-" * 80)
    for row in rows:
        number = row[0][:18]
        name = (row[1] or "-")[:23]
        count = row[2]
        last_seen = row[3][:16]
        print(f"{number:<20} {name:<25} {count:>8}  {last_seen}")

    db.close()


# --- HISTORY command ---

def cmd_history(config, contact_number, limit=20):
    """Show message history with a contact."""
    db = get_signal_db(config)

    contact = db.execute("SELECT * FROM contacts WHERE number = ?",
                         (contact_number,)).fetchone()
    if not contact:
        print(f"Contact {contact_number} not found.", file=sys.stderr)
        db.close()
        sys.exit(1)

    cols = [d[0] for d in db.execute("SELECT * FROM contacts LIMIT 0").description]
    data = dict(zip(cols, contact))
    print(f"Contact: {data['number']} ({data['name'] or 'unknown'})")
    print(f"Messages: {data['message_count']}, First seen: {data['first_seen']}")
    print()

    messages = db.execute("""
        SELECT direction, body, created_at
        FROM messages WHERE contact_number = ? ORDER BY created_at DESC LIMIT ?
    """, (contact_number, limit)).fetchall()

    for m in reversed(messages):
        direction = "→" if m[0] == "out" else "←"
        print(f"{direction} ({m[2][:16]})")
        print(f"  {m[1][:200]}{'...' if len(m[1] or '') > 200 else ''}")
        print()

    db.close()


# --- Main CLI ---

def main():
    parser = argparse.ArgumentParser(
        description="Atlas Signal Add-on — unified Signal management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  signal-addon.py receive --once        # Check signal-cli once
  signal-addon.py receive               # Continuous polling
  signal-addon.py send +49170123 "Hi!"  # Send a message
  signal-addon.py contacts              # List contacts
  signal-addon.py history +49170123     # Message history
  signal-addon.py deliver reply.json    # Deliver a reply file (used by reply-delivery.sh)
        """,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # receive
    p_recv = sub.add_parser("receive", help="Poll signal-cli for new messages")
    p_recv.add_argument("--once", action="store_true", help="Check once and exit")

    # send
    p_send = sub.add_parser("send", help="Send a Signal message")
    p_send.add_argument("number", help="Recipient phone number")
    p_send.add_argument("message", help="Message text")

    # deliver (internal, called by reply-delivery.sh)
    p_deliver = sub.add_parser("deliver", help="Deliver a reply JSON file via signal-cli")
    p_deliver.add_argument("reply_file", help="Path to reply JSON file")

    # contacts
    p_contacts = sub.add_parser("contacts", help="List known contacts")
    p_contacts.add_argument("--limit", type=int, default=20, help="Max contacts to show")

    # history
    p_history = sub.add_parser("history", help="Show message history with a contact")
    p_history.add_argument("number", help="Contact phone number")
    p_history.add_argument("--limit", type=int, default=20, help="Max messages to show")

    args = parser.parse_args()
    config = load_config()

    if args.command == "receive":
        if args.once:
            cmd_receive(config, once=True)
        else:
            interval = int(os.environ.get("SIGNAL_POLL_INTERVAL", 5))
            print(f"[{datetime.now()}] Signal receiver starting "
                  f"(number={config['number']}, interval={interval}s)")
            while True:
                cmd_receive(config, once=True)
                time.sleep(interval)

    elif args.command == "send":
        cmd_send(config, args.number, args.message)

    elif args.command == "deliver":
        cmd_deliver(config, args.reply_file)

    elif args.command == "contacts":
        cmd_contacts(config, limit=args.limit)

    elif args.command == "history":
        cmd_history(config, args.number, limit=args.limit)


if __name__ == "__main__":
    main()
