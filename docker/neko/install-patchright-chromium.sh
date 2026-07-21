#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# Install Patchright's bundled Chromium without invoking `npx patchright
# install`, whose out-of-process extractor (extract-zip/yauzl) hangs after the
# download completes in some sandboxed/overlayfs build environments: the zip
# arrives intact ("SUCCESS downloading", "download complete"), the child logs
# "extracting archive", and the extraction promise then never resolves, so the
# Docker build stalls indefinitely at the `patchright-chromium` stage.
#
# The bytes are never the problem — `unzip` of the very same archive completes
# in seconds. So we reproduce exactly what a real `patchright install` would
# leave on disk:
#
#   $PLAYWRIGHT_BROWSERS_PATH/chromium-<revision>/chrome-linux64/chrome   (+tree)
#   $PLAYWRIGHT_BROWSERS_PATH/chromium-<revision>/INSTALLATION_COMPLETE   (marker)
#
# but extract with the system `unzip` instead of patchright's bundled extractor.
#
# The Chromium revision (1217) and browserVersion (147.0.7727.15) are read from
# the patchright-core package that npm just installed, so this stays pinned to
# whatever `patchright@<version>` the Dockerfile selected — no magic numbers
# duplicated here, and a patchright bump updates the download automatically.
#
# start-chromium.sh resolves the binary at runtime by globbing
# /opt/patchright-browsers/chromium-*/chrome-linux64/chrome, so the only hard
# requirement is the binary tree at that path; the marker is written for
# fidelity with a real install in case anything consults the registry.
set -euo pipefail

: "${PLAYWRIGHT_BROWSERS_PATH:?PLAYWRIGHT_BROWSERS_PATH must be set}"

WORKDIR="${1:-$PWD}"
cd "$WORKDIR"

# Resolve the chromium revision + version from the installed patchright-core,
# and the CDN host from the same package, so the URL tracks the pinned version.
# shellcheck disable=SC2016  # the node -e body below is JS source, not shell; single quotes are intentional
read -r REVISION BROWSER_VERSION <<EOF
$(node -e '
  const fs = require("fs");
  const dir = require.resolve("patchright-core/package.json").replace(/package\.json$/, "");
  const browsers = JSON.parse(fs.readFileSync(dir + "browsers.json", "utf8"));
  const chromium = browsers.browsers.find((b) => b.name === "chromium");
  if (!chromium) throw new Error("no chromium descriptor in patchright browsers.json");
  process.stdout.write(`${chromium.revision} ${chromium.browserVersion}`);
')
EOF

if [ -z "${REVISION:-}" ] || [ -z "${BROWSER_VERSION:-}" ]; then
  echo "install-patchright-chromium: failed to resolve chromium revision/version" >&2
  exit 1
fi

DEST_DIR="${PLAYWRIGHT_BROWSERS_PATH}/chromium-${REVISION}"
MARKER="${DEST_DIR}/INSTALLATION_COMPLETE"
BINARY="${DEST_DIR}/chrome-linux64/chrome"

if [ -x "$BINARY" ] && [ -f "$MARKER" ]; then
  echo "install-patchright-chromium: chromium-${REVISION} already present, skipping"
  exit 0
fi

# Same CDN path template patchright uses: builds/cft/<version>/linux64/chrome-linux64.zip
URL="https://cdn.playwright.dev/builds/cft/${BROWSER_VERSION}/linux64/chrome-linux64.zip"
ZIP="$(mktemp /tmp/patchright-chromium-XXXXXX.zip)"
trap 'rm -f "$ZIP"' EXIT

echo "install-patchright-chromium: downloading chromium ${BROWSER_VERSION} (revision ${REVISION})"
echo "install-patchright-chromium:   from ${URL}"
# --retry guards transient CDN hiccups; --fail surfaces non-2xx as a build error.
curl -fSL --retry 3 --retry-delay 2 -o "$ZIP" "$URL"

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
echo "install-patchright-chromium: extracting with system unzip into ${DEST_DIR}"
unzip -q "$ZIP" -d "$DEST_DIR"

if [ ! -e "$BINARY" ]; then
  echo "install-patchright-chromium: expected chrome binary missing at ${BINARY}" >&2
  echo "install-patchright-chromium: extracted tree:" >&2
  find "$DEST_DIR" -maxdepth 2 >&2
  exit 1
fi

chmod 0755 "$BINARY"
# Mark the install complete exactly as patchright's installer does once the
# extraction step finishes, so the on-disk layout is indistinguishable.
: > "$MARKER"

echo "install-patchright-chromium: installed chromium-${REVISION}; binary at ${BINARY}"
