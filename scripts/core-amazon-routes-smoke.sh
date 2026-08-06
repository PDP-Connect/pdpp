#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Built-image smoke for the Core `amazon` connector-registration terminal fix.
#
# Root cause: reference-implementation/server/index.ts's generic
# shouldAutoReconcilePolyfillManifests() default is fail-closed for SQLite
# (it only auto-enables for the dev script's
# ../packages/polyfill-connectors/.pdpp-data/pdpp.sqlite path or for
# Postgres). The published `core` image's baked-in SQLite default
# (/var/lib/pdpp/pdpp.sqlite, Dockerfile `core-browser` stage) does not match
# that sentinel, so first-party manifests (amazon, ...) were never registered
# on a real Core boot and both the static-secret and browser-session connect
# routes 404'd for a fresh SQLite-default deployment. The fix bakes
# PDPP_RECONCILE_POLYFILL_MANIFESTS=1 into the `core-browser` Dockerfile
# stage (Core only — `reference`/`reference-browser` compatibility images are
# untouched).
#
# This script proves the fix against the ACTUAL BUILT `core` image, not a
# source-level assertion: it builds (or reuses) the image, boots one
# container exactly like the documented quickstart
# (`docker run ... -v pdpp_data:/var/lib/pdpp ... core`), and drives the real
# HTTP surface an owner/browser would hit.
#
# Usage:
#   bash scripts/core-amazon-routes-smoke.sh
#   PDPP_CORE_SMOKE_IMAGE=ghcr.io/pdp-connect/pdpp/core:main bash scripts/core-amazon-routes-smoke.sh
#
# Env knobs:
#   PDPP_CORE_SMOKE_IMAGE   Reuse an already-built image instead of building
#                           one locally (CI can pass the image it just built).
#   PDPP_CORE_SMOKE_PORT    Host port to publish (default 3011, distinct from
#                           the dev-stack's 3000/3002 so it can run alongside).
#
# Requires Docker. This is a live-gate smoke, not a CI unit test — run it
# manually or from a dedicated Docker-enabled job, same convention as
# scripts/docker-smoke.sh and scripts/railway-sqlite-restart-smoke.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CONTAINER_NAME="${PDPP_CORE_SMOKE_CONTAINER_NAME:-pdpp-core-amazon-smoke-$$}"
VOLUME_NAME="${PDPP_CORE_SMOKE_VOLUME_NAME:-pdpp-core-amazon-smoke-data-$$}"
PORT="${PDPP_CORE_SMOKE_PORT:-3011}"
ORIGIN="http://localhost:${PORT}"
OWNER_PASSWORD="${PDPP_OWNER_PASSWORD:-$(node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")}"
IMAGE="${PDPP_CORE_SMOKE_IMAGE:-}"
BUILT_IMAGE=0

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  if [[ "$BUILT_IMAGE" == "1" && -n "${IMAGE:-}" ]]; then
    docker image rm "$IMAGE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "$IMAGE" ]]; then
  IMAGE="pdpp-core-amazon-smoke:$$"
  BUILT_IMAGE=1
  echo "[1/5] building core image ($IMAGE) ..."
  docker build --target core -t "$IMAGE" .
else
  echo "[1/5] reusing supplied image: $IMAGE"
fi

IMAGE_ENV="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE")"
if ! grep -Fxq 'PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite' <<<"$IMAGE_ENV"; then
  echo "Core image is missing its SQLite default PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite" >&2
  exit 1
fi
if ! grep -Fxq 'PDPP_RECONCILE_POLYFILL_MANIFESTS=1' <<<"$IMAGE_ENV"; then
  echo "Core image is missing PDPP_RECONCILE_POLYFILL_MANIFESTS=1" >&2
  exit 1
fi
echo "  ok: image carries the Core SQLite and reconciliation defaults"

echo "[2/5] booting one-container Core (SQLite default /var/lib/pdpp/pdpp.sqlite) ..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER_NAME" \
  -p "${PORT}:3000" \
  -v "${VOLUME_NAME}:/var/lib/pdpp" \
  -e "PDPP_OWNER_PASSWORD=${OWNER_PASSWORD}" \
  -e "PDPP_REFERENCE_ORIGIN=${ORIGIN}" \
  -e "PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0" \
  "$IMAGE" >/dev/null

wait_for() {
  local url="$1"
  local label="$2"
  local max="${3:-120}"
  local start
  start="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if (( $(date +%s) - start >= max )); then
      echo "Timed out waiting for $label at $url" >&2
      docker logs --tail=200 "$CONTAINER_NAME" >&2 || true
      return 1
    fi
    sleep 2
  done
}

wait_for "$ORIGIN/.well-known/oauth-authorization-server" "authorization metadata"

echo "[3/5] asserting boot logs show Amazon manifest reconciliation ..."
BOOT_LOGS="$(docker logs "$CONTAINER_NAME" 2>&1)"
if ! grep -q "manifest-reconcile" <<<"$BOOT_LOGS"; then
  echo "Expected [manifest-reconcile] activity in boot logs; found none. PDPP_RECONCILE_POLYFILL_MANIFESTS default did not take effect." >&2
  echo "$BOOT_LOGS" | tail -n 200 >&2
  exit 1
fi
if ! grep -Eq "manifest-reconcile\].*registered listed first-party manifest .* from amazon\.json" <<<"$BOOT_LOGS"; then
  echo "Expected boot logs to show Amazon registration during reconciliation; found none." >&2
  echo "$BOOT_LOGS" | grep "manifest-reconcile" >&2 || true
  exit 1
fi
echo "  ok: boot logs show amazon manifest reconciliation"

echo "[4/5] logging in as owner and probing the amazon connect routes ..."
node --import tsx - "$ORIGIN" "$OWNER_PASSWORD" <<'NODE'
import { establishOwnerSessionCookie } from "./scripts/lib/owner-session.ts";

const [, , origin, ownerPassword] = process.argv;

async function main() {
  const cookie = await establishOwnerSessionCookie({ origin, ownerPassword });
  if (!cookie) {
    throw new Error("owner login did not return a session cookie");
  }

  // GET /connect/static-secret/amazon must resolve the amazon manifest and
  // render the setup page (200), not 404 (unregistered connector).
  const staticSecretResp = await fetch(`${origin}/connect/static-secret/amazon`, {
    headers: { cookie, accept: "text/html" },
    redirect: "manual",
  });
  if (staticSecretResp.status !== 200) {
    throw new Error(
      `GET /connect/static-secret/amazon expected 200, got ${staticSecretResp.status}. ` +
        `A non-200 here means the amazon manifest was not registered at boot.`
    );
  }
  console.log("  ok: GET /connect/static-secret/amazon -> 200");

  // POST /connect/browser-session/amazon/start must classify amazon as a
  // supported browser-collector connector, resolve its manifest via
  // createBrowserEnrollmentShell, and redirect to the launch step — not a
  // backend 404 from an unregistered connector.
  const browserSessionResp = await fetch(`${origin}/connect/browser-session/amazon/start`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "",
    redirect: "manual",
  });
  if (![302, 303, 307, 308].includes(browserSessionResp.status)) {
    const body = await browserSessionResp.text().catch(() => "<unreadable body>");
    throw new Error(
      `POST /connect/browser-session/amazon/start expected a redirect, got ${browserSessionResp.status}: ${body.slice(0, 500)}`
    );
  }
  const location = browserSessionResp.headers.get("location") ?? "";
  if (!location.includes("/connect/browser-session/amazon/launch")) {
    throw new Error(
      `POST /connect/browser-session/amazon/start redirected to an unexpected location: ${location}. ` +
        "Expected the launch step, not an error/backend-404 bounce."
    );
  }
  console.log(`  ok: POST /connect/browser-session/amazon/start -> ${browserSessionResp.status} ${location}`);

  // Custom-manifest isolation: an id outside the shipped first-party set must
  // stay unregistered (reconciliation only ever reads
  // packages/polyfill-connectors/manifests/*.json — see
  // reference-implementation/server/polyfill-manifest-reconcile.ts). Proven
  // here as a real HTTP 404, not a source-code assertion: reconciliation
  // running for real on this boot did not spuriously register an unrelated
  // custom id.
  const customResp = await fetch(`${origin}/connect/static-secret/not-a-shipped-connector-smoke-probe`, {
    headers: { cookie, accept: "text/html" },
    redirect: "manual",
  });
  if (customResp.status !== 404) {
    throw new Error(
      `GET /connect/static-secret/not-a-shipped-connector-smoke-probe expected 404 (untouched by reconciliation), got ${customResp.status}`
    );
  }
  console.log("  ok: non-shipped connector id stays unregistered (404) after boot reconciliation");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
NODE

echo "[5/5] done"
echo
echo "Core amazon-routes smoke passed for $ORIGIN"
