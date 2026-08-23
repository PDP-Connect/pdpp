#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# Proves the npm package works without a workspace, pnpm overrides, or a
# pre-existing npm cache. This is intentionally an external-artifact smoke,
# not a package-local build check.
set -euo pipefail

NODE_IMAGE="${PDPP_PUBLISHED_SMOKE_NODE_IMAGE:-node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "published-local-collector-advertise-smoke: required command not found: $1" >&2
    exit 127
  }
}

require_command docker

docker run --rm --network bridge "$NODE_IMAGE" sh -ceu '
  advertised="$(NPM_CONFIG_UPDATE_NOTIFIER=false npx -y @pdpp/local-collector advertise)"
  ADVERTISED="$advertised" node --input-type=module -e "
    const advertised = JSON.parse(process.env.ADVERTISED ?? \"\");
    if (advertised.runtime !== \"collector\") {
      throw new Error(\"advertise.runtime must be collector\");
    }
    if (!Array.isArray(advertised.bindings)) {
      throw new Error(\"advertise.bindings must be an array\");
    }
    for (const binding of [\"network\", \"filesystem\", \"local_device\"]) {
      if (!advertised.bindings.includes(binding)) {
        throw new Error(\"advertise.bindings is missing \" + binding);
      }
    }
  "
'

echo "published-local-collector-advertise-smoke: passed ($NODE_IMAGE)"
