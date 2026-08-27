#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Proves a built (or pulled) Core image carries exactly one non-"unknown"
# immutable git SHA, and that the SAME SHA is present in both places an
# acceptance receipt can read it from:
#
#   - the OCI image label org.opencontainers.image.revision (Dockerfile
#     LABEL, set from the PDPP_BUILD_REVISION build-arg)
#   - the runtime env var PDPP_REFERENCE_REVISION (Dockerfile ENV, the value
#     the running container advertises via the PDPP-Reference-Revision
#     response header and the stream-health acceptance receipt reads)
#
# This is the pre-acceptance gate: it inspects the image's own metadata, not
# a live origin, so it runs BEFORE any deploy/acceptance step and fails
# closed on exactly the defect that let the retained production Core image
# report org.opencontainers.image.revision=unknown with no way to attribute
# a live result to a commit.
#
# Equality and non-"unknown" alone do not prove the value is an immutable
# git object id: a build invoked with PDPP_REFERENCE_REVISION=main would
# produce label=main, env=main, which is an exact non-"unknown" match but
# names a MUTABLE ref, not a commit. Whenever the value is not the literal
# sentinel "unknown" — in EITHER mode, including --allow-unknown, which only
# widens acceptance for that one sentinel — this script also requires the
# value to be shaped like a real git object id: lowercase hex, full length
# only (40 for the current SHA-1 object format, or 64 to also accept a
# future SHA-256 repository). Abbreviated/short SHAs and any non-hex value
# (branch/tag names, "drain", "latest", etc.) are rejected outright. This is
# a format check only: it does not call `git cat-file` against a repo (an
# image inspector has no repo to check against), so it cannot prove the
# value resolves to a real commit — deploy/docker/check-prod-revision-drift.sh
# already owns that heavier origin-resolvability proof against a live
# container. This script's job is narrower and runs earlier: reject anything
# that is not even SHA-shaped before it can reach acceptance.
#
# Usage:
#   check-image-identity.sh <image-ref>
#   check-image-identity.sh --require-known <image-ref>   # default; release/UAT images
#   check-image-identity.sh --allow-unknown <image-ref>   # ordinary local dev build
#
# Env:
#   PDPP_IMAGE_IDENTITY_MODE   "require-known" (default) or "allow-unknown";
#                              overridden by the --require-known/--allow-unknown flag
#
# Exit codes:
#   0  identity proven: exactly one non-"unknown", full-length-hex SHA,
#      present and identical in both the label and the runtime env (or, in
#      --allow-unknown mode, both are honestly "unknown" — an ordinary local
#      dev build)
#   1  identity violation: missing, "unknown" under --require-known, not
#      shaped like a full-length git object id under --require-known, or a
#      mismatch between the label and the runtime env
#   2  usage/inspection error (bad args, image not found)

set -euo pipefail

MODE="${PDPP_IMAGE_IDENTITY_MODE:-require-known}"
IMAGE=""

for arg in "$@"; do
  case "$arg" in
    --require-known)
      MODE="require-known"
      ;;
    --allow-unknown)
      MODE="allow-unknown"
      ;;
    -*)
      echo "check-image-identity: unknown flag: $arg" >&2
      exit 2
      ;;
    *)
      if [[ -n "$IMAGE" ]]; then
        echo "check-image-identity: unexpected extra argument: $arg" >&2
        exit 2
      fi
      IMAGE="$arg"
      ;;
  esac
done

if [[ -z "$IMAGE" ]]; then
  echo "check-image-identity: usage: check-image-identity.sh [--require-known|--allow-unknown] <image-ref>" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "check-image-identity: required command not found: docker" >&2
  exit 2
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "check-image-identity: image not found (docker image inspect failed): $IMAGE" >&2
  exit 2
fi

LABEL_REVISION="$(docker image inspect "$IMAGE" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
if [[ "$LABEL_REVISION" == "<no value>" ]]; then
  LABEL_REVISION=""
fi

ENV_REVISION="$(docker image inspect "$IMAGE" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^PDPP_REFERENCE_REVISION=//p')"

echo "image:            $IMAGE"
echo "label revision:   ${LABEL_REVISION:-<missing>}"
echo "runtime revision: ${ENV_REVISION:-<missing>}"
echo "mode:             $MODE"

if [[ -z "$LABEL_REVISION" ]]; then
  echo "IDENTITY VIOLATION: image has no org.opencontainers.image.revision label" >&2
  exit 1
fi

if [[ -z "$ENV_REVISION" ]]; then
  echo "IDENTITY VIOLATION: image has no PDPP_REFERENCE_REVISION runtime env var" >&2
  exit 1
fi

if [[ "$LABEL_REVISION" != "$ENV_REVISION" ]]; then
  echo "IDENTITY VIOLATION: label and runtime revision disagree — a candidate image must carry exactly ONE revision, not two." >&2
  echo "  org.opencontainers.image.revision = $LABEL_REVISION" >&2
  echo "  PDPP_REFERENCE_REVISION           = $ENV_REVISION" >&2
  exit 1
fi

if [[ "$LABEL_REVISION" == "unknown" ]]; then
  if [[ "$MODE" == "allow-unknown" ]]; then
    echo "OK: ordinary local dev build — both label and runtime revision are honestly 'unknown' (no fabricated SHA)."
    exit 0
  fi
  echo "IDENTITY VIOLATION: revision is 'unknown' — this image cannot be attributed to a commit and must not reach acceptance. Build with --build-arg PDPP_REFERENCE_REVISION=\$(git rev-parse HEAD), or pass --allow-unknown for an ordinary local dev build." >&2
  exit 1
fi

# A matching, non-"unknown" value is still not proof of an immutable commit:
# PDPP_REFERENCE_REVISION=main (a mutable branch) would reach this point as
# an exact match. Require the value to be SHA-shaped — lowercase hex, full
# length only (40 hex = SHA-1 object id; 64 hex = a future SHA-256 object
# id) — before treating it as a real revision. Abbreviated SHAs are
# rejected on purpose: a short SHA is ambiguous and this is a build-time
# identity, not a display convenience.
#
# This check runs regardless of --allow-unknown: that flag only widens
# acceptance for the literal sentinel value "unknown" (handled above, which
# already returned before reaching here). It does not mean "accept any
# string as a revision" — a caller who explicitly set a non-"unknown",
# non-SHA value (a branch name, a typo, "latest") gets exactly the same
# rejection whether or not --allow-unknown was passed.
if ! [[ "$LABEL_REVISION" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]]; then
  echo "IDENTITY VIOLATION: revision '$LABEL_REVISION' is not shaped like a full-length git object id (40 lowercase hex chars for SHA-1, 64 for SHA-256)." >&2
  echo "  A mutable ref name (a branch, tag, or arbitrary string) is not an immutable commit identity, even when the label and runtime env agree on it." >&2
  echo "  Build with --build-arg PDPP_REFERENCE_REVISION=\$(git rev-parse HEAD) (the full SHA, not an abbreviation or a ref name)." >&2
  exit 1
fi

echo "OK: exact match — one immutable revision ($LABEL_REVISION) in both the OCI label and the runtime env."
exit 0
