## ADDED Requirements

### Requirement: Collection runs SHALL preserve acquisition batch evidence

A Collection Profile runtime or first-party polyfill connector SHALL represent each bounded acquisition event as an acquisition batch when it claims acquisition/coverage support.

An acquisition batch SHALL identify the acquisition method, source format when
applicable, parser or connector version, event-time coverage claim, accepted and
rejected count facts, duplicate/skipped facts when known, and safe coverage gaps.

The acquisition batch SHALL be distinct from a connection, run, stream, grant,
and record. It SHALL NOT be exposed as PDPP Core grant semantics.

#### Scenario: Owner uploads an export artifact

- **WHEN** an owner-provided artifact is parsed and committed
- **THEN** the runtime SHALL preserve an acquisition batch for that artifact
- **AND** the batch SHALL identify the acquisition method as `owner_artifact`
- **AND** the batch SHALL carry safe provenance and coverage facts sufficient to
  produce an import receipt.

#### Scenario: Provider API window collects records

- **WHEN** a provider API connector collects a bounded time or cursor window
- **THEN** the runtime MAY preserve that run window as an acquisition batch
- **AND** the batch SHALL identify the acquisition method as `provider_api` if
  acquisition-batch reporting is enabled for that connector.

#### Scenario: Batch evidence is not grant semantics

- **WHEN** a grant-scoped client reads records emitted by an acquisition batch
- **THEN** the client SHALL see records according to the grant and query
  contract
- **AND** the acquisition batch's owner-only provenance SHALL NOT widen,
  narrow, or replace the grant.

### Requirement: Acquisition method SHALL be orthogonal to trigger posture and stream identity

Connector manifests or runtime metadata that declare acquisition support SHALL
keep acquisition method separate from how acquisition is triggered and separate
from which streams are emitted. Manual owner action, share target upload,
scheduled import, watched folder, one-shot upload, or background run SHALL NOT be
modeled as separate acquisition methods solely because the trigger differs.

Initial acquisition methods SHALL be limited to provider API acquisition,
owner-provided artifact acquisition, device sync, device backup, and
browser/session polyfill acquisition unless a future change adds another method.

#### Scenario: Manual export upload uses owner artifact acquisition

- **WHEN** a source requires the owner to export a file manually and upload it
- **THEN** the acquisition method SHALL be `owner_artifact`
- **AND** the requirement for owner action SHALL be represented as trigger or
  setup posture rather than as a distinct acquisition method.

#### Scenario: Share target and file picker use the same acquisition method

- **WHEN** the owner supplies the same export artifact through an Android share
  target, a mobile upload page, or a desktop file picker
- **THEN** those paths SHALL use the same acquisition method
- **AND** implementation MAY record the upload channel as reference-owned
  provenance without changing the acquisition method.

### Requirement: Multiple acquisition methods MAY populate the same stream with explicit provenance

A runtime SHALL allow multiple acquisition methods to emit records into the same
stream for one connection only when each emitted record or accepted batch remains
attributable to its acquisition method and identity/deduplication rules prevent
silent collisions.

A runtime SHALL NOT assume that records from two acquisition methods are
equivalent evidence unless a connector-declared or implementation-approved
identity rule proves equivalence.

#### Scenario: Historical archive and current polyfill populate one stream

- **WHEN** an owner artifact hydrates historical `timeline_points`
- **AND** a later provider API or browser-polyfill pass emits newer
  `timeline_points`
- **THEN** both batches MAY populate the same stream
- **AND** the reference SHALL preserve which acquisition batch produced each
  accepted record or coverage claim
- **AND** overlapping records SHALL be deduplicated only by explicit stable-key
  or merge rules.

#### Scenario: Media sync and chat export overlap

- **WHEN** a WhatsApp chat export emits message records and a device media sync
  emits media assets from a WhatsApp-visible folder
- **THEN** the system SHALL NOT silently assert that a media asset belongs to a
  specific message unless connector evidence proves that relationship
- **AND** owner surfaces MAY show the overlap as related coverage rather than a
  completed merge.

### Requirement: Owner-artifact acquisition SHALL be idempotent and coverage-aware

Owner-artifact acquisition SHALL treat repeated, partial, out-of-order,
overlapping, stale, and media-incomplete artifacts as normal inputs. Re-ingesting
the same artifact SHALL NOT duplicate records or advance coverage falsely.
Missing media or partial coverage SHALL be represented as coverage gaps or
warnings, not as generic protocol failures.

#### Scenario: Same export is uploaded twice

- **WHEN** the owner provides the same artifact content more than once
- **THEN** the runtime SHALL avoid duplicating records
- **AND** the owner-visible result SHALL identify the upload as already known or
  entirely duplicate rather than reporting a generic failure.

#### Scenario: Older export backfills history

- **WHEN** the owner uploads an artifact whose event-time range is older than
  already-collected records
- **THEN** the runtime SHALL accept any new valid records within that range
- **AND** it SHALL update coverage facts without treating older event timestamps
  as stale ingestion.

#### Scenario: Export declares media but media files are absent

- **WHEN** an artifact references media that is not included in the supplied
  files
- **THEN** the batch SHALL carry a safe missing-media coverage gap
- **AND** accepted text or metadata records SHALL remain valid if their stream
  schema permits missing media.
