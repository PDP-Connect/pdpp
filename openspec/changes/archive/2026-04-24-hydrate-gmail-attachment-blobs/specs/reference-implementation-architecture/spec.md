## ADDED Requirements

### Requirement: The reference SHALL hydrate Gmail attachments as content-addressed blobs

When the Gmail `attachments` stream is requested, the reference Gmail connector SHALL fetch each attachment's MIME part bytes from IMAP, compute a SHA-256 content hash over the exact bytes to be served, upload the bytes through the reference blob upload surface, and emit the attachment record with a visible `blob_ref` that resolves through `GET /v1/blobs/{blob_id}`. Successful hydrated attachment records SHALL include `content_sha256` matching the blob hash, byte size, MIME type, and `hydration_status: "hydrated"`.

The connector SHALL NOT inline attachment bytes into the attachment record or the `message_bodies` stream. Attachment primary keys SHALL remain stable across hydration backfills.

#### Scenario: A requested Gmail attachment is hydrated
- **WHEN** the Gmail connector processes a message with an attachment and the `attachments` stream is requested
- **THEN** it SHALL download the attachment MIME part bytes
- **AND** it SHALL compute `content_sha256` over those bytes
- **AND** it SHALL upload the bytes as a content-addressed blob
- **AND** it SHALL emit an `attachments` record whose visible `blob_ref.blob_id` resolves to those bytes

#### Scenario: A Gmail attachment cannot be hydrated
- **WHEN** the Gmail connector can emit attachment metadata but cannot download or upload the attachment bytes for a bounded per-attachment reason
- **THEN** it MAY emit the attachment metadata with `hydration_status` set to `"failed"` or `"deferred"`
- **AND** it SHALL NOT emit a fake `blob_id`, fake `content_sha256`, or fetchable `blob_ref`
- **AND** it SHALL continue processing other attachments and messages when doing so is safe

#### Scenario: Message bodies are queried separately
- **WHEN** a caller requests Gmail `message_bodies`
- **THEN** the response SHALL expose email body text/HTML according to the `message_bodies` stream contract
- **AND** it SHALL NOT include Gmail attachment bytes
- **AND** attachment byte retrieval SHALL require the caller to read the relevant `attachments` record and its visible `blob_ref`

### Requirement: The reference SHALL expose connector-facing blob upload without weakening blob fetch authorization

The reference SHALL provide a connector-facing blob upload path that allows authorized connector/runtime code to upload bytes for a specific `connector_id`, `stream`, and `record_key`. The upload path SHALL return the canonical `blob_id`, `sha256`, `size_bytes`, and `mime_type` that records can expose through `blob_ref`. Uploading the same bytes for the same record binding SHALL be idempotent.

The reference SHALL continue to authorize `GET /v1/blobs/{blob_id}` by resolving the blob's bound record and requiring that record to be visible under the caller's grant with a matching visible `data.blob_ref.blob_id`. A caller SHALL NOT gain blob access by guessing a `blob_id`, by reading attachment metadata without `blob_ref`, or by holding access to a different record that does not reference the blob.

#### Scenario: A connector uploads the same attachment twice
- **WHEN** connector/runtime code uploads identical attachment bytes for the same Gmail attachment record more than once
- **THEN** the reference SHALL return the same canonical blob identity
- **AND** it SHALL NOT create duplicate logical blobs for that record binding

#### Scenario: A caller can see the attachment blob reference
- **WHEN** a caller is authorized to read a Gmail `attachments` record including its `blob_ref` field
- **AND** that `blob_ref.blob_id` points at an uploaded blob
- **THEN** record-list and record-detail responses SHALL decorate the visible `blob_ref` with a fetch URL for `/v1/blobs/{blob_id}`
- **AND** `GET /v1/blobs/{blob_id}` SHALL return the blob bytes with truthful content metadata

#### Scenario: A caller cannot see the attachment blob reference
- **WHEN** a caller is authorized to read Gmail attachment metadata but is not authorized to read the `blob_ref` field
- **THEN** the caller SHALL NOT receive a blob fetch URL in record-list, record-detail, or expanded-record responses
- **AND** `GET /v1/blobs/{blob_id}` for that blob SHALL fail as `blob_not_found`

### Requirement: The reference SHALL backfill Gmail attachment blob linkage idempotently

The Gmail connector SHALL treat metadata ingestion and byte hydration as separate completion facts. A message or attachment that has already been seen in an incremental run SHALL still be eligible for hydration if its attachment record lacks a hydrated `blob_ref`. Backfill runs SHALL re-emit the same attachment primary key with blob linkage once bytes are available.

#### Scenario: Existing metadata-only attachments are backfilled
- **WHEN** the reference contains Gmail `attachments` records emitted before blob hydration existed
- **AND** a later Gmail connector run can download and upload the attachment bytes
- **THEN** the connector SHALL emit updated records with the same primary keys
- **AND** those records SHALL gain hydrated `blob_ref` and `content_sha256` fields

#### Scenario: Already-hydrated attachments are seen again
- **WHEN** an incremental Gmail run encounters an attachment whose bytes were already uploaded
- **THEN** the connector SHALL preserve the attachment primary key
- **AND** the blob upload/read path SHALL behave idempotently
- **AND** the run SHALL NOT create duplicate attachment records or duplicate logical blob identities
