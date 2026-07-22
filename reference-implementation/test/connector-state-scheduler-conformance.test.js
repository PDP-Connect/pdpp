// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector state, schedule, and active-run conformance — SQLite reference
 * driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/connector-state-scheduler-conformance.js` against the current
 * SQLite-backed reference helpers (`getSyncState` / `putSyncState` for
 * connector state, `createController` for schedules, and the registered
 * `controllerUpsertActiveRun` / `controllerListActiveRuns` /
 * `controllerDeleteActiveRun` queries for the active-run registry).
 *
 * Replaces nothing on its own; existing route/controller suites
 * (`control-actions.test.js`, `scheduler.test.js`,
 * `run-interaction-control.test.js`, the state slices in `pdpp.test.js`)
 * remain as direct integration evidence alongside this conformance run.
 *
 * Spec: openspec/changes/add-connector-state-scheduler-conformance-harness/
 *       specs/reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { runConnectorStateSchedulerConformance } from './helpers/connector-state-scheduler-conformance.js';
import { createSqliteConnectorStateSchedulerDriver } from './helpers/sqlite-connector-state-scheduler-driver.js';

runConnectorStateSchedulerConformance({
  label: 'sqlite-reference',
  test,
  makeDriver: () => createSqliteConnectorStateSchedulerDriver(),
});
