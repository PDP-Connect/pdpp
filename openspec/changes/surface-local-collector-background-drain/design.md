## Decision

Render self-handled local-device drains as background upload, not as owner
recovery.

The local collector already distinguishes:

- `dead_letter` / `stalled` / `state_read_failed`: owner must run a host-local
  recovery command.
- `draining` / `outbox_active`: the host is uploading saved work and the owner
  should wait or inspect progress.

The console should preserve that split. After an owner fixes a stalled lane, the
next state must answer: "is it fixed?" The truthful answer can be "the blocking
problem is fixed; this host is still uploading saved work."

## UX Contract

When `local_device_progress.records_pending > 0`, a trusted source instance has
pending outbox diagnostics, and the rendered verdict has no local-device
remediation action, the connection diagnostics SHALL render a calm visible panel:

- Title: "Uploading from the local host" or equivalent.
- Body: "The collector on <host> is sending saved work in the background. No
  dashboard action is needed."
- Scale: queued uploads / pending count from the device.
- Freshness of progress: last ingest and heartbeat when present.

The panel SHALL NOT render copyable recovery commands. Recovery commands belong
only to the stalled/outbox remediation panel.

## Alternatives Considered

- **Make `recover --apply` drain until idle.** Rejected as the default. The
  runner has safety budgets for good reasons; a large queue should not turn a
  recovery command into an unbounded foreground job.
- **Add a new server desired-drain primitive now.** Deferred. It may become the
  ideal long-term automation seam, but the current gap is visible progress, and
  the reference already receives the necessary progress facts.
- **Leave it in raw source-instance diagnostics.** Rejected. It technically
  exposes the data, but it makes the owner infer that `pending` plus successful
  heartbeats means "nothing to do." That repeats the diagnostic-wall failure.

## Acceptance Checks

- A detail page with `records_pending > 0`, outbox pending counts, and no
  remediation action renders the background-upload panel.
- A stalled/dead-letter source still renders the recovery panel and does not
  collapse into the background-upload panel.
- The panel uses host labels when available and never says a hosted service is
  fixing the source.
