#!/usr/bin/env bash
# Generate required secrets for a PDPP reference deployment.
#
# Usage:
#   scripts/generate-secrets.sh              — print generated values to stdout; no files modified
#   scripts/generate-secrets.sh --write      — patch .env.docker in place (fills only empty values)
#   scripts/generate-secrets.sh --out FILE   — write generated values to FILE
#   scripts/generate-secrets.sh --help
#
# Run once after `cp .env.docker.example .env.docker`, before starting the stack.
# Existing non-empty values are never overwritten.
#
# Requires Node.js (already required to run pnpm workloads in this repo).

set -euo pipefail

WRITE_TARGET=""
OUT_FILE=""

usage() {
  cat <<'EOF'
Usage: scripts/generate-secrets.sh [OPTION]

Generate required secrets for a PDPP reference deployment.

  (no options)    Print generated values to stdout; no files are modified.
  --write         Patch .env.docker in place, filling only empty values.
  --out FILE      Write generated values to FILE instead of stdout.
  --help          Show this message.

Variables generated:
  PDPP_OWNER_PASSWORD              gates /owner, /device, /consent, / (console)
  PDPP_CREDENTIAL_ENCRYPTION_KEY   seals per-connection static-secret credentials
  PDPP_WEB_PUSH_VAPID_PUBLIC_KEY   VAPID key pair for browser push notifications
  PDPP_WEB_PUSH_VAPID_PRIVATE_KEY

The script never overwrites a variable that already has a non-empty value.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write)
      WRITE_TARGET=".env.docker"
      shift
      ;;
    --out)
      [[ -n "${2:-}" ]] || { echo "--out requires a path" >&2; exit 1; }
      OUT_FILE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "$WRITE_TARGET" && -n "$OUT_FILE" ]]; then
  echo "--write and --out are mutually exclusive" >&2
  exit 1
fi

# --- dependency check ---

if ! command -v node &>/dev/null; then
  echo "Node.js is required but was not found in PATH." >&2
  echo "Install Node.js 20+ before running this script." >&2
  exit 1
fi

# --- generate secrets ---

# Owner password: 32 random bytes, base64url-encoded (no padding).
PDPP_OWNER_PASSWORD="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"

# Credential encryption key: 48 random bytes, base64url-encoded (64 chars).
PDPP_CREDENTIAL_ENCRYPTION_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))")"

# VAPID key pair for browser push (EC P-256, VAPID format).
# JWK export provides raw key components without manual DER parsing.
_vapid="$(node --input-type=module <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const prvJwk = privateKey.export({ format: 'jwk' });
const pubJwk = publicKey.export({ format: 'jwk' });
const dec = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const enc = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const x = dec(pubJwk.x), y = dec(pubJwk.y);
const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
process.stdout.write(enc(uncompressed) + '\n' + enc(dec(prvJwk.d)) + '\n');
NODE
)"
PDPP_WEB_PUSH_VAPID_PUBLIC_KEY="$(printf '%s\n' "$_vapid" | sed -n '1p')"
PDPP_WEB_PUSH_VAPID_PRIVATE_KEY="$(printf '%s\n' "$_vapid" | sed -n '2p')"

# --- output helpers ---

emit() {
  printf 'PDPP_OWNER_PASSWORD=%s\n' "$PDPP_OWNER_PASSWORD"
  printf 'PDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' "$PDPP_CREDENTIAL_ENCRYPTION_KEY"
  printf 'PDPP_WEB_PUSH_VAPID_PUBLIC_KEY=%s\n' "$PDPP_WEB_PUSH_VAPID_PUBLIC_KEY"
  printf 'PDPP_WEB_PUSH_VAPID_PRIVATE_KEY=%s\n' "$PDPP_WEB_PUSH_VAPID_PRIVATE_KEY"
}

patch_env_file() {
  local target="$1"
  if [[ ! -f "$target" ]]; then
    echo "File not found: $target" >&2
    echo "Run: cp .env.docker.example .env.docker" >&2
    exit 1
  fi

  _patch_var() {
    local var="$1" val="$2"
    if grep -qE "^${var}=[[:space:]]*$" "$target"; then
      _PDPP_T="$target" _PDPP_V="$var" _PDPP_U="$val" node -e '
        const fs = require("node:fs");
        const t = process.env._PDPP_T, v = process.env._PDPP_V, u = process.env._PDPP_U;
        const c = fs.readFileSync(t, "utf8");
        fs.writeFileSync(t, c.replace(new RegExp("^" + v + "=[ \t]*$", "m"), v + "=" + u));
      '
      printf '  set   %s\n' "$var"
      if [[ "$var" == "PDPP_OWNER_PASSWORD" ]]; then
        printf '\n  *** Owner password — save this now; it will not be shown again ***\n'
        printf '  %s=%s\n' "$var" "$val"
        printf '  *******************************************************************\n\n'
      fi
    elif grep -qE "^${var}=" "$target"; then
      printf '  skip  %s (already set)\n' "$var"
    else
      printf '%s=%s\n' "$var" "$val" >> "$target"
      printf '  add   %s (key was missing)\n' "$var"
      if [[ "$var" == "PDPP_OWNER_PASSWORD" ]]; then
        printf '\n  *** Owner password — save this now; it will not be shown again ***\n'
        printf '  %s=%s\n' "$var" "$val"
        printf '  *******************************************************************\n\n'
      fi
    fi
  }

  printf 'Patching %s:\n' "$target"
  _patch_var PDPP_OWNER_PASSWORD              "$PDPP_OWNER_PASSWORD"
  _patch_var PDPP_CREDENTIAL_ENCRYPTION_KEY   "$PDPP_CREDENTIAL_ENCRYPTION_KEY"
  _patch_var PDPP_WEB_PUSH_VAPID_PUBLIC_KEY   "$PDPP_WEB_PUSH_VAPID_PUBLIC_KEY"
  _patch_var PDPP_WEB_PUSH_VAPID_PRIVATE_KEY  "$PDPP_WEB_PUSH_VAPID_PRIVATE_KEY"
  printf '\nDone. Keep %s out of version control.\n' "$target"
  printf 'Set PDPP_REFERENCE_ORIGIN manually (depends on your deployment URL).\n'
}

# --- dispatch ---

if [[ -n "$WRITE_TARGET" ]]; then
  patch_env_file "$WRITE_TARGET"
elif [[ -n "$OUT_FILE" ]]; then
  emit > "$OUT_FILE"
  printf 'Secrets written to %s\n' "$OUT_FILE"
else
  emit
fi
