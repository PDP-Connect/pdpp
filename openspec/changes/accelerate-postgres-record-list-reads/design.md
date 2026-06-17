## Context

The reference Postgres store has grown large enough that JSON-derived ordering
and whole-table exact counts are owner-visible latency. Live `EXPLAIN ANALYZE`
showed:

- `ORDER BY record_json->>'sent_at'` on Slack messages: about 1325ms.
- `ORDER BY cursor_value, primary_key_text` through
  `idx_pg_records_stream_cursor`: about 2ms.
- `COUNT(*)` on the same stream: about 1155ms.
- `retained_size_stream` already carries a clean per-stream `record_count` for
  the same connection/stream.

The initial indexed-read idea was insufficient by itself because existing live
rows had many `cursor_value IS NULL` gaps even when the manifest cursor field
was present in `record_json`. For DESC order, nulls intentionally sort first;
using the stored column before repairing those gaps would make the result fast
but semantically wrong.

## Decision

Use stored Postgres sort-position columns as the read path's canonical ordering
basis, and make that correct by construction:

- New writes populate `cursor_value` from the registered manifest stream's
  `cursor_field` and `primary_key_text` from the manifest primary key fallback.
- Manifest registration invalidates the small in-process manifest-stream cache
  and runs an idempotent backfill for rows whose JSON payload has the declared
  cursor field but whose stored `cursor_value` is null.
- Record-list reads order by stored `cursor_value` / `primary_key_text`, which
  matches the existing covering index.
- Exact/estimated count may use `retained_size_stream.record_count` only when
  that projection is clean and the request is the full unfiltered stream. Any
  request filter, time range, resource scope, missing projection, or dirty
  projection falls back to the SQL count.

## Alternatives Considered

- Keep JSON extraction and accept the latency. Rejected: it fails the public
  read-surface performance bar on real data.
- Use `COALESCE(cursor_value, record_json->>field)` on every read. Rejected:
  preserves correctness but prevents the indexed path from doing the work that
  the schema was already designed to support.
- Query the manifest table per ingested record. Rejected: this makes collection
  slower as a side effect of fixing reads.
- Trust existing stored cursor values without backfill. Rejected: live data
  proved that would mis-bucket many records as missing-cursor rows.

## Acceptance Checks

- Postgres runtime tests prove new ingests populate stored cursor values and a
  manifest refresh backfills null stored cursor values.
- Postgres runtime tests prove filtered counts ignore the retained-size
  projection and dirty projections fall back to SQL count.
- Live Postgres verification shows records page and exact count latency improve
  materially on the benchmarked streams after deploy.
