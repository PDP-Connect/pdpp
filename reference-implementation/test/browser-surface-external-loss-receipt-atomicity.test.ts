// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// External-loss receipt / surface-downgrade ATOMICITY oracle (SQLite backend).
//
// `persistAllocatorSurfaceReconciliation` (runtime/browser-surface/
// run-coordinator.ts) records external-loss replacement receipts INSIDE
// `withLeaseTransaction` alongside the evicted surfaces' health downgrades.
// On the SQLite backend that transaction is `BEGIN IMMEDIATE` on the shared
// `getDb()` connection and the receipt store's `append` issues plain
// statements on that same connection, so the receipt and the downgrade
// commit — or roll back — as one unit. A 2026-08-11 refactor draft moved the
// receipt write OUTSIDE the transaction and NO test discriminated it: a
// receipt could then commit while its surface-health downgrade rolled back,
// durably announcing a replacement for a surface still recorded healthy.
//
// This suite is that missing discriminator. It drives the REAL seam
// (`sweepBrowserSurfaceLeases` → allocator reconciliation) with the real
// SQLite lease + receipt stores, injects a mid-transaction upsert failure,
// and asserts the receipt write was attempted AND left no durable row —
// which can only hold while the receipt write shares the lease transaction.

import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrowserSurface,
  type BrowserSurfaceAllocator,
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_PRIORITY_RANKS,
  // biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
} from "@opendatalabs/remote-surface/leases";
import { createBrowserSurfaceManager } from "../runtime/browser-surface/run-coordinator.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  type BrowserSurfaceLeaseStore,
  createSqliteBrowserSurfaceLeaseStore,
} from "../server/stores/browser-surface-lease-store.ts";
import {
  type BrowserSurfaceReplacementReceiptStore,
  getDefaultBrowserSurfaceReplacementReceiptStore,
} from "../server/stores/browser-surface-replacement-ledger-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const NOW_ISO = "2026-05-12T12:00:00.000Z";

function readySurface(surfaceId: string, profileKey: string): BrowserSurface {
  return {
    backend: "neko",
    cdp_url: `http://${surfaceId}:9223`,
    connector_id: "managed",
    created_at: NOW_ISO,
    health: "ready",
    last_used_at: NOW_ISO,
    profile_key: profileKey,
    stream_base_url: `http://${surfaceId}:8080`,
    surface_id: surfaceId,
  };
}

// Two distinct profile scopes so BOTH evicted surfaces elect an external-loss
// receipt (same-scope duplicates collapse to one lexical representative).
const SURFACE_A = readySurface("surface_a", "profile-a");
const SURFACE_B = readySurface("surface_b", "profile-b");

function createManagerWithSurfaces(surfaces: readonly BrowserSurface[]): BrowserSurfaceLeaseManager {
  let leaseSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set(["managed"]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap: surfaces.length,
      surfaceMode: "dynamic",
    },
    initialSurfaces: [...surfaces],
    makeLeaseId: () => {
      leaseSeq += 1;
      return `lease_${leaseSeq}`;
    },
    makeSurfaceId: () => {
      throw new Error("test never allocates new surfaces");
    },
    nextFencingToken: () => {
      tokenSeq += 1;
      return tokenSeq;
    },
    now: () => new Date(NOW_ISO),
  });
}

// The allocator's live view is EMPTY: every ready surface the manager still
// remembers has lost its backing container — the external-loss boundary.
function createEmptyAllocator(): BrowserSurfaceAllocator {
  return {
    ensureSurface: () => {
      throw new Error("test never provisions surfaces");
    },
    getSurfaceStatus: async () => null,
    listSurfaces: async () => [],
    stopSurface: async () => null,
  };
}

// Delegating wrapper (Proxy, not spread — the SQLite store's methods live on
// its prototype) that makes `upsertSurface` throw for one surface id while
// `withLeaseTransaction` still runs the REAL BEGIN IMMEDIATE transaction and
// hands the callback this same wrapper.
function withFailingUpsert(real: BrowserSurfaceLeaseStore, failSurfaceId: string): BrowserSurfaceLeaseStore {
  const wrapped: BrowserSurfaceLeaseStore = new Proxy(real, {
    get(target, prop) {
      if (prop === "upsertSurface") {
        return (surface: Parameters<BrowserSurfaceLeaseStore["upsertSurface"]>[0]) => {
          if (surface.surface_id === failSurfaceId) {
            throw new Error("injected: surface persistence failed mid-transaction");
          }
          return target.upsertSurface(surface);
        };
      }
      if (prop === "withLeaseTransaction") {
        return <T>(fn: (store: BrowserSurfaceLeaseStore) => Promise<T> | T) =>
          target.withLeaseTransaction(() => fn(wrapped));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return wrapped;
}

// Counting wrapper proving the receipt write was genuinely ATTEMPTED — a
// vacuous pass (reconciliation never reaching the receipt store) must fail.
function withAppendCounter(real: BrowserSurfaceReplacementReceiptStore): {
  store: BrowserSurfaceReplacementReceiptStore;
  appendCalls: () => number;
} {
  let calls = 0;
  const store: BrowserSurfaceReplacementReceiptStore = new Proxy(real, {
    get(target, prop) {
      if (prop === "append") {
        return (receipt: Parameters<BrowserSurfaceReplacementReceiptStore["append"]>[0]) => {
          calls += 1;
          return target.append(receipt);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { appendCalls: () => calls, store };
}

async function setupStores(): Promise<{
  leaseStore: BrowserSurfaceLeaseStore;
  receiptStore: BrowserSurfaceReplacementReceiptStore;
}> {
  initDb(makeTemporaryDbPath("browser-surface-receipt-atomicity"));
  const leaseStore = createSqliteBrowserSurfaceLeaseStore();
  const receiptStore = getDefaultBrowserSurfaceReplacementReceiptStore();
  await leaseStore.upsertSurface(SURFACE_A);
  await leaseStore.upsertSurface(SURFACE_B);
  return { leaseStore, receiptStore };
}

function createSweepManager(input: {
  leaseStore: BrowserSurfaceLeaseStore;
  receiptStore: BrowserSurfaceReplacementReceiptStore;
  warnings: string[];
}): ReturnType<typeof createBrowserSurfaceManager> {
  return createBrowserSurfaceManager({
    activeRunInteractions: new Map(),
    browserSurfaceAllocator: createEmptyAllocator(),
    browserSurfaceLeaseManager: createManagerWithSurfaces([SURFACE_A, SURFACE_B]),
    browserSurfaceLeaseStore: input.leaseStore,
    browserSurfaceMidWaitPollIntervalMs: undefined,
    browserSurfaceReadinessProbe: null,
    browserSurfaceReadinessTimeoutMs: undefined,
    browserSurfaceReplacementReceiptStore: input.receiptStore,
    listPersistedActiveRuns: async () => [],
    log: { warn: (message: string) => input.warnings.push(message) },
    pendingBrowserSurfaceLaunches: new Map(),
    scheduleRun: () => undefined,
    startupControllerRunReconciliation: Promise.resolve(),
  });
}

test("a mid-transaction downgrade failure rolls the external-loss receipts back with it (SQLite atomicity)", async (t) => {
  const { leaseStore, receiptStore } = await setupStores();
  t.after(() => closeDb());
  const counted = withAppendCounter(receiptStore);
  const warnings: string[] = [];
  const manager = createSweepManager({
    leaseStore: withFailingUpsert(leaseStore, SURFACE_B.surface_id),
    receiptStore: counted.store,
    warnings,
  });

  await manager.sweepBrowserSurfaceLeases();

  // The reconciliation genuinely reached the receipt store and failed on the
  // second surface's downgrade — this is not a vacuous no-op pass.
  assert.ok(counted.appendCalls() >= 1, "external-loss receipt append must have been attempted inside the sweep");
  assert.ok(
    warnings.some((message) => message.includes("surface reconciliation failed")),
    "the injected mid-transaction failure must surface through the reconciliation warning path"
  );

  // ATOMICITY: the rollback that discarded the downgrade must also discard
  // every receipt appended in the same reconciliation. A receipt surviving
  // here means receipt persistence escaped `withLeaseTransaction`.
  assert.deepEqual(
    await receiptStore.list(),
    [],
    "no external-loss receipt may be durable after the lease transaction rolled back"
  );
  assert.equal(
    (await leaseStore.getSurface(SURFACE_A.surface_id))?.health,
    "ready",
    "the first surface's downgrade must roll back with the failed transaction"
  );
});

test("without a failure, external-loss receipts and surface downgrades commit together", async (t) => {
  const { leaseStore, receiptStore } = await setupStores();
  t.after(() => closeDb());
  const warnings: string[] = [];
  const manager = createSweepManager({ leaseStore, receiptStore, warnings });

  await manager.sweepBrowserSurfaceLeases();

  assert.deepEqual(warnings, [], "the happy-path sweep must not warn");
  const receipts = await receiptStore.list();
  assert.equal(receipts.length, 2, "one external-loss receipt per lost profile scope");
  assert.equal((await leaseStore.getSurface(SURFACE_A.surface_id))?.health, "unhealthy");
  assert.equal((await leaseStore.getSurface(SURFACE_B.surface_id))?.health, "unhealthy");
});
