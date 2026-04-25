# Design

## Current State

The reference RS already has the core blob substrate:

- `POST /v1/blobs` stores content-addressed bytes for owner-authorized ingestion.
- `GET /v1/blobs/{blob_id}` serves bytes only when the caller can see a record that references the blob through a visible `blob_ref`.
- Read responses decorate visible `blob_ref` objects with `fetch_url`.
- Query tests already prove grant-visible `blob_ref` enforcement and Gmail attachment expansion for synthetic hydrated records.

The missing layer is connector hydration. Real first-party connectors still often emit records such as Gmail attachments, Slack files, statements, or receipts as metadata without a populated `blob_ref`, so the transport exists but clients cannot reach actual bytes.

## Principles

1. **Use the existing blob contract.** Do not add `/attachments/:id/content`, `/download`, or stream-specific byte routes.
2. **Connector output remains metadata-first.** A file-like record can exist without bytes; hydration status tells clients whether bytes are available.
3. **Hydration is grant-safe by construction.** Bytes are fetchable only through a record whose `blob_ref` field is visible under the bearer.
4. **Hydration is idempotent.** Re-running a connector should not duplicate stored bytes for the same content.
5. **Failures are records, not surprises.** If byte collection is blocked, too large, expired, unavailable, or intentionally skipped, preserve a metadata record with a machine-readable hydration status/reason.
6. **No secrets in blobs or timelines.** Connector logs and run timelines must not include byte contents or signed source URLs.

## Candidate Streams

The first implementation pass should audit all shipped first-party manifests and classify each stream:

- **Hydrate now:** bytes are source-available, useful, bounded, and safe to fetch in normal sync.
- **Metadata only:** bytes may exist but are not available through the current connector auth/path, are too expensive, or need separate design.
- **Not binary:** no collectible byte payload.

Known candidates:

- Gmail `attachments`: first vertical slice; stream already models metadata, `blob_ref`, `content_sha256`, and `hydration_status`.
- Slack file/message attachment surfaces: likely useful, but distinguish Slack message attachments from actual uploaded files and remote files.
- Chase/USAA/Amazon statements, receipts, invoices, or exports: high assistant value, but may require browser download handling and retention-size policy.
- ChatGPT/Claude/Codex artifacts or uploaded files: audit first; many records may be text metadata or local filesystem references rather than collectible source bytes.
- GitHub gists/release assets/files: audit whether these should be records, blobs, or both.

## Hydration Model

For a hydrated file-like record, connector code should:

1. Fetch bytes from the source while operating under the owner-authorized connector session.
2. Upload/store bytes through the reference blob seam.
3. Emit a record whose `data.blob_ref` contains:
   - `blob_id`
   - `mime_type`
   - `size_bytes`
   - `sha256`
4. Emit a connector-specific integrity field such as `content_sha256` where the manifest already declares it.
5. Emit `hydration_status: "hydrated"`.

For a non-hydrated file-like record, connector code should emit metadata plus `hydration_status` such as:

- `deferred`
- `unavailable`
- `blocked`
- `too_large`
- `failed`

If a stream needs finer diagnostics, add an optional non-secret `hydration_error_code` or equivalent field through the manifest rather than overloading logs.

## Size And Retention

This change should start conservative:

- Set a per-connector default max blob size.
- Allow operator override via environment/config only after documenting the consequence.
- Keep blob storage local to the reference deployment.
- Avoid automatic OCR/text extraction in this change; extracted text can be a later capability.

## Client Discovery

Clients should learn byte availability from:

- `/v1/schema` stream fields and field capabilities,
- `blob_ref` fields present in returned records,
- `blob_ref.fetch_url` injected by the RS at read time,
- `hydration_status` on file-like records.

Docs and examples should explicitly say that `/content`, `/download`, or stream-specific byte URL guessing is not the PDPP contract.

## First Vertical Slice

Implement Gmail attachment hydration first because:

- The stream and relationship already exist.
- Real user testing has confirmed metadata exists but `blob_ref` is absent.
- Existing synthetic query-contract tests already define the desired grant-safe behavior.
- It unlocks high-value assistant questions involving leases, invoices, receipts, PDFs, and documents.

The Gmail slice should prove:

- A real sync can populate attachment `blob_ref` for at least one attachment.
- `expand=attachments` exposes `fetch_url` only when the grant includes `attachments.blob_ref`.
- Fetching `fetch_url` returns the original bytes.
- Metadata-only fallback remains valid when download fails or is skipped.

## Non-Goals

- No new public blob endpoint.
- No resource-specific attachment content routes.
- No automatic OCR/PDF/docx text extraction.
- No hosted blob storage.
- No cross-connector deduplication semantics beyond content-addressed storage.
- No change to the PDPP grant model.
