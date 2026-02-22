#!/bin/bash
# Signal message receiver: polls signal-cli for new messages and routes to trigger
# Runs as a supervised process (via supervisord or cron)
#
# Prerequisites:
#   1. signal-cli installed: apt-get install -y signal-cli
#   2. signal-cli registered: signal-cli -a +YOUR_NUMBER register / verify
#   3. Trigger created: trigger_create(name="signal-chat", type="webhook", session_mode="persistent", channel="signal")
#
# Usage: signal-receiver.sh [--once]
#   --once: process current messages and exit (for cron mode)
#   default: continuous polling loop
set -euo pipefail

WORKSPACE=/atlas/workspace
CONFIG="$WORKSPACE/config.yml"
DB="$WORKSPACE/inbox/atlas.db"
LOG="/atlas/logs/signal.log"
TRIGGER_NAME="signal-chat"
POLL_INTERVAL="${SIGNAL_POLL_INTERVAL:-5}"

# Read phone number from config
SIGNAL_NUMBER="${SIGNAL_NUMBER:-}"
if [ -z "$SIGNAL_NUMBER" ] && [ -f "$CONFIG" ]; then
  SIGNAL_NUMBER=$(python3 -c "
import yaml
with open('$CONFIG') as f:
  cfg = yaml.safe_load(f)
print(cfg.get('signal', {}).get('number', ''))
" 2>/dev/null || echo "")
fi

if [ -z "$SIGNAL_NUMBER" ]; then
  echo "[$(date)] ERROR: No Signal number configured. Set SIGNAL_NUMBER env or signal.number in config.yml" | tee -a "$LOG" >&2
  exit 1
fi

# Read whitelist from config
WHITELIST=""
if [ -f "$CONFIG" ]; then
  WHITELIST=$(python3 -c "
import yaml
with open('$CONFIG') as f:
  cfg = yaml.safe_load(f)
wl = cfg.get('signal', {}).get('whitelist', [])
print(' '.join(wl) if wl else '')
" 2>/dev/null || echo "")
fi

is_whitelisted() {
  local sender="$1"
  if [ -z "$WHITELIST" ]; then
    return 0  # No whitelist = accept all
  fi
  for allowed in $WHITELIST; do
    if [ "$sender" = "$allowed" ]; then
      return 0
    fi
  done
  return 1
}

process_messages() {
  # Receive pending messages as JSON
  local messages
  messages=$(signal-cli -a "$SIGNAL_NUMBER" receive --json 2>/dev/null || echo "")

  if [ -z "$messages" ]; then
    return
  fi

  echo "$messages" | while IFS= read -r line; do
    # Skip empty lines
    [ -z "$line" ] && continue

    # Extract sender and message body
    local sender body timestamp
    sender=$(echo "$line" | python3 -c "
import sys, json
msg = json.loads(sys.stdin.read())
env = msg.get('envelope', {})
print(env.get('source', env.get('sourceNumber', '')))" 2>/dev/null || echo "")
    body=$(echo "$line" | python3 -c "
import sys, json
msg = json.loads(sys.stdin.read())
dm = msg.get('envelope', {}).get('dataMessage', {})
print(dm.get('message', ''))" 2>/dev/null || echo "")
    timestamp=$(echo "$line" | python3 -c "
import sys, json
msg = json.loads(sys.stdin.read())
print(msg.get('envelope', {}).get('timestamp', ''))" 2>/dev/null || echo "")

    # Skip empty messages (receipts, typing indicators)
    if [ -z "$body" ] || [ -z "$sender" ]; then
      continue
    fi

    # Check whitelist
    if ! is_whitelisted "$sender"; then
      echo "[$(date)] Blocked message from non-whitelisted sender: $sender" | tee -a "$LOG"
      continue
    fi

    echo "[$(date)] Signal message from $sender: ${body:0:80}..." | tee -a "$LOG"

    # Build payload JSON
    local payload
    payload=$(python3 -c "
import json
print(json.dumps({
  'sender': '$sender',
  'message': $(python3 -c "import json; print(json.dumps('''$body'''))"),
  'timestamp': '$timestamp'
}))" 2>/dev/null || echo "{\"sender\":\"$sender\",\"message\":\"$body\"}")

    # Fire trigger with sender as session key (persistent per-contact session)
    /atlas/app/triggers/trigger.sh "$TRIGGER_NAME" "$payload" "$sender"
  done
}

# Main loop
if [ "${1:-}" = "--once" ]; then
  process_messages
else
  echo "[$(date)] Signal receiver starting (number=$SIGNAL_NUMBER, poll=${POLL_INTERVAL}s)" | tee -a "$LOG"
  while true; do
    process_messages
    sleep "$POLL_INTERVAL"
  done
fi
