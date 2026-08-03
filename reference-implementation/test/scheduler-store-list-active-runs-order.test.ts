// Regression + parity test for an ORDER BY drift between the SQLite and
// Postgres `listActiveRuns()` implementations in
// server/stores/scheduler-store.ts.
//
// The SQLite path (`controllerListActiveRuns`, backed by
// server/queries/controller/list-active-runs.sql) orders
// `ORDER BY started_at ASC, connector_id ASC, connector_instance_id ASC`.
// This is used by `reconcileAbandonedControllerRuns` at startup to
// enumerate stale controller-managed runs left behind by a mid-run
// restart, so the order determines which stale run is reconciled first.
//
// The Postgres `createPostgresSchedulerStore().listActiveRuns()` omitted
// `started_at` entirely and ordered only
// `ORDER BY connector_id, connector_instance_id` — startup reconciliation
// order diverged between backends (no data loss, but a silent behavioral
// drift).
//
// This test seeds three active-run rows across both backends whose
// `connector_id` alphabetical order is the OPPOSITE of their `started_at`
// chronological order, so a `connector_id`-only sort and a
// `started_at`-first sort produce different, distinguishable orderings.
// Both backends must return rows sorted by `started_at` first.
//
// Spec: server/queries/controller/list-active-runs.sql (source of truth
// for the ordering contract both backends must match).

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.ts';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.ts';
import {
  createPostgresSchedulerStore,
  createSqliteSchedulerStore,
} from '../server/stores/scheduler-store.ts';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// connector_id alphabetical order: connector_a, connector_b, connector_c.
// started_at chronological order: connector_c (earliest), connector_a,
// connector_b (latest). A connector_id-only sort would put connector_a
// first; a started_at-first sort must put connector_c first.
const SEED_RUNS = [
  {
    connector_id: 'connector_a',
    connector_instance_id: 'connector_a',
    run_id: 'run_a',
    trace_id: 'trace_a',
    scenario_id: 'scenario_a',
    started_at: '2026-01-01T00:02:00.000Z',
    run_generation: 1,
  },
  {
    connector_id: 'connector_b',
    connector_instance_id: 'connector_b',
    run_id: 'run_b',
    trace_id: 'trace_b',
    scenario_id: 'scenario_b',
    started_at: '2026-01-01T00:03:00.000Z',
    run_generation: 1,
  },
  {
    connector_id: 'connector_c',
    connector_instance_id: 'connector_c',
    run_id: 'run_c',
    trace_id: 'trace_c',
    scenario_id: 'scenario_c',
    started_at: '2026-01-01T00:01:00.000Z',
    run_generation: 1,
  },
];

const EXPECTED_ORDER_BY_STARTED_AT = ['run_c', 'run_a', 'run_b'];

async function runOrderConformance(store, label) {
  for (const record of SEED_RUNS) {
    await store.upsertActiveRun(record);
  }
  const rows = await store.listActiveRuns();
  const orderedRunIds = rows.map((row) => row.run_id);
  assert.deepEqual(
    orderedRunIds,
    EXPECTED_ORDER_BY_STARTED_AT,
    `${label}: listActiveRuns must order by started_at ASC first (got ${JSON.stringify(orderedRunIds)})`,
  );
}

test('SQLite: listActiveRuns orders by started_at ASC, not connector_id', async () => {
  initDb(':memory:');
  try {
    const store = createSqliteSchedulerStore();
    await runOrderConformance(store, 'sqlite');
  } finally {
    closeDb();
  }
});

if (!POSTGRES_URL) {
  test('Postgres: listActiveRuns orders by started_at ASC (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('Postgres: listActiveRuns orders by started_at ASC, not connector_id (parity with SQLite)', async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery('DELETE FROM controller_active_runs');
      const store = createPostgresSchedulerStore();
      await runOrderConformance(store, 'postgres');
    } finally {
      await postgresQuery('DELETE FROM controller_active_runs').catch(() => {});
      await closePostgresStorage();
    }
  });
}
