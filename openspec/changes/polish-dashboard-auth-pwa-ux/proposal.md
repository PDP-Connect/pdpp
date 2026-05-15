## Why

Dashboard operators should not be forced through avoidable login friction or light-only owner pages while managing long-running connector runs.

## What Changes

- Add dark-mode support to reference hosted owner pages, including `/owner/login`.
- Extend the reference owner-session default lifetime from 12 hours to 7 days.
- Add `PDPP_OWNER_SESSION_TTL_SECONDS` so deployments can shorten or lengthen the placeholder owner session explicitly.
- Verify dashboard PWA and Web Push setup metadata without duplicating the existing manifest.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects only reference owner/dashboard operator UX.
- Does not change PDPP protocol authentication semantics.
- Keeps owner cookies signed, HttpOnly, SameSite-aware, and optionally forced Secure.
