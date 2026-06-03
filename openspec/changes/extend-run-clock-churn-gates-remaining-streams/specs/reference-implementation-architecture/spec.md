## MODIFIED Requirements

### Requirement: The reference SHALL expose an owner/operator-only historical record-changes compaction tool

The reference implementation SHALL provide an owner/operator-only operational tool that removes provably-redundant adjacent historical `record_changes` rows under a per-stream compaction policy that mirrors the connector's own no-op fingerprint definition. The tool is reference-implementation maintenance, not protocol behavior. It SHALL NOT affect PDPP Core semantics, public record reads, public `changes_since` responses, or grant enforcement.

The tool SHALL be authorized by direct database access (`PDPP_DATABASE_URL` or `PDPP_TEST_POSTGRES_URL`). It SHALL NOT be exposed via an HTTP route, a scheduler, or any automatic background job.

The tool SHALL maintain a registry of `(connector_id, stream)` compaction policies in code. Each policy SHALL declare the per-stream fingerprint definition (`excludeKeys` list, where an empty list means stable-stringify of the full `record_json`). The registry SHALL cover two policy families:

- **Connector fingerprint mirror.** Gmail `threads`, Gmail `labels` (with `excludeKeys` empty — the connector's per-label fingerprint hashes the stored body after excluding a synthetic keying `id` that is not part of `record_json`), Slack `workspace` (with `fetched_at` excluded from the fingerprint), Slack `users`, Slack `files`, YNAB `payee_locations`, YNAB `budgets` (with `last_month` and `last_modified_on` excluded from the fingerprint), USAA `statements` (with `fetched_at` excluded from the fingerprint), Chase `accounts` (with `fetched_at` excluded from the fingerprint), Chase `statements` (with `fetched_at` excluded from the fingerprint), Chase `transactions` (with `fetched_at` excluded from the fingerprint), USAA `accounts` (with `fetched_at` excluded from the fingerprint), USAA `credit_card_billing` (with `fetched_at` excluded from the fingerprint), USAA `transactions` (with `fetched_at` excluded from the fingerprint), USAA `inbox_messages` (with `fetched_at` excluded from the fingerprint), Chase `current_activity` (with `fetched_at` excluded from the fingerprint), and Amazon `orders` (with `fetched_at` excluded from the fingerprint). Each policy SHALL declare the same fingerprint definition the corresponding connector uses to suppress no-op emits. For USAA `transactions`, the body carries immutable posted-transaction source fields (`date`, `amount`, `original_description`, `balance_after_cents`, …) keyed by a hash of `accountId|date|amount|original|#ord`, shared across the CSV-export and PDF-statement emit paths; for USAA `inbox_messages`, the body carries a message keyed by `hashId(date_short|preview[:120])` whose only mutable field is the read/unread `status`; for Chase `current_activity`, the body carries a dashboard activity row keyed by `account_id|ui_transaction_id` (or an account-scoped fallback hash) whose mutable fields are the pending → posted transition (`status`/`posted_date`/`amount`); for Amazon `orders`, the body carries an order keyed by the immutable order id with a fixed total whose only mutable fields are the in-transit `delivery_status`/`status_detail`. In every case only the run-clock `fetched_at` is excluded — every real source field remains a fingerprint boundary that is never collapsed.
- **Exact stable-JSON identity for local-device connectors.** Codex (`messages`, `function_calls`, `sessions`, `skills`, `prompts`, `rules`) and Claude Code (`messages`, `attachments`, `sessions`, `skills`, `memory_notes`, `slash_commands`). Each policy SHALL declare an empty `excludeKeys` list. The policy is justified per-stream by verifying the `record_json` payload contains no `fetched_at`-style volatile field — adjacent versions with byte-identical canonical JSON are then strictly more conservative than the connector's own no-op-emit semantics could be.

Registering a new policy SHALL be a code-review gate that either references a connector-side fingerprint already in production (family 1) or documents the per-stream proof that the record payload contains no volatile field that would force exact-JSON identity to over-classify (family 2). A family-1 policy that excludes a run-clock field from a body containing real point-in-time state or immutable source data SHALL NOT exclude any real-state or source field; excluding only the run-clock field is lossless because any real change yields a distinct fingerprint that is retained as a version boundary.

The connector-side forward gate for a **partial-scan** stream (one whose run observes only an incremental window of records, not the full set — e.g. Chase `transactions` and USAA `transactions`, which download a per-account window starting at the prior watermark; Chase `current_activity`, which renders only the dashboard's recent rows; Amazon `orders`, which year-freezes historical years) SHALL NOT prune fingerprints for records it did not observe this run. Pruning a partial scan would drop fingerprints for records outside the window and re-emit them on the next overlapping window. Full-scan streams (e.g. Chase `accounts`, Chase `statements`, USAA `accounts`, USAA `inbox_messages`) MAY prune so a removed-then-re-added record re-emits.

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
