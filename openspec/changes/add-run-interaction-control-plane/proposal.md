## Why

The runtime already supports blocking `INTERACTION` / `INTERACTION_RESPONSE`, and the reference already preserves `run.interaction_required` / `run.interaction_completed` in durable run timelines. What is missing is a truthful owner-facing control-plane seam for answering a live run interaction from the dashboard, so dashboard-started runs with missing credentials or OTP needs look stuck even though the run is really waiting on operator input.

## What Changes

- Add a narrow, owner-only reference control-plane endpoint for answering the current pending interaction of an active run.
- Keep the read path on the existing run timeline and current run detail UI; do not add a new public PDPP route or a second inbox-style identity model.
- Extend the dashboard run detail page to render a response form for pending `credentials`, `otp`, and `manual_action` interactions.
- Keep dashboard-submitted interaction values ephemeral to the current run; do not write them to `.env.local`, connector manifests, or durable reference state.
- Document this as an explicit later control-plane widening of the `_ref` boundary, not as a Core PDPP or public Collection Profile change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: widen the currently read-only `_ref` boundary to allow a narrow, owner-only run-interaction control endpoint for active runs.

## Impact

- `reference-implementation/runtime/controller.js`
- `reference-implementation/server/index.js`
- `packages/reference-contract/src/reference/index.ts`
- `reference-implementation/test/*` for control-plane and run-interaction coverage
- `apps/web/src/app/dashboard/runs/[runId]/*`
- `apps/web/src/app/dashboard/lib/ref-client.ts`
- reference docs describing `_ref` surfaces and the operator control plane
