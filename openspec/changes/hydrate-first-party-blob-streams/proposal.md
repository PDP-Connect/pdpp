# hydrate-first-party-blob-streams

## Why

The reference already exposes a grant-safe blob transport through `blob_ref.fetch_url` and `GET /v1/blobs/{blob_id}`, but first-party connectors mostly emit metadata-only records for files and attachments. Reviewers can discover that an email, statement, receipt, or uploaded file exists, but cannot fetch the bytes through PDPP even when the source account makes those bytes available.

That gap is demo-relevant and product-relevant: lease PDFs, bank statements, receipts, screenshots, exports, and uploaded files are often the evidence a personal assistant needs.

## What Changes

- Audit first-party connector streams for collectible binary/file content.
- Hydrate supported binary records by uploading bytes through the existing reference blob storage seam.
- Emit stable `blob_ref`, `content_sha256`, MIME type, size, and hydration status fields where manifests declare them.
- Preserve metadata-only fallback when bytes are unavailable, too large, blocked, or intentionally out of scope.
- Document that clients discover bytes from `blob_ref.fetch_url`, not resource-specific `/content` or `/download` URL conventions.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- No new public blob endpoint is introduced.
- The existing `GET /v1/blobs/{blob_id}` authorization model remains the byte-fetch path.
- Connector implementations and manifests will change for streams that can safely collect bytes.
- Tests must prove grant-safe expansion and blob fetch behavior on real connector output, not only synthetic seeded records.
