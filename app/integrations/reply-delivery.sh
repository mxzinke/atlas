#!/bin/bash
# Reply delivery daemon: reads replies/*.json and delivers to Signal/Email
# Runs as a supervised process or via cron
#
# Usage: reply-delivery.sh [--once]
#   --once: process current replies and exit (for cron mode)
#   default: continuous watch loop
set -euo pipefail

REPLIES_DIR="/atlas/workspace/inbox/replies"
CONFIG="/atlas/workspace/config.yml"
LOG="/atlas/logs/reply-delivery.log"
POLL_INTERVAL="${REPLY_POLL_INTERVAL:-10}"

# Read Signal number from config
SIGNAL_NUMBER="${SIGNAL_NUMBER:-}"
if [ -z "$SIGNAL_NUMBER" ] && [ -f "$CONFIG" ]; then
  SIGNAL_NUMBER=$(python3 -c "
import yaml
with open('$CONFIG') as f:
  cfg = yaml.safe_load(f)
print(cfg.get('signal', {}).get('number', ''))
" 2>/dev/null || echo "")
fi

# Read SMTP config from config
read_email_config() {
  python3 -c "
import yaml, json
with open('$CONFIG') as f:
  cfg = yaml.safe_load(f)
email_cfg = cfg.get('email', {})
print(json.dumps(email_cfg))
" 2>/dev/null || echo "{}"
}

deliver_signal() {
  local reply_to="$1"
  local content="$2"

  if [ -z "$SIGNAL_NUMBER" ]; then
    echo "[$(date)] ERROR: No Signal number configured, cannot deliver" | tee -a "$LOG"
    return 1
  fi

  if command -v signal-cli &>/dev/null; then
    signal-cli -a "$SIGNAL_NUMBER" send -m "$content" "$reply_to" 2>&1 | tee -a "$LOG"
    echo "[$(date)] Signal reply delivered to $reply_to" | tee -a "$LOG"
  else
    echo "[$(date)] ERROR: signal-cli not installed. Reply pending for $reply_to" | tee -a "$LOG"
    return 1
  fi
}

deliver_email() {
  local reply_to="$1"
  local content="$2"

  python3 -c "
import smtplib, json, yaml, sys
from email.mime.text import MIMEText
from pathlib import Path

config_path = '$CONFIG'
reply_to = '$reply_to'
content = '''$content'''

try:
    with open(config_path) as f:
        cfg = yaml.safe_load(f)
    email_cfg = cfg.get('email', {})
except:
    print('ERROR: Could not read email config', file=sys.stderr)
    sys.exit(1)

smtp_host = email_cfg.get('smtp_host', '')
smtp_port = int(email_cfg.get('smtp_port', 587))
username = email_cfg.get('username', '')
password = ''
password_file = email_cfg.get('password_file', '')
if password_file and Path(password_file).exists():
    password = Path(password_file).read_text().strip()

if not smtp_host or not username or not password:
    print('ERROR: SMTP not configured', file=sys.stderr)
    sys.exit(1)

msg = MIMEText(content)
msg['From'] = username
msg['To'] = reply_to
msg['Subject'] = 'Re: Atlas Response'

try:
    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.starttls()
        server.login(username, password)
        server.send_message(msg)
    print(f'Email reply delivered to {reply_to}')
except Exception as e:
    print(f'ERROR: SMTP delivery failed: {e}', file=sys.stderr)
    sys.exit(1)
" 2>&1 | tee -a "$LOG"
}

process_replies() {
  if [ ! -d "$REPLIES_DIR" ]; then
    return
  fi

  for reply_file in "$REPLIES_DIR"/*.json; do
    [ -f "$reply_file" ] || continue

    local channel reply_to content
    channel=$(python3 -c "import json; d=json.load(open('$reply_file')); print(d.get('channel',''))" 2>/dev/null || echo "")
    reply_to=$(python3 -c "import json; d=json.load(open('$reply_file')); print(d.get('reply_to',''))" 2>/dev/null || echo "")
    content=$(python3 -c "import json; d=json.load(open('$reply_file')); print(d.get('content',''))" 2>/dev/null || echo "")

    if [ -z "$channel" ] || [ -z "$content" ]; then
      echo "[$(date)] Skipping malformed reply: $reply_file" | tee -a "$LOG"
      continue
    fi

    local success=false
    case "$channel" in
      signal)
        if deliver_signal "$reply_to" "$content"; then
          success=true
        fi
        ;;
      email)
        if deliver_email "$reply_to" "$content"; then
          success=true
        fi
        ;;
      *)
        echo "[$(date)] Unknown channel '$channel' in $reply_file" | tee -a "$LOG"
        success=true  # Remove unknown channel replies
        ;;
    esac

    if [ "$success" = "true" ]; then
      # Move to archive instead of deleting
      local archive_dir="$REPLIES_DIR/archive"
      mkdir -p "$archive_dir"
      mv "$reply_file" "$archive_dir/" 2>/dev/null || rm -f "$reply_file"
    fi
  done
}

# Main
if [ "${1:-}" = "--once" ]; then
  process_replies
else
  echo "[$(date)] Reply delivery daemon starting (poll=${POLL_INTERVAL}s)" | tee -a "$LOG"
  while true; do
    process_replies
    sleep "$POLL_INTERVAL"
  done
fi
