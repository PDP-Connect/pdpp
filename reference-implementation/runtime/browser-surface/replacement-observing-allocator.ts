import { randomUUID } from "node:crypto";
import type {
  BrowserSurface,
  BrowserSurfaceAllocator,
  EnsureBrowserSurfaceRequest,
  StopBrowserSurfaceRequest,
} from "@opendatalabs/remote-surface/leases";
import {
  type BrowserSurfaceReplacementLedger,
  deriveOpaqueGenerationHash,
  mapStopReasonToReplacementCause,
  type ReplacementReceipt,
  type ReplacementStartInput,
} from "./replacement-receipt-ledger-state.ts";

export interface ReplacementObservingAllocatorOptions {
  readonly createEnsureAttemptId?: (request: EnsureBrowserSurfaceRequest) => string;
  readonly createStopAttemptId?: (request: StopBrowserSurfaceRequest) => string;
  readonly findPending?: (surfaceId: string) => Promise<ReplacementReceipt | null>;
  readonly ledger: BrowserSurfaceReplacementLedger;
  readonly onPersistenceError?: (error: unknown) => void;
  readonly persist?: (receipt: ReplacementReceipt) => Promise<ReplacementReceipt>;
}

interface EnsureObservation {
  readonly attemptId: string;
  readonly before: BrowserSurface | null;
  readonly preclaimed: ReplacementReceipt | null;
}

export function createReplacementObservingAllocator(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions
): BrowserSurfaceAllocator {
  return {
    ensureSurface: (request) => ensureSurfaceWithObservation(allocator, options, request),
    getSurfaceStatus: (surfaceId) => allocator.getSurfaceStatus(surfaceId),
    stopSurface: (request) => stopSurfaceWithObservation(allocator, options, request),
    listSurfaces: () => allocator.listSurfaces(),
  };
}

async function ensureSurfaceWithObservation(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest
): Promise<BrowserSurface> {
  const observation = await prepareEnsureObservation(allocator, options, request);
  const after = await performEnsureEffect(allocator, options, request, observation);
  await recordEnsureSuccess(options, request, observation, after);
  return after;
}

async function prepareEnsureObservation(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest
): Promise<EnsureObservation> {
  const before = await allocator.getSurfaceStatus(request.surfaceId);
  const attemptId = options.createEnsureAttemptId?.(request) ?? randomUUID();
  const preclaimed = await startAdvertisedReplacement(options, request, before, attemptId);
  return { before, attemptId, preclaimed };
}

async function performEnsureEffect(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  observation: EnsureObservation
): Promise<BrowserSurface> {
  try {
    return await allocator.ensureSurface(request);
  } catch (error) {
    await recordEnsureFailureBoundary(options, request, observation);
    throw error;
  }
}

async function recordEnsureFailureBoundary(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  observation: EnsureObservation
): Promise<void> {
  if (observation.preclaimed) {
    await recordTerminal(options, observation.preclaimed, "failed");
  } else {
    await recordEnsureFailure(options, request, observation.before, observation.attemptId);
  }
}

async function recordEnsureSuccess(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  observation: EnsureObservation,
  after: BrowserSurface
): Promise<void> {
  if (observation.preclaimed) {
    await recordPreclaimedEnsureResult(options, observation.preclaimed, observation.before, after);
    return;
  }
  await recordContainerTransition(options, request, observation.before, after, observation.attemptId);
}

async function recordPreclaimedEnsureResult(
  options: ReplacementObservingAllocatorOptions,
  preclaimed: ReplacementReceipt,
  before: BrowserSurface | null,
  after: BrowserSurface
): Promise<void> {
  if (!after.container_id || after.container_id === before?.container_id) {
    await recordTerminal(options, preclaimed, "abandoned");
  }
}

function startAdvertisedReplacement(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  before: BrowserSurface | null,
  attemptId: string
): Promise<ReplacementReceipt | null> {
  if (!before?.container_id || before.allocator_metadata?.ensure_disposition !== "replace") {
    return Promise.resolve(null);
  }
  return ensureReceipt(options, request, before, before.container_id, attemptId);
}

async function recordContainerTransition(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  before: BrowserSurface | null,
  after: BrowserSurface,
  attemptId: string
): Promise<void> {
  const previousContainerId = before?.container_id;
  if (!(previousContainerId && after.container_id) || previousContainerId === after.container_id) {
    return;
  }
  const existing = await pendingForSurface(options, after.surface_id);
  if (existing) {
    return;
  }
  await ensureReceipt(options, request, after, previousContainerId, attemptId, after.container_id);
}

function ensureReceipt(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  surface: BrowserSurface,
  previousContainerId: string,
  attemptId: string,
  nextContainerId?: string
): Promise<ReplacementReceipt> {
  const previousHash = deriveOpaqueGenerationHash(previousContainerId);
  const nextHash = nextContainerId ? `:${deriveOpaqueGenerationHash(nextContainerId)}` : "";
  const started = options.ledger.start({
    ...correlation({
      connector_id: request.connectorId,
      profile_key: request.profileKey,
      ...(request.surfaceSubjectId ? { surface_subject_id: request.surfaceSubjectId } : {}),
      surface_id: surface.surface_id,
    }),
    idempotency_key: `ensure:${surface.surface_id}:${previousHash}${nextHash}:${attemptId}`,
    previous_generation_hash: previousHash,
  });
  return record(options, started);
}

async function recordEnsureFailure(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  before: BrowserSurface | null,
  attemptId: string
): Promise<void> {
  if (!before?.container_id) {
    return;
  }
  const started = options.ledger.start({
    ...correlation({
      connector_id: request.connectorId,
      profile_key: request.profileKey,
      surface_id: request.surfaceId,
    }),
    idempotency_key: `ensure-failed:${request.surfaceId}:${deriveOpaqueGenerationHash(before.container_id)}:${attemptId}`,
    previous_generation_hash: deriveOpaqueGenerationHash(before.container_id),
  });
  await record(options, started);
  await recordTerminal(options, started, "failed");
}

async function recordTerminal(
  options: ReplacementObservingAllocatorOptions,
  started: ReplacementReceipt | null,
  outcome: "failed" | "abandoned"
): Promise<void> {
  if (!started) {
    return;
  }
  await record(
    options,
    options.ledger.terminate({
      replacement_id: started.replacement_id,
      connection_id: started.connection_id,
      profile_key: started.profile_key,
      ...(started.surface_subject_id ? { surface_subject_id: started.surface_subject_id } : {}),
      ...(started.surface_id ? { surface_id: started.surface_id } : {}),
      cause: started.cause,
      outcome,
    })
  );
}

async function stopSurfaceWithObservation(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  request: StopBrowserSurfaceRequest
): Promise<BrowserSurface | null> {
  const before = await allocator.getSurfaceStatus(request.surfaceId);
  const started = await startStopReceipt(options, before, request);
  try {
    return await allocator.stopSurface(request);
  } catch (error) {
    await recordTerminal(options, started, "failed");
    throw error;
  }
}

function startStopReceipt(
  options: ReplacementObservingAllocatorOptions,
  before: BrowserSurface | null,
  request: StopBrowserSurfaceRequest
): Promise<ReplacementReceipt | null> {
  if (!before?.container_id) {
    return Promise.resolve(null);
  }
  const cause = mapStopReasonToReplacementCause(request.reason);
  const attemptId = options.createStopAttemptId?.(request) ?? randomUUID();
  const started = options.ledger.start({
    connection_id: before.surface_subject_id ?? before.connector_id,
    connector_id: before.connector_id,
    profile_key: before.profile_key,
    ...(before.surface_subject_id ? { surface_subject_id: before.surface_subject_id } : {}),
    surface_id: before.surface_id,
    previous_generation_hash: deriveOpaqueGenerationHash(before.container_id),
    idempotency_key: `stop:${before.surface_id}:${deriveOpaqueGenerationHash(before.container_id)}:${cause}:${attemptId}`,
    cause,
  });
  return record(options, started);
}

async function record(
  options: ReplacementObservingAllocatorOptions,
  receipt: ReplacementReceipt
): Promise<ReplacementReceipt> {
  try {
    return await (options.persist ?? (async (value: ReplacementReceipt) => value))(receipt);
  } catch (error) {
    options.onPersistenceError?.(error);
    throw error;
  }
}

function pendingForSurface(
  options: ReplacementObservingAllocatorOptions,
  surfaceId: string
): Promise<ReplacementReceipt | null> {
  const inMemory = findPendingInMemory(options.ledger.list(), surfaceId);
  return inMemory ? Promise.resolve(inMemory) : (options.findPending?.(surfaceId) ?? Promise.resolve(null));
}

function findPendingInMemory(receipts: readonly ReplacementReceipt[], surfaceId: string): ReplacementReceipt | null {
  return (
    receipts.filter((receipt) => isPendingForSurface(receipt, receipts, surfaceId)).sort(compareReceipts)[0] ?? null
  );
}

function isPendingForSurface(
  receipt: ReplacementReceipt,
  receipts: readonly ReplacementReceipt[],
  surfaceId: string
): boolean {
  return (
    receipt.surface_id === surfaceId && receipt.phase === "started" && !hasResolution(receipts, receipt.replacement_id)
  );
}

function hasResolution(receipts: readonly ReplacementReceipt[], replacementId: string): boolean {
  return receipts.some(
    (receipt) =>
      receipt.replacement_id === replacementId && (receipt.phase === "completed" || receipt.phase === "terminal")
  );
}

function compareReceipts(left: ReplacementReceipt, right: ReplacementReceipt): number {
  return right.event_seq - left.event_seq;
}

function correlation(input: {
  readonly connector_id: string;
  readonly profile_key: string;
  readonly surface_subject_id?: string;
  readonly surface_id?: string;
}): ReplacementStartInput {
  const result: ReplacementStartInput = {
    connection_id: input.surface_subject_id ?? input.connector_id,
    connector_id: input.connector_id,
    profile_key: input.profile_key,
    cause: "allocator_internal_ensure_surface",
    ...(input.surface_subject_id === undefined ? {} : { surface_subject_id: input.surface_subject_id }),
    ...(input.surface_id === undefined ? {} : { surface_id: input.surface_id }),
  };
  return result;
}
