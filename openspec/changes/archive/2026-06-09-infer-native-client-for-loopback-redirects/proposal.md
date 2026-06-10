## Why

Dynamic client registration currently treats omitted `application_type` as `web` during authorization-code redirect validation. Native/local clients that register loopback HTTP redirect URIs without self-declaring `application_type: "native"` are rejected even though RFC 8252 defines loopback redirects as a native-app redirect mechanism.

## What Changes

- Infer `application_type: "native"` when DCR metadata omits `application_type` and includes a loopback HTTP redirect URI.
- Preserve explicit `application_type` semantics: an explicit `web` client with an HTTP redirect remains invalid.
- Persist and return the inferred application type in registration details.
- Add public `/oauth/register` regression coverage for `localhost` and `127.0.0.1` loopback redirects.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: DCR public-client metadata validation now infers native client type from loopback HTTP redirect URIs when the type is omitted.

## Impact

- Affects `reference-implementation/server/auth.js`.
- Affects hosted MCP and local/native OAuth clients that use DCR with loopback HTTP redirects.
- Adds focused DCR conformance tests; no new dependencies.
