#!/usr/bin/env python3
"""
Signal daemon listener for Atlas.

Connects to signal-cli's UNIX socket, reads JSON-RPC notifications,
and calls 'signal incoming' for each received message.

Run as a supervisord service alongside signal-cli daemon.
See workspace/supervisor.d/ for the service configuration.
"""

import json
import socket
import subprocess
import sys
import time
from datetime import datetime

SOCKET_PATH = "/tmp/signal.sock"


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def connect_socket(path, retries=60, delay=2):
    """Wait for the signal-cli daemon socket to become available."""
    for attempt in range(retries):
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(path)
            return sock
        except (FileNotFoundError, ConnectionRefusedError) as e:
            if attempt < retries - 1:
                log(f"Socket not ready ({e}), retrying in {delay}s...")
                time.sleep(delay)
            else:
                raise


def handle_notification(notification):
    """Process a JSON-RPC receive notification from signal-cli daemon."""
    if notification.get("method") != "receive":
        return

    params = notification.get("params", {})
    envelope = params.get("envelope", {})
    dm = envelope.get("dataMessage", {})

    body = dm.get("message", "")
    sender = envelope.get("sourceNumber") or envelope.get("source", "")
    name = envelope.get("sourceName", "")
    ts = str(envelope.get("timestamp", ""))

    # Ignore receipts, typing notifications, and empty messages
    if not sender or not body:
        return

    log(f"Message from {sender} ({name}): {body[:80]}")

    cmd = ["signal", "incoming", sender, body]
    if name:
        cmd += ["--name", name]
    if ts:
        cmd += ["--timestamp", ts]

    try:
        subprocess.run(cmd, timeout=30, check=False)
    except Exception as e:
        log(f"ERROR calling 'signal incoming': {e}")


def listen(sock):
    """Read newline-delimited JSON from the socket until connection drops."""
    buf = ""
    while True:
        try:
            data = sock.recv(4096)
        except OSError:
            break
        if not data:
            log("Connection closed by signal-cli daemon")
            break
        buf += data.decode("utf-8", errors="replace")
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if "method" in obj:
                    handle_notification(obj)
            except json.JSONDecodeError:
                pass


def main():
    log(f"Signal daemon listener starting (socket={SOCKET_PATH})")
    while True:
        try:
            sock = connect_socket(SOCKET_PATH)
            log("Connected to signal-cli daemon, listening for messages")
            listen(sock)
            sock.close()
        except Exception as e:
            log(f"Connection error: {e}")
        log("Reconnecting in 5s...")
        time.sleep(5)


if __name__ == "__main__":
    main()
