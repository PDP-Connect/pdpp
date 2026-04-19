# Pending Consent Seam Plan

Date: 2026-04-16  
Status: Code-oriented implementation plan  
Scope: remove the in-memory `pendingConsent` seam from `e2e/server/auth.js` without broad auth rewrites

## Goal

Replace the process-local `pendingConsent` `Map` in `e2e/server/auth.js` with durable SQLite-backed storage so the current device-code-style consent flow works across restarts and multi-instance/stateless AS deployments.

This plan is intentionally narrow:

- keep the existing auth flow and route shapes
- keep SQLite as the first persistence adapter
- avoid introducing a generic auth/session framework
- avoid changing the grants/tokens model unless required

## Current seam

Today, `e2e/server/auth.js` stores pending consent requests in:

- `const pendingConsent = new Map()`

Used by:

- `initiateGrant(params, opts)`
- `getPendingConsent(deviceCode)`
- `approveGrant(deviceCode, subjectId, opts)`
- `pollGrant(deviceCode)`
- `denyGrant(deviceCode)`

Routes depending on that seam in `e2e/server/index.js`:

- `POST /grants/initiate`
- `GET /consent/:deviceCode`
- `POST /consent/:deviceCode/approve`
- `POST /consent/:deviceCode/approve-api`
- `POST /consent/:deviceCode/deny`
- `GET /grants/poll/:deviceCode`

The failure mode is straightforward:

- initiation lands on instance A
- approval or poll lands on instance B
- the request looks missing

## Minimal design

Move pending-consent state into SQLite with one new table and a few small helper functions in `e2e/server/auth.js`.

Do **not**:

- create a separate service layer
- create a cross-cutting repository abstraction
- change the grant issuance logic after pending consent is loaded

The right cut is:

- `auth.js` remains the owner of pending-consent lifecycle
- `db.js` gets one new table
- `index.js` route signatures stay the same

## Exact schema suggestion

Add one table in `e2e/server/db.js`:

```sql
CREATE TABLE IF NOT EXISTS pending_consents (
  device_code        TEXT PRIMARY KEY,
  user_code          TEXT NOT NULL UNIQUE,
  params_json        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  subject_id         TEXT,
  grant_id           TEXT,
  token_id           TEXT,
  ai_training_consented INTEGER,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  approved_at        TEXT,
  denied_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_consents_status_expires
ON pending_consents(status, expires_at);
```

### Why this shape

- `device_code` stays the primary lookup key because the current routes use it.
- `user_code` is made unique so the table can support future “enter code manually” UX without another migration.
- `params_json` keeps the current request shape intact and avoids premature normalization.
- `status` should be a small state machine: `pending`, `approved`, `denied`, `consumed`, `expired`.
- `grant_id` and `token_id` are stored so polling no longer depends on process memory.
- `created_at` and `expires_at` are explicit for expiration logic and cleanup.

### What not to store

Do not split every request field into columns yet. The request shape is already slated to change when the auth/request front door moves toward RFC 9396. Keeping `params_json` intact preserves flexibility.

## Lifecycle

### 1. Initiation

In `initiateGrant(params, opts)`:

- generate `deviceCode` and `userCode` as today
- compute `verificationBaseUrl` exactly as today
- compute `createdAt = nowIso()`
- compute `expiresAt = now + 300s`
- insert row into `pending_consents`
- return the same response shape:
  - `device_code`
  - `user_code`
  - `verification_uri`
  - `expires_in`

### 2. Display / fetch

In `getPendingConsent(deviceCode)`:

- load the row by `device_code`
- if missing, return `null`
- if `status` is not `pending`, return `null` for HTML-display purposes
- if expired, mark expired and return `null`
- otherwise return:
  - parsed `params`
  - `userCode`
  - timestamps/status metadata if useful

The current consent page only needs `params` and `userCode`, so keep the returned object minimal.

### 3. Approve

In `approveGrant(deviceCode, subjectId, opts)`:

- fetch pending-consent row from DB
- reject if missing
- reject if expired
- reject if `status !== 'pending'`
- parse `params_json`
- run the existing validation / manifest resolution / grant issuance logic mostly unchanged
- inside the same transaction if practical:
  - insert grant row
  - issue token
  - update pending-consent row to:
    - `status = 'approved'`
    - `subject_id`
    - `grant_id`
    - `token_id`
    - `approved_at`
    - `ai_training_consented`

Return `{ grant, token }` exactly as today.

### 4. Poll

In `pollGrant(deviceCode)`:

- load row
- if missing, return `{ status: 'expired' }` to preserve current external behavior
- if expired and still `pending`, mark `expired`, then return `{ status: 'expired' }`
- if `status === 'pending'`, return `{ status: 'pending' }`
- if `status === 'approved'`, return `{ status: 'approved', token, grant_id }`
- if `status === 'denied'`, either:
  - keep current behavior and return `{ status: 'expired' }` for compatibility, or
  - return `{ status: 'denied' }`

Recommendation:

- preserve current wire behavior for now: denied/missing both collapse to non-approvable terminal states
- if the client/poll contract is later cleaned up, give `denied` its own explicit state then

### 5. Deny

In `denyGrant(deviceCode)`:

- replace delete-from-Map with:
  - update row to `status = 'denied'`
  - set `denied_at`
- return boolean indicating whether a pending row existed and was transitioned

Recommendation:

- do **not** hard-delete immediately
- denied rows are useful for short-lived audit/debug visibility and idempotency

### 6. Cleanup / terminal handling

Do not make request-time cleanup too clever.

Initial plan:

- lazily mark expired rows when they are read
- optionally add a small helper `purgeExpiredPendingConsents()` later if table growth becomes annoying

For now, a periodic janitor is optional, not required.

## Expiration handling

Current behavior implicitly relies on process lifetime and missing Map entries. The DB-backed version should be explicit.

### Rules

- `expires_in` remains `300`
- `expires_at` is written at initiation
- any read path (`getPendingConsent`, `pollGrant`, `approveGrant`) must compare `expires_at` to `now`
- if expired:
  - `pending -> expired`
  - approval attempts fail
  - display path returns not found
  - poll path returns terminal non-approved state

### Why status update matters

If expiry is only computed on the fly, the system never records that the request died. Updating status gives better operator/debug behavior with almost no extra complexity.

## Public URL and config implications

This plan does **not** require a public-URL redesign, but it is the right place to tighten one existing behavior.

Current code in `initiateGrant()`:

- `opts.baseUrl`
- or `process.env.AS_PUBLIC_URL`
- or `http://localhost:${AS_PORT}`

Current route wiring in `POST /grants/initiate` passes:

- ``${req.protocol}://${req.get('host')}``

### Recommendation

Keep the current precedence, but make the intent explicit in the code while touching this seam:

1. `opts.baseUrl`
2. `process.env.AS_PUBLIC_URL`
3. request-derived host
4. localhost fallback

Why this matters here:

- once pending consent is durable, the next source of “works locally, breaks in deployment” will be bad verification URLs
- this is still a small change and does not require changing route shapes

No new env vars are required for this seam removal alone.

## Route impact

Keep the current routes and response shapes.

### No shape change intended

- `POST /grants/initiate`
- `GET /consent/:deviceCode`
- `POST /consent/:deviceCode/approve`
- `POST /consent/:deviceCode/approve-api`
- `POST /consent/:deviceCode/deny`
- `GET /grants/poll/:deviceCode`

### Behavior changes

- these routes become restart-safe
- approval/poll no longer require same-instance affinity
- denied requests are no longer silently deleted from process memory
- expired requests become explicit DB state

### One small UX compatibility note

`GET /consent/:deviceCode` currently returns raw `404 Not found` when the Map entry is absent. Keep that behavior for expired/missing/non-pending rows to avoid unnecessary churn.

## File-oriented implementation steps

### `e2e/server/db.js`

Add:

- `pending_consents` table
- one index on `(status, expires_at)`

No other schema changes needed for the first pass.

### `e2e/server/auth.js`

1. Delete:
   - `const pendingConsent = new Map()`
2. Add small helpers near the top:
   - `getPendingConsentRow(deviceCode)`
   - `createPendingConsent(deviceCode, userCode, params, expiresAt)`
   - `markPendingConsentApproved(deviceCode, fields)`
   - `markPendingConsentDenied(deviceCode)`
   - `markPendingConsentExpired(deviceCode)`
   - maybe `isExpired(row)`
3. Convert:
   - `initiateGrant` to insert row
   - `getPendingConsent` to query row and parse `params_json`
   - `approveGrant` to load row from DB and persist terminal state
   - `pollGrant` to read DB-backed status/token/grant
   - `denyGrant` to update status instead of delete

Keep the grant-building logic below `const params = ...` as intact as possible.

### `e2e/server/index.js`

Likely no route-shape changes.

Only expected edits:

- possibly make the `baseUrl` precedence comment clearer in `/grants/initiate`
- possibly update the not-found/terminal handling comments on consent and poll routes

### `e2e/test/*`

Minimal test changes should be enough.

## Minimal test changes

The goal is to add coverage for the seam, not rewrite the suite.

### Add one new targeted test

In `e2e/test/pdpp.test.js` or a small new auth-focused test:

- initiate grant
- simulate a fresh request path by calling poll/approve after initiation without relying on shared JS memory assumptions
- verify approval still succeeds and poll returns approved

Because the current harness already talks over HTTP to a started server, the main thing to prove is persistence across code paths, not necessarily multi-process infrastructure.

### Add one expiration test

Fast-path approach:

- insert or initiate a pending consent with a very short expiry
- force it expired by direct DB update or test helper
- verify:
  - `GET /consent/:deviceCode` returns 404
  - `GET /grants/poll/:deviceCode` returns terminal non-approved state
  - `POST /consent/:deviceCode/approve-api` fails

### Keep existing tests stable

Existing E2E grant tests that call:

- `/grants/initiate`
- `/consent/:deviceCode/approve-api`

should continue to pass with no caller-side changes if the seam replacement is done correctly.

## Why this can stay SQLite-first and still be serverless-friendly

Because the real problem is process-local state, not SQLite.

SQLite is an acceptable first persistence layer here because:

- pending consent is small, relational, and transactional
- it fits naturally beside `grants` and `tokens`
- it removes sticky-session dependence without adding infrastructure
- another SQL-backed adapter can be introduced later without changing the lifecycle model

What makes this serverless-friendly is not “using a cloud-native queue.” It is:

- moving state out of process memory
- making lifecycle explicit in durable storage
- keeping public URLs/config explicit enough for split deployments

That is enough to make the current auth seam viable on stateless app instances, provided the DB itself is actually durable in deployment.

## Non-goals

This plan does **not**:

- convert the auth flow to OAuth auth code / PKCE
- redesign `client_display` or RFC 9396 request handling
- add a generic session framework
- add Redis
- add a scheduler/janitor service by default
- change the owner-token shortcut

Those may happen later, but they are not required to remove the `pendingConsent` seam cleanly.

## Recommended order

1. Add `pending_consents` table in `db.js`
2. Add DB helper functions in `auth.js`
3. Swap `initiateGrant`, `getPendingConsent`, `approveGrant`, `pollGrant`, `denyGrant` over one by one
4. Add one persistence-path test and one expiration test
5. Only then consider small cleanup like explicit denied/expired poll states

That order keeps the change surgical and easy to verify.
