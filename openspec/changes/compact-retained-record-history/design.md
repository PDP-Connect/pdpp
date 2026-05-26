## Context

The 2026-05-26 churn investigation closed the active source of churn — connectors now persist a per-record semantic fingerprint through their STATE cursors and skip emit on equality. The 2026-05-26 prior-art note nonetheless deferred *historical* compaction: the existing `record_changes` rows from the bug window are still inflating retained-size accounting and the dashboard, and only an explicit, owner-run, backed-up retention operation should remove them.

Two boundaries make this safe to do narrowly:

1. **The fingerprint is the connector's own no-op definition, not a new ontology.** For Gmail `threads`, Slack `workspace`/`users`/`files`, and YNAB `payee_locations`, the connector authored a semantic fingerprint as part of the cursor fix. A historical version whose fingerprint matches its immediate predecessor under the same policy is, by the connector's own definition, a redundant snapshot — the kind the connector now refuses to emit. Compacting it does not collapse any version transition the policy considers meaningful.
2. **The current `records` row is invariant.** Compaction only removes intermediate `record_changes` rows. The current row's payload, `version`, `emitted_at`, blob bindings, and grant-scoped reads are not affected. `version_counter.max_version` is not touched, so future ingests still allocate monotonically.

## Decision

### Scope (denylist by default)

The tool SHALL operate only on `(connector_id, stream)` pairs that have a registered policy. The initial registry is:

| connector            | stream            | fingerprint                                                                 |
| -------------------- | ----------------- | --------------------------------------------------------------------------- |
| `gmail`              | `threads`         | stable-stringify of full record_json                                        |
| `slack`              | `workspace`       | stable-stringify of record_json with `fetched_at` excluded                  |
| `slack`              | `users`           | stable-stringify of full record_json                                        |
| `slack`              | `files`           | stable-stringify of full record_json                                        |
| `ynab`               | `payee_locations` | stable-stringify of full record_json                                        |

Each policy entry SHALL list every `connector_id` value the policy applies to. In practice this is both the short name (`slack`) and the registry URL form (`https://registry.pdpp.org/connectors/slack`) the live deployment actually stores — same connector, two surface identifiers. Adding a policy means accepting both forms so the operator does not have to translate.

These mirror the canonical authoring-layer fingerprint at `packages/polyfill-connectors/src/fingerprint-cursor.ts:recordFingerprint` (shipped in `228305a6`) and the still-hand-rolled `connectors/gmail/parsers.ts:buildThreadFingerprint` and `connectors/ynab/index.ts:payeeLocationFingerprint`. Slack's per-stream excludeKeys come from `connectors/slack/index.ts:FINGERPRINT_EXCLUDE`; the workspace exclusion of `fetched_at` is preserved verbatim — without exclusion, the connector's own gate would never fire (per `a08d7a0a`'s commit message).

The script ships its own copy of `recordFingerprint` so this operational `.mjs` tool does not depend on a compiled TypeScript artifact or a runtime TS shim. Drift between the two implementations is prevented by `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`, which asserts byte-identical hex output across representative payloads for every registered policy plus adversarial nested-object/null-leaf fixtures. Adding a new policy requires extending that parity fixture set.

The script SHALL refuse any other `connector_id`/`stream` invocation with a non-zero exit code listing the registered policies.

Adding a new policy is a code-review gate: the policy must reference a connector-side fingerprint definition already in production, and the owner must confirm the fingerprint covers the semantic content the user would consider "the record."

### Retention rule

For each `(connector_instance_id, stream, record_key)` in scope, the script SHALL:

1. Read all `record_changes` rows for that key in `version ASC` order.
2. Compute the policy fingerprint on `record_json` for each non-tombstone row. (Tombstones — `deleted = TRUE` — are never compacted.)
3. Walk versions in order; mark a version as removable iff (a) it is not a tombstone, (b) the immediately-prior surviving version is not a tombstone, (c) both have the same fingerprint, and (d) it is not the current row's version.
4. Always retain: the lowest version for the key, the current row's version, every tombstone, and the immediately-prior version whose fingerprint differs from the current row.

Tombstones are retention boundaries. A `deleted=TRUE` row marks a real state transition the user would expect to see in history; we never coalesce around it.

The current row's `version` is read from the `records` table and treated as a hard retention pin. The script SHALL fail-closed if no current row exists for a key (the key was deleted out from under us mid-run).

### Backup and apply safety

Dry-run is the default. With `--apply`, the script SHALL:

1. Generate a `runId` (timestamp + random suffix).
2. Create table `compact_record_history_backup_<runId>` with the same column shape as `record_changes` (plus a `compacted_at` column).
3. Inside a single Postgres transaction per `(connector_instance_id, stream)` scope:
   - `INSERT INTO compact_record_history_backup_<runId> (...) SELECT ... FROM record_changes WHERE ...` for every removable version.
   - `DELETE FROM record_changes WHERE (connector_instance_id, stream, version) IN (...)`.
   - Assert the insert and delete row counts match.
   - Commit.

If any assertion fails, the transaction SHALL roll back and the script SHALL exit non-zero. The backup table persists after commit as the operator's rollback handle (re-insertable into `record_changes`).

The script SHALL refuse `--apply` if `PDPP_DATABASE_URL` (or `PDPP_TEST_POSTGRES_URL`) is unset. Authorization is by direct database access, the same model as `record-derived-field-backfill.mjs` — no HTTP route, no scheduler.

The script SHALL accept `--connector-instance-id`, `--stream`, optional `--connector-id` (defaults inferred from `connector_instances`), `--limit-keys` (positive integer, caps how many keys to scan per invocation), and `--apply`. An invalid `--limit-keys` SHALL cause the script to refuse to run.

### Read-model invalidation

After a successful apply, the script SHALL call `markRetainedSizeStreamDirty({ connectorInstanceId, stream })`. The existing rebuild/reconcile path handles re-projection. The script SHALL NOT manually adjust `record_history_count` — the projection is rebuildable from ground truth and any direct delta arithmetic would just recreate the projection-drift class of bug the churn report flagged.

### What the script SHALL NOT do

- SHALL NOT mutate or delete any row in `records`.
- SHALL NOT touch `version_counter` (deletions of historical versions don't lower `max_version`; the counter remains an append-only allocator).
- SHALL NOT mutate the surviving `record_changes` rows.
- SHALL NOT operate on streams without a registered policy.
- SHALL NOT cross `(connector_instance_id, stream, record_key)` boundaries — every fingerprint comparison stays within one key.
- SHALL NOT delete tombstones, the first version for a key, the current version, or the most recent version whose fingerprint differs from current.
- SHALL NOT skip backup. Apply without backup is forbidden.
- SHALL NOT run automatically on a schedule.

## Alternatives Considered

- **Bulk DELETE without fingerprint policy** (delete every `record_changes` row except current). Rejected: destroys real history for streams with no churn policy (Codex, messages, etc.) and violates the prior-art note's "narrow, policy-driven" requirement.
- **Content-hash column on `record_changes`** so comparisons happen in SQL only. Rejected: requires a schema migration on a 14M-row table for a one-off operation. The connector already computes the same hash on emit; we just recompute it here on the ~3M rows in scope.
- **In-database fingerprint UDF**. Rejected: the fingerprint must match the connector's `stableStringify` exactly. Re-implementing it in PL/pgSQL is more code than re-implementing it in 15 lines of node and risks divergence as connectors evolve.
- **Postgres `pg_dump` external backup script**. Rejected: a per-run backup table inside the same transaction as the delete is atomic and self-rollback-able. A shell-script `pg_dump` is operator-friction without a safety win.
- **Touch `version_counter.max_version`** to "reclaim" version numbers. Rejected: monotonic allocation is the contract; gaps in `version` are fine and already exist after no-op suppression.
- **Hook into the existing rebuild path to compact during rebuild**. Rejected: conflates retention (destructive) with read-model rebuild (recoverable). Keeping them separate means the rebuild can run any time without losing data.
- **Per-version delete instead of per-stream batch**. Rejected: per-stream transaction with bulk INSERT … SELECT then DELETE is the simplest atomic shape and Postgres handles it well.

## Stop Conditions

Stop and report for owner review if implementation requires any of:

- a schema migration to `records`, `record_changes`, or `version_counter`;
- mutating any surviving `record_changes` row;
- compacting a stream without a registered fingerprint policy;
- crossing `(connector_instance_id, stream, record_key)` boundaries;
- changing public `/v1/records`, `/v1/records/changes_since`, or `/_ref/` shapes;
- removing the dry-run-default or apply-requires-backup gates.

## Acceptance Checks

- `openspec validate compact-retained-record-history --strict` passes.
- Pure-helper tests: fingerprint computation matches a known fixture for each of the five policies; the retention selector preserves first/current/tombstone/fingerprint-boundary rows and marks adjacent same-fingerprint intermediate rows removable; refuses unknown streams; rejects invalid `--limit-keys`.
- Postgres-backed test (gated on `PDPP_TEST_POSTGRES_URL`): seeds a `(connector_instance_id, stream)` workspace key with six versions whose only differences are `fetched_at` — the live churn shape the policy is designed for. Dry-run reports four removable. Apply removes exactly four rows, populates the backup table with exactly those four rows, leaves the current row in `records` untouched, leaves `version_counter.max_version` unchanged, and marks the retained-size projection dirty.
- Postgres-backed no-op safety test: a stream where every version differs in fingerprint produces zero removable in dry-run, and `--apply` is a no-op (no backup table populated beyond zero rows; or no backup table created at all — implementation choice).
- Postgres-backed unknown-stream test: invoking with `--stream=messages` against a Slack instance refuses to run.
