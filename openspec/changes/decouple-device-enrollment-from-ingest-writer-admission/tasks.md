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

## 4. Close the D1 residual coupling: derived-column repair backfill (D4)

- [x] 4.1 Gate `postgresBackfillRecordSortPositionsForManifest` (Postgres) and `backfillSqliteRecordSemanticTimesForManifest` (SQLite) inside `registerConnector` (auth.js) behind the same `options.backfillRetrievalIndexes !== false` condition that already guards lexical/semantic retrieval-index backfill. Keep Postgres manifest-cache invalidation unconditional (not fenced).
- [x] 4.2 Add a Postgres mutation-grade oracle: enroll + ingest one record for a first `codex` device, hold the writer-admission gate on that first device's `connector_instance_id`, then enroll a second `codex` device while the gate is held; assert the second enroll completes and returns a distinct `connector_instance_id` (fails before 4.1, passes after; reverting 4.1 alone fails this oracle while the D1 oracle in 1.2 still passes).
- [x] 4.3 Re-verify D2 (idempotent re-enroll) and D3 (typed 503) oracles unmodified and green.
- [x] 4.4 Re-verify the `polyfill-manifest-reconcile-bounded-work-postgres` "zero records-table queries" oracle stays green (confirms `backfillRetrievalIndexes: false` callers other than enroll are unaffected).

## 5. Gates

- [x] 5.1 `openspec validate --strict` passes.
- [x] 5.2 Full device-exporter + coordinator test suites green; all oracles (D1-D4) green.
- [x] 5.3 Lint/format (biome) clean on touched files; `tsc --noEmit` clean.
