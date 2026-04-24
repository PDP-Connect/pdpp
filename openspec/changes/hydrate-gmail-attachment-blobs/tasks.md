## 1. Blob Upload Contract

- [ ] 1.1 Add or expose a connector-facing `POST /v1/blobs` route authenticated with owner/runtime authority and bound to `connector_id`, `stream`, and `record_key`.
- [ ] 1.2 Make blob upload content-addressed and idempotent: repeated uploads of identical bytes return the same canonical `blob_id`/`sha256` and do not duplicate stored bytes.
- [ ] 1.3 Preserve the existing `GET /v1/blobs/{blob_id}` safety rule: blob fetch requires a visible authorized record with matching `data.blob_ref.blob_id`.
- [ ] 1.4 Add contract/request tests for blob upload validation, content-type/size/hash handling, and duplicate upload behavior.

## 2. Gmail Manifest And Consent Copy

- [ ] 2.1 Update the Gmail `attachments` schema with `blob_ref`, `content_sha256`, `hydration_status`, and `hydration_error`.
- [ ] 2.2 Update attachment display/detail copy so users understand that granting `blob_ref` exposes retrievable attachment bytes, not only metadata.
- [ ] 2.3 Keep `message_bodies` copy and schema separate from attachment blob hydration.
- [ ] 2.4 Add manifest validator tests for the updated attachment blob-ref shape and malformed declarations.

## 3. Connector Hydration

- [ ] 3.1 Use the IMAP attachment part download path for requested Gmail `attachments` records.
- [ ] 3.2 Stream each attachment through SHA-256 hashing and blob upload without buffering large files unnecessarily.
- [ ] 3.3 Emit attachment records with stable primary keys, `blob_ref`, `content_sha256`, MIME type, size, and `hydration_status: "hydrated"` after successful upload.
- [ ] 3.4 Emit bounded `hydration_status: "failed"` or `"deferred"` metadata without fake blob IDs when a single attachment cannot be downloaded or uploaded.
- [ ] 3.5 Ensure incremental runs can backfill existing metadata-only attachment records without changing attachment identity or skipping already-hydrated blobs.

## 4. Read Path And Expansion

- [ ] 4.1 Ensure record-list and record-detail responses inject `blob_ref.fetch_url` only when `blob_ref` is visible under the caller's grant.
- [ ] 4.2 Ensure `GET /v1/blobs/{blob_id}` returns `blob_not_found` when the caller can read attachment metadata but not the `blob_ref` field.
- [ ] 4.3 Cover Gmail `messages -> attachments` expansion/read-path behavior once the expansion tranche is available, including blob-ref decoration on expanded records.

## 5. Tests And Acceptance

- [ ] 5.1 Add Gmail connector fixture tests proving attachment bytes are downloaded, hashed, uploaded, and emitted as blob-linked records.
- [ ] 5.2 Add rerun/backfill tests proving idempotency for already-seen attachments and already-uploaded blobs.
- [ ] 5.3 Add API tests proving authorized blob fetch returns bytes, content type, and length for Gmail attachments.
- [ ] 5.4 Add API tests proving hidden or unauthorized `blob_ref` fields cannot be used to fetch blobs.
- [ ] 5.5 Add a regression test proving `message_bodies` remains a separate content stream and attachment bytes are not inlined there.
- [ ] 5.6 Run `openspec validate hydrate-gmail-attachment-blobs --strict`.
- [ ] 5.7 Run `openspec validate --all --strict`.
- [ ] 5.8 Run `git diff --check`.
