#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
repo_root=$(cd "$script_dir/../../../../.." && pwd)
tools_dir=${PDPP_SLACKDUMP_TOOLS_DIR:-"$repo_root/packages/polyfill-connectors/.pdpp-tools/slackdump"}

cd "$script_dir"
go mod verify
mkdir -p "$tools_dir"
go build -trimpath -ldflags='-s -w' -o "$tools_dir/slackdump-identity" .
"$tools_dir/slackdump-identity" --version
