## 1. Content-Fingerprint Fields

- [ ] 1.1 Add `pdf_text_sha256` (sha256 of normalized extracted text) and `pdf_page_count` (integer) to the `usaa/statements` record body, populated from the existing `pdf-parse` extraction in `connectors/usaa/statement-pdfs.ts`.
- [ ] 1.2 Add a statement text-extraction path to the Chase connector (reuse the `pdf-parse` helper; do not add a second PDF library) and emit `pdf_text_sha256`/`pdf_page_count` on `chase/statements`.
- [ ] 1.3 Define the text normalization once (Unicode NFC, collapse whitespace/newline runs to single space, trim) and share it across both connectors so the sha is extractor-jitter-stable.
- [ ] 1.4 On extraction failure or empty text, emit `pdf_text_sha256: null` / `pdf_page_count: null` (fail closed to today's behavior).
- [ ] 1.5 Declare the two new fields in the Chase and USAA connector manifests for the `statements` stream.

## 2. Content-Gated Canonical Fingerprint

- [ ] 2.1 Switch the Chase and USAA statements fingerprint cursors to a content-gated exclusion: exclude `["pdf_sha256", "pdf_path", "document_url", "fetched_at"]` only when both content fields are present and non-null; otherwise exclude only `["fetched_at"]`.
- [ ] 2.2 Keep `account_id`/`account_reference` inside the fingerprint for both connectors (never excluded).
- [ ] 2.3 Update the `chase/statements` and `usaa/statements` compaction policies in `reference-implementation/scripts/compact-record-history.mjs` to the same content-gated `excludeKeys` and add `changeModel: "immutable_semantic"` and `representativePolicy: "current"`.
- [ ] 2.4 Confirm no other Chase, USAA, Amazon, ChatGPT, agent, or point-in-time stream gains canonical eligibility in this tranche.

## 3. Tests

- [ ] 3.1 Unit: re-parsing a fixed statement PDF emits stable `pdf_text_sha256`/`pdf_page_count`; normalization collapses whitespace/line-wrap jitter to the same sha (acceptance check 1).
- [ ] 3.2 Parity: connector cursor and compaction policy compute the same content-gated fingerprint (both fields present → blob fields excluded; either absent → only `fetched_at` excluded); fail closed when the connector helper cannot load (acceptance check 2).
- [ ] 3.3 Unit: blob-only churn with identical content fields → `shouldEmit === false` and removable (acceptance check 3).
- [ ] 3.4 Unit: different `pdf_text_sha256` or `pdf_page_count` → distinct fingerprint, retained boundary (acceptance check 4).
- [ ] 3.5 Unit: USAA `account_id` null→value → distinct fingerprint, retained boundary (acceptance check 5).
- [ ] 3.6 Unit: content-less version adjacent to a content-bearing version → distinct fingerprints, not collapsed (acceptance check 6).

## 4. Copied-Database Validation

- [ ] 4.1 Recreate or refresh narrow copied databases for `cin_029a67a16d8a252f6e3eb896/chase/statements` and `cin_bc1efca69a1c386d610f0924/usaa/statements`.
- [ ] 4.2 Run audit-mode dry-run and confirm the conservative shape is unchanged on the copied data (acceptance check 7).
- [ ] 4.3 Run canonical-mode dry-run and confirm a non-zero `removableVersions` reducing each stream toward one current survivor per same-content run, with every current `records.version` anchored (acceptance check 8).
- [ ] 4.4 Apply canonical mode on the copied database and confirm the backup table is created, only removable rows are removed atomically, every current `records` row has a matching retained history row, and `version_counter` is unchanged (acceptance check 9).
- [ ] 4.5 Re-run canonical-mode dry-run after apply and confirm idempotence (`removableVersions === 0`) (acceptance check 10).

## 5. Acceptance Checks

- [ ] 5.1 Run focused compact-record-history tests for the two statement policies.
- [ ] 5.2 Run Chase and USAA statement fingerprint/parity/integration tests.
- [x] 5.3 Run `openspec validate add-statement-content-fingerprint --strict`.
- [x] 5.4 Run `openspec validate --all --strict`.
- [x] 5.5 Run `git diff --check`.

## 6. Live Owner Gate

- [ ] 6.1 Run live canonical-mode dry-run for each statement stream only after copied-database validation passes.
- [ ] 6.2 Do not run live canonical apply until the owner explicitly approves the destructive retained-history mutation.
- [ ] 6.3 After any approved live apply, run the retained-size projection refresh and verify records/connections UI ratios for both statement streams.
