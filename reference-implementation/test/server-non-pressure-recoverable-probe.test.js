// SLVP-ideal §4.3 — L2 server probe: getNonPressureRecoverableCount handler
//
// Validates the index.js handler that feeds `getNonPressureRecoverableCount`
// into createScheduler. The handler reads pending gaps for a connector via
// `store.listPendingGapsForConnector`, then:
//   - includes gaps whose reason is NOT in SOURCE_PRESSURE_GAP_REASONS
//   - excludes source-pressure gaps (rate_limited / upstream_pressure)
//   - scopes to the connector_instance_id (not cross-instance)
//   - returns the scalar count, or 0 on probe error (fail-closed)
//
// This test exercises the store primitives directly in the same composition
// the handler uses, so the filter logic is pinned without re-testing the
// scheduler tick machinery. Pattern mirrors connector-detail-gap-store.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, initDb } from '../server/db.js';
import { createSqliteConnectorDetailGapStore } from '../server/stores/connector-detail-gap-store.js';
import { SOURCE_PRESSURE_GAP_REASONS } from '../runtime/scheduler-source-pressure-cooldown.ts';

// ─── helper: the handler logic extracted for testing ────────────────────────
//
// This mirrors the inline closure in server/index.js
// `getNonPressureRecoverableCount` exactly: read pending gaps for the connector
// (store-wide), filter to this instance, count those whose reason is NOT a
// source-pressure reason. Fail-closed to 0 on any error.
async function countNonPressureRecoverable(store, connectorId, connectorInstanceId) {
  try {
    const rows = await store.listPendingGapsForConnector(connectorId, { limit: 200 });
    const instanceKey = connectorInstanceId || connectorId;
    let count = 0;
    for (const row of rows ?? []) {
      // Exclude source-pressure reasons — they belong to Governor A (cooldown),
      // not to the recovery lane (SLVP-ideal §4.3).
      if (typeof row?.reason === 'string' && SOURCE_PRESSURE_GAP_REASONS.has(row.reason)) continue;
      // Scope to this connection's instance, matching the pressure-probe scoping.
      if ((row.connector_instance_id || connectorId) !== instanceKey) continue;
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-np-probe-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// Seed a single pending gap with the given connectorId, instance ID, reason.
async function seedGap(store, { connectorId, connectorInstanceId, reason, stream = 'messages', recordKey }) {
  await store.upsertPendingGap({
    connectorId,
    connectorInstanceId,
    stream,
    recordKey: recordKey ?? `key_${Math.random().toString(36).slice(2)}`,
    detailLocator: { kind: 'test', id: recordKey ?? 'k' },
    reason,
    grantId: 'grant_test',
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test(
  'counts non-pressure pending gaps (run_cap_deferred, retry_exhausted)',
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = 'chatgpt';
    const instanceId = `cii_${connectorId}_default`;

    // Seed 3 non-pressure reasons (the recovery lane's targets).
    await seedGap(store, { connectorId, connectorInstanceId: instanceId, reason: 'run_cap_deferred', recordKey: 'k1' });
    await seedGap(store, { connectorId, connectorInstanceId: instanceId, reason: 'retry_exhausted', recordKey: 'k2' });
    await seedGap(store, { connectorId, connectorInstanceId: instanceId, reason: 'temporary_unavailable', recordKey: 'k3' });

    const count = await countNonPressureRecoverable(store, connectorId, instanceId);
    assert.equal(count, 3, 'all three non-pressure gaps are counted');
  }),
);

test(
  'excludes source-pressure gaps (rate_limited, upstream_pressure)',
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = 'chatgpt';
    const instanceId = `cii_${connectorId}_default`;

    // Seed 2 source-pressure gaps — these arm the cooldown, NOT the recovery lane.
    await seedGap(store, { connectorId, connectorInstanceId: instanceId, reason: 'rate_limited', recordKey: 'p1' });
    await seedGap(store, { connectorId, connectorInstanceId: instanceId, reason: 'upstream_pressure', recordKey: 'p2' });

    const count = await countNonPressureRecoverable(store, connectorId, instanceId);
    assert.equal(count, 0, 'source-pressure gaps do not count toward the recovery probe');
  }),
);

test(
  'counts non-pressure only, correctly excludes source-pressure from mixed set',
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = 'chatgpt';
    const instanceId = `cii_${connectorId}_default`;

    // Mix: 51 pressure (the live scenario's cooldown-arming set) + 942 non-pressure.
    for (let i = 0; i < 51; i++) {
      await seedGap(store, { connectorId, connectorInstanceId: instanceId, reason: 'upstream_pressure', recordKey: `pressure_${i}` });
    }
    for (let i = 0; i < 10; i++) {
      await seedGap(store, { connectorId, connectorInstanceId: instanceId, reason: 'retry_exhausted', recordKey: `nonpressure_${i}` });
    }

    const count = await countNonPressureRecoverable(store, connectorId, instanceId);
    assert.equal(count, 10, 'only non-pressure gaps are counted; pressure gaps excluded');
  }),
);

test(
  'scoped to connector_instance_id: excludes gaps from a different instance of the same connector type',
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = 'chatgpt';
    const instanceA = `cii_chatgpt_account_A`;
    const instanceB = `cii_chatgpt_account_B`;

    // Instance A has 3 non-pressure gaps; instance B has 5.
    for (let i = 0; i < 3; i++) {
      await seedGap(store, { connectorId, connectorInstanceId: instanceA, reason: 'retry_exhausted', recordKey: `a_${i}` });
    }
    for (let i = 0; i < 5; i++) {
      await seedGap(store, { connectorId, connectorInstanceId: instanceB, reason: 'run_cap_deferred', recordKey: `b_${i}` });
    }

    // Probing for instance A must only count A's gaps (SLVP §4.3: cooldown is per-source).
    const countA = await countNonPressureRecoverable(store, connectorId, instanceA);
    assert.equal(countA, 3, 'probe for instance A returns only A\'s gaps');

    const countB = await countNonPressureRecoverable(store, connectorId, instanceB);
    assert.equal(countB, 5, 'probe for instance B returns only B\'s gaps');
  }),
);

test(
  'returns 0 when there are no pending gaps at all',
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const count = await countNonPressureRecoverable(store, 'chatgpt', 'cii_chatgpt_default');
    assert.equal(count, 0, 'empty store returns 0');
  }),
);

test(
  'returns 0 (fail-closed) when the store probe throws',
  async () => {
    // A broken store (throws on listPendingGapsForConnector) must not propagate
    // the error — fail-closed to 0 so the scheduler is not accidentally unlocked.
    const brokenStore = {
      listPendingGapsForConnector: () => { throw new Error('db unavailable'); },
    };
    const count = await countNonPressureRecoverable(brokenStore, 'chatgpt', 'cii_chatgpt_default');
    assert.equal(count, 0, 'probe error returns 0 (fail-closed)');
  },
);

test(
  'null reason gap is treated as non-pressure (counts toward recovery)',
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = 'chatgpt';
    const instanceId = `cii_${connectorId}_default`;

    // A gap with no reason is not a pressure gap; the cooldown has no claim on it.
    await seedGap(store, { connectorId, connectorInstanceId: instanceId, reason: null, recordKey: 'noreason' });

    const count = await countNonPressureRecoverable(store, connectorId, instanceId);
    assert.equal(count, 1, 'null-reason gap is counted as non-pressure');
  }),
);
