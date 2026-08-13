## ADDED Requirements

### Requirement: Source webhook ingress is resource-bounded

The reference-only `POST /_ref/source-webhooks/:sourceId` ingress SHALL reject
any request whose wire body exceeds 1 MiB with HTTP 413 and the standard PDPP
error envelope using error code `resource_limit`. The limit SHALL apply to both
`ingest_records` and `schedule_run` actions. For `ingest_records`, the
`records` array SHALL contain no more than 500 entries; an over-limit array
SHALL return HTTP 413 with error code `resource_limit` before the source event
is claimed and before records are serialized for NDJSON ingest.

These are reference deployment resource policies, not PDPP Core protocol
constants. Source adapters that need to deliver more data SHALL split it into
bounded signed callbacks. Each chunk SHALL use a distinct event id because
replay protection is keyed by `(source_id,event_id)`.

#### Scenario: A body exactly at the byte limit is accepted
- **WHEN** a source-authenticated callback has a wire body of exactly 1 MiB
- **AND** its action and payload satisfy the source-webhook requirements
- **THEN** the reference SHALL process the callback normally

#### Scenario: A body over the byte limit is rejected before operation work
- **WHEN** a callback's wire body exceeds 1 MiB
- **THEN** the reference SHALL return HTTP 413 with error code `resource_limit`
- **AND** it SHALL NOT verify the callback body, claim the event, or ingest records

#### Scenario: Five hundred records are accepted
- **WHEN** an authenticated `ingest_records` callback has exactly 500 records
- **AND** its total wire body is at most 1 MiB
- **THEN** the reference SHALL pass the records to the existing ingest operation

#### Scenario: Five hundred and one records are rejected before claim
- **WHEN** an authenticated `ingest_records` callback has 501 records
- **AND** its total wire body is at most 1 MiB
- **THEN** the reference SHALL return HTTP 413 with error code `resource_limit`
- **AND** it SHALL NOT claim the event or serialize records for ingest

#### Scenario: A bounded schedule request keeps the existing behavior
- **WHEN** an authenticated `schedule_run` callback is at most 1 MiB
- **THEN** the reference SHALL apply the existing policy, run, or scheduler fallback

#### Scenario: An oversized schedule request is rejected
- **WHEN** an authenticated `schedule_run` callback exceeds 1 MiB
- **THEN** the reference SHALL return HTTP 413 with error code `resource_limit`
- **AND** it SHALL NOT claim the event or request a run
