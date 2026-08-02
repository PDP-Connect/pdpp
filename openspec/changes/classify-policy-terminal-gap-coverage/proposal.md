## Why

Terminal Gmail attachment rows with verified `too_large` policy evidence are
correctly retained as terminal detail gaps, but the collection-report
projection counts every terminal row as a repair-blocking coverage gap. This
turns an accepted policy exclusion into a maintainer `code_fix` action even
when retryable siblings remain queued separately.

## What Changes

- Keep terminal policy rows and their aggregate count visible.
- Exclude only connector-neutral, policy-terminal reasons from the
  repair-blocking per-stream terminal aggregate used by coverage projection.
- Keep terminal resource/connector defects repair-blocking.
- Add SQLite/PostgreSQL parity for reason-scoped per-stream aggregates and a
  regression covering policy versus defect terminal rows.

## Capabilities

### Modified Capabilities

- `reference-connection-health`: terminal policy evidence is visible without
  being projected as a maintainer repair requirement.

## Impact

- `reference-implementation/server/ref-control.ts`
- `reference-implementation/server/stores/connector-detail-gap-store.ts`
- `reference-implementation/runtime/recovery-decision.ts`
