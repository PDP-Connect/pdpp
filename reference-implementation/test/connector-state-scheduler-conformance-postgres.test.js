/**
 * Connector state, schedule, and active-run conformance — Postgres
 * adapter spike.
 *
 * Test-only proof slice for the
 * `define-reference-operation-environments` change (task 3.2). Runs the
 * reusable conformance scenarios from
 * `helpers/connector-state-scheduler-conformance.js` against a
 * Postgres-backed driver that reimplements the three concerns
 * (connector sync state, schedule registry, active-run registry plus
 * restart reconciliation) directly in Postgres, with no coupling to the
 * SQLite reference helpers.
 *
 * Environment gate:
 *   - When `PDPP_TEST_POSTGRES_URL` is set, the harness runs against
 *     that connection string. Each scenario provisions a fresh,
 *     uniquely-named schema in `setup()` and drops it in `teardown()`,
 *     so concurrent harness runs do not collide and a leftover schema
 *     from a crashed run is bounded to its own namespace.
 *   - When the env var is unset, this file registers a single skipped
 *     test so the suite still acknowledges the proof exists but does
 *     not fail in environments without Postgres.
 *
 * The Postgres dependency (`pg`) is dev-scoped on
 * `reference-implementation` because this is a test-only spike. There
 * is no production Postgres adapter being introduced here.
 *
 * Spec: openspec/changes/define-reference-operation-environments/
 *       (task 3.2 Postgres-oriented storage proof).
 */

import test from 'node:test';

import { runConnectorStateSchedulerConformance } from './helpers/connector-state-scheduler-conformance.js';
import { createPostgresConnectorStateSchedulerDriver } from './helpers/postgres-connector-state-scheduler-driver.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres connector-state/scheduler conformance (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  runConnectorStateSchedulerConformance({
    label: 'postgres-spike',
    test,
    makeDriver: () =>
      createPostgresConnectorStateSchedulerDriver({ connectionString: POSTGRES_URL }),
  });
}
