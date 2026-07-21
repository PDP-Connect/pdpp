/**
 * Aggregation-rows conformance — SQLite reference driver (always-run).
 *
 * Runs the reusable conformance scenarios from
 * `helpers/aggregation-rows-conformance.js` against the production
 * SQLite-backed `listRowsForAggregation` path. These tests establish the
 * baseline pre-migration proof: every scenario that must survive the
 * StorageBackend pilot migration passes against the current SQLite
 * implementation.
 *
 * Spec: openspec/changes/pilot-storage-backend-interface/
 */

import test from 'node:test';

import { makeDefaultAccountConnectorInstanceId } from '../server/stores/connector-instance-store.js';
import { CONFORMANCE_CONNECTOR_ID } from './helpers/aggregation-rows-conformance.js';
import { runAggregationRowsConformance } from './helpers/aggregation-rows-conformance.js';
import { createSqliteAggregationRowsDriver } from './helpers/sqlite-aggregation-rows-driver.js';

// Two distinct connector_instance_ids to exercise the multi-account scenario.
// We derive them with the same helper production code uses so the IDs are
// realistic (not arbitrary strings).
const INSTANCE_A = makeDefaultAccountConnectorInstanceId('owner_local', CONFORMANCE_CONNECTOR_ID);
const INSTANCE_B = makeDefaultAccountConnectorInstanceId('owner_second', CONFORMANCE_CONNECTOR_ID);

runAggregationRowsConformance({
  label: 'sqlite-reference',
  test,
  makeDriver: () => createSqliteAggregationRowsDriver(),
  connectorInstanceIdA: INSTANCE_A,
  connectorInstanceIdB: INSTANCE_B,
});
