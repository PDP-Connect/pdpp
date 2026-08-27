# Design: repair terminal commit recovery

## Decision

`terminal_run_commit` dead letters are not requeued by `recover --apply`.
Instead, the normal collector pass is allowed to proceed past a dead terminal
row and generate a fresh terminal commit from a genuinely completed pass. The
existing terminal gate remains authoritative: the child must report successful
`DONE`, the scan must not hit its budget, coverage diagnostics must be present,
and all record/gap predecessors must be acknowledged before the replacement is
sent.

After the replacement terminal row is acknowledged, the outbox writes one row
to `local_device_terminal_commit_supersessions` for each matching older dead
terminal row. The ledger is the retirement marker. It stores the old row id,
replacement row id, and timestamp; it does not copy or delete the old row.
This ordering is the load-bearing invariant: an accepted replacement exists
before an old terminal row stops blocking lifecycle state.

Matching is scoped to source instance, connector, connector instance, and
collection boundary, and is limited to rows older than the replacement. This
prevents a successful pass from retiring terminal evidence for another source
or boundary. The ledger insert is idempotent and transactional.

Queue queries that decide active work exclude only dead terminal rows with a
ledger entry. Raw `list()`/`get()` continue to expose those rows, so retirement
does not silently drop terminal evidence. Record batches are never selected by
the supersession operation. Existing non-terminal dead letters remain eligible
for the ordinary filtered requeue path.

## Alternatives rejected

- Requeue the old terminal row: reproduces the incident by sending identical
  invalid bytes and cannot repair a permanent 400.
- Delete the old terminal row before scanning: loses evidence and can claim
  progress without a replacement accepted by the server.
- Mark the old row `succeeded`: lies about destination acceptance and collides
  with the meaning of the existing status.
- Rebuild by deleting record batches: risks duplicate or missing source data and
  violates the durable record-batch contract.
- Weaken server validation or accept the old body locally: moves the defect
  across the trust boundary and permits invalid terminal evidence.

## Acceptance checks

- A queue with one dead-letter terminal commit (`attempt_count = 1`) and retained
  record batches does not resend the old terminal bytes during recovery.
- A completed recovery pass sends a newly generated terminal commit, then the
  old row remains present with its original payload/error and is ledger-retired.
- If the replacement is not accepted, the old row remains active and the
  lifecycle remains `dead_letter`.
- Ordinary transient dead-letter record batches still requeue and deliver.
- Server-side terminal payload validation tests remain unchanged and pass.
