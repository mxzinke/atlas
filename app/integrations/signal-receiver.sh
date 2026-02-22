#!/bin/bash
# Signal receiver: delegates to the Signal Add-on for signal-cli polling
# Runs via cron or as continuous loop
#
# Prerequisites:
#   1. signal-cli installed: apt-get install -y signal-cli
#   2. signal-cli registered: signal-cli -a +YOUR_NUMBER register / verify
#   3. Trigger created: trigger_create(name="signal-chat", type="webhook",
#      session_mode="persistent", channel="signal")
#
# Usage: signal-receiver.sh [--once]
#   --once: check once and exit (for cron mode)
#   default: continuous polling loop
set -euo pipefail

LOG="/atlas/logs/signal.log"

python3 /atlas/app/integrations/signal/signal-addon.py receive "$@" 2>&1 | tee -a "$LOG"
