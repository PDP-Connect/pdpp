## Decision

The existing `connector_detail_gaps` row remains authoritative. Its terminal
count is retained for diagnostics and truthful history. The per-stream count
used to derive `terminal_gap` subtracts only explicitly policy-terminal
reasons. `too_large` is currently the policy-terminal reason; the shared
recovery classifier owns that vocabulary so this remains connector-neutral.

The store gains an optional reason filter on its existing bounded per-stream
status aggregates. The projection obtains both all terminal rows and the
policy-terminal subset, then subtracts counts by connection and stream. A
non-policy terminal row therefore remains repair-blocking; a policy row is
neither deleted nor relabelled.

## Alternatives

- Reclassify `too_large` as recovered: rejected because blob bytes were not
  hydrated and recovery evidence would be false.
- Remove policy rows: rejected because it erases durable evidence.
- Make all terminal rows non-blocking: rejected because actual provider or
  connector defects still require diagnosis.

## Acceptance checks

- A terminal `too_large` row stays in the terminal total and owner diagnostics
  but does not produce a per-stream `terminal_gap` count.
- A terminal non-policy row in the same stream still produces a blocking count.
- Both storage backends apply the same reason filter.
