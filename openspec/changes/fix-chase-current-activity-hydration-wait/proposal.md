# Fix Chase current-activity hydration wait

## Why

The Chase connector snapshots dashboard HTML for the `current_activity` stream
after account cards appear. The live run `run_1783395077609` proved that account
cards can be present before the dashboard's recent-activity table has hydrated:
the run found one account, completed transactions and statements, then emitted
`selectors_pending` for `current_activity` because the captured dashboard HTML
contained no parseable recent-activity rows.

That is a connector timing bug. The connector must wait for the specific surface
it parses before deciding that selectors drifted.

### Regression: the wait-then-read fix still produced a false `selectors_pending`

A second owner-present live run (`run_1783647087916`, after the wait-then-read
fix above was deployed) again emitted `selectors_pending` for
`current_activity`. The retained raw fixture capture for that run proved the
row surface was NOT drifted and NOT a genuine empty state: the
`dashboard-accounts` DOM checkpoint captured immediately before the
row-selector wait began already contained 5 valid
`tr.mds-activity-table__row[data-values]` rows, which the real
`parseCurrentActivityDom()` parses cleanly. The row-selector wait then still
consumed its entire budget before the connector re-read `page.content()` and
parsed zero rows.

The locator wait and the parser disagreed about readiness on already-good
evidence, and the connector trusted the locator, discarding a snapshot that
would have parsed successfully if read immediately. A bounded selector wait
is a hydration retry trigger, not proof that content read afterward will
parse — it can discard already-parseable content while waiting on a signal
that may never (or only transiently) match.

## What Changes

- The Chase connector waits for the dashboard recent-activity row selector before
  snapshotting HTML for `current_activity`.
- If the row surface still does not appear within the existing DOM wait budget,
  the connector preserves the existing `selectors_pending` diagnostic path.
- Tests prove the snapshot waits before reading HTML and still falls through to
  the selector diagnostic when rows never appear.
- **Parse-first correction:** the connector now reads and parses
  `page.content()` immediately, before consulting any locator. A non-empty
  parse is accepted as proof of readiness without waiting. The bounded
  row-selector wait is now only a fallback retry trigger used when the
  immediate parse yields zero rows, and after it resolves (or times out) the
  connector re-reads and re-parses once. `rowSurfaceReady` always reflects
  the final parsed result, never just whether the locator promise resolved,
  so the locator and the parser can no longer disagree about what the caller
  is told.
- This still cannot distinguish a genuine Chase-side empty state (no visible
  activity) from unrecognized/drifted markup — no fixture or corpus evidence
  proves an empty-state marker exists on this surface. Zero rows after the
  fallback wait continues to route to `selectors_pending`, unchanged from
  today's behavior.

## Capabilities

Modified: `reference-implementation-architecture`

## Impact

- `packages/polyfill-connectors/connectors/chase/index.ts`
- `packages/polyfill-connectors/connectors/chase/integration.test.ts`
  (reuses the existing `current-activity-dashboard-overview-real.html`
  fixture — no new fixture needed; the regression is an ordering defect, not
  a new unrecognized row shape)
- No runtime message, storage, manifest, or PDPP Core changes.
