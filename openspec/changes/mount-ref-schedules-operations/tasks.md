## 1. Baseline

- [x] 1.1 Inventory `GET /_ref/schedules` and `GET /_ref/connectors/:connectorId/schedule` route flow.
- [x] 1.2 Confirm response shapes pinned by `control-actions.test.js`, `ref-read-owner-gate.test.js`, and `owner-auth.test.js`.
- [x] 1.3 Identify capability-shaped read dependencies on the controller (`listSchedules`, `getSchedule`).

## 2. Operation Modules

- [x] 2.1 Implement `ref.schedules.list` operation under `operations/ref-schedules-list/index.ts`.
- [x] 2.2 Implement `ref.connector-schedule.get` operation under `operations/ref-connector-schedule-get/index.ts` with a typed `not_found` error.
- [x] 2.3 Keep operation modules free of Fastify, Next, SQLite, process/env, controller, and store internals.

## 3. Host Mounts

- [x] 3.1 Update `GET /_ref/schedules` route to call `executeRefSchedulesList` with an injected `listSchedules` capability.
- [x] 3.2 Update `GET /_ref/connectors/:connectorId/schedule` route to call `executeRefConnectorScheduleGet` with an injected `getConnectorSchedule` capability and translate the typed not-found error into the existing 404 envelope.
- [x] 3.3 Preserve owner-auth gates and existing error envelopes.

## 4. Tests

- [x] 4.1 Add `ref-schedules-list-boundary.test.js`.
- [x] 4.2 Add `ref-schedules-list-operation.test.js` covering envelope and dependency-order behavior.
- [x] 4.3 Add `ref-connector-schedule-get-boundary.test.js`.
- [x] 4.4 Add `ref-connector-schedule-get-operation.test.js` covering success projection and not-found error mapping.

## 5. Validation

- [x] 5.1 Run schedule/control-action tests (`control-actions.test.js`).
- [x] 5.2 Run owner-gate tests (`ref-read-owner-gate.test.js`, `owner-auth.test.js`).
- [x] 5.3 Run operation-boundary tests (per-op + `operations-boundary.test.js`).
- [x] 5.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 5.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 5.6 Run `openspec validate mount-ref-schedules-operations --strict`.
- [x] 5.7 Run `openspec validate --all --strict`.
- [x] 5.8 Run `pnpm workstreams:status -- --no-fail`.
