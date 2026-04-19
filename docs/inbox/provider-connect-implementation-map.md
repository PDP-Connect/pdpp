# Provider Connect Implementation Map

Status: Working implementation memo  
Date: 2026-04-16

## Purpose

This document maps the draft PDPP Provider Connect Profile to the **smallest concrete reference-implementation surfaces** worth carrying in the launch build.

It is intentionally implementation-oriented. It answers:

- what metadata documents and endpoints must exist for the launch target
- which exact fields the reference should expose for that target
- what can remain omitted even in the launch-complete reference
- how a generic CLI should exercise the launch-complete surface

The goal is to make the launch target concrete without overbuilding the surrounding ecosystem.

## Launch-complete target

The launch-complete reference target is:

> A generic PDPP client can discover a provider through RFC 9728 plus RFC 8414, determine whether owner self-export and third-party client connectivity are supported, obtain an owner token through a standards-based flow, and either use pre-registered client credentials or protected dynamic client registration to stage a PDPP request and complete a consented client-connect flow.

That target includes the important connection modes we want the reference to ship with:

- owner-authenticated self-export
- known third-party client connect
- protected DCR when the provider advertises it
- a manual or pre-registered fallback for providers that do not support DCR

The interoperability baseline remains smaller than the launch-complete reference: DCR is not universal and should not be the only supported registration path.

## What the launch-complete reference must expose

### 1. Protected-resource metadata endpoint

This is the most important discovery surface for the launch target.

The reference should expose:

- the RFC 9728 protected-resource metadata endpoint for the native PDPP provider
- the same for the personal-server realization if we want the CLI to support both

This is the discovery anchor for a generic CLI.

### 2. Authorization-server metadata endpoint

The reference should expose:

- an RFC 8414 authorization-server metadata document for the AS that issues owner tokens

One AS metadata document is enough if it truthfully advertises the supported provider-connect modes.

### 3. Standard PDPP RS query endpoints

These already exist conceptually and are the actual data surface the CLI should call.

The reference should prove:

- stream listing
- record query
- self-export using owner auth against those exact same endpoints

### 4. Owner-auth flow suitable for CLI use

The minimal strong option is:

- RFC 8628 device authorization grant

This is better than inventing a custom CLI login.

The launch target should use RFC 8628 device flow rather than a bespoke shortcut.

### 5. Third-party client registration paths

The launch-complete reference should support both:

- protected dynamic client registration when `registration_endpoint` is advertised
- a pre-registered client path when the provider does not support DCR

This keeps the launch target complete without pretending DCR is the universal baseline.

## Minimal metadata fields to expose at launch

The launch-complete reference should still expose the smallest field set that proves the complete launch target honestly.

### A. Protected-resource metadata: launch-required fields

Expose these at launch:

- `authorization_servers`
  Why: lets the CLI find the AS metadata document through the RFC 9728/RFC 8414 chain.
- `pdpp_provider_connect_version`
  Why: lets the CLI know it is talking to a provider-connect-aware provider.
- `pdpp_self_export_supported`
  Why: lets the CLI distinguish providers that support owner-operated self-export.
- `pdpp_token_kinds_supported`
  Why: lets the CLI distinguish a provider that actually recognizes owner tokens.
- `pdpp_core_query_base`
  Why: removes ambiguity about the RS base the CLI should call.

Suggested first values:

```json
{
  "authorization_servers": [
    "https://northstar.example.com"
  ],
  "pdpp_provider_connect_version": "draft-2026-04-16",
  "pdpp_self_export_supported": true,
  "pdpp_token_kinds_supported": ["owner", "client"],
  "pdpp_core_query_base": "https://northstar.example.com/v1"
}
```

### B. Authorization-server metadata: launch-required fields

Expose these at launch:

- the normal RFC 8414 core fields needed for device flow and token acquisition
- `pdpp_provider_connect_capabilities`
- `pdpp_registration_modes_supported`
- `pdpp_authorization_details_types_supported`
- `pushed_authorization_request_endpoint` when PAR is supported
- `registration_endpoint` when protected DCR is supported

Suggested first values:

```json
{
  "issuer": "https://northstar.example.com",
  "introspection_endpoint": "https://northstar.example.com/introspect",
  "token_endpoint": "https://northstar.example.com/oauth/token",
  "token_endpoint_auth_methods_supported": ["none"],
  "device_authorization_endpoint": "https://northstar.example.com/oauth/device_authorization",
  "pushed_authorization_request_endpoint": "https://northstar.example.com/oauth/par",
  "registration_endpoint": "https://northstar.example.com/oauth/register",
  "grant_types_supported": [
    "urn:ietf:params:oauth:grant-type:device_code"
  ],
  "pdpp_provider_connect_capabilities": [
    "owner_self_export",
    "cli_device_connect",
    "third_party_client_connect"
  ],
  "pdpp_authorization_details_types_supported": [
    "https://pdpp.org/data-access"
  ],
  "pdpp_registration_modes_supported": [
    "dynamic",
    "pre_registered_public"
  ]
}
```

## What can stay omitted from the launch-complete reference

To keep the reference thin, the following can remain out of scope even at launch.

### 1. Dynamic client registration is not the only baseline

Do not make RFC 7591 registration the only supported registration mode.

Reason:

- major providers still rely on manual or pre-registered clients
- launch-complete PDPP should support DCR where available without making it the universal assumption

### 2. Open registration

Do not treat open registration as part of the launch target.

Reason:

- the reference should prefer protected DCR with an initial access token or equivalent provider policy control
- open registration is not needed to prove the profile

### 3. Additional trust/bootstrap permutations

Do not expand the launch target to every ecosystem bootstrap variant.

Reason:

- the launch reference only needs to prove the important connection modes cleanly
- broader permutations can come later without weakening the launch story

## Concrete reference-implementation surfaces to support at launch

The launch implementation should introduce as little new surface area as possible.

### Surface 1: protected-resource metadata route

Add one route on the provider side that returns:

- the standard RFC 9728 fields needed for discovery
- the four PDPP extension fields listed above

This route is the main provider-connect-specific discovery surface for the launch target.

### Surface 2: authorization-server metadata route

Add or normalize one RFC 8414 route on the provider side.

The launch target does not need a huge auth-feature matrix. It needs enough metadata for:

- device authorization
- token acquisition
- PAR-backed request staging
- protected DCR discovery when available
- CLI discovery

### Surface 3: device authorization flow

Implement the smallest working RFC 8628 path that yields an owner token scoped to one subject.

This can be reference-grade rather than product-grade, but it should:

- use the standard device-flow endpoint pattern
- issue a real owner token
- avoid pretending a local session token or env var is the provider-connect standard

### Surface 3A: PAR-backed request staging

Stage PDPP request envelopes through `POST /oauth/par`, returning a `request_uri` and provider-hosted consent URL.

This is part of the launch target because third-party client connect should use the same request-staging seam the reference already proves.

### Surface 3B: dynamic client registration

Add RFC 7591 registration in protected form and advertise it through standard metadata when enabled.

The reference should:

- expose a `registration_endpoint`
- require an initial access token or equivalent provider policy control
- return standard client metadata and credentials
- keep `pre_registered_public` support available alongside `dynamic`

### Surface 4: CLI metadata inspect command

Add a CLI command that:

- accepts a provider/RS URL
- fetches protected-resource metadata
- follows the AS link to fetch authorization-server metadata
- prints the provider-connect-relevant capabilities

This is the fastest way to prove the discovery path before proving login.

### Surface 5: CLI self-export command

Add a CLI command that:

- discovers metadata
- starts owner login if needed
- stores an owner token
- hits standard PDPP RS endpoints
- returns stream or record data

## Exact launch-complete CLI flow

The launch-complete generic CLI flow should be:

1. User provides a PDPP provider URL or RS base URL.
2. CLI fetches protected-resource metadata.
3. CLI verifies:
   - `pdpp_provider_connect_version` exists
   - `pdpp_self_export_supported` is `true`
   - `owner` is in `pdpp_token_kinds_supported`
4. CLI follows `authorization_servers[0]` to fetch RFC 8414 AS metadata.
5. CLI verifies:
   - device flow is supported
   - `owner_self_export` and `cli_device_connect` are present in `pdpp_provider_connect_capabilities`
6. CLI performs device flow to obtain an owner token.
7. If the user is self-exporting, CLI calls standard PDPP RS endpoints with `Authorization: Bearer <owner_token>`.
8. If the user is connecting a third-party client, CLI either:
   - uses pre-registered client metadata, or
   - performs protected DCR when `registration_endpoint` and `dynamic` support are advertised.
9. CLI stages a PDPP request through PAR, obtains a `request_uri`, and drives the consent start surface.
10. After consent, CLI uses the resulting client grant or token resolution path against standard PDPP RS endpoints.

If these flows work generically against both:

- the native provider
- the personal-server realization

then the launch provider-connect target is real.

## What the reference should not expose yet

To avoid bloating the reference, do **not** add these in the launch target:

- a PDPP-specific discovery endpoint
- a provider-connect dashboard
- a special self-export API outside the RS query surface
- third-party-client connect endpoints beyond PAR, consent, and standard PDPP RS/token-resolution behavior
- extra metadata fields that the CLI will not actually consume in the launch target

If a field or endpoint is not needed by:

- the generic CLI
- the tests
- the future thin profile

it should probably wait.

## How this maps to the current reference-implementation stack

The current codebase already has useful substrate:

- AS/RS server
- owner-authenticated patterns
- RS query semantics
- self-export semantics in the core spec and tests

The missing pieces are mainly:

- standards-based discovery documents
- a standards-based owner login flow for a generic CLI
- a protected DCR path that coexists with pre-registered clients
- a CLI that exercises those real surfaces honestly

So the launch-oriented implementation should be mostly:

- expose metadata
- normalize auth metadata and device flow
- expose protected DCR when enabled
- write the CLI path
- add conformance-style tests for both registration modes and both connect modes

Not:

- invent new domain models
- add UI
- add broad ecosystem machinery

## Minimal launch test matrix

The launch provider-connect tests should prove:

1. protected-resource metadata is discoverable and contains the expected PDPP fields
2. authorization-server metadata is discoverable from that document
3. the provider advertises self-export support truthfully
4. a CLI-like client can complete device flow and obtain an owner token
5. the owner token works against standard PDPP RS query endpoints
6. the provider advertises whether registration is `dynamic` and/or `pre_registered_public`
7. protected DCR works when advertised
8. the pre-registered path still works when DCR is absent or disabled
9. PAR-backed PDPP request staging works for third-party client connect
10. the same CLI logic works against both reference realizations if both claim support

## Recommended order of implementation

1. Add protected-resource metadata route.
2. Add or normalize authorization-server metadata route.
3. Add owner self-export capability fields.
4. Implement or normalize device authorization flow.
5. Add or normalize PAR metadata and request staging.
6. Add protected DCR when enabled, alongside a pre-registered fallback.
7. Add `cli inspect-provider`.
8. Add `cli self-export`.
9. Add CLI support for third-party client connect using both registration paths.
10. Add tests for discovery, self-export, registration, and third-party client connect.

## Recommendation

The launch-complete implementation of the companion profile should prove:

- RS-first discovery via RFC 9728
- AS discovery via RFC 8414
- owner self-export capability signaling
- owner token acquisition via device flow
- standard PDPP RS self-export by a generic CLI
- third-party client connect using PDPP `authorization_details`
- protected DCR where advertised
- pre-registered fallback where DCR is not available

That launch target is enough to make the profile concrete without turning the reference into a bloated half-finished OAuth platform.
