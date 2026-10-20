#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Current-main baseline. The historical reference runner default remains unchanged.
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
: "${PDPP_DC_REF:?Set PDPP_DC_REF to the clean reference checkout}"
: "${PDPP_VANA_PS:?Set PDPP_VANA_PS to the clean PS checkout}"
: "${PDPP_BASELINE_OUT:?Set PDPP_BASELINE_OUT to an output directory}"
export PDPP_DC_PIN=e94f4fd9c6683e8284143dbccf29a12bc7370b94
export PDPP_VANA_REF=0b5eac036a33cb714cdd6d3a71abddd98e609f2d
mkdir -p "$PDPP_BASELINE_OUT"
OUT="$(cd "$PDPP_BASELINE_OUT" && pwd)"
exec 6>"$OUT/.baseline.lock"
flock -n 6 || { echo 'Baseline output directory is in use' >&2; exit 1; }
OUT="$(mktemp -d "$OUT/run.XXXXXX")"
printf 'Baseline run directory: %s\n' "$OUT"
ref_status=0
mkdir -p "$OUT/reference-v01" "$OUT/ps-v01"
node "$PACKAGE_DIR/scripts/bind-baseline.mjs" --snapshot "$OUT/reference-v01/suite-source.json"
bash "$PACKAGE_DIR/scripts/reference-target.sh" run --out "$OUT/reference-v01" || ref_status=$?
node "$PACKAGE_DIR/scripts/bind-baseline.mjs" --out "$OUT/reference-v01" \
  --target-checkout "$PDPP_DC_REF" --target-sha "$PDPP_DC_PIN" \
  --target-repo PDP-Connect/data-connect --suite-exit "$ref_status"
ps_status=0
node "$PACKAGE_DIR/scripts/bind-baseline.mjs" --snapshot "$OUT/ps-v01/suite-source.json"
PDPP_VANA_REPORT_DIR="$OUT/ps-v01" bash "$PACKAGE_DIR/scripts/vana-target.sh" run || ps_status=$?
node "$PACKAGE_DIR/scripts/bind-baseline.mjs" --out "$OUT/ps-v01" \
  --target-checkout "$PDPP_VANA_PS" --target-sha "$PDPP_VANA_REF" \
  --target-repo vana-com/personal-server-ts --suite-exit "$ps_status"
# Failure dominates incomplete coverage; neither is converted into success.
if [[ "$ref_status" = 1 || "$ps_status" = 1 ]]; then exit 1; fi
if [[ "$ref_status" != 0 ]]; then exit "$ref_status"; fi
exit "$ps_status"
