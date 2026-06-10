# Design — honor-csrf-exemption-for-bff-device-flow

## Context

Bug-hunt validation surfaced two concrete failures in the dashboard when `PDPP_OWNER_PASSWORD` is configured:

1. `/dashboard/records/<connector>` crashes during render because the BFF's owner-token mint hits `csrf_token_invalid` against `/device/approve`.
2. `/dashboard/grants/bootstrap` (operator-facing device-flow walkthrough; later relocated to `/dashboard/deployment/tokens`) fails at the Approve step for the same reason.

Both call sites POST form-encoded bodies. The AS's `requireCsrf` middleware enforces a hosted-form CSRF token on form-encoded POSTs to `/device/approve`. JSON content-type is exempt (`server/owner-auth.ts:500-519 isJsonRequest`).

## Why JSON exemption, not a new endpoint

A first draft of this change proposed a new internal endpoint `POST /_ref/owner/mint-self-export-token` that wrapped the device flow's three calls into one cookie-authed request. That draft was rejected on review against the OpenSpec archive:

> "Do not add a private `POST /_ref/tokens` or equivalent raw mint API. If the control plane wants to help an operator obtain an owner token, it should do so through the real owner-device flow and make the resulting identifiers and token state inspectable."
> — `openspec/changes/archive/2026-04-24-reference-implementation-program/design-notes/reference-implementation-execution-plan-2026-04-21.md` §7

Standards research corroborates the design note:

- **There is no IETF-standardized "personal access token" primitive.** PATs are a vendor convention (GitHub, Linear, Vercel, Stripe). The OAuth working group standardizes flows (Auth Code + PKCE, Device Authorization, Client Credentials), token formats (JWT profile), and validation (Introspection) — never an alternative issuance shape.
- **OAuth 2.1 (`draft-ietf-oauth-v2-1-15`)** removes ROPC and offers no first-party exception. For "operator at a browser issuing a bearer for their own CLI," the IETF-blessed primitive is the device flow.
- **RFC 8628 §5.6** explicitly contemplates the operator-runs-the-flow-against-themselves case as legitimate: "the user in possession of the client credentials can already impersonate the client and create a new authorization grant."

A reference implementation built around a vendor-invented mint endpoint would put PDPP *less* aligned with IETF, not more — and it would mask the protocol's wire shape from the very inspection surfaces the dashboard is supposed to demonstrate.

## Why the JSON CSRF exemption is safe

The exemption already exists. Its safety rests on browser CORS:

- A browser will not send `Content-Type: application/json` cross-origin without a CORS preflight, and the AS does not advertise CORS for `/device/approve`. So a malicious cross-origin page cannot silently cause the operator's browser to forge a JSON POST.
- A first-party page on the same origin (i.e. the dashboard) can send the cookie, but anything on the same origin already has same-origin powers — the cookie isolation point is the origin boundary, which is unchanged by this exemption.
- A non-browser caller (CLI, server-to-server) with the operator's session cookie can hit `/device/approve` directly. That has always been true, and the device-flow protocol explicitly contemplates self-issuance in §5.6.

This change adds three regression tests that pin the contract:

1. JSON POST with valid session cookie → 200. (Positive: the dashboard works.)
2. Form-encoded POST without CSRF → 403. (Negative: nothing else can sneak in.)
3. JSON POST without session cookie → 401. (Authentication remains enforced.)

## Alternatives considered

- **(Rejected) Add a hidden `_ref/owner/mint-self-export-token` endpoint.** Violates design note #7 and hides the protocol from inspection.
- **(Rejected) Extend `/v1/*` to accept the owner session cookie as alternate credential.** Muddies the public PDPP protocol surface with a vendor-flavored shortcut. The IETF browser-based-apps draft and the Curity token-handler pattern are explicit: tokens belong on the resource server, cookies on the BFF.
- **(Rejected) Have the dashboard scrape a CSRF token from a server-rendered hosted form before each approval.** Doubles round-trips, couples the BFF to the AS's hosted-UI HTML structure, and adds a brittle scraping step for a problem the documented JSON exemption already solves.
- **(Selected) Use the documented JSON CSRF exemption.** Smallest change, no new endpoint, no protocol divergence, real device flow stays on the wire and stays inspectable from the Tokens page's "Show device-flow details" disclosure.

## Acceptance checks

- `mintOwnerToken` succeeds against `PDPP_OWNER_PASSWORD`-enabled AS using only JSON POSTs and a forwarded session cookie.
- The Tokens page (`/dashboard/deployment/tokens`) issues a real bearer end-to-end with `PDPP_OWNER_PASSWORD` set.
- `reference-implementation/test/owner-csrf.test.js` carries the three regression pins (JSON success, form-encoded 403, no-cookie 401).
- The wire transcript visible in the Tokens page's "Show device-flow details" disclosure is the unmodified RFC 8628 device flow (no wrapper endpoint, no fabricated steps).
