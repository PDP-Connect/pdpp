# Proposal: gate-hosted-owner-exposure

## Why

Two confirmed vulnerabilities (program audit wave 2, S-1 + S-2) let an
internet-facing reference deployment expose its owner control plane to anyone:

- **S-1 (CRITICAL):** `requireOwnerSession` did `if (!enabled) { next(); }`.
  When `PDPP_OWNER_PASSWORD` is unset, owner auth is disabled and EVERY
  protected `/_ref` route falls through open: deployment diagnostics (which dump
  env values, DB path, connector list, disk/Postgres footprint), connection
  delete/revoke, run/grant timelines, scheduler controls, and the manual-run
  trigger. The hosted templates (Railway/Fly/Docker) rely on documentation to
  set a password — nothing in the server enforces it — so a template deployed
  without the password silently ships an unauthenticated owner surface bound to
  a public interface.
- **S-2 (HIGH):** `POST /connectors` upserts a connector manifest with no auth
  (`ON CONFLICT … DO UPDATE SET manifest = EXCLUDED.manifest`). Because grants
  are validated against `grant_contract.version`, an attacker who POSTs a
  manifest with a bumped `version` field immediately invalidates every existing
  grant for that connector — a one-request grant-wipe DoS — and can also rewrite
  stream schema / refresh policy.

Local development legitimately wants the password-optional convenience (the
`pnpm dev` and test harnesses self-register manifests and approve consent
without a login). The fix must keep `pnpm dev` frictionless while making
accidental internet exposure impossible. It fails closed, never silently open.

## What Changes

- Introduce an **owner-exposure posture** (`server/owner-exposure-posture.ts`):
  a pure function that classifies a deployment as hosted (internet-facing) or
  local-dev from honest signals the deployment already carries — a non-loopback
  `PDPP_REFERENCE_ORIGIN` / `AS_PUBLIC_URL` / `asPublicUrl`, `NODE_ENV=production`,
  or an explicit non-loopback `bindHost`. Operators retain explicit overrides:
  `PDPP_HOSTED=1`/`0` forces the classification; `PDPP_ALLOW_UNAUTHENTICATED_OWNER=1`
  is a loudly-documented escape hatch that keeps the open posture.
- **S-1 fix (boot guard):** in a hosted posture with no password and no
  override, `startServer` SHALL throw before any listener binds — fail closed,
  refuse to start. In a local-dev posture that nonetheless binds a non-loopback
  interface without a password, the server SHALL log a loud warning.
- **S-1 fix (runtime safety):** `requireOwnerSession`'s disabled-auth branch
  SHALL fall through to open behavior ONLY when the posture allows it (local-dev
  or explicit override); otherwise it SHALL fail closed (401 JSON / login
  redirect). This is defense in depth behind the boot guard.
- **S-2 fix:** `POST /connectors` SHALL require an owner session whenever hosted
  (or when `PDPP_LOCK_CONNECTOR_REGISTRY=1`). In local-dev it stays open so the
  dev/test harness can self-register manifests. `GET /connectors/:id` (manifest
  read, no user data) is unchanged.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- `server/owner-exposure-posture.ts` (new, pure), `server/owner-auth.ts`
  (disabled-branch fail-closed + new option), `server/index.js` (posture
  computation, boot guard, warning, wiring into `buildAsApp`),
  `server/routes/as-polyfill-connectors.ts` (optional owner-session gate on
  `POST /connectors`).
- Does NOT change PDPP protocol semantics, the OAuth/PAR/token/introspection
  endpoints, connector behavior, or storage schema.
- Backward compatible for local dev: a loopback deployment with no password
  keeps the exact open behavior the existing `pnpm dev` / test harness relies
  on. Hosted templates that already set `PDPP_OWNER_PASSWORD` are unaffected;
  a hosted template that forgot it now fails to boot with an actionable message
  instead of silently exposing the owner plane.
- Explicitly out of scope (separate audit lanes): owner-session KDF hardening
  (S-3), stderr-tail / connector-error redaction (S-4 / S-6), CIMD IP-guard
  hex-mapped/6to4 forms (S-5), credential fingerprint width (S-7).
