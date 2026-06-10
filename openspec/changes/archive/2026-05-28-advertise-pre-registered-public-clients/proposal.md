## Why

Public metadata can advertise `pre_registered_public` without telling a third-party client which public `client_id` values are usable. That leaves agent clients at a discovery dead end when dynamic registration is intentionally unavailable on the public host.

## What Changes

- Add a PDPP authorization-server metadata extension listing advertised pre-registered public clients.
- Populate the extension from the reference's configured pre-registered public client set.
- Update public contract validation, tests, and docs so the metadata does not advertise an unusable registration mode.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects `GET /.well-known/oauth-authorization-server`.
- Does not implement open self-registration.
- Does not publish dynamically registered or owner-scoped clients.
