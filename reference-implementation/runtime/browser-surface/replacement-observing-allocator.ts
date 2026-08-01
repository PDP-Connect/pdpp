// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type {
  BrowserSurface,
  BrowserSurfaceAllocator,
  EnsureBrowserSurfaceRequest,
  StopBrowserSurfaceRequest,
  // biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
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
  /**
   * A replacement may receive a new surface ID after allocator or host loss.
   * Scope binds that successor attempt to the durable connection profile.
   */
  readonly findPendingForScope?: (input: {
    readonly connectionId: string;
    readonly profileKey: string;
    readonly surfaceSubjectId: string | null;
    readonly preferredSurfaceId: string;
  }) => Promise<ReplacementReceipt | null>;
  readonly ledger: BrowserSurfaceReplacementLedger;
  readonly onPersistenceError?: (error: unknown) => void;
  readonly persist?: (receipt: ReplacementReceipt) => Promise<ReplacementReceipt>;
}

interface EnsureObservation {
  readonly attemptId: string;
  readonly before: BrowserSurface | null;
  readonly preclaimed: ReplacementReceipt | null;
}

/**
 * Per-allocator-instance set of `started`-phase replacement_ids whose
 * durable persist is known to have failed (2026-08-01 gate revision,
 * Blocker 2). `ledger.start` mutates the ledger's in-memory receipt list
 * unconditionally, before `record` even attempts to persist it — so a
 * rejected first write still leaves a "started, unresolved" receipt
 * sitting in memory, and `findPendingInMemory` (used by
 * `recordContainerTransition`'s pending-transition check) would treat it
 * as an in-flight claim forever, silently suppressing every later real
 * container-rotation receipt for that surface until process restart.
 * Membership here means "do not let this specific in-memory receipt block
 * a later observation" — it does NOT mean "this replacement never
 * happened": the receipt itself, and any later resolution of it, are
 * untouched. Entries are removed once that replacement_id resolves
 * (terminal/completed) or its persist succeeds on a later attempt for the
 * SAME receipt, so this cannot grow without bound across a long-lived
 * process. Scoped to one allocator instance (not module-level) so
 * independent allocators/tests never leak failure state into each other.
 */
type DurablePersistFailureTracker = Set<string>;

/**
 * Reports a bookkeeping fault to the caller-supplied diagnostic hook. This
 * must NEVER be able to replace or block whatever real result/error the
 * caller is in the middle of returning: `onPersistenceError` is
 * production-wired to `log.warn` (`replacement-lifecycle-hooks.ts`), which
 * is not guaranteed not to throw (2026-08-01 gate revision, Blocker 1 — a
 * throwing `log.warn` was shown to replace a real allocator success/error
 * with the logger's own error, exactly the masking hazard this whole file
 * exists to prevent). Mirrors the same try/catch/ignore discipline already
 * used for the sibling exhausted-retry warning in
 * `run-coordinator.ts`'s `emitExhaustedTransientPollRetryWarning` call.
 */
function reportPersistenceError(options: ReplacementObservingAllocatorOptions, error: unknown): void {
  try {
    options.onPersistenceError?.(error);
  } catch {
    // The diagnostic reporter must never interfere with the real result.
  }
}

export function createReplacementObservingAllocator(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions
): BrowserSurfaceAllocator {
  const durableFailures: DurablePersistFailureTracker = new Set();
  return {
    ensureSurface: (request) => ensureSurfaceWithObservation(allocator, options, durableFailures, request),
    getSurfaceStatus: (surfaceId) => allocator.getSurfaceStatus(surfaceId),
    listSurfaces: () => allocator.listSurfaces(),
    stopSurface: (request) => stopSurfaceWithObservation(allocator, options, durableFailures, request),
  };
}

async function ensureSurfaceWithObservation(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  request: EnsureBrowserSurfaceRequest
): Promise<BrowserSurface> {
  const observation = await prepareEnsureObservation(allocator, options, durableFailures, request);
  const after = await performEnsureEffect(allocator, options, durableFailures, request, observation);
  // Bookkeeping only — never allowed to turn a real allocator success into
  // an apparent failure. See recordEnsureSuccessObserved's doc comment.
  await recordEnsureSuccessObserved(options, durableFailures, request, observation, after);
  return after;
}

async function prepareEnsureObservation(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  request: EnsureBrowserSurfaceRequest
): Promise<EnsureObservation> {
  // `before` is a real allocator read: a genuine failure here is a genuine
  // allocator-health signal and must propagate like any other ensureSurface
  // failure.
  const before = await allocator.getSurfaceStatus(request.surfaceId);
  // Everything past this point — including the injectable attempt-ID
  // provider — is replacement-ledger bookkeeping (in-memory and
  // durable-store lookups), not a property of the allocator call itself.
  // A throw anywhere in this boundary (e.g. a transient receipt-store
  // error, or a hostile/buggy injected `createEnsureAttemptId`) must never
  // abort an ensureSurface attempt before the real allocator is even asked
  // — that would masquerade as an allocator failure to callers/retry
  // wrappers that cannot tell the difference (2026-08-01 Amazon incident:
  // a plain, unwrapped receipt-store error here exhausted the
  // starting-surface poll retry budget and terminalized the lease, even
  // though the allocator itself was never given the chance to succeed or
  // fail). `createEnsureAttemptId` is not production-wired today
  // (`replacement-lifecycle-hooks.ts` always defaults to `randomUUID()`)
  // and exists purely to make idempotency keys deterministic in tests — it
  // has no legitimate reason to be trusted more than the lookups it feeds,
  // so it is computed inside this same protected boundary, once, below.
  const { attemptId, preclaimed } = await observePendingReplacement(options, durableFailures, request, before);
  return { attemptId, before, preclaimed };
}

async function observePendingReplacement(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  request: EnsureBrowserSurfaceRequest,
  before: BrowserSurface | null
): Promise<{ attemptId: string; preclaimed: ReplacementReceipt | null }> {
  try {
    const attemptId = options.createEnsureAttemptId?.(request) ?? randomUUID();
    const advertisedReplacement = await startAdvertisedReplacement(
      options,
      durableFailures,
      request,
      before,
      attemptId
    );
    const preclaimed = advertisedReplacement ?? (await pendingReplacementForRequest(options, request));
    return { attemptId, preclaimed };
  } catch (error) {
    reportPersistenceError(options, error);
    // A fault anywhere in this boundary (including a throwing injected
    // createEnsureAttemptId) still needs SOME attempt id for the caller's
    // subsequent bookkeeping calls to use — randomUUID() never throws.
    return { attemptId: randomUUID(), preclaimed: null };
  }
}

function pendingReplacementForRequest(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest
): Promise<ReplacementReceipt | null> {
  if (!options.findPendingForScope) {
    return Promise.resolve(null);
  }
  return options.findPendingForScope({
    connectionId: request.surfaceSubjectId ?? request.connectorId,
    preferredSurfaceId: request.surfaceId,
    profileKey: request.profileKey,
    surfaceSubjectId: request.surfaceSubjectId ?? null,
  });
}

async function performEnsureEffect(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  request: EnsureBrowserSurfaceRequest,
  observation: EnsureObservation
): Promise<BrowserSurface> {
  try {
    return await allocator.ensureSurface(request);
  } catch (error) {
    // Bookkeeping only — a failure recording THIS failure must never replace
    // or mask the real allocator error being rethrown below.
    await recordEnsureFailureBoundaryObserved(options, durableFailures, request, observation);
    throw error;
  }
}

async function recordEnsureFailureBoundaryObserved(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  request: EnsureBrowserSurfaceRequest,
  observation: EnsureObservation
): Promise<void> {
  try {
    if (observation.preclaimed) {
      await recordTerminal(options, durableFailures, observation.preclaimed, "failed");
    } else {
      await recordEnsureFailure(options, durableFailures, request, observation.before, observation.attemptId);
    }
  } catch (error) {
    reportPersistenceError(options, error);
  }
}

/**
 * Records the replacement-ledger side effects of a successful ensureSurface
 * call. This is pure observability/audit-trail bookkeeping ABOUT the
 * allocator's result, not a property of the result itself: a real,
 * successful allocator surface must never be discarded — and reported to
 * the caller and any wrapping retry logic as an error — merely because this
 * bookkeeping failed to persist (2026-08-01 Amazon incident root cause: a
 * plain, unwrapped receipt-store error here was indistinguishable from an
 * allocator failure to `wrapAllocatorWithTransientPollRetry`, which
 * exhausted its retry budget and terminalized an otherwise-healthy lease).
 * Failures are reported via `onPersistenceError` and swallowed.
 */
async function recordEnsureSuccessObserved(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  request: EnsureBrowserSurfaceRequest,
  observation: EnsureObservation,
  after: BrowserSurface
): Promise<void> {
  try {
    if (observation.preclaimed) {
      await recordPreclaimedEnsureResult(options, durableFailures, observation.preclaimed, observation.before, after);
      return;
    }
    await recordContainerTransition(
      options,
      durableFailures,
      request,
      observation.before,
      after,
      observation.attemptId
    );
  } catch (error) {
    reportPersistenceError(options, error);
  }
}

async function recordPreclaimedEnsureResult(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  preclaimed: ReplacementReceipt,
  before: BrowserSurface | null,
  after: BrowserSurface
): Promise<void> {
  if (!after.container_id || after.container_id === before?.container_id) {
    await recordTerminal(options, durableFailures, preclaimed, "abandoned");
  }
}

function startAdvertisedReplacement(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  request: EnsureBrowserSurfaceRequest,
  before: BrowserSurface | null,
  attemptId: string
): Promise<ReplacementReceipt | null> {
  if (!before?.container_id || before.allocator_metadata?.ensure_disposition !== "replace") {
    return Promise.resolve(null);
  }
  return ensureReceipt(options, durableFailures, request, before, before.container_id, attemptId);
}

async function recordContainerTransition(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  request: EnsureBrowserSurfaceRequest,
  before: BrowserSurface | null,
  after: BrowserSurface,
  attemptId: string
): Promise<void> {
  const previousContainerId = before?.container_id;
  if (!(previousContainerId && after.container_id) || previousContainerId === after.container_id) {
    return;
  }
  const existing = await pendingForSurface(options, durableFailures, after.surface_id);
  if (existing) {
    return;
  }
  await ensureReceipt(options, durableFailures, request, after, previousContainerId, attemptId, after.container_id);
}

function ensureReceipt(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
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
  return record(options, durableFailures, started);
}

async function recordEnsureFailure(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
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
  await record(options, durableFailures, started);
  await recordTerminal(options, durableFailures, started, "failed");
}

async function recordTerminal(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  started: ReplacementReceipt | null,
  outcome: "failed" | "abandoned"
): Promise<void> {
  if (!started) {
    return;
  }
  await record(
    options,
    durableFailures,
    options.ledger.terminate({
      connection_id: started.connection_id,
      profile_key: started.profile_key,
      replacement_id: started.replacement_id,
      ...(started.surface_subject_id ? { surface_subject_id: started.surface_subject_id } : {}),
      ...(started.surface_id ? { surface_id: started.surface_id } : {}),
      cause: started.cause,
      outcome,
    })
  );
  // Resolved (successfully or not — the resolution attempt itself may also
  // have failed to persist, but the receipt is no longer a "started,
  // unresolved" claim either way): stop tracking it as a durable-persist
  // failure so the tracker cannot grow across a resolved replacement_id.
  durableFailures.delete(started.replacement_id);
}

async function stopSurfaceWithObservation(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  request: StopBrowserSurfaceRequest
): Promise<BrowserSurface | null> {
  const before = await allocator.getSurfaceStatus(request.surfaceId);
  // Bookkeeping only — must never abort a real stopSurface call before the
  // allocator is even asked. Same masking hazard as ensureSurface's
  // observation step (see prepareEnsureObservation's doc comment).
  const started = await startStopReceiptObserved(options, durableFailures, before, request);
  try {
    return await allocator.stopSurface(request);
  } catch (error) {
    await recordTerminal(options, durableFailures, started, "failed");
    throw error;
  }
}

async function startStopReceiptObserved(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  before: BrowserSurface | null,
  request: StopBrowserSurfaceRequest
): Promise<ReplacementReceipt | null> {
  try {
    return await startStopReceipt(options, durableFailures, before, request);
  } catch (error) {
    reportPersistenceError(options, error);
    return null;
  }
}

function startStopReceipt(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
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
    cause,
    idempotency_key: `stop:${before.surface_id}:${deriveOpaqueGenerationHash(before.container_id)}:${cause}:${attemptId}`,
    previous_generation_hash: deriveOpaqueGenerationHash(before.container_id),
    surface_id: before.surface_id,
  });
  return record(options, durableFailures, started);
}

/**
 * Persists a replacement receipt. This is durable bookkeeping ABOUT an
 * allocator operation, not the operation itself: a persistence failure here
 * must never propagate to callers observing an ensureSurface/stopSurface
 * call, or a real allocator success/failure becomes indistinguishable from
 * "the audit trail had a hiccup" to any wrapping retry logic (2026-08-01
 * Amazon incident root cause). Failures are reported via
 * `onPersistenceError` and swallowed; the in-memory receipt shape is
 * returned unchanged so callers' bookkeeping (which does not depend on
 * durable persistence having succeeded) still proceeds consistently.
 *
 * A rejected `started`-phase persist marks `receipt.replacement_id` in
 * `durableFailures` (2026-08-01 gate revision, Blocker 2): the ledger's
 * `start()` already pushed this receipt into in-memory state before this
 * call ran, so without this tracking a later real container rotation for
 * the SAME surface would find it via `pendingForSurface`'s in-memory
 * lookup and treat it as still-in-flight, permanently suppressing every
 * later durable transition receipt for that surface. A successful persist
 * for a replacement_id already in the tracker (the same receipt recovering
 * on a later attempt) clears the entry.
 */
async function record(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  receipt: ReplacementReceipt
): Promise<ReplacementReceipt> {
  try {
    const persisted = await (options.persist ?? (async (value: ReplacementReceipt) => value))(receipt);
    durableFailures.delete(receipt.replacement_id);
    return persisted;
  } catch (error) {
    reportPersistenceError(options, error);
    if (receipt.phase === "started") {
      durableFailures.add(receipt.replacement_id);
    }
    return receipt;
  }
}

function pendingForSurface(
  options: ReplacementObservingAllocatorOptions,
  durableFailures: DurablePersistFailureTracker,
  surfaceId: string
): Promise<ReplacementReceipt | null> {
  const inMemory = findPendingInMemory(options.ledger.list(), durableFailures, surfaceId);
  return inMemory ? Promise.resolve(inMemory) : (options.findPending?.(surfaceId) ?? Promise.resolve(null));
}

function findPendingInMemory(
  receipts: readonly ReplacementReceipt[],
  durableFailures: DurablePersistFailureTracker,
  surfaceId: string
): ReplacementReceipt | null {
  return (
    receipts
      .filter(
        (receipt) => isPendingForSurface(receipt, receipts, surfaceId) && !durableFailures.has(receipt.replacement_id)
      )
      .sort(compareReceipts)[0] ?? null
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
    cause: "allocator_internal_ensure_surface",
    connection_id: input.surface_subject_id ?? input.connector_id,
    connector_id: input.connector_id,
    profile_key: input.profile_key,
    ...(input.surface_subject_id === undefined ? {} : { surface_subject_id: input.surface_subject_id }),
    ...(input.surface_id === undefined ? {} : { surface_id: input.surface_id }),
  };
  return result;
}
