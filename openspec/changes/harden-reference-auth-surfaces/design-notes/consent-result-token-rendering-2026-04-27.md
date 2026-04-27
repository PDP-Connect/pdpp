# Consent-result token rendering — followup

- Status: decided-promote (absorbed by `harden-consent-token-handoff`).
- Captured: 2026-04-27.
- Origin: bug-hunt audit, finding P1 #4.

## Context

`reference-implementation/server/index.js:2335-2361` renders `/consent/approve` as an HTML page that includes the issued bearer token in the page body:

```js
{ label: 'Token', html: `<code>${hostedEscape(token)}</code>` },
```

The token is HTML-escaped (so this is not an XSS vector). The problem is that the live bearer string ends up in the operator's browser history, in any screen-share, in any password-manager autofill heuristic, and on any screenshot. The project's own `pdpp-data-access` skill explicitly tells agents not to do this with tokens — the AS is doing exactly that to the operator.

The JSON-mode response from the same endpoint already returns the token correctly (the client called `/oauth/par` and is polling, so the token belongs in the JSON reply, not in the HTML).

## What we want

Replace the HTML token-copy UX with an exchange-code flow:

- on approve, the AS issues a one-time-use, short-lived exchange code (e.g. `code_<random>`) and stores `{ code -> token, single_use: true, expires_in: 60s }` in memory.
- the HTML response shows the code, not the token, plus a "use this code at `/consent/exchange?code=…`" pointer or a copy button.
- the dashboard / agent calls `POST /consent/exchange` with the code over a fresh request and gets the token in the JSON body; possession of the single-use code is the redemption authority.

That keeps the human-visible artifact a non-credential (the code) and routes the actual bearer through a normal HTTPS JSON body.

## Why not now

- This is a real protocol-shape change for the consent surface, not a UI tweak.
- We have to decide whether the exchange code is a PDPP-Core idea (other AS implementations would honor it) or a reference-only artifact.
- We would need to update every existing client that approves consent and reads the HTML response — including the operator-bootstrap dashboard flow.
- A same-night patch would risk shipping a half-spec'd surface.

## Suggested next packet

Absorbed by `openspec/changes/harden-consent-token-handoff/`. The promoted change SHALL:

- decide reference-only vs PDPP-Core scope.
- spec the code shape, TTL, single-use semantics, and revocation-on-failure.
- design how the HTML page transitions between "show code" → "code consumed" without ever rendering the token.
- include regression tests that the HTML page body never contains the bearer string for the issued grant.
- update the `pdpp-data-access` skill in lockstep.
