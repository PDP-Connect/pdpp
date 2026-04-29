## Context

`tmp/workstreams/refactor-operation-mount-inventory-report.md` lists `/_ref/schedules` and `/_ref/connectors/:connectorId/schedule` as deferred until `SchedulerStore` lands. That extraction has shipped as part of `extract-low-risk-reference-stores`, so the read paths can now move behind canonical operation capsules without touching scheduler persistence or active-run semantics.

## Decision

Create operation modules under `reference-implementation/operations/`:

- `ref-schedules-list` — owns the `{object: 'list', data}` envelope for `/_ref/schedules`.
- `ref-connector-schedule-get` — owns the `schedule` projection and the `not_found`-shaped failure for `/_ref/connectors/:connectorId/schedule`.

Each operation SHALL receive its data dependency in capability shape (`listSchedules()`, `getConnectorSchedule(connectorId)`), not a raw controller, scheduler store, or database handle. Host adapters in `reference-implementation/server/index.js` SHALL own owner auth, HTTP status, and response writing only; they SHALL NOT assemble envelopes locally.

The operation modules SHALL pass the shared operation-boundary gate: no Fastify, Next, SQLite, Postgres, `getDb()`, `server/auth.js`, `server/index.js`, `process` / `process.env`, or sandbox imports.

The not-found path on `/_ref/connectors/:connectorId/schedule` SHALL preserve the existing `pdppError(res, 404, 'not_found', ...)` envelope shape. The operation surfaces the not-found condition by throwing a typed error; the host adapter maps it to the existing PDPP 404 envelope through the shared `handleError` helper.

## Stop Conditions

Stop for owner review if the implementation:

- changes existing `/_ref/schedules` or `/_ref/connectors/:connectorId/schedule` response shapes;
- changes 404 status code or error envelope semantics for missing schedules;
- weakens owner-auth gating;
- alters scheduler persistence, refresh policy, default mode, or active-run semantics;
- requires passing a raw controller, scheduler store, or database handle into an operation module to satisfy the capability surface;
- overlaps with scheduler mutation routes or `runNow`/interaction operation work.

## Acceptance Checks

- Existing schedule and control-action route tests remain green.
- New operation-boundary tests cover both modules.
- `ref-read-owner-gate` remains green for `/_ref/schedules` and `/_ref/connectors/:connectorId/schedule`.
- Connector-state-scheduler conformance remains green.
- `openspec validate mount-ref-schedules-operations --strict` passes.
- `openspec validate --all --strict` passes.
