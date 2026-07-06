## Design

The reference already reads pending detail gaps with a bounded limit. The
connection-health rollup tracks when that read hit the limit, but the per-stream
Collection Report dropped that fact and exposed only the returned row count.

This change keeps the existing bounded read and threads the bound into
`buildCollectionReport`. When the read returns at least the read limit, any
stream with a positive pending-gap count marks that count as a floor via
`pending_detail_gaps_is_floor: true`.

The console then renders the count as `at least N pending gaps`. It does not
claim an exact total and does not perform a new full-count query.

## Alternatives

- Run an exact `COUNT(*) GROUP BY stream` for all pending gaps. This would be
  more precise but is a separate performance/design decision. The immediate bug
  is the false exact count, and the reference already has a floor signal.
- Hide the count when capped. That avoids false precision but removes useful
  scale information.

## Acceptance Checks

- Server projection marks a stream count as a floor when the pending-gap read
  reaches its limit.
- Console formatting renders floor counts as `at least N pending gaps`.
- Existing non-capped counts continue to render as exact counts.
