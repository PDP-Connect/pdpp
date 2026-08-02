## Why

The Gmail attachment recovery tail contains pre-existing durable detail gaps
whose current records now resolve to `hydration_status: "too_large"`. Gmail
credits those records through `optional_skip_keys`, but emits no lease-owned
outcome. Runtime cleanup therefore releases the lease back to `pending`, so
the same four policy rows monopolize the next recovery page and starve
ordinary retryable siblings.

The diagnosis at `/home/tnunamak/.tmp/gmail-tail-diagnosis-0802.md` identifies
four exact policy rows, 28 additional `too_large` rows, and three
`Connection not available` rows in the observed tail. The latter must remain
retryable.

## What changes

- Add a terminal, policy-skipped `DETAIL_GAP` outcome for a served Gmail
  attachment whose hydration status is `too_large`. It retains the served
  `gap_id`, `lease_id`, exact terminal evidence, `optional_skip_keys`, and
  `reason`/error class `too_large`, without emitting an attempted or recovered
  outcome.
- Add a lease-owned, compare-and-set terminal settlement in the shared
  runtime/store contract. A policy settlement does not increment provider
  `attempt_count`; planned `run_cap_deferred` remains pending and likewise
  does not increment it.
- Add a bounded owner repair command for already-pending Gmail attachment gaps
  with exact `connector_id`, `connector_instance_id`, `stream`, and error-class
  scope. It is dry-run by default, idempotent, receipt-producing, and routes
  through the existing detail-gap store rather than a parallel table or
  direct SQL command.
- Add mutation-sensitive connector, runtime/store, and repair-command tests.

The semantic change is scoped to Gmail's served attachment policy result and
the connector-neutral lease/store protocol. Other connectors keep their
existing failure classification until evidence requires a corresponding
connector-owned outcome.
