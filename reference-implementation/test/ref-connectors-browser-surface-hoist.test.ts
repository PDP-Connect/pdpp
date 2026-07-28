// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the records-dashboard hot-path optimization that hoists
 * the three GLOBAL browser-surface table reads (`listNonTerminalLeases` +
 * `listLeases` + `listSurfaces`) out of the per-connector
 * `listConnectorSummaries` loop.
 *
 * Before the hoist, `getConnectorBrowserSurfaceProjection` read all three unscoped
 * tables once per connector and filtered the rows by `connector_id` in memory,
 * so a dashboard with N connectors issued 3N full-table reads on every load
 * (and on every records-page poll). The rows do not depend on which connector
 * is asking, so `loadSharedBrowserSurfaceReader` reads them ONCE and replays the
 * snapshot for every connector: 3N -> 3.
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

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
import type { BrowserSurface, BrowserSurfaceLease } from "@opendatalabs/remote-surface/leases";

import { getConnectorBrowserSurfaceProjection, loadSharedBrowserSurfaceReader } from "../server/ref-control.ts";

const LEASE_ROW: BrowserSurfaceLease = {
  connector_id: "chatgpt",
  expires_at: "2026-05-19T12:30:00.000Z",
  fencing_token: 1,
  lease_id: "lease_chatgpt_1",
  priority_class: "background",
  profile_key: "chatgpt:default",
  requested_at: "2026-05-19T12:00:00.000Z",
  run_id: "run_chatgpt_1",
  status: "leased",
  surface_id: "surface_chatgpt_1",
};

const SURFACE_ROW: BrowserSurface = {
  backend: "neko",
  cdp_url: "ws://127.0.0.1:9222/chatgpt_1",
  connector_id: "chatgpt",
  created_at: "2026-05-19T11:55:00.000Z",
  health: "ready",
  last_used_at: "2026-05-19T12:00:00.000Z",
  profile_key: "chatgpt:default",
  stream_base_url: "http://127.0.0.1:8080/chatgpt_1",
  surface_id: "surface_chatgpt_1",
};

interface CountingBrowserSurfaceStore {
  listLeases: () => Promise<readonly BrowserSurfaceLease[]>;
  listNonTerminalLeases: () => Promise<readonly BrowserSurfaceLease[]>;
  listSurfaces: () => Promise<readonly BrowserSurface[]>;
}

function countingStore({
  leases = [] as readonly BrowserSurfaceLease[],
  surfaces = [] as readonly BrowserSurface[],
} = {}): {
  store: CountingBrowserSurfaceStore;
  calls: Record<"listLeases" | "listNonTerminalLeases" | "listSurfaces", number>;
} {
  const calls = { listLeases: 0, listNonTerminalLeases: 0, listSurfaces: 0 };
  const store: CountingBrowserSurfaceStore = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listLeases() {
      calls.listLeases += 1;
      return leases;
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listNonTerminalLeases() {
      calls.listNonTerminalLeases += 1;
      return leases;
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listSurfaces() {
      calls.listSurfaces += 1;
      return surfaces;
    },
  };
  return { calls, store };
}

test("shared browser-surface reader reads the store once and replays it for every connector", async () => {
  const { store, calls } = countingStore({ leases: [LEASE_ROW], surfaces: [SURFACE_ROW] });

  const reader = await loadSharedBrowserSurfaceReader(store);
  // The snapshot read happens eagerly inside loadSharedBrowserSurfaceReader.
  assert.equal(calls.listNonTerminalLeases, 1, "underlying lease read happens exactly once");
  assert.equal(calls.listLeases, 1, "underlying lease-history read happens exactly once");
  assert.equal(calls.listSurfaces, 1, "underlying surface read happens exactly once");

  // Replay the reader the way 13 connectors would in the summaries loop.
  // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
  for (let i = 0; i < 13; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    const leases = await reader.listNonTerminalLeases();
    const surfaces = await reader.listSurfaces();
    assert.deepEqual(leases, [LEASE_ROW], "replayed leases match the snapshot");
    assert.deepEqual(surfaces, [SURFACE_ROW], "replayed surfaces match the snapshot");
  }

  // The whole point: 13 replays still cost ONE underlying read each, not 13.
  assert.equal(calls.listNonTerminalLeases, 1, "no extra lease reads under replay (3N -> 3)");
  assert.equal(calls.listLeases, 1, "no extra lease-history reads under replay (3N -> 3)");
  assert.equal(calls.listSurfaces, 1, "no extra surface reads under replay (3N -> 3)");
});

test("shared reader composes with getConnectorBrowserSurfaceProjection without changing its output", async () => {
  const { store } = countingStore({ leases: [LEASE_ROW], surfaces: [SURFACE_ROW] });
  const reader = await loadSharedBrowserSurfaceReader(store);

  // Same call shape listConnectorSummaries uses: pass the shared reader in as
  // the `store` option. An active `leased` lease against a ready surface is
  // reliable evidence, not an outage.
  const projection = await getConnectorBrowserSurfaceProjection("chatgpt", { store: reader });
  assert.equal(projection.unreliable, false, "leased+ready surface is reliable evidence");
  assert.notEqual(projection.evidence, null, "a managed surface produces remote-surface evidence");

  // A connector with no rows in the snapshot is routine absence, not unreliable.
  const absent = await getConnectorBrowserSurfaceProjection("some-other-connector", { store: reader });
  assert.equal(absent.unreliable, false, "no rows for a connector is routine absence");
  assert.equal(absent.evidence, null, "absent connector has no remote-surface evidence");
});

test("a failing snapshot read re-throws on every replay so each connector stays unreliable", async () => {
  let underlyingReads = 0;
  const failingStore = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listLeases() {
      underlyingReads += 1;
      throw new Error("simulated lease-history store outage");
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listNonTerminalLeases() {
      underlyingReads += 1;
      throw new Error("simulated lease store outage");
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listSurfaces() {
      underlyingReads += 1;
      throw new Error("simulated surface store outage");
    },
  };

  // loadSharedBrowserSurfaceReader must NOT propagate the outage itself; it
  // captures the error and replays it, mirroring the prior per-connector read
  // where each projection independently caught the throw.
  const reader = await loadSharedBrowserSurfaceReader(failingStore);

  // Every connector that replays the failed snapshot routes through the existing
  // projection catch to `unreliable: true` — same as before the hoist.
  // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
  for (let i = 0; i < 3; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    const projection = await getConnectorBrowserSurfaceProjection("chatgpt", { store: reader });
    assert.equal(projection.unreliable, true, "a snapshot outage keeps every projection unreliable");
  }

  // The outage is read at most three times total (the single Promise.all snapshot),
  // never re-hit per connector.
  assert.ok(underlyingReads <= 3, `outage read at most once per table, got ${underlyingReads}`);
});
