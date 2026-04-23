# Owner Auth Placeholder Open Question (2026-04-22)

**Status:** partially landed — reference implementation now ships the recommended placeholder behind `PDPP_OWNER_PASSWORD` for the approval surfaces; `/dashboard` is intentionally **still not gated** and remains the open follow-up question  
**Scope:** reference-only owner approval/authentication surfaces; not a PDPP Core protocol change

## Why this exists

The current reference implementation exposes real local approval UIs for:

- `GET /consent?request_uri=...`
- `POST /consent/approve`
- `POST /consent/deny`
- `GET /device?user_code=...`
- `POST /device/approve`
- `POST /device/deny`

Those surfaces are intentionally part of the current thin provider-connect and
owner-device reference story.

But today they do **not** have a real owner-authentication layer in front of
them. They effectively trust whoever can reach the local UI and submit a
`subject_id`, defaulting to `owner_local`.

That is acceptable as a local-development shortcut, but it should be described
truthfully and treated as a reference-design question rather than silently left
as if it were a finished auth story.

## Current reality

The current reference behaves like this:

- when `PDPP_OWNER_PASSWORD` is **unset**: the approval surfaces remain openly
  accessible on the local AS, matching the original open local-dev behavior
- when `PDPP_OWNER_PASSWORD` is **set**: the `/consent*` and `/device*`
  approval surfaces require a valid owner session established via
  `/owner/login`, and the submitted `subject_id` is ignored in favor of
  `PDPP_OWNER_SUBJECT_ID` (defaulting to `owner_local`)
- no durable session, passkey, or external identity provider is required —
  the placeholder is a stateless HMAC-signed cookie only
- `/dashboard` is **not** gated in this tranche and remains an open follow-up
- public protocol surfaces (`/oauth/par`, `/oauth/register`, `/oauth/token`,
  `/v1/*`, `/.well-known/*`) are not gated; the placeholder only affects the
  local approval UIs
- this is still grant issuance / owner approval, not a durable answer to "how
  does the owner authenticate?"

This matches the current protocol stance:

- PDPP Core requires distinct owner and app tokens
- PDPP Core leaves the owner-authentication mechanism out of scope
- the reference therefore needs an implementation choice, not a protocol change

## What this note was trying to decide

Before the reference claims a more polished local control/approval surface, we
wanted to decide whether it wants a simple owner-auth placeholder.

The original question was:

**Should the reference add a local-only owner-auth session layer in front of
the approval/dashboard surfaces before a more durable owner-auth story is
chosen?**

### Status

The **approval** half of that question is now answered affirmatively and
landed: the reference ships an env-gated password-and-session placeholder in
front of `/consent` and `/device` approval routes. The **dashboard** half
remains open — see the open questions section below.

## Placeholder direction (landed for approval surfaces)

The landed placeholder uses this shape:

- local-only password gate from env: `PDPP_OWNER_PASSWORD`
- optional `PDPP_OWNER_SUBJECT_ID` selects the single owner subject id the
  placeholder will use for approved grants/device authorizations (defaults to
  `owner_local`); freeform `subject_id` input is ignored when placeholder auth
  is enabled
- `GET /owner/login` remains a stable owner-entry page even when placeholder
  auth is disabled; in that case it renders an honest hosted UI explaining
  that approval pages are open locally and how to enable the placeholder
- a signed HTTP-only cookie (`pdpp_owner_session`, `SameSite=Lax`, `Secure`
  when served over HTTPS) after successful local login, with a 12 hour
  lifetime
- implemented with Node `crypto` HMAC-SHA256 — no new dependencies
- unauthenticated HTML requests to a protected route redirect to
  `/owner/login?return_to=...`; non-HTML callers get an honest `401` with
  error code `owner_session_required`
- requires that session for the approval surfaces:
  - `/consent`
  - `/consent/approve`
  - `/consent/deny`
  - `/device`
  - `/device/approve`
  - `/device/deny`
- **not** applied to `/dashboard` in this tranche — see open questions
- if the env var is not set, remain in the current open local-dev mode

Why this is the recommended placeholder:

- simple and reversible
- does not reopen PDPP Core semantics
- improves the local safety story materially
- avoids pretending that freeform `subject_id` entry is authentication
- leaves room for later replacement with passkeys, SSO, wallet signatures, or
  another real reference choice

## What we should not do as part of this placeholder

- do not standardize owner auth in PDPP Core
- do not build a large account/user-management system
- do not require an external identity provider for the local reference
- do not pretend the current thin provider-connect reference is a full
  ecosystem auth product

## Open questions to resolve later

- whether the launch reference should stay openly local-only by default, with
  placeholder auth merely optional (still the current default: placeholder is
  off until `PDPP_OWNER_PASSWORD` is set)
- whether `/dashboard` should be protected by the same owner session as the
  approval/device pages — **still open**: the approval/device tranche landed
  without gating `/dashboard`, and the dashboard remains an open follow-up
  until we can gate it with the exact same cookie/session model and no
  parallel auth implementation
- whether the placeholder session should continue to identify only one local
  owner subject or grow to support explicit multi-subject local testing
- whether a later reference auth choice should be:
  - local password + session only (currently landed as placeholder)
  - passkeys
  - external OIDC
  - wallet signature
  - something else entirely

## Owner recommendation today

The current state is that the approval-surface placeholder landed — the
reference is now truthful about not pretending freeform `subject_id` entry is
authentication and is safer against casual local-network exposure when
`PDPP_OWNER_PASSWORD` is set. The placeholder is still not a durable owner-auth
story: `/dashboard` is not gated, there is no multi-subject support, and the
mechanism should be replaced (not extended) when a durable reference auth
choice is made.
