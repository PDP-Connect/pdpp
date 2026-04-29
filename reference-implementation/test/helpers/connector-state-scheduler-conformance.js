/**
 * Connector state, schedule, and active-run conformance harness.
 *
 * Test-only helper. Defines durable persistence obligations of three
 * adjacent reference-runtime concerns as reusable scenarios that any
 * candidate driver can be evaluated against by supplying a small driver
 * object:
 *
 *   - Connector sync state (`connector_state` and `grant_connector_state`):
 *     owner-scoped upsert/list, overwrite per `(connector_id, stream)`,
 *     grant-scoped isolation, allowed-stream filtering on read.
 *
 *   - Schedule registry (`connector_schedules`): one row per connector,
 *     create/update/list/pause/resume/delete behavior.
 *
 *   - Active-run registry (`controller_active_runs`): at most one active
 *     run per connector, lookup, delete, and abandoned-run cleanup at
 *     restart.
 *
 * The driver shape is intentionally narrow and *semantic*: it speaks in
 * reference-runtime lifecycle terms (put/get state, upsert/list/delete
 * schedule, insert/list/delete active run, simulate restart) and does not
 * expose raw SQL, table names, or a generic repository surface. It is not
 * exported from production code and SHALL NOT be treated as a production
 * `ConnectorStateStore` / `SchedulerStore` / `ActiveRunStore` contract.
 *
 * Driver shape:
 *
 *   {
 *     async setup(): void
 *     async teardown(): void
 *
 *     // Connector sync state
 *     //
 *     // `scope` is `{ connectorId, grantId? }`. When `grantId` is null or
 *     // absent the call addresses owner-scoped state; otherwise it
 *     // addresses grant-scoped state for that grant.
 *     //
 *     // `stateByStream` is `{ [streamName]: cursorObject }` — one cursor
 *     // object per stream; the driver MUST persist every entry as a
 *     // separate `(scope, stream)` row.
 *     //
 *     // Returns the canonical projection:
 *     //   { object: 'stream_state', connector_id, grant_id, state, updated_at }
 *     async putConnectorState(scope, stateByStream): StateProjection
 *
 *     // Read state for a scope. `allowedStreams` (optional array of stream
 *     // names) narrows the projection to the listed streams; rows that
 *     // are not in the set are filtered out without being deleted.
 *     async getConnectorState(scope, { allowedStreams } = {}): StateProjection
 *
 *     // Schedule registry
 *     //
 *     // `patch` mirrors the runtime controller's `ConnectorSchedulePatch`:
 *     //   { interval_seconds, jitter_seconds?, enabled? }
 *     // The driver MUST persist exactly one row per connector and MUST
 *     // preserve `created_at` across updates.
 *     async upsertSchedule(connectorId, patch): ScheduleSummary
 *     async getSchedule(connectorId): ScheduleSummary | null
 *     async listSchedules(): ScheduleSummary[]
 *     async setScheduleEnabled(connectorId, enabled): ScheduleSummary
 *     // Returns true if a row was deleted, false if the connector had no
 *     // schedule. Repeated delete on the same connector returns false.
 *     async deleteSchedule(connectorId): boolean
 *
 *     // Active-run registry
 *     //
 *     // `run` is `{ runId, traceId, scenarioId, startedAt }`. The driver
 *     // MUST enforce one active row per connector and a unique run_id
 *     // across the registry.
 *     async insertActiveRun(connectorId, run): void
 *     async getActiveRun(connectorId): ActiveRunSummary | null
 *     async listActiveRuns(): ActiveRunSummary[]
 *     async deleteActiveRun(connectorId, runId): void
 *
 *     // Simulate a process restart that re-runs the controller's
 *     // abandoned-run reconciliation. After this resolves the driver
 *     // MUST report zero active runs and MUST have surfaced a
 *     // run.failed terminal event for any previously-active run that did
 *     // not already have one. The driver SHALL provide a synchronous
 *     // way to inspect terminal events for a run via
 *     // `wasRunMarkedFailed(runId)` so the harness can prove the
 *     // reconciliation effect without coupling to the spine schema.
 *     async simulateRestart(): void
 *     async wasRunMarkedFailed(runId): boolean
 *   }
 *
 * Spec: openspec/changes/add-connector-state-scheduler-conformance-harness/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';

export const CONNECTOR_A = 'https://test.pdpp.org/connectors/conformance-a';
export const CONNECTOR_B = 'https://test.pdpp.org/connectors/conformance-b';

export const STREAM_X = 'stream_x';
export const STREAM_Y = 'stream_y';

export const GRANT_1 = 'grant_conformance_1';
export const GRANT_2 = 'grant_conformance_2';

/**
 * Run the connector-state / schedule / active-run conformance suite against
 * a driver.
 *
 * @param {object} options
 * @param {string} options.label                                       distinguishes the driver in test names
 * @param {(name: string, fn: () => Promise<void>) => void} options.test  test runner (e.g. `node:test`'s `test`)
 * @param {() => Promise<object> | object} options.makeDriver           returns a fresh driver per scenario
 */
export function runConnectorStateSchedulerConformance({ label, test, makeDriver }) {
  const t = (name, fn) => test(`[conformance:${label}] ${name}`, fn);

  // ────────────────────────────────────────────────────────────────────────
  // Connector state — owner-scoped
  // ────────────────────────────────────────────────────────────────────────

  // Pins the owner-scoped upsert/list invariant: each `(connector_id,
  // stream)` writes a single row, multiple streams round-trip together,
  // and the projection's `connector_id`/`grant_id` reflect the addressed
  // scope.
  t('owner-scoped state put/get round-trips multiple streams under one connector', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const written = await driver.putConnectorState(
        { connectorId: CONNECTOR_A },
        {
          [STREAM_X]: { cursor: 'x:1', items: 3 },
          [STREAM_Y]: { cursor: 'y:7', items: 9 },
        },
      );
      assert.equal(written.object, 'stream_state');
      assert.equal(written.connector_id, CONNECTOR_A);
      assert.equal(written.grant_id, null);

      const got = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      assert.equal(got.object, 'stream_state');
      assert.equal(got.connector_id, CONNECTOR_A);
      assert.equal(got.grant_id, null);
      assert.deepEqual(got.state, {
        [STREAM_X]: { cursor: 'x:1', items: 3 },
        [STREAM_Y]: { cursor: 'y:7', items: 9 },
      });
      assert.ok(typeof got.updated_at === 'string' && got.updated_at.length > 0);
    } finally {
      await driver.teardown();
    }
  });

  // Pins the per-(connector, stream) overwrite rule: writing the same
  // stream twice must replace the prior cursor rather than appending or
  // duplicating rows.
  t('owner-scoped state overwrites per (connector, stream) on second put', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A },
        { [STREAM_X]: { cursor: 'x:1' } },
      );
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A },
        { [STREAM_X]: { cursor: 'x:2' } },
      );

      const got = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      assert.deepEqual(got.state, { [STREAM_X]: { cursor: 'x:2' } });
    } finally {
      await driver.teardown();
    }
  });

  // Pins inter-connector isolation for owner-scoped state: reading state
  // for one connector must not surface streams persisted under another
  // connector with the same stream name.
  t('owner-scoped state for connector A is isolated from connector B', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A },
        { [STREAM_X]: { source: 'a' } },
      );
      await driver.putConnectorState(
        { connectorId: CONNECTOR_B },
        { [STREAM_X]: { source: 'b' } },
      );

      const a = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      const b = await driver.getConnectorState({ connectorId: CONNECTOR_B });
      assert.deepEqual(a.state, { [STREAM_X]: { source: 'a' } });
      assert.deepEqual(b.state, { [STREAM_X]: { source: 'b' } });
    } finally {
      await driver.teardown();
    }
  });

  // Pins read-side narrowing by `allowedStreams`. The reference helper
  // `getSyncState` accepts `allowedStreams` and filters out rows not in
  // the set. This is the only stream-allowlist check the helper
  // currently performs; route handlers enforce manifest membership and
  // grant-scope membership separately. Drivers MUST implement the read
  // filter; pre-write rejection of unknown streams is *not* required at
  // this layer (see "Deferrals" comment block at the file foot).
  t('owner-scoped state read narrows by allowedStreams without deleting other rows', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A },
        {
          [STREAM_X]: { cursor: 'x:1' },
          [STREAM_Y]: { cursor: 'y:1' },
        },
      );

      const narrow = await driver.getConnectorState(
        { connectorId: CONNECTOR_A },
        { allowedStreams: [STREAM_X] },
      );
      assert.deepEqual(narrow.state, { [STREAM_X]: { cursor: 'x:1' } });

      // The narrowing is read-only; subsequent unfiltered read still
      // returns both streams. This catches drivers that mistakenly
      // delete or hide rows when an allowlist is applied.
      const wide = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      assert.deepEqual(wide.state, {
        [STREAM_X]: { cursor: 'x:1' },
        [STREAM_Y]: { cursor: 'y:1' },
      });
    } finally {
      await driver.teardown();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Connector state — grant-scoped
  // ────────────────────────────────────────────────────────────────────────

  // Pins owner/grant isolation: a grant-scoped write MUST NOT surface in
  // owner-scoped reads, and an owner-scoped write MUST NOT surface in
  // grant-scoped reads. This is the durable invariant that lets later
  // adapters split the two scopes into different tables or partitions
  // without changing semantics.
  t('grant-scoped state is isolated from owner-scoped state on the same connector', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A },
        { [STREAM_X]: { who: 'owner' } },
      );
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A, grantId: GRANT_1 },
        { [STREAM_X]: { who: 'grant_1' } },
      );

      const owner = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      const grant = await driver.getConnectorState({ connectorId: CONNECTOR_A, grantId: GRANT_1 });
      assert.deepEqual(owner.state, { [STREAM_X]: { who: 'owner' } });
      assert.equal(owner.grant_id, null);
      assert.deepEqual(grant.state, { [STREAM_X]: { who: 'grant_1' } });
      assert.equal(grant.grant_id, GRANT_1);
    } finally {
      await driver.teardown();
    }
  });

  // Pins inter-grant isolation under a single connector: two distinct
  // grants must not bleed into each other.
  t('grant-scoped state for grant 1 is isolated from grant 2 on the same connector', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A, grantId: GRANT_1 },
        { [STREAM_X]: { who: 'grant_1' } },
      );
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A, grantId: GRANT_2 },
        { [STREAM_X]: { who: 'grant_2' } },
      );

      const g1 = await driver.getConnectorState({ connectorId: CONNECTOR_A, grantId: GRANT_1 });
      const g2 = await driver.getConnectorState({ connectorId: CONNECTOR_A, grantId: GRANT_2 });
      assert.deepEqual(g1.state, { [STREAM_X]: { who: 'grant_1' } });
      assert.deepEqual(g2.state, { [STREAM_X]: { who: 'grant_2' } });
    } finally {
      await driver.teardown();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Schedule registry
  // ────────────────────────────────────────────────────────────────────────

  // Pins the create case: an upsert against an empty registry produces
  // exactly one row whose fields reflect the patch and whose
  // `created_at`/`updated_at` are populated.
  t('schedule upsert creates one row per connector with patch fields populated', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const created = await driver.upsertSchedule(CONNECTOR_A, {
        interval_seconds: 1800,
        jitter_seconds: 30,
        enabled: true,
      });
      assert.equal(created.connector_id, CONNECTOR_A);
      assert.equal(created.interval_seconds, 1800);
      assert.equal(created.jitter_seconds, 30);
      assert.equal(created.enabled, true);
      assert.ok(typeof created.created_at === 'string' && created.created_at.length > 0);
      assert.ok(typeof created.updated_at === 'string' && created.updated_at.length > 0);

      const list = await driver.listSchedules();
      assert.equal(list.length, 1);
      assert.equal(list[0].connector_id, CONNECTOR_A);
    } finally {
      await driver.teardown();
    }
  });

  // Pins the update case: a second upsert on the same connector must
  // change interval/jitter/enabled while preserving connector identity
  // and `created_at`. This is the invariant that catches drivers that
  // (a) insert a duplicate row instead of updating, or (b) overwrite
  // `created_at` on update.
  t('schedule upsert updates existing row in place and preserves created_at', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const first = await driver.upsertSchedule(CONNECTOR_A, {
        interval_seconds: 1800,
        jitter_seconds: 30,
        enabled: true,
      });
      const second = await driver.upsertSchedule(CONNECTOR_A, {
        interval_seconds: 3600,
        jitter_seconds: 60,
        enabled: false,
      });

      assert.equal(second.connector_id, CONNECTOR_A);
      assert.equal(second.interval_seconds, 3600);
      assert.equal(second.jitter_seconds, 60);
      assert.equal(second.enabled, false);
      assert.equal(
        second.created_at,
        first.created_at,
        'second upsert must preserve the original created_at',
      );

      const list = await driver.listSchedules();
      assert.equal(list.length, 1, 'second upsert must update in place rather than insert a duplicate');
    } finally {
      await driver.teardown();
    }
  });

  // Pins the pause/resume invariant: toggling enabled must not lose the
  // current interval or jitter. Drivers that recompute defaults on
  // toggle would fail this scenario.
  t('schedule pause then resume toggles enabled without losing interval or jitter', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.upsertSchedule(CONNECTOR_A, {
        interval_seconds: 1800,
        jitter_seconds: 30,
        enabled: true,
      });

      const paused = await driver.setScheduleEnabled(CONNECTOR_A, false);
      assert.equal(paused.enabled, false);
      assert.equal(paused.interval_seconds, 1800);
      assert.equal(paused.jitter_seconds, 30);

      const resumed = await driver.setScheduleEnabled(CONNECTOR_A, true);
      assert.equal(resumed.enabled, true);
      assert.equal(resumed.interval_seconds, 1800);
      assert.equal(resumed.jitter_seconds, 30);
    } finally {
      await driver.teardown();
    }
  });

  // Pins listing order independence and per-connector identity: two
  // connectors with schedules surface as two distinct rows with the
  // right fields. We assert by-id rather than by-position to keep the
  // harness driver-agnostic about ordering.
  t('schedule list surfaces all configured connectors', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.upsertSchedule(CONNECTOR_A, { interval_seconds: 60 });
      await driver.upsertSchedule(CONNECTOR_B, { interval_seconds: 120 });

      const list = await driver.listSchedules();
      assert.equal(list.length, 2);
      const byId = Object.fromEntries(list.map((row) => [row.connector_id, row]));
      assert.ok(byId[CONNECTOR_A]);
      assert.ok(byId[CONNECTOR_B]);
      assert.equal(byId[CONNECTOR_A].interval_seconds, 60);
      assert.equal(byId[CONNECTOR_B].interval_seconds, 120);
    } finally {
      await driver.teardown();
    }
  });

  // Pins delete and idempotence-of-absence: the first delete of a known
  // schedule reports success (true), the second delete reports
  // not-found (false), and the row is gone from list/get. Mirrors the
  // controller's current `deleteSchedule` returning a boolean and the
  // route's 204→404 response sequence.
  t('schedule delete removes the row and repeated delete reports not-found', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.upsertSchedule(CONNECTOR_A, { interval_seconds: 1800 });
      const first = await driver.deleteSchedule(CONNECTOR_A);
      assert.equal(first, true, 'first delete should report a row was removed');

      const got = await driver.getSchedule(CONNECTOR_A);
      assert.equal(got, null, 'schedule should be gone after delete');

      const second = await driver.deleteSchedule(CONNECTOR_A);
      assert.equal(second, false, 'repeated delete should report not-found');
    } finally {
      await driver.teardown();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Active-run registry
  // ────────────────────────────────────────────────────────────────────────

  // Pins per-connector exclusivity. The current SQLite reference uses a
  // PRIMARY KEY on `connector_id` plus an upsert ON CONFLICT, so a
  // second insert *replaces* the prior row rather than throwing. Either
  // shape is acceptable as long as the registry never holds two
  // simultaneous rows for the same connector. Drivers MAY throw on
  // collision; if they upsert, the new run id MUST win.
  t('active-run registry holds at most one row per connector', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.insertActiveRun(CONNECTOR_A, {
        runId: 'run_one',
        traceId: 'trc_1',
        scenarioId: 'scn_1',
        startedAt: '2026-04-28T00:00:00.000Z',
      });

      let collisionThrew = false;
      try {
        await driver.insertActiveRun(CONNECTOR_A, {
          runId: 'run_two',
          traceId: 'trc_2',
          scenarioId: 'scn_2',
          startedAt: '2026-04-28T00:01:00.000Z',
        });
      } catch {
        collisionThrew = true;
      }

      const list = await driver.listActiveRuns();
      const forA = list.filter((row) => row.connector_id === CONNECTOR_A);
      assert.equal(forA.length, 1, 'connector A must have exactly one active row');
      if (!collisionThrew) {
        assert.equal(
          forA[0].run_id,
          'run_two',
          'when collision is resolved by upsert, the newer run id must win',
        );
      } else {
        assert.equal(
          forA[0].run_id,
          'run_one',
          'when collision throws, the original row must remain intact',
        );
      }
    } finally {
      await driver.teardown();
    }
  });

  // Pins cross-connector run_id uniqueness. The current SQLite schema
  // declares `run_id UNIQUE` on `controller_active_runs` (and an index
  // on the column) precisely so a run id minted for one connector
  // cannot also be minted for another. Drivers MUST either reject the
  // duplicate insert (throw) or ignore it (no-op); they MUST NOT
  // rebind the existing run id from connector A to connector B. Either
  // way the original connector A row stays intact, the registry holds
  // exactly one row under that run id, and connector B has no active
  // row. A driver that silently moves the run id to connector B
  // (e.g. UPDATE … WHERE run_id = ?) fails this scenario, as does a
  // driver that lets both rows persist.
  t('active-run run_id is unique across connectors', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.insertActiveRun(CONNECTOR_A, {
        runId: 'run_shared',
        traceId: 'trc_a',
        scenarioId: 'scn_a',
        startedAt: '2026-04-28T00:00:00.000Z',
      });

      try {
        await driver.insertActiveRun(CONNECTOR_B, {
          runId: 'run_shared',
          traceId: 'trc_b',
          scenarioId: 'scn_b',
          startedAt: '2026-04-28T00:01:00.000Z',
        });
      } catch {
        // Throwing the duplicate is acceptable; the row-state
        // assertions below pin the invariant whether the driver
        // throws or no-ops.
      }

      const list = await driver.listActiveRuns();
      const sharedRows = list.filter((row) => row.run_id === 'run_shared');
      assert.equal(
        sharedRows.length,
        1,
        'run_id must be unique across the active-run registry',
      );
      assert.equal(
        sharedRows[0].connector_id,
        CONNECTOR_A,
        'duplicate run_id must not rebind the existing row to a different connector',
      );
      assert.equal(
        sharedRows[0].trace_id,
        'trc_a',
        'original row trace_id must remain intact after a duplicate run_id attempt',
      );
      const onB = await driver.getActiveRun(CONNECTOR_B);
      assert.equal(
        onB,
        null,
        'connector B must have no active row when its insert duplicated an existing run_id',
      );
    } finally {
      await driver.teardown();
    }
  });

  // Pins lookup-by-connector. `getActiveRun(connectorId)` must surface
  // the registry row's run/trace/scenario/started_at for that
  // connector, and return null when nothing is active.
  t('active-run lookup by connector returns null when absent and the row when present', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      assert.equal(await driver.getActiveRun(CONNECTOR_A), null);

      await driver.insertActiveRun(CONNECTOR_A, {
        runId: 'run_lookup',
        traceId: 'trc_lookup',
        scenarioId: 'scn_lookup',
        startedAt: '2026-04-28T00:00:00.000Z',
      });

      const got = await driver.getActiveRun(CONNECTOR_A);
      assert.ok(got, 'expected an active-run row');
      assert.equal(got.connector_id, CONNECTOR_A);
      assert.equal(got.run_id, 'run_lookup');
      assert.equal(got.trace_id, 'trc_lookup');
    } finally {
      await driver.teardown();
    }
  });

  // Pins delete + run-id guard. The current reference deletes by
  // `(connector_id, run_id)` so a stale delete with the wrong run_id
  // does not race a freshly-overwritten row. Drivers MUST honor that
  // guard.
  t('active-run delete is scoped by (connector_id, run_id) and does not affect a different run id', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.insertActiveRun(CONNECTOR_A, {
        runId: 'run_current',
        traceId: 'trc',
        scenarioId: 'scn',
        startedAt: '2026-04-28T00:00:00.000Z',
      });

      // Stale delete from a previously-active run id; must not clear the row.
      await driver.deleteActiveRun(CONNECTOR_A, 'run_stale');
      const stillThere = await driver.getActiveRun(CONNECTOR_A);
      assert.ok(stillThere, 'mismatched run_id delete must not remove the active row');
      assert.equal(stillThere.run_id, 'run_current');

      // Correct delete clears it.
      await driver.deleteActiveRun(CONNECTOR_A, 'run_current');
      assert.equal(await driver.getActiveRun(CONNECTOR_A), null);
    } finally {
      await driver.teardown();
    }
  });

  // Pins startup reconciliation. After a simulated restart any rows
  // that had been left in the active registry must be cleared, and a
  // run.failed terminal event must have been surfaced for each one
  // that did not already have one. The harness asks the driver via a
  // narrow `wasRunMarkedFailed` accessor instead of reading the spine
  // table directly so the contract is at the lifecycle layer.
  t('simulated restart reconciles abandoned runs and emits run.failed for each', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.insertActiveRun(CONNECTOR_A, {
        runId: 'run_abandoned_a',
        traceId: 'trc_a',
        scenarioId: 'scn_a',
        startedAt: '2026-04-28T00:00:00.000Z',
      });
      await driver.insertActiveRun(CONNECTOR_B, {
        runId: 'run_abandoned_b',
        traceId: 'trc_b',
        scenarioId: 'scn_b',
        startedAt: '2026-04-28T00:01:00.000Z',
      });

      await driver.simulateRestart();

      const remaining = await driver.listActiveRuns();
      assert.deepEqual(remaining, [], 'restart must clear stale active-run rows');

      assert.equal(await driver.wasRunMarkedFailed('run_abandoned_a'), true);
      assert.equal(await driver.wasRunMarkedFailed('run_abandoned_b'), true);
    } finally {
      await driver.teardown();
    }
  });
}

/*
 * Deferrals (deliberately not enforced at the persistence layer)
 *
 * - Manifest-stream membership: route handlers (`PUT /v1/state/:connectorId`)
 *   reject writes whose stream is not declared in the connector manifest.
 *   The persistence helper itself accepts any stream name. Tests covering
 *   manifest enforcement live in `pdpp.test.js`.
 *
 * - Grant scope rejection: route handlers reject writes whose stream is
 *   not in the grant's `grantedStreams` set. The helper accepts the write
 *   and only filters the *projection* via `allowedStreams`. Coverage for
 *   the route-side rejection lives in `pdpp.test.js`.
 *
 * - Schedule input validation: the controller's `validateScheduleInput`
 *   throws `ControllerError('invalid_request')` on bad patches, but that
 *   is policy above persistence. The harness covers persistence behavior
 *   for valid inputs; controller-level tests in `control-actions.test.js`
 *   cover input rejection.
 *
 * - `minimum_interval_warning`: the controller composes a policy warning
 *   based on the connector manifest's `refresh_policy.minimum_interval_seconds`.
 *   Warning composition is policy-not-persistence; coverage stays in
 *   `control-actions.test.js`.
 *
 * - Active-run interaction projection: pending interactions are tracked
 *   in an in-memory `activeRunInteractions` map and a separate
 *   `run.interaction_required` spine event, not in
 *   `controller_active_runs`. Coverage stays in
 *   `run-interaction-control.test.js`.
 *
 * If a future adapter changes any of these surfaces, the harness must be
 * updated explicitly rather than implicitly extended via route tests.
 */
