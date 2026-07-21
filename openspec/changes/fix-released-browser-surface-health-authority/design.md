## Context

The reference implementation keeps browser-surface rows after lease release,
which is useful for diagnostics and history. The bug is that the projection
layer treats that retained history as current authority once lease evidence
runs out.

## Decision

- Use current lifecycle evidence, not surface-row recency, to decide whether a
  browser-surface row can influence the connection headline.
- Preserve fail-closed behavior for lease-backed failures and other current
  evidence that proves a live browser surface is unhealthy.
- When only retired browser-surface history remains, project `unknown`
  rather than letting that history dominate.

## Alternatives

- Keep picking the most recent surface row. Rejected: this is the bug.
- Suppress every unhealthy surface row. Rejected: current lease-backed
  failures would stop degrading the connection.
- Add timestamps or age heuristics. Rejected: the lifecycle boundary is
  semantic, not temporal.

## Acceptance Checks

- A released browser surface later marked unhealthy does not become the
  current connection-health authority.
- A current leased unhealthy browser surface still degrades the connection.
- A newer ready surface still wins over older unhealthy history.
- When no current browser-surface evidence exists, the projection is
  `unknown`.
