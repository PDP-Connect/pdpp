## ADDED Requirements

### Requirement: Reference semantic retrieval readiness SHALL distinguish backend readiness from corpus participation

The reference implementation SHALL treat semantic backend/index readiness and semantic corpus participation as separate operational facts. A ready embedding backend and built vector index SHALL NOT by themselves imply that the first-party corpus has any searchable semantic coverage.

#### Scenario: Backend is ready but no stream participates
- **WHEN** the reference has an available semantic embedding backend and a built vector index
- **AND** zero loaded first-party streams declare usable `query.search.semantic_fields`
- **THEN** reference diagnostics SHALL report zero semantic participation explicitly
- **AND** the dashboard SHALL surface that as a warning rather than presenting semantic retrieval as a useful corpus feature

#### Scenario: Streams participate
- **WHEN** loaded manifests declare usable semantic fields
- **THEN** reference diagnostics SHALL report participating connectors, streams, and fields
- **AND** the reported participation SHALL be derived from loaded manifests and validator-accepted top-level string fields

### Requirement: First-party polyfill manifests SHALL provide honest semantic field coverage where natural-language fields exist

The reference implementation SHALL declare `query.search.semantic_fields` in first-party polyfill manifests for top-level string fields that are suitable for semantic retrieval. The declaration SHALL remain independent from lexical fields and SHALL NOT include nested paths, arrays, blobs, non-string scalars, or fields absent from the stream schema.

#### Scenario: A natural-language top-level string field exists
- **WHEN** a first-party polyfill stream contains a top-level string field whose value is natural-language record content
- **THEN** the implementation SHALL either declare that field in `query.search.semantic_fields` or document why the field is intentionally excluded

#### Scenario: A field is not safe for semantic embedding
- **WHEN** a stream field is nested, array-shaped, blob-backed, non-string, identifier-like, or otherwise unsuitable for semantic matching
- **THEN** the implementation SHALL NOT declare that field in `query.search.semantic_fields`

### Requirement: Reference semantic retrieval SHALL offer an operational local embedding backend and a deterministic test backend

The reference implementation SHALL support a production-like local embedding backend for operational semantic retrieval while preserving the deterministic stub backend for tests, CI, and exact-match contract checks. The operational backend SHALL require no hosted API key by default.

#### Scenario: Operational semantic retrieval is enabled
- **WHEN** the reference is configured to use the operational local embedding backend
- **THEN** the semantic capability metadata and deployment diagnostics SHALL identify the configured model, dimensions, distance metric, and language bias
- **AND** semantic index drift SHALL be detected when any of those backend identity fields change

#### Scenario: Tests use the deterministic stub
- **WHEN** tests or CI configure the deterministic stub backend
- **THEN** the reference SHALL preserve deterministic exact-match behavior for stable assertions
- **AND** tests SHALL NOT rely on paraphrase, synonym, multilingual, or conceptual-similarity behavior from the stub

### Requirement: Reference semantic retrieval SHALL support operator-configured multilingual embedding profiles

The reference implementation SHALL allow an operator to configure one active semantic embedding profile, including a documented multilingual profile suitable for Italian-language data. The public semantic retrieval API SHALL remain server-configured and SHALL NOT expose caller-selected model parameters.

#### Scenario: Operator configures a multilingual profile
- **WHEN** an operator configures a multilingual embedding profile
- **THEN** semantic capability metadata and deployment diagnostics SHALL identify the active profile and its language bias
- **AND** existing semantic index coverage SHALL be marked stale until rebuilt with that profile

#### Scenario: Caller requests a model directly
- **WHEN** a caller passes a model selector to `GET /v1/search/semantic`
- **THEN** the public endpoint SHALL continue rejecting the request according to the semantic retrieval contract
- **AND** the configured model SHALL remain an operator/server decision

#### Scenario: Multiple simultaneous profiles are desired
- **WHEN** an operator wants concurrent indexes for multiple embedding profiles
- **THEN** this reference change SHALL NOT claim support for query-time model fan-out
- **AND** that requirement SHALL be handled by a future OpenSpec change because it affects index identity, cursor validity, and ranking/merge semantics

### Requirement: Reference deployment diagnostics SHALL expose semantic retrieval health without leaking secrets

The reference dashboard SHALL provide a read-only deployment diagnostics surface that makes semantic retrieval readiness inspectable by an operator. The diagnostics SHALL include semantic backend status, vector index status, model/profile identity, language bias, participating semantic fields, manifest provenance, database/index topology, and relevant environment configuration with secret values redacted.

#### Scenario: Operator opens deployment diagnostics
- **WHEN** an operator opens the deployment diagnostics page
- **THEN** the page SHALL show whether semantic retrieval is enabled, which backend/index are active, the current index state, and which connectors/streams/fields participate
- **AND** the page SHALL show warnings for zero participation, stale index, unavailable backend, missing model cache, disabled model download, and vector-index fallback when applicable

#### Scenario: Diagnostics include environment configuration
- **WHEN** diagnostics display environment-derived configuration
- **THEN** secret values SHALL be redacted
- **AND** the page SHALL distinguish present, absent, defaulted, and redacted values where that provenance is known

### Requirement: Existing first-party local databases SHALL reconcile semantic coverage changes

The reference implementation SHALL reconcile first-party manifest semantic-field changes into existing local polyfill databases and SHALL rebuild semantic index coverage from stored records without requiring connector re-ingest.

#### Scenario: A first-party manifest gains semantic fields
- **WHEN** an existing local database starts with a first-party manifest that now declares additional `semantic_fields`
- **THEN** the reference SHALL update the persisted first-party manifest according to the existing reconcile rules
- **AND** semantic backfill SHALL index existing stored records for the new declared fields

#### Scenario: The embedding profile changes
- **WHEN** the configured embedding profile changes for an existing local database
- **THEN** semantic index metadata SHALL mark affected coverage stale
- **AND** rebuild SHALL derive replacement embeddings from stored records rather than from connector re-ingest
