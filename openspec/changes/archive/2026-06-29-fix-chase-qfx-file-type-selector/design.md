## Context

The open Chase gap is account-scoped `transactions` coverage with
`last_error.class = qfx_download_failed`. The run reached the Chase browser
surface, completed owner assistance, discovered the account, and failed while
selecting "Quicken Web Connect" in the QFX download form.

The existing connector already has two observed Chase file-type id families:
`#downloadFileTypeOption` and `#select-downloadFileTypeOption`. The weak point
is that `downloadQfx()` waits for only the first id family before the selection
helper clicks the combined selector. That can mark the form as unavailable or
enter a brittle path even when the second observed id family is present.

## Decision

Use one exported selector string for the QFX file-type control:

- `downloadQfx()` waits for the shared selector family.
- `selectFileType()` clicks the same selector family.
- If the custom element is present but not actionable, `selectFileType()` falls
  back to a labeled `combobox` role.

This keeps the fix narrow: it does not change transaction semantics, pending
transaction placement, detail-gap classification, or banking refresh posture.

## Alternatives

- Retry live first: rejected as the only fix because the current code still has
  a known selector drift. A retry after the patch is still required for live
  closure.
- Treat the gap as `current_activity`: rejected. Pending/current-cycle rows
  belong in `current_activity`; posted ledger transactions still rely on QFX.
- Add broad waits or fixed sleeps: rejected. The selector/control issue should
  be explicit and testable.

## Acceptance Checks

- `openspec validate fix-chase-qfx-file-type-selector --strict`
- Chase connector integration tests pass.
- Polyfill connector typecheck passes.
- Live Chase retry is owner-mediated and connection-scoped before claiming the
  live gap closed.
