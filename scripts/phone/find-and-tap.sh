#!/usr/bin/env bash
# Find a UI node by case-insensitive substring match on text|content-desc, tap its center.
# Usage: find-and-tap.sh <substring>
set -eu
NEEDLE="${1:-}"
if [ -z "$NEEDLE" ]; then
  echo "usage: find-and-tap.sh <substring>" >&2
  exit 2
fi
SERIAL="${ADB_SERIAL:-39111FDJG00ECM}"
ADB="adb -s $SERIAL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

$ADB shell uiautomator dump /sdcard/window_dump.xml >/dev/null
$ADB pull /sdcard/window_dump.xml "$TMP/dump.xml" >/dev/null 2>&1

COORDS="$(python3 - "$TMP/dump.xml" "$NEEDLE" <<'PY'
import sys, re, xml.etree.ElementTree as ET
path, needle = sys.argv[1], sys.argv[2].lower()
root = ET.parse(path).getroot()
for n in root.iter('node'):
    t = (n.get('text') or '').lower()
    cd = (n.get('content-desc') or '').lower()
    if needle in t or needle in cd:
        b = n.get('bounds') or ''
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', b)
        if not m: continue
        x1,y1,x2,y2 = map(int, m.groups())
        print(f"{(x1+x2)//2} {(y1+y2)//2}|text={n.get('text')!r} desc={n.get('content-desc')!r} bounds={b}")
        sys.exit(0)
sys.exit(1)
PY
)" || { echo "FAIL: no node matched '$NEEDLE'" >&2; exit 1; }

XY="${COORDS%%|*}"
INFO="${COORDS#*|}"
X="${XY% *}"; Y="${XY#* }"
echo "node: $INFO" >&2
$ADB shell input tap "$X" "$Y"
echo "tapped: $X,$Y (match=$NEEDLE)" >&2
