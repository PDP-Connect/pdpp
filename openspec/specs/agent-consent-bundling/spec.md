# agent-consent-bundling Specification

## Purpose
Define reference-implementation semantics for agent consent ceremonies that bundle owner approval across multiple configured data connections without turning that bundle into a cross-source PDPP grant.
## Requirements
### Requirement: Hosted MCP broad approval SHALL issue source-bounded child grants

When the reference hosted MCP flow lets an owner approve multiple sources in one ceremony, the authorization server SHALL issue one independent source-bounded PDPP grant per approved source and SHALL NOT issue a single cross-source PDPP grant.

#### Scenario: Owner approves multiple sources

- **WHEN** an owner approves Gmail and Slack in one hosted MCP authorization ceremony
- **THEN** the authorization server SHALL create one Gmail-scoped grant and one Slack-scoped grant
- **AND** each grant SHALL remain independently auditable and revocable.

#### Scenario: Owner denies one source

- **WHEN** an owner selects Gmail but not Slack in a hosted MCP authorization ceremony
- **THEN** the authorization server SHALL issue no Slack child grant
- **AND** the MCP client SHALL NOT receive access to Slack records through the package.

### Requirement: Grant packages SHALL NOT be PDPP grants

A grant package SHALL be an authorization-server/reference grouping object for client token routing and audit, not a PDPP grant object carrying source or stream authority.

#### Scenario: Package token is introspected

- **WHEN** a package-bound hosted MCP token is introspected by the reference resource server
- **THEN** the token SHALL identify its grant package
- **AND** record access SHALL still be authorized only by active child grants.

### Requirement: Broad hosted MCP consent SHALL make cumulative risk legible

The hosted MCP consent ceremony for multiple sources SHALL show the owner cumulative breadth before approval.

#### Scenario: Multiple selected sources include maximal access

- **WHEN** the hosted MCP ceremony asks for all streams with continuous access across more than one source
- **THEN** the consent page SHALL show that the approval creates multiple source grants
- **AND** it SHALL show enough source/stream summary for the owner to understand the cumulative scope.

### Requirement: Hosted MCP consent SHALL distinguish configured connections

When a connector has more than one configured owner connection, the hosted MCP consent ceremony SHALL present the configured connection as the owner-facing selectable unit and SHALL preserve the selected connection binding on the issued child grant.

#### Scenario: Multiple Codex connections exist

- **WHEN** an owner has more than one active Codex connection
- **THEN** the hosted MCP consent page SHALL show owner-facing connection names and stable connection identifiers
- **AND** approving one Codex connection SHALL bind the child grant to that connection instance rather than an arbitrary Codex default.

#### Scenario: A package selector is ambiguous

- **WHEN** a package contains more than one child grant for the same connector type
- **THEN** connector-type selectors SHALL NOT silently choose one child grant
- **AND** the MCP read path SHALL require a source key, source token, or connection identifier that resolves to exactly one child grant.

### Requirement: Package revocation SHALL preserve child-grant control

The reference implementation SHALL support disabling a hosted MCP grant package without removing the ability to audit and revoke child grants individually.

#### Scenario: One child grant is revoked

- **WHEN** the owner revokes one child grant in a package
- **THEN** package reads for that source SHALL stop
- **AND** package reads for still-active child grants MAY continue.

#### Scenario: Package is revoked

- **WHEN** the owner revokes the package
- **THEN** package-bound access and refresh tokens SHALL stop working
- **AND** the implementation MAY offer a convenience action to revoke every still-active child grant.

### Requirement: Hosted MCP reads SHALL preserve REST read semantics

The hosted MCP adapter SHALL route read tools through the same scoped-token REST resource-server semantics rather than defining independent MCP-only query behavior.

#### Scenario: MCP search selects a REST search mode

- **WHEN** an MCP client calls `search` with `mode=hybrid`
- **THEN** the adapter SHALL route through the REST hybrid search endpoint
- **AND** it SHALL forward supported structured query parameters using the same nested REST query shape.

#### Scenario: A package token searches across children

- **WHEN** a package-bound MCP token searches across multiple child grants
- **THEN** each child read SHALL use the same REST endpoint selected by the MCP adapter
- **AND** each result SHALL remain source-qualified.

### Requirement: Hosted MCP connection presentation SHALL use shared connector identity

The hosted MCP consent picker SHALL use the reference implementation's shared connector identity equivalence helper when suppressing stale legacy local collector aliases or grouping equivalent connector ids.

#### Scenario: Legacy local collector alias has a canonical dataful connection

- **WHEN** both a legacy local collector connector id and its canonical connector id are registered
- **AND** the canonical connector has a dataful configured connection
- **THEN** the hosted MCP picker SHALL NOT show a stale zero-record legacy duplicate as a separate owner-facing source.

### Requirement: Grant packages SHALL be visible to the operator

The reference implementation SHALL expose grant packages to the operator console as a first-class artifact that the operator can list, inspect, and revoke without per-child manual revocation.

#### Scenario: Operator opens the package list

- **WHEN** the operator visits the package list surface on the operator console
- **THEN** the surface SHALL render every grant package issued on the deployment, ordered by created-at descending
- **AND** each row SHALL surface the package id, the bound subject and client, the active status, the count of member child grants, and the created and revoked timestamps.

#### Scenario: Operator opens a package detail

- **WHEN** the operator opens a single package on the operator console
- **THEN** the detail surface SHALL render the package status, the bound subject and client, the created and revoked timestamps, and every member child grant with its source and current status
- **AND** the detail surface SHALL link to each member child grant's standalone detail surface and to the filtered event-subscription list for the package's children.

#### Scenario: Operator revokes a package

- **WHEN** the operator submits the revoke affordance on a package detail surface
- **THEN** the reference implementation SHALL revoke every active package membership
- **AND** SHALL flip the package row to `revoked`
- **AND** SHALL invalidate the package-bound MCP refresh token on the next exchange.

#### Scenario: Operator tries to revoke an already-revoked package

- **WHEN** the operator submits the revoke affordance on a package whose status is already `revoked`
- **THEN** the reference implementation SHALL return a typed `already_revoked` error envelope and SHALL NOT alter the existing child-grant statuses.

### Requirement: Child grants SHALL carry their package linkage on operator surfaces

The reference implementation SHALL surface a child grant's parent package id on the operator console grant list and grant detail surfaces whenever the grant is a member of a package.

#### Scenario: Operator views the grants list

- **WHEN** the operator opens the grants list on the operator console
- **THEN** every grant row whose grant id is present in `grant_package_members` SHALL carry the parent `grant_package_id`
- **AND** the row SHALL render a pivot affordance to the package detail surface.

#### Scenario: Operator views a child grant standalone

- **WHEN** the operator opens a child grant on the operator console
- **AND** the grant is bound to a package
- **THEN** the detail surface SHALL render a pivot affordance to the package detail surface.

### Requirement: Grant package visibility surfaces SHALL NOT leak secret material

The reference implementation SHALL NOT include grant-package secret material (refresh-token hashes, opaque package secrets, raw bearer strings) on any operator-visible package list, detail, or event-log surface.

#### Scenario: Operator inspects a package

- **WHEN** the operator inspects a package detail
- **THEN** the rendered payload SHALL NOT contain any refresh-token hash, access-token string, or raw package secret
- **AND** the rendered payload SHALL only surface non-secret identifiers, statuses, and timestamps already exposed elsewhere in the operator console.

### Requirement: Hosted MCP adapter SHALL forward self-calls to a configured internal resource-server base

The hosted MCP adapter SHALL forward its grant-scoped self-calls to a configured internal resource-server base URL when one is present, and SHALL fall back to the advertised public resource when no internal base is configured. This applies to BOTH hosted MCP token paths: the **package** path (the per-member child `RsClient` fan-out for an `mcp_package` token) and the **standalone** path (the single-bearer `RsClient` for a `client` token). The advertised `resource`, the protected-resource discovery metadata, and the MCP server's advertised `providerUrl` SHALL continue to resolve to the public origin; the internal base SHALL be used only as the adapter's server-internal fetch base and SHALL NOT be advertised, written into issued-token audience/resource, or returned in discovery responses. The internal base SHALL be operator-configured to a trusted loopback or internal cluster/service-DNS address and SHALL NOT be derived from request headers. Each self-call SHALL still be authorized only by its active grant bearer (the child grant's bearer for a package token; the single grant's bearer for a `client` token) and SHALL remain subject to per-grant resource-server enforcement.

#### Scenario: Package-token update recovers from a public-edge method block

- **WHEN** a hosted MCP package token calls `update_event_subscription` (a `PATCH /v1/event-subscriptions/:id` self-call)
- **AND** the public edge fronting the advertised resource rejects the PATCH method with HTTP 405 while the configured internal resource-server base method-routes PATCH
- **THEN** the adapter SHALL forward the self-call to the internal base and the update SHALL succeed
- **AND** the call SHALL NOT return an `rs_error` with code `http_405`.

#### Scenario: Standalone client-token update also recovers from a public-edge method block

- **WHEN** a standalone hosted MCP `client` token (not a package token) calls `update_event_subscription` (a `PATCH /v1/event-subscriptions/:id` self-call)
- **AND** the public edge rejects PATCH with HTTP 405 while the configured internal base method-routes PATCH
- **THEN** the adapter SHALL build the single-bearer `RsClient` against the internal base and the update SHALL succeed
- **AND** the call SHALL NOT return an `rs_error` with code `http_405`
- **AND** the advertised `providerUrl` SHALL remain the public origin.

#### Scenario: Advertised metadata stays public

- **WHEN** a client discovers the hosted MCP resource and the adapter forwards a child self-call to the internal base
- **THEN** the advertised `resource`, the protected-resource discovery metadata, and the advertised `providerUrl` SHALL resolve to the public origin
- **AND** the internal resource-server base SHALL NOT appear in any advertised metadata, discovery response, or issued-token audience.

#### Scenario: No internal base configured falls back to the public resource

- **WHEN** no internal resource-server base is configured for the deployment
- **THEN** the adapter SHALL forward child self-calls to the advertised public resource
- **AND** the package adapter's child-locate, source-selection, ambiguity, fan-out, and per-child enforcement behavior SHALL be unchanged.

#### Scenario: Internal base does not widen authority

- **WHEN** the adapter forwards a child self-call to the configured internal resource-server base
- **THEN** the self-call SHALL carry the owning child grant's bearer
- **AND** record access SHALL still be authorized only by that active child grant under the resource server's per-grant enforcement.

### Requirement: Fast broad agent consent SHALL remain proposed until accepted

Any mechanism that lets an owner approve multiple source scopes for an agent in one ceremony SHALL be treated as proposed until reviewed and accepted through the OpenSpec/spec process.

#### Scenario: Experimental batch consent ships in the reference

- **WHEN** the reference implementation experiments with a batch consent or grant package flow
- **THEN** the UI and documentation SHALL label it reference-experimental
- **AND** it SHALL NOT claim finalized PDPP protocol semantics.

### Requirement: Issued grants SHALL remain source-bounded unless explicitly superseded

Fast setup designs SHALL preserve the current source-bounded grant model by issuing independent grants per source rather than a single cross-source grant, unless a later accepted PDPP change explicitly supersedes that model.

#### Scenario: Owner approves a multi-source setup ceremony

- **WHEN** an owner approves access to multiple connectors or providers in one owner-facing ceremony
- **THEN** the resulting access SHALL be represented as multiple independently revocable source-bounded grants
- **AND** RS enforcement SHALL remain per grant and per source.

### Requirement: Broad consent UI SHALL make cumulative risk legible

Any proposed broad or batch consent ceremony SHALL render enough information for the owner to understand cumulative access risk across sources.

#### Scenario: A request includes high-risk breadth

- **WHEN** a staged setup request includes continuous access, all streams, no time range, no field projection, sensitive sources, or many sources
- **THEN** the consent UI SHALL surface those risk factors explicitly
- **AND** it SHALL NOT make maximal access visually equivalent to a narrow single-task grant.

### Requirement: Owner control SHALL remain granular

Any proposed broad setup flow SHALL preserve granular owner control over approval, denial, audit, and revocation.

#### Scenario: Owner rejects one source in a package

- **WHEN** an owner-facing ceremony contains multiple source-bounded requests
- **THEN** the owner SHALL be able to deny or remove one source without denying all other sources
- **AND** any approved sources SHALL remain auditable and revocable independently.

### Requirement: Client-authored broad packages SHALL be constrained

The AS SHALL NOT accept arbitrary client-authored "all data" packages without validation, risk classification, and owner-visible review constraints.

#### Scenario: Client requests many maximal continuous scopes

- **WHEN** a client stages a broad package containing many maximal continuous source scopes
- **THEN** the AS SHALL either reject it or require a stronger consent ceremony than a narrow request
- **AND** the owner SHALL see which sources and scope dimensions make the request broad.

### Requirement: Hosted MCP picker SHALL let the owner narrow streams within a selected source

When the hosted MCP package picker presents a connector-backed source, it SHALL render an owner-controllable list of the connector's manifest streams alongside the source toggle. Selecting the source SHALL make stream choices available without implying that every stream was approved. Leaving an individual stream unselected, or clearing it after selecting it, SHALL exclude that stream from the issued child grant. The AS SHALL NOT silently widen the issued child grant beyond the streams the picker observed as selected at submission time.

#### Scenario: Owner selects a subset of streams within a selected source

- **WHEN** the owner selects a hosted MCP source and selects only some streams within that source before submitting
- **THEN** the issued child grant SHALL authorize only the streams selected for that source
- **AND** the AS SHALL NOT include unselected streams in the resulting `authorization_details`.

#### Scenario: Owner explicitly authorizes every stream for a source

- **WHEN** the owner selects a hosted MCP source and submits every manifest stream for that source as selected
- **THEN** the AS MAY emit the canonical `[{ name: "*" }]` shorthand for that source so the child grant naturally expands when a future manifest revision adds streams
- **AND** the issued child grant SHALL authorize every manifest stream for that source at the time of approval.

#### Scenario: Owner leaves every stream unselected for a selected source

- **WHEN** the owner selects a hosted MCP source but submits no stream selected within it
- **THEN** the AS SHALL NOT silently drop the source or issue a child grant for that source
- **AND** the AS SHALL re-render the hosted picker with an HTML validation error naming the affected source(s) by display name, not raw connector URLs or internal connection ids.

### Requirement: Hosted MCP picker SHALL enforce a selected connection on the issued child grant

When the hosted MCP package picker presents a connector that has more than one active connection and the owner selects one specific connection row, the issued child grant SHALL carry `streams[].connection_id` for every stream entry it authorizes, including the canonical wildcard entry, so that the selection the owner saw is enforced on every grant-authorized read rather than recorded only as audit or display metadata. When the picker presents a connector with exactly one active connection, or presents only the connector with no connection-level choice, the issued child grant SHALL omit `connection_id` and preserve cross-connection (fan-in) read semantics. The connection enforced on the issued grant SHALL equal the connection named to the owner in the picker; the AS SHALL NOT enforce a different connection than the one shown, and SHALL NOT silently drop a stale or unknown connection after validation.

#### Scenario: Owner selects one connection among siblings

- **WHEN** the owner selects a hosted MCP source whose connector has more than one active connection and chooses one specific connection before submitting
- **THEN** every stream entry on the issued child grant SHALL carry that connection's `connection_id`
- **AND** a grant-authorized read under that child grant SHALL return records only from the selected connection and SHALL NOT disclose records reachable only from a sibling connection of the same connector.

#### Scenario: Owner approves the whole source for a selected connection

- **WHEN** the owner selects every manifest stream for a hosted MCP source whose connector has more than one active connection and a specific connection is chosen
- **THEN** the AS MAY emit the canonical `[{ name: "*", connection_id }]` shorthand for that source
- **AND** the issued child grant SHALL constrain every authorized stream to the selected connection, whether the grant stores the wildcard form or its expanded per-stream equivalent.

#### Scenario: Single-connection source preserves fan-in

- **WHEN** the owner selects a hosted MCP source whose connector has exactly one active connection
- **THEN** the issued child grant SHALL NOT carry a `streams[].connection_id` constraint
- **AND** previously-issued single-connection grants SHALL continue to function without re-issuance.

#### Scenario: Enforced connection matches the shown connection

- **WHEN** the picker issues a child grant pinned to a connection
- **THEN** the package member audit metadata (`source_json.connection_id`) and the enforceable grant scope (`grant.streams[].connection_id`) SHALL name the same connection
- **AND** the AS SHALL reject a submitted connection that is not an active binding for the owner and connector rather than issuing a grant pinned to an unknown connection.

### Requirement: Hosted MCP picker SHALL let the owner choose the package access mode

The hosted MCP package picker SHALL expose a single owner-facing control that selects the package access mode for every child grant issued by the ceremony. The control SHALL offer the two protocol-enforced access modes (`single_use` and `continuous`) defined by `spec-core.md`. The AS SHALL apply the submitted access mode to every `authorization_details[]` entry the picker emits; mixed-access packages are out of scope for this picker. The picker SHALL default to `continuous` to preserve the prior baseline behavior, and the owner-facing copy SHALL describe what each mode means in plain language before submission.

#### Scenario: Owner accepts the default continuous access

- **WHEN** the owner submits the picker without changing the access-mode control
- **THEN** every child grant issued by the package SHALL carry `access_mode: 'continuous'`
- **AND** the picker MAY rely on the spec-default `continuous` semantics rather than re-encoding the value into every checkbox.

#### Scenario: Owner narrows the package to single-use access

- **WHEN** the owner selects the `single_use` access-mode control before submitting
- **THEN** every child grant issued by the package SHALL carry `access_mode: 'single_use'`
- **AND** each child grant SHALL be subject to the same single-use lifecycle (one consumption, expiry on use) that `spec-core.md` already defines for non-package single-use grants
- **AND** the AS SHALL NOT silently upgrade a `single_use` selection to `continuous` for any source in the package.

#### Scenario: Picker rejects unsupported access-mode submissions

- **WHEN** the picker POST submits an `access_mode` value that is not `single_use` or `continuous`
- **THEN** the AS SHALL return a typed `invalid_request` error
- **AND** the AS SHALL NOT issue any child grant for the request.

### Requirement: Hosted MCP picker SHALL NOT encode a non-Core retention shape

The hosted MCP picker SHALL NOT emit a `retention` field on the `authorization_details[]` entries it constructs, and the issued child grants SHALL NOT carry a `retention` object that does not match the `spec-core.md` shape `{ max_duration, on_expiry }`. In the generic Claude/ChatGPT hosted MCP ceremony no Core-shaped per-source retention commitment exists; absence is the honest answer, and absence SHALL be how the picker conveys it. The owner-facing copy SHALL state plainly that this ceremony does not encode a machine-readable retention bound on the issued grants, and that any retention of fetched results is governed by the MCP client's own policy and any external agreements the owner has with that client.

#### Scenario: Picker says the ceremony does not encode a retention bound

- **WHEN** the picker renders the cumulative-risk disclosure copy
- **THEN** the copy SHALL state that this ceremony does not encode a machine-readable retention bound on the issued grants
- **AND** the copy SHALL NOT call this a retention policy encoded in the grant
- **AND** the copy SHALL NOT advertise an owner-controllable retention preset that the picker does not actually emit.

#### Scenario: Picker-issued child grants omit the retention field

- **WHEN** the picker emits an `authorization_details[]` entry for a selected source
- **THEN** the entry SHALL NOT include a `retention` object
- **AND** the issued child grant SHALL NOT carry a `retention` object whose shape does not match `spec-core.md`'s `{ max_duration, on_expiry }`.

### Requirement: Grant detail spine events SHALL surface what the package picker approved

Every `grant.issued` spine event for a hosted MCP package child grant SHALL include the structured fields a downstream operator surface (dashboard timeline, CLI grant timeline, `/_ref/grants/:grantId/timeline`) needs to recognise a narrowed grant without re-deriving the picker submission. Specifically the event `data` SHALL include the resolved `access_mode` and the resolved `stream_names` from the issued grant, and the event `data` SHALL make the absence of a machine-readable retention bound visible — either by omitting the `retention` key or by surfacing it as an explicit `null`. The event `data` SHALL NOT include a non-Core retention shape (for example, a `classification` field).

#### Scenario: Operator inspects the timeline for a narrowed package child grant

- **WHEN** an operator opens the spine timeline for a child grant issued by the hosted MCP package picker
- **THEN** the `grant.issued` event data SHALL include `access_mode` and `stream_names`
- **AND** the event data SHALL convey retention absence as `retention: null` (or by omitting the key) when no Core-shaped retention is carried on the grant
- **AND** the event data SHALL NOT include a non-Core retention shape such as `retention.classification`
- **AND** a child grant narrowed to a subset of streams SHALL be distinguishable from a wildcard child grant by inspecting `stream_names` against the connector manifest at the issued-at time.

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
