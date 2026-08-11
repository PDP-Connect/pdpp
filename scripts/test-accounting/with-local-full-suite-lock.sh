#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "usage: with-local-full-suite-lock.sh COMMAND [ARG ...]" >&2
  exit 64
fi
if [[ -n "${CI:-}" ]]; then
  exec "$@"
fi

git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
lock_path="${git_common_dir}/pdpp-test-accounting.lock"
exec 9>"${lock_path}"
if ! flock --nonblock 9; then
  echo "Another full PDPP test-accounting run is active; waiting for it to finish." >&2
  flock 9
fi

exec "$@"
