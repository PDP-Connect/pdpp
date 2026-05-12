#!/usr/bin/env bash
# Capture a screenshot. Prints path on stdout.
# Usage: screenshot.sh [label]
set -eu
LABEL="${1:-shot}"
SERIAL="${ADB_SERIAL:-39111FDJG00ECM}"
DIR="/tmp/phone-shots"
mkdir -p "$DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/${TS}-${LABEL}.png"
adb -s "$SERIAL" exec-out screencap -p > "$OUT"
if [ ! -s "$OUT" ]; then
  echo "FAIL: empty screenshot" >&2
  rm -f "$OUT"
  exit 1
fi
echo "$OUT"
echo "PASS: $OUT" >&2
