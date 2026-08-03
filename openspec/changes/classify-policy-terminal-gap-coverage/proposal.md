## Why

Historical Gmail attachment rows use mutable `reason` and error-class fields
as a proxy for `too_large` policy evidence. That lets an ordinary terminal
failure be misclassified by a generic status mutation and lets diagnostics and
coverage disagree. The collection-report projection must retain every terminal
row while excluding only a validated terminal-settlement policy fact.

## What Changes

- Keep terminal policy rows and their aggregate count visible.
- Write one immutable `gmail_attachment_too_large` disposition only during
  terminal lease settlement after validating Gmail attachment context and
  observed-size/configured-limit evidence.
- Clear that disposition in every generic status, reason, or error transition
  and whenever the row exits terminal state, so a proof cannot outlive its
  settled tuple.
- Exclude only that stored disposition from the repair-blocking per-stream
  terminal aggregate and derive owner diagnostics from the same closed parser.
- Declare the column on fresh `connector_detail_gaps` schemas and preserve the
  additive upgrade path; do not add it to unrelated device tables.
- Keep terminal resource/connector defects repair-blocking.
- Fail closed when either aggregate is malformed, duplicated, or inconsistent.
- Add a dry-run-by-default, exact-instance migration bridge for legacy Gmail
  attachment `too_large` terminal rows with no validated disposition. The
  bridge only returns the bounded rows to normal scheduled recovery; it does
  not infer history, alter records or spine events, or emit a new outcome.
- Add SQLite/PostgreSQL parity and mutation regressions for policy versus
  defect terminal rows.

## Capabilities

### Modified Capabilities

- `reference-connection-health`: terminal policy evidence is visible without
  being projected as a maintainer repair requirement.

## Impact

- `reference-implementation/server/ref-control.ts`
- `reference-implementation/server/stores/connector-detail-gap-store.ts`
- `reference-implementation/runtime/terminal-policy-disposition.ts`
- `reference-implementation/server/owner-detail-gap-projection.ts`
- `reference-implementation/scripts/repair/requeue-gmail-precontract-too-large-detail-gaps.ts`
