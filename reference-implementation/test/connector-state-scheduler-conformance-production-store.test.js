/**
 * Connector state, schedule, and active-run conformance — production
 * SQLite store driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/connector-state-scheduler-conformance.js` against the
 * production `ConnectorStateStore` and `SchedulerStore` SQLite
 * implementations directly. This is the production-store-backed test
 * adapter required by the `extract-low-risk-reference-stores` change
 * (task 2.5): the new production interfaces must satisfy the same
 * conformance gate that the existing test-only driver satisfies.
 *
 * Replaces nothing on its own; the existing
 * `connector-state-scheduler-conformance.test.js` (which exercises the
 * legacy helpers via `getSyncState`/`putSyncState` and the controller
 * mutation methods) remains in place so we have parallel evidence that
 * route-shaped callers and direct store callers agree.
 *
 * Spec: openspec/changes/extract-low-risk-reference-stores/
 *       specs/reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { runConnectorStateSchedulerConformance } from './helpers/connector-state-scheduler-conformance.js';
import { createProductionStoreConnectorStateSchedulerDriver } from './helpers/production-store-connector-state-scheduler-driver.js';

runConnectorStateSchedulerConformance({
  label: 'production-sqlite-store',
  test,
  makeDriver: () => createProductionStoreConnectorStateSchedulerDriver(),
});
