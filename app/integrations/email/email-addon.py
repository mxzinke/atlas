#!/usr/bin/env python3
"""
Email Communication Add-on for Atlas.

Unified module for all email operations: polling IMAP, sending/replying via SMTP,
and thread tracking. Uses its own SQLite database per account.

Subcommands:
  poll   [--once]           Fetch new emails from IMAP, write to inbox, fire triggers
  send   <to> <subject> <body>   Send a new email
  reply  <thread_id> <body>      Reply to an existing thread
  threads [--limit N]       List tracked email threads
  thread <thread_id>        Show thread detail

Concurrency: poll fetches all new UIDs first, writes them to the email DB and
atlas inbox in a single pass, then fires triggers in the background (non-blocking)
so parallel threads don't block each other.
"""

import argparse
import email as emaillib
import email.utils
import imaplib
import json
import os
import re
import signal
import smtplib
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

# --- Paths ---
CONFIG_PATH = "/atlas/workspace/config.yml"
ATLAS_DB_PATH = "/atlas/workspace/inbox/atlas.db"
EMAIL_DB_DIR = "/atlas/workspace/inbox/email"
WAKE_PATH = "/atlas/workspace/inbox/.wake"
TRIGGER_SCRIPT = "/atlas/app/triggers/trigger.sh"
TRIGGER_NAME = "email-handler"
ATTACHMENTS_DIR = "/atlas/workspace/inbox/email/attachments"
STATE_FILE_LEGACY = "/atlas/workspace/inbox/.email-last-uid"
THREADS_DIR_LEGACY = "/atlas/workspace/inbox/email-threads"


# --- Config ---

def load_config():
    """Load email config from config.yml, with env overrides."""
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            import yaml
            with open(CONFIG_PATH) as f:
                data = yaml.safe_load(f) or {}
            cfg = data.get("email", {})
        except ImportError:
            pass

    config = {
        "imap_host": os.environ.get("EMAIL_IMAP_HOST", cfg.get("imap_host", "")),
        "imap_port": int(os.environ.get("EMAIL_IMAP_PORT", cfg.get("imap_port", 993))),
        "smtp_host": os.environ.get("EMAIL_SMTP_HOST", cfg.get("smtp_host", "")),
        "smtp_port": int(os.environ.get("EMAIL_SMTP_PORT", cfg.get("smtp_port", 587))),
        "username": os.environ.get("EMAIL_USERNAME", cfg.get("username", "")),
        "password": os.environ.get("EMAIL_PASSWORD", ""),
        "password_file": cfg.get("password_file", ""),
        "folder": os.environ.get("EMAIL_FOLDER", cfg.get("folder", "INBOX")),
        "whitelist": cfg.get("whitelist", []),
        "mark_read": cfg.get("mark_read", True),
    }

    if not config["password"] and config["password_file"]:
        pf = Path(config["password_file"])
        if pf.exists():
            config["password"] = pf.read_text().strip()

    return config


# --- Email Database ---

def get_email_db(config):
    """Open (or create) the per-account email database."""
    os.makedirs(EMAIL_DB_DIR, exist_ok=True)

    # Sanitize username for filename
    account = re.sub(r"[^a-zA-Z0-9@._-]", "_", config.get("username", "default"))
    db_path = os.path.join(EMAIL_DB_DIR, f"{account}.db")

    db = sqlite3.connect(db_path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")

    db.executescript("""
        CREATE TABLE IF NOT EXISTS threads (
            thread_id       TEXT PRIMARY KEY,
            subject         TEXT NOT NULL DEFAULT '',
            last_message_id TEXT NOT NULL DEFAULT '',
            references_chain TEXT NOT NULL DEFAULT '[]',
            last_sender     TEXT NOT NULL DEFAULT '',
            last_sender_full TEXT NOT NULL DEFAULT '',
            participants    TEXT NOT NULL DEFAULT '[]',
            message_count   INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS emails (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id       TEXT NOT NULL,
            message_id      TEXT NOT NULL DEFAULT '',
            direction       TEXT NOT NULL DEFAULT 'in',
            sender          TEXT NOT NULL DEFAULT '',
            recipient       TEXT NOT NULL DEFAULT '',
            subject         TEXT NOT NULL DEFAULT '',
            body            TEXT NOT NULL DEFAULT '',
            headers_json    TEXT NOT NULL DEFAULT '{}',
            inbox_msg_id    INTEGER,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
        );

        CREATE TABLE IF NOT EXISTS state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
        CREATE INDEX IF NOT EXISTS idx_emails_direction ON emails(direction);
    """)

    # Migrate legacy data if present
    _migrate_legacy(db)

    return db


def _migrate_legacy(db):
    """One-time migration from legacy JSON thread files and UID state."""
    migrated = db.execute("SELECT value FROM state WHERE key='legacy_migrated'").fetchone()
    if migrated:
        return

    # Migrate thread JSON files
    if os.path.isdir(THREADS_DIR_LEGACY):
        for f in Path(THREADS_DIR_LEGACY).glob("*.json"):
            try:
                data = json.loads(f.read_text())
                thread_id = data.get("thread_id", f.stem)
                refs = json.dumps(data.get("references", []))
                participants = json.dumps(data.get("participants", []))
                db.execute("""
                    INSERT OR IGNORE INTO threads
                    (thread_id, subject, last_message_id, references_chain,
                     last_sender, last_sender_full, participants, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    thread_id,
                    data.get("subject", ""),
                    data.get("last_message_id", ""),
                    refs,
                    data.get("last_sender", ""),
                    data.get("last_sender_full", ""),
                    participants,
                    data.get("updated_at", datetime.now().isoformat()),
                ))
            except (json.JSONDecodeError, OSError):
                pass

    # Migrate last UID
    if os.path.exists(STATE_FILE_LEGACY):
        uid = Path(STATE_FILE_LEGACY).read_text().strip()
        if uid:
            db.execute("INSERT OR REPLACE INTO state (key, value) VALUES ('last_uid', ?)", (uid,))

    db.execute("INSERT OR REPLACE INTO state (key, value) VALUES ('legacy_migrated', '1')")
    db.commit()


# --- Thread helpers ---

def extract_thread_id(msg):
    """Extract thread identifier from email headers."""
    references = msg.get("References", "").strip()
    if references:
        first_ref = references.split()[0]
        return sanitize_thread_id(first_ref)

    in_reply_to = msg.get("In-Reply-To", "").strip()
    if in_reply_to:
        return sanitize_thread_id(in_reply_to)

    message_id = msg.get("Message-ID", "").strip()
    return sanitize_thread_id(message_id) if message_id else f"email-{int(time.time())}"


def sanitize_thread_id(raw):
    clean = raw.strip("<>")
    clean = re.sub(r"[^a-zA-Z0-9@._-]", "_", clean)
    return clean[:128]


def build_references_chain(msg):
    """Build full references chain from email headers."""
    refs = []
    references = msg.get("References", "").strip()
    if references:
        refs = references.split()
    message_id = msg.get("Message-ID", "").strip()
    if message_id and message_id not in refs:
        refs.append(message_id)
    return refs


def update_thread(db, thread_id, msg):
    """Update thread state in the email DB."""
    sender = msg.get("From", "")
    _, sender_addr = emaillib.utils.parseaddr(sender)
    subject = msg.get("Subject", "(no subject)")
    subject_clean = re.sub(r"^(Re:\s*)+", "", subject, flags=re.IGNORECASE).strip()
    message_id = msg.get("Message-ID", "").strip()
    references = build_references_chain(msg)

    existing = db.execute("SELECT participants, message_count FROM threads WHERE thread_id = ?",
                          (thread_id,)).fetchone()

    if existing:
        participants = set(json.loads(existing[0]))
        count = existing[1] + 1
    else:
        participants = set()
        count = 1

    if sender_addr:
        participants.add(sender_addr)

    db.execute("""
        INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
                             last_sender, last_sender_full, participants, message_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
            subject = excluded.subject,
            last_message_id = excluded.last_message_id,
            references_chain = excluded.references_chain,
            last_sender = excluded.last_sender,
            last_sender_full = excluded.last_sender_full,
            participants = excluded.participants,
            message_count = excluded.message_count,
            updated_at = excluded.updated_at
    """, (
        thread_id, subject_clean, message_id,
        json.dumps(references), sender_addr, sender,
        json.dumps(sorted(participants)), count,
        datetime.now().isoformat(),
    ))

    return {
        "thread_id": thread_id,
        "subject": subject_clean,
        "last_message_id": message_id,
        "references": references,
        "last_sender": sender_addr,
    }


def get_body(msg):
    """Extract plaintext body from email message."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                charset = part.get_content_charset() or "utf-8"
                return part.get_payload(decode=True).decode(charset, errors="replace")
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                charset = part.get_content_charset() or "utf-8"
                html = part.get_payload(decode=True).decode(charset, errors="replace")
                return re.sub(r"<[^>]+>", "", html)
    else:
        charset = msg.get_content_charset() or "utf-8"
        return msg.get_payload(decode=True).decode(charset, errors="replace")
    return ""


def extract_attachments(msg, thread_id):
    """Extract and save attachments from an email. Returns list of attachment metadata."""
    if not msg.is_multipart():
        return []

    attachments = []
    save_dir = os.path.join(ATTACHMENTS_DIR, thread_id)

    for part in msg.walk():
        content_disposition = part.get("Content-Disposition", "")
        if "attachment" not in content_disposition and "inline" not in content_disposition:
            continue
        # Skip text parts that are the email body
        if part.get_content_type() in ("text/plain", "text/html") and "attachment" not in content_disposition:
            continue

        filename = part.get_filename()
        if not filename:
            ext = part.get_content_type().split("/")[-1]
            filename = f"attachment-{len(attachments) + 1}.{ext}"

        # Sanitize filename
        filename = re.sub(r"[^a-zA-Z0-9._-]", "_", filename)[:128]

        payload = part.get_payload(decode=True)
        if not payload:
            continue

        os.makedirs(save_dir, exist_ok=True)
        filepath = os.path.join(save_dir, filename)

        # Avoid overwriting existing files
        base, ext = os.path.splitext(filename)
        counter = 1
        while os.path.exists(filepath):
            filepath = os.path.join(save_dir, f"{base}-{counter}{ext}")
            counter += 1

        with open(filepath, "wb") as f:
            f.write(payload)

        attachments.append({
            "filename": filename,
            "content_type": part.get_content_type(),
            "size": len(payload),
            "path": filepath,
        })

    return attachments


def is_whitelisted(sender, whitelist):
    if not whitelist:
        return True
    _, addr = emaillib.utils.parseaddr(sender)
    addr = addr.lower()
    return any(addr == w.lower() or addr.endswith(f"@{w.lower()}") for w in whitelist)


# --- Atlas inbox helper ---

def write_to_atlas_inbox(sender, content, thread_id):
    """Write email to the main Atlas inbox. Returns message ID."""
    atlas_db = sqlite3.connect(ATLAS_DB_PATH)
    atlas_db.execute("PRAGMA busy_timeout=5000")
    cursor = atlas_db.execute(
        "INSERT INTO messages (channel, sender, content, reply_to) VALUES (?, ?, ?, ?)",
        ("email", sender, content, thread_id),
    )
    msg_id = cursor.lastrowid
    atlas_db.commit()
    atlas_db.close()
    # Touch .wake so main session picks up the message even if trigger.sh fails
    Path(WAKE_PATH).touch()
    return msg_id


# --- POLL command ---

def cmd_poll(config, once=False):
    """Fetch new emails from IMAP, store in DB, write to inbox, fire triggers."""
    if not config["imap_host"] or not config["username"] or not config["password"]:
        print(f"[{datetime.now()}] ERROR: Email not configured (IMAP). Set email section in config.yml")
        return

    db = get_email_db(config)

    # Get last UID
    row = db.execute("SELECT value FROM state WHERE key='last_uid'").fetchone()
    last_uid = int(row[0]) if row and row[0].isdigit() else 0

    try:
        mail = imaplib.IMAP4_SSL(config["imap_host"], config["imap_port"])
        mail.login(config["username"], config["password"])
        mail.select(config["folder"])

        # Search for new emails
        if last_uid > 0:
            status, data = mail.uid("search", None, f"UID {last_uid + 1}:*")
        else:
            status, data = mail.uid("search", None, "UNSEEN")

        if status != "OK" or not data[0]:
            mail.logout()
            db.close()
            return

        uids = data[0].split()
        print(f"[{datetime.now()}] Found {len(uids)} new email(s)")

        max_uid = last_uid
        trigger_queue = []  # Collect triggers to fire after all emails are stored

        for uid_bytes in uids:
            uid = uid_bytes.decode()
            uid_int = int(uid)

            if uid_int <= last_uid:
                continue

            status, msg_data = mail.uid("fetch", uid, "(RFC822)")
            if status != "OK":
                continue

            raw = msg_data[0][1]
            msg = emaillib.message_from_bytes(raw)

            sender = msg.get("From", "unknown")
            subject = msg.get("Subject", "(no subject)")
            body = get_body(msg)
            thread_id = extract_thread_id(msg)
            message_id_hdr = msg.get("Message-ID", "").strip()

            if not is_whitelisted(sender, config["whitelist"]):
                print(f"[{datetime.now()}] Blocked email from {sender}")
                max_uid = max(max_uid, uid_int)
                continue

            # 1. Update thread state in email DB
            thread_info = update_thread(db, thread_id, msg)

            # 1b. Extract attachments
            attachments = extract_attachments(msg, thread_id)

            # 2. Store email in email DB
            _, sender_addr = emaillib.utils.parseaddr(sender)
            db.execute("""
                INSERT INTO emails (thread_id, message_id, direction, sender, subject, body)
                VALUES (?, ?, 'in', ?, ?, ?)
            """, (thread_id, message_id_hdr, sender_addr, subject, body[:8000]))

            # 3. Write to Atlas inbox
            inbox_content = f"From: {sender}\nSubject: {subject}\n\n{body[:4000]}"
            if attachments:
                att_summary = "\n".join(f"  - {a['filename']} ({a['content_type']}, {a['size']} bytes): {a['path']}" for a in attachments)
                inbox_content += f"\n\nAttachments:\n{att_summary}"
            inbox_msg_id = write_to_atlas_inbox(sender, inbox_content, thread_id)

            # Update email record with inbox msg id
            db.execute("UPDATE emails SET inbox_msg_id = ? WHERE rowid = last_insert_rowid()", (inbox_msg_id,))

            print(f"[{datetime.now()}] Email from {sender}: {subject[:60]} "
                  f"(thread={thread_id}, inbox={inbox_msg_id})")

            # 4. Queue trigger (fire after all emails stored)
            payload_data = {
                "inbox_message_id": inbox_msg_id,
                "sender": sender,
                "subject": subject,
                "body": body[:4000],
                "thread_id": thread_id,
                "message_id": message_id_hdr,
                "date": msg.get("Date", ""),
            }
            if attachments:
                payload_data["attachments"] = [
                    {"filename": a["filename"], "content_type": a["content_type"],
                     "size": a["size"], "path": a["path"]} for a in attachments
                ]
            payload = json.dumps(payload_data)
            trigger_queue.append((payload, thread_id))

            if config["mark_read"]:
                mail.uid("store", uid, "+FLAGS", "\\Seen")

            max_uid = max(max_uid, uid_int)

        # Persist UID state
        if max_uid > last_uid:
            db.execute("INSERT OR REPLACE INTO state (key, value) VALUES ('last_uid', ?)", (str(max_uid),))

        db.commit()
        mail.logout()

        # Fire triggers non-blocking (each thread gets its own trigger session)
        for payload, thread_id in trigger_queue:
            try:
                subprocess.Popen(
                    [TRIGGER_SCRIPT, TRIGGER_NAME, payload, thread_id],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                print(f"[{datetime.now()}] Trigger fired for thread {thread_id}")
            except Exception as e:
                print(f"[{datetime.now()}] Failed to fire trigger for {thread_id}: {e}")

    except imaplib.IMAP4.error as e:
        print(f"[{datetime.now()}] IMAP error: {e}")
    except Exception as e:
        print(f"[{datetime.now()}] Error: {e}")
    finally:
        db.close()


# --- SEND command ---

def build_message(body, attachments=None):
    """Build a MIMEText or MIMEMultipart message depending on attachments."""
    if not attachments:
        return MIMEText(body)

    msg = MIMEMultipart()
    msg.attach(MIMEText(body))

    for filepath in attachments:
        path = Path(filepath)
        if not path.exists():
            print(f"WARNING: Attachment not found: {filepath}", file=sys.stderr)
            continue
        part = MIMEBase("application", "octet-stream")
        part.set_payload(path.read_bytes())
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{path.name}"')
        msg.attach(part)

    return msg


def cmd_send(config, to, subject, body, attachments=None):
    """Send a new email (not a reply)."""
    if not config["smtp_host"] or not config["username"] or not config["password"]:
        print("ERROR: SMTP not configured. Set email section in config.yml", file=sys.stderr)
        sys.exit(1)

    db = get_email_db(config)

    msg = build_message(body, attachments)
    msg["From"] = config["username"]
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    domain = config["username"].split("@")[-1] if "@" in config["username"] else "atlas.local"
    msg["Message-ID"] = make_msgid(domain=domain)

    try:
        with smtplib.SMTP(config["smtp_host"], config["smtp_port"]) as server:
            server.starttls()
            server.login(config["username"], config["password"])
            server.send_message(msg)

        # Create thread in DB
        thread_id = sanitize_thread_id(msg["Message-ID"])
        db.execute("""
            INSERT OR IGNORE INTO threads
            (thread_id, subject, last_message_id, references_chain,
             last_sender, last_sender_full, participants, message_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        """, (
            thread_id, subject, msg["Message-ID"],
            json.dumps([msg["Message-ID"]]),
            config["username"], config["username"],
            json.dumps(sorted([config["username"], to])),
        ))

        # Store email record
        db.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, subject, body)
            VALUES (?, ?, 'out', ?, ?, ?, ?)
        """, (thread_id, msg["Message-ID"], config["username"], to, subject, body[:8000]))

        db.commit()
        print(f"Email sent to {to} (subject=\"{subject}\", thread={thread_id})")

    except Exception as e:
        print(f"ERROR: Failed to send: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


# --- REPLY command ---

def cmd_reply(config, thread_id, body, attachments=None):
    """Reply to an existing email thread with proper threading headers."""
    if not config["smtp_host"] or not config["username"] or not config["password"]:
        print("ERROR: SMTP not configured. Set email section in config.yml", file=sys.stderr)
        sys.exit(1)

    db = get_email_db(config)

    thread = db.execute("SELECT * FROM threads WHERE thread_id = ?", (thread_id,)).fetchone()
    if not thread:
        print(f"ERROR: Thread {thread_id} not found", file=sys.stderr)
        db.close()
        sys.exit(1)

    # Unpack thread data
    cols = [d[0] for d in db.execute("SELECT * FROM threads LIMIT 0").description]
    thread_data = dict(zip(cols, thread))

    recipient = thread_data["last_sender"]
    subject = thread_data["subject"]
    last_message_id = thread_data["last_message_id"]
    references = json.loads(thread_data["references_chain"])

    msg = build_message(body, attachments)
    msg["From"] = config["username"]
    msg["To"] = recipient
    msg["Subject"] = f"Re: {subject}"
    msg["Date"] = formatdate(localtime=True)
    domain = config["username"].split("@")[-1] if "@" in config["username"] else "atlas.local"
    msg["Message-ID"] = make_msgid(domain=domain)

    if last_message_id:
        msg["In-Reply-To"] = last_message_id
    if references:
        msg["References"] = " ".join(references)

    try:
        with smtplib.SMTP(config["smtp_host"], config["smtp_port"]) as server:
            server.starttls()
            server.login(config["username"], config["password"])
            server.send_message(msg)

        # Update thread state: append our Message-ID to references
        references.append(msg["Message-ID"])
        db.execute("""
            UPDATE threads SET
                last_message_id = ?,
                references_chain = ?,
                message_count = message_count + 1,
                updated_at = ?
            WHERE thread_id = ?
        """, (msg["Message-ID"], json.dumps(references), datetime.now().isoformat(), thread_id))

        # Store email record
        db.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, subject, body)
            VALUES (?, ?, 'out', ?, ?, ?, ?)
        """, (thread_id, msg["Message-ID"], config["username"], recipient,
              f"Re: {subject}", body[:8000]))

        db.commit()
        print(f"Reply sent to {recipient} (thread={thread_id}, "
              f"In-Reply-To={last_message_id or 'none'})")

    except Exception as e:
        print(f"ERROR: Failed to send reply: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


# --- THREADS command ---

def cmd_threads(config, limit=20):
    """List tracked email threads."""
    db = get_email_db(config)
    rows = db.execute("""
        SELECT thread_id, subject, last_sender, message_count, updated_at
        FROM threads ORDER BY updated_at DESC LIMIT ?
    """, (limit,)).fetchall()

    if not rows:
        print("No email threads found.")
        db.close()
        return

    print(f"{'Thread ID':<40} {'Subject':<30} {'From':<25} {'Msgs':>4}  {'Updated'}")
    print("-" * 130)
    for row in rows:
        tid = row[0][:38]
        subj = row[1][:28]
        sender = row[2][:23]
        count = row[3]
        updated = row[4][:16]
        print(f"{tid:<40} {subj:<30} {sender:<25} {count:>4}  {updated}")

    db.close()


# --- THREAD detail command ---

def cmd_thread_detail(config, thread_id):
    """Show detail for a specific thread."""
    db = get_email_db(config)

    thread = db.execute("SELECT * FROM threads WHERE thread_id = ?", (thread_id,)).fetchone()
    if not thread:
        print(f"Thread {thread_id} not found.", file=sys.stderr)
        db.close()
        sys.exit(1)

    cols = [d[0] for d in db.execute("SELECT * FROM threads LIMIT 0").description]
    data = dict(zip(cols, thread))
    data["references_chain"] = json.loads(data["references_chain"])
    data["participants"] = json.loads(data["participants"])

    print(json.dumps(data, indent=2))

    # Show emails in thread
    emails = db.execute("""
        SELECT direction, sender, subject, created_at, body
        FROM emails WHERE thread_id = ? ORDER BY created_at
    """, (thread_id,)).fetchall()

    if emails:
        print(f"\n--- Messages ({len(emails)}) ---")
        for e in emails:
            direction = "→" if e[0] == "out" else "←"
            print(f"\n{direction} {e[1]} ({e[3]})")
            print(f"  Subject: {e[2]}")
            print(f"  {e[4][:200]}{'...' if len(e[4] or '') > 200 else ''}")

    db.close()


# --- Main CLI ---

def main():
    parser = argparse.ArgumentParser(
        description="Atlas Email Add-on — unified email management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  email-addon.py poll --once          # Check IMAP once
  email-addon.py poll                 # Continuous polling
  email-addon.py send alice@x.com "Subject" "Body text"
  email-addon.py reply <thread_id> "Reply body"
  email-addon.py threads              # List all threads
  email-addon.py thread <thread_id>   # Thread detail
        """,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # poll
    p_poll = sub.add_parser("poll", help="Fetch new emails from IMAP")
    p_poll.add_argument("--once", action="store_true", help="Check once and exit")

    # send
    p_send = sub.add_parser("send", help="Send a new email")
    p_send.add_argument("to", help="Recipient email address")
    p_send.add_argument("subject", help="Email subject")
    p_send.add_argument("body", help="Email body text")
    p_send.add_argument("--attach", action="append", default=[], metavar="FILE",
                        help="Attach a file (can be used multiple times)")

    # reply
    p_reply = sub.add_parser("reply", help="Reply to an email thread")
    p_reply.add_argument("thread_id", help="Thread ID to reply to")
    p_reply.add_argument("body", help="Reply body text")
    p_reply.add_argument("--attach", action="append", default=[], metavar="FILE",
                        help="Attach a file (can be used multiple times)")

    # threads
    p_threads = sub.add_parser("threads", help="List email threads")
    p_threads.add_argument("--limit", type=int, default=20, help="Max threads to show")

    # thread detail
    p_thread = sub.add_parser("thread", help="Show thread detail")
    p_thread.add_argument("thread_id", help="Thread ID")

    args = parser.parse_args()
    config = load_config()

    if args.command == "poll":
        if args.once:
            cmd_poll(config, once=True)
        else:
            interval = int(os.environ.get("EMAIL_POLL_INTERVAL", 120))
            print(f"[{datetime.now()}] Email poller starting "
                  f"(host={config['imap_host']}, interval={interval}s)")
            while True:
                cmd_poll(config, once=True)
                time.sleep(interval)

    elif args.command == "send":
        cmd_send(config, args.to, args.subject, args.body,
                 attachments=args.attach or None)

    elif args.command == "reply":
        cmd_reply(config, args.thread_id, args.body,
                  attachments=args.attach or None)

    elif args.command == "threads":
        cmd_threads(config, limit=args.limit)

    elif args.command == "thread":
        cmd_thread_detail(config, args.thread_id)


if __name__ == "__main__":
    main()
