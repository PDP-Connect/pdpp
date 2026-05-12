#!/usr/bin/env bash
# Tap at screen coords.
# Usage: tap.sh <x> <y>
set -eu
X="${1:-}"
Y="${2:-}"
if [ -z "$X" ] || [ -z "$Y" ]; then
  echo "usage: tap.sh <x> <y>" >&2
  exit 2
fi
SERIAL="${ADB_SERIAL:-39111FDJG00ECM}"
adb -s "$SERIAL" shell input tap "$X" "$Y"
echo "tapped: $X,$Y" >&2
