## Why

A saved live run (`run_1784062643752`) recorded the USAA `transactions` stream terminating with `export_affordance_missing` and no durable structural fixture, because the connector's page was already unavailable by the time capture ran. Reading `driveExport`'s `dialog-not-open` branch in `packages/polyfill-connectors/connectors/usaa/index.ts` showed a real, narrow ordering defect that explains why that phase in particular can lose its evidence: `openExportDialog` presses `Escape` to dismiss the export affordance click when the date-range select never renders, but the caller (`driveExport`) only called `captureExportCheckpoint(..., "dialog-not-open")` *after* `openExportDialog` returned — i.e., after `Escape` had already run inside it. `Escape` can dismiss/mutate the on-page dialog surface, so the checkpoint capture for this one phase was not guaranteed to observe the pre-mutation page.

This is not a provider-outage, profile-poisoning, or selector-drift defect — it is a connector-internal control-flow ordering bug in when the existing best-effort DOM checkpoint fires relative to a page-mutating action within the same phase.

## What Changes

- Move the `dialog-not-open` checkpoint capture inside `openExportDialog`, immediately after the unexpected-shape diagnostic and before the `Escape` keypress, so it captures the pre-mutation page.
- No new capture primitive, no new taxonomy, no change to `export_affordance_missing` classification or the other checkpoint labels (`before-submit`, `source-empty`, `dialog-error`, `artifact-failed`, `no-export-affordance`), which were already ordered correctly relative to their own page-mutating steps.

## Capabilities

Added:

- `polyfill-runtime` — new requirement that a connector's failure-phase DOM checkpoint capture precede any page-mutating cleanup within the same phase (no prior spec capability governed this ordering).

Modified:

- USAA connector `driveExport` (`packages/polyfill-connectors/connectors/usaa/index.ts`)

## Impact

- The `dialog-not-open` failure phase now has a checkpoint capture that reliably reflects the page state before the Escape-driven dialog dismissal, closing one concrete evidence-timing gap identified from saved live-run evidence.
- Does not resolve or reclassify the underlying `export_affordance_missing` cause (markup change vs. profile/runtime surface loss) — that still requires a live run captured after this fix deploys.
- No coupling introduced between Chase and USAA; the fix is scoped to the USAA export ladder only.

## Residual risks

- Owner-authorized post-deploy acceptance remains: a run reaching
  `dialog-not-open` should produce a non-empty, privacy-safe structural
  checkpoint fixture for that phase. This is live-environment verification,
  not an implementation task; record and authorize it through the owner’s
  issue-tracking process before running it.
