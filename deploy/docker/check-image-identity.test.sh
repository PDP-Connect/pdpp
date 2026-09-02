#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Tests for deploy/docker/check-image-identity.sh
#
# A `docker` stub on PATH answers `image inspect` for fake image refs with
# canned Config.Labels / Config.Env output, so this never touches a real
# image or the Docker daemon.
#
# Run: bash deploy/docker/check-image-identity.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_SCRIPT="$SCRIPT_DIR/check-image-identity.sh"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

FAILURES=0

# A real full-length SHA-1 object id (40 lowercase hex chars) and a real
# full-length SHA-256 object id (64 lowercase hex chars) — the only two
# shapes --require-known accepts as a real immutable commit identity.
# Built (not hand-typed) so the lengths are verifiably exact, not eyeballed.
FULL_SHA1="$(printf 'abc123def456%028d' 0)"
FULL_SHA256="$(printf 'abc123def456%052d' 0)"
[[ "${#FULL_SHA1}" -eq 40 ]] || { echo "test fixture bug: FULL_SHA1 is ${#FULL_SHA1} chars, want 40" >&2; exit 1; }
[[ "${#FULL_SHA256}" -eq 64 ]] || { echo "test fixture bug: FULL_SHA256 is ${#FULL_SHA256} chars, want 64" >&2; exit 1; }

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

STUB_BIN="$WORK_DIR/bin"
mkdir -p "$STUB_BIN"

# write_docker_stub label_revision env_revision
#   label_revision: value for org.opencontainers.image.revision, or the
#                   literal string "MISSING" to omit the label entirely
#                   (rendered by Go templates as "<no value>")
#   env_revision:   value for PDPP_REFERENCE_REVISION, or "MISSING" to omit
#                   the env var entirely from Config.Env
write_docker_stub() {
  local label_revision="$1" env_revision="$2"
  local label_output env_output
  if [[ "$label_revision" == "MISSING" ]]; then
    label_output="<no value>"
  else
    label_output="$label_revision"
  fi
  cat > "$STUB_BIN/docker" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == "image" && "\$2" == "inspect" ]]; then
  shift 2
  image=""
  format=""
  while [[ \$# -gt 0 ]]; do
    case "\$1" in
      --format)
        format="\$2"
        shift 2
        ;;
      --format=*)
        format="\${1#--format=}"
        shift
        ;;
      *)
        image="\$1"
        shift
        ;;
    esac
  done
  if [[ "\$image" == "missing-image" ]]; then
    exit 1
  fi
  if [[ "\$format" == *"Config.Labels"* ]]; then
    printf '%s\n' "$label_output"
    exit 0
  fi
  if [[ "\$format" == *"Config.Env"* ]]; then
STUB
  if [[ "$env_revision" != "MISSING" ]]; then
    cat >> "$STUB_BIN/docker" <<STUB
    printf 'PDPP_REFERENCE_REVISION=%s\n' "$env_revision"
STUB
  fi
  cat >> "$STUB_BIN/docker" <<STUB
    printf 'NODE_ENV=production\n'
    exit 0
  fi
  exit 0
fi
exit 1
STUB
  chmod +x "$STUB_BIN/docker"
}

run_check() {
  PATH="$STUB_BIN:$PATH" bash "$TARGET_SCRIPT" "$@"
}

# 1. label "unknown", env "unknown" (default --require-known mode) -> IDENTITY VIOLATION, exit 1
write_docker_stub "unknown" "unknown"
if OUT=$(run_check "fake-image" 2>&1); then
  fail "unknown revision under require-known should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "IDENTITY VIOLATION.*unknown"; then
    pass "unknown revision (require-known) -> IDENTITY VIOLATION, exit 1"
  else
    fail "unknown revision: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 2. label and env are both set but to DIFFERENT non-unknown SHAs (duplicate/mismatched identity) -> exit 1
write_docker_stub "aaa111" "bbb222"
if OUT=$(run_check "fake-image" 2>&1); then
  fail "mismatched revisions should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "IDENTITY VIOLATION: label and runtime revision disagree"; then
    pass "mismatched label vs runtime revision -> IDENTITY VIOLATION, exit 1"
  else
    fail "mismatch: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 3. label missing entirely -> exit 1
write_docker_stub "MISSING" "ccc333"
if OUT=$(run_check "fake-image" 2>&1); then
  fail "missing label should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "no org.opencontainers.image.revision label"; then
    pass "missing OCI label -> IDENTITY VIOLATION, exit 1"
  else
    fail "missing label: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 4. runtime env missing entirely -> exit 1
write_docker_stub "ccc333" "MISSING"
if OUT=$(run_check "fake-image" 2>&1); then
  fail "missing runtime env should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "no PDPP_REFERENCE_REVISION runtime env var"; then
    pass "missing runtime env -> IDENTITY VIOLATION, exit 1"
  else
    fail "missing env: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 5. exact match, full-length (40-hex) SHA-1 -> exit 0 (pass-after case)
write_docker_stub "$FULL_SHA1" "$FULL_SHA1"
if OUT=$(run_check "fake-image" 2>&1); then
  pass "exact matching full-length SHA-1 revision -> exit 0"
else
  fail "exact match (SHA-1) should exit 0. Output: $OUT"
fi

# 6. explicit --require-known flag behaves the same as the default
write_docker_stub "$FULL_SHA1" "$FULL_SHA1"
if OUT=$(run_check --require-known "fake-image" 2>&1); then
  pass "exact match with explicit --require-known -> exit 0"
else
  fail "explicit --require-known exact match should exit 0. Output: $OUT"
fi

# 6b. exact match, full-length (64-hex) SHA-256 also accepted -> exit 0
write_docker_stub "$FULL_SHA256" "$FULL_SHA256"
if OUT=$(run_check "fake-image" 2>&1); then
  pass "exact matching full-length SHA-256 revision -> exit 0"
else
  fail "exact match (SHA-256) should exit 0. Output: $OUT"
fi

# 6c. FAIL-BEFORE / PASS-AFTER for the format gate itself: a mutable ref name
# that matches on BOTH sides (label == env == "main") must still be rejected
# under --require-known. Equality and non-"unknown" alone are not proof of an
# immutable commit — "main" is exactly the counterexample that shows why:
# without this check, a build invoked with PDPP_REFERENCE_REVISION=main would
# make both the label and the runtime env agree on a mutable branch name and
# incorrectly pass.
write_docker_stub "main" "main"
if OUT=$(run_check "fake-image" 2>&1); then
  fail "a mutable ref name ('main') that matches on both sides should still exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "not shaped like a full-length git object id"; then
    pass "matching mutable ref name ('main') is rejected as non-SHA-shaped -> exit 1"
  else
    fail "mutable ref name: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 6d. an abbreviated SHA (12 hex chars — a real short-form git commit
# reference) that matches on both sides must also be rejected: it is hex,
# but not full length, so it is ambiguous and not accepted as an identity.
write_docker_stub "abc123def456" "abc123def456"
if OUT=$(run_check "fake-image" 2>&1); then
  fail "an abbreviated (12-char) SHA that matches on both sides should still exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "not shaped like a full-length git object id"; then
    pass "matching abbreviated SHA (12 hex chars) is rejected as non-full-length -> exit 1"
  else
    fail "abbreviated SHA: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 7. both unknown, but --allow-unknown (ordinary local dev build) -> exit 0
write_docker_stub "unknown" "unknown"
if OUT=$(run_check --allow-unknown "fake-image" 2>&1); then
  pass "both unknown with --allow-unknown (dev build) -> exit 0"
else
  fail "dev build (both unknown, --allow-unknown) should exit 0. Output: $OUT"
fi

# 8. mismatch is STILL rejected even under --allow-unknown — a fabricated or
#    divergent SHA is never acceptable, only an honest shared "unknown" is
write_docker_stub "aaa111" "unknown"
if OUT=$(run_check --allow-unknown "fake-image" 2>&1); then
  fail "mismatch under --allow-unknown should still exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "IDENTITY VIOLATION: label and runtime revision disagree"; then
    pass "mismatch under --allow-unknown is still rejected -> exit 1"
  else
    fail "mismatch under --allow-unknown: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 8b. --allow-unknown only widens acceptance for the literal sentinel
# "unknown" — a matching MUTABLE ref name ("main") must still be rejected
# even under --allow-unknown. This is the same fail-before/pass-after
# counterexample as case 6c, re-proven in the mode that a naive reading of
# "--allow-unknown" might assume is permissive about any string.
write_docker_stub "main" "main"
if OUT=$(run_check --allow-unknown "fake-image" 2>&1); then
  fail "a mutable ref name ('main') should still exit nonzero even under --allow-unknown. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "not shaped like a full-length git object id"; then
    pass "matching mutable ref name ('main') is rejected under --allow-unknown too -> exit 1"
  else
    fail "mutable ref name under --allow-unknown: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 8c. --allow-unknown still accepts a real full-length matching SHA (it is a
# strict widening of acceptance, not a different identity contract).
write_docker_stub "$FULL_SHA1" "$FULL_SHA1"
if OUT=$(run_check --allow-unknown "fake-image" 2>&1); then
  pass "full-length matching SHA-1 still passes under --allow-unknown -> exit 0"
else
  fail "full-length SHA-1 under --allow-unknown should exit 0. Output: $OUT"
fi

# 9. image not found -> usage/inspection error, exit 2 (distinct from an identity finding)
write_docker_stub "irrelevant" "irrelevant"
if OUT=$(run_check "missing-image" 2>&1); then
  fail "missing image should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "2" ]]; then
    pass "image not found -> inspection error, exit 2"
  else
    fail "missing image: expected exit 2, got $CODE. Output: $OUT"
  fi
fi

# 10. no image argument -> usage error, exit 2
if OUT=$(run_check 2>&1); then
  fail "no image argument should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "2" ]]; then
    pass "no image argument -> usage error, exit 2"
  else
    fail "no image argument: expected exit 2, got $CODE. Output: $OUT"
  fi
fi

echo
if (( FAILURES > 0 )); then
  echo "$FAILURES test(s) failed" >&2
  exit 1
fi
echo "All tests passed"
