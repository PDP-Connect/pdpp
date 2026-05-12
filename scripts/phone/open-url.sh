#!/usr/bin/env bash
# Open a URL on the connected Android phone in Brave. Falls back to default view intent.
# Usage: open-url.sh <url>
set -eu
URL="${1:-}"
if [ -z "$URL" ]; then
  echo "usage: open-url.sh <url>" >&2
  exit 2
fi
SERIAL="${ADB_SERIAL:-39111FDJG00ECM}"
WAIT_S="${WAIT_S:-6}"
ADB="adb -s $SERIAL"

set +e
$ADB shell am start -n com.brave.browser/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d "$URL" >/dev/null 2>&1
RC=$?
if [ $RC -ne 0 ]; then
  $ADB shell am start -a android.intent.action.VIEW -d "$URL" >/dev/null 2>&1 || true
fi
set -e

sleep "$WAIT_S"
FG="$($ADB shell dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -1 || true)"
echo "foreground: $FG" >&2
if echo "$FG" | grep -qi brave; then
  echo "PASS: brave in foreground" >&2
  exit 0
fi
echo "FAIL: brave not in foreground" >&2
exit 1
