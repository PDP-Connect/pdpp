// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import test from "node:test";

import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";
import { CONFORMANCE_CONNECTOR_ID, runAggregationRowsConformance } from "./helpers/aggregation-rows-conformance.ts";
import { createSqliteAggregationRowsDriver } from "./helpers/sqlite-aggregation-rows-driver.ts";

// Two distinct connector_instance_ids to exercise the multi-account scenario.
// We derive them with the same helper production code uses so the IDs are
// realistic (not arbitrary strings).
const INSTANCE_A = makeDefaultAccountConnectorInstanceId("owner_local", CONFORMANCE_CONNECTOR_ID);
const INSTANCE_B = makeDefaultAccountConnectorInstanceId("owner_second", CONFORMANCE_CONNECTOR_ID);

runAggregationRowsConformance({
  connectorInstanceIdA: INSTANCE_A,
  connectorInstanceIdB: INSTANCE_B,
  label: "sqlite-reference",
  makeDriver: () => createSqliteAggregationRowsDriver(),
  test,
});
