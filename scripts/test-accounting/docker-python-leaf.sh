#!/usr/bin/env bash
set -u

status=0
for path in "$@"; do
  uv run python "$path" -v || status=$?
done
exit "$status"
