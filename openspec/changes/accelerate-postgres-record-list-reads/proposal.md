## Why

Large Postgres-backed record streams were not "blazing fast" on the public
read surface. Live evidence on `pdpp.vivid.fish` showed a Slack messages page
spending about 1.3s sorting `record_json->>cursor_field`, and `count:"exact"`
spending about 1.1s scanning the full `records` table.

The Postgres schema already has stored `cursor_value`, `primary_key_text`, and
retained-size projections, but the record-list path did not consistently use
them and the write path did not populate cursor values for new rows.

## What Changes

- Populate stored Postgres record sort positions from the manifest-declared
  cursor field on ingest.
- Backfill stored cursor values from registered connector manifests when a
  manifest is registered or refreshed.
- Order Postgres record-list pages by the stored sort-position columns instead
  of per-read JSON extraction.
- Satisfy unfiltered full-stream `count:"exact"` / `count:"estimated"` from a
  clean `retained_size_stream` projection, falling back to SQL count for
  filtered, time-ranged, resource-scoped, or dirty/missing projections.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Affects Postgres-backed `query_records` / REST record-list reads.
- Does not change public request or response shape.
- Requires an idempotent sort-position backfill on existing Postgres rows before
  the indexed read path can be treated as fully effective.
