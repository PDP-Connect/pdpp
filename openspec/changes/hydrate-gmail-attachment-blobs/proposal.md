## Why

Gmail `attachments` records currently describe attachment metadata only. The IMAP MIME part bytes never leave Gmail, so clients can find that an email had a PDF, image, or document but cannot fetch the file through the reference Resource Server. This leaves `message_bodies` complete for email text while attachment content remains invisible.

## What Changes

- Add content-addressed blob hydration for Gmail `attachments` records by streaming each requested attachment part from IMAP, hashing the bytes, uploading them through a connector-facing `POST /v1/blobs` path, and emitting a visible `blob_ref` on the attachment record.
- Extend Gmail attachment records with durable blob linkage: a `blob_ref` object whose `blob_id` resolves through `GET /v1/blobs/{blob_id}`, plus `content_sha256`, byte size, MIME type, and hydration status fields.
- Preserve grant safety: blob fetch remains authorized only when the caller can read the attachment record and the visible `blob_ref` field that points at the requested `blob_id`.
- Make hydration idempotent and backfillable: the same attachment bytes uploaded repeatedly produce the same blob identity and do not duplicate blob storage, while existing metadata-only rows can be re-emitted with blob linkage.
- Keep Gmail `message_bodies` separate. `message_bodies` is the email text/HTML stream; `attachments` is the per-file metadata and byte handle stream.
- Keep generic PDF/docx/image text extraction out of scope. Extracted text can be a future profile once blob bytes are safely addressable.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: define the reference behavior for connector-facing blob upload, Gmail attachment record shape, grant-safe blob fetch, incremental backfill, and tests.

### Added Capabilities

*(none)*

### Removed Capabilities

*(none)*

## Impact

- `packages/polyfill-connectors/manifests/gmail.json` attachment schema and profile copy.
- Gmail connector IMAP attachment download path, upload client, idempotent record emission, and integration fixtures.
- Reference blob upload/read authorization path, including the existing `GET /v1/blobs/{blob_id}` contract.
- Query/read-path behavior that injects `fetch_url` only for visible `blob_ref` fields.
- Contract tests around manifest validation, connector emission, blob upload/fetch, and record expansion/read paths.

Related note: `openspec/changes/reference-implementation-program/design-notes/blob-id-param-naming-2026-04-22.md` records that the public blob fetch path is `/v1/blobs/{blob_id}` and the server route is aligned on the snake_case `blob_id` parameter.
