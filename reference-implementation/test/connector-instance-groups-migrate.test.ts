// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for connector-instance-groups-migrate.ts's applyMapping refusal
 * logic, run against a minimal fake `pg.Pool` (no live Postgres required).
 * Covers the P2 grant-scoped-records caveat fix: a fragment whose own status
 * is 'active' must be refused, because canonicalization is applied at
 * search's/Sources'/Explore's result-shaping boundary, not inside
 * `listActiveByConnector` (the grant-scoped/records fan-in enumerator) — an
 * active fragment would otherwise keep enumerating under its own raw id for
 * any grant-scoped records read even after being grouped.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { applyMapping, type MappingEntry } from "../scripts/connector-instance-groups-migrate.ts";

const ACTIVE_STATUS_REFUSAL_DETAIL = /is status 'active'/;

interface FakeInstance {
  connector_id: string;
  connector_instance_id: string;
  owner_subject_id: string;
  status: string;
}

/**
 * Minimal fake matching the exact `pool.query(sql, params)` call shapes
 * `applyMapping` issues: fetchInstance (SELECT ... FROM connector_instances
 * WHERE connector_instance_id = $1), the canonical-already-grouped check
 * (SELECT 1 FROM connector_instance_groups WHERE connector_instance_id = $1),
 * fragmentHasLiveSyncState's two queries (credentials, schedules), the
 * existing-group lookup, and the INSERT ... ON CONFLICT upsert.
 */
function makeFakePool(opts: {
  instances: readonly FakeInstance[];
  groupedIds?: readonly string[];
  hasCredential?: readonly string[];
  hasSchedule?: readonly string[];
}) {
  const instances = new Map(opts.instances.map((row) => [row.connector_instance_id, row]));
  const grouped = new Set(opts.groupedIds ?? []);
  const credentialed = new Set(opts.hasCredential ?? []);
  const scheduled = new Set(opts.hasSchedule ?? []);
  const inserted: Array<{ connectorInstanceId: string; canonicalConnectorInstanceId: string }> = [];

  return {
    inserted,
    query: (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("FROM connector_instances WHERE connector_instance_id")) {
        const row = instances.get(params[0] as string);
        return Promise.resolve({ rowCount: row ? 1 : 0, rows: row ? [row] : [] });
      }
      if (sql.includes("FROM connector_instance_groups WHERE connector_instance_id") && sql.includes("SELECT 1")) {
        const id = params[0] as string;
        return Promise.resolve({ rowCount: grouped.has(id) ? 1 : 0, rows: grouped.has(id) ? [{}] : [] });
      }
      if (sql.includes("FROM connector_instance_credentials")) {
        const id = params[0] as string;
        return Promise.resolve({ rowCount: credentialed.has(id) ? 1 : 0, rows: [] });
      }
      if (sql.includes("FROM connector_schedules")) {
        const id = params[0] as string;
        return Promise.resolve({ rowCount: scheduled.has(id) ? 1 : 0, rows: [] });
      }
      if (sql.includes("SELECT canonical_connector_instance_id, reason FROM connector_instance_groups")) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (sql.trim().startsWith("INSERT INTO connector_instance_groups")) {
        inserted.push({
          canonicalConnectorInstanceId: params[1] as string,
          connectorInstanceId: params[0] as string,
        });
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
      return Promise.reject(new Error(`Fake pool: unrecognized query: ${sql}`));
    },
  };
}

function mapping(overrides: Partial<MappingEntry> & Pick<MappingEntry, "connectorInstanceId">): MappingEntry {
  return {
    canonicalConnectorInstanceId: null,
    evidence: {},
    reason: "test",
    ...overrides,
  };
}

test("refuses to group a fragment whose own status is 'active' (P2 grant-scoped-records fix)", async () => {
  const pool = makeFakePool({
    instances: [
      {
        connector_id: "smoketest",
        connector_instance_id: "cin_canonical",
        owner_subject_id: "owner1",
        status: "active",
      },
      {
        connector_id: "smoketest",
        connector_instance_id: "cin_active_fragment",
        owner_subject_id: "owner1",
        status: "active",
      },
    ],
  });

  const result = await applyMapping(
    pool as never,
    mapping({ canonicalConnectorInstanceId: "cin_canonical", connectorInstanceId: "cin_active_fragment" }),
    { actor: "test", apply: true, now: "2026-08-15T00:00:00.000Z" }
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.detail, ACTIVE_STATUS_REFUSAL_DETAIL);
  assert.equal(pool.inserted.length, 0, "an active fragment must never be written to connector_instance_groups");
});

test("still groups a paused, uncredentialed fragment (the proven Amazon shape) unaffected by the new check", async () => {
  const pool = makeFakePool({
    instances: [
      {
        connector_id: "amazon",
        connector_instance_id: "cin_canonical",
        owner_subject_id: "owner1",
        status: "paused",
      },
      {
        connector_id: "amazon",
        connector_instance_id: "cin_paused_fragment",
        owner_subject_id: "owner1",
        status: "paused",
      },
    ],
  });

  const result = await applyMapping(
    pool as never,
    mapping({
      canonicalConnectorInstanceId: "cin_canonical",
      connectorInstanceId: "cin_paused_fragment",
      reason: "proven_subset",
    }),
    { actor: "test", apply: true, now: "2026-08-15T00:00:00.000Z" }
  );

  assert.equal(result.outcome, "grouped");
  assert.equal(pool.inserted.length, 1);
  assert.equal(pool.inserted[0]?.connectorInstanceId, "cin_paused_fragment");
  assert.equal(pool.inserted[0]?.canonicalConnectorInstanceId, "cin_canonical");
});

test("an active fragment is refused even if it also has no credential/schedule (status check runs before the live-sync-state check)", async () => {
  const pool = makeFakePool({
    hasCredential: [],
    hasSchedule: [],
    instances: [
      {
        connector_id: "chatgpt",
        connector_instance_id: "cin_canonical",
        owner_subject_id: "owner1",
        status: "active",
      },
      {
        connector_id: "chatgpt",
        connector_instance_id: "cin_active_no_creds",
        owner_subject_id: "owner1",
        status: "active",
      },
    ],
  });

  const result = await applyMapping(
    pool as never,
    mapping({ canonicalConnectorInstanceId: "cin_canonical", connectorInstanceId: "cin_active_no_creds" }),
    { actor: "test", apply: true, now: "2026-08-15T00:00:00.000Z" }
  );

  assert.equal(result.outcome, "refused");
  assert.match(result.detail, ACTIVE_STATUS_REFUSAL_DETAIL);
});

test("dry run reports the same active-status refusal without writing", async () => {
  const pool = makeFakePool({
    instances: [
      {
        connector_id: "github",
        connector_instance_id: "cin_canonical",
        owner_subject_id: "owner1",
        status: "active",
      },
      {
        connector_id: "github",
        connector_instance_id: "cin_active_fragment",
        owner_subject_id: "owner1",
        status: "active",
      },
    ],
  });

  const result = await applyMapping(
    pool as never,
    mapping({ canonicalConnectorInstanceId: "cin_canonical", connectorInstanceId: "cin_active_fragment" }),
    { actor: "test", apply: false, now: "2026-08-15T00:00:00.000Z" }
  );

  assert.equal(result.outcome, "refused");
  assert.equal(pool.inserted.length, 0);
});
