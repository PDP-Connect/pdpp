# Design — harden-consent-token-handoff

## Context

`POST /consent/approve` has two response shapes today:

- **JSON** (callers send `Accept: application/json` or `Content-Type: application/json`) — returns `{ grant_id, token, grant }`. The reference test suite, the operator-bootstrap dashboard at `apps/web/src/app/dashboard/lib/operator-approvals.ts`, and any forking implementer hits this branch.
- **HTML** (a human owner clicked Approve in the browser) — renders a hosted-UI success page that includes the literal bearer string. The token-render line is `reference-implementation/server/index.js`:

  ```js
  { label: 'Token', html: `<code>${hostedEscape(token)}</code>` },
  ```

The bug-hunt audit on 2026-04-27 documented the HTML branch as a P1: the live bearer leaks into browser history, screenshots, screen-shares, password-manager autofill, and chat transcripts that paste the page contents.

## Goal

Stop rendering the live client bearer in the HTML approval surface while preserving every existing programmatic path that legitimately receives the token today.

## Decision

### 1. The HTML page renders an opaque exchange code, not the bearer

When `POST /consent/approve` is served as HTML, the AS:

1. Issues the grant and mints the bearer the same way it does today.
2. Generates a single-use consent exchange code: `cex_<32 bytes hex>`. The code prefix is reference-only; nothing in the protocol parses it.
3. Stores `{ code → { grantId, tokenId, grant, expiresAt, consumed: false } }` in process memory.
4. Renders the page with the grant id and the **exchange code**, not the token. The page tells the caller to redeem the code at `POST /consent/exchange` to receive the bearer.

Why a code, not the bearer:

- The code is a one-shot redemption ticket. If it appears in screen-shares or chat history, the attacker still needs to redeem it before the legitimate caller does (and within the TTL); after one use it is dead. The bearer, in contrast, is valid for hours-to-permanently and is reusable.
- The redemption response carries the bearer in a JSON body over HTTPS, exactly the channel a programmatic client expects.
- The artifact the operator can paste, screenshot, or speak is no longer a credential.

### 2. The JSON branch is unchanged

JSON callers (`Accept: application/json`, or `Content-Type: application/json`, or any test harness that does `res.json({...})`) keep receiving `{ grant_id, token, grant }` directly. They do not need an exchange code, because they already have a JSON channel for the bearer and the bearer is not displayed to a human. Changing the JSON contract would force a coordinated update across the dashboard bootstrap, every consent test (`hybrid-retrieval`, `semantic-retrieval`, `lexical-retrieval`, `query-contract`, `event-spine`, `composed-origin`, `owner-auth`), and any forking implementer's test harness, with no security gain on the JSON channel itself.

### 3. The exchange endpoint is reference-only and unauthenticated by design

`POST /consent/exchange` accepts `{ code }` and returns `{ grant_id, token, grant }` exactly once.

Why no extra auth on the exchange endpoint:

- The code itself **is** the authentication: the only legitimate holder is whoever the human owner just handed it to.
- Adding owner-bearer auth would require the calling client to already hold a credential strong enough to mint its own grants, which defeats the cold-agent handoff this code exists to enable.
- Adding a "registered client" bearer would require pre-issuing a programmatic credential the cold agent does not yet have; that is the exact gap the consent flow is supposed to close.
- The code is scoped narrowly: single-use, short TTL, in-memory only, only ever associated with one specific freshly issued grant. After redemption or expiry the code is gone. This matches the way short-lived authorization codes are used in OAuth 2.0 / OIDC.

### 4. In-memory store, not SQLite

Exchange codes:

- have a 5-minute TTL by default;
- are single-use;
- are useless after process restart (the human can re-approve);
- never need cross-process coordination (the reference is single-process).

In-memory `Map` with periodic sweep is sufficient and avoids a schema migration in the same patch. Storage parity with `pending_consents` is not desirable here: a stored code that survives restart materially weakens the "short-lived ticket" property.

### 5. Code shape

`cex_` + 64 hex chars (32 random bytes) — same entropy floor we use for opaque bearers (`generateToken()`), so the code is not the weak link.

### 6. Ordering: code minting happens after token issuance

`approveGrant` mints the grant and the bearer atomically inside a SQLite transaction. The exchange code is created *after* `approveGrant` returns successfully, in the route handler, so:

- a failed `approveGrant` never produces an orphan code;
- the code TTL clock starts when the page is rendered, not when the SQL commit lands;
- the code-creation path remains separate from grant issuance and easy to test in isolation.

## Alternatives considered

- **Stop rendering the page entirely; show only "approved, return to your CLI"**. Rejected: a real cold-agent handoff exists today (the human approves in the browser; the agent waiting on the other side has no JSON channel to receive the bearer because the human, not the agent, called `/consent/approve`). Killing the visible artifact would break that handoff. The exchange code is the minimal artifact that lets the human convey the result back to the agent.

- **Make the human paste the bearer manually, but mark it with a copy-only widget**. Rejected: this still puts the live bearer into the browser DOM, the clipboard, the screenshot, and the chat transcript. The whole point of the change is that the visible artifact should not be a credential.

- **Promote the exchange code to PDPP-Core**. Deferred. The exchange code is reference-only because the underlying problem is reference-only: the JSON consent surface is already fine. A normative spec would force every AS implementation to add the same surface even when their consent UX never embeds a token. If experience with this code shows other implementations want it, we promote it later through a proper protocol spec change.

- **Persist exchange codes in SQLite for restart-survival**. Rejected: a stored code that survives restart weakens the "short-lived in-memory ticket" property. A surviving code expanding the attacker window after a process restart is worse than the operator re-approving.

## Acceptance checks

1. `openspec validate harden-consent-token-handoff --strict` passes.
2. `node --test reference-implementation/test/security-auth-surfaces.test.js` passes, including the new HTML-no-bearer / exchange-redemption / replay / expiry / JSON-branch-unchanged scenarios.
3. Manual or scripted: `curl -X POST <as>/consent/approve -d 'request_uri=...'` (HTML) returns a body that does **not** contain the bearer; the body **does** contain a `cex_…` code; `curl -X POST <as>/consent/exchange -H 'Content-Type: application/json' -d '{"code":"cex_…"}'` returns `{ grant_id, token, grant }`; a second call with the same code returns 400/410 with a PDPP error envelope.
4. Existing consent JSON tests continue to pass without modification (`pnpm --dir reference-implementation run verify` or targeted equivalents).
