// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this workspace package export.
import type { BrowserSurfaceLease } from "@opendatalabs/remote-surface/leases";
import { createReplacementLifecycleHooks } from "../runtime/browser-surface/replacement-lifecycle-hooks.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import type {
  BrowserSurfaceLeaseStore,
  BrowserSurfaceWithPersistenceMetadata,
} from "../server/stores/browser-surface-lease-store.ts";
import {
  createPostgresBrowserSurfaceLeaseStore,
  createSqliteBrowserSurfaceLeaseStore,
} from "../server/stores/browser-surface-lease-store.ts";
import {
  type BrowserSurfacePersistenceLeaseCapability,
  type BrowserSurfacePersistenceUnitOfWorkStores,
  createBrowserSurfacePersistenceUnitOfWork,
} from "../server/stores/browser-surface-persistence-unit-of-work.ts";
import type { BrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";
import {
  createPostgresBrowserSurfaceReplacementReceiptStore,
  createSqliteBrowserSurfaceReplacementReceiptStore,
} from "../server/stores/browser-surface-replacement-ledger-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const NOW = "2026-08-11T12:00:00.000Z";
const OLD_GENERATION_HASH = "a".repeat(64);
const NEW_GENERATION_HASH = "b".repeat(64);
const SURFACE_ID = "readiness-generation-atomicity-surface";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const INJECTED_FAILURE = /injected: browser generation hash persistence failed/;
const MISSING_UOW = /browser-surface readiness replacement requires a persistence unit of work/;

function surface(): BrowserSurfaceWithPersistenceMetadata {
  return {
    backend: "neko",
    browser_generation_hash: OLD_GENERATION_HASH,
    cdp_url: "http://neko:9222",
    connector_id: "connector-readiness-atomicity",
    container_id: "container-readiness-atomicity",
    created_at: NOW,
    health: "ready",
    last_used_at: NOW,
    profile_key: "profile-readiness-atomicity",
    stream_base_url: "http://neko:8080",
    surface_id: SURFACE_ID,
    surface_subject_id: "subject-readiness-atomicity",
  };
}

function lease(): BrowserSurfaceLease {
  return {
    connector_id: "connector-readiness-atomicity",
    expires_at: "2026-08-11T13:00:00.000Z",
    fencing_token: 1,
    lease_id: "lease-readiness-atomicity",
    priority_class: "interactive",
    profile_key: "profile-readiness-atomicity",
    requested_at: NOW,
    run_id: "run-readiness-atomicity",
    status: "leased",
    surface_id: SURFACE_ID,
    surface_subject_id: "subject-readiness-atomicity",
  };
}

function withFailingGenerationUpdateCapability(
  real: BrowserSurfacePersistenceLeaseCapability
): BrowserSurfacePersistenceLeaseCapability {
  return {
    getSurface: (surfaceId) => real.getSurface(surfaceId),
    updateBrowserGenerationHash: (surfaceId, browserGenerationHash) => {
      if (surfaceId === SURFACE_ID) {
        throw new Error("injected: browser generation hash persistence failed");
      }
      return real.updateBrowserGenerationHash(surfaceId, browserGenerationHash);
    },
    upsertSurface: (nextSurface) => real.upsertSurface(nextSurface),
  };
}

function withFailingGenerationUpdate(real: BrowserSurfaceLeaseStore): BrowserSurfaceLeaseStore {
  const wrapped: BrowserSurfaceLeaseStore = new Proxy(real, {
    get(target, prop) {
      if (prop === "withPersistenceUnitOfWork") {
        return <T>(
          receiptStore: BrowserSurfaceReplacementReceiptStore,
          fn: (stores: BrowserSurfacePersistenceUnitOfWorkStores) => Promise<T> | T
        ) =>
          target.withPersistenceUnitOfWork(receiptStore, (stores) =>
            fn({
              leaseStore: withFailingGenerationUpdateCapability(stores.leaseStore),
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

async function runReadinessGeneration(
  leaseStore: BrowserSurfaceLeaseStore,
  receiptStore: BrowserSurfaceReplacementReceiptStore,
  shouldFail: boolean
): Promise<number> {
  let appendCalls = 0;
  const observedReceiptStore = countAppends(receiptStore, () => {
    appendCalls += 1;
  });
  const boundLeaseStore = shouldFail ? withFailingGenerationUpdate(leaseStore) : leaseStore;
  const hooks = createReplacementLifecycleHooks({
    allocator: null,
    leaseStore: boundLeaseStore,
    log: {},
    persistenceUnitOfWork: createBrowserSurfacePersistenceUnitOfWork(boundLeaseStore, observedReceiptStore),
    receiptStore: observedReceiptStore,
  });

  const operation = hooks.recordBrowserGeneration(
    lease(),
    surface(),
    "connector-readiness-atomicity",
    "run-readiness-atomicity",
    {
      browserGenerationHash: NEW_GENERATION_HASH,
      ok: true,
      pageTargetCount: 1,
    }
  );
  if (shouldFail) {
    await assert.rejects(operation, INJECTED_FAILURE);
  } else {
    await operation;
  }
  return appendCalls;
}

async function assertReadinessGenerationAtomicity(
  leaseStore: BrowserSurfaceLeaseStore,
  receiptStore: BrowserSurfaceReplacementReceiptStore
): Promise<void> {
  await leaseStore.upsertSurface(surface());

  const rollbackAppendCalls = await runReadinessGeneration(leaseStore, receiptStore, true);
  assert.equal(
    rollbackAppendCalls,
    2,
    "rollback oracle must reach both receipt appends before the injected hash failure"
  );
  assert.deepEqual(
    (await receiptStore.list()).filter((receipt) => receipt.surface_id === SURFACE_ID),
    [],
    "readiness receipts must roll back with the failed browser-generation projection update"
  );
  assert.equal(
    (await leaseStore.getSurface(SURFACE_ID))?.browser_generation_hash,
    OLD_GENERATION_HASH,
    "the browser-generation projection must remain unchanged after rollback"
  );

  const happyPathAppendCalls = await runReadinessGeneration(leaseStore, receiptStore, false);
  assert.equal(happyPathAppendCalls, 2, "happy path must append started and completed readiness receipts");
  assert.deepEqual(
    (await receiptStore.list()).filter((receipt) => receipt.surface_id === SURFACE_ID).map((receipt) => receipt.phase),
    ["started", "completed"],
    "happy path must commit one readiness replacement pair"
  );
  assert.equal(
    (await leaseStore.getSurface(SURFACE_ID))?.browser_generation_hash,
    NEW_GENERATION_HASH,
    "happy path must commit the browser-generation projection with its receipts"
  );
}

test("readiness-generation receipt and browser hash are atomic on SQLite", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("browser-surface-readiness-generation-atomicity"));
  t.after(() => closeDb());
  await assertReadinessGenerationAtomicity(
    createSqliteBrowserSurfaceLeaseStore(),
    createSqliteBrowserSurfaceReplacementReceiptStore()
  );
});

test("readiness-generation persistence fails closed when the server-owned UoW is absent", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("browser-surface-readiness-generation-fail-closed"));
  t.after(() => closeDb());
  const leaseStore = createSqliteBrowserSurfaceLeaseStore();
  const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
  await leaseStore.upsertSurface(surface());
  const hooks = createReplacementLifecycleHooks({
    allocator: null,
    leaseStore,
    log: {},
    persistenceUnitOfWork: null,
    receiptStore,
  });

  await assert.rejects(
    () =>
      hooks.recordBrowserGeneration(lease(), surface(), "connector-readiness-atomicity", "run-readiness-atomicity", {
        browserGenerationHash: NEW_GENERATION_HASH,
        ok: true,
        pageTargetCount: 1,
      }),
    MISSING_UOW
  );
  assert.deepEqual(
    (await receiptStore.list()).filter((receipt) => receipt.surface_id === SURFACE_ID),
    []
  );
  assert.equal((await leaseStore.getSurface(SURFACE_ID))?.browser_generation_hash, OLD_GENERATION_HASH);
});

test("readiness-generation receipt and browser hash are atomic on disposable PostgreSQL", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  t.after(async () => {
    await postgresQuery("DELETE FROM browser_surface_replacement_receipts WHERE surface_id = $1", [SURFACE_ID]);
    await postgresQuery("DELETE FROM browser_surfaces WHERE surface_id = $1", [SURFACE_ID]);
    await closePostgresStorage();
  });
  await postgresQuery("DELETE FROM browser_surface_replacement_receipts WHERE surface_id = $1", [SURFACE_ID]);
  await postgresQuery("DELETE FROM browser_surfaces WHERE surface_id = $1", [SURFACE_ID]);
  await assertReadinessGenerationAtomicity(
    createPostgresBrowserSurfaceLeaseStore(),
    createPostgresBrowserSurfaceReplacementReceiptStore()
  );
});
