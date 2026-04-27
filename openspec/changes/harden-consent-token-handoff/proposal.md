## Why

The bug-hunt audit on 2026-04-27 (P1 #4) found that `POST /consent/approve` renders the freshly issued client bearer token into the HTML success page body (`reference-implementation/server/index.js` `/consent/approve`). The token is HTML-escaped, so this is not an XSS vector; the problem is the live bearer ending up in browser history, screenshots, screen-shares, password-manager autofill, and any chat transcript that pastes the page content. The reference's own `pdpp-data-access` skill explicitly tells agents not to do this with tokens, but the AS does exactly that to the operator on the human-hosted approval surface.

The follow-up was captured in `openspec/changes/harden-reference-auth-surfaces/design-notes/consent-result-token-rendering-2026-04-27.md` and deliberately deferred from the auth-hardening tranche. This change addresses it.

The JSON-mode response from the same endpoint already returns the token correctly (the operator-bootstrap dashboard and every test calls `/consent/approve` with `Content-Type: application/json` and reads `{ grant_id, token, grant }` out of the JSON body). That programmatic contract is well established and SHALL be preserved unchanged.

## What Changes

- The HTML branch of `POST /consent/approve` SHALL NOT include the issued client bearer token in any visible page artifact (page body, attributes, hidden form fields, JavaScript variables, or response headers). The HTML page SHALL display the grant id and an opaque short-lived single-use **consent exchange code**, not the token itself.
- The reference SHALL add a new endpoint `POST /consent/exchange` that accepts `{ code }` and, on success, returns `{ grant_id, token, grant }` exactly once. The endpoint SHALL be reference-only and SHALL not require additional authentication beyond possession of the code, because possession of the code is the only authority required to redeem the bearer the AS just issued for that consent request.
- Consent exchange codes SHALL be opaque strings (≥ 256 bits of entropy, prefixed `cex_`), single-use, and SHALL expire after a short TTL (default 5 minutes). Codes SHALL be generated only on the HTML approval branch; the JSON branch SHALL NOT generate or return a code, because JSON callers already receive the token directly.
- The JSON branch of `POST /consent/approve` SHALL continue to return `{ grant_id, token, grant }` unchanged. This preserves the operator-bootstrap dashboard flow, the reference test suite, and any external test harness that drives the JSON consent surface today.
- Regression tests SHALL pin: (1) the HTML response body never contains the issued bearer string for the issued grant; (2) the exchange code redeems the token exactly once; (3) a second redemption attempt fails with a 4xx PDPP error envelope; (4) an expired code fails with a 4xx PDPP error envelope; (5) the JSON branch still returns the token directly.

Out of scope (explicit):

- Removing `token_id` from spine storage or wider name- or shape-based projection on `_ref` reads — covered separately by `harden-reference-auth-surfaces`.
- Changing the wire shape of `POST /oauth/par` or any pre-approval surface.
- Promoting the consent exchange code into the normative PDPP-Core protocol. The exchange code is a reference-only artifact for the reference HTML approval flow; other AS implementations are not required to adopt it.
- Updating the `pdpp-data-access` skill copy. The skill currently does not document the HTML approval flow and does not need to change for this tranche.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: extend the "Reference-only surfaces are explicit" hosted-UI guarantees so the human-hosted `/consent/approve` HTML response never embeds a live client bearer, and add a new requirement defining the consent-exchange code shape, redemption endpoint, single-use semantics, and TTL.

## Impact

- `reference-implementation/server/auth.js` — add an in-memory consent-exchange-code store with TTL+single-use semantics; export `createConsentExchangeCode` / `consumeConsentExchangeCode`.
- `reference-implementation/server/index.js` — HTML `/consent/approve` now mints a code and renders it instead of the token; new `POST /consent/exchange` redeems the code and returns the same JSON body the JSON branch returns. JSON branch unchanged.
- `reference-implementation/openapi/*.openapi.json` — document the new exchange endpoint as a reference-only surface.
- `reference-implementation/test/security-auth-surfaces.test.js` — add coverage for the four invariants above.
