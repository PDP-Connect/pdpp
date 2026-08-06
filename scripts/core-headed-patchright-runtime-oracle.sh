#!/usr/bin/env bash
set -euo pipefail

image="${PDPP_CORE_ORACLE_IMAGE:-pdpp-core-headed-oracle}"
volume="pdpp-core-headed-oracle-$$"
container_prefix="pdpp-core-headed-oracle-$$"

cleanup() {
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --target core --tag "$image" .
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
