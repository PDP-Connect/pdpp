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
const OWNER_RUN_IDS = ["run-readiness-owner-a", "run-readiness-owner-b"] as const;

function surfaceFor(
  surfaceId: string,
  connectorId: string,
  profileKey: string,
  surfaceSubjectId: string
): BrowserSurfaceWithPersistenceMetadata {
  return {
    backend: "neko",
    browser_generation_hash: OLD_GENERATION_HASH,
    cdp_url: "http://neko:9222",
    connector_id: connectorId,
    container_id: "container-readiness-atomicity",
    created_at: NOW,
    health: "ready",
    last_used_at: NOW,
    profile_key: profileKey,
    stream_base_url: "http://neko:8080",
    surface_id: surfaceId,
    surface_subject_id: surfaceSubjectId,
  };
}

function surface(): BrowserSurfaceWithPersistenceMetadata {
  return surfaceFor(
    SURFACE_ID,
    "connector-readiness-atomicity",
    "profile-readiness-atomicity",
    "subject-readiness-atomicity"
  );
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
  real: BrowserSurfacePersistenceLeaseCapability,
  shouldFail: () => boolean = () => true
): BrowserSurfacePersistenceLeaseCapability {
  return {
    getSurface: (surfaceId) => real.getSurface(surfaceId),
    updateBrowserGenerationHash: (surfaceId, browserGenerationHash) => {
      if (surfaceId === SURFACE_ID && shouldFail()) {
        throw new Error("injected: browser generation hash persistence failed");
      }
      return real.updateBrowserGenerationHash(surfaceId, browserGenerationHash);
    },
    upsertSurface: (nextSurface) => real.upsertSurface(nextSurface),
  };
}

function withFailingGenerationUpdate(
  real: BrowserSurfaceLeaseStore,
  shouldFail: () => boolean = () => true
): BrowserSurfaceLeaseStore {
  const wrapped: BrowserSurfaceLeaseStore = new Proxy(real, {
    get(target, prop) {
      if (prop === "withPersistenceUnitOfWork") {
        return <T>(
          receiptStore: BrowserSurfaceReplacementReceiptStore,
          fn: (stores: BrowserSurfacePersistenceUnitOfWorkStores) => Promise<T> | T
        ) =>
          target.withPersistenceUnitOfWork(receiptStore, (stores) =>
            fn({
              leaseStore: withFailingGenerationUpdateCapability(stores.leaseStore, shouldFail),
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

function observeReadinessGeneration(
  leaseStore: BrowserSurfaceLeaseStore,
  receiptStore: BrowserSurfaceReplacementReceiptStore,
  runId: string
): Promise<void> {
  const hooks = createReplacementLifecycleHooks({
    allocator: null,
    leaseStore,
    log: {},
    persistenceUnitOfWork: createBrowserSurfacePersistenceUnitOfWork(leaseStore, receiptStore),
    receiptStore,
  });
  return hooks.recordBrowserGeneration(lease(), surface(), "connector-readiness-atomicity", runId, {
    browserGenerationHash: NEW_GENERATION_HASH,
    ok: true,
    pageTargetCount: 1,
  });
}

async function assertConcurrentReadinessObservers(
  leaseStore: BrowserSurfaceLeaseStore,
  receiptStore: BrowserSurfaceReplacementReceiptStore
): Promise<void> {
  await leaseStore.upsertSurface(surface());
  const results = await Promise.allSettled(
    OWNER_RUN_IDS.map((runId) => observeReadinessGeneration(leaseStore, receiptStore, runId))
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled"],
    "both concurrent readiness observers must return success"
  );

  const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === SURFACE_ID);
  assert.deepEqual(
    receipts.map((receipt) => receipt.phase),
    ["started", "completed"],
    "concurrent observers must commit exactly one started/completed transition"
  );
  const [started, completed] = receipts;
  assert.ok(started, "expected the durable started transition");
  assert.ok(completed, "expected the durable completed transition");
  assert.equal(started.replacement_id, completed.replacement_id);
  assert.ok(OWNER_RUN_IDS.includes(started.run_id as (typeof OWNER_RUN_IDS)[number]));
  assert.equal(
    (await leaseStore.getSurface(SURFACE_ID))?.browser_generation_hash,
    NEW_GENERATION_HASH,
    "the authoritative generation must commit with the transition"
  );
}

async function assertReadinessReplayAfterRestart(
  leaseStore: BrowserSurfaceLeaseStore,
  receiptStore: BrowserSurfaceReplacementReceiptStore
): Promise<void> {
  await observeReadinessGeneration(leaseStore, receiptStore, "run-readiness-after-restart");
  assert.deepEqual(
    (await receiptStore.list()).filter((receipt) => receipt.surface_id === SURFACE_ID).map((receipt) => receipt.phase),
    ["started", "completed"],
    "a restarted observer must replay the committed transition without appending another pair"
  );
}

async function assertConcurrentRollbackHandoff(
  leaseStore: BrowserSurfaceLeaseStore,
  receiptStore: BrowserSurfaceReplacementReceiptStore,
  firstObserverReceiptStore: BrowserSurfaceReplacementReceiptStore,
  secondObserverReceiptStore: BrowserSurfaceReplacementReceiptStore
): Promise<void> {
  await leaseStore.upsertSurface(surface());
  let failNextGenerationUpdate = true;
  const failingLeaseStore = withFailingGenerationUpdate(leaseStore, () => {
    if (!failNextGenerationUpdate) {
      return false;
    }
    failNextGenerationUpdate = false;
    return true;
  });
  const results = await Promise.allSettled([
    observeReadinessGeneration(failingLeaseStore, firstObserverReceiptStore, OWNER_RUN_IDS[0]),
    observeReadinessGeneration(leaseStore, secondObserverReceiptStore, OWNER_RUN_IDS[1]),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "fulfilled"],
    "a failed owner must roll back while the queued owner completes the transition"
  );
  const [failed] = results;
  assert.equal(failed.status, "rejected");
  assert.match(String(failed.reason), INJECTED_FAILURE);

  const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === SURFACE_ID);
  assert.deepEqual(
    receipts.map((receipt) => receipt.phase),
    ["started", "completed"],
    "the rolled-back owner must leave no durable partial transition"
  );
  assert.equal(receipts[0]?.run_id, OWNER_RUN_IDS[1], "the successful successor owns the committed audit attribution");
  assert.equal((await leaseStore.getSurface(SURFACE_ID))?.browser_generation_hash, NEW_GENERATION_HASH);
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

test("two concurrent readiness observers converge to one transition on SQLite and replay after restart", async (t) => {
  closeDb();
  const dbPath = makeTemporaryDbPath("browser-surface-readiness-generation-concurrency");
  initDb(dbPath);
  t.after(() => closeDb());

  await assertConcurrentReadinessObservers(
    createSqliteBrowserSurfaceLeaseStore(),
    createSqliteBrowserSurfaceReplacementReceiptStore()
  );

  closeDb();
  initDb(dbPath);
  await assertReadinessReplayAfterRestart(
    createSqliteBrowserSurfaceLeaseStore(),
    createSqliteBrowserSurfaceReplacementReceiptStore()
  );
});

test("a failed concurrent readiness observer rolls back before the SQLite successor commits", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("browser-surface-readiness-generation-concurrency-rollback"));
  t.after(() => closeDb());
  const leaseStore = createSqliteBrowserSurfaceLeaseStore();
  await assertConcurrentRollbackHandoff(
    leaseStore,
    createSqliteBrowserSurfaceReplacementReceiptStore(),
    createSqliteBrowserSurfaceReplacementReceiptStore(),
    createSqliteBrowserSurfaceReplacementReceiptStore()
  );
});

async function assertUnrelatedSurfaceUnitOfWorkBehavior(
  firstLeaseStore: BrowserSurfaceLeaseStore,
  secondLeaseStore: BrowserSurfaceLeaseStore,
  receiptStore: BrowserSurfaceReplacementReceiptStore,
  firstSurface: BrowserSurfaceWithPersistenceMetadata,
  secondSurface: BrowserSurfaceWithPersistenceMetadata,
  expectedSecondStatus: "fulfilled" | "pending"
): Promise<void> {
  const firstGenerationHash = "c".repeat(64);
  const secondGenerationHash = "d".repeat(64);
  await firstLeaseStore.upsertSurface(firstSurface);
  await firstLeaseStore.upsertSurface(secondSurface);

  let releaseFirst: () => void = () => {
    throw new Error("first transaction gate was not initialized");
  };
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let resolveFirstStarted: () => void = () => {
    throw new Error("first transaction start gate was not initialized");
  };
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const first = firstLeaseStore.withPersistenceUnitOfWork(receiptStore, async (stores) => {
    await stores.leaseStore.updateBrowserGenerationHash(firstSurface.surface_id, firstGenerationHash);
    resolveFirstStarted();
    await firstGate;
  });
  await firstStarted;

  const second = secondLeaseStore.withPersistenceUnitOfWork(receiptStore, (stores) =>
    stores.leaseStore.updateBrowserGenerationHash(secondSurface.surface_id, secondGenerationHash)
  );
  let secondStatus: "fulfilled" | "pending" | "rejected";
  try {
    secondStatus = await Promise.race([
      second.then(
        () => "fulfilled" as const,
        () => "rejected" as const
      ),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 500)),
    ]);
  } finally {
    releaseFirst();
  }
  await Promise.all([first, second]);
  assert.equal(
    secondStatus,
    expectedSecondStatus,
    "unrelated surfaces must share the SQLite transaction queue but retain PostgreSQL row concurrency"
  );

  assert.equal(
    (await firstLeaseStore.getSurface(firstSurface.surface_id))?.browser_generation_hash,
    firstGenerationHash
  );
  assert.equal(
    (await firstLeaseStore.getSurface(secondSurface.surface_id))?.browser_generation_hash,
    secondGenerationHash
  );
}

test("SQLite serializes unrelated browser-surface units at the shared connection authority", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("browser-surface-unrelated-unit-of-work"));
  t.after(() => closeDb());
  await assertUnrelatedSurfaceUnitOfWorkBehavior(
    createSqliteBrowserSurfaceLeaseStore(),
    createSqliteBrowserSurfaceLeaseStore(),
    createSqliteBrowserSurfaceReplacementReceiptStore(),
    surfaceFor("unrelated-surface-a", "connector-unrelated-a", "profile-unrelated-a", "subject-unrelated-a"),
    surfaceFor("unrelated-surface-b", "connector-unrelated-b", "profile-unrelated-b", "subject-unrelated-b"),
    "pending"
  );
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

test("two concurrent readiness observers converge to one transition on disposable PostgreSQL and replay after restart", {
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

  await assertConcurrentReadinessObservers(
    createPostgresBrowserSurfaceLeaseStore(),
    createPostgresBrowserSurfaceReplacementReceiptStore()
  );

  await closePostgresStorage();
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  await assertReadinessReplayAfterRestart(
    createPostgresBrowserSurfaceLeaseStore(),
    createPostgresBrowserSurfaceReplacementReceiptStore()
  );
});

test("a failed concurrent readiness observer rolls back before the PostgreSQL successor commits", {
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

  const leaseStore = createPostgresBrowserSurfaceLeaseStore();
  await assertConcurrentRollbackHandoff(
    leaseStore,
    createPostgresBrowserSurfaceReplacementReceiptStore(),
    createPostgresBrowserSurfaceReplacementReceiptStore(),
    createPostgresBrowserSurfaceReplacementReceiptStore()
  );
});

test("PostgreSQL preserves unrelated browser-surface unit-of-work concurrency", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  const namespace = `unrelated-uow-${process.pid}-${Date.now()}`;
  const firstSurface = surfaceFor(
    `${namespace}-a`,
    `${namespace}-connector-a`,
    `${namespace}-profile-a`,
    `${namespace}-subject-a`
  );
  const secondSurface = surfaceFor(
    `${namespace}-b`,
    `${namespace}-connector-b`,
    `${namespace}-profile-b`,
    `${namespace}-subject-b`
  );
  t.after(async () => {
    await postgresQuery("DELETE FROM browser_surfaces WHERE surface_id IN ($1, $2)", [
      firstSurface.surface_id,
      secondSurface.surface_id,
    ]);
    await closePostgresStorage();
  });
  await assertUnrelatedSurfaceUnitOfWorkBehavior(
    createPostgresBrowserSurfaceLeaseStore(),
    createPostgresBrowserSurfaceLeaseStore(),
    createPostgresBrowserSurfaceReplacementReceiptStore(),
    firstSurface,
    secondSurface,
    "fulfilled"
  );
});
