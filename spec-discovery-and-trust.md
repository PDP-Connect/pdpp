# PDPP Source Declaration Discovery and Trust v0.1.0

Status: Informative. Implementation guidance. The load-bearing requirements moved into Core on 2026-09-02: equivocation into Core §5 Versioning and snapshots, source acceptance into Core §6 Source acceptance, and publisher attribution into Core §5 SourceDeclaration fields.
Date: 2026-08-14

---

## 1. Scope

This companion specification defines how an authorization server discovers,
retrieves, validates, and accepts a source declaration. The Core specification
defines the `SourceDeclaration`, selection request, grant, and resource server
semantics. This specification does not redefine those contracts.

Discovery is an onboarding concern. It is not a resource server authorization
dependency. A resource server enforces a resolved grant without retrieving a
current declaration.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, NOT RECOMMENDED, MAY, and OPTIONAL in this document are to be
interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when,
they appear in all capitals.

## 2. Provider-native discovery

An authorization server that onboards a provider-native source SHALL start
with an already accepted protected-resource identifier. The identifier MUST be
an HTTPS URI without a fragment or user information. It SHOULD NOT contain a
query component.

The authorization server SHALL derive the protected-resource metadata URL as
specified by RFC 9728 Section 3.1. It inserts
`/.well-known/oauth-protected-resource` between the authority and any path or
query component. It removes the terminating slash after the authority before
insertion. For example:

| Protected-resource identifier | Metadata URL |
| --- | --- |
| `https://resource.example.com` | `https://resource.example.com/.well-known/oauth-protected-resource` |
| `https://resource.example.com/` | `https://resource.example.com/.well-known/oauth-protected-resource` |
| `https://resource.example.com/?tenant=one` | `https://resource.example.com/.well-known/oauth-protected-resource?tenant=one` |
| `https://resource.example.com/owner/alice` | `https://resource.example.com/.well-known/oauth-protected-resource/owner/alice` |

The authorization server SHALL retrieve the metadata with HTTP `GET`. The
returned `resource` value MUST be byte-for-byte identical to the protected-
resource identifier used for the request.

PDPP defines the protected-resource metadata member
`pdpp_source_declaration_uri`. It contains one HTTPS URI string without a
fragment or user information. The member is OPTIONAL in generic protected-
resource metadata. It is REQUIRED when the resource is onboarded as one
provider-native PDPP source.

The retrieved `SourceDeclaration.source.kind` MUST be `provider_native`, and
`SourceDeclaration.source.id` MUST be identical to the accepted
protected-resource identifier. The authorization server SHALL reject either
mismatch before consent or grant issuance.

## 3. Source onboarding and authority

An ordinary authorization request SHALL name only a source already accepted by
the authorization server. A new provider-native resource SHALL enter through
explicit owner or operator onboarding. A client SHALL NOT select a new
resource authority or declaration URI during authorization.

Connector and community sources SHALL enter through an installed catalog, an
accepted registry entry, or explicit local provisioning. Local provisioning
MAY allow private or local endpoints under the operator's network policy. This
local exception does not change the public protocol requirements.

TLS authentication of protected-resource metadata authenticates the resource
authority and its declaration pointer. The declaration MAY be hosted on a
different origin. The declaration host does not, by itself, authenticate
`publisher.id`.

The authorization server SHALL keep resource authority separate from publisher
attribution. It SHALL treat `publisher.id` as authenticated only when an
accepted channel or configured mapping binds that publisher to the declaration.
Without that binding, the publisher value is a non-authoritative claim and
MUST NOT support source acceptance, redirect policy, attribution, or another
trust decision.

## 4. Bounded declaration retrieval

The declaration retriever SHALL:

1. Use HTTPS without ambient credentials.
2. Enforce configured response-byte, time, and retrieval-depth limits.
3. Require every redirect target and the final declaration URL to satisfy the
   accepted declaration pointer and the configured redirect policy. The policy
   MAY reject all redirects.
4. Resolve DNS freshly for every connection attempt, including each redirect
   hop.
5. Validate every resolved address against the applicable network policy before
   connecting.
6. Connect only to an address from that validated result while preserving the
   destination authority for TLS authentication.
7. Reject a declaration that requires automatic retrieval of a remote schema.
8. Fail closed when a bound, validation, redirect, network, or identity check
   fails.

An address accepted for an earlier connection attempt MUST NOT authorize a
later DNS result. Validation of the final declaration URL is separate from
validation of `SourceDeclaration.source.id`. The declaration location is not
the source identity.

## 5. Accepted revisions

An accepted revision SHALL be keyed by its accepted authority binding,
`source.id`, and opaque `declaration_version`. After JSON parsing and Source
Declaration validation, later content under the same key MUST compare equal as
parsed JSON.

An implementation MAY use an internal content fingerprint to accelerate this
comparison. The fingerprint algorithm is not a protocol identity and need not
be portable between implementations.

When the authorization server uses provider-native discovery for consent, its
consent and audit evidence SHALL retain an unambiguous AS-local
accepted-revision reference to the accepted authority binding and parsed
revision retained by this AS. That reference is not a portable authorization
right, grant identity, bearer handle, or cross-AS declaration credential.

Different parsed content under an accepted key is equivocation. The
authorization server SHALL reject it and retain the previously accepted
content. It SHALL NOT infer ordering or freshness from
`declaration_version`. A pointer to a previously accepted revision is accepted
or rejected only under explicit publisher or local rollback policy.

## 6. Use and lifecycle

Declaration display values are untrusted input. An implementation SHALL escape
them for their output context and enforce configured response, parser, display,
and logging limits before consent rendering or logging.

Current declaration query capabilities MUST NOT widen an issued grant. A local
block MAY prevent a declaration from being used for new consent. That block
MUST NOT automatically revoke historical grants.

The Collection Profile remains OPTIONAL. Discovery and trust apply equally to
provider-native sources, pre-collected sources, and connector-backed sources.
An accepted source does not need a Collection Profile extension unless the
implementation uses Collection Profile behavior for that source.

## References

- RFC 2119, Key words for use in RFCs to Indicate Requirement Levels
- RFC 8174, Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words
- RFC 9728, OAuth 2.0 Protected Resource Metadata
- [PDPP Core](spec-core)
- [PDPP Collection Profile](spec-collection-profile)
