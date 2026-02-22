#!/bin/bash
# Signal receiver: reads signal-cli JSON output, injects each message into Atlas
#
# Each message is passed directly to signal-addon.py incoming, which:
#   1. Stores it in signal.db
#   2. Writes it to the atlas inbox
#   3. Fires trigger.sh (non-blocking) → message lands in the trigger session
#
# Usage: signal-receiver.sh [--once]
set -euo pipefail

WORKSPACE=/atlas/workspace
CONFIG="$WORKSPACE/config.yml"
LOG="/atlas/logs/signal.log"
ADDON="/atlas/app/integrations/signal/signal-addon.py"
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
  echo "[$(date)] ERROR: No Signal number configured" | tee -a "$LOG" >&2
  exit 1
fi

process_messages() {
  local output
  output=$(signal-cli -a "$SIGNAL_NUMBER" receive --json 2>/dev/null || echo "")
  [ -z "$output" ] && return

  echo "$output" | while IFS= read -r line; do
    [ -z "$line" ] && continue

    # Parse each JSON line → extract sender + body + name + timestamp
    python3 -c "
import sys, json, subprocess
msg = json.loads('''$line''') if '''$line''' else {}
env = msg.get('envelope', {})
dm = env.get('dataMessage', {})
sender = env.get('source', env.get('sourceNumber', ''))
body = dm.get('message', '')
name = env.get('sourceName', '')
ts = str(env.get('timestamp', ''))
if sender and body:
    args = ['$ADDON', 'incoming', sender, body]
    if name:
        args += ['--name', name]
    if ts:
        args += ['--timestamp', ts]
    subprocess.run(args)
" 2>/dev/null || true

  done
}

# Main
if [ "${1:-}" = "--once" ]; then
  process_messages 2>&1 | tee -a "$LOG"
else
  echo "[$(date)] Signal receiver starting (number=$SIGNAL_NUMBER, poll=${POLL_INTERVAL}s)" | tee -a "$LOG"
  while true; do
    process_messages 2>&1 | tee -a "$LOG"
    sleep "$POLL_INTERVAL"
  done
fi
