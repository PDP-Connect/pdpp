#!/bin/bash
# Strategy alignment check. Outputs working state as hook context.
# Keep working-state.md under 5 lines to minimize token usage.
STATE_FILE="$(cd "$(dirname "$0")/.." && pwd)/working-state.md"
[ -f "$STATE_FILE" ] && cat "$STATE_FILE"
