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
  admitAndRecordStart,
  type BrowserSurfaceReplacementLedger,
  createBrowserSurfaceReplacementLedger,
  createReplacementObservingAllocator,
  deriveOpaqueGenerationHash,
  type ReplacementCompletionInput,
  type ReplacementObservingAllocatorOptions,
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
  const admissionOptions = createAdmissionOptions(input, ledger);
  const allocator = wrapAllocator(input, admissionOptions);
  return {
    allocator,
    recordBrowserGeneration: (lease, surface, connectorId, runId, result) =>
      recordBrowserGeneration({
        admissionOptions,
        connectorId,
        lease,
        leaseStore: input.leaseStore,
        ledger,
        receiptStore: input.receiptStore,
        result,
        runId,
        surface,
      }),
    recordExternalSurfaceLoss: (surface) => recordExternalSurfaceLoss(admissionOptions, surface),
  };
}

/**
 * The single bounded, uncertain-write-safe admission boundary every audit
 * receipt admission in this controller passes through (2026-08-01
 * seventh/final gate revision — closes a state-machine-boundary gap where
 * `recordExternalSurfaceLoss`, `recordCurrentGeneration`, and
 * `recordRecoveredFailedSuccessor` each called `ledger.start()` directly and
 * persisted with a bare `store.append`, bypassing both the per-scope
 * unknown-admission cap `ledger.admitStart` enforces and the
 * commit-then-reject reconciliation `admitAndRecordStart` performs). This is
 * the exact same options shape `wrapAllocator` builds for the allocator
 * wrapper — one boundary, one options object, reused by every admission
 * call site in this controller.
 */
function createAdmissionOptions(
  input: {
    readonly receiptStore: BrowserSurfaceReplacementReceiptStore | null;
    readonly log: ControllerLogger;
  },
  ledger: BrowserSurfaceReplacementLedger
): ReplacementObservingAllocatorOptions {
  return {
    ledger,
    onPersistenceError: (error) => logReplacementPersistenceError(input.log, error),
    persist: (receipt) => persistReplacementReceipt(input.receiptStore, receipt),
    reconcileStartedAdmission: (replacementId) =>
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      input.receiptStore?.findByReplacementId(replacementId) ?? Promise.resolve(null),
  };
}

function wrapAllocator(
  input: {
    readonly allocator: BrowserSurfaceAllocator | null;
    readonly receiptStore: BrowserSurfaceReplacementReceiptStore | null;
    readonly log: ControllerLogger;
  },
  admissionOptions: ReplacementObservingAllocatorOptions
): BrowserSurfaceAllocator | null {
  if (!(input.allocator && input.receiptStore)) {
    return input.allocator;
  }
  return createReplacementObservingAllocator(input.allocator, {
    ...admissionOptions,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    findPending: (surfaceId) => input.receiptStore?.findPendingForSurface(surfaceId) ?? Promise.resolve(null),
    findPendingForScope: (scope) => {
      if (!input.receiptStore) {
        return Promise.resolve(null);
      }
      return input.receiptStore.findPendingForScope({
        connection_id: scope.connectionId,
        preferred_surface_id: scope.preferredSurfaceId,
        profile_key: scope.profileKey,
        surface_subject_id: scope.surfaceSubjectId,
      });
    },
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
  admissionOptions: ReplacementObservingAllocatorOptions,
  surface: BrowserSurface
): Promise<void> {
  const previousGenerationHash = surface.container_id ? deriveOpaqueGenerationHash(surface.container_id) : undefined;
  await admitAndRecordStart(admissionOptions, externalLossStartInput(surface, previousGenerationHash));
}

function externalLossStartInput(
  surface: BrowserSurface,
  previousGenerationHash: string | undefined
): ReplacementStartInput {
  const result = {
    cause: "external_or_host_loss",
    connection_id: surface.surface_subject_id ?? surface.connector_id,
    connector_id: surface.connector_id,
    idempotency_key: `external-loss:${surface.surface_id}:${previousGenerationHash ?? "unknown"}:${surface.last_used_at}`,
    profile_key: surface.profile_key,
    surface_id: surface.surface_id,
  } as ReplacementStartInput;
  assignOptional(result, "surface_subject_id", surface.surface_subject_id);
  assignOptional(result, "previous_generation_hash", previousGenerationHash);
  return result;
}

async function recordBrowserGeneration(input: {
  readonly admissionOptions: ReplacementObservingAllocatorOptions;
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
    readonly admissionOptions: ReplacementObservingAllocatorOptions;
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
    await recordRecoveredFailedSuccessor(input, generationHash);
    return;
  }
  if (!previousGenerationHash) {
    await recordRecoveredFailedSuccessor(input, generationHash);
    await input.leaseStore.updateBrowserGenerationHash(input.surface.surface_id, generationHash);
    return;
  }
  const cause = stableContainerIdentity(input.surface, persistedSurface)
    ? "same_container_browser_generation_change"
    : "external_or_host_loss";
  const started = await admitAndRecordStart(
    input.admissionOptions,
    currentGenerationStartInput(input, previousGenerationHash, generationHash, cause)
  );
  // `admitAndRecordStart` returns null when the scope's admission was
  // refused (a different unresolved unknown already owns it) or confirmed
  // absent after an uncertain-write rejection — either way there is no
  // durably admitted `started` receipt beneath it, so completing it would
  // throw (the ledger refuses to resolve a receipt it never durably
  // admitted). Skipping the completion here is the correct terminal
  // outcome for this observation, not a bypass: the next readiness
  // observation for the same surface will retry admission from scratch.
  if (started) {
    await persistReplacementReceipt(
      input.receiptStore,
      input.ledger.complete(completionInput(started, generationHash))
    );
  }
  await input.leaseStore.updateBrowserGenerationHash(input.surface.surface_id, generationHash);
}

async function recordRecoveredFailedSuccessor(
  input: {
    readonly admissionOptions: ReplacementObservingAllocatorOptions;
    readonly receiptStore: BrowserSurfaceReplacementReceiptStore | null;
    readonly ledger: BrowserSurfaceReplacementLedger;
    readonly surface: BrowserSurface;
  },
  generationHash: string
): Promise<void> {
  const store = input.receiptStore;
  if (!store) {
    return;
  }
  const failed = await store.selectSystemActionable({
    connection_id: input.surface.surface_subject_id ?? input.surface.connector_id,
    profile_key: input.surface.profile_key,
    ...(input.surface.surface_subject_id ? { surface_subject_id: input.surface.surface_subject_id } : {}),
  });
  if (!failed) {
    return;
  }
  const started = await admitAndRecordStart(input.admissionOptions, {
    cause: "allocator_internal_ensure_surface",
    connection_id: failed.connection_id,
    connector_id: input.surface.connector_id,
    idempotency_key: `successor-recovered:${failed.replacement_id}:${input.surface.surface_id}:${generationHash}`,
    profile_key: input.surface.profile_key,
    surface_id: input.surface.surface_id,
    ...(input.surface.surface_subject_id ? { surface_subject_id: input.surface.surface_subject_id } : {}),
  });
  // Same as `recordCurrentGeneration`: a refused or confirmed-absent
  // admission has no durably admitted `started` receipt to complete.
  if (started) {
    await persistReplacementReceipt(store, input.ledger.complete(pendingCompletionInput(started, generationHash)));
  }
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
