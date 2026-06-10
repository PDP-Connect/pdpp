## 1. Console helper

- [x] 1.1 Add `scale: string | null` to `NextStepGuidance`; set it on every existing guidance return (`null`) and only on the stalled-outbox branch (via the existing `formatOutboxCountScale`).
- [x] 1.2 Extend `deriveConnectionNextStep` to accept an optional `localDeviceProgress`; compute the scale from `outbox_counts` on the stalled branch only.

## 2. Console row

- [x] 2.1 Thread `overview.localDeviceProgress ?? null` into the row's `deriveConnectionNextStep` call.
- [x] 2.2 Render the count-backed scale inside the existing `NextStepGuidanceRow` `<Link>` to `detailHref`, gated on `guidance.scale`.

## 3. Tests

- [x] 3.1 Pure helper tests: scale present on stalled+counts; omits zero categories; null on stalled+no-counts / stalled+no-progress / all-zero-stuck-work; null on every non-stalled guidance with a populated rollup; attached even under a dominant condition.
- [x] 3.2 Structural connector-row tests: row threads `localDeviceProgress` into the helper; renders the cue only when a scale is present; cue lives inside the detail-linked guidance `<Link>`.

## 4. Validation

- [x] 4.1 Targeted `apps/console` tests (connection-evidence, connector-row, connection-diagnostics, records-list classification).
- [x] 4.2 `pnpm --dir apps/console run types:check`.
- [x] 4.3 `pnpm --dir apps/console run check`.
- [x] 4.4 `openspec validate add-outbox-counts-in-records-row --strict`.
- [x] 4.5 `openspec validate --all --strict`.
- [x] 4.6 `git diff --check`.
