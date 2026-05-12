# scripts/phone

Small ADB + telemetry helpers used by validation loops against a USB-connected Android device.

## Requirements

- `adb` (with USB-debugging enabled phone, unlocked)
- `python3`, `jq`, `docker compose`
- PDPP env files: `.env.docker`, `docker-compose.yml`, `docker-compose.neko.yml`
- Default device serial: `39111FDJG00ECM` (Pixel 8 Pro). Override via `ADB_SERIAL`.

## Scripts

| Script | Purpose |
| --- | --- |
| `open-url.sh <url>` | Opens URL in Brave (intent fallback). Waits `$WAIT_S` (default 6) then verifies Brave foreground. |
| `screenshot.sh [label]` | Captures `screencap -p` to `/tmp/phone-shots/<ISO>-<label>.png`. Prints path. |
| `tap.sh <x> <y>` | `input tap` wrapper. |
| `find-and-tap.sh <substring>` | `uiautomator dump` + case-insensitive text/content-desc match → tap node center. Fails if no match. Note: cannot find content inside `<video>` streams or some shadow roots. |
| `wait-for-telemetry.sh <substring> [timeout-s]` | Polls `/app/tmp/stream-debug/<UTC-date>.jsonl` in `pdpp-web-1` container, returns first matching line. |

Exit codes: `0` PASS, non-zero FAIL (one-line reason on stderr).
