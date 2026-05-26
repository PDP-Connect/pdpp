## Why

Live Postgres history shows record-version churn that is not source mutation. Slack `workspace` has 31,160 versions for one record with only 253 distinct payloads (250 byte-identical writes in a single run window). Gmail `threads`, Slack `users`, Codex `rules`/`prompts`/`skills`, YNAB `payee_locations`, and Gmail `labels` show the same shape: hundreds of versions per distinct payload. Codex `sessions` separately regressed `message_count`/`function_call_count` to null in current rows where the prior run had recovered values; ~1,261 of 1,298 current Codex session rows are presently null but ~1,220 are recoverable from history.

Two root causes:

1. The Postgres ingest no-op check compares `JSON.stringify(current.record_json)` (an object node-postgres parsed back from jsonb, with keys in storage order) against the incoming `JSON.stringify(data)` (with keys in source order). The strings are byte-equal-length but never key-order-equal, so the no-op suppression at `postgres-records.js:449` is a permanent false negative on the Postgres adapter. The SQLite path stores `record_json` as TEXT and compares the verbatim string, so it is correct.
2. Codex's per-thread fingerprint cursor (commit `af1700ad`) prevents future lossy-null overwrites but does not repair already-collected current rows whose counts were clobbered before the cursor existed.

A forward fix without repair leaves the dashboard, retained-size accounting, and any future data explorer reading misleading history. A repair without a contract change risks the next adapter regressing the same way.

## What Changes

- Modify the existing "No-op writes do not allocate" requirement so byte-equivalence is defined over the canonical JSON of the stored record, not the adapter's incidental in-memory shape, and applies identically across SQLite and Postgres reference storage adapters.
- Fix `postgres-records.js` no-op detection so byte-identical incoming payloads do not allocate a new version, append a `record_changes` row, or perturb retained-size deltas.
- Add a reference-only owner-invoked repair tool that backfills current `records` rows whose payload is byte-equivalent (after canonicalization) to a recent history version with more complete derived fields, for connector streams where the connector authors a derived-field-preservation contract. The Codex `sessions` stream is the first such consumer.
- Require the repair tool to support dry-run preview, narrow scope (connector/stream/key filters), and audit logging; it SHALL NOT mutate sources, schemas, or history rows, and SHALL NOT introduce cross-`(connector_instance_id, stream, record_key)` dedupe.
- Add emitted/skipped/changed observability on the reference ingest path so future regressions of either kind become visible without re-querying history.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Production code: `reference-implementation/server/postgres-records.js`, narrow reference-implementation script under `reference-implementation/scripts/` for repair, ingest path counters and structured-log emission.
- Tests: targeted no-op false-negative regression test against the Postgres adapter (via the existing record-mutation conformance harness driver); a Codex-sessions repair unit test against fixtures.
- Out of scope: extracting a production `RecordStore`, new content-hash columns, history compaction or pruning, schema-level deduplication, cross-connection dedupe, or changes to public record / `changes_since` response shapes.
