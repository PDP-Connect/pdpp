## Problem

A local collector host can recover after a crash, run on its timer, and keep draining pending durable outbox work while the owner console still appears to need manual repair. The timer success alone is not enough: the server projection needs fresh, accepted source-instance heartbeat evidence with outbox diagnostics.

The live failure shape observed on July 7, 2026 had no dead letters and no expired leases. The local host showed pending work decreasing, while the remote owner surface could still classify the connection as stale/stalled because its latest accepted heartbeat was older than the stale threshold.

## Design

Local collector runs SHALL publish source-instance heartbeat evidence for every meaningful terminal state:

- normal run completion after source scan and drain;
- backlog-drain-only run where scanning is skipped because durable work remains;
- state-read failure, which blocks source scanning but still has current outbox diagnostics;
- corrective post-error heartbeat after a run throws after the starting heartbeat.

Heartbeat failure on a terminal path that is the only current health report SHALL NOT be silently swallowed as a successful run. Best-effort heartbeat remains acceptable only when a caller is already surfacing a stronger failure and the heartbeat is extra context.

The connection-health projection SHALL keep local-device backlog distinct from owner action. A recent heartbeat with pending work is active local-device work. Manual remediation appears only for genuinely stalled/dead-letter/state-read-blocked conditions, not for a collector that is still advancing.

## Alternatives

- Only adjust UI copy. Rejected: it would rename the symptom while leaving stale heartbeat evidence and invisible silent failures.
- Increase the stale heartbeat threshold. Rejected: that hides slow or broken collectors and delays real repair.
- Require the owner to run local recovery after every crash. Rejected: the durable outbox and timers are specifically meant to make crash recovery automatic.

## Acceptance Checks

- OpenSpec validates strictly.
- Local collector runner tests cover backlog-drain-only heartbeat reporting.
- Local collector runner tests cover state-read failure heartbeat reporting with outbox diagnostics.
- Connection-health tests cover recent local pending work as active/non-owner-actionable.
- Type-check relevant packages.
