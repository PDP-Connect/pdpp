## Why

The reference dashboard needs fast, honest retained-size summaries for large
owner datasets. The current live Postgres deployment can compute accurate
totals, but doing so by scanning canonical records, record history, and blobs
on request is too slow and does not set up a future data explorer.

## What Changes

- Add a reference-only retained-size read model with typed logical-byte
  measures.
- Support bounded grains for global, connection, stream, and optional
  connector-authored record-family summaries.
- Add bounded top-N heavy-hitter rows for future drill-down surfaces.
- Add owner-only `_ref` read endpoints for retained-size rows and top-N rows.
- Preserve existing dataset-summary semantics and rebuild/reconcile behavior.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects reference runtime projection storage, dashboard/operator data
  sources, and `_ref` documentation.
- Does not change PDPP Core, Collection Profile messages, grant semantics, or
  `/v1` resource-server response contracts.
- Defers full data explorer UI, arbitrary field statistics, ad hoc grouping,
  and physical-storage metrics.
