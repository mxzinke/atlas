#!/usr/bin/env python3
"""
Email reply sender with proper threading headers.

Reads thread state from /atlas/workspace/inbox/email-threads/<thread_id>.json
to construct correct In-Reply-To and References headers so replies land in the
correct thread in the recipient's mail client.

Usage: email-send.py <reply-json-file>

The reply JSON must contain:
  {
    "channel": "email",
    "reply_to": "<thread_id>",    ← used to look up thread state
    "content": "Reply body text",
    "timestamp": "..."
  }
"""

import json
import os
import smtplib
import sys
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

CONFIG_PATH = "/atlas/workspace/config.yml"
THREADS_DIR = "/atlas/workspace/inbox/email-threads"


def load_email_config():
    """Load SMTP config from config.yml."""
    try:
        import yaml
        with open(CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        return cfg.get("email", {})
    except Exception as e:
        print(f"ERROR: Could not read config: {e}", file=sys.stderr)
        sys.exit(1)


def load_thread_state(thread_id):
    """Load thread state for proper email threading."""
    thread_file = os.path.join(THREADS_DIR, f"{thread_id}.json")
    if os.path.exists(thread_file):
        try:
            with open(thread_file) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return None


def send_reply(reply_file):
    """Send an email reply with correct threading headers."""
    # Load reply data
    with open(reply_file) as f:
        reply = json.load(f)

    thread_id = reply.get("reply_to", "")
    content = reply.get("content", "")

    if not content:
        print("ERROR: Empty reply content", file=sys.stderr)
        return False

    # Load SMTP config
    email_cfg = load_email_config()
    smtp_host = email_cfg.get("smtp_host", "")
    smtp_port = int(email_cfg.get("smtp_port", 587))
    username = email_cfg.get("username", "")
    password = ""
    password_file = email_cfg.get("password_file", "")
    if password_file and Path(password_file).exists():
        password = Path(password_file).read_text().strip()

    if not smtp_host or not username or not password:
        print("ERROR: SMTP not configured", file=sys.stderr)
        return False

    # Load thread state for threading headers
    thread = load_thread_state(thread_id) if thread_id else None

    # Build email
    msg = MIMEText(content)
    msg["From"] = username
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=username.split("@")[-1] if "@" in username else "atlas.local")

    if thread:
        # Proper threading: reply to last message in thread
        recipient = thread.get("last_sender", thread_id)
        subject = thread.get("subject", "Atlas Response")

        msg["To"] = recipient
        msg["Subject"] = f"Re: {subject}"

        # In-Reply-To: the Message-ID of the last email we received
        last_msg_id = thread.get("last_message_id", "")
        if last_msg_id:
            msg["In-Reply-To"] = last_msg_id

        # References: full chain of Message-IDs in this thread
        references = thread.get("references", [])
        if references:
            msg["References"] = " ".join(references)

        # Update thread state with our reply's Message-ID
        references.append(msg["Message-ID"])
        thread["references"] = references
        thread_file = os.path.join(THREADS_DIR, f"{thread_id}.json")
        with open(thread_file, "w") as f:
            json.dump(thread, f, indent=2)
    else:
        # No thread state — fallback to basic reply
        msg["To"] = thread_id  # reply_to is hopefully an email address
        msg["Subject"] = "Re: Atlas Response"

    # Send
    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(username, password)
            server.send_message(msg)

        recipient = msg["To"]
        print(f"Email reply delivered to {recipient} (thread={thread_id}, In-Reply-To={msg.get('In-Reply-To', 'none')})")
        return True

    except Exception as e:
        print(f"ERROR: SMTP delivery failed: {e}", file=sys.stderr)
        return False


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: email-send.py <reply-json-file>", file=sys.stderr)
        sys.exit(1)
    success = send_reply(sys.argv[1])
    sys.exit(0 if success else 1)
