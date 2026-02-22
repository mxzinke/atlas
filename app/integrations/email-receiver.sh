#!/bin/bash
# Email receiver: delegates to the Email Add-on for IMAP polling
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

LOG="/atlas/logs/email.log"

python3 /atlas/app/integrations/email/email-addon.py poll "$@" 2>&1 | tee -a "$LOG"
