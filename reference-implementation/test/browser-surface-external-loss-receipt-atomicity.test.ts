// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// External-loss receipt / surface-downgrade ATOMICITY oracle (SQLite + PostgreSQL).
//
// `persistAllocatorSurfaceReconciliation` (runtime/browser-surface/
// run-coordinator.ts) records external-loss replacement receipts inside the
// explicit persistence unit of work alongside the evicted surfaces' health
// downgrades. SQLite binds both stores to its `BEGIN IMMEDIATE` connection;
// PostgreSQL binds both stores to its `withPostgresTransaction` client, so the
// receipt and the downgrade commit — or roll back — as one unit. Before this
// seam, PostgreSQL receipts used the pool-backed store outside that transaction:
// a receipt could commit while its surface-health downgrade rolled back,
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
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  type BrowserSurfaceLeaseStore,
  createPostgresBrowserSurfaceLeaseStore,
  createSqliteBrowserSurfaceLeaseStore,
} from "../server/stores/browser-surface-lease-store.ts";
import type {
  BrowserSurfacePersistenceLeaseCapability,
  BrowserSurfacePersistenceUnitOfWorkStores,
} from "../server/stores/browser-surface-persistence-unit-of-work.ts";
import {
  type BrowserSurfaceReplacementReceiptStore,
  createPostgresBrowserSurfaceReplacementReceiptStore,
  getDefaultBrowserSurfaceReplacementReceiptStore,
} from "../server/stores/browser-surface-replacement-ledger-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const NOW_ISO = "2026-05-12T12:00:00.000Z";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

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
// `withPersistenceUnitOfWork` still runs the REAL backend transaction and
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
      if (prop === "withPersistenceUnitOfWork") {
        return <T>(
          receiptStore: BrowserSurfaceReplacementReceiptStore,
          fn: (stores: BrowserSurfacePersistenceUnitOfWorkStores) => Promise<T> | T
        ) =>
          target.withPersistenceUnitOfWork(receiptStore, (stores) =>
            fn({
              leaseStore: withFailingUpsertCapability(stores.leaseStore, failSurfaceId),
              replacementReceiptStore: stores.replacementReceiptStore,
            })
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return wrapped;
}

function withFailingUpsertCapability(
  real: BrowserSurfacePersistenceLeaseCapability,
  failSurfaceId: string
): BrowserSurfacePersistenceLeaseCapability {
  return {
    getSurface: (surfaceId) => real.getSurface(surfaceId),
    updateBrowserGenerationHash: (surfaceId, browserGenerationHash) =>
      real.updateBrowserGenerationHash(surfaceId, browserGenerationHash),
    upsertSurface: (surface) => {
      if (surface.surface_id === failSurfaceId) {
        throw new Error("injected: surface persistence failed mid-transaction");
      }
      return real.upsertSurface(surface);
    },
  };
}

function countAppends(
  real: BrowserSurfaceReplacementReceiptStore,
  onAppend: () => void
): BrowserSurfaceReplacementReceiptStore {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "append") {
        return (receipt: Parameters<BrowserSurfaceReplacementReceiptStore["append"]>[0]) => {
          onAppend();
          return target.append(receipt);
        };
      }
      if (prop === "bindToTransaction") {
        return (transaction: Parameters<BrowserSurfaceReplacementReceiptStore["bindToTransaction"]>[0]) =>
          countAppends(target.bindToTransaction(transaction), onAppend);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

async function externalLossReceipts(store: BrowserSurfaceReplacementReceiptStore) {
  return (await store.list()).filter(
    (receipt) =>
      receipt.cause === "external_or_host_loss" &&
      (receipt.surface_id === SURFACE_A.surface_id || receipt.surface_id === SURFACE_B.surface_id)
  );
}

function createSweepManager(input: {
  leaseStore: BrowserSurfaceLeaseStore;
  receiptStore: BrowserSurfaceReplacementReceiptStore;
  warnings: string[];
}): ReturnType<typeof createBrowserSurfaceManager> {
  const deps = {
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
  };
  return createBrowserSurfaceManager(deps);
}

test("a mid-transaction downgrade failure rolls the external-loss receipts back with it (SQLite atomicity)", async (t) => {
  const { leaseStore, receiptStore } = await setupStores();
  t.after(() => closeDb());
  let appendCalls = 0;
  const countedReceiptStore = countAppends(receiptStore, () => {
    appendCalls += 1;
  });
  const warnings: string[] = [];
  const manager = createSweepManager({
    leaseStore: withFailingUpsert(leaseStore, SURFACE_B.surface_id),
    receiptStore: countedReceiptStore,
    warnings,
  });

  await manager.sweepBrowserSurfaceLeases();

  // The reconciliation genuinely reached the receipt store and failed on the
  // second surface's downgrade — this is not a vacuous no-op pass.
  assert.ok(appendCalls >= 1, "external-loss receipt append must have been attempted inside the sweep");
  assert.ok(
    warnings.some((message) => message.includes("surface reconciliation failed")),
    "the injected mid-transaction failure must surface through the reconciliation warning path"
  );

  // ATOMICITY: the rollback that discarded the downgrade must also discard
  // every receipt appended in the same reconciliation. A receipt surviving
  // here means receipt persistence escaped `withLeaseTransaction`.
  assert.deepEqual(
    await externalLossReceipts(receiptStore),
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
  const receipts = await externalLossReceipts(receiptStore);
  assert.equal(receipts.length, 2, "one external-loss receipt per lost profile scope");
  assert.equal((await leaseStore.getSurface(SURFACE_A.surface_id))?.health, "unhealthy");
  assert.equal((await leaseStore.getSurface(SURFACE_B.surface_id))?.health, "unhealthy");
});

async function setupPostgresStores(): Promise<{
  leaseStore: BrowserSurfaceLeaseStore;
  receiptStore: BrowserSurfaceReplacementReceiptStore;
}> {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  const leaseStore = createPostgresBrowserSurfaceLeaseStore();
  const receiptStore = createPostgresBrowserSurfaceReplacementReceiptStore();
  await postgresQuery("DELETE FROM browser_surface_replacement_receipts WHERE surface_id IN ($1, $2)", [
    SURFACE_A.surface_id,
    SURFACE_B.surface_id,
  ]);
  await postgresQuery("DELETE FROM browser_surface_leases WHERE surface_id IN ($1, $2)", [
    SURFACE_A.surface_id,
    SURFACE_B.surface_id,
  ]);
  await postgresQuery("DELETE FROM browser_surfaces WHERE surface_id IN ($1, $2)", [
    SURFACE_A.surface_id,
    SURFACE_B.surface_id,
  ]);
  await leaseStore.upsertSurface(SURFACE_A);
  await leaseStore.upsertSurface(SURFACE_B);
  return { leaseStore, receiptStore };
}

async function cleanupPostgresStores(): Promise<void> {
  await postgresQuery("DELETE FROM browser_surface_replacement_receipts WHERE surface_id IN ($1, $2)", [
    SURFACE_A.surface_id,
    SURFACE_B.surface_id,
  ]);
  await postgresQuery("DELETE FROM browser_surface_leases WHERE surface_id IN ($1, $2)", [
    SURFACE_A.surface_id,
    SURFACE_B.surface_id,
  ]);
  await postgresQuery("DELETE FROM browser_surfaces WHERE surface_id IN ($1, $2)", [
    SURFACE_A.surface_id,
    SURFACE_B.surface_id,
  ]);
  await closePostgresStorage();
}

test("a mid-transaction downgrade failure rolls the external-loss receipts back with it (Postgres atomicity)", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  const { leaseStore, receiptStore } = await setupPostgresStores();
  t.after(async () => cleanupPostgresStores());
  let appendCalls = 0;
  const countedReceiptStore = countAppends(receiptStore, () => {
    appendCalls += 1;
  });
  const warnings: string[] = [];
  const manager = createSweepManager({
    leaseStore: withFailingUpsert(leaseStore, SURFACE_B.surface_id),
    receiptStore: countedReceiptStore,
    warnings,
  });

  await manager.sweepBrowserSurfaceLeases();

  assert.ok(appendCalls >= 1, "external-loss receipt append must have been attempted inside the sweep");
  assert.ok(
    warnings.some((message) => message.includes("surface reconciliation failed")),
    "the injected mid-transaction failure must surface through the reconciliation warning path"
  );
  assert.deepEqual(
    await externalLossReceipts(receiptStore),
    [],
    "no external-loss receipt may be durable after the lease transaction rolled back"
  );
  assert.equal((await leaseStore.getSurface(SURFACE_A.surface_id))?.health, "ready");
});

test("without a failure, external-loss receipts and surface downgrades commit together (Postgres)", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  const { leaseStore, receiptStore } = await setupPostgresStores();
  t.after(async () => cleanupPostgresStores());
  const warnings: string[] = [];
  const manager = createSweepManager({ leaseStore, receiptStore, warnings });

  await manager.sweepBrowserSurfaceLeases();

  assert.deepEqual(warnings, [], "the happy-path sweep must not warn");
  const receipts = await externalLossReceipts(receiptStore);
  assert.equal(receipts.length, 2, "one external-loss receipt per lost profile scope");
  assert.equal((await leaseStore.getSurface(SURFACE_A.surface_id))?.health, "unhealthy");
  assert.equal((await leaseStore.getSurface(SURFACE_B.surface_id))?.health, "unhealthy");
});
