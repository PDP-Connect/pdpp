## Decision

The existing `connector_detail_gaps` row remains authoritative. Its terminal
count is retained for diagnostics and truthful history. A new nullable
`policy_disposition_json` column is written only by terminal lease settlement.
Every generic status/reason/error transition and every transition out of
terminal clears it, so a non-null proof is bound to that settlement rather
than to mutable row fields. The only accepted value is
`gmail_attachment_too_large`, with
positive safe-integer `observed_size_bytes` greater than
`configured_limit_bytes`. Settlement also validates the Gmail connector,
`attachments` stream, Gmail attachment locator, terminal `too_large` reason,
and terminal `too_large` error class. Historical rows remain null; they are
not inferred or rewritten from free text.

The store gains an optional disposition filter on its existing bounded
per-stream status aggregates. It groups only non-null candidate proofs and
uses the exact closed parser used by owner diagnostics before counting any of
them. The projection obtains both all terminal rows and the validated
whitelisted subset, then subtracts counts by connection and stream. A
non-policy terminal row therefore remains repair-blocking; a policy row is
neither deleted nor relabelled. Any malformed row, duplicate stream, failed
aggregate, or policy stream absent from the total, or a policy count greater
than the total leaves the repair count unmeasured.

Legacy rows without the disposition remain historically unproven. The upgrade
bridge is deliberately not a policy-disposition writer: it is a bounded,
dry-run-by-default operator command requiring one connector instance, the
fixed Gmail/attachments/`too_large` scope, and the
`pre_contract_gmail_attachment_too_large_remeasurement_v1` mutation
discriminator. The store reuses the normal Gmail recovery locator parser: only
a well-formed `attachment_id` derivable to message/part, or a nonempty
`message_id` and `part_index`, is eligible. It rechecks terminal reason/error
class, no active lease, and exact policy-disposition and locator JSON
preimages as part of each status compare-and-set. It excludes every row the
closed policy validator accepts and every kind-only or malformed locator.

Apply changes only an eligible current gap row from `terminal` to `pending`,
clearing its terminal-only disposition and lease fields. It preserves the
gap/record identity, locator, source, error, run links, attempt counters, and
all immutable spine/audit history. It creates no provider, record, run, or
spine fact. A later normal scheduled lease is therefore the sole authority for
any fresh policy proof, `not_found`, or recovery outcome. Repeating the apply
or racing it against another apply can change each row at most once; a valid
policy row and all other instances/classes remain untouched.

## Alternatives

- Reclassify `too_large` as recovered: rejected because blob bytes were not
  hydrated and recovery evidence would be false.
- Remove policy rows: rejected because it erases durable evidence.
- Make all terminal rows non-blocking: rejected because actual provider or
  connector defects still require diagnosis.
- Backfill policy proof from the terminal message or current configuration:
  rejected because it would fabricate historical settlement evidence.

## Acceptance checks

- A valid Gmail attachment disposition stays in the terminal total and owner
  diagnostics but does not produce a per-stream `terminal_gap` count.
- A terminal `not_found` row remains blocking even when generic mutation sets
  its reason to `too_large`.
- A valid policy row changed through generic `markGapStatus` to `not_found`
  has no proof, no policy diagnostic, and remains repair-blocking.
- A kind-only or otherwise malformed persisted JSON value is excluded by both
  coverage and diagnostics.
- Both storage backends apply the same disposition filter and historical rows
  with no disposition remain blocking.
- The explicit remeasurement bridge is dry-run by default, only requeues an
  exact Gmail connection-instance scope lacking validated proof, and leaves
  new outcome production to scheduled recovery.
