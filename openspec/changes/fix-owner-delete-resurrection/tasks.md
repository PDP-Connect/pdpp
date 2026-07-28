## 1. Root cause + design proof

- [x] Reproduce resurrection against the real SQLite store: hard-delete a
      `local_device` connection, then `upsert` the same deterministic
      identity (new device_id/source_instance_id, same
      owner/connector/source_kind/local_binding_name) — confirm the row
      re-materializes `status: active`, `revoked_at: null` on the SAME
      `connector_instance_id`.
- [x] Trace every real-world caller that can reach that `upsert` collision:
      device-exporter `/enroll` (deterministic binding key from
      `local_binding_name`) is the only reachable one; browser-enrollment
      shells and static-secret/manual-upload drafts all use fresh random
      binding keys and can never collide with a tombstoned identity.
- [x] ~~Rule out boot-time resurrection~~ — **CORRECTED (independent judge
      gate report):
      this was WRONG.** The original audit checked `startServer` in
      `server/index.js` for calls to `connectorInstanceStore.upsert` and
      found none, but missed `migrateLocalDeviceConnectorInstances`
      (`server/db.js`) / `migratePostgresLocalDeviceConnectorInstances`
      (`server/postgres-storage.js`) — raw-SQL migrations, not store
      `.upsert()` calls, invoked unconditionally on every `initDb()` /
      `bootstrapPostgresSchema()`. The judge reproduced live resurrection
      through this exact path: delete a connection, close/reopen the DB
      with no other action, and the row comes back active. This IS the
      startup-migration trigger the live incident's "after a normal stack
      rebuild" phrasing actually describes — see the corrected root-cause
      write-up in `proposal.md` and section 7 below.
- [x] Evaluate reusing `connector_instances` (new terminal `deleted` status)
      instead of a new table; find it unsafe without a much larger audit —
      `connector-summary-evidence-engine.ts`'s unscoped `SELECT *` discovery
      reads, `records.js`/`connector-state-store.ts`/
      `record-source-checkpoint.ts`'s unfiltered by-id reads all treat every
      `connector_instances` row as live; document this proof in the
      proposal instead of adding the table by default.

## 2. Schema

- [x] Add `connector_instance_tombstones` table to `server/db.js` (SQLite)
      and `server/postgres-storage.js` (Postgres): `connector_instance_id`,
      `owner_subject_id`, `connector_id`, `source_kind`,
      `source_binding_key`, `deleted_at`, with a UNIQUE constraint on
      `(owner_subject_id, connector_id, source_kind, source_binding_key)`
      mirroring `connector_instances`' own uniqueness — this is the exact
      identity axis a resurrecting `upsert` collides on.
- [x] No configuration, display name, or record data in the tombstone row —
      identity + deletion timestamp only.

## 3. Store logic

- [x] `deleteConnection` (both SQLite and Postgres arms): write the
      tombstone row (`INSERT ... ON CONFLICT DO NOTHING`, idempotent) inside
      the SAME cascade transaction that removes the `connector_instances`
      row — no new transaction, no new failure mode; the existing I8
      atomicity tests must still pass unchanged (tombstone write rolls back
      with everything else on a mid-cascade failure).
- [x] `upsert` (both arms): on the path where no existing row is found for
      the target identity (a real `ON CONFLICT DO UPDATE` hit on a LIVE row
      is untouched — revoke, pause, reactivate-by-re-enroll all keep their
      current behavior), check the tombstone table for that identity FIRST.
      If a tombstone exists, throw
      `ConnectorInstanceDeleteError('connection_tombstoned', ...)` instead
      of inserting.
- [x] Verify `ensureDefaultAccountConnection`'s existing revoke-durability
      guard (read-before-write on a live revoked row) is unaffected — it
      short-circuits before reaching `upsert` and is untouched by this
      change.

## 4. Route surface

- [x] `server/routes/ref-device-exporters.ts` `/enroll`: map
      `connection_tombstoned` to a typed 409 (operator-facing: this binding
      was owner-deleted; re-enroll under a distinct `local_binding_name`),
      rather than letting the raw store error surface as a 500.

## 5. Tests (discriminating, SQLite + Postgres, restart + re-registration)

- [x] `connector-instance-store.test.js`: SQLite — delete a `local_device`
      connection, then attempt `upsert` under the exact same identity with a
      DIFFERENT `device_id`/`source_instance_id` (simulating device
      reinstall / re-enrollment) — assert `connection_tombstoned`, assert
      `store.get(id)` still returns `null` (no row was created).
- [x] Same test, Postgres arm (gated the same way existing Postgres
      `deleteConnection` tests are gated in this file).
- [x] Restart-survival: close and reopen the SQLite handle
      (`closeDb()`/`initDb()` against the SAME file path) between delete and
      the resurrecting `upsert` attempt — assert the tombstone (and the
      block) survives the reopen, proving this is not an in-memory guard.
- [x] Mutation proof: a variant of the atomicity test that deletes the
      tombstone-write statement's effect (by asserting the negative) —
      show that WITHOUT the tombstone check, the exact same `upsert` call
      succeeds and resurrects the row (this is the pre-fix reproduction,
      kept as a documented regression test on the OLD behavior being wrong,
      not just a happy-path assertion of the new behavior).
- [x] Unaffected-sibling test: delete one binding, `upsert` a DIFFERENT
      binding (different `local_binding_name`) for the same owner/connector
      — assert it succeeds normally with a new id, proving the tombstone is
      identity-scoped, not connector- or owner-wide.
- [x] Unaffected-revoke test: revoke (not delete) a connection, then
      `upsert` the SAME identity (re-enroll) — assert this still succeeds
      and reactivates, exactly as before this change (revoke's existing
      "row still exists" reactivation-by-re-enroll behavior is explicitly
      preserved, not touched).
- [x] `deleteConnection` I8 atomicity tests: extend the existing
      record-purge-failure and post-purge-failure rollback tests to also
      assert no tombstone row exists after a rolled-back delete.
- [x] Device-exporter route test: `/enroll` against a tombstoned identity
      returns 409 with a typed, non-secret error body.

## 6. Verification

- [x] `openspec validate fix-owner-delete-resurrection --strict` passes.
- [x] Focused tests green: `connector-instance-store.test.js` (8/8, SQLite +
      dedicated-test Postgres), `device-exporter-routes.test.js` (32/32),
      `device-exporter-store.test.js` (6/6, SQLite + Postgres),
      `owner-connection-delete.test.js` + `owner-connection-revoke.test.js`
      + `owner-connection-reactivate.test.js` (39/39, unchanged/no
      regression).
- [x] Complete touched-behavioral-surface suite green: the above plus all 13
      `connector-summary-evidence-*.test.js` files (43/43, 12 Postgres-gated
      skips, no failures) and all 4 pinned `codeToStatus` contract files +
      the spot-check (24/24) — see "Pinned-contract fallout" below.
  - Note: a full unscoped repo-wide `pnpm test` was started and stopped
    partway through per owner direction (isolated maker lane, not the
    integration gate) after reaching 3411/3411 passing with zero failures
    on everything it reached; this is informative, not authoritative, and
    does not replace the scoped suite above.
- [x] Typecheck clean on all touched files (`pnpm typecheck`, zero errors).
- [x] Lint clean on all touched `.ts` files (`.js` files are the repo's
      documented pre-existing lint-exempt legacy set, unrelated to this
      change).
- [x] Diff review: 15 files touched, all intentional (schema x2, SQL x2,
      query registry, error-status table, store, route error test, 5
      test files including 4 pinned-contract snapshots that needed
      updating for the new `connection_tombstoned` code); no
      secrets/record contents in the tombstone table (identity + timestamp
      only) or its logging.
- [x] Report LAND/REVISE with evidence in the independent owner report.

### Pinned-contract fallout (discovered during verification)

Adding `connection_tombstoned` to `codeToStatus` broke FOUR separate
pre-existing exhaustive/snapshot pins of the whole table (a heavily
duplicated defensive pattern in this repo, not something this change
introduced): `error-code-status-table-exhaustive.test.js`,
`ref-error-status-full-table.test.js`, `ref-error-status-exhaustive.test.js`,
and `ref-error-status-completeness-oracle.test.js` (which also hardcodes the
table's total entry count, updated 48 -> 49). All four updated in lockstep,
consistent with each file's own stated purpose ("a deliberate speed bump on
the externally-observable status contract").

## 7. REVISE closure packet (independent judge gate, 2026-07-25)

Judge report: independent owner gate report.
Verdict REVISE, critical finding: the startup local-device migration sweep
(both backends) bypasses the tombstone entirely and reproducibly
resurrects a deleted connection on a bare restart — the actual "stack
rebuild" trigger, not re-enrollment.

- [x] `server/db.js` `migrateLocalDeviceConnectorInstances`: add the same
      tombstone check as `upsert`'s no-existing-row path, immediately
      before the bare-INSERT fallback (`resolvedInstanceId` computed via
      `canonicalConnectorInstanceId`); skip (continue the loop, do not
      throw — a background sweep, not an owner-facing request) any row
      whose identity is tombstoned. Emits an `onSchemaMigration` event
      (`skippedTombstonedRow`) matching this file's existing logging
      convention for every other migration.
- [x] `server/postgres-storage.js` `migratePostgresLocalDeviceConnectorInstances`:
      same guard, same skip semantics, on the bare-INSERT path.
- [x] Fix the SQLite migration's binding-key derivation: replaced the local
      `sourceBindingKey()`/`connectorInstanceId()` functions (which hashed
      the FULL `{kind, device_id, local_binding_name, source_instance_id}`
      shape) with imports of the canonical `makeConnectorInstanceSourceBindingKey`
      / `makeConnectorInstanceId` from `connector-instance-utils.ts` — the
      SAME shared authority `postgres-storage.js` already used correctly
      and the store's own `upsert` uses. One authority, not a duplicate;
      required for the migration's tombstone lookup to find the identity
      the store's `deleteConnection` actually tombstoned.
- [x] Added a realistic restart regression test
      (`connector-instance-store.test.js`, SQLite + Postgres variants):
      seeds `device_source_instances`/`device_exporters` exactly as a real
      device enrollment leaves them, runs the REAL `deleteConnection`
      cascade (not a hand-rolled UPDATE), then re-runs a full `initDb()` /
      `initPostgresStorage()` boot (not a direct call to the migration
      function) and asserts no row reappears — across two consecutive
      restarts. Verified this test fails deterministically (reproduces the
      judge's exact live-incident shape: resurrected row, `status: active`,
      `revokedAt: null`) when the fix is reverted, on both backends.
- [x] Evaluated the "should fix" TOCTOU finding
      (`connector-instance-store.js` Postgres `upsert` not covered by
      `withConnectorInstanceWrite`'s per-identity lock): wrapping `upsert`
      broke the SQLite arm's synchronous calling contract for a production
      caller (`ref-static-secret-draft-connection.ts`'s
      `createDraftConnection`) and four test call sites that call
      `store.upsert(...)` without `await` — SQLite's `upsert` was
      deliberately synchronous (better-sqlite3 is single-connection,
      single-process; no genuine multi-process race exists on that
      backend). Scoped the coordination fix to Postgres only, matching the
      judge's exact finding; reverted the SQLite wrap.
- [x] Verified the Postgres coordination is a REAL cross-process
      mechanism, not merely in-process: `withConnectorInstanceWrite`'s
      Postgres path (`postgresCoordinationEnabled()` /
      `acquirePostgresAdvisoryLock`) issues a genuine
      `pg_try_advisory_lock`, enforced by the Postgres server across
      separate connections/sessions — confirmed by reading the
      implementation and the two existing dedicated-Postgres coordinator
      tests (`connector-instance-write-coordinator.test.js`) that already
      exercise it against a live Postgres instance.
- [x] Added a genuine two-OS-process discriminator
      (`test/connector-instance-delete-upsert-two-process-race.test.js` +
      `test/fixtures/connector-instance-two-process-race-fixture.mjs`,
      mirroring the existing SQLite two-process oracle's structure):
      spawns a real second OS process holding its own Postgres session,
      races it against the parent's `deleteConnection` for the identical
      identity. Added a test-only, env-gated delay
      (`PDPP_TEST_UPSERT_TOMBSTONE_CHECK_DELAY_MS`,
      `testOnlyUpsertTombstoneCheckDelay` in
      `connector-instance-store.js`, no-op in production) inside the
      Postgres `upsert`'s tombstone-check-to-INSERT window so the race is
      deterministically reproducible rather than a timing-luck flake.
      Verified this test FAILS deterministically (reproduces the exact
      live-incident resurrection shape via two real OS processes) with the
      Postgres `upsert` coordination wrap removed, and PASSES with it
      restored — genuine regression-sensitivity proof, not a happy-path
      assertion.
- [x] Updated `proposal.md` and the spec delta to name the startup
      migration as the definitive, proven, zero-action trigger; kept
      device-exporter re-enrollment documented as a real, independently
      reachable, and independently tested secondary path (both share the
      identical defect and fix) rather than removing it — it is proven
      real by its own passing regression test, just not the higher-
      confidence explanation for the specific "stack rebuild" incident
      framing.
- [x] Added two new spec scenarios: "The startup local-device migration
      sweep does not resurrect a deleted connection on a bare restart" and
      "A concurrent delete and upsert for the same identity never produce
      a resurrected row (Postgres)".
- [x] `openspec validate fix-owner-delete-resurrection --strict` passes
      with the updated spec.
- [x] Scoped focused-gate verification (SQLite + dedicated Postgres +
      startup/device/error-mapping — NOT an unbounded full suite, per
      owner direction) green: `connector-instance-store.test.js` (10/10,
      including the two new startup-migration restart tests),
      `connector-instance-delete-upsert-two-process-race.test.js` (1/1, the
      new genuine two-OS-process discriminator), `device-exporter-routes.test.js`
      (32/32), `owner-connection-delete/revoke/reactivate.test.js` (39/39,
      unchanged), `device-exporter-store.test.js` +
      `connector-instance-write-coordinator.test.js` (11/11, including the
      two real-Postgres advisory-lock coordinator tests),
      `error-code-status-table-exhaustive.test.js` +
      `ref-error-status-*.test.js` (24/24), `connector-summary-evidence-*.test.js`
      (40/40 + 9 legitimate Postgres-gated skips),
      `device-exporter-state-routes.test.js` (12/12, including the
      pre-existing legacy-migration tests, confirming the migration guard
      did not regress genuine legacy-row migration behavior). Typecheck
      clean; no `.ts` files touched this revision, so no new lint surface.
- [x] New commit (additive correction, prior commit NOT amended); report
      updated to final LAND/REVISE verdict.
