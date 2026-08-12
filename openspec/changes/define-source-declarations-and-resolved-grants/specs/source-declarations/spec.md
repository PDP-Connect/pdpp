# Source Declarations and Resolved Grants

## MODIFIED Requirements

### Requirement: Core defines one independent SourceDeclaration

Core SHALL define one complete `SourceDeclaration` shape for `connector` and
`provider_native`. Its public JSON Schema SHALL declare the JSON Schema
2020-12 dialect. `streams[].schema` SHALL default to JSON Schema 2020-12 when
`$schema` is absent, and a present `$schema` SHALL name
`https://json-schema.org/draft/2020-12/schema`. This dialect declaration SHALL
NOT by itself claim identical validation behavior across implementations. The
AS SHALL meta-validate every embedded stream schema. Embedded `$ref` and
`$dynamicRef` values SHALL be local fragment references so a retained
declaration does not depend on mutable remote schema content.

The declaration SHALL include `protocol_version`, `source`,
`declaration_version`, `publisher`, `display`, and `streams`, with optional
`selection_presets` and `extensions`. `source` SHALL contain exactly `kind`
and `id`. `protocol_version` SHALL be `0.1.0`. Every stream
SHALL contain a unique non-empty non-wildcard `name`, `semantics`, `schema`, unique non-empty
`primary_key`, and `selection`; it MAY contain `description`, `display`,
`cursor_field`, `consent_time_field`, `views`, `relationships`, and `query`.
These members SHALL retain Core's consent, record, selection, and Resource
Server capability semantics for both source kinds. A declaration SHALL NOT
put owner-specific instance handles at source level. Instance handles belong
to per-stream request and grant scope, and the AS SHALL validate their
eligibility there. The complete member and omission rules are defined in the
design for this change.

Each selection preset SHALL NOT contain the same stream name more than once.
Duplicate stream names inside one preset SHALL make the SourceDeclaration
invalid.

`extensions`, when present, SHALL be an object keyed by collision-resistant
profile URIs. Each profile SHALL own its entire value. Core SHALL NOT parse or
validate a profile-owned value. An operation that requires an unsupported
profile SHALL reject the operation. A profile SHALL NOT redefine or weaken a
Core member. In declarations and grants, `source.kind` SHALL be AS-derived
provenance and authority-class metadata. In requests, `source.kind` MAY be
omitted. If present, it SHALL be a client trust expectation that must match
the accepted declaration provenance before consent. It SHALL NOT be
authorization equality, a runtime type, or a Collection-conformance claim.
It SHALL NOT select runtime.
`source.id` SHALL be the authorization identity. Core SHALL require an
absolute URI and SHALL reject local, storage, or instance keys, but SHALL NOT
reject an absolute URI merely because it resembles a package coordinate.
Trusted allocation and publisher authority belong to the Discovery Contract PR. A connector-kind declaration
without a Collection extension SHALL remain Core-usable. Core SHALL NOT parse
or interpret a profile-owned extension value.
Connector acquisition and execution terms, including runtime bindings, setup,
interaction, refresh, and collection state, SHALL remain outside these Core
stream members and MAY appear only in a Collection-owned extension.

#### Scenario: Connector Core declaration has no Collection extension

- **WHEN** Core receives a valid connector declaration with no Collection extension
- **THEN** it SHALL validate the declaration, render consent, issue grants, and
  support grant-filtered serving without Collection schema or runtime modules

#### Scenario: Source kind is retained as provenance

- **WHEN** two declarations have the same `source.id` and matching selected
  declaration metadata but their runtime fulfillment differs
- **THEN** authorization equality SHALL use `source.id`
- **AND** `source.kind` SHALL remain provenance metadata rather than runtime or
  Collection conformance

#### Scenario: Preset contains a duplicate stream name

- **WHEN** a SourceDeclaration selection preset lists the same stream name more
  than once
- **THEN** SourceDeclaration validation SHALL reject the declaration before any
  grant is resolved

### Requirement: Source identity and source instance scope are explicit

`source.id` SHALL be an absolute URI identifying the authorization and data
surface. It SHALL NOT be a local key, storage key, runtime identity,
account identifier, credential, or instance handle. Source instance handles in
requests and grants SHALL be opaque and scoped to issuer, subject, `source.id`,
and stream.
Handles SHALL NOT be inferred across streams.

Core `resource_ref` values SHALL identify the referenced source with
`source_id`. They SHALL NOT use the connector-only `connector_id` name because
the referenced source may be connector-backed or provider-native.

A selection request stream MAY contain `instance_ids`, and every approved
grant stream SHALL contain a required unique non-empty `instance_ids` array.
The AS SHALL validate each handle for the issuer, subject, source ID, and that
stream. Omission in a request stream SHALL resolve only when exactly one
eligible instance exists for that stream. It SHALL never mean fan-in. Fan-in
SHALL be represented only by explicitly listing multiple handles on the
approved stream. SourceDeclaration and request source objects SHALL contain no
instance IDs.

#### Scenario: Existing per-stream connection identity is not reinterpreted

- **WHEN** current serving data addresses a stream with `streams[].connection_id`
- **THEN** new authorization SHALL resolve explicit eligible `instance_ids`
- **AND** it SHALL NOT reinterpret the legacy connection value as authorization

#### Scenario: Provider-native records use cross-stream references

- **WHEN** a provider-native record refers to a record from another source on
  the same Resource Server
- **THEN** its `resource_ref.source_id` SHALL contain that source's absolute
  authorization identity
- **AND** the reference SHALL NOT require a connector identity

#### Scenario: Ambiguous source instance selection is rejected

- **WHEN** more than one eligible handle exists and a request stream omits
  `instance_ids`
- **THEN** the AS SHALL require an explicit owner choice or reject the request
- **AND** it SHALL not authorize fan-in

### Requirement: Request and resolved grant shapes are complete

A request SHALL contain `type`, `source`, `purpose_code`, `access_mode`, and
exactly one of `streams` or `selection_preset`; optional members SHALL be
limited to `purpose_description`, `retention`, and `client_claims`, apart from
the selected `streams` or `selection_preset` member. A request source SHALL
contain required `id` and optional `kind`. Request stream members SHALL be `name`,
optional `necessity`, `instance_ids`, `fields`, `view`, `time_range`, and
`resources`; `fields` and `view` SHALL be mutually exclusive. Wildcards SHALL
be request-only. Explicit request stream names SHALL be unique, and a wildcard
entry SHALL be the only stream entry in its request.

A resolved grant SHALL retain the existing Core grant shape, its `version`
SHALL be `0.1.0`, and it SHALL contain
`version`, `grant_id`, `issued_at`, `subject`, `client`, `source`,
`source_declaration`, `purpose_code`, `access_mode`, and `streams`, with
optional `purpose_description`, `retention`, `selection_preset`, and
`expires_at`. OAuth issuer and audience SHALL remain binding-context facts
owned by PR89. The approved grant source SHALL contain exactly `kind` and `id`.
Every grant stream SHALL contain a unique concrete `name`, unique non-empty
`instance_ids`, and unique non-empty `fields`. It MAY contain
`time_constraint` and `resources`. `time_constraint`, when present, SHALL
contain exact `field` and at least one of `since` or `until`; `resources`, when
present, SHALL be unique non-empty canonical primary-key strings. Omission
means no constraint and never means future declaration expansion.

The AS SHALL resolve omitted instance IDs before the final approval surface is
shown. It SHALL bind exact resolved instances and all final decision fields to
an immutable review revision or digest before final approval. Those decision
fields SHALL include source, stream names, fields, resources, temporal field
and bounds, purpose, retention, client identity, and expiry. If `client_claims`
are rendered to the owner, the final approval artifact and review revision
SHALL also bind the normalized exact claims with client attribution. Retained
consent evidence SHALL preserve that binding. `client_claims` SHALL remain
outside authorization equality, resolved grant rights, and RS enforcement. If
instance eligibility or the reviewed revision becomes stale before approval,
the AS SHALL reject approval and require a new review. The AS SHALL resolve and
freeze stream names, fields, source ID, subject, client, every approved
per-stream instance set, temporal field and bounds, and resources from one
declaration snapshot. Grant authorization equality SHALL use source ID, not
source kind.
A request that violates this request contract SHALL produce the binding-neutral
Source validation failure `source.authorization_details_invalid`. The binding
SHALL own its protocol response mapping.

#### Scenario: Issuance materializes all authorization facts

- **WHEN** a request uses a wildcard, preset, view, omitted fields, or omitted
  eligible per-stream instance IDs
- **THEN** the issued grant SHALL contain concrete stream names, non-empty
  fields, and a non-empty approved instance set on every stream
- **AND** it SHALL not retain those convenience forms as continuing authority

#### Scenario: Stale review revision is rejected

- **WHEN** a final review artifact resolved omitted instance IDs and the
  eligible instance set or reviewed revision changes before approval
- **THEN** approval SHALL fail closed
- **AND** the owner SHALL review the exact resolved decision again before a
  grant can be issued

#### Scenario: Client-authored claims are retained as consent context

- **WHEN** the AS renders `client_claims` on the final owner review surface
- **THEN** the final approval artifact and immutable review revision SHALL bind
  the normalized exact claims with client attribution
- **AND** retained consent evidence SHALL preserve that binding
- **AND** the issued grant SHALL NOT treat those claims as granted rights or RS
  enforcement input

#### Scenario: Time constraint is frozen

- **WHEN** a request has a temporal constraint
- **THEN** the grant SHALL contain the exact snapshot-resolved time field and at
  least one unchanged bound
- **AND** a current declaration time-field change SHALL not reinterpret it

#### Scenario: Invalid selection details produce a neutral failure

- **WHEN** a request violates the Source request shape or narrowing rules
- **THEN** Source validation SHALL fail with
  `source.authorization_details_invalid`
- **AND** Source SHALL not prescribe the binding's protocol response

### Requirement: One snapshot and mutation barriers govern issuance

The AS SHALL use one exact immutable declaration snapshot for request
validation, consent display, narrowing, resolution, issuance, and retained
consent evidence. Tests SHALL mutate, delete, and same-version-replace the
current catalog entry before display, narrowing, and issuance and prove that
each phase still uses the retained snapshot. A version label alone SHALL not
substitute for the snapshot.

#### Scenario: Declaration changes between phases

- **WHEN** the declaration is mutated, deleted, or replaced with a different
  value under the same version between any barrier
- **THEN** display, narrowing, issuance, and evidence SHALL continue to use
  the retained snapshot
- **AND** the AS SHALL fail closed rather than refetch if the retained snapshot
  is unavailable

### Requirement: RS authorization is independent of current declarations

The RS SHALL enforce solely from the resolved authorization context. It MAY
consult current serving metadata only for routing and to describe currently
served schemas or query capabilities, and only to narrow or reject. It SHALL
not reinterpret canonical resource keys, widen or reinterpret a grant, look up
a current declaration to obtain its time field, resolve a preset or view, or
turn absent instance IDs into fan-in.
The retained snapshot SHALL be evidence and audit material, not a current
declaration lookup.

For a client-token records request, the RS SHALL reject a query-time `view`
parameter. A client SHALL request explicit `fields`, or rely on the field
projection already frozen into the grant. Owner-token reads MAY resolve a
current view because they are current-capability requests, not grant
reinterpretation.

In v0.1, client-token reads SHALL also reject every request-time `filter[...]`
parameter, including exact `filter[field]` and range
`filter[field][gte|gt|lte|lt]` forms. The rejection SHALL occur before the RS
consults current SourceDeclaration or serving metadata, and SHALL use HTTP 400
`invalid_request`. Owner-token current-capability reads MAY retain exact and
declaration-driven range filters against current serving metadata.

#### Scenario: Current serving metadata changes

- **WHEN** the current declaration or serving metadata changes after grant
  issuance
- **THEN** the RS SHALL make the same authorization decision from the grant
  unless lifecycle or serving capability requires rejection
- **AND** it SHALL not broaden the decision using current metadata

### Requirement: Grant-scoped and current metadata are distinct

Client-token schema, stream, search, and record metadata SHALL be projected
from the resolved grant. It SHALL expose only granted streams and fields and
the frozen temporal and source-instance constraints relevant to that surface.
It SHALL NOT present current declaration additions as though the client is
authorized to use them. Owner-token and discovery/catalog metadata MAY expose
the current declaration and current serving capabilities, but SHALL identify
them as current capability and SHALL NOT use them as authority for a client
grant.

#### Scenario: Client schema excludes a newly declared field

- **WHEN** a current declaration adds a field after a client grant was issued
- **THEN** a client-token schema or stream metadata response SHALL omit that
  field from the grant projection
- **AND** an owner or discovery response MAY show the field as current
  capability

#### Scenario: Current metadata cannot replace a grant projection

- **WHEN** an RS route can read current declaration metadata while serving a
  client-token request
- **THEN** it MAY use that metadata for routing or reject an unsupported
  resolved constraint
- **AND** it SHALL NOT replace the grant projection, resolve a current view, or
  authorize a field absent from the grant

#### Scenario: Client-token reads reject query-time views

- **WHEN** a client-token records request includes `view`
- **THEN** the RS SHALL reject the request with `invalid_request`
- **AND** the RS SHALL NOT resolve the named view from current metadata

#### Scenario: Client-token reads reject exact and range filters before metadata

- **WHEN** a client-token request includes `filter[field]=value` or
  `filter[field][op]=value`
- **THEN** the RS SHALL reject the request with HTTP 400 `invalid_request`
- **AND** the RS SHALL reject it before consulting current SourceDeclaration
  or serving metadata
- **AND** the RS SHALL NOT advertise typed exact or range filter capabilities
  in client grant metadata

#### Scenario: Owner reads retain current filters

- **WHEN** an owner-token current-capability read includes an exact or declared
  range `filter[...]`
- **THEN** the RS MAY validate and apply that filter against current serving
  metadata
- **AND** this owner behavior SHALL NOT make the filter available to
  client-token reads

### Requirement: Collection mechanisms are outside Core conformance

Core SHALL NOT normatively define Collection Profile POST ingest endpoints,
state endpoints, grant-scoped collection state, concurrent collection
coordination, or Collection conformance tiers. Those mechanisms and tiers SHALL
be specified in `spec-collection-profile.md` and SHALL apply only to an
implementation that claims Collection Profile support. Core grant, record, and
read-query conformance SHALL be testable with pre-collected or provider-native
data and no Collection runtime, ingest route, state store, or concurrent-run
controller.

#### Scenario: Core-only conformance has no Collection dependency

- **WHEN** a Core implementation validates a declaration, issues a grant, and
  serves pre-collected or provider-native records
- **THEN** its conformance tests SHALL NOT require POST ingest, Collection state,
  grant-scoped collection state, concurrent collection, or a Collection tier

#### Scenario: Collection support is claimed separately

- **WHEN** an implementation claims Collection Profile support
- **THEN** its ingest, state, grant-scoped state, concurrent collection, and
  conformance-tier behavior SHALL be tested under `spec-collection-profile.md`
- **AND** those requirements SHALL NOT become prerequisites for Core

### Requirement: Pre-v0.1 authorization state fails closed

After this change, the implementation SHALL approve only pending consent that
contains the retained SourceDeclaration snapshot and SHALL serve only the
closed resolved grant shape. Pre-v0.1 pending consent, grants, and packages
SHALL require fresh consent. The implementation SHALL NOT add a projection
column, historical reconstruction, or legacy authorization adapter.

#### Scenario: Legacy authorization is encountered

- **WHEN** approval or serving encounters a pre-v0.1 row or a grant stream that
  uses `connection_id` instead of required `instance_ids`
- **THEN** it SHALL reject that authorization state
- **AND** it SHALL NOT infer authorization from current declarations or connections

### Requirement: Ownership boundaries are explicit

This change SHALL be delivered through five PRs: Source Contract, Source RI,
PR89 Auth Carrier, Discovery Contract, and Discovery RI. The contract PRs
SHALL define protocol behavior separately from reference implementation
adoption. Source RI SHALL own snapshot retention, co-located enforcement, and
the Core dependency oracle. PR89 SHALL own the binding-neutral approved
authorization context and OAuth/RAR response and introspection carrier without
defining a second grant shape. Discovery Contract SHALL own declaration
retrieval and trust semantics. Discovery RI SHALL implement those semantics
without making discovery a runtime RS enforcement dependency.

Source Contract SHALL merge before Source RI. Source RI SHALL merge before
PR89's separated-RS conformance claim. Discovery Contract SHALL stack on
Source Contract, and Discovery RI SHALL stack on Discovery Contract and Source
RI. PR89 SHALL pass the response-only enforcement vectors before any separated
deployment claims the new authorization context. Discovery SHALL NOT change
grant-right interpretation. Collection work SHALL remain outside these merge
gates.

#### Scenario: Core dependency oracle runs

- **WHEN** the Core-only oracle validates and exercises a connector declaration
- **THEN** its dependency graph SHALL import no Collection schema or runtime
  module
- **AND** the declaration SHALL remain usable without an extension value

#### Scenario: Native and connector sources share query and consent semantics

- **WHEN** equivalent connector and provider-native declarations expose the
  same streams, selection capabilities, views, relationships, and query support
- **THEN** Core SHALL validate and interpret those members identically
- **AND** neither source kind SHALL require Collection execution metadata

#### Scenario: PR ownership prevents a second grant shape

- **WHEN** PR89 carries resolved authorization across an OAuth binding
- **THEN** it SHALL transport the Source Contract resolved grant without
  redefining SourceDeclaration or creating a parallel selection model
- **AND** discovery or Collection changes SHALL NOT be required for Source
  RI's co-located Core conformance
