# Source Declaration discovery and trust

## ADDED Requirements

### Requirement: Provider-native discovery SHALL bind the accepted resource and declaration

For an already onboarded provider-native protected resource, the AS SHALL use
RFC 9728 protected-resource metadata and its standard well-known URI
transformation. The metadata extension `pdpp_source_declaration_uri` SHALL be
one HTTPS URI string with no fragment. RFC 9728 resource comparison SHALL use
decoded Unicode code-point equality without normalization. PDPP SHALL require
`SourceDeclaration.source.id` to equal the provider-native protected resource.
The AS SHALL consume the Source schema and accepted snapshot defined by the
Source Declaration contract and SHALL fail closed on any mismatch.

#### Scenario: Metadata points to the matching declaration

- **WHEN** accepted metadata contains a valid extension and the declaration's source ID equals the protected resource under the required comparison
- **THEN** the AS SHALL accept the declaration for validation and consent

#### Scenario: Metadata extension is invalid

- **WHEN** the extension is missing, not one HTTPS URI string, or contains a fragment
- **THEN** discovery SHALL fail closed before declaration use

#### Scenario: Declaration names another resource

- **WHEN** `SourceDeclaration.source.id` does not equal the provider-native protected resource
- **THEN** the AS SHALL reject the declaration and SHALL NOT use it for consent

### Requirement: Source onboarding SHALL precede ordinary authorization

An ordinary authorization request SHALL name only a source already accepted by
the AS. A new provider-native resource identifier SHALL enter only through
explicit owner or operator onboarding. Connector and community sources SHALL
come from an installed catalog, a trusted registry entry, or explicit local
provisioning. A client SHALL NOT select a new authority or arbitrary
declaration URL during authorization.

#### Scenario: Client names an unaccepted source

- **WHEN** an authorization request names a source not accepted by the AS
- **THEN** the AS SHALL reject the request before discovery retrieval

#### Scenario: Explicit local provisioning accepts a private endpoint

- **WHEN** an operator explicitly provisions a private or local source endpoint
- **THEN** the AS MAY use that endpoint under the local provisioning policy
- **AND** the endpoint SHALL NOT become a general protocol conformance rule

### Requirement: Resource authority and publisher attribution SHALL be separate

TLS-authenticated protected-resource metadata SHALL be authoritative for its
declaration pointer. Cross-origin declaration hosting MAY be used, but the host
alone SHALL NOT authenticate `publisher.id`. Publisher attribution SHALL be
authenticated only by an accepted channel or configured mapping. The AS SHALL
store resource authority and publisher attribution separately.

#### Scenario: Cross-origin declaration host lacks a publisher binding

- **WHEN** metadata points to a declaration on another origin and no accepted channel or configured mapping binds its publisher
- **THEN** the AS SHALL not treat the origin as authentication of `publisher.id`
- **AND** the AS SHALL reject or withhold publisher attribution according to local acceptance policy

### Requirement: Declaration retrieval SHALL be bounded and fail closed

The reference implementation retrieval path SHALL use HTTPS, no redirects, no ambient
credentials, bounded response bytes, time, and retrieval depth, exact source and
revision validation, and fail-closed outcomes. It SHALL NOT automatically fetch
remote schemas. Private or local endpoints SHALL require explicit local
provisioning or onboarding. A universal private-address exclusion list is not a
protocol conformance requirement.

#### Scenario: Retrieval exceeds a bound

- **WHEN** retrieval exceeds the configured bytes, time, or depth bound, or returns a redirect
- **THEN** retrieval SHALL fail closed and SHALL NOT produce an accepted declaration

#### Scenario: Declaration requests a remote schema

- **WHEN** validation would require automatic remote schema retrieval
- **THEN** the AS SHALL reject the declaration rather than fetch the schema

### Requirement: Accepted revisions SHALL be immutable by exact body bytes

An accepted revision SHALL be keyed by its accepted authority binding,
`source.id`, and opaque `declaration_version`. Its content SHALL be the exact
accepted UTF-8 JSON body bytes after HTTP content decoding. Later non-identical
bytes under the same key SHALL be rejected. This requirement SHALL NOT define a
cross-implementation digest, parsed-JSON equivalence, portable cache-key
grammar, rollback framework, or version ordering.

#### Scenario: Same revision returns different bytes

- **WHEN** a later response under the same authority, source ID, and version key has non-identical decoded body bytes
- **THEN** the AS SHALL reject the response and retain the accepted bytes

#### Scenario: Version values are opaque

- **WHEN** two accepted declarations have different `declaration_version` values
- **THEN** the AS SHALL not infer ordering or freshness from those values

### Requirement: Display and parser safety SHALL remain implementation policy

Declaration-provided display values SHALL be escaped for their output context.
Whole-response, parser, and display limits SHALL be implementation policy. This
change SHALL NOT add fixed display `maxLength` numbers to the Source schema.

#### Scenario: Declaration text reaches consent output

- **WHEN** accepted declaration text is rendered or logged
- **THEN** the implementation SHALL escape it for that output context and apply its local limits

### Requirement: Local blocking SHALL not revoke historical grants automatically

An AS MAY locally block a declaration from new consent. That block SHALL NOT
automatically revoke historical grants. Quarantine records and quarantine
workflow are deferred. Grant and consent snapshot semantics remain owned by
their separate Core and Source Declaration contracts.

#### Scenario: Blocked declaration has a historical grant

- **WHEN** a declaration is locally blocked after a historical grant was issued
- **THEN** new consent using that declaration SHALL be blocked
- **AND** the historical grant SHALL not be automatically revoked by this rule

### Requirement: Collection Profile SHALL remain optional

Discovery and trust SHALL consume the Source schema and snapshot without
requiring Collection Profile data. A connector MAY use Collection Profile
semantics, but this change SHALL NOT redefine or require Collection.

#### Scenario: Core-only source is accepted

- **WHEN** an accepted provider-native or pre-collected source has no Collection Profile data
- **THEN** discovery SHALL still be able to accept its declaration

## Explicit exclusions

This change does not define grants, consent snapshots, the Core Source schema,
the Collection Profile, legacy acceptance advertisement, quarantine records or
workflow, cross-implementation digests, parsed-JSON equivalence, cache-key
grammar, rollback, version ordering, federation, or signed declaration
credentials.
