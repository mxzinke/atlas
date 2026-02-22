#!/usr/bin/env python3
"""
Email IMAP poller: fetches new emails and routes to trigger.sh

Reads config from /atlas/workspace/config.yml:
  email:
    imap_host: imap.example.com
    imap_port: 993
    username: atlas@example.com
    password_file: /atlas/workspace/secrets/email-password
    folder: INBOX
    whitelist: []           # empty = accept all, or list of allowed senders
    mark_read: true         # mark fetched emails as read on IMAP server

Or via environment variables:
  EMAIL_IMAP_HOST, EMAIL_IMAP_PORT, EMAIL_USERNAME, EMAIL_PASSWORD, EMAIL_FOLDER
"""

import imaplib
import email
import email.utils
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

CONFIG_PATH = "/atlas/workspace/config.yml"
STATE_FILE = "/atlas/workspace/inbox/.email-last-uid"
TRIGGER_NAME = "email-handler"
TRIGGER_SCRIPT = "/atlas/app/triggers/trigger.sh"


def load_config():
    """Load email config from config.yml or environment."""
    cfg = {}

    # Try config file first
    if os.path.exists(CONFIG_PATH):
        try:
            import yaml
            with open(CONFIG_PATH) as f:
                data = yaml.safe_load(f) or {}
            cfg = data.get("email", {})
        except ImportError:
            pass  # yaml not available, fall back to env vars

    # Environment overrides
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

    # Read password from file if not in env
    if not config["password"] and config["password_file"]:
        pf = Path(config["password_file"])
        if pf.exists():
            config["password"] = pf.read_text().strip()

    return config


def get_last_uid():
    """Read the last processed UID from state file."""
    if os.path.exists(STATE_FILE):
        return Path(STATE_FILE).read_text().strip()
    return "0"


def save_last_uid(uid):
    """Save the last processed UID to state file."""
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    Path(STATE_FILE).write_text(str(uid))


def extract_thread_id(msg):
    """Extract a thread identifier from email headers.

    Priority: In-Reply-To → References (first) → Message-ID
    This groups replies within the same thread.
    """
    # In-Reply-To directly references the parent
    in_reply_to = msg.get("In-Reply-To", "").strip()
    if in_reply_to:
        return sanitize_thread_id(in_reply_to)

    # References header contains the thread root
    references = msg.get("References", "").strip()
    if references:
        first_ref = references.split()[0]
        return sanitize_thread_id(first_ref)

    # No threading headers = new thread, use own Message-ID
    message_id = msg.get("Message-ID", "").strip()
    return sanitize_thread_id(message_id) if message_id else f"email-{int(time.time())}"


def sanitize_thread_id(raw):
    """Make a Message-ID safe for use as a session key."""
    # Strip angle brackets, replace special chars
    clean = raw.strip("<>")
    clean = re.sub(r"[^a-zA-Z0-9@._-]", "_", clean)
    return clean[:128]  # Limit length


def get_body(msg):
    """Extract plain text body from email."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                charset = part.get_content_charset() or "utf-8"
                return part.get_payload(decode=True).decode(charset, errors="replace")
        # Fallback to HTML if no plain text
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                charset = part.get_content_charset() or "utf-8"
                html = part.get_payload(decode=True).decode(charset, errors="replace")
                # Strip HTML tags (basic)
                return re.sub(r"<[^>]+>", "", html)
    else:
        charset = msg.get_content_charset() or "utf-8"
        return msg.get_payload(decode=True).decode(charset, errors="replace")
    return ""


def is_whitelisted(sender, whitelist):
    """Check if sender is allowed."""
    if not whitelist:
        return True
    # Extract email address from "Name <email>" format
    _, addr = email.utils.parseaddr(sender)
    addr = addr.lower()
    return any(addr == w.lower() or addr.endswith(f"@{w.lower()}") for w in whitelist)


def fetch_and_process(config):
    """Connect to IMAP, fetch new emails, route to trigger."""
    if not config["imap_host"] or not config["username"] or not config["password"]:
        print(f"[{datetime.now()}] ERROR: Email not configured. Set email section in config.yml")
        return

    last_uid = get_last_uid()
    max_uid = int(last_uid) if last_uid.isdigit() else 0

    try:
        # Connect
        mail = imaplib.IMAP4_SSL(config["imap_host"], config["imap_port"])
        mail.login(config["username"], config["password"])
        mail.select(config["folder"])

        # Search for messages newer than last UID
        if max_uid > 0:
            status, data = mail.uid("search", None, f"UID {max_uid + 1}:*")
        else:
            # First run: only get unseen messages
            status, data = mail.uid("search", None, "UNSEEN")

        if status != "OK" or not data[0]:
            mail.logout()
            return

        uids = data[0].split()
        print(f"[{datetime.now()}] Found {len(uids)} new email(s)")

        for uid_bytes in uids:
            uid = uid_bytes.decode()
            uid_int = int(uid)

            # Skip already processed
            if uid_int <= max_uid:
                continue

            # Fetch the email
            status, msg_data = mail.uid("fetch", uid, "(RFC822)")
            if status != "OK":
                continue

            raw = msg_data[0][1]
            msg = email.message_from_bytes(raw)

            sender = msg.get("From", "unknown")
            subject = msg.get("Subject", "(no subject)")
            body = get_body(msg)
            thread_id = extract_thread_id(msg)

            # Check whitelist
            if not is_whitelisted(sender, config["whitelist"]):
                print(f"[{datetime.now()}] Blocked email from {sender}")
                max_uid = max(max_uid, uid_int)
                continue

            print(f"[{datetime.now()}] Email from {sender}: {subject[:60]} (thread={thread_id})")

            # Build payload
            payload = json.dumps({
                "sender": sender,
                "subject": subject,
                "body": body[:4000],  # Limit body size
                "thread_id": thread_id,
                "message_id": msg.get("Message-ID", ""),
                "date": msg.get("Date", ""),
            })

            # Fire trigger with thread_id as session key
            try:
                subprocess.run(
                    [TRIGGER_SCRIPT, TRIGGER_NAME, payload, thread_id],
                    timeout=300,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                print(f"[{datetime.now()}] Trigger timeout for thread {thread_id}")

            # Mark as read on server
            if config["mark_read"]:
                mail.uid("store", uid, "+FLAGS", "\\Seen")

            max_uid = max(max_uid, uid_int)

        # Save progress
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
