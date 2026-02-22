#!/bin/bash
# Signal message receiver: polls signal-cli, writes to inbox, fires trigger
#
# Flow:
#   1. signal-cli receive --json → parse messages
#   2. Write each message to inbox (channel=signal, reply_to=sender)
#   3. Fire trigger.sh signal-chat <payload> <sender>
#   4. Trigger session can reply_send(inbox_message_id) → delivery via signal-cli
#
# Prerequisites:
#   1. signal-cli installed: apt-get install -y signal-cli
#   2. signal-cli registered: signal-cli -a +YOUR_NUMBER register / verify
#   3. Trigger created: trigger_create(name="signal-chat", type="webhook",
#      session_mode="persistent", channel="signal")
#
# Usage: signal-receiver.sh [--once]
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

write_to_inbox() {
  local sender="$1"
  local content="$2"
  # reply_to = sender number (used by reply-delivery to send back)
  local msg_id
  msg_id=$(sqlite3 "$DB" "INSERT INTO messages (channel, sender, content, reply_to) VALUES ('signal', '${sender//\'/\'\'}', '${content//\'/\'\'}', '${sender//\'/\'\'}'); SELECT last_insert_rowid();" 2>/dev/null || echo "0")
  echo "$msg_id"
}

process_messages() {
  local messages
  messages=$(signal-cli -a "$SIGNAL_NUMBER" receive --json 2>/dev/null || echo "")

  if [ -z "$messages" ]; then
    return
  fi

  echo "$messages" | while IFS= read -r line; do
    [ -z "$line" ] && continue

    # Extract fields via Python (handles JSON safely)
    local parsed
    parsed=$(echo "$line" | python3 -c "
import sys, json
msg = json.loads(sys.stdin.read())
env = msg.get('envelope', {})
dm = env.get('dataMessage', {})
sender = env.get('source', env.get('sourceNumber', ''))
body = dm.get('message', '')
ts = env.get('timestamp', '')
if sender and body:
    print(json.dumps({'sender': sender, 'body': body, 'timestamp': str(ts)}))
" 2>/dev/null || echo "")

    [ -z "$parsed" ] && continue

    local sender body timestamp
    sender=$(echo "$parsed" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['sender'])")
    body=$(echo "$parsed" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['body'])")
    timestamp=$(echo "$parsed" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['timestamp'])")

    # Check whitelist
    if ! is_whitelisted "$sender"; then
      echo "[$(date)] Blocked message from non-whitelisted sender: $sender" | tee -a "$LOG"
      continue
    fi

    echo "[$(date)] Signal message from $sender: ${body:0:80}..." | tee -a "$LOG"

    # 1. Write to inbox (so trigger session can reply_send on it)
    local inbox_msg_id
    inbox_msg_id=$(write_to_inbox "$sender" "$body")

    # 2. Build payload with inbox message_id
    local payload
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'inbox_message_id': int('$inbox_msg_id'),
    'sender': '$sender',
    'message': $(echo "$body" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))"),
    'timestamp': '$timestamp'
}))" 2>/dev/null || echo "{\"inbox_message_id\":$inbox_msg_id,\"sender\":\"$sender\",\"message\":\"$body\"}")

    # 3. Fire trigger with sender as session key
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
