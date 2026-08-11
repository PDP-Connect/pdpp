# Source Declarations and Resolved Grants

## MODIFIED Requirements

### Requirement: Core defines one independent SourceDeclaration

Core SHALL define one complete `SourceDeclaration` shape for `connector` and
`provider_native`. Its public JSON Schema SHALL declare the JSON Schema
2020-12 dialect. `streams[].schema` SHALL default to JSON Schema 2020-12 when
`$schema` is absent, and a present `$schema` SHALL name
`https://json-schema.org/draft/2020-12/schema`. This dialect declaration SHALL
NOT by itself claim identical validation behavior across implementations.

The declaration SHALL include `protocol_version`, `source`,
`declaration_version`, `publisher`, `display`, and `streams`, with optional
`selection_presets` and `extensions`. `source` SHALL contain exactly `kind`
and `id`. Every stream
SHALL contain a unique non-empty `name`, `schema`, unique non-empty
`primary_key`; it MAY contain `consent_time_field`. A declaration SHALL NOT
put owner-specific instance handles at source level. Instance handles belong
to per-stream request and grant scope, and the AS SHALL validate their
eligibility there. The complete member and omission rules are defined in the
design for this change.

`source.kind` SHALL be provenance and authority-class metadata. It SHALL NOT
be authorization equality, a runtime type, or a Collection-conformance claim.
`source.id` SHALL be the authorization identity. A connector-kind declaration
without a Collection extension SHALL remain Core-usable. Core SHALL NOT parse
or interpret a profile-owned extension value.

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

### Requirement: Source identity and stream instance scope are explicit

`source.id` SHALL be an absolute URI identifying the authorization and data
surface. It SHALL NOT be a package coordinate, storage key, runtime identity,
account identifier, credential, or instance handle. Request and grant stream
handles SHALL be opaque and scoped to issuer, subject, `source.id`, and stream.
Handles SHALL NOT be inferred across streams.

A selection request MAY contain `streams[].instance_ids`, but an approved
stream in a resolved grant SHALL contain a required unique non-empty
`instance_ids` array. The AS SHALL validate eligibility for the issuer,
subject, source ID, and stream. Omission in a request SHALL never mean fan-in.
Fan-in SHALL be represented only by explicitly listing multiple handles in
that stream's approved array.

#### Scenario: Existing per-stream connection identity is preserved

- **WHEN** current serving data addresses a stream with `streams[].connection_id`
- **THEN** migration SHALL preserve that value as the candidate handle for the
  same stream
- **AND** it SHALL not move the handle to a source-wide field

#### Scenario: Ambiguous instance selection is rejected

- **WHEN** more than one eligible handle exists and the request omits
  `instance_ids`
- **THEN** the AS SHALL require an explicit owner choice or reject the request
- **AND** it SHALL not authorize fan-in

### Requirement: Request and resolved grant shapes are complete

A request SHALL contain `type`, `source`, `purpose_code`, `access_mode`, and
exactly one of `streams` or `selection_preset`; optional members SHALL be
limited to `purpose_description`, `retention`, and `client_claims`, apart from
the selected `streams` or `selection_preset` member. A request source SHALL contain
exactly `kind` and `id`. Request stream
members SHALL be `name`, optional `necessity`, `instance_ids`, `fields`,
`view`, `time_range`, and `resources`; `instance_ids`, when present, SHALL be
unique and non-empty, and `fields` and `view` SHALL be mutually exclusive.
Wildcards SHALL be request-only.

A resolved grant SHALL retain the existing Core grant shape and SHALL contain
`version`, `grant_id`, `issued_at`, `subject`, `client`, `source`,
`source_declaration`, `purpose_code`, `access_mode`, and `streams`, with
optional `purpose_description`, `retention`, `selection_preset`, and
`expires_at`. OAuth issuer and audience SHALL remain binding-context facts
owned by PR89. Every grant stream SHALL contain concrete `name`, unique
non-empty `instance_ids`, and unique non-empty `fields`. It MAY contain
`time_constraint` and `resources`. `time_constraint`, when present, SHALL
contain exact `field` and at least one of `since` or `until`; `resources`, when
present, SHALL be unique non-empty canonical primary-key strings. Omission
means no constraint and never means future declaration expansion.

The AS SHALL resolve and freeze stream names, fields, source ID, subject,
client, eligible handles, temporal field and bounds, and resources
from one declaration snapshot. Grant authorization equality SHALL use source
ID, not source kind.
A request that violates this request contract SHALL produce the binding-neutral
Source validation failure `source.authorization_details_invalid`. The binding
SHALL own its protocol response mapping.

#### Scenario: Issuance materializes all authorization facts

- **WHEN** a request uses a wildcard, preset, view, omitted fields, or omitted
  eligible instance IDs
- **THEN** the issued grant SHALL contain concrete stream names, non-empty
  fields, and per-stream non-empty instance IDs
- **AND** it SHALL not retain those convenience forms as continuing authority

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

- **WHEN** the declaration is mutated, deleted, or replaced with different bytes
  under the same version between any barrier
- **THEN** display, narrowing, issuance, and evidence SHALL continue to use
  the retained snapshot
- **AND** the AS SHALL fail closed rather than refetch if the retained snapshot
  is unavailable or fails integrity checks

### Requirement: RS authorization is independent of current declarations

The RS SHALL enforce solely from the resolved authorization context. It MAY
consult current serving metadata only for routing and to describe currently
served schemas or query capabilities, and only to narrow or reject. It SHALL
not reinterpret canonical resource keys, widen or reinterpret a grant, look up
a current declaration to obtain its time field, resolve a preset or view, or
turn absent instance IDs into fan-in.
The retained snapshot SHALL be evidence and audit material, not a current
declaration lookup.

#### Scenario: Current serving metadata changes

- **WHEN** the current declaration or serving metadata changes after grant
  issuance
- **THEN** the RS SHALL make the same authorization decision from the grant
  unless lifecycle or serving capability requires rejection
- **AND** it SHALL not broaden the decision using current metadata

### Requirement: Persisted-data migration preserves evidence and ambiguity

Migration SHALL cover pending consent, grants, packages, current per-stream
`connection_id`, and absent or ambiguous connection mappings. It SHALL preserve
original bytes as evidence and write a separate resolved projection. It SHALL
map a legacy connection ID only after issuer, subject, source ID, stream, and
eligibility match. An absent or ambiguous mapping SHALL remain unresolved and
SHALL never map to current fan-in.
The local legacy adapter SHALL NOT relax this rule. It SHALL reject any stream
without an unambiguous issuer, subject, source ID, stream, and instance mapping.

#### Scenario: Legacy mapping is absent

- **WHEN** a pending consent, grant, or package has no unambiguous per-stream
  connection mapping
- **THEN** migration SHALL preserve the original bytes and mark the projection
  unresolved or reject it
- **AND** it SHALL not issue or serve a grant by selecting all current instances

#### Scenario: Legacy mode does not restore implicit fan-in

- **WHEN** local legacy mode loads a stream without an unambiguous instance mapping
- **THEN** the adapter SHALL fail closed and preserve the original bytes
- **AND** it SHALL not select one or more current instances

### Requirement: Ownership boundaries are explicit

Source SHALL own the neutral declaration, request, grant, snapshot, migration
contract, and Core dependency oracle. PR89 SHALL own the OAuth carrier for
resolved facts. Discovery SHALL own retrieval and publisher trust. Collection
work in this change SHALL be limited to reference relocation and compatibility;
Collection execution, state, retrieval, and conformance semantics SHALL remain
outside Core.

#### Scenario: Core dependency oracle runs

- **WHEN** the Core-only oracle validates and exercises a connector declaration
- **THEN** its dependency graph SHALL import no Collection schema or runtime
  module
- **AND** the declaration SHALL remain usable without an extension value
