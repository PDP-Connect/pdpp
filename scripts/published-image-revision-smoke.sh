#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# The split reference/web images must identify the same published source
# revision. Pull before inspecting so a stale local tag cannot mask drift.
set -euo pipefail

REFERENCE_IMAGE="${PDPP_PUBLISHED_REFERENCE_IMAGE:-ghcr.io/pdp-connect/pdpp/reference:main}"
WEB_IMAGE="${PDPP_PUBLISHED_WEB_IMAGE:-ghcr.io/pdp-connect/pdpp/web:main}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "published-image-revision-smoke: required command not found: $1" >&2
    exit 127
  }
}

revision_for() {
  docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$1"
}

require_command docker

docker pull "$REFERENCE_IMAGE"
docker pull "$WEB_IMAGE"

reference_revision="$(revision_for "$REFERENCE_IMAGE")"
web_revision="$(revision_for "$WEB_IMAGE")"

if [[ -z "$reference_revision" || "$reference_revision" == "<no value>" ]]; then
  echo "published-image-revision-smoke: $REFERENCE_IMAGE has no org.opencontainers.image.revision label" >&2
  exit 1
fi

if [[ -z "$web_revision" || "$web_revision" == "<no value>" ]]; then
  echo "published-image-revision-smoke: $WEB_IMAGE has no org.opencontainers.image.revision label" >&2
  exit 1
fi

if [[ "$reference_revision" != "$web_revision" ]]; then
  echo "published-image-revision-smoke: image revisions differ" >&2
  echo "  $REFERENCE_IMAGE: $reference_revision" >&2
  echo "  $WEB_IMAGE: $web_revision" >&2
  exit 1
fi

printf 'published-image-revision-smoke: passed (%s)\n' "$reference_revision"
