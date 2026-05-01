## Why

Auth docs currently imply the app token path is OAuth authorization-code-with-RAR, while the live reference deliberately exposes PAR plus a direct consent-token handoff and does not advertise a generic authorization endpoint. The docs should not make the reference look more complete than it is.

## What Changes

- Clarify that authorization-code-with-RAR is a standards-aligned profile, not the only allowed issuance mechanism.
- State that the current reference profile uses PAR, consent review, and direct grant/token return.
- Keep the generic authorization-code redirect flow explicitly out of current reference scope.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Documentation-only.
- Does not change protocol endpoints or metadata.
