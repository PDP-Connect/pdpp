# Follow-Up Splits — 2026-04-24

This report records the owner-level cleanup actions taken after the baseline
audit, active-change inventory, design-note triage, and spec-gap audit.

## Completed Program Archive

`reference-implementation-program` is complete. Its only remaining unchecked
item was a deliberately deferred broad-storage abstraction follow-up, now
captured as root `design-notes/broad-storage-abstraction-2026-04-24.md` with
`Status: decided-defer`.

The program was archived as
`openspec/changes/archive/2026-04-24-reference-implementation-program/` with
`--skip-specs` because its requirements had already been reconciled into the
canonical specs.

## Split From `swap-sqlite-driver`

`swap-sqlite-driver` is narrowed to the driver swap and crash-verification
closeout. Query extraction is no longer part of that change.

New owner:

- `make-reference-queries-inspectable` — static SQL/query-surface extraction,
  named query artifacts, and query/schema validation.

## Split From `add-polyfill-connector-system`

`add-polyfill-connector-system` remains active for the running connector fleet
and near-term connector/runtime work. Three backlog clusters now have their own
changes:

- `add-polyfill-layer-two-stream-coverage` — high-value stream additions plus
  explicit Spotify/Reddit fake-data cleanup.
- `add-connector-fixture-scrubber-pipeline` — raw capture handling, deterministic
  and LLM-assisted scrubbing, reviewed scrubbed fixtures.
- `define-partial-run-honesty` — skipped-stream taxonomy, known-gaps summaries,
  and recovery hints.

## Still Active

- `add-polyfill-connector-system` still needs stale-task relabeling and live
  connector bug closeout.
- `swap-sqlite-driver` still needs crash repro verification and cleanup.
- `add-reference-runtime-spec` remains the canonical follow-up for scheduler,
  browser-profile binding, filesystem binding, inbox/ntfy, and polyfill runtime
  logging coverage.
