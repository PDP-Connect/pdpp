## Context

The failing Claude Code MCP authorization request used:

- `client_id=https://claude.ai/oauth/claude-code-client-metadata`
- `redirect_uri=http://localhost:3118/callback`

The client metadata document for that client advertises:

- `http://localhost/callback`
- `http://127.0.0.1/callback`

RFC 8252 native-app loopback guidance allows a client to bind any available
loopback port at runtime. Authorization servers therefore cannot require the
registered loopback URI's port to equal the authorization request's port.

## Decision

The reference authorization server will match registered redirect URIs exactly
except for the port when, and only when, both URIs are `http` loopback redirects
with the same normalized host and the same path/query/fragment components.

This is deliberately not a broad localhost wildcard:

- `http://localhost/callback` matches `http://localhost:3118/callback`.
- `http://127.0.0.1/callback` matches `http://127.0.0.1:3118/callback`.
- `http://localhost/callback` does not match `http://localhost:3118/other`.
- `https://client.example/callback` remains exact-match only.
- `http://client.example/callback` remains invalid for web clients.

## Alternatives

### Hardcode Claude Code's callback port

Rejected. Claude Code may choose a different available local port. Hardcoding
one port would be brittle and client-specific.

### Accept any localhost redirect path

Rejected. RFC 8252 permits port variance for loopback redirects; it does not
justify wildcard paths or arbitrary localhost callbacks.

### Force Claude Code through device authorization only

Rejected for browser-capable native clients. Device authorization is the
headless/sandbox fallback; authorization code + PKCE remains the baseline when
the client can receive a local callback.

## Acceptance Checks

- A CIMD/native client registered with `http://localhost/callback` can authorize
  with `http://localhost:<runtime-port>/callback`.
- The same authorization rejects a different path.
- Web HTTPS redirects remain exact-match only.
- Token exchange still requires the exact redirect URI used in the authorization
  request.
