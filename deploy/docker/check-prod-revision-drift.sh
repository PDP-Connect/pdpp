#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Compares a running production container's baked PDPP_REFERENCE_REVISION
# against origin. Exits nonzero (loudest for a revision that isn't on origin
# at all) so a caller — e.g. a systemd service on failure — can alert.
#
# Usage:
#   check-prod-revision-drift.sh [container-name]
#
# Env:
#   PDPP_DRIFT_CONTAINER      container to inspect (default: pdpp-core-prod-drain)
#   PDPP_DRIFT_REMOTE         git remote to fetch/compare against (default: origin)
#   PDPP_DRIFT_MAIN_BRANCH    branch drift is measured against (default: main)
#   PDPP_DRIFT_THRESHOLD_DAYS days behind main before this is a drift failure (default: 7)
#   PDPP_DRIFT_REPO_DIR       git repo to run the comparison from (default: this script's repo)

set -euo pipefail

CONTAINER="${1:-${PDPP_DRIFT_CONTAINER:-pdpp-core-prod-drain}}"
REMOTE="${PDPP_DRIFT_REMOTE:-origin}"
MAIN_BRANCH="${PDPP_DRIFT_MAIN_BRANCH:-main}"
THRESHOLD_DAYS="${PDPP_DRIFT_THRESHOLD_DAYS:-7}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${PDPP_DRIFT_REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

if ! command -v docker >/dev/null 2>&1; then
  echo "DRIFT CHECK ERROR: docker not found on PATH" >&2
  exit 2
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "DRIFT CHECK ERROR: container '$CONTAINER' not found (docker inspect failed)" >&2
  exit 2
fi

REVISION="$(docker inspect "$CONTAINER" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^PDPP_REFERENCE_REVISION=//p')"

if [[ -z "$REVISION" || "$REVISION" == "unknown" ]]; then
  echo "RULE 1 VIOLATION: container '$CONTAINER' has no usable PDPP_REFERENCE_REVISION (got: '${REVISION:-<empty>}'). This image was not built from a real commit — origin comparison is impossible." >&2
  exit 1
fi

cd "$REPO_DIR"
git fetch --quiet "$REMOTE" "$MAIN_BRANCH"

if ! git cat-file -e "${REVISION}^{commit}" 2>/dev/null; then
  echo "RULE 1 VIOLATION: revision '$REVISION' (from container '$CONTAINER') does not resolve to a known commit in this repo. Fetch may be incomplete, or the image was built from an unpushed/unknown ref." >&2
  exit 1
fi

MERGE_BASE="$(git merge-base "$REVISION" "$REMOTE/$MAIN_BRANCH" 2>/dev/null || true)"
if [[ -z "$MERGE_BASE" ]]; then
  echo "RULE 1 VIOLATION: revision '$REVISION' (from container '$CONTAINER') shares no history with $REMOTE/$MAIN_BRANCH. It is not on origin's mainline." >&2
  exit 1
fi

REVISION_ON_REMOTE="false"
if git branch -r --contains "$REVISION" 2>/dev/null | grep -q "$REMOTE/"; then
  REVISION_ON_REMOTE="true"
fi

REVISION_DATE_EPOCH="$(git show -s --format=%ct "$REVISION")"
MAIN_DATE_EPOCH="$(git show -s --format=%ct "$REMOTE/$MAIN_BRANCH")"
BEHIND_SECONDS=$(( MAIN_DATE_EPOCH - REVISION_DATE_EPOCH ))
BEHIND_DAYS=$(( BEHIND_SECONDS / 86400 ))
COMMITS_BEHIND="$(git rev-list --count "${REVISION}..${REMOTE}/${MAIN_BRANCH}" 2>/dev/null || echo "unknown")"

echo "container:        $CONTAINER"
echo "revision:         $REVISION"
echo "on $REMOTE:        $REVISION_ON_REMOTE"
echo "commits behind $MAIN_BRANCH: $COMMITS_BEHIND"
echo "days behind $MAIN_BRANCH:    $BEHIND_DAYS"
echo "threshold (days): $THRESHOLD_DAYS"

if [[ "$REVISION_ON_REMOTE" != "true" ]]; then
  echo "RULE 1 VIOLATION: revision '$REVISION' is not reachable from any $REMOTE branch. The running image predates or diverges from pushed history." >&2
  exit 1
fi

if (( BEHIND_DAYS > THRESHOLD_DAYS )); then
  echo "DRIFT: production is $BEHIND_DAYS days behind $REMOTE/$MAIN_BRANCH (threshold: $THRESHOLD_DAYS days, $COMMITS_BEHIND commits behind)." >&2
  exit 1
fi

echo "OK: production revision is on $REMOTE and within the ${THRESHOLD_DAYS}-day drift threshold."
exit 0
