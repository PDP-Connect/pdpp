# Tasks — harden-consent-token-handoff

## 1. Reference AS — exchange-code primitives

- [x] 1.1 Add `createConsentExchangeCode({ grantId, token, grant, ttlMs })` and `consumeConsentExchangeCode(code)` in `reference-implementation/server/auth.js`. In-memory `Map`, single-use, TTL-bounded, lazy expiry on read.
- [x] 1.2 Export the helpers from `auth.js` and import them into `server/index.js`.

## 2. HTML approval surface — drop the token

- [x] 2.1 In `POST /consent/approve` (HTML branch) in `server/index.js`, replace the `Token` row with a `Consent exchange code` row that renders the freshly minted exchange code.
- [x] 2.2 Add hosted-UI copy describing how to redeem the code at `POST /consent/exchange`.
- [x] 2.3 Confirm by inspection and by a regression test that the HTML response body never contains the bearer string the AS just minted.

## 3. JSON approval surface — unchanged

- [x] 3.1 Confirm the JSON branch of `POST /consent/approve` continues to return `{ grant_id, token, grant }` exactly as today.
- [x] 3.2 No callers in `apps/web/`, `reference-implementation/cli/`, or `reference-implementation/test/` are updated for the JSON path.

## 4. New exchange endpoint

- [x] 4.1 Add `POST /consent/exchange` in `server/index.js`. Accepts `{ code }`, returns `{ grant_id, token, grant }` once on success.
- [x] 4.2 On unknown / consumed / expired code: return a 4xx PDPP error envelope (`pdppError`).
- [x] 4.3 Do not require additional auth beyond possession of the code.

## 5. Tests

- [x] 5.1 In `reference-implementation/test/security-consent-token-handoff.test.js`, add scenarios:
  - HTML response body for `POST /consent/approve` does not contain the bearer string of the issued grant.
  - HTML response body contains a `cex_…` code.
  - `POST /consent/exchange` redeems the code and returns the bearer that introspects as the same grant.
  - A second redemption attempt returns 4xx and does not leak the bearer.
  - An expired code (advance the in-memory clock or set TTL to a small value) returns 4xx.
  - JSON `POST /consent/approve` still returns the bearer in the JSON body.

## 6. OpenAPI surface

- [x] 6.1 Document `POST /consent/exchange` in `reference-implementation/openapi/reference-public.openapi.json` and `reference-full.openapi.json` as a reference-only surface alongside the existing `/consent/*` group.

## Acceptance checks

- [x] A. `openspec validate harden-consent-token-handoff --strict` passes.
- [x] B. `node --test reference-implementation/test/security-consent-token-handoff.test.js reference-implementation/test/security-auth-surfaces.test.js` passes.
- [x] C. Existing reference consent-using tests still pass on this branch (smoke a representative subset: `node --test reference-implementation/test/owner-auth.test.js`).
- [x] D. Repo-wide grep proves no test, dashboard, or CLI path was forced to switch to the exchange endpoint to preserve existing behavior.
