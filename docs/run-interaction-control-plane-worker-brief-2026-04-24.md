# Run Interaction Control-Plane Worker Brief

Work in the existing repo. This is implementation work for the new OpenSpec change:

- `openspec/changes/add-run-interaction-control-plane/proposal.md`
- `openspec/changes/add-run-interaction-control-plane/design.md`
- `openspec/changes/add-run-interaction-control-plane/tasks.md`
- `openspec/changes/add-run-interaction-control-plane/specs/reference-implementation-architecture/spec.md`

Read those first, then implement the change end-to-end.

## Mission

Add a narrow, owner-only reference control-plane seam so the dashboard can answer a live run interaction for the current active run.

This is **not** a public PDPP API change.

It belongs in the reference-only `_ref` control plane.

## Scope

Implement all tasks in the OpenSpec change:

1. controller/runtime interaction brokerage for server-managed runs
2. `POST /_ref/runs/:runId/interaction`
3. dashboard run-detail response UI
4. tests and docs

Also fix the adjacent controller-managed restart hole:

- if the reference server restarts while a controller-managed run is active or waiting on interaction, the run must not remain a ghost `started` artifact forever
- preserve or implement durable active-run tracking plus startup reconciliation to a terminal `run.failed`
- use a machine-readable reason such as `controller_restarted`

## Hard boundaries

- Do **not** add a public `/v1/...` route.
- Do **not** revive a separate inbox model or inbox page.
- Do **not** persist submitted OTP/credentials to `.env.local`, SQLite config/state, or timeline payloads.
- Do **not** weaken owner-only authz on `_ref` control surfaces.
- Do **not** add SSE/WebSocket/streaming in this tranche.
- Do **not** widen this into generic replay/resume/checkpoint resurrection.

## Required implementation shape

### 1. Controller-managed interaction broker

For runs started through `reference-implementation/runtime/controller.js`:

- replace the current fallback to terminal/stdin interaction handling with an in-memory broker
- store the current pending interaction for the active run
- store a resolver/rejector for the pending `INTERACTION_RESPONSE`
- allow exactly one current pending interaction per active run

The broker should support:

- `success`
- `cancelled`
- runtime-owned `timeout`

The dashboard submission path should resolve only the currently pending interaction with a matching `interaction_id`.

### 1.5 Restart truthfulness for controller-managed runs

Do not leave controller-managed runs as permanently `started` after process death/restart.

Expected shape:

- persist enough controller-managed active-run identity to survive process restart
- on startup, reconcile leftover active controller rows into a terminal run artifact
- append a truthful `run.failed` event with a machine-readable reason like `controller_restarted`
- clear the stale active-run marker so a new run can start

This is specifically about controller-managed/dashboard-started runs, not a generic claim about every possible external CLI run.

### 2. Reference control-plane route

Add:

- `POST /_ref/runs/:runId/interaction`

Request body:

- `interaction_id`
- `status`
  - allowed: `success`, `cancelled`
- `data`
  - optional object

Suggested failure behavior:

- `404` unknown or no-longer-active run
- `409` active run but no current pending interaction / stale `interaction_id`
- `400` invalid body

Keep the read path on the existing run timeline:

- `GET /_ref/runs/:runId/timeline`

Do not add a parallel inbox identity or separate interaction read route in this tranche.

### 3. Dashboard UX

Use the existing run detail page:

- `apps/web/src/app/dashboard/runs/[runId]/page.tsx`

Add:

- response form for `credentials`
- response form for `otp`
- acknowledge/continue and cancel affordances for `manual_action`
- explicit copy that dashboard-submitted values satisfy the current run only and are not persisted

Keep the current live polling honest:

- once interaction is completed / cancelled / timed out / run is no longer active, the form should disappear

### 4. Secrets and durability

Submitted values must:

- satisfy only the current live run
- not be written to `.env.local`
- not be written to SQLite config/state tables
- not be stored in spine event payloads
- not be logged in cleartext

Timeline should continue to expose only safe existing metadata:

- `run.interaction_required`
- `run.interaction_completed`

## Files likely in scope

- `reference-implementation/runtime/controller.js`
- `reference-implementation/runtime/index.js` only if needed to support the controller seam cleanly
- `reference-implementation/server/index.js`
- `packages/reference-contract/src/reference/index.ts`
- `apps/web/src/app/dashboard/lib/ref-client.ts`
- `apps/web/src/app/dashboard/runs/[runId]/page.tsx`
- adjacent server action / helper files under the same dashboard area
- reference docs describing `_ref`

## Tests required

Add coverage for at least:

1. successful interaction response through `_ref`
2. cancelled interaction response through `_ref`
3. stale `interaction_id` is rejected
4. no pending interaction is rejected
5. unknown or finished run is rejected
6. submitted secrets do not appear in the run timeline
7. dashboard build/types still pass
8. controller-managed run abandoned by restart is reconciled to terminal failed state instead of remaining ghost `started`

Use existing control-plane and event-spine tests as prior art.

## Verification

At minimum run:

- `pnpm --dir reference-implementation run verify`
- `pnpm --dir apps/web run types:check`
- `pnpm --dir apps/web run build`

If you add/modify reference-contract artifacts:

- `pnpm --dir packages/reference-contract run verify`
- `pnpm --dir packages/reference-contract run check:generated`

## Final report format

1. exact files changed
2. route/contract added
3. controller/runtime seam added
4. dashboard UX added
5. tests/checks run
6. residual risks

## Stop-and-report conditions

- you discover the dashboard-submit seam cannot be implemented cleanly without widening the public PDPP API
- you discover the controller-managed path cannot own interaction brokerage without breaking CLI/orchestrate interaction behavior
- you find that avoiding secret persistence is materially incompatible with the proposed route shape
