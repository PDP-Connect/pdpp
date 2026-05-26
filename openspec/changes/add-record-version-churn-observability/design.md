## Context

The reference stores current records in `records` and retained history in `record_changes`. That history is intentionally implementation-internal: PDPP Core exposes snapshot-style reads and `changes_since`, not a public record-version log. The reference still needs operator observability because the live deployment showed that a storage-adapter no-op bug and a connector parser bug can inflate history and corrupt derived current fields before the dashboard makes the problem obvious.

The prior-art note at `design-notes/record-version-semantics-prior-art-2026-05-26.md` supports a narrow construction:

- keep current-state reads separate from append-only history;
- treat no-op/idempotency at the storage boundary as essential construction;
- advance connector state only after destination-confirmed progress;
- surface churn/retention risk through bounded operational stats;
- keep compaction explicit and reversible rather than automatic.

## Decision

Add a reference-only version-churn read. The read reports aggregate facts over durable state and helps answer: "which connections/streams are producing much more history than current records?"

The read SHALL be bounded by grouped `(connector_instance_id, stream)` rows. It must not return raw payloads or require the dashboard to scan/parse individual JSON records. The first implementation uses the retained-size projection because it already maintains current record counts, retained-history counts, dirty state, and computed timestamps across SQLite and Postgres. That avoids introducing another raw corpus aggregation on `/records`, while keeping the response contract compatible with a future exact grouped aggregation if needed.

## Row Shape

Each row should include:

- `connector_id`
- `connector_instance_id`
- owner-facing display name when available
- `stream`
- `current_record_count`
- `record_history_count`
- `versions_per_record`
- `last_history_at`
- `last_current_at`
- `projection_dirty`
- `risk_level`: `normal`, `watch`, or `high`
- `risk_reasons`: machine-readable short strings

Risk classification is reference-only guidance, not protocol truth. Initial thresholds:

- `normal`: fewer than 5 history versions per current record, unless other evidence says otherwise.
- `watch`: at least 5 versions per current record.
- `high`: at least 50 versions per current record or at least 10,000 history rows with at least 10 versions per current record.

These thresholds are deliberately simple. They should identify obvious anomalies, not decide whether data is wrong.

## Endpoint

Add an owner-only reference read:

- `GET /_ref/records/version-stats`

Query parameters:

- `connector_instance_id` optional exact filter
- `stream` optional exact filter
- `risk` optional filter over `normal|watch|high`
- `limit` capped, default 100, maximum 500

The route remains `_ref` only. It must not appear as a public `/v1` RS capability.

## Dashboard Use

The dashboard may use this to surface a small "version churn" diagnostic section or per-connection detail. It should not block `/dashboard/records` rendering on expensive recomputation. If the route errors, the dashboard should show no churn panel or an honest unavailable state rather than failing the page.

## Out Of Scope

- Historical compaction.
- Backup/restore workflow for local compaction.
- Content hashes or canonical JSON columns.
- General cursor-vs-record reconciliation.
- Connector-specific repair policies beyond the already-added guarded repair tool.
- Core protocol wording changes.

## Acceptance Checks

- The route returns bounded grouped rows and never raw record JSON.
- Owner auth is required.
- Rows correctly report obvious high-churn streams from the live Postgres deployment.
- The route works in SQLite and Postgres modes where history tables exist.
- Generated reference route docs/OpenAPI include the `_ref` route if applicable.
- Tests cover risk classification and at least one backend query path.
