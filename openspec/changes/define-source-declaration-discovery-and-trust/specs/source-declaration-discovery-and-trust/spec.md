# Source Declaration discovery and trust

## ADDED Requirements

### Requirement: Provider-native discovery SHALL bind the accepted resource and declaration

For an already onboarded provider-native protected-resource identifier, that
identifier SHALL be an HTTPS URL without a fragment or user information and
SHOULD NOT contain a query component. The AS SHALL form the RFC 9728 metadata URL by inserting
`/.well-known/oauth-protected-resource` between the host component and any path
or query components. When a path or query is present, it SHALL remove the
terminating slash following the host before insertion. The AS SHALL retrieve
that URL with HTTP `GET`. The returned metadata `resource` member SHALL be
identical to the protected-resource identifier used to form that URL. The
metadata extension `pdpp_source_declaration_uri` SHALL be one HTTPS URI string
with no fragment or user information when the protected resource is being
onboarded as a provider-native source. The extension MAY be absent from generic
protected-resource metadata for resources that do not map to one Source
Declaration. PDPP SHALL require
`SourceDeclaration.source.id` to equal the accepted protected-resource
identifier under the Source Declaration contract. The AS SHALL consume the
Source schema and accepted snapshot defined by that contract and SHALL fail
closed on any mismatch.

#### Scenario: Metadata points to the matching declaration

- **WHEN** accepted metadata contains a valid extension and the declaration's source ID equals the protected resource under the required comparison
- **THEN** the AS SHALL accept the declaration for validation and consent

#### Scenario: Provider-native metadata extension is invalid

- **WHEN** provider-native onboarding metadata has an extension that is missing,
  not one HTTPS URI string, contains a fragment, or contains user information
- **THEN** discovery SHALL fail closed before declaration use

#### Scenario: Generic metadata has no declaration pointer

- **WHEN** a generic personal-server or hosted MCP protected resource does not map to one Source Declaration
- **THEN** its RFC 9728 metadata MAY omit `pdpp_source_declaration_uri`

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

This is explicit PDPP policy responding to authority substitution and SSRF
threats. It does not claim that RFC 9728 requires this connector/community
onboarding model.

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
store resource authority and publisher attribution separately. Without that
authentication, the declared publisher SHALL remain a non-authoritative claim
and SHALL NOT be used for attribution, source acceptance, redirect approval,
or any other trust decision.

#### Scenario: Cross-origin declaration host lacks a publisher binding

- **WHEN** metadata points to a declaration on another origin and no accepted channel or configured mapping binds its publisher
- **THEN** the AS SHALL not treat the origin as authentication of `publisher.id`
- **AND** the declared publisher SHALL remain non-authoritative and unusable for trust decisions

### Requirement: Declaration retrieval SHALL be bounded and fail closed

The AS declaration retriever SHALL use HTTPS, no ambient credentials, bounded
response bytes, time, and retrieval depth, exact source and revision
validation, and fail-closed outcomes. Redirect handling SHALL follow a local
policy: every redirect target and the final declaration URL SHALL satisfy
the accepted pointer and configured redirect policy. The policy MAY reject all
redirects. For each connection attempt, including every redirect hop, the
retriever SHALL perform a fresh DNS resolution, SHALL validate every resolved
address against the applicable network policy before connecting, and SHALL
connect only to an address from that validated result while preserving the
destination authority for TLS authentication. An earlier DNS result SHALL NOT
authorize a later address. The retrieved `SourceDeclaration.source.id` SHALL be
validated separately against the accepted protected-resource identifier. These
are PDPP retrieval rules, not RFC 9728 redirect rules. The AS SHALL NOT
automatically fetch remote schemas. Private or local endpoints SHALL require
explicit local provisioning or onboarding that supplies the applicable network
policy. A universal private-address exclusion list is not a protocol
conformance requirement.

#### Scenario: Retrieval exceeds a bound or fails redirect policy

- **WHEN** retrieval exceeds the configured bytes, time, or depth bound, or a
  redirect target, final declaration URL, DNS result, or resolved address fails
  the applicable policy
- **THEN** retrieval SHALL fail closed and SHALL NOT produce an accepted declaration

#### Scenario: DNS changes between connection attempts

- **WHEN** a destination resolves again for a redirect hop or later connection attempt
- **THEN** every newly resolved address SHALL pass the applicable network policy before connection
- **AND** an address accepted for an earlier connection SHALL NOT authorize the new result

#### Scenario: Declaration requests a remote schema

- **WHEN** validation would require automatic remote schema retrieval
- **THEN** the AS SHALL reject the declaration rather than fetch the schema

### Requirement: Accepted revisions SHALL be immutable by validated parsed content

An accepted revision SHALL be keyed by its accepted authority binding,
`source.id`, and opaque `declaration_version`. After JSON parsing and
validation, later content under the same key SHALL compare equal as parsed
JSON. An implementation MAY use an internal content fingerprint to accelerate
that comparison, but its algorithm SHALL NOT be a protocol identity or
cross-implementation digest. A different parsed document under the same key
SHALL be rejected as equivocation. A current pointer to a prior revision SHALL
be accepted or rejected only under explicit publisher or local policy; the AS
SHALL NOT infer ordering or freshness from `declaration_version`.

#### Scenario: Same revision returns different parsed JSON

- **WHEN** a later response under the same authority, source ID, and version key parses to a different JSON value
- **THEN** the AS SHALL reject the response as equivocation
- **AND** it SHALL retain the accepted parsed content

#### Scenario: Version values are opaque

- **WHEN** two accepted declarations have different `declaration_version` values
- **THEN** the AS SHALL not infer ordering or freshness from those values

#### Scenario: Current pointer returns a prior revision

- **WHEN** a current pointer names a previously accepted revision
- **THEN** the AS SHALL apply the explicit publisher or local rollback policy
- **AND** it SHALL not infer acceptance or rejection from opaque version ordering

### Requirement: Display and parser safety SHALL remain implementation policy

Declaration-provided display values SHALL be escaped for their output context.
The implementation SHALL define configured whole-response, parser, and display
maxima. A value over its configured maximum SHALL be rejected before consent
rendering or logging. This change SHALL NOT add fixed display `maxLength`
numbers to the Source schema.

#### Scenario: Declaration text reaches consent output

- **WHEN** accepted declaration text is rendered or logged
- **THEN** the implementation SHALL escape it for that output context
- **AND** the implementation SHALL reject it when it exceeds the configured maximum for that display field

### Requirement: Current query capability SHALL not widen issued grants

Current SourceDeclaration query capability, including expansion capability, is
separate from issued-grant rights. Unless the Source Declaration contract
explicitly makes expansion an authorization constraint, current expansion SHALL
not widen the streams or fields in an issued grant. This change consumes that
contract and does not redefine it.

#### Scenario: Current expansion is broader than an issued grant

- **WHEN** a later declaration advertises expansion that reaches a stream or
  field absent from an existing grant
- **THEN** the current capability SHALL not authorize that stream or field
  under the issued grant

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

This change depends on the Source Declaration contract for `SourceDeclaration`,
accepted snapshots, and declaration-defined authorization constraints. It does
not duplicate those requirements. This change does not define grants, consent
snapshots, the Core Source schema, the Collection Profile, quarantine records
or workflow, cross-implementation digests, cache-key grammar, version ordering,
federation, or signed declaration credentials.
