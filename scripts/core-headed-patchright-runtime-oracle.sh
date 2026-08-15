#!/usr/bin/env bash
set -euo pipefail

image="${PDPP_CORE_ORACLE_IMAGE:-pdpp-core-headed-oracle}"
volume="pdpp-core-headed-oracle-$$"
container_prefix="pdpp-core-headed-oracle-$$"

cleanup() {
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# CI already builds the `core` target once (docker-images.yml validate job) and
# loads it under a known tag; set PDPP_CORE_ORACLE_SKIP_BUILD=1 with
# PDPP_CORE_ORACLE_IMAGE pointing at that tag to prove the exact image under
# test instead of paying for a second build.
if [ "${PDPP_CORE_ORACLE_SKIP_BUILD:-0}" != "1" ]; then
  docker build --target core --tag "$image" .
fi
docker volume create "$volume" >/dev/null

docker run --rm --name "${container_prefix}-first" \
  --mount "type=volume,source=${volume},destination=/var/lib/pdpp" \
  -e PDPP_CORE_RUNTIME_ORACLE=1 \
  "$image"

if [ -n "$(docker ps -aq --filter "name=${container_prefix}-first")" ]; then
  echo "runtime oracle container was not removed after the first run" >&2
  exit 1
fi

docker run --rm --name "${container_prefix}-restart" \
  --mount "type=volume,source=${volume},destination=/var/lib/pdpp" \
  -e PDPP_CORE_RUNTIME_ORACLE=1 \
  -e PDPP_CORE_RUNTIME_ORACLE_EXPECT_PERSISTED=1 \
  "$image"

if [ -n "$(docker ps -aq --filter "name=${container_prefix}-restart")" ]; then
  echo "runtime oracle container was not removed after the restart run" >&2
  exit 1
fi

echo "[core-runtime-oracle] PASS production image restart and container cleanup"
