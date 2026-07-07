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

## What Changes

- The Chase connector waits for the dashboard recent-activity row selector before
  snapshotting HTML for `current_activity`.
- If the row surface still does not appear within the existing DOM wait budget,
  the connector preserves the existing `selectors_pending` diagnostic path.
- Tests prove the snapshot waits before reading HTML and still falls through to
  the selector diagnostic when rows never appear.

## Capabilities

Modified: `reference-implementation-architecture`

## Impact

- `packages/polyfill-connectors/connectors/chase/index.ts`
- `packages/polyfill-connectors/connectors/chase/integration.test.ts`
- No runtime message, storage, manifest, or PDPP Core changes.
