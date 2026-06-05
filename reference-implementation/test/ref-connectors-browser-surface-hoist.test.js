/**
 * Regression test for the records-dashboard hot-path optimization that hoists
 * the two GLOBAL browser-surface table reads (`listNonTerminalLeases` +
 * `listSurfaces`) out of the per-connector `listConnectorSummaries` loop.
 *
 * Before the hoist, `getConnectorBrowserSurfaceProjection` read both unscoped
 * tables once per connector and filtered the rows by `connector_id` in memory,
 * so a dashboard with N connectors issued 2N full-table reads on every load
 * (and on every records-page poll). The rows do not depend on which connector
 * is asking, so `loadSharedBrowserSurfaceReader` reads them ONCE and replays the
 * snapshot for every connector: 2N -> 2.
 *
 * What this pins
 * --------------
 * 1. The shared reader reads the underlying store exactly once regardless of how
 *    many connectors replay it (the whole point of the hoist).
 * 2. Each replay returns the identical snapshot rows the underlying store
 *    returned, so the per-connector projection is unchanged.
 * 3. Failure parity: if the single snapshot read throws, the reader re-throws on
 *    every replay, so each connector still routes through the existing
 *    `getConnectorBrowserSurfaceProjection` catch to `unreliable: true`. The
 *    store-outage behavior is byte-identical to the prior per-connector reads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getConnectorBrowserSurfaceProjection,
  loadSharedBrowserSurfaceReader,
} from '../server/ref-control.ts';

const LEASE_ROW = {
  lease_id: 'lease_chatgpt_1',
  connector_id: 'chatgpt',
  profile_key: null,
  surface_id: 'surface_chatgpt_1',
  status: 'leased',
  priority_class: 'background',
  requested_at: '2026-05-19T12:00:00.000Z',
};

const SURFACE_ROW = {
  surface_id: 'surface_chatgpt_1',
  connector_id: 'chatgpt',
  profile_key: null,
  health: 'ready',
  updated_at: '2026-05-19T12:00:00.000Z',
};

function countingStore({ leases = [], surfaces = [] } = {}) {
  const calls = { listNonTerminalLeases: 0, listSurfaces: 0 };
  const store = {
    async listNonTerminalLeases() {
      calls.listNonTerminalLeases += 1;
      return leases;
    },
    async listSurfaces() {
      calls.listSurfaces += 1;
      return surfaces;
    },
  };
  return { store, calls };
}

test('shared browser-surface reader reads the store once and replays it for every connector', async () => {
  const { store, calls } = countingStore({ leases: [LEASE_ROW], surfaces: [SURFACE_ROW] });

  const reader = await loadSharedBrowserSurfaceReader(store);
  // The snapshot read happens eagerly inside loadSharedBrowserSurfaceReader.
  assert.equal(calls.listNonTerminalLeases, 1, 'underlying lease read happens exactly once');
  assert.equal(calls.listSurfaces, 1, 'underlying surface read happens exactly once');

  // Replay the reader the way 13 connectors would in the summaries loop.
  for (let i = 0; i < 13; i++) {
    const leases = await reader.listNonTerminalLeases();
    const surfaces = await reader.listSurfaces();
    assert.deepEqual(leases, [LEASE_ROW], 'replayed leases match the snapshot');
    assert.deepEqual(surfaces, [SURFACE_ROW], 'replayed surfaces match the snapshot');
  }

  // The whole point: 13 replays still cost ONE underlying read each, not 13.
  assert.equal(calls.listNonTerminalLeases, 1, 'no extra lease reads under replay (2N -> 2)');
  assert.equal(calls.listSurfaces, 1, 'no extra surface reads under replay (2N -> 2)');
});

test('shared reader composes with getConnectorBrowserSurfaceProjection without changing its output', async () => {
  const { store } = countingStore({ leases: [LEASE_ROW], surfaces: [SURFACE_ROW] });
  const reader = await loadSharedBrowserSurfaceReader(store);

  // Same call shape listConnectorSummaries uses: pass the shared reader in as
  // the `store` option. An active `leased` lease against a ready surface is
  // reliable evidence, not an outage.
  const projection = await getConnectorBrowserSurfaceProjection('chatgpt', { store: reader });
  assert.equal(projection.unreliable, false, 'leased+ready surface is reliable evidence');
  assert.notEqual(projection.evidence, null, 'a managed surface produces remote-surface evidence');

  // A connector with no rows in the snapshot is routine absence, not unreliable.
  const absent = await getConnectorBrowserSurfaceProjection('some-other-connector', { store: reader });
  assert.equal(absent.unreliable, false, 'no rows for a connector is routine absence');
  assert.equal(absent.evidence, null, 'absent connector has no remote-surface evidence');
});

test('a failing snapshot read re-throws on every replay so each connector stays unreliable', async () => {
  let underlyingReads = 0;
  const failingStore = {
    async listNonTerminalLeases() {
      underlyingReads += 1;
      throw new Error('simulated lease store outage');
    },
    async listSurfaces() {
      underlyingReads += 1;
      throw new Error('simulated surface store outage');
    },
  };

  // loadSharedBrowserSurfaceReader must NOT propagate the outage itself; it
  // captures the error and replays it, mirroring the prior per-connector read
  // where each projection independently caught the throw.
  const reader = await loadSharedBrowserSurfaceReader(failingStore);

  // Every connector that replays the failed snapshot routes through the existing
  // projection catch to `unreliable: true` — same as before the hoist.
  for (let i = 0; i < 3; i++) {
    const projection = await getConnectorBrowserSurfaceProjection('chatgpt', { store: reader });
    assert.equal(projection.unreliable, true, 'a snapshot outage keeps every projection unreliable');
  }

  // The outage is read at most twice total (the single Promise.all snapshot),
  // never re-hit per connector.
  assert.ok(underlyingReads <= 2, `outage read at most once per table, got ${underlyingReads}`);
});
