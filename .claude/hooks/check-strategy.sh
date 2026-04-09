#!/bin/bash
# Strategy alignment check. Fires on UserPromptSubmit but only outputs
# every 5th invocation to reduce token cost.
#
# The working-state.md file is the source of truth for current priorities,
# evaluation lens, and steering constraints.

STATE_FILE="$(cd "$(dirname "$0")/.." && pwd)/working-state.md"
COUNT_FILE="/tmp/.pdpp-hook-count"

# Increment counter
COUNT=0
[ -f "$COUNT_FILE" ] && COUNT=$(cat "$COUNT_FILE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNT_FILE"

# Only output every 5th turn
if [ $((COUNT % 5)) -eq 1 ]; then
  [ -f "$STATE_FILE" ] && cat "$STATE_FILE"
fi
