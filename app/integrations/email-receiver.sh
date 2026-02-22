#!/bin/bash
# Email receiver: polls IMAP for new messages and routes to trigger
# Runs via cron (e.g., every 2 minutes) or as continuous loop
#
# Prerequisites:
#   1. Python3 with imaplib (built-in)
#   2. Email config in config.yml or environment variables
#   3. Trigger created: trigger_create(name="email-handler", type="webhook", session_mode="persistent", channel="email")
#
# Usage: email-receiver.sh [--once]
#   --once: check once and exit (for cron mode)
#   default: continuous polling loop
set -euo pipefail

WORKSPACE=/atlas/workspace
CONFIG="$WORKSPACE/config.yml"
LOG="/atlas/logs/email.log"
TRIGGER_NAME="email-handler"
POLL_INTERVAL="${EMAIL_POLL_INTERVAL:-120}"

# Pass to Python for the actual IMAP work
python3 /atlas/app/integrations/email-poller.py "$@" 2>&1 | tee -a "$LOG"
