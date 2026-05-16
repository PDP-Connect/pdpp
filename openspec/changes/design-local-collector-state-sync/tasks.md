# Tasks

## 1. OpenSpec And Scope Guard

- [x] 1.1 Land this change with proposal, design, tasks, and spec delta.
- [x] 1.2 Confirm `openspec validate design-local-collector-state-sync --strict` passes.
- [x] 1.3 Cross-reference `introduce-local-collector-runner`, `implement-local-device-exporter`, `add-gmail-attachment-backfill`, and `complete-local-agent-collectors` so this change is the canonical place for STATE load/replay/persist semantics.

## 2. Server: Device-Scoped State Endpoints

- [x] 2.1 Add `GET /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` mounted with `requireDeviceExporterCredential`. Reject if path `deviceId !== req.deviceExporter.deviceId`. Reject if `getSourceInstance(deviceId, sourceInstanceId)` is unknown. Return `{ state: { ... }, updated_at: string | null }`.
- [x] 2.2 Add `PUT /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` mounted with `requireDeviceExporterCredential`. Accept `{ state: { [stream]: cursor } }`. Same path and source-instance checks as the GET.
- [x] 2.3 Both routes derive the storage connector id with the existing `referenceLocalDeviceStorageConnectorId(connectorId, sourceInstanceId)` helper. Pass `grantId: null` to `connectorStateStore` (via the existing `getSyncState` / `putSyncState` wrappers in `records.js`).
- [x] 2.4 Owner-session and client-grant token paths SHALL be rejected on these routes, mirroring the existing device-exporter middleware. Reuse `requireDeviceExporterCredential` without modification.
- [x] 2.5 Document the two new routes in the reference operator surface (generated `_ref` routes) and the local-device-exporter runbook.

## 3. Server: Storage Wiring

- [x] 3.1 Confirm `connector-state-store` accepts the derived internal storage connector id without changes. Route-level test in `device-exporter-state-routes.test.js` proves it via the existing `putSyncState` wrapper.
- [x] 3.2 Server tests for `(deviceId, sourceInstanceId)` isolation: two devices, same connector id, different state rows ("Two-device isolation" test); one device, two source instances, two state rows ("Single device with two source instances" test).
- [x] 3.3 Server test that an owner-auth call to `GET /v1/state/:connectorId` for the public connector id returns no rows from device-scoped runs and vice versa ("Owner-auth /v1/state/:connectorId does not surface device-scoped rows" test).

## 4. LocalDeviceClient: State Methods

- [x] 4.1 Add `getSourceInstanceState({ sourceInstanceId })` and `putSourceInstanceState({ sourceInstanceId, state })` to `LocalDeviceClient`. Both authenticated with the existing device token. Added to `LOCAL_DEVICE_ENDPOINTS.sourceInstanceState`.
- [x] 4.2 `LocalDeviceClient` unit tests cover: success (GET + PUT), 401/403 rejection, 404 unknown source instance.

## 5. Collector Runner: Load And Replay STATE

- [x] 5.1 `buildCollectorStartMessage(streams, streamsToBackfill, priorState?)` populates `start.state` only when `priorState` is a non-empty object.
- [x] 5.2 In `runCollectorConnector`, fetch state via `getSourceInstanceState` before `collectConnectorMessages`. Empty body or absence is treated as no prior state.
- [x] 5.3 On state-read failure, the runner emits a `blocked` heartbeat and throws `CollectorStateReadError` before spawn so the CLI exits non-zero.
- [x] 5.4 `CollectorChildContext` and `buildCollectorChildEnv` are unchanged; no new owner-credential env var. State stays in `START` only.

## 6. Collector Runner: Buffer And Persist Emitted STATE

- [x] 6.1 `collectConnectorMessages` keeps every emitted message (RECORD, STATE, DONE, …); only RECORDs are queued for ingest.
- [x] 6.2 `projectEmittedState` projects emitted STATE messages into a `{ [stream]: cursor }` map with per-stream last-wins ordering. Out-of-scope STATE is dropped with a stderr warning.
- [x] 6.3 After `drainCollectorQueue` returns, if the queue has zero unsent items, the runner PUTs the state map to the device-scoped state endpoint. If retrying items remain, the runner skips the PUT for this pass and leaves prior state intact.
- [x] 6.4 On PUT failure after records were accepted, the runner emits a `retrying` heartbeat. The next pass re-reads state, accepts duplicate-ingest absorption, and retries.

## 7. Tests

- [x] 7.1 Unit: collector runner replays prior state through `START.state` (`collector-runner.test.ts` "replays prior STATE into the connector's START.state...").
- [x] 7.2 Unit: emitted `STATE` is buffered and flushed once, after records drain (same test).
- [x] 7.3 Unit: queue with retrying items skips state flush and preserves prior state ("skips state PUT when the queue still has retrying items").
- [x] 7.4 Unit: out-of-scope `STATE` is dropped and warned ("drops out-of-scope STATE messages with a warning").
- [x] 7.5 Integration: owner-token bearer rejected on device state routes; device credentials rejected on cross-device routes (`device-exporter-state-routes.test.js`).
- [x] 7.6 Integration: two-device, same-connector isolation across state rows (same file).
- [x] 7.7 Gmail-style replay regression: two-pass `runCollectorConnector` invocations show the cursor persisted by pass 1 is replayed into pass 2's `START.state` ("two-pass replay regression" test). No live Gmail required — the fixture connector emits the cursor shape the regression depends on.

## 8. Documentation

- [x] 8.1 Updated `reference-implementation/docs/local-device-exporter.md` Boundaries to mention state read/write as device-scoped.
- [x] 8.2 Regenerated `reference-implementation/docs/generated/reference-ref-routes.md` (and the matching OpenAPI artifacts) to include the two new endpoints.
- [x] 8.3 Replaced the outdated "this CLI does NOT yet persist or replay STATE" JSDoc on `bin/collector-runner.ts` with a pointer to this change.

## 9. Acceptance Checks

- [x] 9.1 `openspec validate design-local-collector-state-sync --strict` passes.
- [x] 9.2 `collector-runner.test.ts` covers state load/replay/persist scenarios (7.1–7.4, 7.7) and passes.
- [x] 9.3 Reference route tests for device state pass (7.5–7.6, plus owner/v1 isolation).
- [x] 9.4 Gmail-style fixture replay regression passes (7.7).
- [ ] 9.5 Manual: run the collector against a fixture connector that emits `STATE`, restart the runner, observe replayed cursor on the next pass. (Automated equivalent is 7.7; manual reproduction still recommended before broad rollout.)
