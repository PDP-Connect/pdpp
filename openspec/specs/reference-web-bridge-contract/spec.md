# reference-web-bridge-contract Specification

## Purpose
Define how website bridge routes consume the current reference AS/RS contract without teaching legacy helper routes, demo-only assumptions, or connector-only client access as durable PDPP behavior.
## Requirements
### Requirement: Web bridge routes reflect the current reference contract
Website bridge routes that call the reference implementation SHALL consume the current primary AS/RS surfaces and SHALL not require removed helper routes or connector-only request assumptions when the reference supports a source-aware contract.

#### Scenario: Source-aware grant bridge
- **WHEN** the website starts a PDPP client request through the reference AS
- **THEN** the bridge SHALL stage that request through the current PAR surface and SHALL allow either `connector_id` or `provider_id` according to the current reference contract rather than assuming connector-only input

#### Scenario: Legacy bridge routes remain explicitly non-authoritative
- **WHEN** a website bridge exists only to support a legacy or demo-only flow
- **THEN** that route SHALL remain explicit about its legacy/demo role and SHALL not imply that removed or non-primary surfaces are the current reference contract

### Requirement: Query bridges do not imply connector-only client access
Website query bridges SHALL treat connector scoping as optional implementation detail for polyfill-shaped reads and SHALL not document connector identifiers as universally required for client-token queries.

#### Scenario: Native or token-bound query
- **WHEN** the website bridges a record query driven by a grant-bound client token or native-provider path
- **THEN** the bridge SHALL work without requiring a public `connector_id` parameter

#### Scenario: Polyfill-scoped query
- **WHEN** the website bridges a polyfill-scoped query that still needs explicit source selection
- **THEN** the bridge MAY forward `connector_id`, but SHALL do so as realization-specific behavior rather than as the universal PDPP query model

### Requirement: Sandbox record list SHALL mount `rs.records.list`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/streams/:stream/records` by mounting the canonical `rs.records.list` operation through a sandbox fixture environment profile. It SHALL NOT construct the public record-list response through an independent website-local AS/RS builder.

#### Scenario: Sandbox record list route

- **WHEN** `/sandbox/v1/streams/:stream/records` is requested
- **THEN** the route SHALL execute the same `rs.records.list` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel records-list builder removal

- **WHEN** `/sandbox/v1/streams/:stream/records` is migrated to `rs.records.list`
- **THEN** the website-local public builder that previously constructed the live-shaped record-list response SHALL be deleted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped list of record envelopes from the sandbox fixture profile

### Requirement: Sandbox record detail SHALL mount `rs.records.get`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/streams/:stream/records/:recordId` by mounting the canonical `rs.records.get` operation through a sandbox fixture environment profile. It SHALL NOT construct the public record-detail response through an independent website-local AS/RS builder.

#### Scenario: Sandbox record detail route

- **WHEN** `/sandbox/v1/streams/:stream/records/:recordId` is requested
- **THEN** the route SHALL execute the same `rs.records.get` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel record-detail builder removal

- **WHEN** `/sandbox/v1/streams/:stream/records/:recordId` is migrated to `rs.records.get`
- **THEN** the website-local public builder that previously constructed the live-shaped record-detail response SHALL be deleted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped record envelope from the sandbox fixture profile

### Requirement: Sandbox schema SHALL mount `rs.schema.get`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/schema` by mounting the canonical `rs.schema.get` operation through a sandbox fixture environment profile. It SHALL NOT construct the public schema-discovery response through an independent website-local AS/RS builder.

#### Scenario: Sandbox schema route

- **WHEN** `/sandbox/v1/schema` is requested
- **THEN** the route SHALL execute the same `rs.schema.get` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel builder removal

- **WHEN** `/sandbox/v1/schema` is migrated to `rs.schema.get`
- **THEN** the website-local public builder that previously constructed the live-shaped schema response SHALL be deleted or demoted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped schema graph from the sandbox fixture profile

### Requirement: Sandbox lexical search SHALL mount `rs.search.lexical`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/search` by mounting the canonical `rs.search.lexical` operation through a sandbox fixture environment profile. It SHALL NOT construct the public lexical-search response through an independent website-local AS/RS builder.

#### Scenario: Sandbox lexical search route

- **WHEN** `/sandbox/v1/search` is requested with a valid query
- **THEN** the route SHALL execute the same `rs.search.lexical` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, error mapping, and sandbox demo headers

#### Scenario: Parallel lexical-search builder removal

- **WHEN** `/sandbox/v1/search` is migrated to `rs.search.lexical`
- **THEN** the public sandbox route SHALL NOT statically import the previous website-local public builder that constructed the live-shaped lexical-search response
- **AND** the migration SHALL include a regression test proving the route still returns the canonical lexical-search list envelope from the sandbox fixture profile

#### Scenario: Sandbox API obeys the canonical request contract

- **WHEN** `/sandbox/v1/search` is requested with empty or missing `q`
- **THEN** the route SHALL return the canonical `invalid_request` error envelope produced by the operation
- **AND** the route SHALL NOT short-circuit to an empty list envelope as a host-level demo policy

#### Scenario: Sandbox API rejects unsupported query parameters

- **WHEN** `/sandbox/v1/search` is requested with a query parameter outside the v1 allowlist (`q`, `limit`, `cursor`, `streams`, `streams[]`, `filter`)
- **THEN** the route SHALL return the canonical `invalid_request` error envelope produced by the operation, identifying the rejected parameter

#### Scenario: Sandbox fixture evaluates supported filters and rejects unsupported filters

- **WHEN** `/sandbox/v1/search` is requested with `filter[field]=value` for a top-level scalar field declared in the demo stream's manifest
- **THEN** the route SHALL evaluate the filter against record data and return only matching records (or an empty list when no record matches)
- **WHEN** `/sandbox/v1/search` is requested with `filter[field][op]=value` (a range filter) on any demo field
- **THEN** the route SHALL return the canonical `invalid_request` error envelope because the sandbox manifest advertises no `query.range_filters` for any stream
- **WHEN** `/sandbox/v1/search` is requested with `filter[unknown_field]=value`
- **THEN** the route SHALL return the canonical `invalid_request` error envelope identifying the rejected filter
- **AND** the sandbox SHALL NOT silently accept filter shapes that are not evaluated

### Requirement: Sandbox stream detail SHALL mount `rs.streams.detail`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/streams/:stream` by mounting the canonical `rs.streams.detail` operation through a sandbox fixture environment profile. It SHALL NOT construct the public stream-metadata response through an independent website-local AS/RS builder.

#### Scenario: Sandbox stream detail route

- **WHEN** `/sandbox/v1/streams/:stream` is requested
- **THEN** the route SHALL execute the same `rs.streams.detail` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to path adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel builder removal

- **WHEN** `/sandbox/v1/streams/:stream` is migrated to `rs.streams.detail`
- **THEN** the website-local public builder that previously constructed the live-shaped stream-metadata response SHALL be deleted or demoted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped `stream_metadata` envelope from the sandbox fixture profile

### Requirement: Sandbox stream list SHALL mount `rs.streams.list`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/streams` by mounting the canonical `rs.streams.list` operation through a sandbox fixture environment profile. It SHALL NOT construct the public stream-list response through an independent website-local AS/RS builder.

#### Scenario: Sandbox stream list route

- **WHEN** `/sandbox/v1/streams` is requested
- **THEN** the route SHALL execute the same `rs.streams.list` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel builder removal

- **WHEN** `/sandbox/v1/streams` is migrated to `rs.streams.list`
- **THEN** the website-local public builder that previously constructed the live-shaped stream-list response SHALL be deleted or demoted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped list of stream summaries from the sandbox fixture profile

### Requirement: Sandbox dataset summary SHALL mount `ref.dataset.summary`

The website-hosted sandbox SHALL serve every public dataset-summary surface — both the public `GET /sandbox/_ref/dataset/summary` route and the sandbox dashboard data source's `getDatasetSummary` method — by mounting the canonical `ref.dataset.summary` operation through a sandbox fixture environment profile. It SHALL NOT construct the dataset-summary envelope through an independent website-local builder or local field mapping on any of those surfaces.

#### Scenario: Sandbox dataset-summary route

- **WHEN** `/sandbox/_ref/dataset/summary` is requested
- **THEN** the route SHALL execute the same `ref.dataset.summary` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Sandbox dashboard data source dataset-summary

- **WHEN** the sandbox dashboard data source's `getDatasetSummary` method is invoked
- **THEN** it SHALL execute the same `ref.dataset.summary` operation implementation used by the native reference host and the sandbox public route
- **AND** it SHALL NOT construct the dataset-summary envelope through a local mapping over a demo-shaped builder
- **AND** the resulting envelope SHALL be byte-equal to the envelope returned by the public `/sandbox/_ref/dataset/summary` route under the same fixture environment

#### Scenario: Parallel dataset-summary builder removal

- **WHEN** the sandbox dataset-summary surfaces are migrated to `ref.dataset.summary`
- **THEN** the website-local public builder that previously constructed the live-shaped dataset-summary response SHALL be deleted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the public route still returns a live-shaped `dataset_summary` envelope from the sandbox fixture profile
- **AND** the migration SHALL include a regression test pinning the dashboard data source's envelope to the canonical operation's envelope under the same fixture profile, so any future re-introduction of a parallel local mapping in the data source is caught by test failure

### Requirement: Demo bridge routes SHALL remain sandbox-only and non-authoritative

Website routes that expose mock AS/RS behavior for the public sandbox SHALL remain sandbox-prefixed, deterministic, and explicitly demo-only. They SHALL NOT redefine the primary reference contract or become required by the live reference dashboard.

#### Scenario: Sandbox exposes a mock public endpoint
- **WHEN** `apps/web` exposes a mock endpoint such as `/sandbox/v1/schema`, `/sandbox/v1/search`, or `/sandbox/v1/streams/:stream/records`
- **THEN** the endpoint SHALL return deterministic fictional data
- **AND** it SHALL preserve the relevant shape of the corresponding reference/public surface where practical
- **AND** it SHALL NOT be documented as the live AS/RS endpoint for real deployments

#### Scenario: Live dashboard fetches reference data
- **WHEN** `/dashboard/**` renders live reference state
- **THEN** it SHALL continue using the configured live AS/RS clients and owner-access rules
- **AND** it SHALL NOT silently fall back to sandbox data

#### Scenario: Sandbox dashboard fetches demo data
- **WHEN** `/sandbox/**` renders dashboard-like demo state
- **THEN** it SHALL use a sandbox data-source implementation compatible with the dashboard feature layer
- **AND** it SHALL NOT mint owner tokens, forward owner-session cookies, or call the live AS/RS
