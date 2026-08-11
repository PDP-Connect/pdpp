// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { createSqliteBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import {
  type BrowserSurfacePersistenceUnitOfWorkStores,
  createBrowserSurfacePersistenceUnitOfWork,
} from "../server/stores/browser-surface-persistence-unit-of-work.ts";
import { createSqliteBrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

type MissingPropertyGuard<T, K extends PropertyKey> = K extends keyof T ? never : true;

/** Compile-time guard: the UoW callback is not a full store or a DB client. */
export const BROWSER_SURFACE_PERSISTENCE_CAPABILITY_STATIC_GUARD: [
  MissingPropertyGuard<BrowserSurfacePersistenceUnitOfWorkStores["leaseStore"], "withLeaseTransaction">,
  MissingPropertyGuard<BrowserSurfacePersistenceUnitOfWorkStores["leaseStore"], "query">,
  MissingPropertyGuard<BrowserSurfacePersistenceUnitOfWorkStores["replacementReceiptStore"], "bindToTransaction">,
  MissingPropertyGuard<
    BrowserSurfacePersistenceUnitOfWorkStores["replacementReceiptStore"],
    "applySelectionOverrideBatch"
  >,
  MissingPropertyGuard<BrowserSurfacePersistenceUnitOfWorkStores["replacementReceiptStore"], "list">,
] = [true, true, true, true, true];

const INACTIVE_CAPABILITY = /browser-surface transaction capability is no longer active/;

test("transaction-bound capabilities reject retained methods after callback exit", async (t) => {
  initDb(makeTemporaryDbPath("browser-surface-persistence-capability"));
  t.after(() => closeDb());

  const unitOfWork = createBrowserSurfacePersistenceUnitOfWork(
    createSqliteBrowserSurfaceLeaseStore(),
    createSqliteBrowserSurfaceReplacementReceiptStore()
  );
  let retainedStore: BrowserSurfacePersistenceUnitOfWorkStores["leaseStore"] | undefined;
  let retainedMethod: BrowserSurfacePersistenceUnitOfWorkStores["leaseStore"]["getSurface"] | undefined;

  await unitOfWork.withTransaction(async (stores) => {
    retainedStore = stores.leaseStore;
    retainedMethod = stores.leaseStore.getSurface;
    assert.equal(await stores.leaseStore.getSurface("missing-surface"), null);
  });

  const store = retainedStore;
  const method = retainedMethod;
  assert.ok(store);
  assert.ok(method);
  assert.throws(() => store.getSurface("missing-surface"), INACTIVE_CAPABILITY);
  assert.throws(() => method("missing-surface"), INACTIVE_CAPABILITY);
});
