## Why

The reference dashboard needs a fast, bounded-load overview without re-scanning the records substrate on every page load. Today `GET /_ref/dataset/summary` recomputes counts, byte totals, top connectors, and record-time bounds from `records`, `record_changes`, `blobs`, and manifest-declared JSON fields. Under active ingest this can take 15+ seconds and block `/dashboard` rendering.

## What Changes

- Add a reference-only dataset-summary read model for `GET /_ref/dataset/summary`.
- Serve dashboard summary reads from bounded read-model rows rather than live aggregate scans.
- Maintain the read model from durable record/blob/change writes where safe, and provide reconciliation for extrema or missed updates.
- Expose freshness/rebuild/error metadata so the dashboard can distinguish fresh, refreshing, stale, rebuilding, and failed summary states.
- Split the dashboard render path so shell/header and honest placeholders are not blocked by summary refresh.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects the reference-only dashboard read path, supporting reference storage/maintenance code, and dashboard loading states.
- Does not define PDPP protocol semantics or a public PDPP API.
- Does not require implementing runtime code in this drafting change.
