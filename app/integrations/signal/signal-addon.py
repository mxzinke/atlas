#!/usr/bin/env python3
"""
Signal Communication Add-on for Atlas.

All Signal operations in one module: polling signal-cli, injecting messages,
sending/replying, and contact/conversation tracking. Uses its own SQLite
database per Signal account. Identifies contacts by UUID and supports groups.

Subcommands:
  poll     [--once]                   Poll signal-cli for new messages, process each
  incoming <sender> <message>         Inject a message: write to DB + inbox, fire trigger
  send     <identifier> <message>     Send a Signal message (contact UUID or group ID)
  contacts [--limit N]                List known contacts and groups
  history  <identifier> [--limit]     Show message history with a contact or group
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
WAKE_PATH = "/atlas/workspace/inbox/.wake"
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

    return {
        "number": os.environ.get("SIGNAL_NUMBER", cfg.get("number", "")),
        "whitelist": cfg.get("whitelist", []),
    }


# --- Signal Database ---

def get_signal_db(config):
    """Open (or create) the per-account Signal database."""
    os.makedirs(SIGNAL_DB_DIR, exist_ok=True)

    number = re.sub(r"[^0-9+]", "", config.get("number", "default"))
    db_path = os.path.join(SIGNAL_DB_DIR, f"{number}.db")

    db = sqlite3.connect(db_path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")

    # Migrate old schema: rename number→identifier, contact_number→identifier
    _migrate_to_identifiers(db)

    db.executescript("""
        CREATE TABLE IF NOT EXISTS contacts (
            identifier      TEXT PRIMARY KEY,
            type            TEXT NOT NULL DEFAULT 'contact' CHECK(type IN ('contact','group')),
            name            TEXT NOT NULL DEFAULT '',
            phone           TEXT DEFAULT '',
            message_count   INTEGER NOT NULL DEFAULT 0,
            first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            identifier      TEXT NOT NULL,
            sender_id       TEXT DEFAULT '',
            direction       TEXT NOT NULL DEFAULT 'in',
            body            TEXT NOT NULL DEFAULT '',
            timestamp       TEXT NOT NULL DEFAULT '',
            inbox_msg_id    INTEGER,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (identifier) REFERENCES contacts(identifier)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_identifier ON messages(identifier);
        CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
    """)

    return db


def _migrate_to_identifiers(db):
    """Migrate old phone-number-based schema to identifier-based schema."""
    # Check if old contacts table has 'number' column
    info = db.execute("PRAGMA table_info(contacts)").fetchall()
    col_names = [row[1] for row in info]

    if "number" in col_names and "identifier" not in col_names:
        db.executescript("""
            ALTER TABLE contacts RENAME TO _contacts_old;
            CREATE TABLE contacts (
                identifier      TEXT PRIMARY KEY,
                type            TEXT NOT NULL DEFAULT 'contact',
                name            TEXT NOT NULL DEFAULT '',
                phone           TEXT DEFAULT '',
                message_count   INTEGER NOT NULL DEFAULT 0,
                first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen       TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO contacts (identifier, type, name, phone, message_count, first_seen, last_seen)
                SELECT number, 'contact', name, number, message_count, first_seen, last_seen FROM _contacts_old;
            DROP TABLE _contacts_old;
        """)

    # Migrate messages table: contact_number → identifier, add sender_id
    msg_info = db.execute("PRAGMA table_info(messages)").fetchall()
    msg_cols = [row[1] for row in msg_info]

    if "contact_number" in msg_cols and "identifier" not in msg_cols:
        db.executescript("""
            ALTER TABLE messages RENAME TO _messages_old;
            CREATE TABLE messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                identifier      TEXT NOT NULL,
                sender_id       TEXT DEFAULT '',
                direction       TEXT NOT NULL DEFAULT 'in',
                body            TEXT NOT NULL DEFAULT '',
                timestamp       TEXT NOT NULL DEFAULT '',
                inbox_msg_id    INTEGER,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (identifier) REFERENCES contacts(identifier)
            );
            INSERT INTO messages (id, identifier, sender_id, direction, body, timestamp, inbox_msg_id, created_at)
                SELECT id, contact_number, '', direction, body, timestamp, inbox_msg_id, created_at FROM _messages_old;
            DROP TABLE _messages_old;
        """)


def update_contact(db, identifier, name="", contact_type="contact", phone=""):
    """Update or create contact/group in the Signal DB."""
    db.execute("""
        INSERT INTO contacts (identifier, type, name, phone, message_count, last_seen)
        VALUES (?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(identifier) DO UPDATE SET
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
            phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE contacts.phone END,
            message_count = contacts.message_count + 1,
            last_seen = datetime('now')
    """, (identifier, contact_type, name, phone))


# --- POLL command (signal-cli → incoming) ---

def cmd_poll(config, once=False):
    """Poll signal-cli for new messages and process each via cmd_incoming."""
    number = config["number"]
    if not number:
        print(f"[{datetime.now()}] ERROR: No Signal number configured", file=sys.stderr)
        sys.exit(1)

    try:
        result = subprocess.run(
            ["signal-cli", "-a", number, "--output=json", "receive"],
            capture_output=True, text=True, timeout=30,
        )
        output = result.stdout.strip()
    except FileNotFoundError:
        print(f"[{datetime.now()}] ERROR: signal-cli not installed", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        output = ""

    if not output:
        return

    for line in output.splitlines():
        if not line.strip():
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        envelope = msg.get("envelope", {})
        dm = envelope.get("dataMessage", {})
        body = dm.get("message", "")

        if not body:
            continue

        # Prefer UUID over phone number for sender identification
        sender_uuid = envelope.get("sourceUuid", "")
        sender_phone = envelope.get("sourceNumber") or envelope.get("source") or ""
        sender_id = sender_uuid or sender_phone
        sender_name = envelope.get("sourceName", "")
        ts = str(envelope.get("timestamp", ""))

        if not sender_id:
            continue

        # Check for group message
        group_info = dm.get("groupInfo", {})
        group_id = group_info.get("groupId", "")

        cmd_incoming(
            config, sender_id, body,
            name=sender_name, timestamp=ts,
            sender_phone=sender_phone,
            group_id=group_id,
        )


# --- INCOMING command (core: inject message into session) ---

def cmd_incoming(config, sender, message, name="", timestamp="",
                 sender_phone="", group_id=""):
    """Inject an incoming message: store in DB, write to inbox, fire trigger.

    Args:
        sender: Sender UUID (preferred) or phone number as fallback.
        group_id: If set, this is a group message. The conversation is tracked
                  under the group_id; sender is recorded as sender_id on the message.
    """
    # Whitelist check — match against sender UUID, phone, or group ID
    if config["whitelist"]:
        allowed = any(
            w in (sender, sender_phone, group_id)
            for w in config["whitelist"]
        )
        if not allowed:
            print(f"Blocked: {sender} (group={group_id or 'none'}) not in whitelist", file=sys.stderr)
            return

    db = get_signal_db(config)
    ts = timestamp or datetime.now().isoformat()

    # Determine conversation identifier: group or direct
    if group_id:
        conversation_id = group_id
        update_contact(db, group_id, contact_type="group")
        # Also track the individual sender
        update_contact(db, sender, name, phone=sender_phone)
    else:
        conversation_id = sender
        update_contact(db, sender, name, phone=sender_phone)

    # 1. Store in signal DB
    db.execute("""
        INSERT INTO messages (identifier, sender_id, direction, body, timestamp)
        VALUES (?, ?, 'in', ?, ?)
    """, (conversation_id, sender, message[:8000], ts))

    # 2. Write to atlas inbox — reply_to is conversation_id (for routing replies)
    atlas_db = sqlite3.connect(ATLAS_DB_PATH)
    atlas_db.execute("PRAGMA busy_timeout=5000")

    display_sender = name or sender
    if group_id:
        display_sender = f"{display_sender} (group:{group_id[:12]})"

    cursor = atlas_db.execute(
        "INSERT INTO messages (channel, sender, content, reply_to) VALUES (?, ?, ?, ?)",
        ("signal", display_sender, message, conversation_id),
    )
    inbox_msg_id = cursor.lastrowid
    atlas_db.commit()
    atlas_db.close()

    # Update signal DB with inbox reference
    db.execute("UPDATE messages SET inbox_msg_id = ? WHERE rowid = last_insert_rowid()",
               (inbox_msg_id,))
    db.commit()
    db.close()

    # Touch .wake so main session picks up the message even if trigger.sh fails
    Path(WAKE_PATH).touch()

    source_label = f"group:{group_id[:12]}" if group_id else sender
    print(f"[{datetime.now()}] Signal from {source_label}: {message[:80]}... (inbox={inbox_msg_id})")

    # 3. Fire trigger (trigger.sh handles IPC socket injection vs new session)
    #    Session key = conversation_id (group or sender UUID)
    payload = json.dumps({
        "inbox_message_id": inbox_msg_id,
        "sender": sender,
        "sender_name": name,
        "sender_phone": sender_phone,
        "group_id": group_id,
        "conversation_id": conversation_id,
        "message": message[:4000],
        "timestamp": ts,
    })

    try:
        subprocess.Popen(
            [TRIGGER_SCRIPT, TRIGGER_NAME, payload, conversation_id],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"Failed to fire trigger: {e}", file=sys.stderr)


# --- SEND command ---

def _is_group_id(identifier):
    """Heuristic: group IDs are base64-encoded (long alphanumeric+/= strings)."""
    # UUID format: 8-4-4-4-12 hex chars
    if re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', identifier, re.I):
        return False
    # Phone number
    if re.match(r'^\+\d+$', identifier):
        return False
    # Likely a base64 group ID
    if re.match(r'^[A-Za-z0-9+/=]{16,}$', identifier):
        return True
    return False


def cmd_send(config, to, message):
    """Send a Signal message via signal-cli. Supports UUIDs, phone numbers, and group IDs."""
    number = config["number"]
    if not number:
        print("ERROR: No Signal number configured", file=sys.stderr)
        sys.exit(1)

    db = get_signal_db(config)
    is_group = _is_group_id(to)

    try:
        if is_group:
            cmd = ["signal-cli", "-a", number, "send", "-g", to, "-m", message]
        else:
            cmd = ["signal-cli", "-a", number, "send", "-m", message, to]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        if result.returncode != 0:
            print(f"ERROR: signal-cli send failed: {result.stderr}", file=sys.stderr)
            db.close()
            sys.exit(1)

        contact_type = "group" if is_group else "contact"
        update_contact(db, to, contact_type=contact_type)
        db.execute("""
            INSERT INTO messages (identifier, sender_id, direction, body, timestamp)
            VALUES (?, '', 'out', ?, ?)
        """, (to, message[:8000], datetime.now().isoformat()))
        db.commit()

        target_label = f"group {to[:16]}" if is_group else to
        print(f"Signal message sent to {target_label}")

    except FileNotFoundError:
        print("ERROR: signal-cli not installed", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


# --- CONTACTS command ---

def cmd_contacts(config, limit=20):
    """List known Signal contacts and groups."""
    db = get_signal_db(config)
    rows = db.execute("""
        SELECT identifier, type, name, phone, message_count, last_seen
        FROM contacts ORDER BY last_seen DESC LIMIT ?
    """, (limit,)).fetchall()

    if not rows:
        print("No Signal contacts found.")
        db.close()
        return

    print(f"{'Type':<8} {'Identifier':<40} {'Name':<20} {'Msgs':>5}  {'Last Seen'}")
    print("-" * 95)
    for row in rows:
        ctype = row[1] or "contact"
        identifier = row[0][:38]
        name = (row[2] or row[3] or "-")[:18]
        print(f"{ctype:<8} {identifier:<40} {name:<20} {row[4]:>5}  {row[5][:16]}")

    db.close()


# --- HISTORY command ---

def cmd_history(config, identifier, limit=20):
    """Show message history with a contact or group."""
    db = get_signal_db(config)

    contact = db.execute("SELECT * FROM contacts WHERE identifier = ?",
                         (identifier,)).fetchone()
    if not contact:
        print(f"Contact/group {identifier} not found.", file=sys.stderr)
        db.close()
        sys.exit(1)

    cols = [d[0] for d in db.execute("SELECT * FROM contacts LIMIT 0").description]
    data = dict(zip(cols, contact))

    label = data['name'] or data.get('phone', '') or 'unknown'
    print(f"{data['type'].title()}: {data['identifier']} ({label})")
    print(f"Messages: {data['message_count']}, First seen: {data['first_seen']}")
    print()

    messages = db.execute("""
        SELECT direction, body, created_at, sender_id
        FROM messages WHERE identifier = ? ORDER BY created_at DESC LIMIT ?
    """, (identifier, limit)).fetchall()

    for m in reversed(messages):
        direction = "\u2192" if m[0] == "out" else "\u2190"
        sender_hint = f" [{m[3][:12]}]" if m[3] and data['type'] == 'group' else ""
        print(f"{direction}{sender_hint} ({m[2][:16]})")
        print(f"  {m[1][:200]}{'...' if len(m[1] or '') > 200 else ''}")
        print()

    db.close()


# --- Main CLI ---

def main():
    parser = argparse.ArgumentParser(
        description="Atlas Signal Add-on",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  signal-addon.py poll --once                                        # Check signal-cli once
  signal-addon.py poll                                               # Continuous polling
  signal-addon.py incoming <uuid> "Hello!" --name "Alice"            # Inject incoming message
  signal-addon.py send <uuid-or-group-id> "Hi!"                     # Send message
  signal-addon.py contacts                                           # List contacts & groups
  signal-addon.py history <uuid-or-group-id>                         # Conversation history
        """,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # poll — fetch from signal-cli
    p_poll = sub.add_parser("poll", help="Poll signal-cli for new messages")
    p_poll.add_argument("--once", action="store_true", help="Check once and exit")

    # incoming — inject a message directly
    p_in = sub.add_parser("incoming", help="Inject an incoming message")
    p_in.add_argument("sender", help="Sender identifier (UUID or phone number)")
    p_in.add_argument("message", help="Message text")
    p_in.add_argument("--name", default="", help="Sender display name")
    p_in.add_argument("--timestamp", default="", help="Message timestamp")
    p_in.add_argument("--phone", default="", help="Sender phone number (if sender is UUID)")
    p_in.add_argument("--group", default="", help="Group ID (for group messages)")

    # send
    p_send = sub.add_parser("send", help="Send a Signal message")
    p_send.add_argument("identifier", help="Recipient UUID, phone number, or group ID")
    p_send.add_argument("message", help="Message text")

    # contacts
    p_contacts = sub.add_parser("contacts", help="List known contacts and groups")
    p_contacts.add_argument("--limit", type=int, default=20)

    # history
    p_history = sub.add_parser("history", help="Message history with a contact or group")
    p_history.add_argument("identifier", help="Contact UUID, phone number, or group ID")
    p_history.add_argument("--limit", type=int, default=20)

    args = parser.parse_args()
    config = load_config()

    if args.command == "poll":
        if args.once:
            cmd_poll(config, once=True)
        else:
            interval = int(os.environ.get("SIGNAL_POLL_INTERVAL", 5))
            print(f"[{datetime.now()}] Signal polling starting "
                  f"(number={config['number']}, interval={interval}s)")
            while True:
                cmd_poll(config, once=True)
                time.sleep(interval)
    elif args.command == "incoming":
        cmd_incoming(config, args.sender, args.message,
                     name=args.name, timestamp=args.timestamp,
                     sender_phone=args.phone, group_id=args.group)
    elif args.command == "send":
        cmd_send(config, args.identifier, args.message)
    elif args.command == "contacts":
        cmd_contacts(config, limit=args.limit)
    elif args.command == "history":
        cmd_history(config, args.identifier, limit=args.limit)


if __name__ == "__main__":
    main()
