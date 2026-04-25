## Why

Connector runs often produce useful partial data: skipped streams, missing credentials, checkpoint failures, platform blocks, selector drift, and post-DONE protocol violations are all different situations. Today those differences can collapse into generic failed/skipped state, forcing users and agents to infer whether data is complete enough to use.

## What Changes

- Define reference semantics for partial run honesty.
- Add machine-readable skipped/gap taxonomy, known-gaps reporting, and recovery affordances.
- Preserve useful flushed data without pretending the run was complete.
- Keep public PDPP disclosure semantics separate from reference-only runtime observability until a later protocol decision promotes any part of this behavior.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: bounded collection runs become explicit about completeness, skipped streams, checkpoint state, and recovery paths.

## Impact

- `reference-implementation/runtime/**`
- `reference-implementation/server/ref-control.ts`
- `apps/web/src/app/dashboard/runs/**`
- `packages/polyfill-connectors/**`
- `openspec/changes/add-polyfill-connector-system/design-notes/*partial*`
