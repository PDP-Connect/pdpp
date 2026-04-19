# Provider Metadata Route Plan

Date: 2026-04-16  
Status: Minimal implementation plan for first RFC 9728 / RFC 8414 metadata surfaces in the reference stack

## Why this plan exists

The provider-connect work now has:

- a profile outline
- an implementation map
- a CLI surface memo

What it still needs is one concrete implementation cutline for the first metadata surfaces in `e2e/server`.

This memo answers:

- which routes to add first
- which fields to expose first
- which fields to omit on purpose
- how the CLI will use those metadata documents

This is intentionally phase-1 and minimal. The goal is to prove one real generic discovery path, not to ship a full provider ecosystem.

## Current server reality

The current `e2e/server/index.js` shape is:

- AS app on one port
- RS app on another port
- no provider metadata routes yet
- no RFC 8628 device flow endpoints yet
- current owner bootstrap is the reference-only `POST /owner-token` helper

That means the first metadata implementation should:

- add the metadata routes now
- point only to routes we actually intend to support next
- avoid publishing aspirational metadata that implies flows the server does not really implement

## First principle

The first proved path should stay aligned with the provider-connect implementation map:

- RFC 9728 protected-resource metadata as the discovery anchor
- RFC 8414 authorization-server metadata for the AS
- PDPP-specific extension fields only where the OAuth standards do not carry enough information
- owner self-export first
- no PDPP-specific `/.well-known/pdpp` document yet

## Minimal route set to add first

Add exactly two metadata routes in phase 1:

### 1. RS metadata route

Add to the RS app:

```text
GET /.well-known/oauth-protected-resource
```

Response:

- `200 OK`
- `Content-Type: application/json`
- JSON object containing RFC 9728 fields plus a very small PDPP extension set

### 2. AS metadata route

Add to the AS app:

```text
GET /.well-known/oauth-authorization-server
```

Response:

- `200 OK`
- `Content-Type: application/json`
- JSON object containing RFC 8414 fields plus a very small PDPP extension set

## Why these exact route shapes

### RFC 9728 route

RFC 9728 defines the default well-known suffix:

```text
/.well-known/oauth-protected-resource
```

This is valid when the protected resource identifier has no path component.

For the first reference cut, that is the cleanest choice. Treat the resource identifier as the provider/RS base URL, and use a PDPP extension field to point to the Core query base under `/v1`.

That avoids path-based well-known complexity in phase 1 while still staying standards-based.

### RFC 8414 route

RFC 8414 defines the default well-known suffix:

```text
/.well-known/oauth-authorization-server
```

The current reference AS does not need a path-based issuer in phase 1, so the root well-known route is the right starting shape.

## Implementation shape in `e2e/server`

### New module

Add:

```text
e2e/server/metadata.js
```

Suggested exports:

- `buildProtectedResourceMetadata(opts)`
- `buildAuthorizationServerMetadata(opts)`

This keeps metadata generation out of `index.js`, makes test coverage easier, and creates a clear seam for later profile evolution.

### Minimal `opts` shape

For `buildProtectedResourceMetadata()`:

- `resource`
- `resourceName`
- `authorizationServers`
- `queryBase`
- `providerConnectVersion`
- `selfExportSupported`
- `tokenKindsSupported`

For `buildAuthorizationServerMetadata()`:

- `issuer`
- `tokenEndpoint`
- `deviceAuthorizationEndpoint`
- `providerConnectCapabilities`
- `registrationModesSupported`

### `index.js` changes

In `buildRsApp()`:

- add the `GET /.well-known/oauth-protected-resource` route near the top of the RS app

In `buildAsApp()`:

- add the `GET /.well-known/oauth-authorization-server` route near the top of the AS app

Do not add these routes in `apps/web`. They belong in the forkable reference substrate.

## Environment/config inputs

Add or normalize these environment variables:

- `AS_PUBLIC_URL`
- `AS_ISSUER`
- `RS_PUBLIC_URL`
- `PDPP_PROVIDER_NAME`
- `PDPP_PROVIDER_CONNECT_VERSION`

Resolution rule:

- prefer explicit env
- otherwise derive from the current request host/protocol

Recommended defaults for local dev:

- `AS_PUBLIC_URL=http://localhost:7662`
- `AS_ISSUER=http://localhost:7662`
- `RS_PUBLIC_URL=http://localhost:7663`
- `PDPP_PROVIDER_NAME=PDPP Reference Provider`
- `PDPP_PROVIDER_CONNECT_VERSION=draft-2026-04-16`

Important note:

- the RFCs expect HTTPS in production
- local dev may remain HTTP in the reference stack
- the metadata should not pretend local HTTP is production guidance

## Exact first JSON shapes

### A. Protected-resource metadata

First response shape:

```json
{
  "resource": "http://localhost:7663",
  "resource_name": "PDPP Reference Resource Server",
  "authorization_servers": [
    "http://localhost:7662"
  ],
  "bearer_methods_supported": ["header"],

  "pdpp_provider_connect_version": "draft-2026-04-16",
  "pdpp_self_export_supported": true,
  "pdpp_token_kinds_supported": ["owner", "client"],
  "pdpp_core_query_base": "http://localhost:7663/v1"
}
```

### Required first RFC 9728 fields

- `resource`
  - required by RFC 9728
  - must exactly match the protected resource identifier the CLI used to fetch the document
- `authorization_servers`
  - needed so the CLI can find the AS issuer

### Recommended first RFC 9728 fields

- `resource_name`
  - useful for CLI display and debugging
- `bearer_methods_supported`
  - explicitly advertise header-based bearer usage

### First PDPP extensions

- `pdpp_provider_connect_version`
  - tells the CLI this is a provider-connect-aware provider
- `pdpp_self_export_supported`
  - phase 1 is explicitly about self-export
- `pdpp_token_kinds_supported`
  - tells the CLI whether `owner` is recognized
- `pdpp_core_query_base`
  - removes ambiguity about where PDPP Core RS queries live

### B. Authorization-server metadata

First response shape:

```json
{
  "issuer": "http://localhost:7662",
  "token_endpoint": "http://localhost:7662/oauth/token",
  "device_authorization_endpoint": "http://localhost:7662/oauth/device_authorization",
  "grant_types_supported": [
    "urn:ietf:params:oauth:grant-type:device_code"
  ],
  "token_endpoint_auth_methods_supported": ["none"],

  "pdpp_provider_connect_capabilities": [
    "owner_self_export",
    "cli_device_connect"
  ],
  "pdpp_registration_modes_supported": [
    "none"
  ]
}
```

### Required first RFC 8414 fields

- `issuer`
  - required
- `token_endpoint`
  - required in practice for device-code token exchange

### Recommended first RFC 8414 fields

- `device_authorization_endpoint`
  - needed for CLI device flow
- `grant_types_supported`
  - should explicitly advertise device code
- `token_endpoint_auth_methods_supported`
  - phase 1 should keep this simple: public CLI / no client auth

### First PDPP extensions

- `pdpp_provider_connect_capabilities`
  - first values:
    - `owner_self_export`
    - `cli_device_connect`
- `pdpp_registration_modes_supported`
  - first value:
    - `none`

This keeps the metadata honest: phase 1 does not prove dynamic registration or generic third-party client onboarding.

## What to omit in phase 1

The main discipline here is not publishing metadata that implies unfinished behavior.

### Omit from RFC 9728 response

- `scopes_supported`
  - phase 1 is not proving OAuth scope-driven client behavior
- `jwks_uri`
  - not needed for the first CLI discovery path
- `resource_signing_alg_values_supported`
  - not relevant yet
- `resource_documentation`
  - nice later, not needed for proof
- `signed_metadata`
  - definitely not phase 1

### Omit from RFC 8414 response

- `authorization_endpoint`
  - do not publish until a real browser/native auth-code flow exists
- `response_types_supported`
  - same reason
- `registration_endpoint`
  - no dynamic registration in phase 1
- `code_challenge_methods_supported`
  - do not imply PKCE support before auth-code flow exists
- `pushed_authorization_request_endpoint`
  - not needed yet
- `authorization_details_types_supported`
  - phase 1 is not proving generic third-party PDPP client requests

### Omit as separate docs

- `/.well-known/pdpp`
  - explicitly not in phase 1

## Important honesty rule

Do not publish the metadata documents until the referenced auth routes are real enough.

That means:

- if `device_authorization_endpoint` is present, the reference stack needs a real device-flow endpoint next
- do not point `token_endpoint` to `/owner-token`
- do not use metadata to paper over demo-only auth helpers

The metadata plan and auth-route plan should land together or in very close sequence.

## CLI discovery flow

Phase-1 CLI discovery should be:

1. User provides a provider/RS base URL.
2. CLI fetches:

```text
GET {base}/.well-known/oauth-protected-resource
```

3. CLI validates:

- `resource` exactly equals the base URL used for discovery
- `authorization_servers[0]` exists
- `pdpp_provider_connect_version` exists
- `pdpp_self_export_supported` is `true`
- `owner` is present in `pdpp_token_kinds_supported`

4. CLI reads `pdpp_core_query_base` and stores it as the RS query base.
5. CLI fetches:

```text
GET {authorization_servers[0]}/.well-known/oauth-authorization-server
```

6. CLI validates:

- `issuer` exactly matches the authorization server identifier used
- `device_authorization_endpoint` exists
- `token_endpoint` exists
- `urn:ietf:params:oauth:grant-type:device_code` is present in `grant_types_supported`
- `owner_self_export` is present in `pdpp_provider_connect_capabilities`

7. CLI can then either:

- proceed to device flow once implemented
- or stop after discovery in the first metadata-only milestone

## Suggested first CLI command to prove the surface

The first CLI command should be:

```text
pdpp provider show <base-url>
```

What it does:

- fetches protected-resource metadata
- follows `authorization_servers[0]`
- fetches AS metadata
- prints:
  - resource identifier
  - query base
  - whether self-export is supported
  - whether device flow is supported
  - whether registration is required

This is the fastest way to prove that the metadata surfaces are coherent before implementing the actual login flow.

## Test plan

Add tests before or with the routes.

### `e2e/test/provider-metadata.test.js`

Minimum assertions:

1. `GET /.well-known/oauth-protected-resource` returns `200` JSON.
2. `resource` exactly matches the expected base URL.
3. `authorization_servers[0]` points to the AS issuer.
4. `pdpp_self_export_supported` is `true`.
5. `pdpp_core_query_base` ends with `/v1`.
6. `GET /.well-known/oauth-authorization-server` returns `200` JSON.
7. `issuer` exactly matches the AS issuer.
8. `device_authorization_endpoint` and `token_endpoint` are present.
9. `grant_types_supported` contains device code.
10. CLI/provider discovery helper can fetch both documents and extract the expected capability summary.

## Minimal implementation sequence

1. Add `e2e/server/metadata.js`.
2. Add RS metadata route.
3. Add AS metadata route.
4. Add tests for both metadata docs.
5. Add `pdpp provider show` in the CLI.
6. Only after that, implement the real device-flow routes those docs advertise.

## Recommendation

The first provider metadata milestone should be deliberately small:

- one RFC 9728 route
- one RFC 8414 route
- four PDPP extension fields on the RS metadata
- two PDPP extension fields on the AS metadata
- no custom PDPP well-known document
- no dynamic registration
- no published auth-code/PKCE claims yet

That is enough to prove the discovery chain cleanly and keeps the reference aligned with the “reuse OAuth directly, add only the missing glue” rule.
