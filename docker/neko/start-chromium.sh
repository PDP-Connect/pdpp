#!/bin/sh

PROXY_FLAGS=""
if [ -n "${FORWARD_PROXY_PORT:-}" ]; then
  PROXY_FLAGS="--proxy-server=http://127.0.0.1:${FORWARD_PROXY_PORT}"
fi

exec /usr/bin/chromium \
  --window-position=0,0 \
  --window-size=1280,720 \
  --class=RemoteBrowserApp \
  --display="${DISPLAY}" \
  --user-data-dir=/home/user/.config/chromium \
  --no-first-run \
  --no-sandbox \
  --test-type \
  --disable-file-system \
  --use-gl=angle \
  --use-angle=swiftshader \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --remote-allow-origins=* \
  --app='data:text/html,<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#000"></body>' \
  ${PROXY_FLAGS} \
  ${CHROMIUM_MOBILE_FLAGS}
