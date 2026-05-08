#!/bin/sh
set -eu

DISPLAY_NAME="${NEKO_DESKTOP_DISPLAY:-${DISPLAY:-:99.0}}"

exec /usr/bin/neko serve \
  --server.static /var/www \
  --server.bind "${NEKO_SERVER_BIND:-127.0.0.1:8080}" \
  --server.path_prefix "${NEKO_SERVER_PATH_PREFIX:-/}" \
  --server.proxy="${NEKO_SERVER_PROXY:-false}" \
  --member.provider "${NEKO_MEMBER_PROVIDER:-multiuser}" \
  --session.implicit_hosting="${NEKO_SESSION_IMPLICIT_HOSTING:-true}" \
  --session.cookie.enabled="${NEKO_SESSION_COOKIE_ENABLED:-false}" \
  --desktop.display "${DISPLAY_NAME}" \
  --desktop.screen "${NEKO_DESKTOP_SCREEN:-1280x720@30}" \
  --capture.video.display "${DISPLAY_NAME}" \
  --webrtc.udpmux "${NEKO_WEBRTC_UDPMUX:-0}" \
  --webrtc.tcpmux "${NEKO_WEBRTC_TCPMUX:-0}" \
  --webrtc.icelite="${NEKO_WEBRTC_ICELITE:-false}" \
  --webrtc.nat1to1 "${NEKO_WEBRTC_NAT1TO1:-}" \
  --webrtc.iceservers.frontend "${NEKO_WEBRTC_ICESERVERS:-[]}" \
  --webrtc.iceservers.backend "${NEKO_WEBRTC_ICESERVERS_BACKEND:-[]}"
