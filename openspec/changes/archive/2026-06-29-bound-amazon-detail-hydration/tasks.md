## 1. Amazon Detail Budget

- [x] 1.1 Add an Amazon detail-budget helper that tracks elapsed detail time and/or attempted detail count per run.
- [x] 1.2 Update `processListOrder` so budget-deferred detail emits list-derived records plus a retryable `DETAIL_GAP`.
- [x] 1.3 Preserve `DETAIL_COVERAGE` required/hydrated/gap accounting when detail is budget-deferred.

## 2. Recovery-Only Drain

- [x] 2.1 Add Amazon recovery-only handling for pending `order_items` gaps from `START.detail_gaps`.
- [x] 2.2 Emit recovered detail records and `DETAIL_GAP_RECOVERED` for hydrated gaps.
- [x] 2.3 Keep unrecovered gaps pending with bounded, redacted error evidence.

## 3. Diagnostics

- [x] 3.1 Capture one failed detail checkpoint when fixture capture is enabled; budget deferral emits structured redacted gap evidence without touching the page.
- [x] 3.2 Ensure the diagnostic path does not add raw detail content to `DETAIL_GAP` messages.

## 4. Validation

- [x] 4.1 Add Amazon integration tests for detail budget deferral.
- [x] 4.2 Add Amazon integration tests for recovery-only detail hydration.
- [x] 4.3 Run `openspec validate bound-amazon-detail-hydration --strict`.
- [x] 4.4 Run Amazon connector tests.
