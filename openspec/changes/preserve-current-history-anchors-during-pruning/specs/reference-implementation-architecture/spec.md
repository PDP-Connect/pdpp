## MODIFIED Requirements

### Requirement: Durable record ingest SHALL be atomic

The reference implementation SHALL treat durable record ingest as one atomic mutation of live record state, per-stream version state, and record change history. Search-index maintenance and disclosure-spine observability SHALL remain outside this durable record mutation unit unless a later OpenSpec change explicitly widens the boundary.

When `PDPP_CHANGE_HISTORY_LIMIT` bounds retained history, the prune step inside the durable ingest unit SHALL NOT delete the `record_changes` row that anchors a current `records` row for the same `(connector_instance_id, stream, record_key)` — the retained history row whose `version` equals the current `records` row's `version`. A pure per-stream version cutoff SHALL NOT be used, because the per-stream version advances on every key's mutation and would otherwise delete the anchor of an unchanged ("cold") current row once other ("hot") keys advance the stream past that key's retention horizon, stranding the current row with no retained history to prove it. Pruning SHALL remain bounded for changing keys: only the single anchor row per live key is exempt; older history for that key and all history of keys whose current row has since advanced SHALL still prune.

The retained-size and dataset-summary delta accounting for a prune SHALL count and sum exactly the rows the prune deletes, using the same anchor-preserving predicate, so the read models do not over-report pruned rows or bytes for keys whose anchor is retained.

#### Scenario: Successful record mutation

- **WHEN** the reference ingests a record whose payload changes durable state
- **THEN** the live `records` row, appended `record_changes` row, and `version_counter` advance SHALL commit as one atomic unit
- **AND** the appended `record_changes.version` SHALL be the version recorded by `version_counter` for that `(connector_id, stream)` after the commit

#### Scenario: No-op re-ingest

- **WHEN** the reference ingests a record whose durable payload is identical to the current live state
- **THEN** it SHALL NOT append a `record_changes` row
- **AND** it SHALL NOT advance `version_counter`

#### Scenario: Repeated delete

- **WHEN** the reference receives a delete for a record that is already deleted or absent
- **THEN** it SHALL NOT append a duplicate delete change
- **AND** it SHALL NOT advance `version_counter`

#### Scenario: Durable mutation failure

- **WHEN** an error occurs before the durable ingest mutation commits
- **THEN** the reference SHALL NOT leave `records`, `record_changes`, and `version_counter` in a partially advanced state
- **AND** a later ingest for the same `(connector_id, stream)` SHALL NOT collide with or skip around a partially written version

#### Scenario: Derived index maintenance

- **WHEN** durable record ingest commits successfully
- **THEN** lexical and semantic index maintenance MAY run after the commit as derived maintenance
- **AND** failure in derived index maintenance SHALL NOT retroactively partially commit or roll back the durable record mutation

#### Scenario: History pruning preserves a cold-key anchor while the stream advances

- **WHEN** a current `records` row for a key is at version `V` and unchanged, and other keys advance the per-stream version past `V + PDPP_CHANGE_HISTORY_LIMIT`
- **THEN** the prune step SHALL retain the `record_changes` row at version `V` for that key
- **AND** the current projection for that key SHALL remain provable from retained history (no `unresolved_pruned` row is created by pruning)
- **AND** history for changing keys SHALL still be bounded by `PDPP_CHANGE_HISTORY_LIMIT`

#### Scenario: History pruning preserves a deleted-key tombstone anchor

- **WHEN** a current `records` row is a tombstone at version `V` (the key was deleted) and other keys advance the per-stream version past `V + PDPP_CHANGE_HISTORY_LIMIT`
- **THEN** the prune step SHALL retain the deleted `record_changes` row at version `V` for that key
- **AND** the key SHALL remain in the consistent `(deleted latest history, deleted current)` state, neither resurrected nor orphaned

### Requirement: Direct record delete SHALL be atomic

The reference implementation SHALL treat direct owner-authenticated record delete as one atomic mutation of live record state, per-stream version state, and record change history. Search-index maintenance and disclosure-spine observability SHALL remain outside this durable record mutation unit unless a later OpenSpec change explicitly widens the boundary.

When `PDPP_CHANGE_HISTORY_LIMIT` bounds retained history, the prune step inside the durable delete unit SHALL preserve current-history anchors under the same rule as durable ingest: it SHALL NOT delete the `record_changes` row whose `version` equals a current `records` row's `version` for the same `(connector_instance_id, stream, record_key)`, and the retained-size and dataset-summary delta accounting for the prune SHALL use the same anchor-preserving predicate as the prune DELETE.

#### Scenario: Successful direct delete

- **WHEN** the reference directly deletes an existing live record
- **THEN** the live `records` row delete marker, appended deleted `record_changes` row, and `version_counter` advance SHALL commit as one atomic unit
- **AND** the appended `record_changes.version` SHALL be the version recorded by `version_counter` for that `(connector_id, stream)` after the commit

#### Scenario: No-op direct delete

- **WHEN** the reference directly deletes a record that is absent or already deleted
- **THEN** it SHALL NOT append a `record_changes` row
- **AND** it SHALL NOT advance `version_counter`

#### Scenario: Direct delete mutation failure

- **WHEN** an error occurs before the durable direct-delete mutation commits
- **THEN** the reference SHALL NOT leave `records`, `record_changes`, and `version_counter` in a partially advanced state
- **AND** a later mutation for the same `(connector_id, stream)` SHALL NOT collide with or skip around a partially written version

#### Scenario: Derived index delete maintenance

- **WHEN** durable direct record delete commits successfully
- **THEN** lexical and semantic index delete maintenance MAY run after the commit as derived maintenance
- **AND** failure in derived index delete maintenance SHALL NOT retroactively partially commit or roll back the durable direct delete mutation

#### Scenario: Delete-path pruning preserves a still-current anchor

- **WHEN** a delete advances the per-stream version and the prune step runs, while a different unchanged key's current `records` row sits below the prune cutoff
- **THEN** the prune step SHALL retain that other key's anchor `record_changes` row
- **AND** the prune SHALL NOT strand any current row whose key was not the delete target

## ADDED Requirements

### Requirement: The reference SHALL expose an owner/operator-only all-stream current-projection drift scanner

The reference implementation SHALL provide an owner/operator-only, read-only operational tool that audits the current `records` projection against the authoritative `record_changes` history across every `(connector_instance_id, stream)` in the Postgres store in a single scan, optionally filtered to one `connector_id`. The tool is reference-implementation maintenance, not protocol behavior. It SHALL NOT affect PDPP Core semantics, public record reads, public `changes_since` responses, or grant enforcement.

The tool SHALL be authorized by direct database access (`PDPP_DATABASE_URL`, with `PDPP_TEST_POSTGRES_URL` accepted as a fallback). It SHALL NOT be exposed via an HTTP route, a scheduler, or any automatic background job. It SHALL NOT mutate, insert, or delete any row. It SHALL NOT print raw record payloads, personal text, secrets, cookies, or tokens; every preview SHALL carry only versions, deleted flags, byte counts, payload-equality booleans, and truncated identifiers, with the payload comparison (`record_json IS NOT DISTINCT FROM`) computed in SQL.

The tool SHALL classify each drifting `(connector_instance_id, stream, record_key)` into exactly one of the following classes and SHALL report a remediation disposition per class:

- `missing_current` — latest retained history is non-deleted, but no usable current row exists. Disposition: repairable from latest retained history.
- `stale_current` — a live current row is behind the latest non-deleted retained history (same-version payload disagreement, or an older live current version). Disposition: repairable from latest retained history.
- `latest_deleted` — the latest retained history row is a tombstone, but a non-deleted current row survives. Disposition: owner-gated delete reconciliation.
- `current_payload_matches_latest_history_but_version_differs` — a live current row whose version differs from the latest retained history version, but whose payload is byte-equal to that latest history row. Disposition: safe current-version correction (no source resync).
- `unverified_current_payload_differs_from_latest_history` — a live current row whose version differs from the latest retained history version and whose payload differs from it. Disposition: source resync required.
- `current_version_newer_than_retained_history` — the current row's version is strictly greater than every retained history row for the key. Disposition: source resync or owner-gated synthetic maintenance anchor.
- `current_no_retained_history` — the current row's key has no retained `record_changes` at all. Disposition: source resync or owner-gated synthetic maintenance anchor.

The tool SHALL exit non-zero when any drift is found and zero when the projection is consistent, so an operator or CI can branch on "needs remediation". The tool SHALL NOT write a synthetic `record_changes` anchor; synthetic maintenance anchoring is owner-gated and out of scope for this read-only tool.

#### Scenario: Clean projection reports no drift

- **WHEN** the operator runs the scanner against a store whose current projection agrees with retained history everywhere in scope
- **THEN** the scanner SHALL report zero drift across all classes
- **AND** it SHALL exit zero
- **AND** it SHALL NOT mutate any row

#### Scenario: Mixed drift is classified by remediation disposition

- **WHEN** the operator runs the scanner against a store containing rows of several drift classes
- **THEN** the scanner SHALL report each class's count and one payload-free preview per drifting key with its remediation disposition
- **AND** it SHALL distinguish a version-only disagreement whose payload byte-equals the latest retained history (safe version correction) from one whose payload differs (source resync)
- **AND** it SHALL exit non-zero

#### Scenario: Scanner never emits payloads

- **WHEN** the scanner reports drift previews in either human or JSON form
- **THEN** the output SHALL contain only versions, deleted flags, byte counts, payload-equality booleans, and truncated identifiers
- **AND** it SHALL NOT contain any `record_json` payload, personal text, secret, cookie, or token
