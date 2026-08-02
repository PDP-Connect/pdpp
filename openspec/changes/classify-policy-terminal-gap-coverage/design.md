## Decision

The existing `connector_detail_gaps` row remains authoritative. Its terminal
count is retained for diagnostics and truthful history. A new nullable,
immutable `policy_disposition_json` column is written only by terminal lease
settlement. The only accepted value is `gmail_attachment_too_large`, with
positive safe-integer `observed_size_bytes` greater than
`configured_limit_bytes`. Settlement also validates the Gmail connector,
`attachments` stream, Gmail attachment locator, terminal `too_large` reason,
and terminal `too_large` error class. Historical rows remain null; they are
not inferred or rewritten from free text.

The store gains an optional disposition-kind filter on its existing bounded
per-stream status aggregates. The projection obtains both all terminal rows
and the whitelisted disposition subset, then subtracts counts by connection
and stream. Owner diagnostics read the same parsed disposition. A non-policy
terminal row therefore remains repair-blocking; a policy row is neither
deleted nor relabelled. Any malformed row, duplicate stream, failed aggregate,
or policy stream absent from the total, or a policy count greater than the
total leaves the repair count unmeasured.

## Alternatives

- Reclassify `too_large` as recovered: rejected because blob bytes were not
  hydrated and recovery evidence would be false.
- Remove policy rows: rejected because it erases durable evidence.
- Make all terminal rows non-blocking: rejected because actual provider or
  connector defects still require diagnosis.

## Acceptance checks

- A valid Gmail attachment disposition stays in the terminal total and owner
  diagnostics but does not produce a per-stream `terminal_gap` count.
- A terminal `not_found` row remains blocking even when generic mutation sets
  its reason to `too_large`.
- Both storage backends apply the same disposition filter and historical rows
  with no disposition remain blocking.
