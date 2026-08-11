// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReplacementReceipt } from "../../runtime/browser-surface/replacement-receipt-ledger.ts";
import type { BrowserSurfaceLeaseStore, BrowserSurfaceWithPersistenceMetadata } from "./browser-surface-lease-store.ts";
import type { BrowserSurfaceReplacementReceiptStore } from "./browser-surface-replacement-ledger-store.ts";

export interface BrowserSurfacePersistenceTransaction {
  readonly backend: "postgres" | "sqlite";
  readonly query?: (sql: string, values?: readonly unknown[]) => Promise<{ readonly rows: readonly unknown[] }>;
}

export interface BrowserSurfacePersistenceLeaseCapability {
  readonly getSurface: (surfaceId: string) => Promise<BrowserSurfaceWithPersistenceMetadata | null>;
  readonly updateBrowserGenerationHash: (surfaceId: string, browserGenerationHash: string) => Promise<void>;
  readonly upsertSurface: (
    surface: BrowserSurfaceWithPersistenceMetadata
  ) => Promise<BrowserSurfaceWithPersistenceMetadata>;
}

export interface BrowserSurfacePersistenceReceiptCapability {
  readonly append: (receipt: ReplacementReceipt) => Promise<ReplacementReceipt>;
  readonly findPendingForScope: (input: {
    readonly connection_id: string;
    readonly surface_subject_id: string | null;
    readonly profile_key: string;
    readonly preferred_surface_id?: string;
  }) => Promise<ReplacementReceipt | null>;
  readonly findPendingForSurface: (surfaceId: string) => Promise<ReplacementReceipt | null>;
  readonly selectSystemActionable: (input: {
    readonly connection_id: string;
    readonly profile_key: string;
    readonly surface_subject_id?: string;
  }) => Promise<ReplacementReceipt | null>;
}

export interface BrowserSurfacePersistenceUnitOfWorkStores {
  readonly leaseStore: BrowserSurfacePersistenceLeaseCapability;
  readonly replacementReceiptStore: BrowserSurfacePersistenceReceiptCapability;
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

interface CapabilityScope {
  active: boolean;
}

function assertCapabilityActive(scope: CapabilityScope): void {
  if (!scope.active) {
    throw new Error("browser-surface transaction capability is no longer active");
  }
}

function invokeCapability<T>(scope: CapabilityScope, operation: () => T): T {
  assertCapabilityActive(scope);
  return operation();
}

function bindLeaseCapability(
  leaseStore: BrowserSurfacePersistenceLeaseCapability,
  scope: CapabilityScope
): BrowserSurfacePersistenceLeaseCapability {
  return {
    getSurface: (surfaceId) => invokeCapability(scope, () => leaseStore.getSurface(surfaceId)),
    updateBrowserGenerationHash: (surfaceId, browserGenerationHash) =>
      invokeCapability(scope, () => leaseStore.updateBrowserGenerationHash(surfaceId, browserGenerationHash)),
    upsertSurface: (surface) => invokeCapability(scope, () => leaseStore.upsertSurface(surface)),
  };
}

function bindReceiptCapability(
  replacementReceiptStore: BrowserSurfacePersistenceReceiptCapability,
  scope: CapabilityScope
): BrowserSurfacePersistenceReceiptCapability {
  return {
    append: (receipt) => invokeCapability(scope, () => replacementReceiptStore.append(receipt)),
    findPendingForScope: (input) => invokeCapability(scope, () => replacementReceiptStore.findPendingForScope(input)),
    findPendingForSurface: (surfaceId) =>
      invokeCapability(scope, () => replacementReceiptStore.findPendingForSurface(surfaceId)),
    selectSystemActionable: (input) =>
      invokeCapability(scope, () => replacementReceiptStore.selectSystemActionable(input)),
  };
}

export async function runBrowserSurfacePersistenceUnitOfWork<T>(
  stores: BrowserSurfacePersistenceUnitOfWorkStores,
  fn: (stores: BrowserSurfacePersistenceUnitOfWorkStores) => Promise<T> | T
): Promise<T> {
  const scope: CapabilityScope = { active: true };
  try {
    // Await is required: capabilities stay active for the complete callback, including its asynchronous work.
    return await fn({
      leaseStore: bindLeaseCapability(stores.leaseStore, scope),
      replacementReceiptStore: bindReceiptCapability(stores.replacementReceiptStore, scope),
    });
  } finally {
    scope.active = false;
  }
}
