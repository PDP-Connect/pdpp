## Why

Clients that start by probing a protected RS endpoint receive a 401 JSON error but no standards-shaped pointer to the resource metadata document. RFC 9728 defines `WWW-Authenticate: Bearer resource_metadata="..."` for exactly this reactive discovery case, and the reference should emit it without weakening host-origin safety.

## What Changes

- Add a `WWW-Authenticate` challenge with a `resource_metadata` parameter on RS bearer-token 401 responses.
- Add matching `error.resource_metadata` and `error.next_step` fields to those 401 JSON bodies so simple agents that do not inspect headers still see the discovery/auth hint.
- Derive the metadata URL from the same configured/trusted public-origin logic used by `GET /.well-known/oauth-protected-resource`.
- Omit the challenge rather than deriving it from an untrusted public request host.
- Add tests for local/default discovery, explicit public-origin discovery, and untrusted host omission.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: add reactive RFC 9728 metadata discovery behavior for RS 401 responses.

## Impact

- `reference-implementation/server/index.js` — set the `WWW-Authenticate` challenge and body hints before RS auth 401 responses.
- `reference-implementation/test/provider-metadata.test.js` — cover the challenge URL and host-safety behavior.
- `openspec/changes/advertise-resource-metadata-challenge/specs/reference-implementation-architecture/spec.md` — document the reference behavior.
