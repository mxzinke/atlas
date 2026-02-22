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

deliver_signal() {
  local reply_file="$1"

  # Delegate to signal add-on which handles delivery and message tracking
  python3 /atlas/app/integrations/signal/signal-addon.py deliver "$reply_file" 2>&1 | tee -a "$LOG"
}

deliver_email() {
  local reply_file="$1"

  # Delegate to email add-on which handles threading headers via its own DB
  python3 /atlas/app/integrations/email/email-addon.py deliver "$reply_file" 2>&1 | tee -a "$LOG"
}

process_replies() {
  if [ ! -d "$REPLIES_DIR" ]; then
    return
  fi

  for reply_file in "$REPLIES_DIR"/*.json; do
    [ -f "$reply_file" ] || continue

    local channel content
    channel=$(python3 -c "import json; d=json.load(open('$reply_file')); print(d.get('channel',''))" 2>/dev/null || echo "")
    content=$(python3 -c "import json; d=json.load(open('$reply_file')); print(d.get('content',''))" 2>/dev/null || echo "")

    if [ -z "$channel" ] || [ -z "$content" ]; then
      echo "[$(date)] Skipping malformed reply: $reply_file" | tee -a "$LOG"
      continue
    fi

    local success=false
    case "$channel" in
      signal)
        if deliver_signal "$reply_file"; then
          success=true
        fi
        ;;
      email)
        if deliver_email "$reply_file"; then
          success=true
        fi
        ;;
      *)
        echo "[$(date)] Unknown channel '$channel' in $reply_file" | tee -a "$LOG"
        success=true
        ;;
    esac

    if [ "$success" = "true" ]; then
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
