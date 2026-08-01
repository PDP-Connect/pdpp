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
  /**
   * Authoritative durable read-after-uncertain-write reconciliation
   * (2026-08-01 fourth gate revision): `persist` can commit its durable
   * write and THEN reject — SQLite's post-insert re-read and Postgres's
   * post-insert RETURNING-result handling can both throw after the row is
   * already durably committed. A rejected `started`-phase `persist` call
   * is therefore an UNKNOWN outcome, not proof of non-commit. This is
   * called with the receipt's `replacement_id` to authoritatively resolve
   * that uncertainty before `record` decides whether to roll the
   * in-memory admission back: adopt the durable row if it committed,
   * roll back only once its absence is confirmed. If omitted, `record`
   * fails safe — it treats a rejected `started` persist as UNRESOLVABLE
   * uncertainty (never proven absent) and does NOT roll back, exactly the
   * same "leave it in memory, keep reporting the fault" behavior as when
   * reconciliation itself throws.
   */
  readonly reconcileStartedAdmission?: (replacementId: string) => Promise<ReplacementReceipt | null>;
}

interface EnsureObservation {
  readonly attemptId: string;
  readonly before: BrowserSurface | null;
  readonly preclaimed: ReplacementReceipt | null;
}

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
  return {
    ensureSurface: (request) => ensureSurfaceWithObservation(allocator, options, request),
    getSurfaceStatus: (surfaceId) => allocator.getSurfaceStatus(surfaceId),
    listSurfaces: () => allocator.listSurfaces(),
    stopSurface: (request) => stopSurfaceWithObservation(allocator, options, request),
  };
}

async function ensureSurfaceWithObservation(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest
): Promise<BrowserSurface> {
  const observation = await prepareEnsureObservation(allocator, options, request);
  const after = await performEnsureEffect(allocator, options, request, observation);
  // Bookkeeping only — never allowed to turn a real allocator success into
  // an apparent failure. See recordEnsureSuccessObserved's doc comment.
  await recordEnsureSuccessObserved(options, request, observation, after);
  return after;
}

async function prepareEnsureObservation(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
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
  const { attemptId, preclaimed } = await observePendingReplacement(options, request, before);
  return { attemptId, before, preclaimed };
}

async function observePendingReplacement(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  before: BrowserSurface | null
): Promise<{ attemptId: string; preclaimed: ReplacementReceipt | null }> {
  try {
    const attemptId = options.createEnsureAttemptId?.(request) ?? randomUUID();
    const advertisedReplacement = await startAdvertisedReplacement(options, request, before, attemptId);
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
  request: EnsureBrowserSurfaceRequest,
  observation: EnsureObservation
): Promise<BrowserSurface> {
  try {
    return await allocator.ensureSurface(request);
  } catch (error) {
    // Bookkeeping only — a failure recording THIS failure must never replace
    // or mask the real allocator error being rethrown below.
    await recordEnsureFailureBoundaryObserved(options, request, observation);
    throw error;
  }
}

async function recordEnsureFailureBoundaryObserved(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  observation: EnsureObservation
): Promise<void> {
  try {
    if (observation.preclaimed) {
      await recordTerminal(options, observation.preclaimed, "failed");
    } else {
      await recordEnsureFailure(options, request, observation.before, observation.attemptId);
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
  request: EnsureBrowserSurfaceRequest,
  observation: EnsureObservation,
  after: BrowserSurface
): Promise<void> {
  try {
    if (observation.preclaimed) {
      await recordPreclaimedEnsureResult(options, observation.preclaimed, observation.before, after);
      return;
    }
    await recordContainerTransition(options, request, observation.before, after, observation.attemptId);
  } catch (error) {
    reportPersistenceError(options, error);
  }
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

async function startAdvertisedReplacement(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  before: BrowserSurface | null,
  attemptId: string
): Promise<ReplacementReceipt | null> {
  if (!before?.container_id || before.allocator_metadata?.ensure_disposition !== "replace") {
    return null;
  }
  return await ensureReceipt(options, request, before, before.container_id, attemptId);
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

/**
 * Starts (attempts to durably admit) a replacement receipt for the given
 * surface. Returns `null` if the durable persist fails — see `record`'s
 * doc comment for why that means the receipt was never effectively
 * admitted at all, not merely "admitted but not yet resolved."
 */
function ensureReceipt(
  options: ReplacementObservingAllocatorOptions,
  request: EnsureBrowserSurfaceRequest,
  surface: BrowserSurface,
  previousContainerId: string,
  attemptId: string,
  nextContainerId?: string
): Promise<ReplacementReceipt | null> {
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
  const admitted = await record(options, started);
  // If `started` was never durably admitted (rolled back by `record`),
  // there is nothing to resolve — a receipt that was never effectively
  // created cannot be terminalized, and attempting to would either no-op
  // against the ledger (it has no started row for this replacement_id
  // anymore) or, worse, attempt to durably persist an orphan terminal.
  if (admitted) {
    await recordTerminal(options, admitted, "failed");
  }
}

/**
 * Resolves a `started` receipt to a terminal outcome. Unlike the prior
 * (2026-08-01 second gate revision) design, this performs NO non-durable
 * bookkeeping of its own: by the time any receipt reaches this function,
 * `ensureReceipt`/`startStopReceipt` already guaranteed (via `record`'s
 * transactional admission) that it is durably persisted, or that it was
 * rolled back and this function is never called for it at all (every
 * caller checks the `ReplacementReceipt | null` result of the start before
 * proceeding to a resolution). A durable terminal/completed receipt can
 * therefore never be orphaned with no `started` predecessor beneath it —
 * that invariant is enforced at admission time, not at resolution time,
 * so there is no parallel state to leak on any success or failure path.
 */
async function recordTerminal(
  options: ReplacementObservingAllocatorOptions,
  started: ReplacementReceipt,
  outcome: "failed" | "abandoned"
): Promise<void> {
  const terminated = options.ledger.terminate({
    connection_id: started.connection_id,
    profile_key: started.profile_key,
    replacement_id: started.replacement_id,
    ...(started.surface_subject_id ? { surface_subject_id: started.surface_subject_id } : {}),
    ...(started.surface_id ? { surface_id: started.surface_id } : {}),
    cause: started.cause,
    outcome,
  });
  await record(options, terminated);
}

async function stopSurfaceWithObservation(
  allocator: BrowserSurfaceAllocator,
  options: ReplacementObservingAllocatorOptions,
  request: StopBrowserSurfaceRequest
): Promise<BrowserSurface | null> {
  const before = await allocator.getSurfaceStatus(request.surfaceId);
  // Bookkeeping only — must never abort a real stopSurface call before the
  // allocator is even asked. Same masking hazard as ensureSurface's
  // observation step (see prepareEnsureObservation's doc comment).
  const started = await startStopReceiptObserved(options, before, request);
  try {
    return await allocator.stopSurface(request);
  } catch (error) {
    // Bookkeeping only — recording THIS failure must never replace or mask
    // the real allocator error being rethrown below (2026-08-01 gate
    // revision, Blocker 1: recordTerminal's ledger.terminate runs
    // synchronously, before record()'s own try/catch can intervene — a
    // throwing ledger, exactly like a throwing reporter, must not be able
    // to surface in place of the real stopSurface error).
    await recordStopFailureObserved(options, started);
    throw error;
  }
}

async function recordStopFailureObserved(
  options: ReplacementObservingAllocatorOptions,
  started: ReplacementReceipt | null
): Promise<void> {
  if (!started) {
    return;
  }
  try {
    await recordTerminal(options, started, "failed");
  } catch (error) {
    reportPersistenceError(options, error);
  }
}

async function startStopReceiptObserved(
  options: ReplacementObservingAllocatorOptions,
  before: BrowserSurface | null,
  request: StopBrowserSurfaceRequest
): Promise<ReplacementReceipt | null> {
  try {
    return await startStopReceipt(options, before, request);
  } catch (error) {
    reportPersistenceError(options, error);
    return null;
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
    cause,
    idempotency_key: `stop:${before.surface_id}:${deriveOpaqueGenerationHash(before.container_id)}:${cause}:${attemptId}`,
    previous_generation_hash: deriveOpaqueGenerationHash(before.container_id),
    surface_id: before.surface_id,
  });
  return record(options, started);
}

/**
 * Persists a replacement receipt via transactional admission (2026-08-01
 * third/fourth gate revisions — replaces a parallel "non-durable tracker"
 * design that required every resolution path to remember a cleanup step
 * and leaked on paths that never called it). This is durable bookkeeping
 * ABOUT an allocator operation, not the operation itself: a persistence
 * failure here must never propagate to callers observing an
 * ensureSurface/stopSurface call (2026-08-01 Amazon incident root cause).
 *
 * For a `started` receipt (the only phase `ledger.start` can produce,
 * which is also the only phase `ledger.discardUnresolvedStart` can roll
 * back), a REJECTED persist call is NOT proof the durable write never
 * happened (2026-08-01 fourth gate revision): both supported stores can
 * commit their INSERT and then throw during post-insert processing
 * (SQLite's post-insert re-read; Postgres's post-insert RETURNING-result
 * handling). Blindly rolling back on every rejection can therefore strand
 * a durable `started` row with no in-memory representation left to ever
 * resolve it — an orphan pending row that also permanently suppresses
 * later observations for its surface, since nothing durable ever confirms
 * whether it needs reconciling. `reconcileAfterUncertainPersistRejection`
 * resolves this UNKNOWN outcome authoritatively before any rollback
 * decision is made: adopt the durable row if the write actually committed
 * (the in-memory admission already agrees — nothing to change), roll back
 * only once durable absence is CONFIRMED. If reconciliation is unavailable
 * or itself fails, the safe default is to NOT roll back (leave the receipt
 * in memory, keep reporting the fault) — the destructive action
 * (`discardUnresolvedStart`) never runs on unresolved uncertainty.
 *
 * For a `terminal`/`completed` receipt, there is no analogous rollback: an
 * in-memory resolution of an already-durably-admitted `started` receipt is
 * valid regardless of whether ITS OWN durable write succeeds (the ledger's
 * own `hasResolution`/pending-lookup logic already reflects the correct
 * in-memory truth), so a persist failure here is reported and the
 * unresolved-but-in-memory-resolved receipt is returned unchanged.
 */
async function record(
  options: ReplacementObservingAllocatorOptions,
  receipt: ReplacementReceipt
): Promise<ReplacementReceipt | null> {
  try {
    return await (options.persist ?? (async (value: ReplacementReceipt) => value))(receipt);
  } catch (error) {
    reportPersistenceError(options, error);
    if (receipt.phase !== "started") {
      return receipt;
    }
    return await reconcileAfterUncertainPersistRejection(options, receipt);
  }
}

/**
 * Authoritatively resolves whether a rejected `started` persist call
 * actually committed durably before deciding whether to roll the
 * in-memory admission back. See `record`'s doc comment for why a rejection
 * alone cannot answer this. Every branch is fail-safe toward NOT rolling
 * back: only a durably-CONFIRMED-absent result triggers
 * `discardUnresolvedStart`.
 */
async function reconcileAfterUncertainPersistRejection(
  options: ReplacementObservingAllocatorOptions,
  receipt: ReplacementReceipt
): Promise<ReplacementReceipt | null> {
  if (!options.reconcileStartedAdmission) {
    // No authoritative reconciliation available: the outcome remains
    // genuinely unknown, so the safe default is to leave the in-memory
    // admission exactly as `ledger.start` created it — never invent a
    // "confirmed absent" verdict this function has no way to prove.
    return receipt;
  }
  let durable: ReplacementReceipt | null;
  try {
    durable = await options.reconcileStartedAdmission(receipt.replacement_id);
  } catch (error) {
    // Reconciliation itself failed: still unresolved, still not a proven
    // absence — fail safe the same way as "no reconciliation available".
    reportPersistenceError(options, error);
    return receipt;
  }
  if (durable) {
    // The write actually committed (commit-then-reject): the in-memory
    // admission already agrees with the durable row (both were produced
    // from the same `ledger.start` call) — nothing to roll back, nothing
    // to change. Returning the in-memory receipt (not the durable read)
    // keeps object identity stable for callers that compare it structurally.
    return receipt;
  }
  // Durable absence is now CONFIRMED (not merely assumed from a rejection)
  // — safe to roll the in-memory admission back out of the ledger.
  options.ledger.discardUnresolvedStart(receipt.replacement_id);
  return null;
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
    cause: "allocator_internal_ensure_surface",
    connection_id: input.surface_subject_id ?? input.connector_id,
    connector_id: input.connector_id,
    profile_key: input.profile_key,
    ...(input.surface_subject_id === undefined ? {} : { surface_subject_id: input.surface_subject_id }),
    ...(input.surface_id === undefined ? {} : { surface_id: input.surface_id }),
  };
  return result;
}
