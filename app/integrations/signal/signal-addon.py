#!/usr/bin/env python3
"""
Signal Communication Add-on for Atlas.

All Signal operations in one module: polling signal-cli, injecting messages,
sending/replying, and contact/conversation tracking. Uses its own SQLite
database per Signal number.

Subcommands:
  poll     [--once]              Poll signal-cli for new messages, process each
  incoming <sender> <message>    Inject a message: write to DB + inbox, fire trigger
  send     <number> <message>    Send a Signal message via signal-cli
  contacts [--limit N]           List known contacts
  history  <number> [--limit]    Show message history with a contact
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
DAEMON_SOCKET = "/tmp/signal.sock"

# signal-cli binary: check PATH first, then known workspace location
def _find_signal_cli_bin():
    import shutil
    if shutil.which("signal-cli"):
        return "signal-cli"
    for p in ["/atlas/workspace/bin/signal-cli-bin", "/atlas/workspace/bin/signal-cli"]:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


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
    """Open (or create) the per-number Signal database."""
    os.makedirs(SIGNAL_DB_DIR, exist_ok=True)

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


# --- POLL command (signal-cli → incoming) ---

def cmd_poll(config, once=False):
    """Poll signal-cli for new messages and process each via cmd_incoming."""
    number = config["number"]
    if not number:
        print(f"[{datetime.now()}] ERROR: No Signal number configured", file=sys.stderr)
        sys.exit(1)

    bin_path = _find_signal_cli_bin()
    if not bin_path:
        print(f"[{datetime.now()}] ERROR: signal-cli binary not found", file=sys.stderr)
        sys.exit(1)
    try:
        result = subprocess.run(
            [bin_path, "-a", number, "receive", "--output=json"],
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
        sender = envelope.get("source", envelope.get("sourceNumber", ""))
        body = dm.get("message", "")
        name = envelope.get("sourceName", "")
        ts = str(envelope.get("timestamp", ""))

        if not sender or not body:
            continue

        cmd_incoming(config, sender, body, name=name, timestamp=ts)


# --- INCOMING command (core: inject message into session) ---

def cmd_incoming(config, sender, message, name="", timestamp=""):
    """Inject an incoming message: store in DB, write to inbox, fire trigger."""
    # Whitelist check
    if config["whitelist"] and sender not in config["whitelist"]:
        print(f"Blocked: {sender} not in whitelist", file=sys.stderr)
        return

    db = get_signal_db(config)
    ts = timestamp or datetime.now().isoformat()

    # 1. Store in signal DB
    update_contact(db, sender, name)
    db.execute("""
        INSERT INTO messages (contact_number, direction, body, timestamp)
        VALUES (?, 'in', ?, ?)
    """, (sender, message[:8000], ts))

    # 2. Write to atlas inbox
    atlas_db = sqlite3.connect(ATLAS_DB_PATH)
    atlas_db.execute("PRAGMA busy_timeout=5000")
    cursor = atlas_db.execute(
        "INSERT INTO messages (channel, sender, content) VALUES (?, ?, ?)",
        ("signal", sender, message),
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

    print(f"[{datetime.now()}] Signal from {sender}: {message[:80]}... (inbox={inbox_msg_id})")

    # 3. Fire trigger (trigger.sh handles IPC socket injection vs new session)
    payload = json.dumps({
        "inbox_message_id": inbox_msg_id,
        "sender": sender,
        "sender_name": name,
        "message": message[:4000],
        "timestamp": ts,
    })

    try:
        subprocess.Popen(
            [TRIGGER_SCRIPT, TRIGGER_NAME, payload, sender],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"Failed to fire trigger: {e}", file=sys.stderr)


# --- SEND command ---

def _send_via_socket(to, message):
    """Send via the running signal-cli daemon JSON-RPC socket."""
    import socket as _socket
    with _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM) as s:
        s.settimeout(30)
        s.connect(DAEMON_SOCKET)
        req = json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "send",
            "params": {"recipient": [to], "message": message},
        })
        s.sendall(req.encode() + b"\n")
        # Read until newline (single JSON-RPC response)
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
        resp = json.loads(buf.split(b"\n")[0])
        if "error" in resp:
            raise RuntimeError(resp["error"].get("message", str(resp["error"])))


def _send_via_cli(number, to, message):
    """Send via direct signal-cli invocation (fallback when no daemon socket)."""
    bin_path = _find_signal_cli_bin()
    if not bin_path:
        raise FileNotFoundError("signal-cli binary not found")
    result = subprocess.run(
        [bin_path, "-a", number, "send", "-m", message, to],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"signal-cli send failed: {result.stderr.strip()}")


def cmd_send(config, to, message):
    """Send a Signal message — via daemon socket if running, otherwise via CLI."""
    number = config["number"]
    if not number:
        print("ERROR: No Signal number configured", file=sys.stderr)
        sys.exit(1)

    db = get_signal_db(config)
    try:
        if os.path.exists(DAEMON_SOCKET):
            _send_via_socket(to, message)
        else:
            _send_via_cli(number, to, message)

        update_contact(db, to)
        db.execute("""
            INSERT INTO messages (contact_number, direction, body, timestamp)
            VALUES (?, 'out', ?, ?)
        """, (to, message[:8000], datetime.now().isoformat()))
        db.commit()
        print(f"Signal message sent to {to}")
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


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
        print(f"{row[0][:18]:<20} {(row[1] or '-')[:23]:<25} {row[2]:>8}  {row[3][:16]}")

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
        direction = "\u2192" if m[0] == "out" else "\u2190"
        print(f"{direction} ({m[2][:16]})")
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
  signal-addon.py poll --once                        # Check signal-cli once
  signal-addon.py poll                               # Continuous polling
  signal-addon.py incoming +49170123 "Hello!"        # Inject incoming message
  signal-addon.py send +49170123 "Hi!"               # Send outgoing message
  signal-addon.py contacts                           # List contacts
  signal-addon.py history +49170123                  # Conversation history
        """,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # poll — fetch from signal-cli
    p_poll = sub.add_parser("poll", help="Poll signal-cli for new messages")
    p_poll.add_argument("--once", action="store_true", help="Check once and exit")

    # incoming — inject a message directly
    p_in = sub.add_parser("incoming", help="Inject an incoming message")
    p_in.add_argument("sender", help="Sender phone number")
    p_in.add_argument("message", help="Message text")
    p_in.add_argument("--name", default="", help="Sender display name")
    p_in.add_argument("--timestamp", default="", help="Message timestamp")

    # send
    p_send = sub.add_parser("send", help="Send a Signal message")
    p_send.add_argument("number", help="Recipient phone number")
    p_send.add_argument("message", help="Message text")

    # contacts
    p_contacts = sub.add_parser("contacts", help="List known contacts")
    p_contacts.add_argument("--limit", type=int, default=20)

    # history
    p_history = sub.add_parser("history", help="Message history with a contact")
    p_history.add_argument("number", help="Contact phone number")
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
                     name=args.name, timestamp=args.timestamp)
    elif args.command == "send":
        cmd_send(config, args.number, args.message)
    elif args.command == "contacts":
        cmd_contacts(config, limit=args.limit)
    elif args.command == "history":
        cmd_history(config, args.number, limit=args.limit)


if __name__ == "__main__":
    main()
