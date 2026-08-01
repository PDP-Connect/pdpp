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
   * (2026-08-01 fourth/fifth gate revisions): `persist` can commit its
   * durable write and THEN reject — SQLite's post-insert re-read and
   * Postgres's post-insert RETURNING-result handling can both throw after
   * the row is already durably committed. A rejected `started`-phase
   * `persist` call is therefore an UNKNOWN outcome, not proof of
   * non-commit. This is called with the receipt's `replacement_id` to
   * authoritatively resolve that uncertainty: adopt the durable row if it
   * committed, roll back once its absence is confirmed, or — if omitted,
   * or if this itself throws — mark the receipt as ledger-owned UNKNOWN
   * admission state via `ledger.markStartedAdmissionUnknown`. An unknown
   * receipt is never treated as ordinary pending state (cannot suppress a
   * later real observation) and is never resolved (terminate/complete
   * refuses it) until a later bounded reconciliation attempt before a
   * same-scope observation adopts or discards it.
   */
  readonly reconcileStartedAdmission?: (replacementId: string) => Promise<ReplacementReceipt | null>;
}

interface EnsureObservation {
  readonly attemptId: string;
  readonly before: BrowserSurface | null;
  readonly preclaimed: ReplacementReceipt | null;
}

interface ReplacementAdmissionScope {
  readonly connectionId: string;
  readonly profileKey: string;
  readonly surfaceSubjectId?: string;
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
    await reconcileUnknownAdmissionForScope(options, admissionScopeForRequest(request));
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
  // Dedup ONLY against a pending receipt for THIS EXACT transition
  // (matching the idempotency-key prefix `ensure:<surfaceId>:<prevHash><nextHash>:`
  // that `ensureReceipt` derives below from the same previous/next
  // container ids — a `started` receipt never carries a
  // `next_generation_hash` field, so the idempotency key is the only
  // stable place both sides of the transition are recorded together) —
  // not against any prior unresolved receipt for the surface.
  // Container-transition receipts are fire-and-forget observability
  // records this module never resolves (unlike a preclaimed advertised
  // replacement, which IS resolved via recordPreclaimedEnsureResult), so
  // an OLDER transition's receipt staying unresolved forever must never
  // block recording a genuinely NEW, distinct transition — otherwise only
  // the very first observed transition for a surface's whole lifetime
  // would ever get an audit receipt (2026-08-01 fifth gate revision: this
  // was the exact mechanism behind "three later successful rotations
  // produce only one persist attempt", independent of the
  // admission-uncertainty bug this revision also fixes — a stuck
  // unknown-admission receipt merely made the pre-existing surface-wide
  // block trigger on the very first attempt instead of the second).
  const transitionKeyPrefix = ensureTransitionIdempotencyKeyPrefix(
    after.surface_id,
    previousContainerId,
    after.container_id
  );
  const existing = await pendingForTransition(options, after.surface_id, transitionKeyPrefix);
  if (existing) {
    return;
  }
  await ensureReceipt(options, request, after, previousContainerId, attemptId, after.container_id);
}

function ensureTransitionIdempotencyKeyPrefix(
  surfaceId: string,
  previousContainerId: string,
  nextContainerId: string
): string {
  const previousHash = deriveOpaqueGenerationHash(previousContainerId);
  const nextHash = `:${deriveOpaqueGenerationHash(nextContainerId)}`;
  return `ensure:${surfaceId}:${previousHash}${nextHash}:`;
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
  const started = options.ledger.admitStart({
    ...correlation({
      connector_id: request.connectorId,
      profile_key: request.profileKey,
      ...(request.surfaceSubjectId ? { surface_subject_id: request.surfaceSubjectId } : {}),
      surface_id: surface.surface_id,
    }),
    idempotency_key: `ensure:${surface.surface_id}:${previousHash}${nextHash}:${attemptId}`,
    previous_generation_hash: previousHash,
  });
  // `admitStart` returns null when a DIFFERENT unresolved unknown admission
  // already owns this connection/profile/surface-subject scope — a bounded
  // recovery policy (2026-08-01 sixth gate revision) that stops a
  // continuous run of outages from minting one new unknown receipt per
  // rotation forever. This is audit-receipt bookkeeping only: the real
  // allocator effect above has already happened and is returned to the
  // caller regardless.
  return started ? record(options, started) : Promise.resolve(null);
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
  const started = options.ledger.admitStart({
    ...correlation({
      connector_id: request.connectorId,
      profile_key: request.profileKey,
      surface_id: request.surfaceId,
    }),
    idempotency_key: `ensure-failed:${request.surfaceId}:${deriveOpaqueGenerationHash(before.container_id)}:${attemptId}`,
    previous_generation_hash: deriveOpaqueGenerationHash(before.container_id),
  });
  // Same bounded scope gate as `ensureReceipt`: a different unresolved
  // unknown admission already owns this scope, so no new receipt is
  // admitted — the real ensureSurface failure this records was already
  // rethrown to the caller by `performEnsureEffect` regardless.
  const admitted = started ? await record(options, started) : null;
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
 * bookkeeping of its own: `record` has either durably admitted the start,
 * confirmed its absence and returned `null`, or marked it ledger-owned
 * UNKNOWN. The ledger rejects resolution for UNKNOWN, so this function can
 * only append a terminal receipt beneath a durably admitted start. A
 * durable terminal/completed receipt can therefore never be orphaned with
 * no `started` predecessor beneath it — that invariant is enforced at
 * admission time, not by a parallel cleanup tracker.
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
    if (before) {
      await reconcileUnknownAdmissionForScope(options, admissionScopeForSurface(before));
    }
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
  const started = options.ledger.admitStart({
    connection_id: before.surface_subject_id ?? before.connector_id,
    connector_id: before.connector_id,
    profile_key: before.profile_key,
    ...(before.surface_subject_id ? { surface_subject_id: before.surface_subject_id } : {}),
    cause,
    idempotency_key: `stop:${before.surface_id}:${deriveOpaqueGenerationHash(before.container_id)}:${cause}:${attemptId}`,
    previous_generation_hash: deriveOpaqueGenerationHash(before.container_id),
    surface_id: before.surface_id,
  });
  // Same bounded scope gate as `ensureReceipt`: this runs before the real
  // `stopSurface` call but only as bookkeeping preparation — its caller
  // (`startStopReceiptObserved`) already tolerates any failure here without
  // blocking the real allocator call.
  return started ? record(options, started) : Promise.resolve(null);
}

/**
 * Persists a replacement receipt via transactional admission (2026-08-01
 * third/fourth/fifth gate revisions — replaces a parallel "non-durable
 * tracker" design that required every resolution path to remember a
 * cleanup step and leaked on paths that never called it). This is durable
 * bookkeeping ABOUT an allocator operation, not the operation itself: a
 * persistence failure here must never propagate to callers observing an
 * ensureSurface/stopSurface call (2026-08-01 Amazon incident root cause).
 *
 * For a `started` receipt (the only phase `ledger.start` can produce), a
 * REJECTED persist call is NOT proof the durable write never happened
 * (2026-08-01 fourth gate revision): both supported stores can commit
 * their INSERT and then throw during post-insert processing (SQLite's
 * post-insert re-read; Postgres's post-insert RETURNING-result handling).
 * `reconcileAfterUncertainPersistRejection` resolves this outcome
 * authoritatively: DURABLE (adopt — `ledger.adoptConfirmedStart`, nothing
 * to change), ABSENT (confirmed — `ledger.discardUnresolvedStart`, roll
 * back), or still UNKNOWN (reconciliation unavailable or itself failed —
 * `ledger.markStartedAdmissionUnknown`). Marking UNKNOWN is
 * ledger-OWNED state, not a caller-side tracker (2026-08-01 fifth gate
 * revision — the prior fix returned the volatile in-memory receipt
 * unchanged on an unresolved outcome, which an ordinary pending lookup's
 * `isPendingForSurface` check could not distinguish from a genuinely
 * durable pending claim, so it silently suppressed every later real
 * observation for that scope forever). The preparation boundary retries
 * reconciliation before a later same-scope observation can be blocked or
 * resolved by it.
 *
 * For a `terminal`/`completed` receipt, there is no analogous rollback: an
 * in-memory resolution of an already-durably-admitted `started` receipt is
 * valid regardless of whether ITS OWN durable write succeeds, so a persist
 * failure here is reported and the receipt is returned unchanged.
 */
async function record(
  options: ReplacementObservingAllocatorOptions,
  receipt: ReplacementReceipt
): Promise<ReplacementReceipt | null> {
  try {
    const persisted = await (options.persist ?? (async (value: ReplacementReceipt) => value))(receipt);
    // A same-idempotency-key retry of a `started` receipt that a prior
    // attempt already marked ledger-owned UNKNOWN (2026-08-01 sixth gate
    // revision) replays the SAME in-memory receipt (`ledger.start`'s
    // append-time idempotency replay) — so a persist success here proves
    // the durable write now committed and the id must be adopted, exactly
    // like a reconciliation-confirmed durable row. Not doing this left the
    // receipt marked unknown forever even after it demonstrably persisted.
    if (persisted.phase === "started" && options.ledger.isAdmissionUnknown(persisted.replacement_id)) {
      options.ledger.adoptConfirmedStart(persisted.replacement_id);
    }
    return persisted;
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
 * actually committed durably. Every branch either adopts (durable),
 * discards (confirmed absent), or explicitly marks the receipt as
 * ledger-owned UNKNOWN admission state — never silently leaves it
 * indistinguishable from an ordinary durable pending claim. See
 * `record`'s doc comment for the full rationale.
 */
async function reconcileAfterUncertainPersistRejection(
  options: ReplacementObservingAllocatorOptions,
  receipt: ReplacementReceipt
): Promise<ReplacementReceipt | null> {
  if (!options.reconcileStartedAdmission) {
    options.ledger.markStartedAdmissionUnknown(receipt.replacement_id);
    return receipt;
  }
  let durable: ReplacementReceipt | null;
  try {
    durable = await options.reconcileStartedAdmission(receipt.replacement_id);
  } catch (error) {
    // Reconciliation itself failed: still unresolved, still not a proven
    // absence — mark it unknown rather than silently leaving it
    // indistinguishable from a durable pending claim.
    reportPersistenceError(options, error);
    options.ledger.markStartedAdmissionUnknown(receipt.replacement_id);
    return receipt;
  }
  if (durable) {
    // The write actually committed (commit-then-reject): adopt it —
    // nothing to roll back, nothing to change. Returning the in-memory
    // receipt (not the durable read) keeps object identity stable for
    // callers that compare it structurally.
    options.ledger.adoptConfirmedStart(receipt.replacement_id);
    return receipt;
  }
  // Durable absence is now CONFIRMED (not merely assumed from a rejection)
  // — safe to roll the in-memory admission back out of the ledger.
  options.ledger.discardUnresolvedStart(receipt.replacement_id);
  return null;
}

/**
 * Finds a pending `started` receipt for the EXACT transition (matching the
 * idempotency-key prefix `ensure:<surfaceId>:<prevHash><nextHash>:` that
 * `ensureReceipt` derives from the same previous/next container ids — a
 * `started` receipt never carries a populated `next_generation_hash`
 * field, since that column is only set by `ledger.complete()`, so the
 * idempotency key is the only place both sides of the transition are
 * recorded together) on a surface. The preparation boundary already makes
 * one bounded reconciliation attempt for the same scope. If that durable
 * read remains transiently unavailable, an unknown admission is excluded
 * here and fails open rather than blocking this new observation.
 *
 * Scoped to the exact transition, not "any pending receipt for this
 * surface at all" (2026-08-01 fifth gate revision — see
 * `recordContainerTransition`'s doc comment): an older, distinct
 * transition's receipt is intentionally left unresolved forever by this
 * module and must never block recording a genuinely new, different
 * transition. Falls back to `options.findPending` (a broader, durable
 * "any pending receipt for this surface" lookup — unchanged since before
 * this revision) only when nothing matches in memory, to still catch a
 * still-pending durable receipt for this exact transition that predates
 * an in-process restart; a durable match for a DIFFERENT transition is
 * ignored, for the same reason an in-memory one is.
 */
async function pendingForTransition(
  options: ReplacementObservingAllocatorOptions,
  surfaceId: string,
  idempotencyKeyPrefix: string
): Promise<ReplacementReceipt | null> {
  const inMemory = findPendingTransitionInMemory(options.ledger, surfaceId, idempotencyKeyPrefix);
  if (inMemory) {
    return inMemory;
  }
  const durable = await (options.findPending?.(surfaceId) ?? Promise.resolve(null));
  return durable?.idempotency_key.startsWith(idempotencyKeyPrefix) ? durable : null;
}

async function reconcileUnknownAdmissionForScope(
  options: ReplacementObservingAllocatorOptions,
  scope: ReplacementAdmissionScope
): Promise<void> {
  if (!options.reconcileStartedAdmission) {
    return;
  }
  // One exact-ID read per observation bounds bookkeeping work even if the
  // durable store stays transiently unreadable. Unknown admissions fail
  // open, so the remaining entries cannot suppress this observation; a
  // later observation retries this oldest unresolved entry.
  const [unknown] = options.ledger
    .list()
    .filter(
      (receipt) =>
        receipt.phase === "started" &&
        isInAdmissionScope(receipt, scope) &&
        options.ledger.isAdmissionUnknown(receipt.replacement_id)
    )
    .sort((left, right) => left.event_seq - right.event_seq);
  if (unknown) {
    await reconcileKnownUnknownAdmission(options, unknown);
  }
}

async function reconcileKnownUnknownAdmission(
  options: ReplacementObservingAllocatorOptions,
  receipt: ReplacementReceipt
): Promise<void> {
  if (!options.reconcileStartedAdmission) {
    return;
  }
  let durable: ReplacementReceipt | null;
  try {
    durable = await options.reconcileStartedAdmission(receipt.replacement_id);
  } catch (error) {
    // Still unresolved — remains marked unknown for a future attempt.
    reportPersistenceError(options, error);
    return;
  }
  if (durable) {
    options.ledger.adoptConfirmedStart(receipt.replacement_id);
  } else {
    options.ledger.discardUnresolvedStart(receipt.replacement_id);
  }
}

function findPendingTransitionInMemory(
  ledger: ReplacementObservingAllocatorOptions["ledger"],
  surfaceId: string,
  idempotencyKeyPrefix: string
): ReplacementReceipt | null {
  const receipts = ledger.list();
  return (
    receipts
      .filter(
        (receipt) =>
          isPendingForSurface(receipt, receipts, surfaceId) &&
          !ledger.isAdmissionUnknown(receipt.replacement_id) &&
          receipt.idempotency_key.startsWith(idempotencyKeyPrefix)
      )
      .sort(compareReceipts)[0] ?? null
  );
}

function admissionScopeForRequest(request: EnsureBrowserSurfaceRequest): ReplacementAdmissionScope {
  return {
    connectionId: request.surfaceSubjectId ?? request.connectorId,
    profileKey: request.profileKey,
    ...(request.surfaceSubjectId ? { surfaceSubjectId: request.surfaceSubjectId } : {}),
  };
}

function admissionScopeForSurface(surface: BrowserSurface): ReplacementAdmissionScope {
  return {
    connectionId: surface.surface_subject_id ?? surface.connector_id,
    profileKey: surface.profile_key,
    ...(surface.surface_subject_id ? { surfaceSubjectId: surface.surface_subject_id } : {}),
  };
}

function isInAdmissionScope(receipt: ReplacementReceipt, scope: ReplacementAdmissionScope): boolean {
  return (
    receipt.connection_id === scope.connectionId &&
    receipt.profile_key === scope.profileKey &&
    receipt.surface_subject_id === scope.surfaceSubjectId
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
