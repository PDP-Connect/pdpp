## 1. Decouple enroll from the ingest writer fence (D1)

- [x] 1.1 `ensureReferenceConnectorCatalogEntry` (index.js + reference-local-connector-catalog.ts) SHALL call `registerConnector(localCollectorManifest, { backfillRetrievalIndexes: false })` for the local-collector manifest branch.
- [x] 1.2 Add a Postgres full-server integration oracle: hold the connector-instance writer fence for the enroll's connector, saturate the admission gate, then enroll; assert the enroll completes and returns `201` + `device_token` (fails before 1.1, passes after).

## 2. Idempotent re-enroll with strict safeguards (D2)

- [x] 2.1 Add a `rotateDeviceCredential(deviceId, ...)` primitive to the device-exporter store (both SQLite and Postgres) that revokes all non-revoked credentials for the device and inserts exactly one fresh credential.
- [x] 2.2 In the enroll handler, when the code status is `consumed`: enforce (unexpired) + (bound to same device, not revoked) + (same binding), then rotate the credential, reuse the existing device/source/connector-instance, emit a `device.enroll.credential_rotated` audit receipt, and return the fresh token. Reject mismatched binding/device and expired replays.
- [x] 2.3 Wire `emitSpineEvent` into the device-exporters route context in index.js.
- [x] 2.4 Idempotency oracle: enroll → re-POST same code → new token, same device_id + connector_instance_id, exactly one active credential, old token invalid, rotation audit event.
- [x] 2.5 Adversarial tests: replay after expiry (`410`), replay for different binding/device (rejected), concurrent retries (≤1 active credential, no duplicate device), old-token invalidation.

## 3. Typed retryable backpressure (D3)

- [x] 3.1 In the enroll handler, catch `connector_instance_busy` and return `503` + `{ retryable: true }` + `Retry-After`, never `500`.
- [x] 3.2 Test: force `connector_instance_busy` on the enroll path → assert `503` + `retryable` + `Retry-After`.

## 4. Gates

- [x] 4.1 `openspec validate` passes.
- [x] 4.2 Full device-exporter + coordinator test suites green; new oracles green.
- [x] 4.3 Lint/format (biome) clean on touched files.
