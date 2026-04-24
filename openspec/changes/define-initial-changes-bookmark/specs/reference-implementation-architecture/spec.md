## ADDED Requirements

### Requirement: The reference record-list query SHALL expose an initial changes bookmark sentinel

The reference implementation SHALL accept `changes_since=beginning` on `GET /v1/streams/{stream}/records` as a public initial changes bookmark sentinel. The sentinel SHALL behave like an opaque changes cursor positioned at the beginning of retained history and SHALL return the normal changes response shape, including `next_changes_since`.

Clients SHALL NOT need to construct internal version-0 cursor payloads to start incremental sync.

#### Scenario: A client starts incremental sync from the beginning

- **WHEN** a client queries `/v1/streams/<s>/records?changes_since=beginning`
- **THEN** the reference SHALL return records whose grant-authorized projections changed since the beginning of retained history
- **AND** the response SHALL include `next_changes_since` when the request succeeds
- **AND** the response SHALL NOT expose or require construction of the internal version-0 cursor representation

#### Scenario: The initial changes response is paginated

- **WHEN** a client queries `/v1/streams/<s>/records?changes_since=beginning&limit=N` and additional visible changes remain
- **THEN** the reference SHALL include `next_cursor` only as a page-continuation cursor for the same changes session
- **AND** the response SHALL include `next_changes_since` as the opaque bookmark for a future changes session

#### Scenario: A client sends a raw timestamp

- **WHEN** a client queries `/v1/streams/<s>/records?changes_since=2026-04-24T00:00:00Z`
- **THEN** the reference SHALL reject the request as an invalid changes cursor
- **AND** timestamp-based changes semantics SHALL remain unsupported unless a separate change defines them

### Requirement: Changes bookmark documentation SHALL distinguish page cursors from changes cursors

The public documentation for `GET /v1/streams/{stream}/records` SHALL distinguish record-list page cursors from changes bookmarks. Documentation SHALL tell clients to use `next_cursor` only with the `cursor` query parameter and `next_changes_since` only with the `changes_since` query parameter.

#### Scenario: A client reads change-tracking guidance

- **WHEN** documentation explains how to continue a paginated record or changes response
- **THEN** it SHALL identify `next_cursor` as a page-continuation token for the `cursor` parameter
- **AND** it SHALL NOT tell clients to use `next_cursor` as `changes_since`

#### Scenario: A client reads incremental sync guidance

- **WHEN** documentation explains how to continue a later incremental sync session
- **THEN** it SHALL identify `next_changes_since` as the opaque token to pass as `changes_since`
