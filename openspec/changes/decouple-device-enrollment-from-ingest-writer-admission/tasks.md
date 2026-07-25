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

## 5. Close the D2 gap: pending-code partial-write idempotency (D5, superseded by D6 — see section 6)

- [x] 5.1 (superseded by 6.1) Original approach derived `deviceId`/`sourceInstanceId` deterministically from `enrollment.enrollmentCodeId`. A second live counterexample (D6) proved this was the wrong stable key — a fresh code for the same collector derives different ids than an expired code's orphan, still colliding on the connector-instance identity and/or leaking a second orphaned device.
- [x] 5.2 `createDevice`: `ON CONFLICT(device_id) DO NOTHING` on both SQLite (`insert-device.sql`) and Postgres backends — retained under D6, now a defensive guard against random-id collision rather than an identity-convergence mechanism.
- [x] 5.3 (superseded by 6.4) `performFirstEnrollment` issues credentials via `rotateDeviceCredential` — retained under D6.
- [x] 5.4 (superseded by 6.3, 6.5) Original `resolveEnrollResumeDeviceId` combined D2 (consumed-code) and D5 (pending-code deterministic-id) resume into one function. D6 splits these: `respondIfConsumedCodeReplay` handles only the D2 case explicitly; the pending-code case is resolved separately and atomically inside `performFirstEnrollment`.
- [x] 5.5 Extend `handleIdempotentReEnroll` to accept an explicit `boundDeviceId` parameter and to consume the enrollment code when it is still `pending` — retained under D6.
- [x] 5.6 (superseded by 6.6) Original `!consumed` fallback assumed a concurrent loser's device was always identical to the winner's (true only under D5's deterministic-per-code scheme). D6 re-derives this: re-reads the code's actual bound device after a failed consume and only resolves via `handleIdempotentReEnroll` when it matches; otherwise explicitly revokes the losing attempt's own orphaned device.
- [x] 5.7 Map raw Postgres `23505` to a typed retryable `503` (`enrollment_identity_conflict`) in `respondEnrollError` — retained under D6, still defense-in-depth.
- [x] 5.8 Add a test-only fault-injection seam (`__setEnrollPhaseFaultHookForTest`) firing after `upsertSourceInstance` and before consume; production never installs it — retained under D6, extended with a second rendezvous point in section 6.
- [x] 5.9 Postgres mutation-grade oracle for the retry-of-same-code case — retained and re-verified under D6's identity scheme.
- [x] 5.10 Adversarial oracle: a pending code with no existing device row still enrolls normally — retained under D6.
- [x] 5.11 Concurrency oracles on both backends — retained under D6, now also mutation-tested against the D6 durable lock (section 6.8).
- [x] 5.12 Re-verify D1-D4 oracles, the SQLite D2/D3 idempotency suite, and the `polyfill-manifest-reconcile-bounded-work-postgres` invariant unmodified and green.

## 6. Correct the identity key to the stable binding, durably serialize, restore the pre-existing re-enroll contract (D6, fix-enroll-stable-binding-identity-key)

- [x] 6.1 Re-derive identity resolution off the STABLE `(ownerSubjectId, connectorId, localBindingId)` binding — not `enrollment.enrollmentCodeId` — since a fresh code minted after an expired code's partial-write orphan must resolve to the SAME collector identity, and only the binding (not the ephemeral code id) is stable across multiple codes for one collector.
- [x] 6.2 Add `resolveOrCreateEnrollmentDevice` (new store method, both SQLite and Postgres): looks up an existing ORPHANED device for the binding (has a `device_source_instances` row, but NO enrollment code ever successfully consumed for it) and adopts it if found; otherwise creates a fresh device AND a placeholder `device_source_instances` row (`connector_instance_id NULL`) atomically. Fails closed (throws) if more than one orphan candidate is found.
- [x] 6.3 Postgres: wrap the lookup-and-create in a transaction opening with `pg_advisory_xact_lock` keyed on the binding (distinct namespace prefix from the ingest-admission advisory lock) — a durable, database-backed serialization boundary, not a process-local lock, since two genuinely concurrent enroll attempts for the same empty binding could otherwise both observe "no orphan" before either commits.
- [x] 6.4 SQLite: no explicit lock needed (better-sqlite3's synchronous, single-connection execution model already provides the same exclusivity) — documented in the method itself.
- [x] 6.5 Restore the pre-existing, intentional "re-enrolling the same connector + local_binding_name resumes one stable connector_instance" contract (`device-exporter-routes.test.js`, predates this change): a genuinely NEW enrollment for an ALREADY-COMPLETED binding (live device with a consumed code) mints a NEW device, never adopts the live one — only orphans (never-consumed identity) are eligible for adoption. Revert `deviceId`/`sourceInstanceId` to `generateSpineId(...)` random generation for the fresh-device case.
- [x] 6.6 Fix the `!consumed` fallback in `performFirstEnrollment`: re-read the enrollment code's actual bound `device_id` after a failed consume; only resolve via `handleIdempotentReEnroll` when it matches this attempt's own device (the concurrent-winner-adopted-first case); otherwise `revokeDevice` this attempt's own now-orphaned device before rejecting, so no active credential for an abandoned device survives the request. (`handleIdempotentReEnroll`'s binding-match check alone cannot distinguish these cases, since `performFirstEnrollment` always writes a matching source instance for both the winner and a same-binding orphan.)
- [x] 6.7 Add explicit rejection (`respondIfConsumedCodeReplay`) for a declined D2 resume on a `consumed` code, replacing the prior fall-through-to-`performFirstEnrollment` — a `consumed` code can never be claimed by `consumeEnrollmentCode`, so falling through created a permanently-unclaimable orphan device masked as a `201` success.
- [x] 6.8 Postgres mutation-grade, deterministic durable-lock oracle: hold two concurrent enroll attempts for the SAME pending code at TWO sequential rendezvous points (`after_identity_before_consume` — proves zero credential rows exist; `after_rotation_before_consume` — proves state before either D2 cleanup-rotation fallback can mask a defect). Removing the `pg_advisory_xact_lock` call makes this oracle fail 5/5 runs (`2 !== 1` devices); the D5→D6 concurrency oracle and the D6 stable-binding adoption oracle independently fail under the same mutation too. Restored and re-verified green.
- [x] 6.9 Stable-binding adoption oracle: code A reaches identity creation, its expiry is moved into the past (not a synthetic shortcut — the exact live scenario), code A fails closed as expired; a FRESH code B for the SAME binding adopts code A's orphaned identity with no manual cleanup; final state converges to one device/connector-instance/source-instance/active-credential; code A stays revoked, never consumed.
- [x] 6.10 Isolation oracle: two distinct local bindings never share identity; a fresh code for an already-completed binding mints a new device while resuming the same connector_instance (proves 6.5's contract holds).
- [x] 6.11 Fixed test-mock gaps surfaced by the D6 restructure: the D3 mock (`device-enroll-admission-idempotency.test.js`) updated to mock `resolveOrCreateEnrollmentDevice` instead of `getDevice`/`createDevice`.
- [x] 6.12 Re-verify the full regression suite, including the pre-existing `device-exporter-routes.test.js` "re-enrolling..." test that a first D6 draft broke and which drove the design correction in 6.5.

## 7. Gates

- [x] 7.1 `openspec validate --strict` passes.
- [x] 7.2 Full device-exporter + coordinator test suites green; all oracles (D1-D6) green.
- [x] 7.3 Lint/format (biome) clean on touched files; `tsc --noEmit` clean; complexity-mass ratchet passes (justifications updated for `ref-device-exporters.ts` and `device-exporter-store.ts`).
