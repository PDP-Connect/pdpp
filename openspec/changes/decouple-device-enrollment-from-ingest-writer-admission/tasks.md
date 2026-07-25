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

## 5. Close the D2 gap: pending-code partial-write idempotency (D5)

- [x] 5.1 Derive `deviceId`/`sourceInstanceId` deterministically from `enrollment.enrollmentCodeId` (`deriveEnrollmentDeviceId`/`deriveEnrollmentSourceInstanceId`, same SHA-256-prefix pattern as `makeConnectorInstanceId`) instead of `generateSpineId(...)` random values, in `performFirstEnrollment`.
- [x] 5.2 `createDevice`: `ON CONFLICT(device_id) DO NOTHING` on both SQLite (`insert-device.sql`) and Postgres backends, so a retry/concurrent duplicate first attempt converges on one row.
- [x] 5.3 `performFirstEnrollment` issues the credential via `rotateDeviceCredential` (not a plain `createCredential` insert) so concurrent/retried first attempts for the same deterministic device converge on exactly one active credential.
- [x] 5.4 Extract `resolveEnrollResumeDeviceId`: returns `enrollment.deviceId` for a `consumed` code (D2), or the deterministic device id for a `pending` code ONLY if that device row already exists (D5), else `null`. Route both cases through `handleIdempotentReEnroll`.
- [x] 5.5 Extend `handleIdempotentReEnroll` to accept an explicit `boundDeviceId` parameter (not just read from `enrollment.deviceId`) and to consume the enrollment code when it is still `pending` (idempotent via `WHERE status = 'pending'`).
- [x] 5.6 `performFirstEnrollment`'s `!consumed` fallback (a concurrent request won the consume race) no longer revokes the shared deterministic device; it resolves through `handleIdempotentReEnroll` instead.
- [x] 5.7 Map raw Postgres `23505` to a typed retryable `503` (`enrollment_identity_conflict`) in `respondEnrollError`, defense-in-depth alongside the existing `connector_instance_busy` mapping.
- [x] 5.8 Add a test-only fault-injection seam (`__setEnrollPhaseFaultHookForTest`, mirrors the file's existing `deviceIngestPhaseFaultHook`) firing after `upsertSourceInstance` and before consume; production never installs it.
- [x] 5.9 Postgres mutation-grade oracle: inject the fault to leave identity-created-but-not-consumed state, retry the same pending code, assert `201` + convergence on one device/connector-instance/source-instance/active-credential + exactly-once consume + the returned token actually authenticates. Verified two ways: reverting the deterministic-identity derivation alone fails this oracle (3/3) while D1/D4 still pass; reverting the credential-rotation change alone fails the companion concurrency oracle (3/3).
- [x] 5.10 Adversarial oracle: a pending code with no existing device row still enrolls normally (not misrouted into resume).
- [x] 5.11 Concurrency oracles on both backends (SQLite in-process, Postgres with genuinely independent connections): N concurrent first attempts for the same pending code converge on one device/connector-instance/source-instance and exactly one active credential.
- [x] 5.12 Re-verify D1-D4 oracles, the SQLite D2/D3 idempotency suite, and the `polyfill-manifest-reconcile-bounded-work-postgres` invariant unmodified and green.

## 6. Gates

- [x] 6.1 `openspec validate --strict` passes.
- [x] 6.2 Full device-exporter + coordinator test suites green; all oracles (D1-D5) green.
- [x] 6.3 Lint/format (biome) clean on touched files; `tsc --noEmit` clean; complexity-mass ratchet passes (justification updated for `ref-device-exporters.ts`).
