# Honor the JSON CSRF exemption when the BFF drives the device flow

## Why

The dashboard (Next.js BFF) and its operator-facing token-issuance page both need to drive the canonical RFC 8628 device flow against the AS to mint owner self-export bearers. When `PDPP_OWNER_PASSWORD` is set, the AS gates `/device/approve` (and `/device/deny`) with both `requireOwnerSession` and `requireCsrf`. The dashboard already forwards the operator's session cookie, but it has no way to acquire the hosted-form CSRF token because that token only exists on a server-rendered HTML form the dashboard never fetches.

Today the BFF and the operator-bootstrap flow both POST form-encoded bodies, which fail with `csrf_token_invalid` the moment owner-auth is on.

The AS already exempts `application/json` POSTs from CSRF (`server/owner-auth.ts isJsonRequest`), on the grounds that cross-origin JSON POSTs require a CORS preflight and cannot be browser-forged. This change makes the dashboard use that exemption.

This change SHALL NOT add a new endpoint. Owner self-export bearers continue to be obtained through the real public RFC 8628 device flow (design note #7 in `archive/2026-04-24-reference-implementation-program/design-notes/reference-implementation-execution-plan-2026-04-21.md`: "do not add a private `POST /_ref/tokens` or equivalent raw mint API").

## What Changes

- The dashboard BFF (`apps/web/src/app/dashboard/lib/owner-token.ts mintOwnerToken`) drives the canonical device flow against the AS using `Content-Type: application/json` for all three POSTs (`/oauth/device_authorization`, `/device/approve`, `/oauth/token`). The session cookie is forwarded.
- The operator-facing token-issuance flow (`apps/web/src/app/dashboard/lib/operator-bootstrap.ts`) uses the same JSON encoding for `/device/approve` and `/device/deny`.
- Pin the JSON-content-type CSRF exemption on `/device/approve` with regression tests; pin that the form-encoded path still 403s.

## Capabilities

### Modified

- `reference-implementation-architecture`: clarify that the documented hosted-form CSRF exemption for `application/json` content-type covers cookie-authed BFF callers driving the public device flow.

## Impact

- Security: no widening. `/device/approve` still requires the owner session cookie. JSON exemption was already present; this change just tightens its observable contract via a positive regression test.
- Compatibility: none. The route accepts both form-encoded and JSON bodies today; only the dashboard's choice changes.
- Supersedes a stale, never-shipped draft (`add-dashboard-bff-token-mint`) that proposed a hidden `POST /_ref/owner/mint-self-export-token` endpoint. That endpoint and its draft were rejected as a design-note-#7 violation.
