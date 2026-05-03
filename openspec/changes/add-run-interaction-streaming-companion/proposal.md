## Why

Some connector runs require human input that cannot be captured by static credential or OTP forms. The reference needs an owner-authorized browser streaming companion so a user can open a short-lived link, see the live browser resized to their device, and provide mouse, keyboard, and touch input without exposing a general-purpose browser bridge.

## What Changes

- Add a reference-only streaming companion for pending run interactions.
- Use CDP screencast and CDP input as the default implementation direction.
- Keep the streaming companion separate from the local collector runner and collector pairing lifecycle.
- Reuse existing owner/session, device, run interaction, and short-lived token patterns where possible.
- Treat n.eko as out of scope unless future evidence proves CDP cannot handle a real connector case.
- Document that streaming interaction is optimistic reference implementation behavior pending Collection Profile/human-owner alignment.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`

## Impact

- `reference-implementation/server/**` run interaction and streaming session routes/stores.
- `apps/web/src/app/dashboard/**` run interaction UX and streaming page.
- Potential package or service code forked from `remote-browser-service` / `remote-browser-sandbox` prior art.
- Tests for streaming session authorization, TTL, single-use behavior, input routing, and run interaction linkage.

