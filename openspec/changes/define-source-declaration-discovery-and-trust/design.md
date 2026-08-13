# Design: Source Declaration discovery and trust

## Ownership

| Contract | Owns | This change's dependency |
|---|---|---|
| Source Declaration contract | `SourceDeclaration`, its schema, accepted source/revision snapshot, and declaration-defined authorization terms | Discovery consumes the schema and snapshot. It does not redefine them. |
| This discovery and trust change | Provider-native discovery pointer, source onboarding inputs, authority binding, bounded retrieval, exact validation, and local blocking for new consent | It must not redefine grants, consent snapshots, Core schema, or Collection. |

The Source Declaration contract must be available before an implementation can
validate or retain declarations.

## Boundary

Discovery selects and accepts a declaration authority. The Source Declaration
change owns the declaration schema and snapshot. Core owns grants and consent
semantics. Collection remains optional and owns collection execution. Discovery
does not copy any of those contracts or define how the Resource Server enforces
an issued grant.

## Provider-native discovery

For the requested protected-resource identifier, the AS uses RFC 9728
protected-resource metadata and RFC 9728's standard well-known URI
transformation. The returned metadata `resource` member must equal the
requested protected-resource identifier under RFC 9728's exact comparison
rule. PDPP adds the provider-native metadata member
`pdpp_source_declaration_uri`. It is one HTTPS URI string with no fragment or
user information.
The member is optional in generic protected-resource metadata because a
multi-source personal server or hosted MCP resource need not map to one Source
Declaration. Provider-native onboarding requires it for the specific protected
resource being accepted.

The retrieved `SourceDeclaration.source.kind` must be `provider_native`, and
`SourceDeclaration.source.id` must equal the accepted protected-resource
identifier under the Source Declaration contract. Either mismatch fails
closed.

TLS-authenticated protected-resource metadata is authoritative for its
declaration pointer. The declaration URI may be hosted on another origin. A
cross-origin host does not, by itself, authenticate `publisher.id`. Publisher
attribution is authenticated only by an accepted channel or configured mapping.
The AS stores resource authority and publisher attribution as separate facts.
Without that authentication, the publisher value remains a non-authoritative
claim and cannot support attribution or any trust decision.

## Onboarding and trust

An ordinary authorization request may name only a source already accepted by
the AS. A new provider-native resource identifier enters through explicit owner
or operator source onboarding. A client cannot select a new resource identifier
or declaration URI during authorization.

Connector and community sources come from an installed catalog, a trusted
registry entry, or explicit local provisioning. The client may name an accepted
source, but cannot turn an arbitrary URL into an authority.

## Retrieval and revision integrity

Declaration retrieval uses HTTPS, no ambient credentials, bounded bytes, time,
and retrieval depth, exact source and revision validation, and fail-closed
outcomes. Redirect handling is local policy: every redirect target and the
final declaration URL must satisfy the accepted pointer and configured
redirect policy. The policy may reject all redirects. For each connection
attempt, including every redirect hop, the retriever resolves the destination
again, validates every resolved address against the applicable network policy,
and connects only to an address from that validated result while preserving the
destination authority for TLS authentication. This prevents an earlier DNS
decision from authorizing a later rebound address. Source identity validation
remains a separate check against `SourceDeclaration.source.id`; a declaration
URL is not reinterpreted as the source identifier. These rules are PDPP
retrieval policy, not RFC 9728 redirect rules. Implementations do not
automatically fetch remote schemas. Private or local endpoints are allowed only
through explicit local provisioning or onboarding. Such provisioning supplies
the applicable network policy; a broad IP-address exclusion list is not
universal protocol conformance.

An accepted revision is identified by the accepted authority binding,
`source.id`, and opaque `declaration_version`. After parsing and validating the
JSON, later content under the same key must compare equal as parsed JSON. A
deployment may use an internal content fingerprint to make that comparison
efficient, but its algorithm is not a protocol identity or cross-implementation
digest. When provider-native discovery is used for consent, the AS must retain
an unambiguous AS-local accepted-revision reference in consent and audit
evidence. The reference addresses this AS's accepted authority binding and
parsed revision only. It is not a portable authorization right, grant identity,
bearer handle, or cross-AS declaration credential. A current pointer that
returns a prior revision is not ordered or
rejected by `declaration_version`; accepting it requires explicit publisher or
local policy. A different parsed document under the same revision is
equivocation and is rejected.

Display values are untrusted and must be escaped for their output context.
The implementation defines configured whole-response, parser, and display
maxima. Values over a configured maximum are rejected before consent rendering
or logging. This change does not add fixed display `maxLength` numbers to the
Source schema.

Current declaration query capability is separate from issued-grant rights. This
change does not add expansion constraints to grants. Unless the Source
Declaration change explicitly makes expansion an authorization constraint,
current expansion capability must not widen the streams or fields in an issued
grant.

## Lifecycle

If a declaration is locally blocked, it cannot be used for new consent. That
block does not automatically revoke historical grants. Quarantine records and a
quarantine workflow are deferred. Existing grant behavior remains owned by the
Core grant and consent contracts.

## Alternatives rejected

- Client-selected declaration URLs or new resources: they would let a request
  choose an authority and bypass onboarding.
- Treating a cross-origin declaration host as publisher authentication: resource
  authority and publisher attribution are distinct trust facts.
- Parsed-JSON or digest-based portability rules: they add a comparison contract
  that this change does not need.
- Universal private-address rejection: local deployments need an explicit,
  narrow provisioning path, while protocol conformance stays transport-focused.
- Collection as a prerequisite: provider-native and pre-collected Core sources
  must work without Collection Profile semantics.

## Claim classification

| Decision | Class | Basis |
|---|---|---|
| RFC 9728 metadata lookup, standard well-known transformation, and exact returned-resource comparison | primary precedent | RFC 9728 |
| `pdpp_source_declaration_uri`, HTTPS/no fragment, provider-native kind, source ID equality, onboarding, and authority separation | PDPP policy | Cross-redteam and discovery implementation review |
| Parsed-content immutability keyed by authority, source ID, and opaque version, with a required AS-local accepted-revision evidence reference for provider-native consent | PDPP policy | Collection rereview and implementation map |
| Per-connection DNS/IP validation, hop-by-hop redirect policy, and final declaration URL validation | PDPP policy | Retrieval threat model; not an RFC 9728 rule |
| Current-pointer rollback requires explicit publisher/local policy | PDPP policy | Opaque revision semantics and lifecycle boundary |
| Client-supplied arbitrary declaration URLs are rejected | PDPP policy | Authority substitution and SSRF threat; no live accepting path is claimed |
| Normal declaration evolution does not reinterpret resolved grants | demonstrated defect | Prior review identified live declaration dependence as a grant-widening risk |
| No schema, grant, consent snapshot, Core, or Collection duplication | PDPP policy | Contract ownership matrix |
| Local blocking without automatic historical grant revocation; quarantine deferred | PDPP policy | Cross-redteam review |
