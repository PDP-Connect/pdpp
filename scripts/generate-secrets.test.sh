#!/usr/bin/env bash
#
# Tests for scripts/generate-secrets.sh
#
# Verifies:
#   1. stdout mode: all four variables present, non-empty, non-example values.
#   2. --write mode: patches a copy of .env.docker.example correctly.
#   3. Idempotence: a second --write run does not change already-set values.
#   4. No-overwrite: existing non-empty values are preserved.
#
# Run: bash scripts/generate-secrets.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/generate-secrets.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLE="$REPO_ROOT/.env.docker.example"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

FAILURES=0

# ---- setup ------------------------------------------------------------------

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ---- helper -----------------------------------------------------------------

# Extract a variable value from a KEY=VALUE line in a file.
get_var() {
  local file="$1" var="$2"
  grep -E "^${var}=" "$file" | head -1 | cut -d= -f2-
}

# ---- test 1: stdout mode produces all four variables with non-empty values ---

OUTPUT="$("$SCRIPT")"

for var in PDPP_OWNER_PASSWORD SESSION_SECRET PDPP_WEB_PUSH_VAPID_PUBLIC_KEY PDPP_WEB_PUSH_VAPID_PRIVATE_KEY; do
  val="$(printf '%s\n' "$OUTPUT" | grep -E "^${var}=" | head -1 | cut -d= -f2-)"
  if [[ -z "$val" ]]; then
    fail "stdout: $var is empty"
  elif [[ "$val" == "your-"* || "$val" == "change-me"* || "$val" == "example"* ]]; then
    fail "stdout: $var looks like a placeholder: $val"
  else
    pass "stdout: $var is non-empty"
  fi
done

# ---- test 2: --write patches .env.docker.example keys ----------------------

ENV_FILE="$TMP_DIR/.env.docker"
cp "$EXAMPLE" "$ENV_FILE"

# Patch the file path argument by using --out then manually running --write on our copy.
# The script's --write hardcodes ".env.docker"; run from TMP_DIR.
(cd "$TMP_DIR" && bash "$SCRIPT" --write)

for var in PDPP_OWNER_PASSWORD SESSION_SECRET PDPP_WEB_PUSH_VAPID_PUBLIC_KEY PDPP_WEB_PUSH_VAPID_PRIVATE_KEY; do
  val="$(get_var "$ENV_FILE" "$var")"
  if [[ -z "$val" ]]; then
    fail "--write: $var still empty after patch"
  else
    pass "--write: $var set to non-empty value"
  fi
done

# ---- test 3: idempotence — second run does not change values ----------------

PASS_VAL_PASSWORD="$(get_var "$ENV_FILE" PDPP_OWNER_PASSWORD)"
PASS_VAL_SESSION="$(get_var "$ENV_FILE" SESSION_SECRET)"
PASS_VAL_VAPID_PUB="$(get_var "$ENV_FILE" PDPP_WEB_PUSH_VAPID_PUBLIC_KEY)"
PASS_VAL_VAPID_PRV="$(get_var "$ENV_FILE" PDPP_WEB_PUSH_VAPID_PRIVATE_KEY)"

(cd "$TMP_DIR" && bash "$SCRIPT" --write)

for var_pair in \
  "PDPP_OWNER_PASSWORD:$PASS_VAL_PASSWORD" \
  "SESSION_SECRET:$PASS_VAL_SESSION" \
  "PDPP_WEB_PUSH_VAPID_PUBLIC_KEY:$PASS_VAL_VAPID_PUB" \
  "PDPP_WEB_PUSH_VAPID_PRIVATE_KEY:$PASS_VAL_VAPID_PRV"; do
  var="${var_pair%%:*}"
  expected="${var_pair#*:}"
  actual="$(get_var "$ENV_FILE" "$var")"
  if [[ "$actual" == "$expected" ]]; then
    pass "idempotent: $var unchanged on second run"
  else
    fail "idempotent: $var changed on second run (was '$expected', now '$actual')"
  fi
done

# ---- test 4: no-overwrite — pre-set values are preserved --------------------

ENV_FILE2="$TMP_DIR/.env.docker.nooverwrite"
cp "$EXAMPLE" "$ENV_FILE2"

# Pre-set two of the four variables to sentinel values.
sed -i 's/^PDPP_OWNER_PASSWORD=.*/PDPP_OWNER_PASSWORD=sentinel-password/' "$ENV_FILE2"
sed -i 's/^SESSION_SECRET=.*/SESSION_SECRET=sentinel-session/' "$ENV_FILE2"

(cd "$TMP_DIR" && cp "$ENV_FILE2" .env.docker && bash "$SCRIPT" --write && cp .env.docker "$ENV_FILE2")

actual_pw="$(get_var "$ENV_FILE2" PDPP_OWNER_PASSWORD)"
actual_ss="$(get_var "$ENV_FILE2" SESSION_SECRET)"
vapid_pub="$(get_var "$ENV_FILE2" PDPP_WEB_PUSH_VAPID_PUBLIC_KEY)"
vapid_prv="$(get_var "$ENV_FILE2" PDPP_WEB_PUSH_VAPID_PRIVATE_KEY)"

if [[ "$actual_pw" == "sentinel-password" ]]; then
  pass "no-overwrite: PDPP_OWNER_PASSWORD preserved"
else
  fail "no-overwrite: PDPP_OWNER_PASSWORD was '$actual_pw', expected 'sentinel-password'"
fi

if [[ "$actual_ss" == "sentinel-session" ]]; then
  pass "no-overwrite: SESSION_SECRET preserved"
else
  fail "no-overwrite: SESSION_SECRET was '$actual_ss', expected 'sentinel-session'"
fi

if [[ -n "$vapid_pub" && -n "$vapid_prv" ]]; then
  pass "no-overwrite: VAPID keys filled where previously empty"
else
  fail "no-overwrite: VAPID keys still empty when they should have been filled"
fi

# ---- summary ----------------------------------------------------------------

echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "All tests passed."
else
  echo "$FAILURES test(s) failed." >&2
  exit 1
fi
