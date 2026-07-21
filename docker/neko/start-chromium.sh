#!/bin/sh
#
# Launch the browser that n.eko streams to the user. The reference-side
# adapter (server/streaming/neko-adapter.js) attaches to it via
# `patchright.chromium.connectOverCDP("http://neko:9223")`, which is what
# delivers driver-side stealth (no Runtime.enable, Route-based init-script
# injection, lazy isolated worlds, closed-shadow-root traversal).
#
# We get THREE layers of stealth:
#
#   (1) Binary layer  — the binary itself is Patchright's bundled Chromium,
#       baked into this image by the Dockerfile (PLAYWRIGHT_BROWSERS_PATH
#       points at /opt/patchright-browsers). Patchright maintainers ship
#       C-level patches in the upstream build at this revision.
#
#   (2) Launch-arg layer — the flag set below mirrors
#       `patchright-core/lib/server/chromium/chromiumSwitches.js` line by
#       line, plus the per-launch additions from `chromium.js:265-313`,
#       with `--remote-debugging-port` swapped for `--remote-debugging-pipe`
#       so we can attach over TCP from a sibling container. See
#       docs/patchright-integration-spec.md §1 for the source citations.
#
#   (3) Driver layer — owned by Patchright in the reference container.
#       NEVER add CDP commands that bypass it (Runtime.enable, Console.enable,
#       Page.addScriptToEvaluateOnNewDocument, parallel Puppeteer sessions,
#       etc.). See docs/patchright-integration-spec.md §8 for the full
#       anti-pattern list.
#
# What this script DOES own (environmental, outside Patchright's scope):
#   - The X display + openbox window class (n.eko contract).
#   - The user-data-dir; managed Chrome policy restores the prior session so
#     session-cookie auth survives container restarts.
#   - Window size matching NEKO_DESKTOP_SCREEN to avoid a torn viewport.
#   - The --remote-debugging-port endpoint that connectOverCDP attaches to.

PROXY_FLAGS=""
if [ -n "${FORWARD_PROXY_PORT:-}" ]; then
  PROXY_FLAGS="--proxy-server=http://127.0.0.1:${FORWARD_PROXY_PORT}"
fi

# Match the active n.eko startup screen. A watcher below keeps Chromium aligned
# when n.eko changes the XRandR mode after the stream attaches.
SCREEN="${NEKO_DESKTOP_SCREEN:-1440x900@30}"
SCREEN_WIDTH="${SCREEN%%x*}"
SCREEN_HEIGHT_WITH_RATE="${SCREEN#*x}"
SCREEN_HEIGHT="${SCREEN_HEIGHT_WITH_RATE%%@*}"
case "${SCREEN_WIDTH}:${SCREEN_HEIGHT}" in
  *[!0-9:]*|:*)
    SCREEN_WIDTH=1440
    SCREEN_HEIGHT=900
    ;;
esac
WIDTH="${SCREEN_WIDTH}"
HEIGHT="${SCREEN_HEIGHT}"

# Binary selection in priority order:
#   1. Patchright's bundled Chromium (what we want).
#   2. Google Chrome stable (real branded build; fallback).
#   3. System chromium (last resort so the image still boots).
PATCHRIGHT_CHROMIUM="${PDPP_PATCHRIGHT_CHROMIUM_BIN:-}"
if [ -z "${PATCHRIGHT_CHROMIUM}" ]; then
  for cand in /opt/patchright-browsers/chromium-*/chrome-linux64/chrome \
              /opt/patchright-browsers/chromium-*/chrome-linux/chrome; do
    if [ -x "${cand}" ]; then
      PATCHRIGHT_CHROMIUM="${cand}"
      break
    fi
  done
fi

if [ -n "${PATCHRIGHT_CHROMIUM}" ] && [ -x "${PATCHRIGHT_CHROMIUM}" ]; then
  CHROME_BIN="${PATCHRIGHT_CHROMIUM}"
elif [ -x /usr/bin/google-chrome-stable ]; then
  CHROME_BIN="/usr/bin/google-chrome-stable"
elif [ -x /usr/bin/google-chrome ]; then
  CHROME_BIN="/usr/bin/google-chrome"
else
  CHROME_BIN="/usr/bin/chromium"
fi

# The base disabled-features list mirrors chromiumSwitches.js:24-52 (the
# non-assistantMode path). AutomationControlled is deliberately absent from
# --disable-features — it's disabled via --disable-blink-features below, which
# flips the runtime feature gate without leaving the variation-trial
# fingerprint that --disable-features would.
PATCHRIGHT_DISABLED_FEATURES="AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints"

# Match the local headed launcher workaround for microsoft/playwright#40158:
# headed Chrome's download bubble can race CDP download interception. This is
# environmental launch parity with browser-launch.ts, not a connector-specific
# Chase workaround.
DOWNLOAD_DISABLED_FEATURES="DownloadBubble,DownloadBubbleV2,DownloadBubbleV3"
DISABLED_FEATURES="${PATCHRIGHT_DISABLED_FEATURES},${DOWNLOAD_DISABLED_FEATURES}"

# Enabled features mirror chromiumSwitches.js:74 (CDPScreenshotNewSurface
# is enabled unless PLAYWRIGHT_LEGACY_SCREENSHOT is set).
ENABLED_FEATURES="${PLAYWRIGHT_LEGACY_SCREENSHOT:+}"
ENABLED_FEATURES="${ENABLED_FEATURES:-CDPScreenshotNewSurface}"

# Args below mirror chromiumSwitches.js:53-88. Do NOT add:
#   --enable-automation, --disable-popup-blocking, --disable-component-update,
#   --disable-default-apps, --disable-extensions,
#   --disable-component-extensions-with-background-pages,
#   --disable-client-side-phishing-detection
# These are deliberately absent — they reintroduce automation fingerprints.
#
# Per-launch additions from chromium.js:265-313 that are relevant to us:
#   --user-data-dir, --remote-debugging-port (NOT --pipe; cross-container),
#   --no-sandbox (neko runs the browser as the X session user without
#     namespace setup; this is unavoidable in the m1k1o/neko base image).
#
# Neko-specific additions:
#   --display, --class, --window-position, --window-size, --app
#   --use-gl/--use-angle (SwiftShader is the only GL backend that works
#     reliably in this container; the WebGL renderer is the strongest
#     remaining fingerprint and is addressed at the docker-compose layer
#     via x11-gpu options when a host GPU is available).
"$CHROME_BIN" \
  --disable-field-trial-config \
  --disable-background-networking \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-breakpad \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-features="${DISABLED_FEATURES}" \
  --enable-features="${ENABLED_FEATURES}" \
  --disable-hang-monitor \
  --disable-prompt-on-repost \
  --disable-renderer-backgrounding \
  --force-color-profile=srgb \
  --no-first-run \
  --password-store=basic \
  --use-mock-keychain \
  --no-service-autorun \
  --export-tagged-pdf \
  --disable-search-engine-choice-screen \
  --disable-infobars \
  --disable-sync \
  --disable-blink-features=AutomationControlled \
  --user-data-dir=/home/user/.config/chromium \
  --no-sandbox \
  --window-position=0,0 \
  --window-size="${WIDTH},${HEIGHT}" \
  --class=RemoteBrowserApp \
  --display="${DISPLAY}" \
  --use-gl=angle \
  --use-angle=swiftshader \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --remote-allow-origins=* \
  --app='data:text/html,<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#000"></body>' \
  ${PROXY_FLAGS} \
  ${CHROMIUM_MOBILE_FLAGS} &
CHROME_PID=$!

resize_browser_to_active_screen() {
  screen_size="$(xwininfo -root -display "${DISPLAY}" 2>/dev/null | awk '/Width:/ { width = $2 } /Height:/ { height = $2 } END { if (width && height) print width "x" height }')"
  case "${screen_size}" in
    *[!0-9x]*|x*) return 1 ;;
  esac
  window_ids="$(xdotool search --class RemoteBrowserApp 2>/dev/null || true)"
  [ -n "${window_ids}" ] || return 1
  for window_id in ${window_ids}; do
    xdotool windowsize --sync "${window_id}" "${screen_size%x*}" "${screen_size#*x}" 2>/dev/null || true
  done
}

trap 'kill "${CHROME_PID}" 2>/dev/null || true; wait "${CHROME_PID}"; exit 0' INT TERM
last_screen_size=""
while kill -0 "${CHROME_PID}" 2>/dev/null; do
  current_screen_size="$(xwininfo -root -display "${DISPLAY}" 2>/dev/null | awk '/Width:/ { width = $2 } /Height:/ { height = $2 } END { if (width && height) print width "x" height }')"
  if [ -n "${current_screen_size}" ] && [ "${current_screen_size}" != "${last_screen_size}" ] && resize_browser_to_active_screen; then
    last_screen_size="${current_screen_size}"
  fi
  sleep 1
done
wait "${CHROME_PID}"
