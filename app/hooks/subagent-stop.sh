#!/bin/bash
# SubagentStop Hook: Quality gate for team member results
set -euo pipefail

# The subagent's output is available via stdin or environment variables
# Claude Code passes subagent context through the hook environment

cat << 'EOF'
=== SUBAGENT RESULT REVIEW ===

A team member has completed their task. Review:

1. Was the original task fully completed?
2. Are there obvious errors or gaps in the result?
3. Does it need rework or is the result acceptable?

If the result is incomplete or flawed:
- Describe what is missing
- Decide whether to re-assign the subagent

If the result is good:
- Integrate it into the main context
- Mark the related task as done
EOF
