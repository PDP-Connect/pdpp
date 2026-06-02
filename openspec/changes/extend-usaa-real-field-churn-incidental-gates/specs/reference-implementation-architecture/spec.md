## MODIFIED Requirements

### Requirement: The reference SHALL expose an owner/operator-only historical record-changes compaction tool

The reference implementation SHALL provide an owner/operator-only operational tool that removes provably-redundant adjacent historical `record_changes` rows under a per-stream compaction policy that mirrors the connector's own no-op fingerprint definition. The tool is reference-implementation maintenance, not protocol behavior. It SHALL NOT affect PDPP Core semantics, public record reads, public `changes_since` responses, or grant enforcement.

The tool SHALL be authorized by direct database access (`PDPP_DATABASE_URL` or `PDPP_TEST_POSTGRES_URL`). It SHALL NOT be exposed via an HTTP route, a scheduler, or any automatic background job.

The tool SHALL maintain a registry of `(connector_id, stream)` compaction policies in code. Each policy SHALL declare the per-stream fingerprint definition (`excludeKeys` list, where an empty list means stable-stringify of the full `record_json`). The registry SHALL cover two policy families:

- **Connector fingerprint mirror.** Gmail `threads`, Gmail `labels` (with `excludeKeys` empty — the connector's per-label fingerprint hashes the stored body after excluding a synthetic keying `id` that is not part of `record_json`), Slack `workspace` (with `fetched_at` excluded from the fingerprint), Slack `users`, Slack `files`, YNAB `payee_locations`, YNAB `budgets` (with `last_month` and `last_modified_on` excluded from the fingerprint), USAA `statements` (with `fetched_at` excluded from the fingerprint), Chase `accounts` (with `fetched_at` excluded from the fingerprint), USAA `accounts` (with `fetched_at` excluded from the fingerprint), and USAA `credit_card_billing` (with `fetched_at` excluded from the fingerprint). Each policy SHALL declare the same fingerprint definition the corresponding connector uses to suppress no-op emits. For USAA `accounts` and USAA `credit_card_billing`, the record body carries real point-in-time financial fields (balances, available credit, rewards, APRs, billing status) that are NOT excluded — only the run-clock `fetched_at` is excluded, so any move in a real field remains a fingerprint boundary that is never collapsed.
- **Exact stable-JSON identity for local-device connectors.** Codex (`messages`, `function_calls`, `sessions`, `skills`, `prompts`, `rules`) and Claude Code (`messages`, `attachments`, `sessions`, `skills`, `memory_notes`, `slash_commands`). Each policy SHALL declare an empty `excludeKeys` list. The policy is justified per-stream by verifying the `record_json` payload contains no `fetched_at`-style volatile field — adjacent versions with byte-identical canonical JSON are then strictly more conservative than the connector's own no-op-emit semantics could be.

Registering a new policy SHALL be a code-review gate that either references a connector-side fingerprint already in production (family 1) or documents the per-stream proof that the record payload contains no volatile field that would force exact-JSON identity to over-classify (family 2). A family-1 policy that excludes a run-clock field from a body containing real point-in-time state SHALL NOT exclude any real-state field; excluding only the run-clock field is lossless because any real-state change yields a distinct fingerprint that is retained as a version boundary.

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

#### Scenario: The USAA real-field run-clock policies collapse pure run-clock churn but preserve every real financial state change

- **WHEN** a `usaa/accounts` or `usaa/credit_card_billing` key's history contains adjacent versions whose only difference is the run-clock `fetched_at`
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`["fetched_at"]`), matching the connector's per-record fingerprint no-op-emit definition
- **AND** a version that changes any retained real financial field — for example `balance_cents` on an account, or `current_balance_cents`, `cash_rewards_cents`, `available_credit_cents`, or `annual_percent_rate` on a credit-card billing record — SHALL remain a fingerprint boundary that is never collapsed
- **AND** every distinct real-state value that ever appeared in the history SHALL survive as a retained version boundary
