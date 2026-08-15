// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded reconcile of scope-keyed search-index dirty flags
 * (search_index_dirty, see stores/search-index-dirty-store.ts).
 *
 * For each dirty (connector_instance_id, stream) scope, this re-runs the
 * EXISTING exact-comparison drift-check + idempotent rebuild-if-needed for
 * both index kinds (search.ts's lexicalIndexBackfillForManifest,
 * search-semantic.ts's semanticIndexBackfillForManifest), scoped to that one
 * connector instance via `storage_binding.connector_instance_id` -- the same
 * mechanism production owner-bound manifests already use to pin backfill
 * scope. Both backfills are already correctness-proven no-ops when the
 * scope is actually in sync (I2's fix makes the semantic comparison exact;
 * the lexical comparison was already exact), so calling them unconditionally
 * for a dirty scope is cheap in the common case and a real (bounded, per-
 * connector) rebuild only when something is actually missing.
 *
 * A scope's dirty flag is cleared ONLY after both backfills complete
 * without throwing for that scope -- clearing does not mean "we found and
 * fixed drift," it means "we checked and there is none left, or we just
 * fixed what there was." A thrown error leaves the flag set and records
 * structured evidence (I6) instead of only a console.warn line.
 */

import { getOne } from "../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";
import { referenceQueries } from "./queries/index.ts";
import { lexicalIndexBackfillForManifest } from "./search.ts";
import { getSemanticBackend, semanticIndexBackfillForManifest } from "./search-semantic.ts";
import { currentStorageGeneration, isCurrentStorageGeneration } from "./storage-generation.ts";
import {
  clearSearchIndexDirty,
  countDirtySearchIndexScopes,
  type DirtySearchIndexScope,
  listDirtySearchIndexScopes,
  recordSearchIndexDirtyFailure,
} from "./stores/search-index-dirty-store.ts";

interface ConnectorManifestRow {
  manifest: string | Record<string, unknown>;
}

type LexicalBackfillOptions = Parameters<typeof lexicalIndexBackfillForManifest>[0];
type SemanticBackfillOptions = Parameters<typeof semanticIndexBackfillForManifest>[0];

async function getRegisteredManifestById(connectorId: string): Promise<Record<string, unknown> | null> {
  if (isPostgresStorageBackend()) {
    const {
      rows: [row],
    } = await postgresQuery<ConnectorManifestRow>("SELECT manifest FROM connectors WHERE connector_id = $1", [
      connectorId,
    ]);
    if (!row) {
      return null;
    }
    return typeof row.manifest === "string" ? safeParseManifest(row.manifest) : row.manifest;
  }
  const row = getOne<ConnectorManifestRow>(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (!row?.manifest) {
    return null;
  }
  return typeof row.manifest === "string" ? safeParseManifest(row.manifest) : row.manifest;
}

function safeParseManifest(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function declaresSemanticFields(manifestStream: Record<string, unknown>): boolean {
  const query = manifestStream.query as { search?: { semantic_fields?: unknown } } | undefined;
  const fields = query?.search?.semantic_fields;
  return Array.isArray(fields) && fields.length > 0;
}

/**
 * `converged`: the clear's revision CAS applied -- this scope's index was
 * proven in sync and no write raced past the check.
 * `recontended`: the backfills themselves threw nothing, but the clear's
 * revision CAS was a no-op -- a concurrent write re-dirtied this scope
 * AFTER this round read it and BEFORE the clear ran, so the fresh mark
 * correctly survives. This is NOT a reconcile failure: nothing was proven
 * wrong, the scope just needs another round to check the newer state. It
 * must not be counted or evidenced the same as `failed`, which reflects the
 * backfills/storage-fence themselves throwing.
 * `failed`: a backfill or the storage-generation fence threw; structured
 * failure evidence was recorded (or dropped as a lifecycle race) and the
 * scope's dirty flag is left untouched.
 */
export type ReconcileScopeOutcome = "converged" | "failed" | "recontended";

export interface ReconcileScopeResult {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly outcome: ReconcileScopeOutcome;
  readonly stream: string;
}

/** Thrown by the fence gate inside reconcileSearchIndexDirtyScope/runScopeBackfills to short-circuit to a dropped-work outcome. */
class ScopeStorageGenerationStaleError extends Error {}

function assertStorageGenerationCurrent(generation: number): void {
  if (!isCurrentStorageGeneration(generation)) {
    throw new ScopeStorageGenerationStaleError();
  }
}

/**
 * Runs both backfills for one already-resolved (manifest, targetStream)
 * pair, pinned to this exact connector instance, then clears the scope's
 * dirty flag. Extracted from reconcileSearchIndexDirtyScope specifically to
 * keep the generation-fence recheck sequence (one call per storage-touching
 * step, see that function's doc comment) at a shallower nesting depth than
 * the manifest/stream resolution it runs after.
 */
async function runScopeBackfills(
  scope: DirtySearchIndexScope,
  manifest: Record<string, unknown>,
  targetStream: Record<string, unknown>,
  generation: number
): Promise<ReconcileScopeResult> {
  const { connectorId, connectorInstanceId, stream } = scope;
  // Narrowed to the ONE dirty stream, not the whole manifest: the
  // maintenance-sweep addendum flagged that the underlying backfill loops
  // have no wall-clock deadline of their own, so bounding the manifest to
  // exactly the stream that needs checking keeps one reconcile round's
  // worst case proportional to one stream's drift-check, not every stream
  // this connector declares.
  const pinnedManifest = {
    ...manifest,
    connector_id: connectorId,
    storage_binding: { connector_instance_id: connectorInstanceId },
    streams: [targetStream],
  };

  await lexicalIndexBackfillForManifest({ manifest: pinnedManifest } as unknown as LexicalBackfillOptions);
  assertStorageGenerationCurrent(generation);

  // Distinguish "this stream does not declare semantic_fields" (semantic
  // participation was never configured here -- clearing is correct, there
  // is nothing to prove) from "this stream DOES declare semantic_fields but
  // no server-wide backend is currently configured" (review-flagged gap:
  // getSemanticBackend() returning null here could mean semantic retrieval
  // is intentionally disabled for the whole server, OR that the backend is
  // temporarily unavailable/warming -- either way, clearing the combined
  // dirty flag in that case would silently declare "semantic is in sync"
  // for a scope whose semantic index was never actually checked,
  // permanently dropping pending proof). When semantic is configured for
  // this stream but no backend exists right now, this reconcile only
  // proves LEXICAL is in sync; the semantic half stays unproven and the
  // flag is deliberately left set (with distinct evidence, not a generic
  // failure) so a later attempt -- once a backend exists -- still gets a
  // chance to actually check it.
  const semanticFieldsDeclared = declaresSemanticFields(targetStream);
  const semanticBackend = getSemanticBackend();
  if (semanticFieldsDeclared && !semanticBackend) {
    await recordSearchIndexDirtyFailure(
      { connectorInstanceId, stream },
      "semantic_fields is declared for this stream but no semantic backend is currently configured; semantic sync is unproven, dirty flag retained"
    );
    return { connectorId, connectorInstanceId, outcome: "failed", stream };
  }
  if (semanticBackend) {
    await semanticIndexBackfillForManifest({ manifest: pinnedManifest } as unknown as SemanticBackfillOptions);
    assertStorageGenerationCurrent(generation);
  }

  // CAS on scope.revision (captured when this round listed the scope,
  // before either backfill ran), NOT scope.markedAt: two durable marks
  // within the same millisecond can share an identical marked_at string,
  // but revision is atomically incremented exactly once per mark and can
  // never collide. If a concurrent write re-dirtied this scope mid-scan,
  // revision has since advanced and this clear is a deliberate no-op --
  // the fresh dirty mark survives for the next round instead of being
  // silently discarded. This is `recontended`, NOT `failed`: the scans
  // above may well have converged everything they saw, just not the write
  // that raced past them, so no failure evidence is recorded and the
  // scope's existing backoff state is left untouched.
  const cleared = await clearSearchIndexDirty(
    { connectorInstanceId, stream },
    scope.revision,
    new Date().toISOString()
  );
  return { connectorId, connectorInstanceId, outcome: cleared ? "converged" : "recontended", stream };
}

/**
 * Reconcile ONE dirty scope: re-run both backfills pinned to this exact
 * connector instance, then clear the flag on success or record structured
 * failure evidence and leave it set on error.
 *
 * Storage-lifecycle fence (server/storage-generation.ts): `generation` is
 * captured by the caller at round-start. `assertStorageGenerationCurrent`
 * re-checks it before every storage-touching step below (and inside
 * runScopeBackfills). Like every other fence check in this codebase (see
 * withIndexWork's identical caveat in records.ts), this proves the
 * generation was still current at the moment of that check -- it does NOT
 * protect the awaits inside lexicalIndexBackfillForManifest/
 * semanticIndexBackfillForManifest themselves; storage can still close
 * mid-call between two of THEIR internal awaits. What this closes is the
 * previously-completely-unfenced gap (this file never checked the
 * generation at all) for the common shutdown/teardown race, not a
 * guarantee against every possible interleaving. A mismatch at any gate
 * means the work is dropped silently: the scope's dirty flag is left
 * untouched (never cleared, no failure evidence written) and converges on
 * the NEW generation's own reconcile, same as any other dropped deferred
 * job.
 */
export async function reconcileSearchIndexDirtyScope(
  scope: DirtySearchIndexScope,
  generation: number = currentStorageGeneration()
): Promise<ReconcileScopeResult> {
  const { connectorId, connectorInstanceId, stream } = scope;
  try {
    assertStorageGenerationCurrent(generation);
    const manifest = await getRegisteredManifestById(connectorId);
    assertStorageGenerationCurrent(generation);
    const manifestStreams = Array.isArray(manifest?.streams) ? (manifest.streams as Record<string, unknown>[]) : null;
    const targetStream = manifestStreams?.find((candidate) => candidate?.name === stream) ?? null;
    if (!(manifest && targetStream)) {
      // Connector no longer registered, or this stream is no longer
      // declared in its manifest: nothing to reconcile against. Clear the
      // flag -- there is no drift-check that can ever run for a stream that
      // does not exist in the current manifest, and leaving dirty=1 forever
      // would keep this scope in every future sweep for no actionable
      // reason. lexicalIndexBackfillForManifest/semanticIndexBackfillForManifest
      // already handle "declared before, not declared now" cleanup via
      // their own manifest-driven sweeps; this only short-circuits THIS
      // scope's flag. CAS'd on scope.revision for the same reason as
      // runScopeBackfills' clear (see that comment): a write racing in
      // between this round's listing and this decision must not have its
      // fresh dirty mark silently discarded, and revision -- not markedAt
      // -- is the token that can prove that reliably.
      const cleared = await clearSearchIndexDirty(
        { connectorInstanceId, stream },
        scope.revision,
        new Date().toISOString()
      );
      return { connectorId, connectorInstanceId, outcome: cleared ? "converged" : "recontended", stream };
    }
    return await runScopeBackfills(scope, manifest, targetStream, generation);
  } catch (err) {
    if (err instanceof ScopeStorageGenerationStaleError || !isCurrentStorageGeneration(generation)) {
      // The failure itself may BE storage having closed mid-flight; writing
      // evidence would touch a different generation's table under the same
      // scope key. Matches scheduleRecordIndexMaintenance's identical
      // re-check in records.ts.
      return { connectorId, connectorInstanceId, outcome: "failed", stream };
    }
    const message = err instanceof Error ? err.message : String(err);
    await recordSearchIndexDirtyFailure({ connectorInstanceId, stream }, message).catch(() => {
      // Evidence write is itself best-effort; never mask the original failure.
    });
    return { connectorId, connectorInstanceId, outcome: "failed", stream };
  }
}

export interface SearchIndexDirtyReconcileRoundResult {
  readonly attempted: number;
  readonly failed: number;
  readonly incomplete: boolean;
  /**
   * A scope whose clear CAS was a no-op because a concurrent write
   * re-dirtied it between this round's listing and its clear (see
   * ReconcileScopeOutcome's `recontended` case). Counted separately from
   * `failed`: nothing was proven wrong for these scopes, they simply need
   * another round to check the newer state their own write already
   * re-flagged. Folding this into `failed` would misreport ordinary,
   * expected contention as a reconcile defect.
   */
  readonly recontended: number;
  readonly succeeded: number;
}

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_DURATION_MS = 2000;

/**
 * One bounded reconcile round: page through currently-dirty scopes
 * (oldest-first), reconcile each within a wall-clock deadline, and report
 * how many were attempted/succeeded/failed. `incomplete: true` means more
 * dirty scopes existed than this round's page/time budget allowed --
 * exactly the maxDurationMs/page-bound shape the connector-summary
 * maintenance sweep already uses (addendum-flagged gap in the prior
 * backfill passes, which have no wall-clock deadline at all).
 */
export async function runSearchIndexDirtyReconcileRound(options?: {
  readonly maxDurationMs?: number;
  readonly pageSize?: number;
}): Promise<SearchIndexDirtyReconcileRoundResult> {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  const deadline = Date.now() + (options?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
  // Storage-lifecycle fence: captured ONCE for the whole round. Every scope
  // in this round re-checks against this same captured value (not a fresh
  // currentStorageGeneration() read per scope) so a storage close/reinit
  // partway through a round consistently drops the REST of that round
  // rather than silently resuming against a new, unrelated handle.
  const generation = currentStorageGeneration();
  const scopes = await listDirtySearchIndexScopes(pageSize);

  const outcomeCounts: Record<ReconcileScopeOutcome, number> = {
    converged: 0,
    failed: 0,
    recontended: 0,
  };
  let incomplete = false;
  let attempted = 0;

  for (const scope of scopes) {
    if (Date.now() >= deadline || !isCurrentStorageGeneration(generation)) {
      incomplete = true;
      break;
    }
    attempted += 1;
    // biome-ignore lint/performance/noAwaitInLoops: Bounded round; each scope's reconcile is independent but sequential to keep this sweep's DB load predictable.
    const result = await reconcileSearchIndexDirtyScope(scope, generation);
    outcomeCounts[result.outcome] += 1;
  }

  return {
    attempted,
    failed: outcomeCounts.failed,
    incomplete: incomplete || scopes.length >= pageSize,
    recontended: outcomeCounts.recontended,
    succeeded: outcomeCounts.converged,
  };
}

// ---------------------------------------------------------------------------
// Read-time self-heal (I3) -- mirrors buildAutoReconciledRetainedSizeProjection
// (routes/ref-dataset.ts) in spirit (a cheap check + cooldown gate at read
// time accelerates convergence beyond the periodic sweep's own tick), but is
// DELIBERATELY NON-BLOCKING here where that pattern is not: a single dirty
// scope's lexical/semantic backfill has no internal wall-clock bound (only
// runSearchIndexDirtyReconcileRound's deadline check runs BETWEEN scopes,
// never within one), so a search request that awaited this could hang for
// an unbounded duration. A search request must never await an unbounded
// reconcile -- this fires a bounded round in the background and returns
// immediately, every time, regardless of outcome.
//
// In-flight dedup (not just a cooldown) matters here specifically because
// this is now fire-and-forget: without it, N concurrent requests arriving
// while a backlog exists would each launch their own background reconcile
// round, multiplying DB load with no benefit (they would all converge the
// same handful of oldest-dirty scopes). Cooldown-after-failure still
// applies on top, exactly as before, to rate-limit repeated attempts
// against a systemically failing reconcile path.
// ---------------------------------------------------------------------------

const SEARCH_INDEX_DIRTY_AUTO_RECONCILE_FAILURE_COOLDOWN_MS = 30_000;
let searchIndexDirtyAutoReconcileRetryAfterMs = 0;
let searchIndexDirtySelfHealInFlight: Promise<void> | null = null;

function searchIndexDirtyAutoReconcileNow(): number {
  return Date.now();
}

function searchIndexDirtyAutoReconcileInCooldown(): boolean {
  return searchIndexDirtyAutoReconcileNow() < searchIndexDirtyAutoReconcileRetryAfterMs;
}

async function runSelfHealAttempt(): Promise<void> {
  const dirtyCount = await countDirtySearchIndexScopes().catch(() => 0);
  if (dirtyCount === 0) {
    return;
  }
  try {
    await runSearchIndexDirtyReconcileRound({ maxDurationMs: 250, pageSize: 5 });
    searchIndexDirtyAutoReconcileRetryAfterMs = 0;
  } catch {
    searchIndexDirtyAutoReconcileRetryAfterMs =
      searchIndexDirtyAutoReconcileNow() + SEARCH_INDEX_DIRTY_AUTO_RECONCILE_FAILURE_COOLDOWN_MS;
  }
}

/**
 * Call once near the top of a search request handler, before running the
 * actual search. Fire-and-forget: returns `void` synchronously, never a
 * Promise, so it cannot be mistakenly awaited. If a self-heal attempt is
 * already in flight, or the cooldown after a recent failure has not
 * elapsed, this is a pure no-op. The search itself proceeds against
 * whatever the index currently has, same as any read between two periodic
 * sweep ticks -- this only accelerates convergence, it is never on the
 * critical path of the response.
 */
export function triggerSearchIndexDirtySelfHeal(): void {
  if (searchIndexDirtySelfHealInFlight || searchIndexDirtyAutoReconcileInCooldown()) {
    return;
  }
  const attempt = runSelfHealAttempt().finally(() => {
    if (searchIndexDirtySelfHealInFlight === attempt) {
      searchIndexDirtySelfHealInFlight = null;
    }
  });
  searchIndexDirtySelfHealInFlight = attempt;
}
