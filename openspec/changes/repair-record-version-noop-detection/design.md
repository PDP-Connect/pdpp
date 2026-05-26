## Context

`harden-record-version-allocation-atomicity` made version allocation atomic and stated that no-op re-ingests SHALL NOT allocate. The requirement is correct, but the Postgres reference adapter does not satisfy it. The SQLite adapter does, because SQLite stores `record_json` as TEXT and compares it verbatim. Postgres stores `record_json` as `jsonb`, and `node-postgres` parses jsonb back into a JS object whose key order matches Postgres' internal storage (length-then-lexicographic). `JSON.stringify` of that object produces a string with reordered keys, so byte-identical re-ingests always look "changed."

Two pieces of live evidence:

- Slack `workspace`: 31,160 versions, 1 record, 253 distinct payloads — the most recent 250 versions share an identical md5. This is impossible if the adapter ever suppresses a byte-identical re-ingest.
- Codex `sessions` for session `019d922d-c38b-7e11-ae99-9187af386148`: 144 versions, 46 carrying `message_count` / `function_call_count` and 98 with both fields null. The current row is at version 177115 with both fields null; version 175854 (the immediately prior non-null) still carries `34257` / `59289`. The Codex fingerprint cursor will prevent further regressions on new runs but leaves this row and ~1,220 sibling rows mis-stated.

## Decision

### No-op equivalence

No-op equivalence SHALL be defined per adapter against the form the adapter stores, in a way that does not depend on incidental layout differences (whitespace, key order) the adapter introduces on its own:

- SQLite stores `record_json` as TEXT verbatim. The adapter compares the stored TEXT against the inbound `JSON.stringify(data)` as a string. This is already correct.
- Postgres stores `record_json` as `jsonb`. The adapter SHALL compare structurally at the `jsonb` level: a `record_json = $::jsonb` (or `IS NOT DISTINCT FROM`) predicate evaluated server-side against the inbound serialized payload. `jsonb` equality is structural — two values are equal iff they have the same keys and values, regardless of whitespace or key order. The naive `JSON.stringify(current.record_json) === incoming` comparison fails on Postgres for two reasons: (1) Postgres' `::text` output adds whitespace after colons and commas, and (2) `node-postgres` returns jsonb as a JS object whose key order matches Postgres' internal storage rather than the original inbound order. Either gap turns identical re-ingests into version churn.

Postgres' `jsonb` representation already discards original key order and whitespace on first ingest, so this is the equivalence the adapter has *de facto* committed to. Choosing it for the comparison aligns the no-op decision with the storage model rather than fighting it.

For SQLite, switching from string equality to a structural equivalence would mean either parsing TEXT to JSON on every ingest (expensive) or canonicalizing on write (a content change). Neither is needed — SQLite's TEXT comparison already preserves no-op semantics. Asymmetry between adapters is acceptable here because each adapter compares against the form it stores; both adapters satisfy the same external requirement that "byte-identical re-ingests do not allocate."

### Repair tooling

Repair is a reference-implementation operational concern, not a protocol-level mechanism. The repair tool SHALL:

- Be invoked explicitly by an operator with owner-token authorization. It does not run on a schedule.
- Take connector / stream / record-key filters and SHALL refuse to operate without at least a `(connector_instance_id, stream)` scope.
- Support a dry-run mode that emits an exact preview of which rows would change, what fields would be refilled, and from which prior version each refill is sourced.
- Only repair records where the current row's payload is byte-equivalent (under the no-op definition above) to a prior history version that has strictly more complete derived fields per a connector-supplied policy.
- For Codex `sessions`, the policy is: if current `message_count` is null and a prior `record_changes` row for the same key carries a non-null `message_count` with otherwise byte-equivalent payload, refill `message_count` (and similarly `function_call_count`). The repair SHALL fall back to the most recent prior non-null value, never reach across record keys, and never cross `connector_instance_id`.
- Allocate a new version through the existing atomic allocator (treating the repair as a new mutation), so the repair is itself visible in `record_changes` and `changes_since`. The repair SHALL NOT rewrite history rows.
- Refuse to operate on streams that have not registered a repair policy. New policies require code review.

This keeps the repair narrow, auditable, and inside the existing append-only contract.

### Observability

The reference ingest path SHALL emit a structured log line per ingest with one of `outcome=changed`, `outcome=noop_byte_equivalent`, or `outcome=noop_delete_absent`. The log SHALL include `connector_id`, `connector_instance_id`, `stream`, and a hashed `record_key` (raw key may contain personal data). This restores observability for the class of bug this change repairs without persisting a new column.

The dashboard summary read model already tracks retained-size and per-stream record counts. No new read-model surface is required for this change; emitted/skipped telemetry is sufficient to detect future regressions in CI and ad-hoc inspection.

## Alternatives Considered

- **Content-hash column on `records`.** Persisting a hash would speed up no-op detection but introduces a schema migration, doubles writes, and needs cross-adapter agreement on hashing. The simpler `::text` comparison is correct without new state.
- **Semantic-key normalization (sorted-keys / canonical-form JSON).** Would catch connector-emitted key reordering. Rejected for this change — the failure today is the adapter, not connectors. Adding semantic equivalence is a larger contract change with cross-connector implications (some streams legitimately re-order keys to signal source mutation) and belongs in its own proposal if motivated.
- **Compact existing history.** Pruning byte-identical successive versions in `record_changes` would shrink retained size but is destructive and removes audit evidence of how the bug behaved. Deferred. A retention policy belongs in a separate change scoped to retention/compaction, not no-op correctness.
- **In-connector deduplication.** Asking connectors to compute their own no-op cursors works for some sources (Codex did it), but cannot help adapters that re-process unchanged records on every run (Slack workspace endpoint always returns the live row). Adapter-level suppression is the load-bearing fix.

## Stop Conditions

Stop for owner review if the implementation:

- requires schema changes to `records`, `record_changes`, or `version_counter`;
- introduces cross-`(connector_instance_id, stream, record_key)` dedupe or repair;
- mutates existing `record_changes` rows;
- needs to change public `/v1/records`, `/v1/records/changes_since`, or `/_ref/` response shapes;
- requires destructive deletion of any record or change row to make the repair correct.

## Acceptance Checks

- Targeted test: against the Postgres-backed adapter, two byte-identical successive `postgresIngestRecord` calls allocate at most one version, append at most one `record_changes` row, and return `{ accepted: true, changed: false }` on the second call.
- Targeted test: SQLite no-op behavior unchanged (existing conformance test stays green).
- Targeted test: Codex `sessions` repair backfills `message_count` / `function_call_count` for a fixture where the current row is null and a prior change row has the value, without touching unrelated records or rewriting history.
- Dry-run preview of the live Codex `sessions` repair lists session `019d922d-c38b-7e11-ae99-9187af386148` and reports the source version (175854) it would refill from.
- New structured ingest log line is emitted on both adapters with the documented `outcome` vocabulary, observable by tailing the reference server in development.
- `openspec validate repair-record-version-noop-detection --strict` and `openspec validate --all --strict` both pass.
