// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: remote-surface 1.5.1 exports ./leases; Biome 2.5.5 fails to resolve this package export.
import type { BrowserSurface, BrowserSurfaceAllocator, BrowserSurfaceLease } from "@opendatalabs/remote-surface/leases";
import type {
  BrowserSurfaceLeaseStore,
  BrowserSurfaceWithPersistenceMetadata,
} from "../../server/stores/browser-surface-lease-store.ts";
import type { BrowserSurfaceReplacementReceiptStore } from "../../server/stores/browser-surface-replacement-ledger-store.ts";
import type { BrowserSurfaceReadinessProbeResult } from "../browser-surface-readiness.ts";
import {
  type BrowserSurfaceReplacementLedger,
  createBrowserSurfaceReplacementLedger,
  createReplacementObservingAllocator,
  deriveOpaqueGenerationHash,
  type ReplacementCompletionInput,
  type ReplacementReceipt,
  type ReplacementStartInput,
  type ReplacementTerminalInput,
} from "./replacement-receipt-ledger.ts";

interface ControllerLogger {
  warn?: (message: string) => void;
}

export interface ReplacementLifecycleHooks {
  readonly allocator: BrowserSurfaceAllocator | null;
  readonly recordBrowserGeneration: (
    lease: BrowserSurfaceLease,
    surface: BrowserSurface | null,
    connectorId: string,
    runId: string,
    result: BrowserSurfaceReadinessProbeResult
  ) => Promise<void>;
  readonly recordExternalSurfaceLoss: (surface: BrowserSurface) => Promise<void>;
}

export function createReplacementLifecycleHooks(input: {
  readonly allocator: BrowserSurfaceAllocator | null;
  readonly leaseStore: BrowserSurfaceLeaseStore | null;
  readonly receiptStore: BrowserSurfaceReplacementReceiptStore | null;
  readonly log: ControllerLogger;
}): ReplacementLifecycleHooks {
  const ledger = createBrowserSurfaceReplacementLedger();
  const allocator = wrapAllocator(input, ledger);
  return {
    allocator,
    recordBrowserGeneration: (lease, surface, connectorId, runId, result) =>
      recordBrowserGeneration({
        connectorId,
        lease,
        leaseStore: input.leaseStore,
        ledger,
        receiptStore: input.receiptStore,
        result,
        runId,
        surface,
      }),
    recordExternalSurfaceLoss: (surface) => recordExternalSurfaceLoss(input.receiptStore, ledger, surface),
  };
}

function wrapAllocator(
  input: {
    readonly allocator: BrowserSurfaceAllocator | null;
    readonly receiptStore: BrowserSurfaceReplacementReceiptStore | null;
    readonly log: ControllerLogger;
  },
  ledger: BrowserSurfaceReplacementLedger
): BrowserSurfaceAllocator | null {
  if (!(input.allocator && input.receiptStore)) {
    return input.allocator;
  }
  return createReplacementObservingAllocator(input.allocator, {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    findPending: (surfaceId) => input.receiptStore?.findPendingForSurface(surfaceId) ?? Promise.resolve(null),
    ledger,
    onPersistenceError: (error) => logReplacementPersistenceError(input.log, error),
    persist: (receipt) => persistReplacementReceipt(input.receiptStore, receipt),
  });
}

function persistReplacementReceipt(
  store: BrowserSurfaceReplacementReceiptStore | null,
  receipt: ReplacementReceipt
): Promise<ReplacementReceipt> {
  return Promise.resolve(store ? store.append(receipt) : receipt);
}

function logReplacementPersistenceError(log: ControllerLogger, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  log.warn?.(`[controller] replacement receipt persistence failed: ${message}`);
}

async function recordExternalSurfaceLoss(
  store: BrowserSurfaceReplacementReceiptStore | null,
  ledger: BrowserSurfaceReplacementLedger,
  surface: BrowserSurface
): Promise<void> {
  if (!store) {
    return;
  }
  const previousGenerationHash = surface.container_id ? deriveOpaqueGenerationHash(surface.container_id) : undefined;
  const started = ledger.start(externalLossStartInput(surface, previousGenerationHash));
  await persistReplacementReceipt(store, started);
  await persistReplacementReceipt(store, ledger.terminate(terminalInput(started, "failed")));
}

function externalLossStartInput(
  surface: BrowserSurface,
  previousGenerationHash: string | undefined
): ReplacementStartInput {
  const result = {
    cause: "external_or_host_loss",
    connection_id: surface.surface_subject_id ?? surface.connector_id,
    connector_id: surface.connector_id,
    idempotency_key: `external-loss:${surface.surface_id}:${previousGenerationHash ?? "unknown"}`,
    profile_key: surface.profile_key,
    surface_id: surface.surface_id,
  } as ReplacementStartInput;
  assignOptional(result, "surface_subject_id", surface.surface_subject_id);
  assignOptional(result, "previous_generation_hash", previousGenerationHash);
  return result;
}

async function recordBrowserGeneration(input: {
  readonly lease: BrowserSurfaceLease;
  readonly surface: BrowserSurface | null;
  readonly connectorId: string;
  readonly runId: string;
  readonly result: BrowserSurfaceReadinessProbeResult;
  readonly leaseStore: BrowserSurfaceLeaseStore | null;
  readonly receiptStore: BrowserSurfaceReplacementReceiptStore | null;
  readonly ledger: BrowserSurfaceReplacementLedger;
}): Promise<void> {
  if (!(input.leaseStore && input.surface)) {
    return;
  }
  if (!(input.result.ok && input.result.browserGenerationHash)) {
    return;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const leaseStore = input.leaseStore;
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const surface = input.surface;
  const generationHash = input.result.browserGenerationHash;
  const persistedSurface = await leaseStore.getSurface(surface.surface_id);
  const pending = await pendingForReadiness(input.receiptStore, surface);
  if (pending) {
    await completePendingGeneration({ ...input, leaseStore, surface }, pending, generationHash);
    return;
  }
  await recordCurrentGeneration({ ...input, leaseStore, surface }, persistedSurface, generationHash);
}

async function pendingForReadiness(
  store: BrowserSurfaceReplacementReceiptStore | null,
  surface: BrowserSurface
): Promise<ReplacementReceipt | null> {
  if (!store) {
    return null;
  }
  const sameSurface = await store.findPendingForSurface(surface.surface_id);
  if (sameSurface) {
    return sameSurface;
  }
  return store.findPendingForScope({
    connection_id: surface.surface_subject_id ?? surface.connector_id,
    preferred_surface_id: surface.surface_id,
    profile_key: surface.profile_key,
    surface_subject_id: surface.surface_subject_id ?? null,
  });
}

async function completePendingGeneration(
  input: {
    readonly leaseStore: BrowserSurfaceLeaseStore;
    readonly receiptStore: BrowserSurfaceReplacementReceiptStore | null;
    readonly ledger: BrowserSurfaceReplacementLedger;
    readonly surface: BrowserSurface;
  },
  pending: ReplacementReceipt,
  generationHash: string
): Promise<void> {
  input.ledger.hydrate([pending]);
  const completed = input.ledger.complete(pendingCompletionInput(pending, generationHash));
  await persistReplacementReceipt(input.receiptStore, completed);
  await input.leaseStore.updateBrowserGenerationHash(input.surface.surface_id, generationHash);
}

function pendingCompletionInput(pending: ReplacementReceipt, generationHash: string): ReplacementCompletionInput {
  const result = {
    cause: pending.cause,
    connection_id: pending.connection_id,
    next_generation_hash: generationHash,
    profile_key: pending.profile_key,
    replacement_id: pending.replacement_id,
  } as ReplacementCompletionInput;
  copyOptionalReceiptFields(result, pending);
  return result;
}

async function recordCurrentGeneration(
  input: {
    readonly lease: BrowserSurfaceLease;
    readonly surface: BrowserSurface;
    readonly connectorId: string;
    readonly runId: string;
    readonly receiptStore: BrowserSurfaceReplacementReceiptStore | null;
    readonly leaseStore: BrowserSurfaceLeaseStore;
    readonly ledger: BrowserSurfaceReplacementLedger;
  },
  persistedSurface: BrowserSurfaceWithPersistenceMetadata | null,
  generationHash: string
): Promise<void> {
  const previousGenerationHash = persistedSurface?.browser_generation_hash;
  if (previousGenerationHash === generationHash) {
    return;
  }
  if (!previousGenerationHash) {
    await input.leaseStore.updateBrowserGenerationHash(input.surface.surface_id, generationHash);
    return;
  }
  const cause = stableContainerIdentity(input.surface, persistedSurface)
    ? "same_container_browser_generation_change"
    : "external_or_host_loss";
  const started = input.ledger.start(currentGenerationStartInput(input, previousGenerationHash, generationHash, cause));
  await persistReplacementReceipt(input.receiptStore, started);
  await persistReplacementReceipt(input.receiptStore, input.ledger.complete(completionInput(started, generationHash)));
  await input.leaseStore.updateBrowserGenerationHash(input.surface.surface_id, generationHash);
}

function stableContainerIdentity(current: BrowserSurface, persisted: BrowserSurface | null): boolean {
  return Boolean(current.container_id && persisted?.container_id && current.container_id === persisted.container_id);
}

function currentGenerationStartInput(
  input: {
    readonly lease: BrowserSurfaceLease;
    readonly surface: BrowserSurface;
    readonly connectorId: string;
    readonly runId: string;
  },
  previousGenerationHash: string,
  generationHash: string,
  cause: "same_container_browser_generation_change" | "external_or_host_loss"
): ReplacementStartInput {
  const result = {
    cause,
    connection_id: input.surface.surface_subject_id ?? input.connectorId,
    connector_id: input.connectorId,
    idempotency_key: `browser-generation:${input.surface.surface_id}:${previousGenerationHash}:${generationHash}`,
    previous_generation_hash: previousGenerationHash,
    profile_key: input.surface.profile_key,
    run_id: input.runId,
    surface_id: input.surface.surface_id,
  } as ReplacementStartInput;
  assignOptional(result, "surface_subject_id", input.surface.surface_subject_id);
  assignOptional(result, "lease_id", input.lease.lease_id);
  return result;
}

function completionInput(started: ReplacementReceipt, generationHash: string): ReplacementCompletionInput {
  const result = {
    cause: started.cause,
    connection_id: started.connection_id,
    next_generation_hash: generationHash,
    profile_key: started.profile_key,
    replacement_id: started.replacement_id,
  } as ReplacementCompletionInput;
  copyOptionalReceiptFields(result, started);
  return result;
}

function terminalInput(started: ReplacementReceipt, outcome: "failed" | "abandoned"): ReplacementTerminalInput {
  const result = {
    cause: started.cause,
    connection_id: started.connection_id,
    outcome,
    profile_key: started.profile_key,
    replacement_id: started.replacement_id,
  } as ReplacementTerminalInput;
  copyOptionalReceiptFields(result, started);
  return result;
}

function copyOptionalReceiptFields(
  target: ReplacementCompletionInput | ReplacementTerminalInput,
  source: ReplacementReceipt
): void {
  assignOptional(target, "connector_id", source.connector_id);
  assignOptional(target, "surface_subject_id", source.surface_subject_id);
  assignOptional(target, "run_id", source.run_id);
  assignOptional(target, "lease_id", source.lease_id);
  assignOptional(target, "surface_id", source.surface_id);
}

function assignOptional<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== undefined) {
    (target as Record<string, unknown>)[key] = value;
  }
}
