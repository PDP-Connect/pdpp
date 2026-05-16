# Tasks

## 1. OpenSpec And Scope Guard

- [ ] 1.1 Land this change with proposal, design, tasks, and spec delta.
- [ ] 1.2 Confirm `openspec validate design-local-collector-state-sync --strict` passes.
- [ ] 1.3 Cross-reference `introduce-local-collector-runner`, `implement-local-device-exporter`, `add-gmail-attachment-backfill`, and `complete-local-agent-collectors` so this change is the canonical place for STATE load/replay/persist semantics.

## 2. Server: Device-Scoped State Endpoints

- [ ] 2.1 Add `GET /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` mounted with `requireDeviceExporterCredential`. Reject if path `deviceId !== req.deviceExporter.deviceId`. Reject if `getSourceInstance(deviceId, sourceInstanceId)` is unknown. Return `{ state: { ... }, updated_at: string | null }`.
- [ ] 2.2 Add `PUT /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` mounted with `requireDeviceExporterCredential`. Accept `{ state: { [stream]: cursor } }`. Same path and source-instance checks as the GET.
- [ ] 2.3 Both routes derive the storage connector id with the existing `referenceLocalDeviceStorageConnectorId(connectorId, sourceInstanceId)` helper. Pass `grantId: null` to `connectorStateStore`.
- [ ] 2.4 Owner-session and client-grant token paths SHALL be rejected on these routes, mirroring the existing device-exporter middleware. Reuse `requireDeviceExporterCredential` without modification.
- [ ] 2.5 Document the two new routes in the reference operator surface (generated `_ref` routes) and the local-device-exporter runbook.

## 3. Server: Storage Wiring

- [ ] 3.1 Confirm `connector-state-store` accepts the derived internal storage connector id without changes. Add a route-level test that proves it.
- [ ] 3.2 Add server tests for `(deviceId, sourceInstanceId)` isolation: two devices, same connector id, different state rows; one device, two source instances, two state rows.
- [ ] 3.3 Add server test that an owner-auth call to `GET /v1/state/:connectorId` for the public connector id returns no rows from device-scoped runs and vice versa.

## 4. LocalDeviceClient: State Methods

- [ ] 4.1 Add `getSourceInstanceState({ sourceInstanceId })` and `putSourceInstanceState({ sourceInstanceId, state })` to `LocalDeviceClient`. Both authenticated with the existing device token. Add to `LOCAL_DEVICE_ENDPOINTS`.
- [ ] 4.2 Add `LocalDeviceClient` unit tests covering: success, 401/403 from server, 404 unknown source instance, malformed body responses.

## 5. Collector Runner: Load And Replay STATE

- [ ] 5.1 Extend `buildCollectorStartMessage(streams, streamsToBackfill, priorState?)` to populate `start.state` only when `priorState` is a non-empty object.
- [ ] 5.2 In `runCollectorConnector`, fetch state via `getSourceInstanceState` before `collectConnectorMessages`. Treat empty body or absence as no prior state.
- [ ] 5.3 On state-read failure, emit a `blocked` heartbeat with `last_error.kind = "state_read_failed"` and exit non-zero before spawn.
- [ ] 5.4 Update `CollectorChildContext` and `buildCollectorChildEnv` only if needed; do not add a new owner-credential env var. State remains in `START` only.

## 6. Collector Runner: Buffer And Persist Emitted STATE

- [ ] 6.1 In `collectConnectorMessages`, retain `STATE` messages alongside `RECORD` (do not silently drop them).
- [ ] 6.2 Project emitted `STATE` messages into a `{ [stream]: cursor }` map with per-stream last-wins ordering. Drop `STATE` for streams not in `START.scope.streams` and log a warning.
- [ ] 6.3 After `drainCollectorQueue` returns, if the queue has zero unsent items, `PUT` the state map to the device-scoped state endpoint. If retrying items remain, skip the `PUT` for this pass.
- [ ] 6.4 On `PUT state` failure after records were accepted, surface via heartbeat `status: "retrying"` with `last_error.kind: "state_put_failed"`. The next pass re-reads state, accepts duplicate-ingest absorption, and retries.

## 7. Tests

- [ ] 7.1 Unit: collector runner replays prior state through `START.state`.
- [ ] 7.2 Unit: emitted `STATE` is buffered and flushed once, after records drain.
- [ ] 7.3 Unit: queue with retrying items skips state flush and preserves prior state.
- [ ] 7.4 Unit: out-of-scope `STATE` is dropped and warned.
- [ ] 7.5 Integration: device credential cannot reach `/v1/state/:connectorId`; owner session cannot reach `_ref/device-exporters/.../state`.
- [ ] 7.6 Integration: two-device, same-connector isolation across state rows.
- [ ] 7.7 Gmail attachment backfill fixture run restarts and resumes from prior `attachments` stream cursor without re-emitting completed UID windows. No live Gmail.

## 8. Documentation

- [ ] 8.1 Update `reference-implementation/docs/local-device-exporter.md` Boundaries to mention state read/write as device-scoped.
- [ ] 8.2 Update `reference-implementation/docs/generated/reference-ref-routes.md` to include the two new endpoints.
- [ ] 8.3 Add a one-paragraph note in `introduce-local-collector-runner` tasks `4. Local Collector Runner MVP` pointing to this change as the canonical source for STATE behavior.

## 9. Acceptance Checks

- [ ] 9.1 `openspec validate design-local-collector-state-sync --strict` passes.
- [ ] 9.2 `collector-runner.test.ts` covers state load/replay/persist scenarios (7.1–7.4) and passes.
- [ ] 9.3 Reference route tests for device state pass (7.5–7.6).
- [ ] 9.4 Gmail attachment backfill fixture restart test passes (7.7).
- [ ] 9.5 Manual: run the collector against a fixture connector that emits `STATE`, restart the runner, observe replayed cursor on the next pass.
