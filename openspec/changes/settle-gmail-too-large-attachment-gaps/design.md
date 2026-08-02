## Decision

Represent the policy settlement on the existing `DETAIL_GAP` wire family with
`status: "terminal"`, `retryable: false`, `reason: "too_large"`, and the
required served `gap_id` and `lease_id`. This preserves the existing stream
and locator identity while making the terminal state explicit to the runtime.
The ordinary pending `DETAIL_GAP` shape remains unchanged, so transient
provider failures such as `Connection not available` continue through their
existing retryable path.

Gmail emits this terminal outcome only after it has accepted the attachment
record and credited the matching key in `optional_skip_keys`. If record
emission fails, Gmail fails closed onto its existing retryable deferral path;
it never claims a durable policy settlement without coverage evidence. A
terminal policy outcome does not emit `DETAIL_GAP_ATTEMPTED` or
`DETAIL_GAP_RECOVERED`.

The runtime validates the terminal shape, requires that the lease belongs to
the current run, flushes the accepted connector record before a lease-owned
compare-and-set transition to `terminal`, and calls a new lease- and
identity-owned store CAS. Gmail's accumulated optional-skip coverage is then
emitted in the normal protocol order before `DONE`. The store changes the row
to `terminal`, clears the lease, preserves the exact bounded `last_error`
object and gap identity, clears the next-attempt time, and leaves provider
attempt evidence unchanged. A missing capability, mismatched lease, or failed
CAS is an error; the runtime does not silently release a row after a claimed
terminal outcome.

`run_cap_deferred` continues to use `settleLeasedGapPending`. Its planned-stop
classifier remains excluded from attempt accounting and no terminal/quarantine
transition is added.

The repair command is an owner/operator boundary over the canonical store. It
accepts only the exact Gmail attachment scope and `too_large` class, caps the
row count, prints a bounded JSON receipt, and defaults to listing matches
without mutation. Apply mode performs a server-side status-and-class guarded
terminal transition; retryable rows, other connectors/instances/streams, and
already-terminal rows cannot match. Repeating apply therefore returns zero
newly terminalized rows. The existing terminal-sticky upsert behavior preserves
the terminal evidence if a later forward pass re-upserts the same identity.

## Rejected alternatives

- Treating `too_large` as a normal retryable gap would repeat a known policy
  failure and retain the starvation shape.
- Inferring terminalization from `DONE` or coverage alone would lose the
  served lease identity and make false recovery/cleanup possible.
- Changing the generic recovery classifier for every connector would broaden
  semantics without evidence.
- A repair script with bespoke SQL or a second gap table would bypass the
  store's identity, sticky-terminal, and backend-parity rules.

## Acceptance evidence

- The four diagnosed policy rows settle terminally in one served run; their
  exact evidence, optional skips, gap IDs, and lease IDs survive, and no
  recovered event is emitted.
- The ordinary sibling tail is admitted on the next run rather than being
  starved by the four policy rows.
- Planned run-cap rows stay pending with unchanged attempt evidence.
- A later same-identity upsert cannot reopen a terminal policy row.
- Repair dry-run is side-effect free; apply is exact, bounded, idempotent,
  and leaves `Connection not available` rows pending.
