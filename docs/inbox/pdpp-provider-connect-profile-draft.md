# PDPP Provider Connect Profile (Draft)

Status: Working draft  
Date: 2026-04-16  
Intended status: Companion profile draft for discussion

## 1. Introduction

This document sketches a thin companion profile for generic PDPP provider connectivity.

The problem it addresses is:

- a native application, desktop application, or CLI wants to support "`connect to your PDPP provider`"
- the client should be able to rely on standards-based discovery and OAuth behavior where possible
- the client should not need bespoke provider documentation for the common case

The profile is intentionally compositional. It reuses OAuth and related standards by reference and defines only the smallest PDPP-specific discovery and capability glue needed for interoperability.

This draft does **not** redefine core PDPP grant semantics, collection/runtime behavior, or general OAuth behavior.

## 2. Scope

This profile is about the **AS / client / RS seam** for generic provider connectivity.

It covers:

- discovery of the OAuth authorization server and the PDPP resource server
- provider capability signaling relevant to PDPP connectivity
- assumptions for owner self-export
- assumptions for third-party client connectivity
- the minimum contract a generic native client or CLI may rely on

It does not cover:

- collection/runtime behavior
- connector execution
- orchestration or control-plane behavior
- landing-page or website integration
- UI layout for consent presentation
- local audit logging or transparency history
- a general hardening profile beyond the OAuth security baseline already defined elsewhere

## 3. Non-goals

This profile is not intended to:

- restate RFC 6749, RFC 6750, RFC 7591, RFC 7662, RFC 8252, RFC 8414, RFC 8628, RFC 9126, RFC 9396, RFC 9700, or RFC 9728
- define a PDPP-specific replacement for OAuth authorization-server metadata or protected-resource metadata
- require dynamic client registration from every conforming provider
- require a new PDPP-specific discovery endpoint in the current profile revision
- redefine owner authentication or token issuance mechanics beyond what PDPP core and the referenced OAuth standards already permit

## 4. Relationship to core PDPP

The following remain core-PDPP concerns and are not redefined here:

- the PDPP `authorization_details` type and object semantics
- grant semantics, including streams, views, access mode, purpose declarations, and retention declarations
- requester identity semantics (`client_display`, `client_claims`)
- resource-server query semantics
- owner-authenticated self-export semantics once an owner token exists
- owner-token versus client-token distinction at the RS boundary
- AS↔RS token-resolution expectations

This profile defines only the additional interoperability glue needed for a generic client to discover and use those core-PDPP surfaces.

## 5. Normative language

The key words "`MUST`", "`MUST NOT`", "`REQUIRED`", "`SHOULD`", "`SHOULD NOT`", "`RECOMMENDED`", "`MAY`", and "`OPTIONAL`" in this document are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

## 6. Normative dependencies

This profile depends on the following standards by reference:

- RFC 6749: OAuth 2.0 Authorization Framework
- RFC 6750: OAuth 2.0 Bearer Token Usage
- RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol
- RFC 7662: OAuth 2.0 Token Introspection
- RFC 8252: OAuth 2.0 for Native Apps
- RFC 8414: OAuth 2.0 Authorization Server Metadata
- RFC 8628: OAuth 2.0 Device Authorization Grant
- RFC 9126: OAuth 2.0 Pushed Authorization Requests
- RFC 9396: OAuth 2.0 Rich Authorization Requests
- RFC 9700: Best Current Practice for OAuth 2.0 Security
- RFC 9728: OAuth 2.0 Protected Resource Metadata
- PDPP Core

Normative behavior from those specifications is incorporated by reference and is not repeated here.

## 7. Conformance targets

This profile defines three conformance targets.

### 7.1 Self-export provider

A **Provider Connect Self-Export Provider** is a PDPP provider that supports generic owner-operated self-export using standard PDPP RS query endpoints and the discovery/capability rules in this profile.

### 7.2 Third-party-connect provider

A **Provider Connect Third-Party Provider** is a PDPP provider that supports generic OAuth-based third-party client connectivity for PDPP selection requests, in addition to any self-export support it may offer.

### 7.3 Generic provider-connect client

A **Provider Connect Client** is a native client, desktop client, or CLI that uses this profile's discovery and capability assumptions to connect to a PDPP provider without bespoke per-provider protocol logic.

### 7.4 Launch-complete reference target

The launch-complete PDPP reference should prove all of the following together:

- owner self-export
- third-party client connectivity for a Longview-like client
- standards-based discovery through RFC 9728 plus RFC 8414
- PDPP selection requests carried as RFC 9396 `authorization_details`
- PAR-backed request staging
- manual or pre-registered client operation as the baseline fallback
- protected dynamic client registration when the AS advertises a `registration_endpoint`

This target is intentionally stronger than the minimum interoperability baseline. The baseline for the profile is that a provider MAY support only manual or pre-registered clients. The launch-complete reference should prove both the baseline path and the richer protected-DCR path.

## 8. Discovery model

### 8.1 Discovery anchor

A Provider Connect Self-Export Provider or Provider Connect Third-Party Provider MUST expose protected-resource metadata as defined by RFC 9728.

This profile treats RFC 9728 protected-resource metadata as the primary discovery anchor for RS-first clients.

### 8.2 Authorization-server metadata

When a provider exposes one or more authorization servers for PDPP use, the provider MUST expose authorization-server metadata as defined by RFC 8414 for each such authorization server.

The provider MUST make the relationship between the protected resource and the relevant authorization server(s) discoverable through standards-based metadata rather than out-of-band prose alone.

### 8.3 No new PDPP-specific discovery endpoint in the current profile revision

This profile does not require a PDPP-specific well-known discovery endpoint in its current revision.

The current assumption is:

- RFC 9728 protected-resource metadata is used to discover the protected resource and its associated authorization server(s)
- RFC 8414 authorization-server metadata is used to discover OAuth endpoints and supported auth behavior

A future PDPP-specific well-known document SHOULD be considered only if implementation experience shows that RFC 9728 plus RFC 8414 cannot carry the required RS↔AS linkage and PDPP capability signaling cleanly.

## 9. Proposed metadata extensions

This section proposes the minimum PDPP-specific metadata needed for the profile.

Unless otherwise stated, these fields are extensions to OAuth metadata documents and do not replace any RFC-defined field.

### 9.1 Protected-resource metadata extensions

The following fields are proposed as extensions to RFC 9728 protected-resource metadata.

| Field | Type | Meaning |
|---|---|---|
| `pdpp_provider_connect_version` | string | Version identifier for this profile draft or the implemented profile revision. |
| `pdpp_self_export_supported` | boolean | Whether the provider accepts owner-authenticated self-export against standard PDPP RS query endpoints. |
| `pdpp_token_kinds_supported` | array of strings | Token kinds the RS recognizes. Initial values: `owner`, `client`. |
| `pdpp_core_query_base` | URI | Base URI for the PDPP RS query surface if not already implicit from the protected-resource identifier. |

Notes:

- `pdpp_core_query_base` SHOULD be omitted when the protected-resource identifier already makes the RS query base unambiguous.
- `pdpp_token_kinds_supported` is capability signaling only. It does not redefine token format or RFC 7662 behavior.

### 9.2 Authorization-server metadata extensions

The following fields are proposed as extensions to RFC 8414 authorization-server metadata.

| Field | Type | Meaning |
|---|---|---|
| `pdpp_provider_connect_capabilities` | array of strings | PDPP provider-connect capabilities exposed by this AS. Initial values: `owner_self_export`, `third_party_client_connect`, `native_pkce_connect`, `cli_device_connect`. |
| `pdpp_authorization_details_types_supported` | array of URIs | PDPP authorization-details type URIs accepted by this AS. |
| `pdpp_registration_modes_supported` | array of strings | Registration modes the AS supports for generic PDPP clients. Initial values: `dynamic`, `pre_registered_public`, `manual_confidential`. |

Notes:

- `pdpp_authorization_details_types_supported` is the AS-side declaration of accepted PDPP `authorization_details` types. It does not replace RFC 9396 semantics.
- `pdpp_registration_modes_supported` supplements, but does not replace, standard OAuth registration metadata and endpoint discovery.
- `pdpp_provider_connect_capabilities` is intentionally capability-oriented rather than topology-oriented.

## 10. Endpoints used by this profile

This profile reuses existing OAuth and PDPP endpoints.

### 10.1 Required standards-based endpoints

A conforming provider uses:

- the RFC 9728 protected-resource metadata endpoint
- the RFC 8414 authorization-server metadata endpoint
- the RFC 6749 authorization endpoint when authorization-code flow is supported
- the RFC 6749 token endpoint
- the RFC 8628 device authorization endpoint when device flow is supported
- the RFC 7591 client registration endpoint when dynamic client registration is supported
- the standard PDPP RS query endpoints for record access and self-export

### 10.2 No new PDPP endpoint required

This profile does not require a new PDPP-specific endpoint.

All mandatory behavior in the current profile revision is expressed through:

- existing OAuth endpoints
- existing PDPP RS query endpoints
- metadata extensions on RFC 9728 and RFC 8414 documents

## 11. Owner self-export assumptions

### 11.1 Capability signaling

A provider claiming Provider Connect Self-Export Provider conformance MUST publish:

- `pdpp_self_export_supported: true` in protected-resource metadata
- `owner` in `pdpp_token_kinds_supported`

### 11.2 Standard RS surface

When self-export is supported, the provider MUST accept owner tokens on the standard PDPP RS query endpoints. The provider MUST NOT require a separate client grant for owner self-export.

### 11.3 Owner-token acquisition

This profile does not define a new owner-token acquisition mechanism.

Instead:

- the provider MUST make the supported flow(s) discoverable through OAuth metadata and profile capability metadata
- a provider claiming generic native-client self-export SHOULD support `native_pkce_connect`
- a provider claiming generic CLI self-export SHOULD support `cli_device_connect`

For generic client interoperability, a provider claiming self-export support SHOULD support at least one owner-operable standard flow suitable for the target client type, such as:

- authorization code + PKCE for native applications
- device authorization grant for CLI clients

### 11.4 What a generic client may assume

If a provider claims self-export support, a generic client may assume:

- owner tokens are accepted at standard PDPP RS query endpoints
- self-export uses the same RS query semantics as any other PDPP query
- the discovery chain for the relevant auth flow is standards-based

A generic client MUST NOT assume:

- that every provider supports the same owner-token issuance flow
- that deployment-specific owner-auth patterns are portable across providers

## 12. Third-party client connectivity assumptions

### 12.1 Capability signaling

A provider claiming Provider Connect Third-Party Provider conformance MUST publish:

- `third_party_client_connect` in `pdpp_provider_connect_capabilities`
- at least one PDPP type URI in `pdpp_authorization_details_types_supported`
- at least one registration mode in `pdpp_registration_modes_supported`

### 12.2 Authorization request shape

For third-party client connectivity, the provider MUST accept PDPP selection requests as RFC 9396 `authorization_details`.

This profile does not redefine:

- the PDPP `authorization_details` object
- the consent semantics of the resulting PDPP grant
- requester identity metadata semantics

### 12.3 Public native clients

If a provider claims generic native-client connectivity, it MUST support an OAuth-native pattern suitable for public native clients and consistent with RFC 8252 and RFC 9700.

At minimum, this means:

- authorization code flow with PKCE for browser-capable native clients

### 12.4 CLI clients

If a provider claims `cli_device_connect`, it MUST support RFC 8628 device flow or another browser-mediated public-client flow that a generic CLI can drive without provider-specific scripting.

The recommended baseline for CLI support is RFC 8628 device flow.

### 12.5 Registration expectations

This profile does not require dynamic client registration from every conforming provider.

However, a provider claiming third-party client connectivity MUST clearly signal which of the following registration modes it supports:

- `dynamic`
- `pre_registered_public`
- `manual_confidential`

A generic client MUST NOT assume dynamic registration support unless the provider explicitly signals it.

The launch-complete PDPP reference SHOULD support:

- `dynamic` registration in protected form
- `pre_registered_public` as a baseline fallback

Open registration is out of scope for the reference target. When DCR is supported, the reference should prefer protected registration with an initial access token or equivalent provider policy control.

### 12.6 PAR

Because PDPP `authorization_details` requests may be large or privacy-sensitive, providers claiming third-party client connectivity SHOULD support RFC 9126 Pushed Authorization Requests.

A future revision of this profile MAY make PAR mandatory for third-party connectivity conformance.

## 13. Assumptions for generic clients

### 13.1 Self-export mode

A generic client implementing self-export mode may assume:

- the protected-resource metadata is the discovery entry point
- the RS query semantics are PDPP core semantics
- if `pdpp_self_export_supported` is true, owner-authenticated self-export is available at the RS query surface

### 13.2 Third-party-connect mode

A generic client implementing third-party-connect mode may assume only what the provider metadata declares.

In particular, the client MUST check:

- whether the provider claims `third_party_client_connect`
- whether the provider claims `native_pkce_connect` and/or `cli_device_connect` for the relevant client type
- which PDPP `authorization_details` types are accepted
- which registration modes are supported
- whether device flow is available for CLI use

The client MUST NOT assume:

- dynamic client registration
- device flow
- a shared issuer across all providers
- bespoke out-of-band approval shortcuts

## 14. Security considerations

This profile inherits OAuth security behavior from the referenced RFCs rather than redefining it.

In particular:

- public native clients SHOULD follow RFC 8252 and RFC 9700 guidance
- providers SHOULD avoid embedded webview assumptions for native apps
- providers claiming third-party client connectivity SHOULD support PAR for large PDPP requests
- bearer-token handling and log hygiene remain governed by OAuth and PDPP core security rules

This draft does not attempt to define:

- sender-constrained token requirements
- DPoP or mutual-TLS requirements
- message-signing requirements

Those belong in a future hardening profile, if needed, rather than in the first-cut provider-connect profile.

## 15. Open questions

1. Is RFC 9728 plus RFC 8414 sufficient, or does PDPP ultimately need a dedicated well-known provider document?
2. Should device flow be mandatory for providers claiming generic CLI connectivity?
3. Should PAR become mandatory for third-party connectivity conformance?
4. Should a future hardening profile introduce sender-constrained token requirements for ongoing personal-data access?

## 16. Draft recommendation

PDPP should define a thin Provider Connect Profile with two optional-but-explicit provider capabilities:

- owner self-export
- third-party client connectivity

The launch-complete PDPP reference should prove the richer end state for that profile:

- owner self-export
- third-party client connect
- manual/pre-registered client operation as the baseline
- protected dynamic client registration when advertised

The profile should:

- reuse RFC 9728 and RFC 8414 as the primary discovery surfaces
- reuse RFC 9396 for PDPP selection requests
- reuse RFC 8252, RFC 8628, RFC 9126, and RFC 9700 directly for client-connect behavior
- reuse RFC 7591 and RFC 7592 for protected dynamic client registration where supported
- define only the minimum PDPP-specific metadata needed to signal:
  - profile version
  - self-export support
  - token-kind support
  - accepted PDPP authorization-details types
  - supported registration modes
  - provider-connect capability class

The profile should not:

- expand core PDPP
- redefine OAuth discovery or registration
- require a new PDPP-specific discovery endpoint in the current profile revision
- require DCR from every conforming provider
- pull collection/runtime concerns into the auth/connectivity surface
