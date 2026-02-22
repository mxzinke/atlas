#!/usr/bin/env python3
"""
Email IMAP poller: fetches new emails, writes to inbox, tracks thread state,
then fires trigger session for processing.

Flow:
  1. Fetch new emails via IMAP
  2. Write each email as inbox message (channel=email, reply_to=thread_id)
  3. Update thread state file (for reply threading headers)
  4. Fire trigger.sh with payload including inbox message_id
  5. Trigger session can reply_send(message_id) -> reply lands in correct thread

Thread state is stored at /atlas/workspace/inbox/email-threads/<thread_id>.json
for proper In-Reply-To and References headers on outgoing replies.

Config from /atlas/workspace/config.yml or environment variables.
"""

import imaplib
import email
import email.utils
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

CONFIG_PATH = "/atlas/workspace/config.yml"
DB_PATH = "/atlas/workspace/inbox/atlas.db"
STATE_FILE = "/atlas/workspace/inbox/.email-last-uid"
THREADS_DIR = "/atlas/workspace/inbox/email-threads"
TRIGGER_NAME = "email-handler"
TRIGGER_SCRIPT = "/atlas/app/triggers/trigger.sh"


def load_config():
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


def get_last_uid():
    if os.path.exists(STATE_FILE):
        return Path(STATE_FILE).read_text().strip()
    return "0"


def save_last_uid(uid):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    Path(STATE_FILE).write_text(str(uid))


def extract_thread_id(msg):
    """Extract thread identifier from email headers.

    Uses the thread root Message-ID as canonical key:
    - References[0] if present (original message)
    - In-Reply-To if no References (direct reply)
    - Own Message-ID if neither (new thread)
    """
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
    """Build full references chain for the References header."""
    refs = []
    references = msg.get("References", "").strip()
    if references:
        refs = references.split()
    message_id = msg.get("Message-ID", "").strip()
    if message_id and message_id not in refs:
        refs.append(message_id)
    return refs


def update_thread_state(thread_id, msg):
    """Write/update thread state file for reply threading."""
    os.makedirs(THREADS_DIR, exist_ok=True)
    thread_file = os.path.join(THREADS_DIR, f"{thread_id}.json")

    state = {}
    if os.path.exists(thread_file):
        try:
            with open(thread_file) as f:
                state = json.load(f)
        except (json.JSONDecodeError, OSError):
            state = {}

    sender = msg.get("From", "")
    _, sender_addr = email.utils.parseaddr(sender)
    subject = msg.get("Subject", "(no subject)")
    message_id = msg.get("Message-ID", "").strip()
    references = build_references_chain(msg)

    state["thread_id"] = thread_id
    state["subject"] = re.sub(r"^(Re:\s*)+", "", subject, flags=re.IGNORECASE).strip()
    state["last_message_id"] = message_id
    state["references"] = references
    state["last_sender"] = sender_addr
    state["last_sender_full"] = sender
    state["updated_at"] = datetime.now().isoformat()

    participants = set(state.get("participants", []))
    if sender_addr:
        participants.add(sender_addr)
    state["participants"] = sorted(participants)

    with open(thread_file, "w") as f:
        json.dump(state, f, indent=2)

    return state


def write_to_inbox(sender, content, thread_id):
    """Write email as inbox message. Returns the message ID."""
    db = sqlite3.connect(DB_PATH)
    cursor = db.execute(
        "INSERT INTO messages (channel, sender, content, reply_to) VALUES (?, ?, ?, ?)",
        ("email", sender, content, thread_id),
    )
    message_id = cursor.lastrowid
    db.commit()
    db.close()
    return message_id


def get_body(msg):
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


def is_whitelisted(sender, whitelist):
    if not whitelist:
        return True
    _, addr = email.utils.parseaddr(sender)
    addr = addr.lower()
    return any(addr == w.lower() or addr.endswith(f"@{w.lower()}") for w in whitelist)


def fetch_and_process(config):
    if not config["imap_host"] or not config["username"] or not config["password"]:
        print(f"[{datetime.now()}] ERROR: Email not configured. Set email section in config.yml")
        return

    last_uid = get_last_uid()
    max_uid = int(last_uid) if last_uid.isdigit() else 0

    try:
        mail = imaplib.IMAP4_SSL(config["imap_host"], config["imap_port"])
        mail.login(config["username"], config["password"])
        mail.select(config["folder"])

        if max_uid > 0:
            status, data = mail.uid("search", None, f"UID {max_uid + 1}:*")
        else:
            status, data = mail.uid("search", None, "UNSEEN")

        if status != "OK" or not data[0]:
            mail.logout()
            return

        uids = data[0].split()
        print(f"[{datetime.now()}] Found {len(uids)} new email(s)")

        for uid_bytes in uids:
            uid = uid_bytes.decode()
            uid_int = int(uid)

            if uid_int <= max_uid:
                continue

            status, msg_data = mail.uid("fetch", uid, "(RFC822)")
            if status != "OK":
                continue

            raw = msg_data[0][1]
            msg = email.message_from_bytes(raw)

            sender = msg.get("From", "unknown")
            subject = msg.get("Subject", "(no subject)")
            body = get_body(msg)
            thread_id = extract_thread_id(msg)

            if not is_whitelisted(sender, config["whitelist"]):
                print(f"[{datetime.now()}] Blocked email from {sender}")
                max_uid = max(max_uid, uid_int)
                continue

            # 1. Update thread state (for reply threading headers)
            update_thread_state(thread_id, msg)

            # 2. Write to inbox (so trigger session can reply_send on it)
            inbox_content = f"From: {sender}\nSubject: {subject}\n\n{body[:4000]}"
            inbox_msg_id = write_to_inbox(sender, inbox_content, thread_id)

            print(f"[{datetime.now()}] Email from {sender}: {subject[:60]} (thread={thread_id}, inbox={inbox_msg_id})")

            # 3. Build payload with inbox message_id for the trigger session
            payload = json.dumps({
                "inbox_message_id": inbox_msg_id,
                "sender": sender,
                "subject": subject,
                "body": body[:4000],
                "thread_id": thread_id,
                "message_id": msg.get("Message-ID", ""),
                "date": msg.get("Date", ""),
            })

            # 4. Fire trigger with thread_id as session key
            try:
                subprocess.run(
                    [TRIGGER_SCRIPT, TRIGGER_NAME, payload, thread_id],
                    timeout=300,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                print(f"[{datetime.now()}] Trigger timeout for thread {thread_id}")

            if config["mark_read"]:
                mail.uid("store", uid, "+FLAGS", "\\Seen")

            max_uid = max(max_uid, uid_int)

        if max_uid > int(last_uid if last_uid.isdigit() else "0"):
            save_last_uid(max_uid)

        mail.logout()

    except imaplib.IMAP4.error as e:
        print(f"[{datetime.now()}] IMAP error: {e}")
    except Exception as e:
        print(f"[{datetime.now()}] Error: {e}")


def main():
    config = load_config()
    once = "--once" in sys.argv

    if once:
        fetch_and_process(config)
    else:
        interval = int(os.environ.get("EMAIL_POLL_INTERVAL", 120))
        print(f"[{datetime.now()}] Email poller starting (host={config['imap_host']}, interval={interval}s)")
        while True:
            fetch_and_process(config)
            time.sleep(interval)


if __name__ == "__main__":
    main()
