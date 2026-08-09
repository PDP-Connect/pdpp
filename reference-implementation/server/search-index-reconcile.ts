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

export interface ReconcileScopeResult {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ok: boolean;
  readonly stream: string;
}

/**
 * Reconcile ONE dirty scope: re-run both backfills pinned to this exact
 * connector instance, then clear the flag on success or record structured
 * failure evidence and leave it set on error.
 */
export async function reconcileSearchIndexDirtyScope(scope: DirtySearchIndexScope): Promise<ReconcileScopeResult> {
  const { connectorId, connectorInstanceId, stream } = scope;
  try {
    const manifest = await getRegisteredManifestById(connectorId);
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
      // scope's flag.
      await clearSearchIndexDirty({ connectorInstanceId, stream }, new Date().toISOString());
      return { connectorId, connectorInstanceId, ok: true, stream };
    }
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

    // Distinguish "this stream does not declare semantic_fields" (semantic
    // participation was never configured here -- clearing is correct, there
    // is nothing to prove) from "this stream DOES declare semantic_fields
    // but no server-wide backend is currently configured" (review-flagged
    // gap: getSemanticBackend() returning null here could mean semantic
    // retrieval is intentionally disabled for the whole server, OR that the
    // backend is temporarily unavailable/warming -- either way, clearing
    // the combined dirty flag in that case would silently declare "semantic
    // is in sync" for a scope whose semantic index was never actually
    // checked, permanently dropping pending proof). When semantic is
    // configured for this stream but no backend exists right now, this
    // reconcile only proves LEXICAL is in sync; the semantic half stays
    // unproven and the flag is deliberately left set (with distinct
    // evidence, not a generic failure) so a later attempt -- once a backend
    // exists -- still gets a chance to actually check it.
    const semanticFieldsDeclared = declaresSemanticFields(targetStream);
    const semanticBackend = getSemanticBackend();
    if (semanticFieldsDeclared && !semanticBackend) {
      await recordSearchIndexDirtyFailure(
        { connectorInstanceId, stream },
        "semantic_fields is declared for this stream but no semantic backend is currently configured; semantic sync is unproven, dirty flag retained"
      );
      return { connectorId, connectorInstanceId, ok: false, stream };
    }
    if (semanticBackend) {
      await semanticIndexBackfillForManifest({ manifest: pinnedManifest } as unknown as SemanticBackfillOptions);
    }

    await clearSearchIndexDirty({ connectorInstanceId, stream }, new Date().toISOString());
    return { connectorId, connectorInstanceId, ok: true, stream };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSearchIndexDirtyFailure({ connectorInstanceId, stream }, message).catch(() => {
      // Evidence write is itself best-effort; never mask the original failure.
    });
    return { connectorId, connectorInstanceId, ok: false, stream };
  }
}

export interface SearchIndexDirtyReconcileRoundResult {
  readonly attempted: number;
  readonly failed: number;
  readonly incomplete: boolean;
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
  const scopes = await listDirtySearchIndexScopes(pageSize);

  let succeeded = 0;
  let failed = 0;
  let incomplete = false;
  let attempted = 0;

  for (const scope of scopes) {
    if (Date.now() >= deadline) {
      incomplete = true;
      break;
    }
    attempted += 1;
    // biome-ignore lint/performance/noAwaitInLoops: Bounded round; each scope's reconcile is independent but sequential to keep this sweep's DB load predictable.
    const result = await reconcileSearchIndexDirtyScope(scope);
    if (result.ok) {
      succeeded += 1;
    } else {
      failed += 1;
    }
  }

  return {
    attempted,
    failed,
    incomplete: incomplete || scopes.length >= pageSize,
    succeeded,
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
