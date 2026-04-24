## Context

The Gmail connector now emits `message_bodies` as a separate content stream, but `attachments` remains metadata-only. The backlog records the gap directly: `decodeBodystructureForAttachments` finds filenames, MIME types, sizes, and part indices, but the connector does not call the IMAP attachment download path and does not populate the Resource Server blob store.

The reference server already has the read-side safety model for blobs: `GET /v1/blobs/{blob_id}` succeeds only when the caller can read a record whose visible top-level `data.blob_ref.blob_id` equals the requested `blob_id`. The existing `blob-id-param-naming-2026-04-22.md` note confirms the public fetch path uses `/v1/blobs/{blob_id}` consistently. The missing piece is connector-facing upload plus Gmail records that expose a grant-visible `blob_ref`.

## Goals / Non-Goals

Goals:

- Hydrate Gmail attachment bytes into content-addressed blobs when the `attachments` stream is requested.
- Preserve the existing grant-safety invariant: possession or guessing of a `blob_id` is insufficient without an authorized visible attachment record carrying the matching `blob_ref`.
- Keep metadata queries fast and byte fetches separate from record listing.
- Make reruns and backfills idempotent so old metadata-only rows can gain blob linkage without duplicating bytes or changing attachment identity.
- Test the full path: manifest schema, connector emission, blob upload, blob fetch authorization, and record read/expansion decoration.

Non-goals:

- No generic PDF/docx/image OCR or text extraction in this change.
- No migration of `message_bodies` to blobs. Gmail body text/HTML remains its own grantable stream.
- No broad blob storage topology rewrite beyond what is required to expose connector upload safely.
- No new grant type for "attachment metadata but not bytes" unless implementation proves field-level projection cannot express it.

## Decisions

### 1. Attachment records carry a visible `blob_ref`

The read-side blob contract already looks for `data.blob_ref.blob_id`, decorates it with `fetch_url`, and authorizes fetches by re-reading the record under the caller's grant. Gmail attachments should use that shape instead of inventing a Gmail-specific download field.

The attachment schema should add:

- `blob_ref`: nullable object with at least `blob_id`, `mime_type`, `size_bytes`, and `sha256`.
- `content_sha256`: nullable string matching `blob_ref.sha256` when hydrated.
- `hydration_status`: `hydrated`, `failed`, or `deferred`.
- `hydration_error`: nullable string for bounded connector-visible failure diagnostics.

Successful hydration should emit `blob_ref` and `content_sha256`. `blob_ref` may be null only when bytes were not attempted because the caller did not request the `attachments` stream, or when a bounded per-attachment failure is represented as `hydration_status: "failed"`/`"deferred"`. Gmail does not provide a trustworthy content hash before download, so a record must not claim `content_sha256` until the connector has streamed and hashed the bytes.

### 2. Upload is connector-facing and content-addressed

The connector needs a Resource Server upload path, proposed as `POST /v1/blobs`, authenticated with the same owner/runtime authority that permits `POST /v1/ingest/:stream`. The upload request should bind the blob to the originating connector, stream, and record key so read authorization can resolve back to the attachment record.

The upload result should return the canonical `blob_id`, `sha256`, `size_bytes`, and `mime_type`. Re-uploading identical bytes for the same connector/stream/record key should be idempotent. Implementations may deduplicate physical storage by content hash across records, but the authorization metadata must still be sufficient to prove which record makes the blob visible.

This is an implementation prerequisite. Today the reference code has `GET /v1/blobs/{blob_id}` and a `blobs` table, but no public connector-facing `POST /v1/blobs` route was found during proposal drafting. If adding that upload route reveals a broader runtime authority or storage-topology problem, implementation should stop and bring the decision back to the owner.

### 3. Hydration happens synchronously within the attachment emission path

For this tranche, the Gmail connector should stream each attachment part from IMAP, hash it, upload it, and emit the attachment record with the resulting `blob_ref`. That keeps record state honest: if a client sees a hydrated attachment, `GET /v1/blobs/{blob_id}` should work under the same grant.

Deferred hydration remains a fallback for bounded failure or future large-object tuning, not the happy path. A deferred record may be useful to preserve attachment metadata when IMAP download fails or byte upload is temporarily unavailable, but it must not include a fake `blob_id`, fake hash, or fetch URL.

### 4. Backfill preserves attachment identity

Existing attachment primary keys should remain stable. The implementation should reprocess messages with historical metadata-only attachments and re-emit the same attachment records with `blob_ref`, `content_sha256`, and hydration status fields populated.

The connector state must not treat "message metadata seen" as proof that attachment bytes are hydrated. A run should be able to identify attachments whose record lacks a hydrated `blob_ref` and schedule them for hydration without duplicating records.

Implementation note: the current Gmail connector does not have a connector-local read API for existing RS rows, so the backfill trigger is conservative. When the `attachments` stream is requested, incremental Gmail runs revisit the All Mail range (`1:*`) and re-emit the same attachment primary keys with hydrated blob linkage. This favors correctness and idempotent backfill over incremental efficiency until the runtime exposes a narrower "records missing blob_ref" worklist.

### 4a. Runtime authority for blob upload

The existing blob upload route is owner-authorized, matching the runtime authority already used to ingest records and persist connector state. To let the Gmail child process stream attachment bytes directly to `POST /v1/blobs`, the runtime passes `PDPP_RS_URL`, `PDPP_OWNER_TOKEN`, and `PDPP_CONNECTOR_ID` into the connector child environment.

Security tradeoff: this broadens the connector child process' ambient authority from "emit records over stdout" to "call owner-authorized RS routes directly" for the duration of the run. The implementation keeps the exposure local to the spawned child process and uses the existing short-lived runtime owner token rather than a new static secret, but a future runtime-owned upload binding would be preferable because it could proxy blob uploads without placing owner bearer material in connector environment variables.

### 5. `message_bodies` stays separate from attachments

`message_bodies` is a content stream for email text and HTML. It is keyed 1:1 with messages, searchable, and independently grantable from header metadata. Attachment blobs are per-file binary payloads attached to messages. They should be discovered through `attachments` records and fetched through the blob endpoint, not folded into `message_bodies`.

This distinction matters for consent copy and query behavior: granting `message_bodies` reveals what emails say; granting `attachments.blob_ref` reveals attached files.

## Acceptance Checks

- Gmail manifest validation accepts the updated `attachments` schema with `blob_ref`, `content_sha256`, and hydration status fields, and rejects malformed blob-ref declarations.
- A Gmail connector fixture with an attachment MIME part emits an `attachments` record containing a hydrated `blob_ref`, matching `content_sha256`, MIME type, and byte size.
- Re-running the same fixture uploads idempotently and does not create duplicate blob storage or a new attachment primary key.
- A seeded or fixture-backed `GET /v1/streams/attachments/records` response injects `blob_ref.fetch_url` only when `blob_ref` is visible under the grant.
- `GET /v1/blobs/{blob_id}` returns bytes for a caller authorized to read the attachment record and visible `blob_ref`, and returns `blob_not_found` for a caller without that field or stream.
- Expansion/read-path tests cover Gmail `messages -> attachments` once expansion is enabled, proving expanded attachment records receive the same blob-ref decoration and authorization behavior.

## Open Questions Deferred

- Whether blob bytes should move from SQLite `BLOB` storage to content-addressed filesystem/object storage before large Slack-style workloads rely on this path.
- Whether a future profile should extract text from hydrated PDFs, docs, images, or archives.
- Whether field-level consent should distinguish attachment metadata from attachment bytes beyond the existing `fields` projection on `blob_ref`.
