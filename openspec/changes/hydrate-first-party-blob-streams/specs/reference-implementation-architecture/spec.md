## ADDED Requirements

### Requirement: First-party binary streams hydrate through the reference blob substrate

The reference implementation SHALL use its existing blob substrate for first-party connector streams that collect binary file content. A connector that hydrates source bytes SHALL store those bytes through the reference blob storage seam and SHALL expose them to clients through a record `blob_ref` decorated with `fetch_url` at read time.

#### Scenario: A connector hydrates a file-like record

- **WHEN** a first-party connector successfully collects bytes for a file-like record
- **THEN** the connector SHALL emit a record that references the stored bytes through `data.blob_ref`
- **AND** the reference SHALL serve those bytes through `GET /v1/blobs/{blob_id}` under the existing blob authorization rules
- **AND** the reference SHALL NOT require clients to construct stream-specific `/content`, `/download`, or equivalent byte URLs

#### Scenario: A connector cannot hydrate bytes

- **WHEN** a first-party connector can describe a file-like source object but cannot safely collect its bytes
- **THEN** the connector SHALL preserve the metadata record
- **AND** the record SHALL expose a non-secret hydration status or equivalent manifest-declared field that lets clients distinguish hydrated and metadata-only records
- **AND** the connector SHALL NOT fabricate a `blob_ref` for bytes it did not store

#### Scenario: A client lacks blob field visibility

- **WHEN** a caller can read a file-like record but the grant projection does not include the record's `blob_ref` field
- **THEN** the reference SHALL NOT expose a usable blob `fetch_url`
- **AND** `GET /v1/blobs/{blob_id}` SHALL remain unauthorized unless some visible record exposes that blob reference under the caller's grant

### Requirement: First-party blob hydration coverage stays auditable

The reference implementation SHALL keep first-party blob hydration coverage auditable by classifying shipped connector streams that may contain collectible binary content.

#### Scenario: A first-party connector has binary-capable streams

- **WHEN** a shipped first-party connector stream can contain source file bytes, attachments, statements, receipts, exports, or uploaded files
- **THEN** the implementation work SHALL classify that stream as hydrated, metadata-only, deferred, or not applicable
- **AND** the classification SHALL document the reason when hydration is not implemented

#### Scenario: Blob hydration expands to a new stream

- **WHEN** blob hydration support is added to another first-party stream
- **THEN** tests SHALL prove that connector output can produce a visible `blob_ref.fetch_url`
- **AND** tests SHALL prove that byte fetch is grant-safe through `GET /v1/blobs/{blob_id}`
