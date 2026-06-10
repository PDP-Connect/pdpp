## ADDED Requirements

### Requirement: Statement PDF streams SHALL carry a positive content fingerprint

The reference polyfill connectors that emit a PDF-statement stream (`chase/statements` and `usaa/statements`) SHALL emit, on each statement record, a positive owner-visible content fingerprint derived from the statement's content rather than from its raw bytes:

- `pdf_text_sha256` — the sha256 of the statement's extracted text after a deterministic normalization (Unicode NFC, runs of whitespace including newlines collapsed to a single space, leading/trailing whitespace trimmed).
- `pdf_page_count` — the integer page count from the PDF structure.

These fields SHALL be content-derived: `pdf_text_sha256` SHALL hash the decrypted, extracted text, NOT the raw (possibly encrypted) PDF bytes. The existing `pdf_sha256` SHALL remain the raw-byte content-address used for blob storage; it SHALL NOT be repurposed as the content fingerprint.

When text extraction fails or yields empty text, the connector SHALL emit `pdf_text_sha256: null` and `pdf_page_count: null` rather than omitting the fields or fabricating a value. Both connectors SHALL share one text-extraction and normalization path so the fingerprint is stable across connectors and across extractor whitespace/line-wrap jitter; a connector SHALL NOT introduce a second PDF-text library for this purpose.

The two fields SHALL be declared in the Chase and USAA connector manifests for the `statements` stream so they are owner-visible and grant-projectable like any other record field.

#### Scenario: A re-downloaded statement with unchanged content emits a stable content fingerprint

- **WHEN** a statement PDF is re-downloaded and re-extracted whose decrypted text and page count are unchanged from the prior version, even though its raw bytes (and therefore `pdf_sha256`) differ
- **THEN** the emitted `pdf_text_sha256` and `pdf_page_count` SHALL be identical to the prior version's values
- **AND** whitespace or line-wrap differences introduced by the text extractor SHALL NOT change `pdf_text_sha256` after normalization

#### Scenario: A genuinely re-issued statement emits a different content fingerprint

- **WHEN** a statement for the same key is re-issued with different text or a different page count
- **THEN** the emitted `pdf_text_sha256` or `pdf_page_count` SHALL differ from the prior version

#### Scenario: Extraction failure fails closed

- **WHEN** statement text extraction fails or returns empty text for a statement
- **THEN** the connector SHALL emit `pdf_text_sha256: null` and `pdf_page_count: null`
- **AND** SHALL NOT drop the statement record or fabricate a content fingerprint

### Requirement: Statement canonical fingerprint SHALL exclude blob identity only when content fields are present

For `chase/statements` and `usaa/statements`, the canonical record fingerprint used by both the connector's no-op emit suppression and the historical compaction policy SHALL exclude the blob/acquisition-identity fields `pdf_sha256`, `pdf_path`, `document_url`, and `fetched_at` **only when both `pdf_text_sha256` and `pdf_page_count` are present and non-null** on the version being fingerprinted. When either content field is absent or null, the fingerprint SHALL exclude only `fetched_at`, preserving the prior conservative behavior so a content-less version is never collapsed against a content-bearing version.

The canonical statement fingerprint SHALL keep `account_id` and `account_reference` inside the fingerprint for both connectors; these fields SHALL NOT be excluded. A statement whose `account_id` transitions from null to a resolved value SHALL therefore remain a retained version boundary.

The connector no-op fingerprint and the compaction policy fingerprint for each statement stream SHALL use the same content-gated exclusion rule, including the same presence gate. Parity coverage SHALL fail closed (not silently skip) if the connector fingerprint helper cannot load.

With the content fields present, the two statement streams SHALL be canonical-compaction-eligible (`changeModel: "immutable_semantic"`, `representativePolicy: "current"`) under the existing canonical retained-history compaction mode. The eligibility rule SHALL be expressed over the record shape (presence of the content fields), not over the emitting connector, so any statement-bearing connector that emits the content fields inherits the same canonical eligibility by declaring the policy.

This requirement SHALL NOT rewrite historical `record_json` payloads to add the content fields. Convergence SHALL be forward: versions emitted before the content fields exist keep the conservative `fetched_at`-only fingerprint and are not collapsed against content-bearing versions.

#### Scenario: Blob-only churn with identical content fields is a no-op

- **WHEN** two adjacent statement versions for the same key carry identical `pdf_text_sha256` and `pdf_page_count` and differ only in `pdf_sha256`, `pdf_path`, `document_url`, and `fetched_at`
- **THEN** the connector's no-op fingerprint SHALL classify the later version as a non-emit
- **AND** canonical compaction SHALL classify the redundant retained version as removable, retaining the current `records.version` survivor

#### Scenario: A real content change survives as a boundary

- **WHEN** two statement versions for the same key carry different `pdf_text_sha256` or different `pdf_page_count`
- **THEN** their canonical fingerprints SHALL differ
- **AND** canonical compaction SHALL retain a survivor for each distinct content fingerprint boundary

#### Scenario: The USAA account backfill stays a boundary

- **WHEN** a `usaa/statements` version transitions `account_id` from null to a resolved value while content is otherwise unchanged
- **THEN** the canonical fingerprint SHALL differ (because `account_id` is inside the fingerprint)
- **AND** canonical compaction SHALL retain the null→resolved transition as a version boundary

#### Scenario: A content-less version is never collapsed against a content-bearing version

- **WHEN** a statement key's history contains a version with no `pdf_text_sha256`/`pdf_page_count` adjacent to a version that carries them
- **THEN** the two versions SHALL be fingerprinted under different exclusion sets (`["fetched_at"]` versus `["pdf_sha256","pdf_path","document_url","fetched_at"]`)
- **AND** canonical compaction SHALL NOT collapse the content-less version into the content-bearing version

#### Scenario: Copied-database validation precedes any live statement apply

- **WHEN** `chase/statements` or `usaa/statements` is proposed for live canonical apply
- **THEN** the operator SHALL first validate the canonical dry-run, apply, and idempotence path on a copied or narrowed database and confirm no current row is orphaned before approving live mutation

## MODIFIED Requirements

### Requirement: The reference SHALL expose an owner/operator-only historical record-changes compaction tool

The reference implementation SHALL provide an owner/operator-only operational tool that removes provably-redundant adjacent historical `record_changes` rows under a per-stream compaction policy that mirrors the connector's own no-op fingerprint definition. The tool is reference-implementation maintenance, not protocol behavior. It SHALL NOT affect PDPP Core semantics, public record reads, public `changes_since` responses, or grant enforcement.

The tool SHALL be authorized by direct database access (`PDPP_DATABASE_URL` or `PDPP_TEST_POSTGRES_URL`). It SHALL NOT be exposed via an HTTP route, a scheduler, or any automatic background job.

The tool SHALL maintain a registry of `(connector_id, stream)` compaction policies in code. Each policy SHALL declare the per-stream fingerprint definition (`excludeKeys` list, where an empty list means stable-stringify of the full `record_json`). The registry SHALL cover three policy families:

- **Connector fingerprint mirror.** Gmail `threads`, Gmail `labels` (with `excludeKeys` empty — the connector's per-label fingerprint hashes the stored body after excluding a synthetic keying `id` that is not part of `record_json`), Slack `workspace` (with `fetched_at` excluded from the fingerprint), Slack `users`, Slack `files`, Slack `channel_memberships` (with `fetched_at` excluded from the fingerprint — the only other fields, `id`/`channel_id`/`user_id`, are the membership identity itself), YNAB `payee_locations`, YNAB `budgets` (with `last_month` and `last_modified_on` excluded from the fingerprint), USAA `statements` (content-gated, see below), Chase `accounts` (with `fetched_at` excluded from the fingerprint), Chase `statements` (content-gated, see below), Chase `transactions` (with `fetched_at` excluded from the fingerprint), USAA `accounts` (with `fetched_at` excluded from the fingerprint), USAA `credit_card_billing` (with `fetched_at` excluded from the fingerprint), USAA `transactions` (with `fetched_at` excluded from the fingerprint), USAA `inbox_messages` (with `fetched_at` excluded from the fingerprint), Chase `current_activity` (with `fetched_at` excluded from the fingerprint), and Amazon `orders` (with `fetched_at` excluded from the fingerprint). Each policy SHALL declare the same fingerprint definition the corresponding connector uses to suppress no-op emits. For Chase `transactions`, the body carries immutable posted-transaction source fields (`date`, `amount`, `name`, `memo`, `type`, …) keyed by `account_id|fitid`; only the run-clock `fetched_at` is excluded — every real source field remains a fingerprint boundary that is never collapsed. For Chase `statements` and USAA `statements`, the record body carries content-addressed PDF references (`document_url`/`pdf_path`/`pdf_sha256`, whose path embeds the raw-byte sha256), a positive content fingerprint (`pdf_text_sha256`/`pdf_page_count`), the statement identity, and the `account_id`/`account_reference` relation. Because the statement PDFs are re-encrypted per download (RC4 for Chase) so the raw bytes — and therefore `pdf_sha256`/`pdf_path`/`document_url` — move with no owner-visible content change, the statement policy is **content-gated**: it excludes `["pdf_sha256", "pdf_path", "document_url", "fetched_at"]` only when both `pdf_text_sha256` and `pdf_page_count` are present and non-null on the version, and otherwise excludes only `["fetched_at"]`. `account_id`/`account_reference` are never excluded, so a null→resolved account backfill remains a version boundary; `pdf_text_sha256`/`pdf_page_count` are never excluded, so a genuinely re-issued statement remains a boundary. For USAA `accounts` and USAA `credit_card_billing`, the record body carries real point-in-time financial fields (balances, available credit, rewards, APRs, billing status) that are NOT excluded — only the run-clock `fetched_at` is excluded, so any move in a real field remains a fingerprint boundary that is never collapsed. For USAA `transactions`, the body carries immutable posted-transaction source fields (`date`, `amount`, `original_description`, `balance_after_cents`, …) keyed by a hash of `accountId|date|amount|original|#ord`, shared across the CSV-export and PDF-statement emit paths; for USAA `inbox_messages`, the body carries a message keyed by `hashId(date_short|preview[:120])` whose only mutable field is the read/unread `status`; for Chase `current_activity`, the body carries a dashboard activity row keyed by `account_id|ui_transaction_id` (or an account-scoped fallback hash) whose mutable fields are the pending → posted transition (`status`/`posted_date`/`amount`); for Amazon `orders`, the body carries an order keyed by the immutable order id with a fixed total whose only mutable fields are the in-transit `delivery_status`/`status_detail`. In every non-statement case only the run-clock `fetched_at` is excluded — every real source field remains a fingerprint boundary that is never collapsed.
- **Exact stable-JSON identity for local-device connectors.** Codex (`messages`, `function_calls`, `sessions`, `skills`, `prompts`, `rules`) and Claude Code (`messages`, `attachments`, `sessions`, `skills`, `memory_notes`, `slash_commands`). Each policy SHALL declare an empty `excludeKeys` list. The policy is justified per-stream by verifying the `record_json` payload contains no `fetched_at`-style volatile field — adjacent versions with byte-identical canonical JSON are then strictly more conservative than the connector's own no-op-emit semantics could be.
- **Inventory churn gate for local-device inventory streams.** The `inventory_only`/`defer` metadata streams whose record bodies are produced by `buildLocalSourceInventory` / `listDirectoryInventory` and carry the incidental file-stat fields `mtime_epoch` and `size_bytes`: Claude Code (`backup_inventory`, `cache_inventory`, `config_inventory`, `file_history`) and Codex (`history`, `session_index`, `shell_snapshots`, `config_inventory`, `cache_inventory`, `logs`). Each policy SHALL declare `excludeKeys: ["mtime_epoch", "size_bytes"]`, mirroring the connector-side `openInventoryFingerprintCursor`. The inventory meaning of the record — its `relative_path`/`path_hash`, `type`, `classification`, and `reason` — remains inside the fingerprint and is never collapsed; only an adjacent version that differs solely in the incidental `mtime_epoch`/`size_bytes` file-stat metadata is removable. The freshness of the store (whether it exists and when the collector last looked) is carried by the `coverage_diagnostics` stream and the per-stream STATE `fetched_at`, not by re-versioning the inventory record.

Registering a new policy SHALL be a code-review gate that either references a connector-side fingerprint already in production (families 1 and 3) or documents the per-stream proof that the record payload contains no volatile field that would force exact-JSON identity to over-classify (family 2). A family-1 policy that excludes a run-clock field from a body containing real point-in-time state or immutable source data SHALL NOT exclude any real-state or source field; excluding only the run-clock field is lossless because any real change yields a distinct fingerprint that is retained as a version boundary. A family-1 **content-gated** statement policy SHALL exclude the blob/acquisition-identity fields only while a positive content fingerprint (`pdf_text_sha256` and `pdf_page_count`) is present in the version; excluding those fields is lossless precisely because a positive content signal remains in the fingerprint to detect a genuinely re-issued statement, and a version lacking that signal falls back to excluding only the run-clock field. A family-3 policy SHALL exclude only the incidental `mtime_epoch`/`size_bytes` file-stat fields; excluding them is lossless because any real inventory transition (a store appearing or disappearing, a file becoming a directory, a path-hash move, or a classification/reason change) yields a distinct fingerprint that is retained as a version boundary.

The connector-side forward gate for a **partial-scan** stream (one whose run observes only an incremental window of records, not the full set — e.g. Chase `transactions` and USAA `transactions`, which download a per-account window starting at the prior watermark; Chase `current_activity`, which renders only the dashboard's recent rows; Amazon `orders`, which year-freezes historical years) SHALL NOT prune fingerprints for records it did not observe this run. Pruning a partial scan would drop fingerprints for records outside the window and re-emit them on the next overlapping window. Full-scan streams (e.g. Chase `accounts`, Chase `statements`, USAA `accounts`, USAA `inbox_messages`) MAY prune so a removed-then-re-added record re-emits.

The connector-side inventory fingerprint cursor enumerates the known stores under the source home as a **full scan**, so it SHALL prune fingerprints for stores not observed this run; a store that disappears drops out of the cursor and re-emits exactly once when it returns.

The tool SHALL default to dry-run mode. In dry-run mode, for each in-scope `(connector_instance_id, stream)` it SHALL report `scannedKeys`, `scannedVersions`, `removableVersions`, `retainedVersionsAfter`, and `estimatedRemovedBytes`, and SHALL NOT modify any row.

The tool SHALL mutate rows only when invoked with an explicit `--apply` flag. With `--apply` it SHALL:

- create a per-run backup table `compact_record_history_backup_<runId>` with the same column shape as `record_changes` plus a `compacted_at` column;
- inside a single Postgres transaction per `(connector_instance_id, stream)` scope, INSERT every removable `record_changes` row into the backup table and DELETE those same rows from `record_changes`;
- assert the inserted and deleted row counts match before commit and SHALL roll back and exit non-zero if they do not.

The tool SHALL apply the following retention rule per `(connector_instance_id, stream, record_key)`:

- never remove the current row's version (the version present in `records`);
- never remove a tombstone (`deleted = TRUE`) row;
- never remove a non-tombstone row whose immediately-prior surviving row is a tombstone, even if their fingerprints match (tombstones bound compaction);
- never remove the first version for the key;
- never remove the most recent prior version whose fingerprint differs from the current row's fingerprint;
- remove a non-tombstone row whose immediately-prior surviving row is a non-tombstone with the same policy fingerprint and is not the current row.

The tool SHALL NOT mutate, delete, or insert any row in `records`. The tool SHALL NOT mutate `version_counter`. The tool SHALL NOT cross `(connector_instance_id, stream, record_key)` boundaries when comparing fingerprints. The tool SHALL NOT operate on any `(connector_id, stream)` pair that is not present in the registered compaction policies.

After a successful apply against a `(connector_instance_id, stream)` scope, the tool SHALL invalidate the retained-size projection for that scope so the existing rebuild path corrects retained-size accounting on the next pass.

#### Scenario: Dry-run reports removable versions without mutating

- **WHEN** the operator invokes the tool in dry-run mode for a `(connector_instance_id, stream)` scope containing a known-redundant series of adjacent same-fingerprint historical versions under a registered policy
- **THEN** the tool SHALL print a summary line with a non-zero `removableVersions` count and a non-zero `estimatedRemovedBytes`
- **AND** `record_changes`, `records`, `version_counter`, and the retained-size projection SHALL be byte-identical to their pre-invocation state

#### Scenario: Apply removes only removable versions, atomically, with a backup

- **WHEN** the operator invokes the tool with `--apply` against the same scope
- **THEN** the tool SHALL create `compact_record_history_backup_<runId>` and SHALL INSERT every removable row into it before DELETE-ing those rows from `record_changes`, inside a single transaction
- **AND** the surviving `record_changes` rows for each in-scope key SHALL be byte-identical to their pre-apply values
- **AND** the current `records` row for each in-scope key SHALL be byte-identical to its pre-apply payload
- **AND** `version_counter.max_version` for the scope SHALL be unchanged
- **AND** the retained-size projection for the scope SHALL be marked dirty for rebuild

#### Scenario: Tombstones bound compaction

- **WHEN** a key's `record_changes` history contains a tombstone row between two same-fingerprint non-tombstone rows
- **THEN** the tool SHALL NOT collapse the two non-tombstone rows into one
- **AND** the tombstone row SHALL be retained

#### Scenario: Unknown stream is refused

- **WHEN** the operator invokes the tool against a `(connector_id, stream)` pair not in the registered compaction policies
- **THEN** the tool SHALL exit non-zero before mutating any row
- **AND** the message SHALL name the registered policies

#### Scenario: Apply without database credentials is refused

- **WHEN** the operator invokes the tool with `--apply` but `PDPP_DATABASE_URL` and `PDPP_TEST_POSTGRES_URL` are both unset
- **THEN** the tool SHALL exit non-zero
- **AND** SHALL NOT create a backup table or modify any row

#### Scenario: The YNAB budgets policy collapses calendar-only churn but preserves genuine summary edits

- **WHEN** a `ynab/budgets` key's history contains adjacent versions whose only differences are `last_month` and `last_modified_on`
- **THEN** the tool SHALL classify those adjacent versions as removable under the `["last_month", "last_modified_on"]` fingerprint exclusion, matching the connector's `BUDGET_FINGERPRINT_EXCLUDE` no-op-emit definition
- **AND** a version that changes any retained budget-summary field (for example the budget `name`, currency locale, date format, or `first_month`) SHALL remain a fingerprint boundary that is never collapsed

#### Scenario: The run-clock / stored-body policies collapse pure run-clock churn but preserve genuine source changes

- **WHEN** a `gmail/labels`, `chase/accounts`, or `slack/channel_memberships` key's history contains adjacent versions whose only difference is the run-clock field (`fetched_at` for accounts/channel_memberships) or is byte-identical under the stored body (labels)
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`[]` for `gmail/labels`, `["fetched_at"]` for `chase/accounts` and `slack/channel_memberships`), matching the connector's per-record fingerprint no-op-emit definition
- **AND** a version that changes any retained source field (for example a renamed Gmail label, a renamed Chase account, or a Slack membership whose `channel_id`/`user_id` changes) SHALL remain a fingerprint boundary that is never collapsed

#### Scenario: The statement content-gated policies collapse blob-identity churn only with a positive content fingerprint

- **WHEN** a `chase/statements` or `usaa/statements` key's history contains adjacent versions that both carry `pdf_text_sha256` and `pdf_page_count` and differ only in `pdf_sha256`, `pdf_path`, `document_url`, and `fetched_at`
- **THEN** the tool SHALL classify those adjacent versions as removable under the content-gated `excludeKeys` (`["pdf_sha256", "pdf_path", "document_url", "fetched_at"]`), matching the connector's content-gated no-op-emit definition
- **AND** a version that changes `pdf_text_sha256` or `pdf_page_count` (a genuinely re-issued statement), or that changes `account_id`/`account_reference` (the null→resolved backfill), or that lacks the content fields (falling back to excluding only `["fetched_at"]`), SHALL remain a fingerprint boundary that is never collapsed
- **AND** every distinct content fingerprint that ever appeared in the history SHALL survive as a retained version boundary

#### Scenario: The Chase transactions run-clock policy collapses pure run-clock churn but preserves every real transaction change

- **WHEN** a `chase/transactions` key's history contains adjacent versions whose only difference is the run-clock `fetched_at`
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`["fetched_at"]`), matching the connector's per-record fingerprint no-op-emit definition
- **AND** a version that changes any retained real field — for example a corrected `amount` or `name` on a transaction — SHALL remain a fingerprint boundary that is never collapsed
- **AND** every distinct real value that ever appeared in the history SHALL survive as a retained version boundary

#### Scenario: The Chase transactions forward gate never prunes its partial incremental window

- **WHEN** a Chase run downloads a per-account QFX window that does not include an older transaction the connector emitted on a prior run
- **THEN** the connector's `transactions` fingerprint cursor SHALL retain that older transaction's fingerprint (it SHALL NOT `pruneStale` it)
- **AND** when a later, wider window re-downloads that older transaction unchanged, the retained fingerprint SHALL suppress the re-emit rather than appending a new run-clock-only version

#### Scenario: The USAA real-field run-clock policies collapse pure run-clock churn but preserve every real financial state change

- **WHEN** a `usaa/accounts` or `usaa/credit_card_billing` key's history contains adjacent versions whose only difference is the run-clock `fetched_at`
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`["fetched_at"]`), matching the connector's per-record fingerprint no-op-emit definition
- **AND** a version that changes any retained real financial field — for example `balance_cents` on an account, or `current_balance_cents`, `cash_rewards_cents`, `available_credit_cents`, or `annual_percent_rate` on a credit-card billing record — SHALL remain a fingerprint boundary that is never collapsed
- **AND** every distinct real-state value that ever appeared in the history SHALL survive as a retained version boundary

#### Scenario: The remaining run-clock policies collapse pure run-clock churn but preserve every real change

- **WHEN** a `usaa/transactions`, `usaa/inbox_messages`, `chase/current_activity`, or `amazon/orders` key's history contains adjacent versions whose only difference is the run-clock `fetched_at`
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`["fetched_at"]`), matching the connector's per-record fingerprint no-op-emit definition
- **AND** a version that changes any retained real field — for example a `balance_after_cents` move on a transaction, a read/unread `status` flip on an inbox message, a pending → posted transition (`status`/`posted_date`) on a current-activity row, or a `delivery_status` move on an order — SHALL remain a fingerprint boundary that is never collapsed
- **AND** every distinct real value that ever appeared in the history SHALL survive as a retained version boundary

#### Scenario: The partial-scan forward gates never prune records outside the current run's window

- **WHEN** a USAA, Chase, or Amazon run observes only a subset of a partial-scan stream's records (an overlapping incremental transaction window, the dashboard's recent current-activity rows, or the unfrozen subset of order years)
- **THEN** the connector's `usaa/transactions`, `chase/current_activity`, and `amazon/orders` fingerprint cursors SHALL retain the fingerprints of records not observed this run (they SHALL NOT `pruneStale` them)
- **AND** when a later run re-surfaces an unchanged record from outside the prior window, the retained fingerprint SHALL suppress the re-emit rather than appending a new run-clock-only version
- **AND** the full-scan `usaa/inbox_messages` cursor MAY prune a message no longer listed so a re-appearance re-emits exactly once

#### Scenario: The inventory churn-gate policies collapse pure file-stat churn but preserve every inventory transition

- **WHEN** a `claude-code/backup_inventory`, `codex/history`, or any other registered inventory churn-gate stream key's history contains adjacent versions whose only difference is the incidental `mtime_epoch`/`size_bytes` file-stat metadata
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`["mtime_epoch", "size_bytes"]`), matching the connector's `openInventoryFingerprintCursor` no-op-emit definition
- **AND** a version that changes any retained inventory field — the `relative_path`/`path_hash`, `type`, `classification`, or `reason` — SHALL remain a fingerprint boundary that is never collapsed
- **AND** the connector-side inventory fingerprint cursor SHALL prune a store no longer present so its re-appearance re-emits exactly once
