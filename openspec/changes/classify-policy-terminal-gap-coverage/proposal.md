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
- Exclude only that stored disposition from the repair-blocking per-stream
  terminal aggregate and derive owner diagnostics from the same field.
- Keep terminal resource/connector defects repair-blocking.
- Fail closed when either aggregate is malformed, duplicated, or inconsistent.
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
