// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Aggregation-rows conformance — Postgres driver (env-gated).
 *
 * Runs the same conformance scenarios as `aggregation-rows-conformance.test.js`
 * against the production Postgres-backed `listRowsForAggregation` path,
 * gated on `PDPP_TEST_POSTGRES_URL`.
 *
 * This is the pre-migration baseline proof for the Postgres backend: the
 * same invariants that hold on SQLite (including the critical
 * `record_json is a string` invariant — Postgres stores JSONB and the
 * production code stringifies before returning) must also hold here.
 *
 * When `PDPP_TEST_POSTGRES_URL` is unset, a single skipped test is
 * registered so the suite remains visible in CI output without failing.
 *
 * Target for local runs:
 *   docker run -d --name pg-pilot -p 55463:5432 \
 *     -e POSTGRES_USER=pdpp -e POSTGRES_PASSWORD=pdpp \
 *     -e POSTGRES_DB=pdpp_pilot \
 *     pgvector/pgvector:pg16
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55463/pdpp_pilot \
 *     node --import tsx test/aggregation-rows-conformance-postgres.test.js
 *
 * Spec: openspec/changes/pilot-storage-backend-interface/
 */

import test from 'node:test';

import { makeDefaultAccountConnectorInstanceId } from '../server/stores/connector-instance-store.js';
import {
  CONFORMANCE_CONNECTOR_ID,
  runAggregationRowsConformance,
} from './helpers/aggregation-rows-conformance.js';
import { createPostgresAggregationRowsDriver } from './helpers/postgres-aggregation-rows-driver.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres aggregation-rows conformance (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  // Instance ids must be unique per run to avoid cross-test pollution when
  // running against a shared Postgres instance. Each Postgres driver
  // instance carries a session-unique connector_id suffix already; we derive
  // the instance ids from THAT prefixed connector_id only AFTER the driver is
  // constructed. The conformance harness receives fixed instance id strings
  // and the driver seeds/queries using those strings directly — the driver
  // itself does not enforce which instance_ids the harness uses.
  //
  // Since the driver scopes all its teardown to connector_id (not instance_id),
  // any instance_id values that resolve to real rows in the session-unique
  // connector's schema will be cleaned up correctly.
  //
  // We pick two deterministic-looking ids here; the driver's connector_id
  // isolation is what truly prevents cross-session pollution.
  const suffix = `${Date.now().toString(36)}_pg`;
  const INSTANCE_A = makeDefaultAccountConnectorInstanceId('owner_local', `${CONFORMANCE_CONNECTOR_ID}_${suffix}`);
  const INSTANCE_B = makeDefaultAccountConnectorInstanceId('owner_second', `${CONFORMANCE_CONNECTOR_ID}_${suffix}`);

  runAggregationRowsConformance({
    label: 'postgres',
    test,
    makeDriver: () => createPostgresAggregationRowsDriver({ connectionString: POSTGRES_URL }),
    connectorInstanceIdA: INSTANCE_A,
    connectorInstanceIdB: INSTANCE_B,
  });
}
