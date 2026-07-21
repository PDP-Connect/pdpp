## Context

The reference stores current records in `records` and retained history in `record_changes`. Two PDF-statement streams — `chase/statements` (1 instance, 5 keys, 33 versions) and `usaa/statements` (1 instance, 15 keys, 101 versions) — retain large histories that are almost entirely acquisition noise.

The statement record body for both connectors carries statement identity plus content-addressed blob pointers:

- Chase (`connectors/chase/index.ts:1324`): `id, account_id, title, date_delivered, account_reference, document_url, pdf_path, pdf_sha256, fetched_at`.
- USAA (`connectors/usaa/index.ts:650`): `id, account_id, title, date_delivered, account_reference, document_url, pdf_sha256, pdf_path, fetched_at`.

`pdf_sha256` is the sha256 of the **raw PDF bytes**, not the content. A read-only evidence lane established, at the byte level:

- Chase statement PDFs are RC4-encrypted (`pdfinfo`: `Encrypted: yes ... algorithm:RC4`). Two same-key blobs differ first at byte offset 35, inside the PDF encryption dictionary (per-download RC4 key material), and carry different `CreationDate`/`ModDate`. The decrypted text (`pdftotext`, empty password) and page count are identical. For all 4 comparable keys: distinct `pdf_sha256`, identical text sha, identical page count, zero text differences.
- `pdf_path` and `document_url` embed the `pdf_sha256`, so all three blob-identity fields move together on every re-download with zero owner-visible content change.
- USAA's connector already runs each statement PDF through `pdf-parse` text extraction (`connectors/usaa/statement-pdfs.ts:532` `extractPdfText`) and splits it into `transactions` with `source = pdf_statement_<YYYY-MM>`. Across 49 `pdf_sha256` changes, all 18 multi-version PDF-derived transaction keys are byte-identical content. USAA also has a real one-way `account_id` backfill in statements history: 9 null→value, 0 value→different, 0 value→null.

Today both streams' canonical fingerprint (connector no-op suppression and the compaction policy, bound together) excludes only `fetched_at`. The merged spec's compaction-policy requirement (`openspec/specs/reference-implementation-architecture/spec.md`, "The reference SHALL expose an owner/operator-only historical record-changes compaction tool") states for Chase statements that "only the run-clock `fetched_at` is excluded — every real source field remains a fingerprint boundary that is never collapsed," and lists USAA `statements` under `["fetched_at"]`. Under that rule `pdf_sha256`/`pdf_path`/`document_url` are fingerprint boundaries, so every RC4 re-encryption churn is a retained version and the streams cannot be canonically compacted without loss.

Prior art in this repo already proves the pattern for a sibling stream: `chase/transactions` is `changeModel: "immutable_semantic"` / `representativePolicy: "current"` and collapses run-clock-only churn while preserving every real field, validated on a copied database (`canonicalize-retained-record-history`). Gmail attachments already emit a content-addressed `content_sha256` field (`connectors/gmail/index.ts:1198`), establishing the field-shape precedent — though that is a blob sha, not a text-content sha, so `pdf_text_sha256` is genuinely net-new content.

## Goals / Non-Goals

**Goals:**

- Give `chase/statements` and `usaa/statements` a positive, owner-visible content fingerprint (`pdf_text_sha256`, `pdf_page_count`) so a re-download with unchanged content is provably a no-op without inspecting raw bytes.
- Make excluding the blob/acquisition-identity fields from the canonical fingerprint **lossless** by gating that exclusion on the presence of the positive content fields.
- Make both statement streams canonical-compaction-eligible, connector-independent of which connector produced them, reusing the canonical mode already shipped.
- Keep USAA's `account_id`/`account_reference` inside the fingerprint so the null→resolved FK backfill stays a version boundary.
- Validate the new policy on a copied/narrowed database before any live apply.

**Non-Goals:**

- No protocol-level PDPP Core change. The two fields are reference-connector record fields under the Collection Profile, not Core semantics.
- No change to the compaction tool's mode/selector machinery — that is owned by `canonicalize-retained-record-history`. This change only adds two content-gated eligible streams and the content-gated exclusion rule.
- No live canonical apply on either stream. Copied-DB validation only.
- No backfill of `pdf_text_sha256`/`pdf_page_count` onto historical `record_changes` rows. Historical versions that predate the fields keep the conservative `["fetched_at"]`-only fingerprint and are not collapsed against content-bearing versions; the content fingerprint takes effect forward and on re-download.
- No USAA accounts pre-split balance work. That is a separate data-migration proposal (see the evidence report); it is explicitly out of scope here.
- No deletion of backup tables or physical storage cleanup; that is a separate operational visibility surface.

## Decisions

### Emit a text-content fingerprint, not rely on the blob sha

`pdf_sha256` cannot prove content stability because it hashes encrypted bytes that the source regenerates per download. The connector must emit a fingerprint over the **decrypted, extracted text** plus structural page count. `pdf_text_sha256` is the sha256 of the extracted text after a deterministic normalization (Unicode NFC, collapse runs of whitespace including newlines to single spaces, trim) so that text-extractor whitespace/line-wrap jitter does not create false boundaries. `pdf_page_count` is the integer page count from the PDF structure. Two fields rather than one: page count is a cheap structural invariant that catches a re-issued statement whose text extraction collapsed (e.g. an image-only re-render) without changing the text sha, and it is independently owner-meaningful.

**Alternative considered:** a single combined `pdf_content_fingerprint`. Rejected — two named fields are independently legible to the owner and to the version-disposition surface, and `pdf_page_count` is useful on its own (it is what the evidence used as the structural invariant). Field names follow the existing `pdf_*` namespace already in the record body, so they read as siblings of `pdf_sha256`/`pdf_path`.

### Gate the blob-field exclusion on the presence of positive content fields

The canonical statement fingerprint excludes `["pdf_sha256", "pdf_path", "document_url", "fetched_at"]` **only when both `pdf_text_sha256` and `pdf_page_count` are present and non-null** on the version being compared. When either is absent, the fingerprint falls back to excluding only `["fetched_at"]` — identical to today's behavior. This is the load-bearing safety property: excluding the blob fields is lossless precisely because a positive content signal remains in the fingerprint to detect a genuinely re-issued statement for the same key. A version with no content fields carries no such signal, so its blob fields must stay boundaries.

The practical effect on existing histories: legacy index-only or pre-fingerprint versions (no content fields) are never collapsed against content-bearing versions, because their fingerprints are computed under different exclusion sets and will differ. The first content-bearing version per key is a real boundary; subsequent re-downloads with identical content collapse to the current survivor. This converges forward without rewriting or reinterpreting historical payloads.

**Alternative considered:** unconditionally exclude the blob fields (matching `chase/transactions`, which excludes only `fetched_at` but has no blob-identity churn). Rejected — for statements the blob fields are the *only* fields that move on a re-download, so unconditional exclusion of them with no positive content signal would make a re-issued statement invisible. The content gate is what makes the exclusion safe, and it is the difference between this stream class and the transactions class.

**Alternative considered:** exclude the blob fields whenever `pdf_text_sha256` alone is present. Rejected — requiring both fields fails closed against a partial extraction (text extracted but page count unavailable, or vice versa), which would otherwise drop blob fields with a weaker content signal.

### Keep `account_id`/`account_reference` in the USAA statement fingerprint

USAA statements have a proven, desirable one-way FK backfill (9 null→value). Those fields stay inside the fingerprint so the null→resolved transition remains a retained version boundary. Only the blob/acquisition-identity fields are content-gated out. Chase statements showed no such FK churn in the evidence (all 33 versions carried full shape), but the rule is written uniformly: only the four blob/acquisition fields are ever excluded, so `account_id`/`account_reference` remain boundaries for both connectors by construction.

### Bind connector no-op suppression and compaction to the same content-gated rule

Per the existing fingerprint-parity requirement, the compactor and the connector runtime SHALL use the same canonical fingerprint. Both statements cursors (`chase/index.ts:2109`, `usaa/index.ts:2321`) currently pass `excludeFromFingerprint: ["fetched_at"]`. They move to the content-gated exclusion. The compaction policy entries (`compact-record-history.mjs:227`, `:260`) move to the same content-gated `excludeKeys` and gain `changeModel: "immutable_semantic"` / `representativePolicy: "current"`. Parity tests must assert the two definitions agree, including the gate, and must fail closed if the connector helper cannot load.

**Alternative considered:** let compaction own an independent exclusion. Rejected for the same reason the canonicalize change rejected it — it lets a connector defect be hidden by a later tool and breaks the old-bad/new-good convergence proof.

### Connector-independence

The eligibility rule is expressed over the record shape (presence of the two content fields), not over which connector emitted the record. A future statement-bearing connector that emits `pdf_text_sha256`/`pdf_page_count` inherits the same canonical eligibility by declaring the policy, with no new rule. This satisfies the "make retained history rational and connector-independent" goal.

### Forward-only, no historical payload rewrite

Historical `record_changes` rows are not rewritten to add the content fields. The fields take effect on the next run (USAA re-uses its existing extraction; Chase gains extraction) and on any re-download. This keeps the change a pure additive-field + fingerprint-rule change and avoids a destructive payload migration. The copied-DB validation therefore proves convergence on the *forward* content-bearing series, and proves that legacy content-less versions are left intact (not collapsed).

## Risks / Trade-offs

- **Text-extraction nondeterminism** → mitigated by the normalization step (NFC + whitespace collapse + trim) so extractor jitter does not create false boundaries; the evidence already showed `pdftotext -raw` text was byte-stable across re-downloads, and USAA's `pdf-parse` output drives byte-stable transactions.
- **Encrypted/extraction failure** → if text extraction fails or returns empty, the connector emits `pdf_text_sha256: null` / `pdf_page_count: null` and the fingerprint falls back to `["fetched_at"]`-only (fails closed to today's conservative behavior). No statement is dropped.
- **Partial content signal** → requiring *both* fields present prevents dropping blob fields on a weak signal.
- **Over-collapsing a genuinely re-issued statement** → impossible while a content field remains in the fingerprint: a re-issue with different text or page count yields a distinct fingerprint and a retained boundary. This is the core safety argument and is asserted by a "real content change survives" scenario.
- **FK backfill loss (USAA)** → `account_id`/`account_reference` stay in the fingerprint; the null→value transition is a retained boundary, asserted by a dedicated scenario.
- **Legacy version collapse** → content-less historical versions use a different exclusion set, so they do not share a fingerprint with content-bearing versions and are not collapsed; asserted by a scenario.
- **Chase extraction cost / new dependency** → Chase gains a text-extraction path. It SHOULD reuse the same `pdf-parse` path USAA uses rather than introducing a second PDF library, keeping the dependency surface unchanged.
- **Over-claiming equality** → operator output and docs SHALL say canonical mode converges semantic content boundaries and current owner-visible state, not raw byte identity (the encrypted bytes still differ on disk).

## Acceptance Checks

Reproducible, copied-DB-only (no live apply). Each maps to a `tasks.md` checkbox.

1. **Field emission (unit).** A re-parse of a fixed statement PDF emits stable `pdf_text_sha256` and `pdf_page_count`; re-running on the same bytes yields identical values; the normalization collapses whitespace/line-wrap jitter to the same sha.
2. **Content-gated fingerprint parity (unit).** For a record carrying both content fields, the connector cursor and the compaction policy compute the same fingerprint excluding `["pdf_sha256","pdf_path","document_url","fetched_at"]`; for a record missing either field, both fall back to excluding only `["fetched_at"]`. Test fails closed if the connector helper cannot load.
3. **No-op on blob-only churn (unit).** Two versions identical except `pdf_sha256`/`pdf_path`/`document_url` (and `fetched_at`), both carrying identical content fields → `shouldEmit === false` and classified removable.
4. **Real content change survives (unit).** Two versions with different `pdf_text_sha256` or different `pdf_page_count` → distinct fingerprint, retained boundary, never collapsed.
5. **USAA FK backfill survives (unit).** Two versions differing only by `account_id` null→value → distinct fingerprint, retained boundary.
6. **Legacy content-less version not collapsed (unit).** A content-less version adjacent to a content-bearing version → different exclusion sets → distinct fingerprints → not collapsed.
7. **Copied-DB dry-run (audit).** On a copied `cin_029a67a16d8a252f6e3eb896/chase/statements` and `cin_bc1efca69a1c386d610f0924/usaa/statements`, audit-mode dry-run reports the conservative shape unchanged.
8. **Copied-DB dry-run (canonical).** Canonical-mode dry-run reports a non-zero `removableVersions` reducing each stream toward one current survivor per same-content run, with every current `records.version` anchored.
9. **Copied-DB apply (canonical).** Apply on the copied DB creates the backup table, removes only removable rows atomically, and every current `records` row still has a matching retained history row; `version_counter` unchanged.
10. **Idempotence.** Re-run canonical dry-run after apply → `removableVersions === 0`.
11. **OpenSpec + diff.** `openspec validate add-statement-content-fingerprint --strict`, `openspec validate --all --strict`, `git diff --check`.

## Migration Plan

1. Add `pdf_text_sha256`/`pdf_page_count` to the USAA statement record from its existing `pdf-parse` extraction; declare the manifest fields.
2. Add a statement text-extraction path to Chase (reusing the `pdf-parse` helper) and emit the two fields; declare the manifest fields.
3. Switch both statements cursors to the content-gated exclusion list.
4. Update both compaction policies to the content-gated `excludeKeys` plus `changeModel`/`representativePolicy`.
5. Add/strengthen unit and parity tests (acceptance checks 1–6).
6. Run copied-DB dry-run, apply, idempotence (checks 7–10).
7. Live dry-run and live apply remain explicit owner actions, recorded as the owner gate; not performed in this change.

## Open Questions

- Should the historical content-less `record_changes` versions eventually be backfilled with `pdf_text_sha256`/`pdf_page_count` (re-extracting from surviving blobs where present) so the legacy series can also collapse, or is forward-only convergence sufficient? Forward-only is chosen here; backfill would be a separate, blob-availability-limited migration (the store keeps ≤1 blob per statement key, so many historical versions are unrecoverable).
- Should the two content fields be promoted into a manifest-declared identity/fingerprint metadata block (alongside the deferred manifest-level identity/scan-kind question in `canonicalize-retained-record-history`) rather than living in connector code plus compaction policy? Deferred to that broader manifest-metadata question.
