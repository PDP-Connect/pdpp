# PDPP Source Declaration Discovery and Trust v0.1.0

Status: Informative. Implementation guidance. Normative requirements moved to Core §5 Declaration acceptance on 2026-09-02. This document uses no BCP 14 requirement keywords: it describes what an implementation does, and Core states every requirement.
Date: 2026-09-03

---

## 1. Scope

This companion specification defines how an authorization server discovers, retrieves, validates, and accepts a source declaration. The Core specification defines the `SourceDeclaration`, selection request, grant, and resource server semantics. This specification does not redefine those contracts.

Discovery is an onboarding concern. It is not a resource server authorization dependency. A resource server enforces a resolved grant without retrieving a current declaration.

## 2. Provider-native discovery

An authorization server that onboards a provider-native source starts from an already accepted protected-resource identifier. That identifier is an HTTPS URI carrying neither a fragment nor user information, and normally no query component either.

The authorization server derives the protected-resource metadata URL as specified by RFC 9728 Section 3.1. It inserts `/.well-known/oauth-protected-resource` between the authority and any path or query component. It removes the terminating slash after the authority before insertion. For example:

| Protected-resource identifier | Metadata URL |
| --- | --- |
| `https://resource.example.com` | `https://resource.example.com/.well-known/oauth-protected-resource` |
| `https://resource.example.com/` | `https://resource.example.com/.well-known/oauth-protected-resource` |
| `https://resource.example.com/?tenant=one` | `https://resource.example.com/.well-known/oauth-protected-resource?tenant=one` |
| `https://resource.example.com/owner/alice` | `https://resource.example.com/.well-known/oauth-protected-resource/owner/alice` |

The authorization server retrieves the metadata with HTTP `GET`, and expects the returned `resource` value to be byte-for-byte identical to the protected-resource identifier it used for the request.

PDPP defines the protected-resource metadata member `pdpp_source_declaration_uri`. It contains one HTTPS URI string without a fragment or user information. The member is optional in generic protected-resource metadata, and is expected to be present when the resource is onboarded as one provider-native PDPP source.

The retrieved `SourceDeclaration.source.kind` is `provider_native`, and `SourceDeclaration.source.id` is identical to the accepted protected-resource identifier. An authorization server rejects either mismatch before consent or grant issuance; Core Section 5 states that rule normatively.

## 3. Source onboarding and authority

An ordinary authorization request names only a source the authorization server has already accepted. A new provider-native resource enters through explicit owner or operator onboarding, and a client does not select a new resource authority or declaration URI during authorization. Core Section 5 states this normatively.

Connector and community sources enter through an installed catalog, an accepted registry entry, or explicit local provisioning. Local provisioning may allow private or local endpoints under the operator's network policy. This local exception does not change the public protocol requirements Core states.

TLS authentication of protected-resource metadata authenticates the resource authority and its declaration pointer. The declaration may be hosted on a different origin. The declaration host does not, by itself, authenticate `publisher.id`.

The authorization server keeps resource authority separate from publisher attribution, treating `publisher.id` as authenticated only when an accepted channel or configured mapping binds that publisher to the declaration. Without that binding the publisher value is a non-authoritative claim, and it supports neither source acceptance, redirect policy, attribution, nor any other trust decision. Core Section 5 states this normatively.

## 4. Bounded declaration retrieval

A declaration retriever built to this guidance:

1. Uses HTTPS without ambient credentials.
2. Enforces configured response-byte, time, and retrieval-depth limits.
3. Requires every redirect target and the final declaration URL to satisfy the
   accepted declaration pointer and the configured redirect policy. That policy may reject all redirects.
4. Resolves DNS freshly for every connection attempt, including each redirect
   hop.
5. Validates every resolved address against the applicable network policy
   immediately before connecting.
6. Connects only to an address from that validated result, while preserving the
   destination authority for TLS authentication.
7. Rejects a declaration that requires automatic retrieval of a remote schema.
8. Fails closed when a bound, validation, redirect, network, or identity check
   fails.

An address accepted for an earlier connection attempt does not authorize a later DNS result. Validation of the final declaration URL is separate from validation of `SourceDeclaration.source.id`. The declaration location is not the source identity.

## 5. Accepted revisions

An accepted revision is keyed by its accepted authority binding, `source.id`, and opaque `declaration_version`. After JSON parsing and Source Declaration validation, later content under the same key compares equal as parsed JSON.
Core Section 5 states this normatively.

An implementation may use an internal content fingerprint to accelerate this comparison. The fingerprint algorithm is not a protocol identity and need not be portable between implementations.

When the authorization server uses provider-native discovery for consent, its consent and audit evidence retains an unambiguous AS-local accepted-revision reference to the accepted authority binding and parsed revision retained by this AS. That reference is not a portable authorization right, grant identity, bearer handle, or cross-AS declaration credential.

Different parsed content under an accepted key is equivocation. The authorization server rejects it and retains the previously accepted content, and it does not infer ordering or freshness from `declaration_version`. A pointer to a previously accepted revision is accepted or rejected only under explicit publisher or local rollback policy.

## 6. Use and lifecycle

Declaration display values are untrusted input. An implementation renders them safely for their output context, and enforces configured response, parser, display, and logging limits before consent rendering or logging. Core Section 5 states the rendering requirement normatively.

Current declaration query capabilities never widen an issued grant. A local block may prevent a declaration from being used for new consent; such a block does not automatically revoke historical grants.

The Collection Profile remains optional. Discovery and trust apply equally to provider-native sources, pre-collected sources, and connector-backed sources.
An accepted source does not need a Collection Profile extension unless the implementation uses Collection Profile behavior for that source.

## References

- RFC 9728, OAuth 2.0 Protected Resource Metadata
- [PDPP Core](spec-core)
- [PDPP Collection Profile](spec-collection-profile)
