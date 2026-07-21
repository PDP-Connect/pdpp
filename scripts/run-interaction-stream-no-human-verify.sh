#!/usr/bin/env bash
# Consolidated no-human verification for add-run-interaction-streaming-companion.
#
# The streaming-companion change has a long tail of tasks (12.8, 13.5, 14.7,
# 15.8, 17.5) whose remaining work is "re-run affected checks, rebuild/recreate
# the n.eko Docker overlay, and run public desktop plus real-phone smoke". The
# real-phone half is inherently physical. This script runs every part of those
# tasks that needs no human and no browser-on-a-phone, so the residual live
# matrix is small, explicit, and auditable.
#
# It always runs the deterministic checks. It additionally runs the gated
# live-CDP smoke when a Chrome/Chromium binary is discoverable, and the n.eko
# Docker allocator overlay smoke when PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1
# and Docker is reachable. Optional checks that cannot run are reported as
# SKIP with the exact env needed, never as silent passes.
#
# Usage:
#   bash scripts/run-interaction-stream-no-human-verify.sh
#   PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1 \
#     bash scripts/run-interaction-stream-no-human-verify.sh   # add Docker overlay smoke
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASS=()
FAIL=()
SKIP=()

run() {
  # run <label> <command...>
  local label="$1"
  shift
  printf '\n=== %s ===\n' "$label"
  if "$@"; then
    PASS+=("$label")
  else
    FAIL+=("$label")
    printf '!!! FAILED: %s\n' "$label"
  fi
}

skip() {
  local label="$1"
  local why="$2"
  printf '\n=== %s ===\nSKIP: %s\n' "$label" "$why"
  SKIP+=("$label -- $why")
}

chrome_available() {
  for bin in google-chrome google-chrome-stable chromium chromium-browser chrome; do
    command -v "$bin" >/dev/null 2>&1 && return 0
  done
  [ -n "${PDPP_TEST_CDP_BIN:-}" ] && command -v "${PDPP_TEST_CDP_BIN}" >/dev/null 2>&1
}

# --- Deterministic checks (always run, no human, no browser) ---------------

run "OpenSpec validate (change, strict)" \
  pnpm exec openspec validate add-run-interaction-streaming-companion --strict

run "OpenSpec validate (--all, strict)" \
  pnpm exec openspec validate --all --strict

run "remote-surface unit tests" \
  pnpm --dir packages/remote-surface run test

run "remote-surface typecheck" \
  pnpm --dir packages/remote-surface run typecheck

# Scoped to the streaming surface on purpose. The full
# `reference-implementation test` suite carries baseline failures unrelated to
# this change (e.g. example-client.test.js reads a now-deleted apps/web path,
# and hosted-mcp-oauth spotify fanout). Those are tracked separately; gating
# streaming closeout on them would be dishonest. Run the full suite directly if
# you want the whole-repo picture.
run "reference-implementation streaming unit tests" \
  node --test --test-force-exit \
    reference-implementation/test/run-interaction-stream-cdp-adapter.test.js \
    reference-implementation/test/run-interaction-stream-companion.test.js \
    reference-implementation/test/run-interaction-stream-neko-adapter.test.js \
    reference-implementation/test/run-interaction-stream-neko-compose.test.js \
    reference-implementation/test/run-interaction-stream-playground.test.js \
    reference-implementation/test/run-interaction-stream-routes.test.js \
    reference-implementation/test/run-interaction-stream-store.test.js \
    reference-implementation/test/neko-surface-allocator.test.js \
    reference-implementation/test/neko-surface-allocator-server.test.js \
    reference-implementation/test/server-neko-runtime-config.test.js \
    reference-implementation/test/manifest-stream-availability.test.js \
    reference-implementation/test/assistant-readiness-smoke.test.js \
    reference-implementation/server/streaming/cdp-method-allowlist.test.js \
    reference-implementation/server/streaming/neko-adapter.test.js \
    reference-implementation/server/streaming/playground.test.js \
    reference-implementation/server/streaming/run-target-registry.test.js

run "local phone-surface parity oracle" \
  pnpm stream:parity:oracle

run "reference-implementation typecheck" \
  pnpm --dir reference-implementation run typecheck

run "console types:check (stream viewer + n.eko client compile)" \
  pnpm --dir apps/console run types:check

run "git diff --check (whitespace/conflict markers)" \
  git diff --check

# --- Gated live-CDP smoke (no human; needs a local Chrome) -----------------

if chrome_available; then
  run "live-CDP smoke against real headless Chromium (frame/ack/input/resize)" \
    env PDPP_TEST_LIVE_CDP=1 pnpm --dir reference-implementation run test:live-cdp
else
  skip "live-CDP smoke" \
    "no Chrome/Chromium found; set PDPP_TEST_CDP_BIN or install google-chrome to run \`pnpm --dir reference-implementation test:live-cdp\`"
fi

# --- Gated n.eko Docker overlay smoke (no human; rebuilds/recreates n.eko) --

if [ "${PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE:-}" = "1" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    run "n.eko Docker dynamic-allocator overlay smoke (rebuild/recreate)" \
      bash scripts/docker-neko-dynamic-allocator-smoke.sh
  else
    skip "n.eko Docker overlay smoke" \
      "PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1 set but Docker daemon is unreachable"
  fi
else
  skip "n.eko Docker overlay smoke" \
    "set PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1 (Docker required) to rebuild/recreate the n.eko overlay and prove dynamic surface allocation"
fi

# --- Summary ----------------------------------------------------------------

printf '\n================ NO-HUMAN STREAM CLOSEOUT SUMMARY ================\n'
printf 'PASS (%d):\n' "${#PASS[@]}"
for item in "${PASS[@]:-}"; do [ -n "$item" ] && printf '  [pass] %s\n' "$item"; done
if [ "${#SKIP[@]}" -gt 0 ]; then
  printf 'SKIP (%d):\n' "${#SKIP[@]}"
  for item in "${SKIP[@]}"; do printf '  [skip] %s\n' "$item"; done
fi
if [ "${#FAIL[@]}" -gt 0 ]; then
  printf 'FAIL (%d):\n' "${#FAIL[@]}"
  for item in "${FAIL[@]}"; do printf '  [fail] %s\n' "$item"; done
fi

cat <<'LIVE'

------------------ RESIDUAL LIVE-DEVICE MATRIX -------------------
The checks above cover every no-human part of tasks 12.8, 13.5, 14.7,
15.8, and 17.5. What remains is physical and cannot be self-certified:

  1. Public desktop smoke against the deployed origin:
       PDPP_STREAM_SMOKE_URL=https://pdpp-dev.example.com \
         pnpm docker:stream-smoke
       (recreate `reference` + `neko` together first; see the
        Manual Acceptance Checklist in
        openspec/changes/add-run-interaction-streaming-companion/
        design-notes/neko-ux-acceptance-2026-05-06.md)

  2. Real-phone smoke (no automation substitute): soft-keyboard
     open/dismiss/reopen, touch precision (<=10 CSS px), rotation
     settle (<=250 ms), reconnect/app-switch recovery, local-to-remote
     paste, and visual sharpness -- per the same checklist.

Mobile-emulated Playwright smoke is NOT a substitute for item 2.
LIVE

if [ "${#FAIL[@]}" -gt 0 ]; then
  exit 1
fi
printf '\nAll no-human stream closeout checks passed.\n'
