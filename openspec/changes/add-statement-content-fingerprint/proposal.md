## Why

The `chase/statements` and `usaa/statements` retained histories churn on every re-download even when the owner-visible statement is unchanged. The statement PDFs are content-addressed by `pdf_sha256 = sha256(raw bytes)`, but the raw bytes are not the content: Chase statement PDFs are RC4-encrypted and the source regenerates the per-download encryption key material and embedded generation timestamps on every fetch, so `pdf_sha256` (and the `pdf_path`/`document_url` that embed it) moves with zero change to the decrypted text or page count. Read-only evidence proved the decrypted text sha and page count are invariant across this churn for every comparable Chase blob pair, and that USAA's own PDF-derived `transactions` are byte-identical content across the same `pdf_sha256` churn.

The current compaction policy and connector fingerprint for both streams exclude only the run-clock `fetched_at`, which makes every blob-identity field a fingerprint boundary. As a result these histories cannot be made rational by canonical compaction: there is no positive content signal that proves a re-download is a no-op, so excluding the blob fields would be lossy (a genuinely re-issued statement for the same key would become invisible). They must therefore stay non-collapsible, and the version-churn surface keeps re-alarming on acquisition noise.

The fix is connector-independent: emit a positive, owner-visible content fingerprint derived from the PDF content (`pdf_text_sha256`, `pdf_page_count`) and make the canonical statement fingerprint exclude the blob/acquisition-identity fields **only when those positive content fields are present**. With a content fingerprint in the record, excluding `pdf_sha256`/`pdf_path`/`document_url` becomes provably lossless, and both statement streams become canonical-compaction-eligible the same way `chase/transactions` already is.

## What Changes

- Add two owner-visible content-fingerprint fields to the `chase/statements` and `usaa/statements` record bodies: `pdf_text_sha256` (sha256 of the extracted PDF text, normalized) and `pdf_page_count` (integer page count).
- USAA already extracts statement PDF text via `pdf-parse`; it reuses that extraction to populate the fields. Chase has no text-extraction path today and gains one for statements.
- Change the canonical statement fingerprint definition (connector no-op suppression and compaction policy, bound to the same rule) to exclude the blob/acquisition-identity fields (`pdf_sha256`, `pdf_path`, `document_url`, `fetched_at`) **only when both positive content fields are present**; when they are absent the fingerprint falls back to excluding only `fetched_at`, so legacy/index-only versions are never silently collapsed.
- Keep `account_id` and `account_reference` inside the USAA statement fingerprint so the proven null → resolved FK backfill (9 null→value, 0 regressions in the evidence) remains a version boundary.
- Make both statement streams canonical-compaction-eligible (`changeModel: "immutable_semantic"`, `representativePolicy: "current"`), gated on the positive content fields, reusing the canonical mode added by `canonicalize-retained-record-history`.
- Validate the policy on a copied/narrowed database with dry-run, apply, and idempotence checks. No live apply.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: add the statement content-fingerprint record fields and the content-gated canonical fingerprint/exclusion rule for `chase/statements` and `usaa/statements`; update the compaction-policy requirement so these two streams are no longer described as blob-identity-bounded run-clock-only policies.

### Removed Capabilities

- None.

## Impact

- `packages/polyfill-connectors/connectors/chase/index.ts` — emit `pdf_text_sha256`/`pdf_page_count` on statements; new text-extraction path.
- `packages/polyfill-connectors/connectors/usaa/index.ts` and `connectors/usaa/statement-pdfs.ts` — emit the two fields from the existing `pdf-parse` extraction.
- `packages/polyfill-connectors/src/fingerprint-cursor.ts` consumers — content-gated exclusion list for the statements cursors.
- Connector manifests for Chase and USAA — declare the two new stream fields.
- `reference-implementation/scripts/compact-record-history.mjs` — update `chase/statements` and `usaa/statements` policies (content-gated exclusion, `changeModel`/`representativePolicy`).
- `reference-implementation/test/compact-record-history-*.test.*` and connector fingerprint/parity tests.
- Operator evidence artifacts under `tmp/workstreams/` for copied-database validation.
