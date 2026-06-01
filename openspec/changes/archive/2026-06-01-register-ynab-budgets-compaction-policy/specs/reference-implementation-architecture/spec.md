## MODIFIED Requirements

### Requirement: The reference SHALL expose an owner/operator-only historical record-changes compaction tool

The reference implementation SHALL provide an owner/operator-only operational tool that removes provably-redundant adjacent historical `record_changes` rows under a per-stream compaction policy that mirrors the connector's own no-op fingerprint definition. The tool is reference-implementation maintenance, not protocol behavior. It SHALL NOT affect PDPP Core semantics, public record reads, public `changes_since` responses, or grant enforcement.

The tool SHALL be authorized by direct database access (`PDPP_DATABASE_URL` or `PDPP_TEST_POSTGRES_URL`). It SHALL NOT be exposed via an HTTP route, a scheduler, or any automatic background job.

The tool SHALL maintain a registry of `(connector_id, stream)` compaction policies in code. Each policy SHALL declare the per-stream fingerprint definition (`excludeKeys` list, where an empty list means stable-stringify of the full `record_json`). The registry SHALL cover two policy families:

- **Connector fingerprint mirror.** Gmail `threads`, Slack `workspace` (with `fetched_at` excluded from the fingerprint), Slack `users`, Slack `files`, YNAB `payee_locations`, and YNAB `budgets` (with `last_month` and `last_modified_on` excluded from the fingerprint). Each policy SHALL declare the same fingerprint definition the corresponding connector uses to suppress no-op emits.
- **Exact stable-JSON identity for local-device connectors.** Codex (`messages`, `function_calls`, `sessions`, `skills`, `prompts`, `rules`) and Claude Code (`messages`, `attachments`, `sessions`, `skills`, `memory_notes`, `slash_commands`). Each policy SHALL declare an empty `excludeKeys` list. The policy is justified per-stream by verifying the `record_json` payload contains no `fetched_at`-style volatile field — adjacent versions with byte-identical canonical JSON are then strictly more conservative than the connector's own no-op-emit semantics could be.

Registering a new policy SHALL be a code-review gate that either references a connector-side fingerprint already in production (family 1) or documents the per-stream proof that the record payload contains no volatile field that would force exact-JSON identity to over-classify (family 2).

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
