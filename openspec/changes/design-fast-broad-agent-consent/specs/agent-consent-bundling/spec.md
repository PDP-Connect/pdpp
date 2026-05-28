## ADDED Requirements

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

When the hosted MCP package picker presents a connector-backed source, it SHALL render an owner-controllable list of the connector's manifest streams alongside the source toggle. Deselecting an individual stream SHALL exclude that stream from the issued child grant. The AS SHALL NOT silently widen the issued child grant beyond the streams the picker observed as selected at submission time.

#### Scenario: Owner narrows streams within a selected source

- **WHEN** the owner selects a hosted MCP source and deselects one or more streams within that source before submitting
- **THEN** the issued child grant SHALL authorize only the streams that remained selected
- **AND** the AS SHALL NOT include deselected streams in the resulting `authorization_details`.

#### Scenario: Owner leaves every stream selected for a source

- **WHEN** the owner selects a hosted MCP source without deselecting any of its streams
- **THEN** the AS MAY emit the canonical `[{ name: "*" }]` shorthand for that source so the child grant naturally expands when a future manifest revision adds streams
- **AND** the issued child grant SHALL authorize every manifest stream for that source at the time of approval.

#### Scenario: Owner deselects every stream for a selected source

- **WHEN** the owner selects a hosted MCP source but deselects every stream within it
- **THEN** the AS SHALL NOT issue a child grant for that source
- **AND** the package SHALL contain only child grants for sources with at least one selected stream
- **AND** if every selected source ends up with zero selected streams the AS SHALL return a typed `invalid_request` error naming the affected source(s) by manifest display name.

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
