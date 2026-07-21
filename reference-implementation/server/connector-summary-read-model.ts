/**
 * Connector-summary evidence read model — reference-only, owner-facing.
 *
 * Maintains DURABLE per-connection evidence for the owner-console connector
 * summary (`/_ref/connectors`). It is the SLVP-ideal construction the design
 * note calls for: a maintained, dual-backend, incrementally-updated evidence
 * store with dirty marking, lazy reconcile, full rebuild, and an honesty
 * envelope — modeled directly on `retained-size-read-model.js`.
 *
 * Load-bearing decision (openspec/changes/maintain-connector-summary-read-model
 * design.md): persist DURABLE evidence only. Time-relative and runtime-relative
 * synthesis — freshness, connection_health, collection_report, rendered_verdict,
 * next_action — is NEVER persisted here. Those are computed on read against the
 * current `now` and controller/runtime liveness so a cached verdict can never
 * say a source is healthy after its evidence has gone stale or blocked.
 *
 * The `/_ref/connectors` routes run `reconcileDirtyConnectorSummaryEvidence`
 * before every list/detail read, so the reconcile pass IS on the hot path;
 * the identity/count columns still do not back the summary payload (the
 * projection reads the retained_size_* tables directly). What the hot path
 * DOES consume from here is the per-stream latest-attempt evidence
 * (`stream_latest_facts_json`): the raw runtime fact from the newest terminal
 * run that attempted each stream, folded from terminal spine events by
 * `event_seq` checkpoint. Raw facts only — coverage/freshness are derived on
 * read. The rebuild derives evidence from already-durable canonical state
 * (connector_instances + the maintained retained_size_* projection + terminal
 * spine events); it never re-runs connectors or reads credentials.
 *
 * Spec: openspec/changes/maintain-connector-summary-read-model/
 *       openspec/changes/define-stream-coverage-freshness-evidence/
 */

import { getDb } from "./db.js";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.js";
import {
  pruneOrphanedEvidenceComplete,
  readAllInstanceIdsForPruning,
  readInstanceIdPage,
  reconcileConnectorSummaryEvidence,
} from "./connector-summary-evidence-engine.ts";

/** A raw database row (column-keyed) crossing the untyped storage boundary. */
type Row = Record<string, unknown>;

/**
 * Strip anything that looks like a credential/token (long base64-ish runs)
 * out of an error string before it lands in durable metadata, and bound the
 * length. Same contract as the retained-size projection's sanitizer.
 */
function sanitizeProjectionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || "unknown error");
  return message.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(0, 240);
}

/**
 * Reason codes for the failure-specific component-degradation markers below
 * (`markTerminalFactsFailedForAllRows`, `markAllConnectorSummaryEvidenceDiscoveryFailed`).
 * Distinct from — and never confused with — the normal happy-path dirty
 * marking (`markConnectorSummaryEvidenceDirty`/`markAllConnectorSummaryEvidenceDirty`),
 * which correctly leaves component states untouched because nothing failed.
 */
const REASON_CODES = {
  TERMINAL_FOLD_FAILED: "terminal_fold_failed",
  DISCOVERY_FAILED: "summary_discovery_failed",
  /**
   * A fold pass wrote this row's terminal facts before its own drain
   * genuinely reached the pass's full high-water mark (`maxSeq`) — the
   * budget (`maxDurationMs`/`maxEvents`) was exhausted first. Applies
   * uniformly to every bounded fold pass, incremental or a fold-logic-
   * version upgrade replay alike: the row's `stream_latest_facts_json`
   * holds genuine, resumable partial progress (never mixed old/new-logic
   * output — see `STREAM_FACTS_FOLD_LOGIC_VERSION`), but is not yet
   * trustworthy as complete evidence. Never `current` while this reason is
   * set; a later pass whose drain genuinely converges clears it.
   */
  TERMINAL_FOLD_INCOMPLETE: "terminal_fold_incomplete",
  /**
   * A row's stored `stream_facts_fold_version` is AHEAD of this binary's own
   * `STREAM_FACTS_FOLD_LOGIC_VERSION` — the row was folded by a newer
   * deploy's fold contract. An older binary has no way to validate that
   * output against its own (older) merge semantics, so it must never fold,
   * replay, or overwrite it; this reason fails the row closed instead.
   */
  FOLD_LOGIC_VERSION_INCOMPATIBLE_FUTURE: "fold_logic_version_incompatible_future",
} as const;

function parseEvidenceJson(value: unknown, fallback: unknown): unknown {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Domain-local store: connector_summary_evidence
//
// One named store for the six dialect-only drift seams of this read model.
// The Postgres/SQLite adapter is selected ONCE per call site via the storage
// backend predicate; the dialect SQL is moved VERBATIM from the old
// inline branches. Adapters stay thin: they return RAW rows (or perform an
// UPDATE). Row-shaping (shapeEvidenceRow, normalizeInstanceRow,
// addStreamRecordEvidence, retainedBytesFromRow) and the best-effort
// try/catch on the dirty markers stay in the calling orchestration.
//
// NOT folded here (already-clean function-level adapter selection over
// multi-statement transactions): rebuild* and reconcileDirty*. Also untouched:
// the *Sync SQLite helpers reconcile uses to stay inside one better-sqlite3
// transaction, and readConnectionRecordRecencyEvidence (out of this tranche).
// ---------------------------------------------------------------------------
function createConnectorSummaryStore() {
  if (isPostgresStorageBackend()) {
    return {
      async listEvidence({
        connectorInstanceId,
        connectorInstanceIds,
      }: {
        connectorInstanceId?: string | null | undefined;
        connectorInstanceIds?: readonly string[] | null | undefined;
      } = {}) {
        const params: unknown[] = [];
        let where = "";
        if (connectorInstanceId) {
          params.push(connectorInstanceId);
          where = `WHERE connector_instance_id = $${params.length}`;
        } else if (connectorInstanceIds) {
          if (connectorInstanceIds.length === 0) {
            return [];
          }
          params.push(connectorInstanceIds);
          where = `WHERE connector_instance_id = ANY($${params.length}::text[])`;
        }
        const result = await postgresQuery(
          `SELECT connector_instance_id, connector_id, display_name, status, source_kind,
                  revoked_at, total_records, stream_count, last_record_updated_at,
                  stream_records_json, retained_bytes_json, total_retained_bytes,
                  record_checkpoint_json, manifest_fingerprint,
                  record_snapshot_state, record_snapshot_reason_code,
                  terminal_facts_state, terminal_facts_reason_code,
                  manifest_declaration_state, manifest_declaration_reason_code,
                  retained_bytes_state, retained_bytes_reason_code,
                  stream_latest_facts_json, stream_facts_event_seq, stream_facts_fold_version,
                  dirty, computed_at, source_event_seq, state, last_error,
                  manifest_generation
             FROM connector_summary_evidence
             ${where}
             ORDER BY connector_instance_id ASC`,
          params
        );
        return result.rows;
      },
      async markDirty({
        connectorInstanceId,
        sanitized,
        sourceEventSeq,
      }: {
        connectorInstanceId?: string | null;
        sanitized?: string | null;
        sourceEventSeq?: unknown;
      }) {
        await postgresQuery(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = $2,
                  source_event_seq = COALESCE($3, source_event_seq)
            WHERE connector_instance_id = $1`,
          [connectorInstanceId, sanitized, sourceEventSeq == null ? null : Number(sourceEventSeq)]
        );
      },
      async markAllDirty({ sanitized }: { sanitized?: string | null }) {
        await postgresQuery(`UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', last_error = $1`, [
          sanitized,
        ]);
      },
      async markAllTerminalFactsFailed({
        sanitized,
        connectorInstanceIds,
      }: {
        sanitized?: string | null;
        connectorInstanceIds?: readonly string[] | null;
      }) {
        if (connectorInstanceIds && connectorInstanceIds.length === 0) {
          return;
        }
        const where = connectorInstanceIds ? "WHERE connector_instance_id = ANY($3::text[])" : "";
        const params: unknown[] = [sanitized, REASON_CODES.TERMINAL_FOLD_FAILED];
        if (connectorInstanceIds) {
          params.push(connectorInstanceIds);
        }
        await postgresQuery(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = $1,
                  terminal_facts_state = 'failed',
                  terminal_facts_reason_code = $2
              ${where}`,
          params
        );
      },
      async markAllDiscoveryFailed({
        sanitized,
        connectorInstanceIds,
      }: {
        sanitized?: string | null;
        connectorInstanceIds?: readonly string[] | null;
      }) {
        if (connectorInstanceIds && connectorInstanceIds.length === 0) {
          return;
        }
        const where = connectorInstanceIds ? "WHERE connector_instance_id = ANY($3::text[])" : "";
        const params: unknown[] = [sanitized, REASON_CODES.DISCOVERY_FAILED];
        if (connectorInstanceIds) {
          params.push(connectorInstanceIds);
        }
        await postgresQuery(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = $1,
                  record_snapshot_state = 'failed',
                  record_snapshot_reason_code = $2,
                  manifest_declaration_state = 'failed',
                  manifest_declaration_reason_code = $2
              ${where}`,
          params
        );
      },
    };
  }
  return {
    listEvidence({
      connectorInstanceId,
      connectorInstanceIds,
    }: {
      connectorInstanceId?: string | null | undefined;
      connectorInstanceIds?: readonly string[] | null | undefined;
    } = {}) {
      const db = getDb();
      const columns = `connector_instance_id, connector_id, display_name, status, source_kind,
                    revoked_at, total_records, stream_count, last_record_updated_at,
                    stream_records_json, retained_bytes_json, total_retained_bytes,
                    record_checkpoint_json, manifest_fingerprint,
                    record_snapshot_state, record_snapshot_reason_code,
                    terminal_facts_state, terminal_facts_reason_code,
                    manifest_declaration_state, manifest_declaration_reason_code,
                    retained_bytes_state, retained_bytes_reason_code,
                    stream_latest_facts_json, stream_facts_event_seq, stream_facts_fold_version,
                    dirty, computed_at, source_event_seq, state, last_error,
                    manifest_generation`;
      if (connectorInstanceId) {
        return db
          .prepare(
            `SELECT ${columns} FROM connector_summary_evidence
              WHERE connector_instance_id = ?
              ORDER BY connector_instance_id ASC`
          )
          .all(connectorInstanceId);
      }
      if (connectorInstanceIds) {
        if (connectorInstanceIds.length === 0) {
          return [];
        }
        const placeholders = connectorInstanceIds.map(() => "?").join(", ");
        return db
          .prepare(
            `SELECT ${columns} FROM connector_summary_evidence
              WHERE connector_instance_id IN (${placeholders})
              ORDER BY connector_instance_id ASC`
          )
          .all(...connectorInstanceIds);
      }
      return db.prepare(`SELECT ${columns} FROM connector_summary_evidence ORDER BY connector_instance_id ASC`).all();
    },
    markDirty({
      connectorInstanceId,
      sanitized,
      sourceEventSeq,
    }: {
      connectorInstanceId?: string | null;
      sanitized?: string | null;
      sourceEventSeq?: unknown;
    }) {
      getDb()
        .prepare(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = ?,
                  source_event_seq = COALESCE(?, source_event_seq)
            WHERE connector_instance_id = ?`
        )
        .run(sanitized, sourceEventSeq == null ? null : Number(sourceEventSeq), connectorInstanceId);
    },
    markAllDirty({ sanitized }: { sanitized?: string | null }) {
      getDb()
        .prepare(`UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', last_error = ?`)
        .run(sanitized);
    },
    markAllTerminalFactsFailed({
      sanitized,
      connectorInstanceIds,
    }: {
      sanitized?: string | null;
      connectorInstanceIds?: readonly string[] | null;
    }) {
      if (connectorInstanceIds && connectorInstanceIds.length === 0) {
        return;
      }
      const where = connectorInstanceIds
        ? `WHERE connector_instance_id IN (${connectorInstanceIds.map(() => "?").join(", ")})`
        : "";
      getDb()
        .prepare(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = ?,
                  terminal_facts_state = 'failed',
                  terminal_facts_reason_code = ?
              ${where}`
        )
        .run(sanitized, REASON_CODES.TERMINAL_FOLD_FAILED, ...(connectorInstanceIds ?? []));
    },
    markAllDiscoveryFailed({
      sanitized,
      connectorInstanceIds,
    }: {
      sanitized?: string | null;
      connectorInstanceIds?: readonly string[] | null;
    }) {
      if (connectorInstanceIds && connectorInstanceIds.length === 0) {
        return;
      }
      const where = connectorInstanceIds
        ? `WHERE connector_instance_id IN (${connectorInstanceIds.map(() => "?").join(", ")})`
        : "";
      getDb()
        .prepare(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = ?,
                  record_snapshot_state = 'failed',
                  record_snapshot_reason_code = ?,
                  manifest_declaration_state = 'failed',
                  manifest_declaration_reason_code = ?
              ${where}`
        )
        .run(sanitized, REASON_CODES.DISCOVERY_FAILED, REASON_CODES.DISCOVERY_FAILED, ...(connectorInstanceIds ?? []));
    },
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List maintained connector-summary evidence rows. Optionally narrow to one
 * connection by `connectorInstanceId`, or to a batched set via
 * `connectorInstanceIds` (one `IN (...)`/`= ANY` query, not a complete-table
 * scan — Sol P1.2). Returns DURABLE evidence only — callers synthesize
 * freshness/health/verdict on read.
 */
export async function listConnectorSummaryEvidence({
  connectorInstanceId,
  connectorInstanceIds,
}: {
  connectorInstanceId?: string | null | undefined;
  connectorInstanceIds?: readonly string[] | null | undefined;
} = {}) {
  const store = createConnectorSummaryStore();
  const rows = await store.listEvidence({ connectorInstanceId, connectorInstanceIds });
  return (rows as Row[]).map(shapeEvidenceRow);
}

/**
 * Read exactly one connection's maintained evidence, or `null` when no row
 * exists yet. Scoped/detail callers use this so they never fall back to the
 * shallow full-list overview.
 */
export async function getConnectorSummaryEvidence(connectorInstanceId: string | null | undefined) {
  if (!connectorInstanceId) {
    return null;
  }
  const rows = await listConnectorSummaryEvidence({ connectorInstanceId });
  return rows[0] ?? null;
}

/**
 * Read-time fail-close for a fold-logic-version-AHEAD row (see
 * `rowIsFoldLogicVersionAhead`): THIS binary presents the row's terminal
 * facts as unreliable for its OWN observation, without ever durably
 * mutating the row. A newer binary owns this row's fold output; an older
 * binary reading it back later (rollback, or before this binary catches
 * up) must not silently trust semantics it cannot validate, but it also
 * must never poison the durable row — a newer-compatible reader (the
 * binary that actually wrote it, or any future binary at that version or
 * newer) still reads `terminal_facts_state` exactly as stored: `current`.
 */
function shapeTerminalFacts(row: Row) {
  const eventSeq = row.stream_facts_event_seq == null ? null : Number(row.stream_facts_event_seq);
  if (rowIsFoldLogicVersionAhead(row)) {
    return {
      state: "stale",
      event_seq: eventSeq,
      as_of: row.computed_at || null,
      reason_code: REASON_CODES.FOLD_LOGIC_VERSION_INCOMPATIBLE_FUTURE,
    };
  }
  return {
    state: row.terminal_facts_state || "unobserved",
    event_seq: eventSeq,
    as_of: row.computed_at || null,
    reason_code: row.terminal_facts_reason_code || null,
  };
}

/**
 * Shape one raw storage row into the owner-facing evidence envelope,
 * including the four orthogonal typed components (design.md "Orthogonal
 * projection evidence"). `retained_bytes` is `null` — not a zeroed object —
 * whenever its component is non-current, so a retained-byte read failure
 * cannot be misread as "zero bytes retained." `retained_bytes_evidence`
 * carries the typed state/as_of/reason_code envelope for that same
 * component, alongside (never replacing) the nulled byte-value payload, so a
 * consumer can distinguish "unavailable because never observed" from
 * "unavailable because the last attempt failed" from "mid-repair."
 *
 * Exported so a caller merging an in-memory failed row (one whose durable
 * write itself failed — see `ReconcileResult.failedRows`, Sol P1.1) over a
 * durable read can shape it into the identical envelope; every field this
 * function reads defaults gracefully on the sparser failed-row shape
 * (`buildFailedRow` in `connector-summary-evidence-engine.ts`).
 */
/** Shared `{state, as_of, reason_code}` envelope shape used by every orthogonal typed component below. */
function shapeComponentEnvelope(row: Row, state: unknown, reasonCode: unknown) {
  return {
    state,
    as_of: row.computed_at || null,
    reason_code: reasonCode || null,
  };
}

export function shapeEvidenceRow(row: Row) {
  const retainedBytesState = String(row.retained_bytes_state || "unobserved");
  return {
    connector_instance_id: row.connector_instance_id,
    connector_id: row.connector_id,
    display_name: row.display_name,
    status: row.status,
    source_kind: row.source_kind,
    revoked_at: row.revoked_at || null,
    total_records: Number(row.total_records || 0),
    stream_count: Number(row.stream_count || 0),
    last_record_updated_at: row.last_record_updated_at || null,
    stream_records: parseEvidenceJson(row.stream_records_json, []),
    stream_latest_facts: parseEvidenceJson(row.stream_latest_facts_json, null),
    stream_facts_event_seq: row.stream_facts_event_seq == null ? null : Number(row.stream_facts_event_seq),
    retained_bytes: retainedBytesState === "current" ? parseEvidenceJson(row.retained_bytes_json, null) : null,
    total_retained_bytes: Number(row.total_retained_bytes || 0),
    record_snapshot: shapeComponentEnvelope(
      row,
      row.record_snapshot_state || "unobserved",
      row.record_snapshot_reason_code
    ),
    terminal_facts: shapeTerminalFacts(row),
    manifest_declaration: shapeComponentEnvelope(
      row,
      row.manifest_declaration_state || "unavailable",
      row.manifest_declaration_reason_code
    ),
    retained_bytes_evidence: shapeComponentEnvelope(row, retainedBytesState, row.retained_bytes_reason_code),
    dirty: Number(row.dirty || 0) !== 0,
    computed_at: row.computed_at || null,
    manifest_generation: Number(row.manifest_generation ?? 0),
    source_event_seq: row.source_event_seq == null ? null : Number(row.source_event_seq),
    state: row.state || "unknown",
    last_error: row.last_error || null,
  };
}

// ---------------------------------------------------------------------------
// Dirty markers
// ---------------------------------------------------------------------------

/**
 * Mark one connection's evidence dirty. Best-effort: a marker failure is
 * non-fatal because the canonical state (connector_instances + retained_size_*)
 * is untouched and a subsequent reconcile/rebuild repairs the row. Same
 * dirty-on-failure contract as the retained-size projection.
 *
 * `sourceEventSeq`, when provided, records the monotonic seq of the event that
 * dirtied the row so a later reconcile can detect it is acting on the freshest
 * cause. It is advisory metadata, never load-bearing for correctness.
 */
export async function markConnectorSummaryEvidenceDirty({
  connectorInstanceId,
  reason,
  sourceEventSeq,
}: {
  connectorInstanceId?: string | null;
  reason?: unknown;
  sourceEventSeq?: unknown;
} = {}) {
  if (!connectorInstanceId) {
    return;
  }
  const sanitized = reason ? sanitizeProjectionError(reason) : null;
  try {
    const store = createConnectorSummaryStore();
    await store.markDirty({ connectorInstanceId, sanitized, sourceEventSeq });
  } catch {
    // Best-effort marker; rebuild/reconcile will repair.
  }
}

/**
 * Mark every maintained evidence row dirty. Used when a bulk write touched an
 * unknown set of connections (the same fallback the retained-size projection
 * uses when it cannot scope the delta).
 */
export async function markAllConnectorSummaryEvidenceDirty(reason: unknown) {
  const sanitized = reason ? sanitizeProjectionError(reason) : null;
  try {
    const store = createConnectorSummaryStore();
    await store.markAllDirty({ sanitized });
  } catch {
    // Best-effort.
  }
}

/**
 * Reads the current durable row (if any) for each requested id, BEFORE a
 * component-failure marker write is attempted. Used to build an in-memory
 * typed failed row when that marker write itself also fails (Sol P1.1's
 * simultaneous double-failure) — degrading exactly the failed component(s)
 * while preserving every other already-known field, the same
 * "preserve-other-components" contract `buildFailedRow`/
 * `persistFailedEvidenceSqlite` already apply on the repair-candidate path.
 * Never throws: a read failure here just means the fallback below defaults
 * to "no prior row" (still safely shaped by `shapeEvidenceRow`, which
 * defaults component states to their honest unobserved/unavailable values,
 * not a fabricated clean row).
 *
 * Also resolves the EFFECTIVE target id list when the caller passed `null`
 * (complete census): a fresh, independent `listEvidence({})` read of every
 * durable row's id — independent of whatever internal state the failed
 * discovery/fold pass had reached, so this still succeeds when the fault is
 * scoped to the failed phase's own read/write path (e.g. `spine_events`
 * unreadable) rather than `connector_summary_evidence` itself. Returns rows
 * keyed by id either way; when even THIS read fails, the id list is empty
 * and the caller correctly produces no overlay (nothing durable can be
 * known about "every row" without knowing what "every row" is) — the
 * durable best-effort marker attempt remains the closure for that
 * doubly-unlucky case, unchanged from before this fix.
 */
async function readExistingRowsForFailureOverlay(
  connectorInstanceIds: readonly string[] | null
): Promise<Map<string, Row>> {
  const byId = new Map<string, Row>();
  if (connectorInstanceIds && connectorInstanceIds.length === 0) {
    return byId;
  }
  try {
    const store = createConnectorSummaryStore();
    const rows = (await store.listEvidence(connectorInstanceIds === null ? {} : { connectorInstanceIds })) as Row[];
    for (const row of rows) {
      byId.set(String(row.connector_instance_id), row);
    }
  } catch {
    // Best-effort snapshot; an empty map here correctly yields no overlay.
  }
  return byId;
}

/**
 * Builds the in-memory typed failed-row overlay for exactly
 * `connectorInstanceIds`, degrading only `componentFields` (the same column
 * set the corresponding store marker method durably writes) while carrying
 * forward every other field from `existingById`. A row absent from
 * `existingById` (never observed before) degrades from the honest empty
 * shape, matching a first-ever observation that immediately fails.
 */
function buildComponentFailedRows(
  connectorInstanceIds: readonly string[],
  existingById: ReadonlyMap<string, Row>,
  componentFields: Row,
  sanitized: string | null
): Map<string, Row> {
  const failedRows = new Map<string, Row>();
  for (const connectorInstanceId of connectorInstanceIds) {
    const existing = existingById.get(connectorInstanceId) ?? { connector_instance_id: connectorInstanceId };
    failedRows.set(connectorInstanceId, {
      ...existing,
      ...componentFields,
      connector_instance_id: connectorInstanceId,
      dirty: 1,
      state: "failed",
      last_error: sanitized,
    });
  }
  return failedRows;
}

/**
 * Failure-specific marker for a genuine terminal-fold failure
 * (`foldStreamFactsBestEffort`'s catch): a fold failure is SPECIFICALLY a
 * terminal-facts failure — nothing this pass could verify about any row's
 * per-stream latest-attempt facts. In ADDITION to the existing generic
 * dirty/state/last_error marking (still set here, unchanged contract),
 * durably degrades `terminal_facts_state` to `'failed'` for every row so a
 * component-state consumer (`evidenceUnreliableSources`) can see the
 * specific failure without depending on the generic `dirty`/`state` columns
 * it does not read. Distinct from — never a replacement for — the normal
 * happy-path `markAllConnectorSummaryEvidenceDirty`, which correctly leaves
 * component states untouched.
 *
 * Returns an in-memory typed failed-row overlay (Sol P1.1) for exactly the
 * ids whose durable marker write also failed — a caller in the SAME
 * observation call merges this over its subsequent durable read for those
 * ids, so a simultaneous fold failure + marker-write failure still surfaces
 * as failed evidence this pass rather than a stale current/fresh re-read.
 * When `connectorInstanceIds` is `null` (complete census), the effective
 * target set is resolved via a fresh, independent evidence-id read (see
 * `readExistingRowsForFailureOverlay`) rather than left unbounded — empty
 * only when that resolution read ALSO fails, in which case the durable
 * degrade-mark attempted above remains the sole closure, unchanged from
 * before this fix.
 */
export async function markTerminalFactsFailedForAllRows(
  reason: unknown,
  connectorInstanceIds: readonly string[] | null = null
): Promise<ReadonlyMap<string, Row>> {
  const sanitized = reason ? sanitizeProjectionError(reason) : null;
  const existingById = await readExistingRowsForFailureOverlay(connectorInstanceIds);
  const effectiveIds = connectorInstanceIds ?? [...existingById.keys()];
  try {
    const store = createConnectorSummaryStore();
    await store.markAllTerminalFactsFailed({ sanitized, connectorInstanceIds });
    return new Map();
  } catch {
    // The durable marker write itself failed. Carry a typed failed-row
    // overlay through in memory instead of trusting a subsequent durable
    // read to reflect this failure (closes Sol P1.1).
    if (effectiveIds.length === 0) {
      return new Map();
    }
    return buildComponentFailedRows(
      effectiveIds,
      existingById,
      { terminal_facts_state: "failed", terminal_facts_reason_code: REASON_CODES.TERMINAL_FOLD_FAILED },
      sanitized
    );
  }
}

/**
 * Failure-specific marker for a genuine discovery failure
 * (`observeConnectorSummaryEvidence`'s discovery-throw catch): discovery
 * itself failed — broader than any one row's repair failure, meaning
 * NOTHING about ANY row's canonical facts (records, checkpoints, manifest)
 * could be verified this pass. Durably degrades `record_snapshot_state` and
 * `manifest_declaration_state` to `'failed'` for every row, in ADDITION to
 * the existing generic dirty/state/last_error marking. Deliberately does
 * NOT touch `retained_bytes_state` — retained bytes converge through their
 * own separate mechanism (out of scope here) — nor `terminal_facts_state`,
 * since a discovery failure says nothing new about whether the terminal
 * fold specifically succeeded or failed; a genuinely current fold's
 * evidence should not be fabricated as failed by an unrelated discovery
 * fault. Distinct from — never a replacement for — the normal happy-path
 * `markAllConnectorSummaryEvidenceDirty`. `connectorInstanceIds`, when
 * provided, narrows the mark to exactly that set (Sol P1.2) — a scoped
 * caller's discovery failure says nothing about every OTHER connection.
 * `null` (the default) preserves the exact prior complete-mark behavior.
 *
 * Returns an in-memory typed failed-row overlay (Sol P1.1), same contract as
 * `markTerminalFactsFailedForAllRows` above: non-empty whenever the durable
 * marker write ALSO fails and the effective target id set (the requested
 * ids, or every existing evidence row's id when `connectorInstanceIds` is
 * `null`) can be resolved.
 */
export async function markAllConnectorSummaryEvidenceDiscoveryFailed(
  reason: unknown,
  connectorInstanceIds: readonly string[] | null = null
): Promise<ReadonlyMap<string, Row>> {
  const sanitized = reason ? sanitizeProjectionError(reason) : null;
  const existingById = await readExistingRowsForFailureOverlay(connectorInstanceIds);
  const effectiveIds = connectorInstanceIds ?? [...existingById.keys()];
  try {
    const store = createConnectorSummaryStore();
    await store.markAllDiscoveryFailed({ sanitized, connectorInstanceIds });
    return new Map();
  } catch {
    if (effectiveIds.length === 0) {
      return new Map();
    }
    return buildComponentFailedRows(
      effectiveIds,
      existingById,
      {
        record_snapshot_state: "failed",
        record_snapshot_reason_code: REASON_CODES.DISCOVERY_FAILED,
        manifest_declaration_state: "failed",
        manifest_declaration_reason_code: REASON_CODES.DISCOVERY_FAILED,
      },
      sanitized
    );
  }
}

// ---------------------------------------------------------------------------
// Per-stream latest-attempt evidence fold
//
// Terminal run events carry the runtime `collection_facts` block (objective
// per-stream facts for the streams that run ATTEMPTED). This fold maintains,
// per connection, the newest fact per stream — raw fact + the terminal
// event's occurred_at (`evidence_as_of`) + run id — checkpointed by spine
// `event_seq` so a terminal event recorded during an in-progress pass is
// folded on the next pass rather than lost. A run that did not attempt a
// stream leaves that stream's stored fact untouched; the newest attempt
// replaces older proof, EXCEPT that an attempt whose own fact does not prove
// durable coverage (checkpoint neither `committed` nor `disabled`) never
// erases a stream's already-durably-proven fact — a later owner-cancelled or
// failed attempt cannot regress a stream that a prior run genuinely proved
// (see `mergeEventStreamFacts`). A never-proven stream's newest attempt still
// always wins, resolved or not, so honest absence of proof is never masked.
// Run failure/cancellation itself is represented by the separate run-health
// authority, not by this per-stream fact store. The connection is the
// isolation key: an event without a `connector_instance_id`/`connection_id`
// (legacy connector-wide) is refused, never attributed.
//
// Rows with a NULL checkpoint (pre-change instances) self-heal: the next
// fold pass — reconcile runs before every `/_ref/connectors` read, and the
// server schedules one pass at startup — folds their full attributable
// terminal history once. On fold failure every row is marked stale with the
// sanitized error so the state is visible, and the projection's fail-closed
// default (missing facts read unknown) keeps verdicts truthful.
// ---------------------------------------------------------------------------

const TERMINAL_RUN_EVENT_TYPES = ["run.completed", "run.failed", "run.browser_surface_failed", "run.cancelled"];
const TERMINAL_TYPES_SQL = TERMINAL_RUN_EVENT_TYPES.map((t) => `'${t}'`).join(", ");
const STREAM_FACTS_FOLD_BATCH = 2000;

/**
 * The fold's own logic version. A row's stored `stream_facts_event_seq`
 * checkpoint is a durable HIGH-WATER MARK: once it advances, `readTerminalFactEvents`
 * never re-reads events at or below it. That is correct when the FOLD LOGIC
 * itself hasn't changed — but a fold-semantics fix (like the monotonic-
 * coverage guard this version bump ships) changes what the SAME event
 * history folds to. Without an invalidation lever, a row whose checkpoint
 * already sits past a since-fixed corrupting event would never re-fold under
 * the new logic — the bug would be permanently frozen into that row's stored
 * facts even after the code fix ships (the exact gap a bare merge-logic fix
 * leaves).
 *
 * `seedFoldState` treats any row whose stored `stream_facts_fold_version` is
 * behind this constant exactly like a NULL checkpoint: it participates from
 * the beginning (full terminal history replay) and starts from an EMPTY fact
 * map rather than trusting its previously-folded (possibly logic-stale)
 * facts as a baseline. This makes every existing row self-heal on its next
 * ordinary reconcile pass (`/_ref/connectors` routes reconcile before every
 * read, and the server runs one pass at startup) — no per-connector/per-
 * provider special case, no manual data mutation. Bump this whenever a
 * change to `mergeEventStreamFacts`'s merge semantics could change the
 * output for existing already-folded event history.
 */
const STREAM_FACTS_FOLD_LOGIC_VERSION = 2;

/**
 * Test-only deterministic pause point inside `foldConnectorSummaryStreamFacts`,
 * a complete no-op in production (`__foldPauseHook` is never assigned
 * outside a test). Exists so a test can make two REAL, complete
 * `foldConnectorSummaryStreamFacts()` calls genuinely overlap — hold one
 * pass paused at a named point while a second pass runs to completion and
 * commits, then release the first pass so its CAS write races against
 * already-committed state — instead of proving the CAS predicate only via
 * sequential rewind-then-replay or a synthesized stale write.
 * `__testOnlySetFoldPauseHook` is the only intended installer.
 */
let __foldPauseHook: ((point: "after_seed_before_read" | "before_cas_write") => Promise<void> | void) | null = null;

export function __testOnlySetFoldPauseHook(
  hook: ((point: "after_seed_before_read" | "before_cas_write") => Promise<void> | void) | null
): void {
  __foldPauseHook = hook;
}

async function testOnlyFoldPauseHook(point: "after_seed_before_read" | "before_cas_write"): Promise<void> {
  if (__foldPauseHook) {
    await __foldPauseHook(point);
  }
}

/** One stored latest-attempt entry: the raw runtime fact plus its provenance. */
interface StoredStreamFactEntry {
  event_seq: number;
  evidence_as_of: string | null;
  fact: Row;
  run_id: string | null;
}

/**
 * Builds the `connector_instance_id IN (...)` fragment plus its bound
 * parameters for a scoped terminal-event read, or an empty fragment/param
 * list for an unscoped (complete) read. `scope` is `null` for "read every
 * connection's terminal history" and a non-empty array for "read only these
 * connections'" — an empty array is never passed by any caller (a caller
 * with zero connections of interest has nothing to fold and does not call
 * the fold store at all), so it is not specially handled here.
 */
function buildTerminalScopeFragmentPostgres(
  scope: readonly string[] | null,
  startParamIndex: number
): { sql: string; params: unknown[] } {
  if (scope === null || scope.length === 0) {
    return { sql: "", params: [] };
  }
  const placeholders = scope.map((_, i) => `$${startParamIndex + i}`).join(", ");
  return { sql: ` AND connector_instance_id IN (${placeholders})`, params: [...scope] };
}

function buildTerminalScopeFragmentSqlite(scope: readonly string[] | null): { sql: string; params: unknown[] } {
  if (scope === null || scope.length === 0) {
    return { sql: "", params: [] };
  }
  const placeholders = scope.map(() => "?").join(", ");
  return { sql: ` AND connector_instance_id IN (${placeholders})`, params: [...scope] };
}

function createStreamFactsFoldStore() {
  if (isPostgresStorageBackend()) {
    return {
      async readMaxTerminalEventSeq(scope: readonly string[] | null = null): Promise<number | null> {
        const { sql: scopeSql, params: scopeParams } = buildTerminalScopeFragmentPostgres(scope, 1);
        const result = await postgresQuery(
          `SELECT MAX(event_seq) AS max_seq FROM spine_events WHERE event_type IN (${TERMINAL_TYPES_SQL})${scopeSql}`,
          scopeParams
        );
        const value = (result.rows[0] as Row | undefined)?.max_seq;
        return value == null ? null : Number(value);
      },
      async readTerminalFactEvents({
        sinceSeq,
        maxSeq,
        limit,
        scope = null,
      }: {
        sinceSeq: number;
        maxSeq: number;
        limit: number;
        scope?: readonly string[] | null;
      }) {
        const { sql: scopeSql, params: scopeParams } = buildTerminalScopeFragmentPostgres(scope, 4);
        const result = await postgresQuery(
          `SELECT event_seq, occurred_at, run_id, data_json::text AS data_json
             FROM spine_events
            WHERE event_type IN (${TERMINAL_TYPES_SQL})
              AND event_seq > $1 AND event_seq <= $2${scopeSql}
            ORDER BY event_seq ASC
            LIMIT $3`,
          [sinceSeq, maxSeq, limit, ...scopeParams]
        );
        return result.rows as Row[];
      },
      async updateStreamFacts({
        connectorInstanceId,
        factsJson,
        eventSeq,
        baselineEventSeq,
        baselineFoldVersion,
        foldVersion,
        terminalFactsState,
        terminalFactsReasonCode,
      }: {
        connectorInstanceId: string;
        factsJson: string | null;
        eventSeq: number;
        baselineEventSeq: number | null;
        baselineFoldVersion: number | null;
        foldVersion: number | null;
        terminalFactsState: "current" | "stale";
        terminalFactsReasonCode: string | null;
      }): Promise<boolean> {
        const result = await postgresQuery(
          `UPDATE connector_summary_evidence
              SET stream_latest_facts_json = $2::jsonb,
                  stream_facts_event_seq = $3,
                  stream_facts_fold_version = $5,
                  terminal_facts_state = $6,
                  terminal_facts_reason_code = $7
            WHERE connector_instance_id = $1
              AND stream_facts_event_seq IS NOT DISTINCT FROM $4
              AND stream_facts_fold_version IS NOT DISTINCT FROM $8`,
          [
            connectorInstanceId,
            factsJson,
            eventSeq,
            baselineEventSeq,
            foldVersion,
            terminalFactsState,
            terminalFactsReasonCode,
            baselineFoldVersion,
          ]
        );
        return (result.rowCount ?? 0) > 0;
      },
    };
  }
  return {
    readMaxTerminalEventSeq(scope: readonly string[] | null = null): number | null {
      const { sql: scopeSql, params: scopeParams } = buildTerminalScopeFragmentSqlite(scope);
      const row = getDb()
        .prepare(
          `SELECT MAX(event_seq) AS max_seq FROM spine_events WHERE event_type IN (${TERMINAL_TYPES_SQL})${scopeSql}`
        )
        .get(...scopeParams) as Row | undefined;
      const value = row?.max_seq;
      return value == null ? null : Number(value);
    },
    readTerminalFactEvents({
      sinceSeq,
      maxSeq,
      limit,
      scope = null,
    }: {
      sinceSeq: number;
      maxSeq: number;
      limit: number;
      scope?: readonly string[] | null;
    }) {
      const { sql: scopeSql, params: scopeParams } = buildTerminalScopeFragmentSqlite(scope);
      return getDb()
        .prepare(
          `SELECT event_seq, occurred_at, run_id, data_json
             FROM spine_events
            WHERE event_type IN (${TERMINAL_TYPES_SQL})
              AND event_seq > ? AND event_seq <= ?${scopeSql}
            ORDER BY event_seq ASC
            LIMIT ?`
        )
        .all(sinceSeq, maxSeq, ...scopeParams, limit) as Row[];
    },
    updateStreamFacts({
      connectorInstanceId,
      factsJson,
      eventSeq,
      baselineEventSeq,
      baselineFoldVersion,
      foldVersion,
      terminalFactsState,
      terminalFactsReasonCode,
    }: {
      connectorInstanceId: string;
      factsJson: string | null;
      eventSeq: number;
      baselineEventSeq: number | null;
      baselineFoldVersion: number | null;
      foldVersion: number | null;
      terminalFactsState: "current" | "stale";
      terminalFactsReasonCode: string | null;
    }): boolean {
      const result = getDb()
        .prepare(
          `UPDATE connector_summary_evidence
              SET stream_latest_facts_json = ?,
                  stream_facts_event_seq = ?,
                  stream_facts_fold_version = ?,
                  terminal_facts_state = ?,
                  terminal_facts_reason_code = ?
            WHERE connector_instance_id = ?
              AND stream_facts_event_seq IS ?
              AND stream_facts_fold_version IS ?`
        )
        .run(
          factsJson,
          eventSeq,
          foldVersion,
          terminalFactsState,
          terminalFactsReasonCode,
          connectorInstanceId,
          baselineEventSeq,
          baselineFoldVersion
        );
      return result.changes > 0;
    },
  };
}

/**
 * Test-only access to the real terminal-facts CAS write
 * (`createStreamFactsFoldStore().updateStreamFacts`) that
 * `foldConnectorSummaryStreamFacts` uses internally. Exists so a genuine
 * two-fold CAS-loser interleaving test can invoke the PRODUCTION compare-
 * and-set write directly with a deliberately-stale `baselineEventSeq` — the
 * exact write an older concurrent fold pass would have attempted — without
 * reimplementing the `stream_facts_event_seq IS <baseline> AND
 * stream_facts_fold_version IS <baseline>` predicate in test code. Never
 * used outside tests.
 */
export function __testOnlyUpdateStreamFactsCasWrite(args: {
  connectorInstanceId: string;
  factsJson: string | null;
  eventSeq: number;
  baselineEventSeq: number | null;
  baselineFoldVersion?: number | null;
  foldVersion?: number | null;
  terminalFactsState?: "current" | "stale";
  terminalFactsReasonCode?: string | null;
}): Promise<boolean> | boolean {
  return createStreamFactsFoldStore().updateStreamFacts({
    ...args,
    baselineFoldVersion: args.baselineFoldVersion ?? null,
    foldVersion: args.foldVersion ?? STREAM_FACTS_FOLD_LOGIC_VERSION,
    terminalFactsState: args.terminalFactsState ?? "current",
    terminalFactsReasonCode: args.terminalFactsReasonCode ?? null,
  });
}

/** The connection an event attributes to, or `null` when it names none (refused). */
function readEventConnectionId(data: Row): string | null {
  const instanceId = data.connector_instance_id;
  if (typeof instanceId === "string" && instanceId) {
    return instanceId;
  }
  const connectionId = data.connection_id;
  if (typeof connectionId === "string" && connectionId) {
    return connectionId;
  }
  return null;
}

/** Parse a terminal event row's payload into its fact stream array, or `null` when it carries none. */
function parseTerminalFactEvent(row: Row): { payload: Row; streams: unknown[] } | null {
  let data: unknown;
  try {
    data = JSON.parse(String(row.data_json ?? "null"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const payload = data as Row;
  const block = payload.collection_facts as Row | undefined;
  const streams = block && typeof block === "object" && Array.isArray(block.streams) ? block.streams : null;
  return streams && streams.length > 0 ? { payload, streams } : null;
}

/**
 * Whether a stream fact's own `checkpoint` proves durable coverage —
 * the SAME predicate `connector-coverage-policy.ts`'s
 * `checkpointProvesCoverage` uses to gate `complete`. Mirrored rather than
 * imported so this read-model module keeps zero dependency on the coverage-
 * derivation module (a raw-facts store must not need to know how coverage is
 * derived); the two are kept in lockstep by
 * `stream-facts-checkpoint-proof-parity.test.js`.
 */
function factCheckpointProvesDurableCoverage(fact: Row): boolean {
  const checkpoint = fact.checkpoint;
  return checkpoint === "committed" || checkpoint === "disabled";
}

/**
 * Merge one event's stream facts into a connection's map: newest attempt
 * wins per stream, UNLESS doing so would erase durable proof with an
 * attempt that proves nothing. A recovery-only run's terminal fact block
 * already omits any stream it did not genuinely (re-)measure this run (see
 * `buildCollectionFacts`'s recovery-only filter in
 * `connector-gap-bounding.ts`) — so this fold needs no recovery-only special
 * case: a stream present in the event's facts was genuinely attempted this
 * run.
 *
 * Monotonicity guard (a connection-health `runtime_evidence_missing` defect
 * class): a stream's own `checkpoint` is the proof, independent of which
 * terminal event type carried it or whether the run overall succeeded,
 * failed, or was cancelled — an owner-cancelled or
 * failed run can still commit a stream's checkpoint (partial progress), and
 * a nominally `run.completed` run can still leave a stream `not_staged`
 * (e.g. persistState disabled). So the guard is: once a stream's STORED
 * fact proves durable coverage (`checkpoint` is `committed` or `disabled` —
 * the same boundary `checkpointProvesCoverage` uses to gate `complete`), a
 * newer attempt whose OWN fact does not also prove durable coverage keeps
 * the existing (stronger) fact and does not replace it. This is a floor, not
 * a freeze: a newer fact that itself proves durable coverage (a genuine
 * `committed`/`disabled` re-measurement, including a legitimate skip/
 * accepted-absence fact whose parent checkpoint committed/disabled) still
 * replaces the stored fact normally — forward progress is unaffected.
 *
 * A stream with no prior durably-proven fact is unaffected by the guard:
 * every attempt — resolved or not — still replaces it, so an honestly-never-
 * proven stream keeps surfacing its newest (possibly unresolved) attempt
 * rather than silently freezing on the first thing recorded for it. Run
 * failure/cancellation itself is never represented here; it is the separate
 * run-health/run-summary authority's job, and this guard only decides which
 * PER-STREAM fact is authoritative evidence going forward.
 */
function mergeEventStreamFacts(
  facts: Record<string, StoredStreamFactEntry>,
  streams: readonly unknown[],
  provenance: { evidenceAsOf: string | null; runId: string | null; eventSeq: number },
  counters: { folded: number; refused: number }
): void {
  for (const rawFact of streams) {
    if (!rawFact || typeof rawFact !== "object" || Array.isArray(rawFact)) {
      continue;
    }
    const stream = (rawFact as Row).stream;
    if (typeof stream !== "string" || !stream) {
      continue;
    }
    const existing = facts[stream];
    // Events are folded in ascending event_seq order, so a later event's
    // fact is a newer attempt than any already-stored fact.
    if (existing && existing.event_seq > provenance.eventSeq) {
      continue;
    }
    if (
      existing &&
      factCheckpointProvesDurableCoverage(existing.fact) &&
      !factCheckpointProvesDurableCoverage(rawFact as Row)
    ) {
      // The stored fact already proves durable coverage; this newer attempt
      // does not. Keep the stronger, already-proven fact — do not regress it.
      continue;
    }
    facts[stream] = {
      fact: rawFact as Row,
      evidence_as_of: provenance.evidenceAsOf,
      run_id: provenance.runId,
      event_seq: provenance.eventSeq,
    };
    counters.folded += 1;
  }
}

/** Fold one terminal event's fact block into the per-instance maps. */
function foldTerminalEventFacts(
  factsByInstance: Map<string, Record<string, StoredStreamFactEntry>>,
  checkpointByInstance: Map<string, number | null>,
  row: Row,
  counters: { folded: number; refused: number }
): void {
  const parsed = parseTerminalFactEvent(row);
  if (!parsed) {
    return;
  }
  const instanceId = readEventConnectionId(parsed.payload);
  if (!instanceId) {
    // Legacy connector-wide event: cannot be attributed to exactly one
    // connection, so it is refused rather than mixed across accounts.
    counters.refused += 1;
    return;
  }
  const facts = factsByInstance.get(instanceId);
  if (!facts) {
    // Not a tracked evidence row (deleted or foreign connection).
    return;
  }
  const eventSeq = Number(row.event_seq);
  const checkpoint = checkpointByInstance.get(instanceId);
  if (!Number.isFinite(eventSeq) || (checkpoint != null && eventSeq <= checkpoint)) {
    return;
  }
  mergeEventStreamFacts(
    facts,
    parsed.streams,
    {
      evidenceAsOf: typeof row.occurred_at === "string" && row.occurred_at ? row.occurred_at : null,
      runId: typeof row.run_id === "string" && row.run_id ? row.run_id : null,
      eventSeq,
    },
    counters
  );
}

/**
 * Whether a row's stored fold output was computed under a fold-logic
 * version older than the current one (including a pre-versioning row, whose
 * `stream_facts_fold_version` is NULL) — see `STREAM_FACTS_FOLD_LOGIC_VERSION`.
 * A version-behind row's checkpoint/facts are not trustworthy baselines under
 * the current merge semantics; the fold treats it exactly like a never-
 * folded row and replays it from scratch (empty fact map, NULL effective
 * checkpoint — see `seedFoldState`).
 *
 * This is DISTINCT from — and only ever true for — the FIRST pass of an
 * upgrade. `stream_facts_fold_version` is stamped to
 * `STREAM_FACTS_FOLD_LOGIC_VERSION` on EVERY write this fold makes,
 * converged or not (see `writeParticipantStreamFacts`): the merge semantics
 * that produced the write's output ARE the current version from the very
 * first partial batch, so the version field always reflects that
 * truthfully. Holding it back would make the row look version-behind again
 * on the next pass, discarding the exact partial progress just persisted
 * and restarting the replay from scratch every single pass.
 *
 * TRUST in an incomplete replay's output is carried entirely by
 * `terminal_facts_state`/`terminal_facts_reason_code`, never by this
 * predicate: a row whose replay is genuinely incomplete after its first
 * write necessarily has `stream_facts_event_seq < maxSeq` (the drain that
 * produced it stopped short — see `drainTerminalEventBatches`), so
 * `rowNeedsFoldParticipation`'s ordinary checkpoint-lag predicate alone
 * already guarantees it participates again and resumes (not restarts) from
 * its own genuine partial progress. No separate reason-keyed participation
 * branch is needed.
 */
function rowIsFoldLogicVersionBehind(row: Row): boolean {
  const version = row.stream_facts_fold_version == null ? null : Number(row.stream_facts_fold_version);
  return version == null || version < STREAM_FACTS_FOLD_LOGIC_VERSION;
}

/**
 * Whether a row's stored `stream_facts_fold_version` is AHEAD of this
 * binary's own `STREAM_FACTS_FOLD_LOGIC_VERSION` — the row was folded by a
 * newer deploy's fold contract (e.g. a rolling deploy where an older
 * instance is still serving traffic, or a rollback to an older binary after
 * a newer one already ran). This binary has no way to validate that output
 * against its own (older) merge semantics: it MUST NOT participate in
 * folding, replaying, or overwriting such a row under any circumstance —
 * fail closed instead. Mutually exclusive with `rowIsFoldLogicVersionBehind`.
 */
function rowIsFoldLogicVersionAhead(row: Row): boolean {
  const version = row.stream_facts_fold_version == null ? null : Number(row.stream_facts_fold_version);
  return version != null && version > STREAM_FACTS_FOLD_LOGIC_VERSION;
}

/** A participant row's write-time CAS anchor, captured at seed time. */
interface FoldCasBaseline {
  readonly eventSeq: number | null;
  readonly foldVersion: number | null;
}

/**
 * Seed the fold's in-memory state from the participating evidence rows. A
 * row whose stored fold-logic version is behind current (see
 * `rowIsFoldLogicVersionBehind`) is seeded exactly like a never-folded row —
 * EMPTY fact map, NULL effective checkpoint — so it replays its FULL
 * attributable terminal history under the current merge semantics rather
 * than treating its previously-folded (possibly logic-stale) facts as a
 * trusted baseline to merge forward from. This is what makes a fold-
 * semantics fix (e.g. the monotonic-coverage guard) self-heal every
 * existing row automatically, without a per-row/per-connector data
 * migration.
 *
 * `casBaselineByInstance` is tracked SEPARATELY from the effective replay
 * checkpoint: it is the row's TRUE currently-stored `(event_seq,
 * fold_version)` pair, used only as the compare-and-set anchor for this
 * pass's write. A version-behind row's true stored `stream_facts_event_seq`
 * is generally non-NULL (it was folded under the old logic) even though its
 * EFFECTIVE replay checkpoint above is forced to NULL — conflating the two
 * would make the CAS predicate compare against a baseline that was never
 * actually stored, so it would never match and the healing write would
 * never land.
 */
function seedFoldState(participants: readonly Row[]): {
  casBaselineByInstance: Map<string, FoldCasBaseline>;
  checkpointByInstance: Map<string, number | null>;
  factsByInstance: Map<string, Record<string, StoredStreamFactEntry>>;
  sinceSeq: number;
} {
  const factsByInstance = new Map<string, Record<string, StoredStreamFactEntry>>();
  const checkpointByInstance = new Map<string, number | null>();
  const casBaselineByInstance = new Map<string, FoldCasBaseline>();
  let sinceSeq = Number.POSITIVE_INFINITY;
  for (const row of participants) {
    const instanceId = String(row.connector_instance_id);
    const versionBehind = rowIsFoldLogicVersionBehind(row);
    const parsed = versionBehind ? null : parseEvidenceJson(row.stream_latest_facts_json, null);
    factsByInstance.set(
      instanceId,
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, StoredStreamFactEntry>) }
        : {}
    );
    const checkpoint = versionBehind || row.stream_facts_event_seq == null ? null : Number(row.stream_facts_event_seq);
    checkpointByInstance.set(instanceId, checkpoint);
    casBaselineByInstance.set(instanceId, {
      eventSeq: row.stream_facts_event_seq == null ? null : Number(row.stream_facts_event_seq),
      foldVersion: row.stream_facts_fold_version == null ? null : Number(row.stream_facts_fold_version),
    });
    sinceSeq = Math.min(sinceSeq, checkpoint ?? 0);
  }
  return { casBaselineByInstance, checkpointByInstance, factsByInstance, sinceSeq };
}

export interface FoldStreamFactsResult {
  readonly folded: number;
  readonly participants: number;
  readonly refused: number;
  /**
   * `true` when this call's own work budget (`maxDurationMs`/`maxEvents`)
   * was exhausted before every participant reached the pass's high-water
   * mark (Sol fourth-verdict P1.2: "the fold itself must be budgeted and
   * resumable, not merely the connection-page enumeration around it").
   * `false` for every unbudgeted call (the exact prior behavior) and for a
   * budgeted call that genuinely finished within its budget.
   */
  readonly incomplete: boolean;
  /**
   * The event_seq every INCOMPLETE participant's durable checkpoint was
   * left at this call — a genuine resume cursor, not merely "call again
   * from the beginning." A follow-up call with the SAME `connectorInstanceIds`
   * naturally resumes from here because `seedFoldState` reads each
   * participant's own durable `stream_facts_event_seq`. `null` when this
   * call was not incomplete.
   */
  readonly resumeAfterSeq: number | null;
}

/**
 * Fold terminal-event deltas into every evidence row's per-stream
 * latest-attempt map, checkpointed by terminal `event_seq`. Bounded: reads
 * only events newer than the oldest participating checkpoint (a NULL
 * checkpoint participates from the beginning — the pre-change backfill),
 * batched, and capped at the max sequence observed when the pass started.
 * Returns fold counters; `{ folded: 0 }` when every row is current.
 *
 * `connectorInstanceIds`, when provided, narrows BOTH the evidence-row read
 * this pass fans out from AND the terminal-event high-water/batch reads to
 * exactly that set, at the SQL level (`spine_events.connector_instance_id`,
 * see the `reconcile-active-summary-evidence` migration) — a scoped
 * observation-barrier caller must not pay for every OTHER connection's
 * fold-participation check OR terminal-event history (Sol P1.2: unrelated
 * connections' terminal event volume must not affect a scoped fold's cost or
 * the checkpoint a scoped participant advances to). `null` (the default)
 * preserves the exact prior complete behavior for every existing caller —
 * an unscoped fold's high-water mark is still the true global max, and its
 * batch reads still see every connection's terminal history.
 *
 * `options.maxDurationMs`/`options.maxEvents`, when provided, genuinely
 * bound the batch-drain loop itself (Sol fourth-verdict P1.2: "the fold
 * work inside one connection/page is unbounded — it drains batches in an
 * unconditional loop with no deadline, max-events budget, or fold cursor").
 * Checked BETWEEN batches, never mid-batch, so a batch already in flight
 * always finishes cleanly. When the budget is exhausted before the drain
 * reaches `maxSeq`, EVERY participant's durable checkpoint is written at
 * the cursor position the drain actually reached (via the same
 * compare-and-set write path the complete case uses) — a genuine partial-
 * progress checkpoint, not the pass's full `maxSeq` — so a follow-up call
 * with the same scope resumes from exactly where this call stopped rather
 * than restarting from the beginning or silently skipping the remainder.
 * Omitting both options (the default) preserves the exact prior unbounded
 * behavior for every existing caller.
 */
/**
 * Whether a row must (re-)participate in this fold pass: either its stored
 * checkpoint genuinely lags the pass's high-water mark, OR it is fold-logic-
 * version-behind (see `rowIsFoldLogicVersionBehind`) — in which case it
 * participates regardless of how far its stale checkpoint already advanced,
 * so a fold-semantics fix self-heals every existing row rather than only
 * affecting future terminal events. A row left mid-UPGRADE-REPLAY by a
 * budget-exhausted prior pass needs no separate branch here: its stored
 * `stream_facts_event_seq` is necessarily below `maxSeq` (the drain that
 * wrote it stopped short — see `drainTerminalEventBatches`), so the
 * ordinary checkpoint-lag predicate below already selects it, resuming
 * (not restarting) from its own genuine partial progress. A fold-logic-
 * version-AHEAD row (see `rowIsFoldLogicVersionAhead`) NEVER participates —
 * this binary must not fold, replay, or overwrite output a newer fold
 * contract produced.
 */
function rowNeedsFoldParticipation(row: Row, maxSeq: number | null): boolean {
  if (rowIsFoldLogicVersionAhead(row)) {
    return false;
  }
  // A manifest fingerprint transition intentionally clears the terminal map
  // while retaining the current event high-water as its generation boundary.
  // It still needs one converged fold pass to turn that deliberately stale
  // component into a current, empty post-boundary fact set. The same retry
  // behavior is correct for other recoverable terminal-fold failures.
  if (row.terminal_facts_state !== "current") {
    return true;
  }
  if (rowIsFoldLogicVersionBehind(row)) {
    return true;
  }
  const checkpoint = row.stream_facts_event_seq;
  return checkpoint == null || (maxSeq != null && Number(checkpoint) < maxSeq);
}

/**
 * No terminal events exist yet for this scope: stamp a zero checkpoint on
 * every participant so fresh rows do not re-participate on every pass. This
 * is always a genuinely CONVERGED state — there is no partial replay to
 * complete when there is no terminal history at all — so every write here
 * is `terminal_facts_state = 'current'` with a fresh `stream_latest_facts_json
 * = NULL` (exact replacement, never a stale carry-forward from a superseded
 * fold-logic version). `participants` never includes a fold-logic-version-
 * AHEAD row (`rowNeedsFoldParticipation` already excludes it before this is
 * called) — this binary must never overwrite output a newer fold contract
 * produced. Guarded by the same CAS as the main write path: a participant's
 * baseline here is always its own currently-stored `(event_seq,
 * fold_version)` pair (that is what made it a participant), so a concurrent
 * fold that already stamped it loses this race harmlessly — the row is
 * already current, not regressed.
 */
async function stampZeroCheckpointForBootstrap(
  foldStore: ReturnType<typeof createStreamFactsFoldStore>,
  participants: readonly Row[]
): Promise<void> {
  for (const row of participants) {
    await foldStore.updateStreamFacts({
      connectorInstanceId: String(row.connector_instance_id),
      factsJson: null,
      eventSeq: 0,
      baselineEventSeq: row.stream_facts_event_seq == null ? null : Number(row.stream_facts_event_seq),
      baselineFoldVersion: row.stream_facts_fold_version == null ? null : Number(row.stream_facts_fold_version),
      foldVersion: STREAM_FACTS_FOLD_LOGIC_VERSION,
      terminalFactsState: "current",
      terminalFactsReasonCode: null,
    });
  }
}

/**
 * Drain terminal-event batches from `startCursor` up to `maxSeq`, folding
 * each into `factsByInstance`/`checkpointByInstance`, until either the drain
 * genuinely reaches `maxSeq` or the caller's budget (`deadline`/`maxEvents`)
 * is exhausted. Checked BETWEEN batches, never mid-batch, so a batch already
 * in flight always finishes cleanly (Sol fourth-verdict P1.2). Returns the
 * cursor the drain actually reached and whether the budget cut it short.
 *
 * Each batch read's own `limit` is capped at the REMAINING `maxEvents`
 * budget (`min(STREAM_FACTS_FOLD_BATCH, maxEvents - eventsProcessed)`), not
 * unconditionally `STREAM_FACTS_FOLD_BATCH`. Without this, `maxEvents` is a
 * budget in name only: a single already-in-flight batch read still always
 * requests up to `STREAM_FACTS_FOLD_BATCH` (2000) rows regardless of how
 * small the caller's remaining budget is, so e.g. `maxEvents: 1` against a
 * scope with 2000 attributable events would still process all 2000 in one
 * batch before the between-batches budget check ever gets a second chance
 * to fire — silently processing 2000x the requested bound. Capping the
 * request itself is what makes `maxEvents` an ACTUAL per-call ceiling, not
 * merely an early-exit hint for a batch that was already oversized.
 *
 * The completion check (`batch.length < limit`) compares against the
 * batch's OWN requested `limit` — never the constant
 * `STREAM_FACTS_FOLD_BATCH` — for the identical reason: once `limit` can be
 * smaller than `STREAM_FACTS_FOLD_BATCH`, a budget-capped one-row batch
 * (`limit: 1`, `batch.length: 1`) would otherwise satisfy
 * `batch.length < STREAM_FACTS_FOLD_BATCH` and be misread as "short batch,
 * genuinely reached the end of history" when it was actually just
 * budget-limited.
 *
 * `budgetExhausted` is derived from `cursor === maxSeq` at the point the
 * loop exits — NEVER from which branch returned. A full batch (exactly
 * `limit` rows, where `limit` may itself equal the pass's remaining true
 * high-water distance) whose last event lands exactly on `maxSeq` genuinely
 * converges: the very next iteration's budget check firing first (before
 * that converged batch is even read for size) would otherwise report a
 * false `budgetExhausted: true` despite `cursor` already equaling `maxSeq`
 * — silently leaving a fully-converged pass unable to ever mark itself
 * `current` (see `foldConnectorSummaryStreamFacts`'s convergence gate,
 * which trusts this flag verbatim).
 */
async function drainTerminalEventBatches({
  foldStore,
  factsByInstance,
  checkpointByInstance,
  counters,
  connectorInstanceIds,
  maxSeq,
  startCursor,
  deadline,
  maxEvents,
}: {
  foldStore: ReturnType<typeof createStreamFactsFoldStore>;
  factsByInstance: Map<string, Record<string, StoredStreamFactEntry>>;
  checkpointByInstance: Map<string, number | null>;
  counters: { folded: number; refused: number };
  connectorInstanceIds: readonly string[] | null;
  maxSeq: number;
  startCursor: number;
  deadline: number | null;
  maxEvents: number | null;
}): Promise<{ cursor: number; budgetExhausted: boolean }> {
  let cursor = startCursor;
  let eventsProcessed = 0;
  for (;;) {
    if (cursor >= maxSeq) {
      return { cursor, budgetExhausted: false };
    }
    if ((deadline !== null && Date.now() >= deadline) || (maxEvents !== null && eventsProcessed >= maxEvents)) {
      return { cursor, budgetExhausted: true };
    }
    const limit =
      maxEvents === null ? STREAM_FACTS_FOLD_BATCH : Math.min(STREAM_FACTS_FOLD_BATCH, maxEvents - eventsProcessed);
    const batch = await foldStore.readTerminalFactEvents({
      sinceSeq: cursor,
      maxSeq,
      limit,
      scope: connectorInstanceIds,
    });
    for (const row of batch) {
      foldTerminalEventFacts(factsByInstance, checkpointByInstance, row, counters);
    }
    eventsProcessed += batch.length;
    if (batch.length > 0) {
      cursor = Number((batch.at(-1) as Row).event_seq);
    }
    if (batch.length < limit) {
      return { cursor, budgetExhausted: false };
    }
  }
}

export async function foldConnectorSummaryStreamFacts(
  connectorInstanceIds: readonly string[] | null = null,
  options: { readonly maxDurationMs?: number; readonly maxEvents?: number } = {}
): Promise<FoldStreamFactsResult> {
  const store = createConnectorSummaryStore();
  const foldStore = createStreamFactsFoldStore();
  const rows = (await store.listEvidence(connectorInstanceIds === null ? {} : { connectorInstanceIds })) as Row[];
  if (rows.length === 0) {
    return { folded: 0, participants: 0, refused: 0, incomplete: false, resumeAfterSeq: null };
  }
  const maxSeq = await foldStore.readMaxTerminalEventSeq(connectorInstanceIds);
  const participants = rows.filter((row) => rowNeedsFoldParticipation(row, maxSeq));
  if (participants.length === 0) {
    return { folded: 0, participants: 0, refused: 0, incomplete: false, resumeAfterSeq: null };
  }
  if (maxSeq == null) {
    await stampZeroCheckpointForBootstrap(foldStore, participants);
    return { folded: 0, participants: participants.length, refused: 0, incomplete: false, resumeAfterSeq: null };
  }
  const { factsByInstance, checkpointByInstance, casBaselineByInstance, sinceSeq } = seedFoldState(participants);
  // Test-only: see `testOnlyFoldPauseHook` — a no-op unless a test installs
  // a hook. Held here, immediately after the baseline (checkpointByInstance)
  // is captured and before this pass's own terminal-event read/CAS write —
  // the exact window Sol's verdict named ("deterministic pause hooks around
  // high-water capture and CAS write") for making two REAL, genuinely
  // overlapping `foldConnectorSummaryStreamFacts()` calls deterministically
  // interleave, instead of one pass completing before the next starts.
  await testOnlyFoldPauseHook("after_seed_before_read");
  const counters = { folded: 0, refused: 0 };
  const drain = await drainTerminalEventBatches({
    foldStore,
    factsByInstance,
    checkpointByInstance,
    counters,
    connectorInstanceIds,
    maxSeq,
    startCursor: Number.isFinite(sinceSeq) ? sinceSeq : 0,
    deadline: typeof options.maxDurationMs === "number" ? Date.now() + options.maxDurationMs : null,
    maxEvents: typeof options.maxEvents === "number" ? options.maxEvents : null,
  });
  const { cursor, budgetExhausted } = drain;
  // Every participant advances to the pass's max sequence when the drain
  // genuinely reached it — all attributable events at or below it have
  // been folded, so later passes read only the delta. When the budget was
  // exhausted first, every participant instead advances only to `cursor`
  // (the exact event_seq the drain actually reached) — a genuine partial-
  // progress checkpoint a follow-up call resumes from, never the pass's
  // full `maxSeq` (which would falsely claim events between `cursor` and
  // `maxSeq` were folded when they were not).
  //
  // Compare-and-set against each participant's baseline checkpoint (the
  // value read at seedFoldState time, before this pass's work began): if a
  // concurrent fold already advanced the row past that baseline, this
  // write's `stream_facts_event_seq IS <baseline>` predicate matches zero
  // rows and the CAS silently no-ops rather than overwriting the newer
  // fact map with this pass's now-stale in-memory one. An older pass may
  // never overwrite a newer fact map/checkpoint (design.md "Monotonic
  // terminal-fact fold").
  // Test-only: see `testOnlyFoldPauseHook` — the second deterministic pause
  // point, immediately before this pass's own CAS write loop.
  await testOnlyFoldPauseHook("before_cas_write");
  const writeSeq = budgetExhausted ? cursor : maxSeq;
  // A pass CONVERGED — reached the pass's true high-water mark, not merely
  // "this pass's own budget check didn't fire" — only when the drain
  // itself was not cut short (`!budgetExhausted`, itself now correctly
  // derived from `cursor === maxSeq`; see `drainTerminalEventBatches`).
  // This is a SINGLE pass-wide flag, not a per-participant one: a
  // budget-exhausted pass leaves EVERY participant's write this round
  // genuinely incomplete (their own `eventSeq` write is `cursor`, strictly
  // below `maxSeq`), so the existing checkpoint-lag participation predicate
  // is what actually drives correct multi-round resumption — no reason-keyed
  // state machine is needed on top of it.
  const replayConverged = !budgetExhausted;
  for (const [instanceId, facts] of factsByInstance) {
    await writeParticipantStreamFacts(
      foldStore,
      instanceId,
      facts,
      writeSeq,
      replayConverged,
      checkpointByInstance,
      casBaselineByInstance
    );
  }
  return {
    folded: counters.folded,
    participants: participants.length,
    refused: counters.refused,
    incomplete: budgetExhausted,
    resumeAfterSeq: budgetExhausted ? writeSeq : null,
  };
}

/**
 * Write one participant's folded fact map, computing its two DISTINCT
 * anchors (see `seedFoldState`'s `FoldCasBaseline` doc): the write's own
 * `eventSeq` is floored at the participant's EFFECTIVE replay checkpoint
 * (never regressing below it — design.md "Monotonic terminal-fact fold"; a
 * version-behind row's effective checkpoint is NULL, so its floor is simply
 * `writeSeq`), while the CAS predicate compares against the row's TRUE
 * currently-stored `(event_seq, fold_version)` pair captured at seed time —
 * which differs from the effective checkpoint by design for a version-behind
 * row (see `FoldCasBaseline`'s doc for why conflating the two would make the
 * healing write's CAS predicate never match).
 *
 * Convergence gate (owner-reviewed correction, applied UNIVERSALLY — not
 * only to a version-upgrading participant): `stream_facts_fold_version` is
 * ALWAYS stamped to `STREAM_FACTS_FOLD_LOGIC_VERSION` (the merge semantics
 * that produced this write's output ARE the current version, whether or not
 * this pass converged — holding the version field back would make the row
 * look version-behind again next pass and restart its replay from scratch;
 * see `rowIsFoldLogicVersionBehind`'s doc). What DOES depend on
 * `replayConverged` is `terminal_facts_state`: `'current'` (reason cleared)
 * when this pass's drain genuinely reached `maxSeq`, else `'stale'` with a
 * precise, stable reason (`terminal_fold_incomplete`) so
 * `evidenceUnreliableSources` surfaces the row as unreliable through the
 * EXISTING failure boundary rather than letting a partial/incomplete
 * replay be read as trusted evidence. Because an incomplete pass's own
 * `eventSeq` write is strictly below `maxSeq` (`writeSeq = cursor` when
 * `budgetExhausted`), `rowNeedsFoldParticipation`'s ordinary checkpoint-lag
 * predicate alone already guarantees the row participates again next pass
 * and RESUMES (never restarts) from this exact partial progress.
 */
async function writeParticipantStreamFacts(
  foldStore: ReturnType<typeof createStreamFactsFoldStore>,
  instanceId: string,
  facts: Record<string, StoredStreamFactEntry>,
  writeSeq: number,
  replayConverged: boolean,
  checkpointByInstance: Map<string, number | null>,
  casBaselineByInstance: Map<string, FoldCasBaseline>
): Promise<void> {
  const effectiveCheckpoint = checkpointByInstance.get(instanceId) ?? null;
  const participantEventSeq = effectiveCheckpoint == null ? writeSeq : Math.max(writeSeq, effectiveCheckpoint);
  const casBaseline = casBaselineByInstance.get(instanceId) ?? { eventSeq: null, foldVersion: null };
  await foldStore.updateStreamFacts({
    connectorInstanceId: instanceId,
    factsJson: Object.keys(facts).length > 0 ? JSON.stringify(facts) : null,
    eventSeq: participantEventSeq,
    baselineEventSeq: casBaseline.eventSeq,
    baselineFoldVersion: casBaseline.foldVersion,
    foldVersion: STREAM_FACTS_FOLD_LOGIC_VERSION,
    terminalFactsState: replayConverged ? "current" : "stale",
    terminalFactsReasonCode: replayConverged ? null : REASON_CODES.TERMINAL_FOLD_INCOMPLETE,
  });
}

/**
 * Fold wrapper used by reconcile/rebuild: a fold failure marks every row
 * stale with the sanitized error and reports `ok: false` so the caller can
 * SKIP the normal dirty-row refresh — running it would immediately re-clean
 * the rows (`state = 'fresh'`, `last_error = NULL`) and erase the failure it
 * just recorded, serving stale stream facts under a fresh evidence envelope.
 * The projection's missing-facts default (unknown coverage) stays truthful
 * while the fold retries on the next pass.
 *
 * `connectorInstanceIds`, when provided, narrows the fold's own evidence-row
 * fan-out AND its terminal-event high-water/batch reads to exactly that set
 * (Sol P1.2) — an unrelated connection's terminal-event volume no longer
 * affects a scoped fold's cost or the checkpoint a scoped participant
 * advances to. `null` (the default) preserves the exact prior complete
 * behavior.
 *
 * `options.maxDurationMs`/`options.maxEvents`, when provided, thread
 * straight through to `foldConnectorSummaryStreamFacts`'s own budget (Sol
 * fourth-verdict P1.2) — the returned `incomplete`/`resumeAfterSeq` surface
 * exactly what that call reports, so `runBoundedSummaryEvidenceSweep` can
 * genuinely resume an interrupted fold rather than only paging connections.
 *
 * On failure, also returns the in-memory typed failed-row overlay for
 * exactly the ids whose durable failure-marker write also failed this call
 * (Sol P1.1) — `observeConnectorSummaryEvidence` merges it into its own
 * `failedRows` result alongside the repair engine's, so a caller reading
 * evidence in the same barrier pass sees the fold failure even when nothing
 * about it could be durably written this pass.
 */
async function foldStreamFactsBestEffort(
  connectorInstanceIds: readonly string[] | null = null,
  options: { readonly maxDurationMs?: number; readonly maxEvents?: number } = {}
): Promise<{
  ok: boolean;
  failedRows: ReadonlyMap<string, Row>;
  incomplete: boolean;
  resumeAfterSeq: number | null;
}> {
  try {
    const result = await foldConnectorSummaryStreamFacts(connectorInstanceIds, options);
    return { ok: true, failedRows: new Map(), incomplete: result.incomplete, resumeAfterSeq: result.resumeAfterSeq };
  } catch (err) {
    // A fold failure is specifically a terminal-facts failure: nothing this
    // pass could verify about any row's per-stream latest-attempt facts.
    // Durably degrade terminal_facts_state (not just the generic dirty/state
    // columns) so `evidenceUnreliableSources` sees the specific failure.
    // Scoped to the same set the fold itself was scoped to — an unscoped
    // failure-mark here would degrade every OTHER connection's terminal
    // facts too, which is not what a scoped fold's own failure proves.
    const failedRows = await markTerminalFactsFailedForAllRows(err, connectorInstanceIds);
    return { ok: false, failedRows, incomplete: false, resumeAfterSeq: null };
  }
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * The one internal observation barrier (design.md "Central consumer and
 * cache boundary"): discover+repair every row the complete canonical
 * `connector_instances` set classifies as needing it (missing, dirty,
 * checkpoint-mismatched, manifest-mismatched, terminal-lagging,
 * retained-bytes-changed — see `reconcileConnectorSummaryEvidence` in
 * `connector-summary-evidence-engine.ts`), THEN fold terminal-event deltas
 * against the now-current row set. Reconcile must run first: a row that
 * does not exist yet (first-ever observation) has nothing for the fold to
 * touch, and a newly (re)inserted row carries a NULL fold checkpoint, which
 * the fold treats as "participates from the beginning" (see
 * `foldConnectorSummaryStreamFacts`) — so a single call to this function
 * both creates AND backfills a brand-new connection's terminal history in
 * one pass. `terminal_facts` therefore reads `unobserved` ONLY when the
 * fold has genuinely never completed for that row (e.g. it failed and left
 * the row stale) — never merely because discovery and fold happened to run
 * in one barrier call rather than two.
 *
 * On fold failure the affected rows were already marked stale with the
 * sanitized error by the fold itself; this does not re-run reconcile
 * against them (that would immediately re-clean and erase the just-recorded
 * failure).
 *
 * `connectorInstanceIds`, when provided, narrows the reconcile/discovery/
 * repair phase to exactly that set (see `reconcileConnectorSummaryEvidence`
 * in `connector-summary-evidence-engine.ts`) — a scoped consumer that
 * already knows the one connection it needs must not pay for a complete
 * census. Defaults to `null` (complete census), preserving the exact prior
 * behavior for every caller that does not pass a scope.
 *
 * `options.maxDurationMs`, when provided, bounds TOTAL wall-clock time
 * across BOTH the repair phase AND the fold phase together (Sol fourth-
 * verdict P1.2: "the fold itself must be budgeted... within a
 * connection"): the repair phase spends first, and whatever remains of the
 * budget (never less than zero) is what the fold phase itself receives via
 * `foldConnectorSummaryStreamFacts`'s own `maxDurationMs` — the fold is no
 * longer unconditionally unbounded merely because `observeConnectorSummaryEvidence`
 * itself was called with a budget. `options.maxEvents`, when provided, is
 * the fold's own separate max-events budget (repair has no per-candidate
 * event count to bound by). Omitting both preserves the exact prior
 * complete/unbounded behavior for every existing caller (every read-time
 * consumer; only startup's bounded sweep passes these).
 *
 * Returns `{ reconciled, incomplete, resumeAfterSeq }`: `reconciled` is the
 * count of candidates repaired plus rows dropped by orphan cleanup.
 * `incomplete`/`resumeAfterSeq` surface the FOLD's own budget outcome (Sol
 * P1.2) — `true`/non-null only when a fold budget was supplied and
 * genuinely exhausted before every participant reached the pass's
 * high-water mark.
 *
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 */
async function observeConnectorSummaryEvidence(
  connectorInstanceIds: readonly string[] | null = null,
  options: { readonly maxCandidates?: number; readonly maxDurationMs?: number; readonly maxEvents?: number } = {}
): Promise<{
  reconciled: number;
  skipped: number;
  failedRows: ReadonlyMap<string, Row>;
  incomplete: boolean;
  resumeAfterSeq: number | null;
}> {
  const overallDeadline = typeof options.maxDurationMs === "number" ? Date.now() + options.maxDurationMs : null;
  let result: { repaired: number; skipped: number; failedRows: ReadonlyMap<string, Row> };
  try {
    result = await reconcileConnectorSummaryEvidence(connectorInstanceIds, options);
  } catch (err) {
    // Discovery itself failed (e.g. a canonical-authority table is
    // unreadable) — broader than any one row's repair failure: NOTHING
    // about ANY row's canonical facts could be verified this pass, so
    // record_snapshot and manifest_declaration (the components discovery
    // itself is responsible for classifying) must not keep reading
    // `current`. Durably degrade both, in addition to the generic
    // dirty/stale marking. The next call's discovery retries from scratch.
    // Scoped to the same set discovery itself was scoped to (Sol P1.2) — a
    // scoped caller's discovery failure says nothing about every OTHER
    // connection's canonical facts, so an unscoped caller here would
    // degrade siblings this pass never even attempted to read.
    //
    // The returned overlay (Sol P1.1) carries the ids whose durable
    // discovery-failure marker ALSO failed this call — this observation's
    // `failedRows` result surfaces them even though nothing durable
    // reflects the failure.
    const failedRows = await markAllConnectorSummaryEvidenceDiscoveryFailed(err, connectorInstanceIds);
    return { reconciled: 0, skipped: 0, failedRows, incomplete: false, resumeAfterSeq: null };
  }
  // The fold's own in-memory overlay (Sol P1.1) is merged in alongside the
  // repair engine's: both are keyed by connector_instance_id and represent
  // disjoint failure causes (repair-candidate failure vs. fold failure), so
  // a plain later-wins spread is safe — no id can appear in both maps from
  // the same pass (a row the repair engine failed to even reconcile never
  // reaches the fold's scoped participant set as a distinct fold failure
  // beyond the generic durable stale-mark the fold failure applies to it
  // too, which this overlay only supersedes with strictly MORE specific
  // typed failure detail, never less).
  const foldBudget: { maxDurationMs?: number; maxEvents?: number } = {};
  if (overallDeadline !== null) {
    // Whatever remains of the overall budget after repair spent its share —
    // floored at 0 so a repair phase that already exhausted the budget
    // still gives the fold phase a genuine (zero-work) bounded call rather
    // than an unbounded one.
    foldBudget.maxDurationMs = Math.max(0, overallDeadline - Date.now());
  }
  if (typeof options.maxEvents === "number") {
    foldBudget.maxEvents = options.maxEvents;
  }
  const foldOutcome = await foldStreamFactsBestEffort(connectorInstanceIds, foldBudget);
  const failedRows =
    foldOutcome.failedRows.size === 0 ? result.failedRows : new Map([...result.failedRows, ...foldOutcome.failedRows]);
  return {
    reconciled: result.repaired,
    skipped: result.skipped,
    failedRows,
    incomplete: foldOutcome.incomplete,
    resumeAfterSeq: foldOutcome.resumeAfterSeq,
  };
}

/**
 * Rebuild every connector-summary evidence row from canonical durable
 * state: the one observation barrier scoped to the complete canonical
 * `connector_instances` set. Rows for connections that no longer exist in
 * that set are removed (complete-census orphan cleanup, inside
 * `reconcileConnectorSummaryEvidence`).
 *
 * Returns the maintained evidence rows (post-observation).
 *
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 */
export async function rebuildConnectorSummaryEvidence() {
  await observeConnectorSummaryEvidence();
  return listConnectorSummaryEvidence();
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * The barrier every `/_ref/connectors` consumer (list, scoped route, owner
 * diagnostics, scheduler) calls before synthesizing a summary — over the
 * COMPLETE canonical `connector_instances` set, not filtered to `dirty = 1`
 * rows. Filtering to only-dirty was the exact defect design.md fixes: a
 * MISSING row (no evidence row at all) has no `dirty` flag to filter on, so
 * a dirty-only pass could never discover it. Batched discovery classifies
 * every row against canonical authorities regardless of its own dirty
 * claim; only classified candidates take the writer fence and get
 * repaired, so an idle system with no changes still does a fixed number of
 * reads and zero repairs — this is not "always touch every row."
 *
 * Delegates to the same reconcile-then-fold barrier `rebuildConnectorSummaryEvidence`
 * uses, so a single call from a cold (missing-row) start fully converges:
 * creates the row, then folds its terminal history — never leaving a
 * caller needing a second call to reach `current`.
 *
 * `connectorInstanceIds`, when provided, narrows the reconcile/discovery/
 * repair phase to exactly that connection set — a scoped consumer (a route
 * that already resolved the one `connectorInstanceId` it needs) must not
 * pay for a complete census of every other connection the owner has.
 * Defaults to `null` (complete census), the exact existing behavior, so
 * every caller that does not pass a scope is unaffected. List/dashboard
 * reads that genuinely need the complete set (`computeConnectorSummaries`,
 * the bare `/_ref/connectors` list route's pre-fetch) correctly keep
 * calling this with no scope.
 *
 * `options.maxCandidates`/`options.maxDurationMs`, when provided, bound the
 * repair loop AND the fold THIS call runs — by candidate count and/or total
 * wall-clock time spanning both phases together (design.md "Startup is
 * acceleration, not authority"; Sol P2.2 closed the gap where a small
 * candidate count did not bound total time when individual repairs are
 * slow; Sol fourth-verdict P1.2 closed the further gap where the fold
 * itself, within one connection, was unconditionally unbounded regardless
 * of this option) — used ONLY by the startup one-shot acceleration pass,
 * never by a read-time consumer, which always needs the complete unbounded
 * repair+fold. `options.maxEvents`, when provided, additionally bounds the
 * fold's own event-count budget. `skipped` in the return value counts
 * candidates a bounded pass declined to repair; they are never lost, only
 * deferred to the next observation. `incomplete`/`resumeAfterSeq` surface
 * the fold's own budget outcome (Sol P1.2) for the caller to resume.
 *
 * Returns `{ reconciled, skipped, incomplete, resumeAfterSeq }`:
 * `reconciled` is the count of candidates repaired plus rows dropped by
 * orphan cleanup.
 *
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 */
export async function reconcileDirtyConnectorSummaryEvidence(
  connectorInstanceIds: readonly string[] | null = null,
  options: { readonly maxCandidates?: number; readonly maxDurationMs?: number; readonly maxEvents?: number } = {}
) {
  return observeConnectorSummaryEvidence(connectorInstanceIds, options);
}

// ---------------------------------------------------------------------------
// Resumable bounded sweep — a genuine deadline spanning discovery + fold +
// repair across the COMPLETE set, not just a repair-loop count/time cap
// (Sol P2.2: "maxDurationMs checked only inside the repair loop does NOT
// close Sol's finding... a full discovery can already exceed the budget
// before the loop begins, and an unscoped fold can exceed it afterward").
// ---------------------------------------------------------------------------

export interface BoundedSweepResult {
  /** Total instances discovered+repaired+considered across every page processed this call. */
  readonly discovered: number;
  readonly repaired: number;
  readonly skipped: number;
  /**
   * `true` when the sweep reached the deadline (or the page-count cap)
   * before covering the complete canonical set, OR when a page's OWN fold
   * exhausted its per-page budget before every participant in that page
   * converged (Sol fourth-verdict P1.2: "gate prunedComplete on both a
   * complete canonical connection census and complete folds") — the caller
   * should NOT treat this as a correctness gate (design.md "Startup is
   * acceleration, not authority": the unbounded read-time barrier always
   * covers whatever this sweep missed). `resumeAfterId`, when set, is the
   * exact cursor position to resume from on a follow-up call — for a
   * fold-incomplete page this is the id BEFORE that page (not past it), so
   * a follow-up call revisits the SAME still-incomplete page's connections
   * rather than skipping past them.
   */
  readonly incomplete: boolean;
  readonly resumeAfterId: string | null;
  /** Complete-set orphan pruning only ran when the sweep covered every page AND every page's fold genuinely converged this call (see below). */
  readonly prunedComplete: boolean;
}

/**
 * Resumable, genuinely bounded observation sweep spanning discovery + FOLD
 * + repair TOGETHER for every page it processes, not just a repair-loop
 * count/time cap (Sol P2.2), AND genuinely bounding the fold WITHIN one
 * page/connection (Sol fourth-verdict P1.2: "`runBoundedSummaryEvidenceSweep`
 * checks its deadline only before starting a page. Once a page starts, the
 * entire discovery/repair/fold runs regardless of elapsed time" — reproduced
 * deterministically: one connection with 2,001 attributable terminal
 * events, a 1ms budget, still folded all 2,001 events and returned
 * `incomplete:false`/`prunedComplete:true` in ~6ms).
 *
 * Processes the canonical `connector_instances` set in small, stable-cursor
 * pages (`readInstanceIdPage`, keyset pagination — correct under concurrent
 * inserts/deletes between pages). Each page is handed to
 * `observeConnectorSummaryEvidence(pageIds, {maxDurationMs, maxEvents})` —
 * the SAME scoped discovery+fold+repair+prune barrier every read-time
 * consumer uses (Sol P1.2 (third verdict) scoped every phase, including
 * the fold, to exactly the requested id set; Sol P1.2 (fourth verdict)
 * makes the fold phase itself genuinely stop draining once its own budget
 * is spent, writing each participant's durable checkpoint at the exact
 * cursor position the drain reached rather than falsely claiming complete
 * coverage). The page-level deadline is checked BETWEEN pages so a page
 * already starting always gets its full remaining-budget allotment;
 * that allotment is what genuinely bounds the fold's OWN batch-drain loop
 * within the page (never mid-batch).
 *
 * Complete-set orphan pruning (deleting evidence for connections whose
 * connector_instances row is entirely gone — distinct from the scoped
 * per-page pruning each page's `observeConnectorSummaryEvidence` call
 * already runs, which only proves ONE requested id is gone) only runs when
 * this call's pages covered the ENTIRE canonical set before the deadline
 * AND every page's own fold genuinely converged (never reported
 * `incomplete`) — a partial page census OR a page whose fold stopped
 * partway through cannot safely run it (an undiscovered page's connections,
 * or a page whose fold left terminal history unfolded, would look
 * indistinguishable from truly orphaned/current ones).
 *
 * `options.maxDurationMs` bounds total wall-clock time across every phase
 * of every page — checked before starting each page's full
 * discovery+fold+repair+prune, so it genuinely bounds the phases Sol's
 * verdict named, not merely the repair loop inside one page; each page's
 * OWN discovery+repair+fold additionally receives the SAME remaining-time
 * budget as its own per-page deadline (via `observeConnectorSummaryEvidence`'s
 * `maxDurationMs`), so a single expensive page cannot itself blow through
 * the deadline unnoticed. `options.maxEventsPerFold`, when provided,
 * additionally bounds each page's fold by event count, independent of
 * time. `options.maxPages` additionally caps the number of pages processed
 * this call. `options.pageSize` controls how many connections each page
 * covers.
 */
export async function runBoundedSummaryEvidenceSweep(options: {
  readonly maxDurationMs: number;
  readonly maxPages?: number;
  readonly pageSize?: number;
  readonly afterId?: string | null;
  readonly maxEventsPerFold?: number;
}): Promise<BoundedSweepResult> {
  const deadline = Date.now() + options.maxDurationMs;
  const pageSize = options.pageSize ?? 25;
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;

  let discovered = 0;
  let repaired = 0;
  let skipped = 0;
  let cursor = options.afterId ?? null;
  // The cursor position BEFORE the page currently being processed — used
  // as the resume point when that page's OWN fold is incomplete, so a
  // follow-up call revisits this exact page's connections rather than
  // advancing past them (the connection-page cursor alone cannot express
  // "this page started but its fold did not finish").
  let cursorBeforeCurrentPage = cursor;
  let pages = 0;
  let coveredCompleteSet = false;
  let anyFoldIncomplete = false;

  for (;;) {
    if (Date.now() >= deadline || pages >= maxPages) {
      break;
    }
    const pageIds = await readInstanceIdPage(cursor, pageSize);
    if (pageIds.length === 0) {
      coveredCompleteSet = true;
      break;
    }
    pages += 1;
    cursorBeforeCurrentPage = cursor;
    // Full discovery + fold + repair + scoped-prune for exactly this page —
    // the same barrier a scoped read-time consumer runs, so the whole unit
    // is bounded by pageSize, not by N. Never started once the deadline has
    // already passed (checked above); once started, it always completes
    // its discovery+repair phases, and its fold phase is itself genuinely
    // bounded by this page's remaining time (and optionally event count).
    const remainingMs = Math.max(0, deadline - Date.now());
    const pageResult = await observeConnectorSummaryEvidence(pageIds, {
      maxDurationMs: remainingMs,
      ...(typeof options.maxEventsPerFold === "number" ? { maxEvents: options.maxEventsPerFold } : {}),
    });
    discovered += pageIds.length;
    repaired += pageResult.reconciled;
    skipped += pageResult.skipped;
    if (pageResult.incomplete) {
      // This page's fold did not fully converge within its budget — the
      // sweep as a whole is incomplete regardless of how many pages
      // followed, and the resume point is BEFORE this page (not past it),
      // so a follow-up call revisits exactly the connections that did not
      // finish rather than skipping them.
      anyFoldIncomplete = true;
      cursor = cursorBeforeCurrentPage;
      break;
    }
    cursor = pageIds[pageIds.length - 1] ?? cursor;
    if (pageIds.length < pageSize) {
      // Short page: this was genuinely the last page of the complete set.
      coveredCompleteSet = true;
      break;
    }
  }

  let prunedComplete = false;
  if (coveredCompleteSet && !anyFoldIncomplete) {
    // The sweep's own pages already scoped-pruned every id they discovered
    // was gone. What per-page scoped pruning CANNOT catch: an evidence row
    // whose connector_instance_id was NEVER discovered by any page at all —
    // impossible if every page's ids came from the same live instance
    // table, EXCEPT for evidence rows that are pure orphans (their
    // connector_instances row is gone, so no page ever produced their id).
    // A genuinely complete run (every page covered, none skipped, every
    // fold genuinely converged) is safe to complete-prune exactly like
    // `reconcileConnectorSummaryEvidence(null)` does, using the same
    // complete live-instance read and prune primitive.
    const liveInstanceRows = await readAllInstanceIdsForPruning();
    const dropped = await pruneOrphanedEvidenceComplete(liveInstanceRows);
    repaired += dropped;
    prunedComplete = true;
  }

  const incomplete = !coveredCompleteSet || anyFoldIncomplete;
  return {
    discovered,
    repaired,
    skipped,
    incomplete,
    resumeAfterId: incomplete ? cursor : null,
    prunedComplete,
  };
}
