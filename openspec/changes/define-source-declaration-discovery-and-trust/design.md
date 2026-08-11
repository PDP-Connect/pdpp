# Design: Source Declaration discovery and trust

## Ownership and merge order

| Merge order | Change | Owns | This change's dependency |
|---|---|---|---|
| 1 | Source Declaration contract | `SourceDeclaration`, its schema, accepted source/revision snapshot, and declaration-defined authorization terms | Discovery consumes the schema and snapshot. It does not redefine them. |
| 2 | PR89 authorization context | The binding-neutral authorization context and its target context contract | Discovery consumes the stable context contract. It does not define the context or legacy acceptance field. |
| 3 | This discovery and trust change | Provider-native discovery pointer, source onboarding inputs, authority binding, bounded retrieval, exact validation, and local blocking for new consent | It must not redefine grants, consent snapshots, Core schema, or Collection. |

The merge order is 1, 2, 3. Discovery may later advertise legacy acceptance when
PR89's target context contract is stable. This change records that dependency
but does not invent the field.

## Boundary

Discovery selects and accepts a declaration authority. The Source Declaration
change owns the declaration schema and snapshot. Core owns grants and consent
semantics. Collection remains optional and owns collection execution. Discovery
does not copy any of those contracts or define how the Resource Server enforces
an issued grant.

## Provider-native discovery

For the exact protected-resource identifier, the AS uses RFC 9728 protected-
resource metadata and RFC 9728's standard well-known URI transformation. PDPP
adds the provider-native metadata member
`pdpp_source_declaration_uri`. It is one HTTPS URI string with no fragment.

RFC 9728 exact resource comparison uses decoded Unicode code-point equality
without normalization. PDPP explicitly requires
`SourceDeclaration.source.id` to equal the provider-native protected resource.
This is PDPP policy. A mismatch fails closed.

TLS-authenticated protected-resource metadata is authoritative for its
declaration pointer. The declaration URI may be hosted on another origin. A
cross-origin host does not, by itself, authenticate `publisher.id`. Publisher
attribution is authenticated only by an accepted channel or configured mapping.
The AS stores resource authority and publisher attribution as separate facts.

## Onboarding and trust

An ordinary authorization request may name only a source already accepted by
the AS. A new provider-native resource identifier enters through explicit owner
or operator source onboarding. A client cannot select a new resource identifier
or declaration URI during authorization.

Connector and community sources come from an installed catalog, a trusted
registry entry, or explicit local provisioning. The client may name an accepted
source, but cannot turn an arbitrary URL into an authority.

## Retrieval and revision integrity

The reference implementation uses HTTPS, no redirects, no ambient
credentials, bounded bytes, time, and retrieval depth, exact source and revision
validation, and fail-closed outcomes. It does not automatically fetch remote
schemas. Private or local endpoints are allowed only through explicit local
provisioning or onboarding. A broad IP-address exclusion list is not universal
protocol conformance.

An accepted revision is identified by the accepted authority binding,
`source.id`, and opaque `declaration_version`. Its immutable content is the
exact accepted UTF-8 JSON body bytes after HTTP content decoding. Later
non-identical bytes under the same key are rejected. This design does not
require a cross-implementation digest, parsed-JSON equivalence, a portable
cache-key grammar, rollback framework, or version ordering.

Display values are untrusted and must be escaped for their output context.
Whole-response, parser, and display limits are implementation policy. This
change does not add fixed display `maxLength` numbers to the Source schema.

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
| RFC 9728 metadata lookup, exact resource comparison, and decoded code-point equality | Primary evidence | RFC 9728 |
| `pdpp_source_declaration_uri`, HTTPS/no fragment, source ID equality, onboarding, and authority separation | PDPP policy | Cross-redteam and discovery implementation review |
| Exact decoded-body-byte immutability keyed by authority, source ID, and opaque version | PDPP policy | Collection rereview and implementation map |
| No schema, grant, consent snapshot, Core, or Collection duplication | Boundary decision | Three-PR ownership matrix |
| Local blocking without automatic historical grant revocation; quarantine deferred | Scope decision | Cross-redteam review |
