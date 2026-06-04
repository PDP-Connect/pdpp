## ADDED Requirements

### Requirement: Batch consent ceremony SHALL stage multiple source-bounded grant requests under a soft cap

The reference implementation SHALL accept a staged consent request that carries more than one source-bounded `authorization_details[]` entry, up to a reference-contract soft cap, and SHALL present it as one owner ceremony. Each staged entry SHALL carry exactly one source binding; the ceremony SHALL NOT merge entries into a cross-source request. The soft cap and warning threshold SHALL be reference-contract policy constants (default soft cap 8, default warning threshold 6), not protocol limits, and there SHALL be no hard cap. The ceremony SHALL be labeled reference-experimental in the rendered screen, in generated docs/OpenAPI metadata, and in any skill text, until a further OpenSpec change promotes batch consent out of experimental status.

#### Scenario: Client stages several sources in one request

- **WHEN** a client submits a staged request with five source-bounded `authorization_details[]` entries
- **THEN** the reference implementation SHALL render one owner ceremony covering all five sources
- **AND** each entry SHALL retain its single source binding without being merged into a cross-source request.

#### Scenario: Staged entry count crosses the warning threshold

- **WHEN** a client stages a request whose source-bounded entry count is at or above the warning threshold but at or below the soft cap
- **THEN** the ceremony SHALL render a warning that the request is unusually broad
- **AND** the ceremony SHALL still allow the owner to proceed.

#### Scenario: Staged entry count exceeds the soft cap

- **WHEN** a client stages a request whose source-bounded entry count exceeds the soft cap
- **THEN** the reference implementation SHALL flag the request as exceeding the soft cap
- **AND** it SHALL NOT silently truncate the staged entries without telling the owner which sources were affected.

#### Scenario: Ceremony is labeled reference-experimental

- **WHEN** the owner opens the batch consent ceremony
- **THEN** the rendered screen SHALL carry a reference-experimental label
- **AND** the label SHALL also appear in generated docs/OpenAPI metadata describing the ceremony.

### Requirement: Batch consent ceremony SHALL render per-source review with a cumulative-risk header

The ceremony SHALL show one review card per staged source and one aggregated cumulative-risk header summarizing breadth across the whole batch. Each per-source card SHALL show the source, the requested streams, the fields/projection, the time range, the access mode, and a per-card risk indication. The cumulative-risk header SHALL summarize at least the sensitive-source count, the continuous-access count, the no-time-bound count, the no-field-projection count, and the total stream count across the batch.

#### Scenario: Owner reviews a mixed batch

- **WHEN** the owner opens a ceremony staging Gmail, Slack, and a finance source
- **THEN** the ceremony SHALL render one review card per source showing that source's streams, fields/projection, time range, and access mode
- **AND** it SHALL render a cumulative-risk header summarizing sensitive-source, continuous-access, no-time-bound, no-field-projection, and total-stream counts across all three sources.

#### Scenario: Cumulative header reflects maximal access

- **WHEN** the staged batch requests all streams with continuous access and no time bound across more than one source
- **THEN** the cumulative-risk header SHALL show that the approval would create multiple source grants
- **AND** it SHALL show the cumulative continuous-access and no-time-bound counts so the owner can see the aggregate breadth before approving.

### Requirement: Batch consent ceremony SHALL support per-source confirmation and per-source partial approval

The owner SHALL be able to act on each staged source independently before approval: approve, deny, defer ("skip for now"), narrow the time range down, and reduce the stream or field set. The owner SHALL NOT be able to widen any staged entry beyond what the client requested. The authorization server SHALL NOT enrich or widen any staged `authorization_details` entry beyond what the owner reviewed; AS-side narrowing of an over-broad request is permitted.

#### Scenario: Owner approves a subset of staged sources

- **WHEN** the owner approves Gmail and Slack but defers the finance source in one ceremony
- **THEN** the authorization server SHALL issue child grants only for Gmail and Slack
- **AND** it SHALL issue no finance child grant from this ceremony.

#### Scenario: Owner narrows one source before approval

- **WHEN** the owner reduces a staged source's streams from all streams to a single stream before approving
- **THEN** the issued child grant for that source SHALL be bound to the narrowed stream set
- **AND** the ceremony SHALL NOT allow the owner to widen any staged entry beyond the client's request.

#### Scenario: Authorization server does not widen a reviewed entry

- **WHEN** the owner approves the staged sources as reviewed
- **THEN** the authorization server SHALL issue child grants matching what the owner reviewed
- **AND** it SHALL NOT enrich or widen any entry beyond the reviewed scope.

### Requirement: Batch consent ceremony SHALL suppress the approve-all affordance under defined risk conditions

A single "approve all" affordance SHALL NOT appear when the staged batch combines continuous access with all streams, pairs no time bound with a sensitive source, or includes three or more sensitive sources. When the approve-all affordance is shown, it SHALL require one confirmation that re-asserts the per-source list. The default presentation SHALL require per-source confirmation rather than offering approve-all.

#### Scenario: High-risk combination hides approve-all

- **WHEN** the staged batch combines continuous access with all streams on at least one source
- **THEN** the ceremony SHALL NOT render an "approve all" affordance
- **AND** the owner SHALL confirm each source individually.

#### Scenario: Three or more sensitive sources hide approve-all

- **WHEN** the staged batch includes three or more sources whose manifest declares `sensitivity: "sensitive"`
- **THEN** the ceremony SHALL NOT render an "approve all" affordance.

#### Scenario: Approve-all shown for a low-risk batch requires a re-asserting confirmation

- **WHEN** the staged batch does not meet any approve-all suppression condition and the owner uses the approve-all affordance
- **THEN** the ceremony SHALL require one confirmation that re-asserts the per-source list before issuing grants.

### Requirement: Batch consent ceremony SHALL classify source sensitivity from the connector manifest

Connector manifests SHALL be able to declare `sensitivity: "standard" | "sensitive"`. The ceremony SHALL read each staged source's sensitivity from its manifest and SHALL use it for the cumulative-risk header and the approve-all suppression conditions. The reference implementation SHALL NOT hardcode a list of sensitive sources. A source whose manifest does not declare `sensitivity` SHALL be treated as `standard`.

#### Scenario: Manifest declares a sensitive source

- **WHEN** a staged source's connector manifest declares `sensitivity: "sensitive"`
- **THEN** the ceremony SHALL count that source in the cumulative-risk header's sensitive-source count
- **AND** it SHALL apply the sensitive-source approve-all suppression conditions to that source.

#### Scenario: Manifest omits sensitivity

- **WHEN** a staged source's connector manifest does not declare a `sensitivity` value
- **THEN** the ceremony SHALL treat that source as `standard`
- **AND** the reference implementation SHALL NOT consult a hardcoded source list to override that default.

### Requirement: Batch consent approval SHALL issue independent source-bounded child grants

Approving a batch ceremony SHALL issue one independent, source-bounded, individually revocable PDPP grant per approved source. The approval SHALL NOT create a single cross-source grant object. Resource-server per-grant enforcement, grant object shape, and revocation semantics SHALL be unchanged from the single-source flow.

#### Scenario: Approval issues one grant per source

- **WHEN** the owner approves Gmail and Slack in one batch ceremony
- **THEN** the authorization server SHALL create one Gmail-scoped grant and one Slack-scoped grant
- **AND** each grant SHALL remain independently auditable and revocable
- **AND** no single cross-source grant object SHALL be created.

#### Scenario: One issued child grant is revoked

- **WHEN** the owner later revokes the Gmail child grant issued by a batch ceremony
- **THEN** reads against the Gmail source SHALL stop
- **AND** reads against the still-active Slack child grant MAY continue.

### Requirement: Batch consent approval SHALL group issued child grants under a package for audit and timeline

Approval SHALL record a `package_id` that groups the issued child grants. The grant timeline and the dashboard SHALL group the issued child grants by their `package_id`. The `package_id` SHALL be an authorization-server/reference grouping object for audit and routing, not a PDPP grant object carrying source or stream authority. Per-grant revocation SHALL remain primary; grouping SHALL NOT weaken or replace per-grant revocation.

#### Scenario: Timeline groups a batch by package

- **WHEN** the owner opens the grant timeline after approving a batch of three sources
- **THEN** the timeline SHALL group the three issued child grants under one `package_id`
- **AND** each child grant SHALL remain independently inspectable from the grouping.

#### Scenario: Package id carries no source authority

- **WHEN** a package-bound token is introspected by the reference resource server
- **THEN** record access SHALL still be authorized only by active child grants
- **AND** the `package_id` SHALL NOT by itself authorize any source or stream access.

### Requirement: Batch consent revoke-package convenience SHALL dispatch per-child revokes with partial-failure visibility

The reference implementation MAY offer a "revoke package" convenience affordance. When used, it SHALL dispatch one revoke per still-active child grant in the package and SHALL surface partial failure, naming which child grants were revoked and which were not. The convenience affordance SHALL NOT replace per-grant revocation, and SHALL NOT silently report success when one or more child revokes failed.

#### Scenario: Revoke-package succeeds for every child

- **WHEN** the owner uses the revoke-package affordance and every still-active child grant revokes successfully
- **THEN** every child grant in the package SHALL be revoked
- **AND** the affordance SHALL report that every child was revoked.

#### Scenario: Revoke-package partially fails

- **WHEN** the owner uses the revoke-package affordance and one child grant revoke fails while the others succeed
- **THEN** the affordance SHALL report which child grants were revoked and which were not
- **AND** it SHALL NOT report overall success.

### Requirement: Incremental add-source SHALL create a new package linked by parent_package_id

When the same client returns later to add one or more sources, the ceremony SHALL create a new package for the added sources and SHALL link it to the prior package via `parent_package_id`. The dashboard SHALL render a cumulative per-client view across that client's linked packages. The added sources SHALL issue their own independent source-bounded child grants; linkage SHALL NOT widen or re-issue the previously approved grants.

#### Scenario: Client adds a source after the initial ceremony

- **WHEN** a client that previously had a batch package approved returns to add one calendar source
- **THEN** the ceremony SHALL create a new package linked to the prior package via `parent_package_id`
- **AND** it SHALL issue an independent source-bounded calendar child grant without re-issuing the prior child grants.

#### Scenario: Dashboard renders cumulative client access

- **WHEN** the owner opens the dashboard for a client that has more than one linked package
- **THEN** the dashboard SHALL render a cumulative per-client view across the linked packages
- **AND** each child grant SHALL remain independently revocable from that view.

### Requirement: Batch consent ceremony SHALL apply one access mode per package in this tranche

In this tranche, a batch package SHALL apply a single `access_mode` to every child grant it issues. Per-source access-mode mixing within one package SHALL NOT be offered in this tranche. An owner who needs different access modes for different sources SHALL run separate ceremonies.

#### Scenario: Package applies one access mode to all children

- **WHEN** the owner chooses an access mode for a batch package
- **THEN** every child grant issued by that package SHALL carry the chosen access mode
- **AND** the ceremony SHALL NOT offer a per-source access-mode control within the package.
