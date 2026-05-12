# syntax=docker/dockerfile:1.6

# Global ARG — re-declared inside each FROM stage that uses it. Default
# pinned to a specific neko/chromium digest so the upstream base never
# changes underneath us; bumping requires an explicit edit.
ARG NEKO_BASE_IMAGE=ghcr.io/m1k1o/neko/chromium:3.0@sha256:13264ee217ecccda06b07aa7543dc12d8f9a423ace344b6bda6ebf6d2ecea193

# ─── Stage 1: fetch Patchright's bundled Chromium ─────────────────────────
# We bake Patchright's binary into the neko image so the X server displays
# the same patched build the upstream Patchright maintainers ship. This is
# what gives us the C-level stealth patches (navigator.webdriver, permissions
# API quirks, CDP-leak fixes that exist below the JS boundary). Driver-side
# stealth (no Runtime.enable, Route-based init injection) is owned by the
# reference container's `chromium.connectOverCDP(...)` call and is
# independent of which binary is on disk here — but the binary patches only
# come from this binary.
#
# Pinned to patchright@1.59.4 (matching the reference container) so the
# revision (Chromium 1217, "Chrome for Testing 147.0.7727.15") stays in
# lockstep with what the driver expects to see in Browser.getVersion.
FROM node:24-slim AS patchright-chromium
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/patchright-browsers /tmp/patchright-install
WORKDIR /tmp/patchright-install
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/patchright-browsers
# Initialise a throwaway package.json so npm doesn't try to write tracker
# metadata into the cache mount (which conflicts with --mount=type=cache).
# `--no-shell` skips the chrome_headless_shell binary we don't need.
RUN echo '{"name":"patchright-installer","private":true,"version":"0.0.0"}' > package.json \
  && npm install --no-save patchright@1.59.4 \
  && npx patchright install chromium --no-shell

# ─── Stage 2: neko runtime ────────────────────────────────────────────────
ARG NEKO_BASE_IMAGE
FROM ${NEKO_BASE_IMAGE} AS neko-runtime

# Copy Patchright's downloaded Chromium tree (chromium-XXXX/, ffmpeg-XXXX/)
# from the patchright-chromium stage. start-chromium.sh resolves the binary
# at runtime by globbing /opt/patchright-browsers/chromium-*/chrome-linux64/chrome
# so version bumps don't require touching the script.
COPY --from=patchright-chromium /opt/patchright-browsers /opt/patchright-browsers

# Install Google Chrome alongside the base image's Chromium. Real branded
# Chrome carries fingerprint signals (extensions surface, chrome.runtime,
# component updater traffic) that bot-protection systems treat as
# distinctly human compared to vanilla Chromium. start-chromium.sh prefers
# google-chrome-stable when present and falls back to /usr/bin/chromium so
# the image still boots if this install ever fails.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

COPY docker/neko/xorg.conf /etc/neko/xorg.conf
COPY docker/neko/neko.yaml /etc/neko/neko.yaml
COPY docker/neko/policies.json /etc/chromium/policies/managed/policies.json
# Same policy file is also installed under Chrome's managed-policy path so
# the policies apply whether start-chromium.sh boots google-chrome-stable
# or falls back to /usr/bin/chromium.
RUN install -d /etc/opt/chrome/policies/managed \
  && cp /etc/chromium/policies/managed/policies.json \
        /etc/opt/chrome/policies/managed/policies.json
COPY docker/neko/chromium.conf /etc/neko/supervisord/chromium.conf
COPY docker/neko/cdp-proxy.conf /etc/neko/supervisord/cdp-proxy.conf
COPY docker/neko/start-chromium.sh /usr/local/bin/start-chromium.sh
COPY docker/neko/start-neko.sh /usr/local/bin/start-neko.sh
COPY docker/neko/cdp-proxy.py /usr/local/bin/cdp-proxy.py

RUN chmod +x /usr/local/bin/start-chromium.sh /usr/local/bin/start-neko.sh /usr/local/bin/cdp-proxy.py \
  && sed -i 's#command=/usr/bin/neko serve --server.static "/var/www"#command=/usr/local/bin/start-neko.sh#' /etc/neko/supervisord.conf \
  && sed -i '/<applications>/a\    <application class="RemoteBrowserApp">\
      <decor>no</decor>\
      <position force="yes">\
        <x>0</x>\
        <y>0</y>\
      </position>\
      <focus>yes</focus>\
      <layer>normal</layer>\
    </application>\
' /etc/neko/openbox.xml \
  && printf '#!/bin/sh\nrm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /tmp/xf86-input-neko.sock\nrm -f /home/user/.config/chromium/SingletonLock /home/user/.config/chromium/SingletonSocket /home/user/.config/chromium/SingletonCookie\nexec "$@"\n' > /usr/local/bin/pdpp-neko-entrypoint.sh \
  && chmod +x /usr/local/bin/pdpp-neko-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/pdpp-neko-entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/neko/supervisord.conf"]
