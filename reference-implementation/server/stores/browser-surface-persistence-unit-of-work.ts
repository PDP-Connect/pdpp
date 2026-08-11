// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BrowserSurfaceLeaseStore } from "./browser-surface-lease-store.ts";
import type { BrowserSurfaceReplacementReceiptStore } from "./browser-surface-replacement-ledger-store.ts";

export interface BrowserSurfacePersistenceTransaction {
  readonly backend: "postgres" | "sqlite";
  readonly query?: (sql: string, values?: readonly unknown[]) => Promise<{ readonly rows: readonly unknown[] }>;
}

export interface BrowserSurfacePersistenceUnitOfWorkStores {
  readonly leaseStore: BrowserSurfaceLeaseStore;
  readonly replacementReceiptStore: BrowserSurfaceReplacementReceiptStore;
}

export interface BrowserSurfacePersistenceUnitOfWork {
  withTransaction: <T>(fn: (stores: BrowserSurfacePersistenceUnitOfWorkStores) => Promise<T> | T) => Promise<T>;
}

export function createBrowserSurfacePersistenceUnitOfWork(
  leaseStore: BrowserSurfaceLeaseStore,
  replacementReceiptStore: BrowserSurfaceReplacementReceiptStore
): BrowserSurfacePersistenceUnitOfWork {
  return {
    withTransaction: (fn) => leaseStore.withPersistenceUnitOfWork(replacementReceiptStore, fn),
  };
}
