#!/usr/bin/env bash
set -u

status=0
for path in "$@"; do
  bash "$path" || status=$?
done
exit "$status"
