# Device Flow Cutline Memo

Date: 2026-04-16  
Status: Minimal phase-1 cutline for provider-connect self-export via RFC 8628

## Why this memo exists

The reference stack already has a device-code-shaped seam:

- `device_code`
- `user_code`
- consent UI
- poll endpoint
- token issuance

But that seam is currently serving the grant-approval demo path, not a real RFC 8628 owner-login path.

This memo defines the smallest device-flow implementation worth building for phase-1 provider-connect self-export:

- what exact RFC 8628 surfaces to add
- what can remain reference-grade
- what must not be faked
- how it should relate to current owner-token and pending-consent seams
- where it should land in the E2E sequence

The goal is not “full OAuth.” The goal is one honest, standards-based owner-token acquisition path for a CLI.

## Bottom line

Phase-1 should add a **real owner device-flow path** next to the current demo grant flow, not by mutating the grant flow into something it is not.

Build:

- `POST /oauth/device_authorization`
- `POST /oauth/token` for `urn:ietf:params:oauth:grant-type:device_code`
- one small owner-login consent/approval surface

Do not:

- reuse `/owner-token` as the fake token endpoint
- pretend `/grants/poll/:deviceCode` is the RFC 8628 polling contract
- overload PDPP grant approval objects with owner-login semantics

The clean design is:

- **owner device flow** = separate pending authorization type that yields an owner token
- **PDPP grant flow** = separate pending authorization type that yields a client token bound to a grant

They may share storage and helper patterns, but not semantics.

## Current seam inventory

The current server already has:

- durable pending consent storage in `pending_consents`
- `initiateGrant(params)` -> returns `device_code`, `user_code`, `verification_uri`, `expires_in`
- `getPendingConsent(deviceCode)`
- `approveGrant(deviceCode, subjectId, opts)` -> creates grant + client token
- `pollGrant(deviceCode)` -> returns pending/approved/expired
- `/consent/:deviceCode` HTML consent screen
- `/consent/:deviceCode/approve-api` demo approval helper
- `/owner-token` shortcut that directly issues an owner token

This is useful substrate, but it is not an RFC 8628 implementation.

## First principle

Phase-1 provider-connect is about:

- discovering a provider
- obtaining an **owner token**
- performing **owner self-export** via standard RS endpoints

It is **not** about:

- third-party client authorization
- PDPP `authorization_details`
- grant creation
- client token issuance

So the device flow added here must be an **owner auth flow**, not a disguised PDPP grant flow.

## Exact minimum RFC 8628 surfaces to add

### 1. Device authorization endpoint

Add:

```text
POST /oauth/device_authorization
Content-Type: application/x-www-form-urlencoded
```

Phase-1 accepted parameters:

- `client_id`

Optional in phase 1:

- `scope`
- `audience` or `resource`

Phase-1 response:

```json
{
  "device_code": "dc_owner_...",
  "user_code": "AB12CD",
  "verification_uri": "http://localhost:7662/device",
  "verification_uri_complete": "http://localhost:7662/device?user_code=AB12CD",
  "expires_in": 300,
  "interval": 5
}
```

Minimum response fields to implement:

- `device_code`
- `user_code`
- `verification_uri`
- `expires_in`
- `interval`

`verification_uri_complete` is strongly recommended in phase 1 because it improves CLI usability at very low cost.

### 2. Token endpoint

Add:

```text
POST /oauth/token
Content-Type: application/x-www-form-urlencoded
```

Phase-1 accepted request:

- `grant_type=urn:ietf:params:oauth:grant-type:device_code`
- `device_code=...`
- `client_id=...`

Phase-1 success response:

```json
{
  "access_token": "tok_...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

Minimum response fields to implement:

- `access_token`
- `token_type`
- `expires_in`

Optional but nice in phase 1:

- `scope`

Do **not** publish refresh-token support in phase 1.

### 3. Verification UI route

Add:

```text
GET /device
```

Behavior:

- renders a small owner-login approval page
- accepts `?user_code=...`
- or allows manual code entry if no query is provided

This is reference-grade UI. It does not need to be beautiful. It does need to be semantically correct.

### 4. Verification action route

Add:

```text
POST /device/approve
```

Minimum form fields:

- `user_code`
- `subject_id` or reference-login subject selection

This route is reference-grade, and the exact user authentication mechanism can remain simple in phase 1.

## Minimum new objects/state to add

Do not reuse the existing pending grant row shape directly without classification.

### Add a second pending-authorization type

Either:

- add a `kind` column to `pending_consents`

or:

- add a second table for owner device auth

Preferred phase-1 choice:

- extend the existing durable pending-auth table with a `kind` discriminator

Suggested kinds:

- `grant_request`
- `owner_device_auth`

This keeps storage simple while preventing semantic confusion.

### Minimum state for owner device auth

Store:

- `device_code`
- `user_code`
- `client_id`
- `status`
- `subject_id` once approved
- `token_id` once issued
- `created_at`
- `expires_at`
- `approved_at`

Do not store:

- grant payload fields
- connector-specific params
- PDPP selection request params

Those belong to the grant flow, not owner login.

## What can remain reference-grade in phase 1

These things do **not** need to be productized yet:

- the user authentication step behind `/device`
- the subject chooser or login UX
- whether the “login” is just selecting `user_demo` from a form
- lack of MFA, passkeys, etc.
- the exact owner-token lifetime policy

What matters is:

- the wire contract is RFC 8628-shaped
- the token is a real owner token
- the CLI can use it against RS self-export endpoints

This matches `spec-auth-design.md`: owner authentication mechanism is out of scope; bearer-token use is not.

## What must not be faked

These are the hard honesty rules.

### 1. Do not use `/owner-token` as the token endpoint

`POST /owner-token` can remain as a reference/development shortcut for tests or demos, but once the provider metadata advertises device flow, the CLI path must stop depending on `/owner-token`.

### 2. Do not use `/grants/poll/:deviceCode` as the token polling contract

RFC 8628 polling belongs at the token endpoint, with device-code grant semantics and RFC-shaped error states.

### 3. Do not mint owner tokens through the grant-approval path

The current `approveGrant()` path creates:

- a PDPP grant
- a client token bound to that grant

An owner device flow must not produce fake “owner access” by going through grant issuance.

### 4. Do not publish device-flow metadata before the routes exist

If `.well-known/oauth-authorization-server` advertises:

- `device_authorization_endpoint`
- `grant_types_supported` containing device code

then those routes must exist and behave accordingly.

## Interaction with current pending-consent/device-code seams

The current seam is valuable and should be reused carefully.

### Reuse

It is reasonable to reuse:

- device-code generation
- user-code generation
- durable pending-row storage
- expiry handling
- approval-status transitions

### Do not reuse as-is

Do not treat the current grant-pending functions as generic device-flow functions:

- `initiateGrant()`
- `approveGrant()`
- `pollGrant()`
- `getPendingConsent()`

These are semantically grant-specific today.

### Suggested implementation split

Keep grant flow helpers as they are, and add parallel owner-auth helpers:

- `startOwnerDeviceAuthorization()`
- `getPendingOwnerDeviceAuthorization()`
- `approveOwnerDeviceAuthorization()`
- `pollOwnerDeviceAuthorizationToken()`

If some helper internals can be factored later, do it after the semantics are clean.

## Interaction with owner tokens

The output of phase-1 device flow should be exactly the same owner-token kind the RS already understands.

That means:

- use the existing `issueOwnerToken(subjectId)` logic or a small extracted helper around it
- keep `pdpp_token_kind = owner`
- let RS self-export keep working unchanged

This is a good cutline because it improves the auth acquisition path without forcing RS changes.

## Exact phase-1 polling/error behavior

The token endpoint should implement the minimal device-code polling semantics:

### Before approval

Return an error equivalent to RFC 8628 pending state.

Implementation requirement:

- structured JSON error on `POST /oauth/token`

### Too-fast polling

Phase-1 choice:

- implement `slow_down` if easy
- otherwise start with `authorization_pending` only and a fixed `interval`

This is acceptable for the first cut if documented and tested.

### After expiry

Return terminal expiration error.

### After approval

Return bearer owner token.

## Sequence relative to native-path cleanup

This should come **after** the native-path contract cleanup, not before it.

Reason:

- owner decision 3 is correct: the native provider path must become connector-free at the contract level first
- device flow is part of that native/provider-connect contract
- if we add device flow too early, we risk teaching the current personal-server demo auth dialect as the native provider shape

Recommended order:

1. native-path cleanup so the native provider reads as a real provider contract
2. provider metadata routes
3. minimal RFC 8628 owner device flow
4. CLI provider discovery + self-export

That said, do not defer device flow indefinitely. It is the first real auth proof for provider-connect self-export.

## Minimal implementation sequence

1. Finish durable pending-auth seam with explicit kind separation if not already done.
2. Add `owner_device_auth` pending-object helpers in `e2e/server/auth.js` or a small sibling module.
3. Add `POST /oauth/device_authorization`.
4. Add `POST /oauth/token` for device-code grant only.
5. Add `GET /device` and `POST /device/approve`.
6. Point AS metadata at those real routes.
7. Add CLI device-flow support against those routes.
8. Keep `/owner-token` only as compat/reference-only until tests and CLI no longer rely on it.

## Phase-1 test expectations

Add tests that prove exactly this:

1. device authorization request returns `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`
2. token polling before approval returns pending state
3. approval via `/device/approve` changes pending state durably
4. token polling after approval returns bearer token
5. returned token introspects as `pdpp_token_kind = owner`
6. returned token works on standard RS self-export endpoints
7. expired device code fails at token endpoint with terminal state

## Recommendation

The correct phase-1 cutline is:

- real RFC 8628-shaped owner device flow
- separate from PDPP grant issuance
- reusing the durable pending-auth seam but not reusing grant semantics
- reference-grade login UI is acceptable
- fake token issuance shortcuts are not
- land it after native-path cleanup, but early enough that provider metadata does not advertise fantasy routes

That is the smallest honest device-flow implementation that meaningfully advances provider-connect self-export.
