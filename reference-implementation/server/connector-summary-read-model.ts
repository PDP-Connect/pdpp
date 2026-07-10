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
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "./postgres-storage.js";

// Reference-only convention: the owner runs one personal server, so every
// connector_instances row is the owner's. Rebuild scopes to this subject the
// same way the connector-summary projection does. Kept as a constant so a
// future multi-owner reference can thread it through without a code search.
const REFERENCE_OWNER_SUBJECT_ID = "owner_local";

/** A raw database row (column-keyed) crossing the untyped storage boundary. */
type Row = Record<string, unknown>;

/** A better-sqlite3 database handle (untyped across the `db.js` boundary). */
// biome-ignore lint/suspicious/noExplicitAny: the db.js boundary is untyped.
type Db = any;

/** Per-connection count evidence accumulated from the stream projection. */
interface CountEvidence {
  stream_count: number;
  stream_records: Array<{ stream: unknown; record_count: number; last_updated: null }>;
  total_records: number;
}

/** Byte totals derived from the retained-size projection. */
interface RetainedBytes {
  blob_bytes: number;
  record_changes_json_bytes: number;
  record_json_bytes: number;
  total_bytes: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Strip anything that looks like a credential/token (long base64-ish runs)
 * out of an error string before it lands in durable metadata, and bound the
 * length. Same contract as the retained-size projection's sanitizer.
 */
function sanitizeProjectionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || "unknown error");
  return message.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(0, 240);
}

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

function emptyRetainedBytes(): RetainedBytes {
  return {
    record_json_bytes: 0,
    record_changes_json_bytes: 0,
    blob_bytes: 0,
    total_bytes: 0,
  };
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
      async listEvidence({ connectorInstanceId }: { connectorInstanceId?: string | null | undefined } = {}) {
        const params: string[] = [];
        let where = "";
        if (connectorInstanceId) {
          params.push(connectorInstanceId);
          where = `WHERE connector_instance_id = $${params.length}`;
        }
        const result = await postgresQuery(
          `SELECT connector_instance_id, connector_id, display_name, status, source_kind,
                  revoked_at, total_records, stream_count, last_record_updated_at,
                  stream_records_json, retained_bytes_json, total_retained_bytes,
                  stream_latest_facts_json, stream_facts_event_seq,
                  dirty, computed_at, source_event_seq, state, last_error
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
      async listConnectorInstanceRows() {
        const result = await postgresQuery(
          `SELECT connector_instance_id, connector_id, display_name, status, source_kind, revoked_at
             FROM connector_instances
            WHERE owner_subject_id = $1
            ORDER BY connector_instance_id ASC`,
          [REFERENCE_OWNER_SUBJECT_ID]
        );
        return result.rows;
      },
      async listStreamCountRows() {
        const result = await postgresQuery(
          `SELECT connector_instance_id,
                  stream,
                  record_count
             FROM retained_size_stream
            ORDER BY connector_instance_id ASC, stream ASC`
        );
        return result.rows;
      },
      async listRetainedBytesRows() {
        const result = await postgresQuery(
          `SELECT connector_instance_id,
                  current_record_json_bytes,
                  record_history_json_bytes,
                  blob_bytes
             FROM retained_size_connection`
        );
        return result.rows;
      },
    };
  }
  return {
    listEvidence({ connectorInstanceId }: { connectorInstanceId?: string | null | undefined } = {}) {
      const db = getDb();
      return connectorInstanceId
        ? db
            .prepare(
              `SELECT connector_instance_id, connector_id, display_name, status, source_kind,
                    revoked_at, total_records, stream_count, last_record_updated_at,
                    stream_records_json, retained_bytes_json, total_retained_bytes,
                    stream_latest_facts_json, stream_facts_event_seq,
                    dirty, computed_at, source_event_seq, state, last_error
               FROM connector_summary_evidence
              WHERE connector_instance_id = ?
              ORDER BY connector_instance_id ASC`
            )
            .all(connectorInstanceId)
        : db
            .prepare(
              `SELECT connector_instance_id, connector_id, display_name, status, source_kind,
                    revoked_at, total_records, stream_count, last_record_updated_at,
                    stream_records_json, retained_bytes_json, total_retained_bytes,
                    stream_latest_facts_json, stream_facts_event_seq,
                    dirty, computed_at, source_event_seq, state, last_error
               FROM connector_summary_evidence
              ORDER BY connector_instance_id ASC`
            )
            .all();
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
    listConnectorInstanceRows() {
      return getDb()
        .prepare(
          `SELECT connector_instance_id, connector_id, display_name, status, source_kind, revoked_at
             FROM connector_instances
            WHERE owner_subject_id = ?
            ORDER BY connector_instance_id ASC`
        )
        .all(REFERENCE_OWNER_SUBJECT_ID);
    },
    listStreamCountRows() {
      return getDb()
        .prepare(
          `SELECT connector_instance_id,
                  stream,
                  record_count
             FROM retained_size_stream
            ORDER BY connector_instance_id ASC, stream ASC`
        )
        .all();
    },
    listRetainedBytesRows() {
      return getDb()
        .prepare(
          `SELECT connector_instance_id,
                  current_record_json_bytes,
                  record_history_json_bytes,
                  blob_bytes
             FROM retained_size_connection`
        )
        .all();
    },
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List maintained connector-summary evidence rows. Optionally narrow to one
 * connection by `connectorInstanceId`. Returns DURABLE evidence only — callers
 * synthesize freshness/health/verdict on read.
 */
export async function listConnectorSummaryEvidence({
  connectorInstanceId,
}: {
  connectorInstanceId?: string | null | undefined;
} = {}) {
  const store = createConnectorSummaryStore();
  const rows = await store.listEvidence({ connectorInstanceId });
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

function shapeEvidenceRow(row: Row) {
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
    retained_bytes: parseEvidenceJson(row.retained_bytes_json, emptyRetainedBytes()),
    total_retained_bytes: Number(row.total_retained_bytes || 0),
    dirty: Number(row.dirty || 0) !== 0,
    computed_at: row.computed_at || null,
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
// replaces older proof even when unresolved (failure is never masked by
// history). The connection is the isolation key: an event without a
// `connector_instance_id`/`connection_id` (legacy connector-wide) is refused,
// never attributed.
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

/** One stored latest-attempt entry: the raw runtime fact plus its provenance. */
interface StoredStreamFactEntry {
  event_seq: number;
  evidence_as_of: string | null;
  fact: Row;
  run_id: string | null;
}

function createStreamFactsFoldStore() {
  if (isPostgresStorageBackend()) {
    return {
      async readMaxTerminalEventSeq(): Promise<number | null> {
        const result = await postgresQuery(
          `SELECT MAX(event_seq) AS max_seq FROM spine_events WHERE event_type IN (${TERMINAL_TYPES_SQL})`
        );
        const value = (result.rows[0] as Row | undefined)?.max_seq;
        return value == null ? null : Number(value);
      },
      async readTerminalFactEvents({ sinceSeq, maxSeq, limit }: { sinceSeq: number; maxSeq: number; limit: number }) {
        const result = await postgresQuery(
          `SELECT event_seq, occurred_at, run_id, data_json::text AS data_json
             FROM spine_events
            WHERE event_type IN (${TERMINAL_TYPES_SQL})
              AND event_seq > $1 AND event_seq <= $2
            ORDER BY event_seq ASC
            LIMIT $3`,
          [sinceSeq, maxSeq, limit]
        );
        return result.rows as Row[];
      },
      async updateStreamFacts({
        connectorInstanceId,
        factsJson,
        eventSeq,
      }: {
        connectorInstanceId: string;
        factsJson: string | null;
        eventSeq: number;
      }) {
        await postgresQuery(
          `UPDATE connector_summary_evidence
              SET stream_latest_facts_json = COALESCE($2::jsonb, stream_latest_facts_json),
                  stream_facts_event_seq = $3
            WHERE connector_instance_id = $1`,
          [connectorInstanceId, factsJson, eventSeq]
        );
      },
    };
  }
  return {
    readMaxTerminalEventSeq(): number | null {
      const row = getDb()
        .prepare(`SELECT MAX(event_seq) AS max_seq FROM spine_events WHERE event_type IN (${TERMINAL_TYPES_SQL})`)
        .get() as Row | undefined;
      const value = row?.max_seq;
      return value == null ? null : Number(value);
    },
    readTerminalFactEvents({ sinceSeq, maxSeq, limit }: { sinceSeq: number; maxSeq: number; limit: number }) {
      return getDb()
        .prepare(
          `SELECT event_seq, occurred_at, run_id, data_json
             FROM spine_events
            WHERE event_type IN (${TERMINAL_TYPES_SQL})
              AND event_seq > ? AND event_seq <= ?
            ORDER BY event_seq ASC
            LIMIT ?`
        )
        .all(sinceSeq, maxSeq, limit) as Row[];
    },
    updateStreamFacts({
      connectorInstanceId,
      factsJson,
      eventSeq,
    }: {
      connectorInstanceId: string;
      factsJson: string | null;
      eventSeq: number;
    }) {
      getDb()
        .prepare(
          `UPDATE connector_summary_evidence
              SET stream_latest_facts_json = COALESCE(?, stream_latest_facts_json),
                  stream_facts_event_seq = ?
            WHERE connector_instance_id = ?`
        )
        .run(factsJson, eventSeq, connectorInstanceId);
    },
  };
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

/** Merge one event's stream facts into a connection's map: newest attempt wins per stream. */
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
    // fact replaces an earlier one — the newest ATTEMPT wins per stream,
    // resolved or not.
    if (!existing || existing.event_seq <= provenance.eventSeq) {
      facts[stream] = {
        fact: rawFact as Row,
        evidence_as_of: provenance.evidenceAsOf,
        run_id: provenance.runId,
        event_seq: provenance.eventSeq,
      };
      counters.folded += 1;
    }
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

/** Seed the fold's in-memory state from the participating evidence rows. */
function seedFoldState(participants: readonly Row[]): {
  checkpointByInstance: Map<string, number | null>;
  factsByInstance: Map<string, Record<string, StoredStreamFactEntry>>;
  sinceSeq: number;
} {
  const factsByInstance = new Map<string, Record<string, StoredStreamFactEntry>>();
  const checkpointByInstance = new Map<string, number | null>();
  let sinceSeq = Number.POSITIVE_INFINITY;
  for (const row of participants) {
    const instanceId = String(row.connector_instance_id);
    const parsed = parseEvidenceJson(row.stream_latest_facts_json, null);
    factsByInstance.set(
      instanceId,
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, StoredStreamFactEntry>) }
        : {}
    );
    const checkpoint = row.stream_facts_event_seq == null ? null : Number(row.stream_facts_event_seq);
    checkpointByInstance.set(instanceId, checkpoint);
    sinceSeq = Math.min(sinceSeq, checkpoint ?? 0);
  }
  return { checkpointByInstance, factsByInstance, sinceSeq };
}

/**
 * Fold terminal-event deltas into every evidence row's per-stream
 * latest-attempt map, checkpointed by terminal `event_seq`. Bounded: reads
 * only events newer than the oldest participating checkpoint (a NULL
 * checkpoint participates from the beginning — the pre-change backfill),
 * batched, and capped at the max sequence observed when the pass started.
 * Returns fold counters; `{ folded: 0 }` when every row is current.
 */
export async function foldConnectorSummaryStreamFacts(): Promise<{
  folded: number;
  participants: number;
  refused: number;
}> {
  const store = createConnectorSummaryStore();
  const foldStore = createStreamFactsFoldStore();
  const rows = (await store.listEvidence()) as Row[];
  if (rows.length === 0) {
    return { folded: 0, participants: 0, refused: 0 };
  }
  const maxSeq = await foldStore.readMaxTerminalEventSeq();
  const participants = rows.filter((row) => {
    const checkpoint = row.stream_facts_event_seq;
    return checkpoint == null || (maxSeq != null && Number(checkpoint) < maxSeq);
  });
  if (participants.length === 0) {
    return { folded: 0, participants: 0, refused: 0 };
  }
  if (maxSeq == null) {
    // No terminal events exist yet; stamp a zero checkpoint so fresh rows do
    // not re-participate on every pass.
    for (const row of participants) {
      await foldStore.updateStreamFacts({
        connectorInstanceId: String(row.connector_instance_id),
        factsJson: null,
        eventSeq: 0,
      });
    }
    return { folded: 0, participants: participants.length, refused: 0 };
  }
  const { factsByInstance, checkpointByInstance, sinceSeq } = seedFoldState(participants);
  const counters = { folded: 0, refused: 0 };
  let cursor = Number.isFinite(sinceSeq) ? sinceSeq : 0;
  for (;;) {
    const batch = await foldStore.readTerminalFactEvents({
      sinceSeq: cursor,
      maxSeq,
      limit: STREAM_FACTS_FOLD_BATCH,
    });
    for (const row of batch) {
      foldTerminalEventFacts(factsByInstance, checkpointByInstance, row, counters);
    }
    if (batch.length < STREAM_FACTS_FOLD_BATCH) {
      break;
    }
    cursor = Number((batch.at(-1) as Row).event_seq);
  }
  // Every participant advances to the pass's max sequence — all attributable
  // events at or below it have been folded, so later passes read only the
  // delta. Events recorded after `maxSeq` during this pass fold next time.
  for (const [instanceId, facts] of factsByInstance) {
    await foldStore.updateStreamFacts({
      connectorInstanceId: instanceId,
      factsJson: Object.keys(facts).length > 0 ? JSON.stringify(facts) : null,
      eventSeq: maxSeq,
    });
  }
  return { folded: counters.folded, participants: participants.length, refused: counters.refused };
}

/**
 * Fold wrapper used by reconcile/rebuild: a fold failure marks every row
 * stale with the sanitized error and reports `ok: false` so the caller can
 * SKIP the normal dirty-row refresh — running it would immediately re-clean
 * the rows (`state = 'fresh'`, `last_error = NULL`) and erase the failure it
 * just recorded, serving stale stream facts under a fresh evidence envelope.
 * The projection's missing-facts default (unknown coverage) stays truthful
 * while the fold retries on the next pass.
 */
async function foldStreamFactsBestEffort(): Promise<{ ok: boolean }> {
  try {
    await foldConnectorSummaryStreamFacts();
    return { ok: true };
  } catch (err) {
    await markAllConnectorSummaryEvidenceDirty(err);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Evidence extraction (pure, shared by rebuild and reconcile)
// ---------------------------------------------------------------------------

/**
 * Read the durable identity/lifecycle rows for every owner connection. These
 * are the connector_instances facts the summary needs (id, type, display name,
 * status, source kind, revoked time) — never a synthesized verdict.
 */
async function readConnectorInstanceRows() {
  const store = createConnectorSummaryStore();
  const rows = await store.listConnectorInstanceRows();
  return (rows as Row[]).map(normalizeInstanceRow);
}

function normalizeInstanceRow(row: Row) {
  return {
    connector_instance_id: row.connector_instance_id,
    connector_id: row.connector_id,
    display_name: row.display_name,
    status: row.status,
    source_kind: row.source_kind,
    revoked_at: row.revoked_at || null,
  };
}

/**
 * Read durable record-count evidence per connection from the maintained
 * retained-size projection. `total_records` is the live record count and
 * `stream_count` is the number of distinct streams with records. These are
 * already-durable canonical counts; we do not re-aggregate the records table
 * here, so rebuild stays cheap and reads one maintained source.
 *
 * Returns a Map keyed by connector_instance_id → { total_records, stream_count }.
 */
function addStreamRecordEvidence(map: Map<string, CountEvidence>, row: Row) {
  const connectorInstanceId = row.connector_instance_id as string;
  const recordCount = Number(row.record_count || 0);
  const evidence = map.get(connectorInstanceId) ?? {
    total_records: 0,
    stream_count: 0,
    stream_records: [],
  };
  evidence.total_records += recordCount;
  if (recordCount > 0) {
    evidence.stream_count += 1;
  }
  evidence.stream_records.push({
    stream: row.stream,
    record_count: recordCount,
    last_updated: null,
  });
  map.set(connectorInstanceId, evidence);
}

async function readConnectionCountEvidence() {
  const map = new Map<string, CountEvidence>();
  const store = createConnectorSummaryStore();
  const rows = await store.listStreamCountRows();
  for (const row of rows as Row[]) {
    addStreamRecordEvidence(map, row);
  }
  return map;
}

function retainedBytesFromRow(row: Row): RetainedBytes {
  const recordJsonBytes = Number(row.current_record_json_bytes || 0);
  const recordChangesJsonBytes = Number(row.record_history_json_bytes || 0);
  const blobBytes = Number(row.blob_bytes || 0);
  return {
    record_json_bytes: recordJsonBytes,
    record_changes_json_bytes: recordChangesJsonBytes,
    blob_bytes: blobBytes,
    total_bytes: recordJsonBytes + recordChangesJsonBytes + blobBytes,
  };
}

async function readConnectionRetainedBytesEvidence() {
  const map = new Map<string, RetainedBytes>();
  const store = createConnectorSummaryStore();
  const rows = await store.listRetainedBytesRows();
  for (const row of rows as Row[]) {
    map.set(row.connector_instance_id as string, retainedBytesFromRow(row));
  }
  return map;
}

async function readConnectionRecordRecencyEvidence() {
  const map = new Map<string, unknown>();
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT connector_instance_id,
              MAX(emitted_at) AS last_record_updated_at
         FROM records
        WHERE deleted = FALSE
        GROUP BY connector_instance_id`
    );
    for (const row of result.rows as Row[]) {
      map.set(row.connector_instance_id as string, row.last_record_updated_at || null);
    }
    return map;
  }

  const rows = getDb()
    .prepare(
      `SELECT connector_instance_id,
              MAX(emitted_at) AS last_record_updated_at
         FROM records
        WHERE deleted = 0
        GROUP BY connector_instance_id`
    )
    .all() as Row[];
  for (const row of rows) {
    map.set(row.connector_instance_id as string, row.last_record_updated_at || null);
  }
  return map;
}

/**
 * Combine identity rows with count evidence into the durable evidence shape.
 * Pure: no storage, no `now`, no synthesis. Shared by rebuild and reconcile so
 * both paths produce byte-identical evidence.
 */
function buildEvidenceRows(
  instanceRows: Row[],
  countsByInstanceId: Map<string, CountEvidence>,
  recencyByInstanceId: Map<string, unknown>,
  retainedBytesByInstanceId: Map<string, RetainedBytes>
) {
  return instanceRows.map((row) => {
    const counts = countsByInstanceId.get(row.connector_instance_id as string) ?? {
      total_records: 0,
      stream_count: 0,
      stream_records: [],
    };
    const retainedBytes = retainedBytesByInstanceId.get(row.connector_instance_id as string) ?? emptyRetainedBytes();
    return {
      connector_instance_id: row.connector_instance_id,
      connector_id: row.connector_id,
      display_name: row.display_name,
      status: row.status,
      source_kind: row.source_kind,
      revoked_at: row.revoked_at,
      total_records: counts.total_records,
      stream_count: counts.stream_count,
      last_record_updated_at: recencyByInstanceId.get(row.connector_instance_id as string) || null,
      stream_records_json: JSON.stringify(counts.stream_records || []),
      retained_bytes_json: JSON.stringify(retainedBytes),
      total_retained_bytes: Number(retainedBytes.total_bytes || 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild every connector-summary evidence row from canonical durable state
 * (connector_instances + the maintained retained_size projection). Does NOT
 * re-run connectors or read credentials. On completion all rows are clean
 * (`dirty = 0`, `state = 'fresh'`) and rows for connections that no longer
 * exist are removed.
 *
 * Returns the maintained evidence rows (post-rebuild).
 */
export async function rebuildConnectorSummaryEvidence() {
  const instanceRows = await readConnectorInstanceRows();
  const counts = await readConnectionCountEvidence();
  const recencies = await readConnectionRecordRecencyEvidence();
  const retainedBytes = await readConnectionRetainedBytesEvidence();
  const evidence = buildEvidenceRows(instanceRows, counts, recencies, retainedBytes);
  const computedAt = nowIso();
  if (isPostgresStorageBackend()) {
    await rebuildPostgres(evidence, computedAt);
  } else {
    rebuildSqlite(evidence, computedAt);
  }
  // Newly (re)inserted rows carry a NULL fold checkpoint; fold their full
  // attributable terminal history now so a rebuild leaves the per-stream
  // latest-attempt evidence current rather than pending the next read. A
  // fold failure leaves the rows it marked stale visible (the rebuild's
  // fresh stamp above is superseded by markAllDirty inside the wrapper).
  await foldStreamFactsBestEffort();
  return listConnectorSummaryEvidence();
}

function rebuildSqlite(evidence: Row[], computedAt: string) {
  const db = getDb();
  const keep = new Set(evidence.map((row) => row.connector_instance_id));
  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO connector_summary_evidence(
         connector_instance_id, connector_id, display_name, status, source_kind,
         revoked_at, total_records, stream_count, last_record_updated_at,
         stream_records_json, retained_bytes_json, total_retained_bytes,
         dirty, computed_at, source_event_seq, state, last_error
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 'fresh', NULL)
       ON CONFLICT(connector_instance_id) DO UPDATE SET
         connector_id = excluded.connector_id,
         display_name = excluded.display_name,
         status = excluded.status,
         source_kind = excluded.source_kind,
         revoked_at = excluded.revoked_at,
         total_records = excluded.total_records,
         stream_count = excluded.stream_count,
         last_record_updated_at = excluded.last_record_updated_at,
         stream_records_json = excluded.stream_records_json,
         retained_bytes_json = excluded.retained_bytes_json,
         total_retained_bytes = excluded.total_retained_bytes,
         dirty = 0,
         computed_at = excluded.computed_at,
         state = 'fresh',
         last_error = NULL`
    );
    for (const row of evidence) {
      upsert.run(
        row.connector_instance_id,
        row.connector_id,
        row.display_name,
        row.status,
        row.source_kind,
        row.revoked_at,
        row.total_records,
        row.stream_count,
        row.last_record_updated_at,
        row.stream_records_json,
        row.retained_bytes_json,
        row.total_retained_bytes,
        computedAt
      );
    }
    // Drop rows for connections that no longer exist in canonical state.
    const existing = db.prepare("SELECT connector_instance_id FROM connector_summary_evidence").all() as Row[];
    const stale = existing.map((r) => r.connector_instance_id).filter((id: unknown) => !keep.has(id));
    const del = db.prepare("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?");
    for (const id of stale) {
      del.run(id);
    }
  })();
}

async function rebuildPostgres(evidence: Row[], computedAt: string) {
  const keep = evidence.map((row) => row.connector_instance_id);
  await withPostgresTransaction(async (client: Db) => {
    for (const row of evidence) {
      await client.query(
        `INSERT INTO connector_summary_evidence(
         connector_instance_id, connector_id, display_name, status, source_kind,
         revoked_at, total_records, stream_count, last_record_updated_at,
         stream_records_json, retained_bytes_json, total_retained_bytes,
         dirty, computed_at, source_event_seq, state, last_error
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, NULL, 'fresh', NULL)
       ON CONFLICT (connector_instance_id) DO UPDATE SET
         connector_id = EXCLUDED.connector_id,
         display_name = EXCLUDED.display_name,
           status = EXCLUDED.status,
           source_kind = EXCLUDED.source_kind,
         revoked_at = EXCLUDED.revoked_at,
         total_records = EXCLUDED.total_records,
         stream_count = EXCLUDED.stream_count,
         last_record_updated_at = EXCLUDED.last_record_updated_at,
         stream_records_json = EXCLUDED.stream_records_json,
         retained_bytes_json = EXCLUDED.retained_bytes_json,
         total_retained_bytes = EXCLUDED.total_retained_bytes,
         dirty = 0,
         computed_at = EXCLUDED.computed_at,
         state = 'fresh',
           last_error = NULL`,
        [
          row.connector_instance_id,
          row.connector_id,
          row.display_name,
          row.status,
          row.source_kind,
          row.revoked_at,
          row.total_records,
          row.stream_count,
          row.last_record_updated_at,
          row.stream_records_json,
          row.retained_bytes_json,
          row.total_retained_bytes,
          computedAt,
        ]
      );
    }
    if (keep.length > 0) {
      await client.query("DELETE FROM connector_summary_evidence WHERE connector_instance_id <> ALL($1::text[])", [
        keep,
      ]);
    } else {
      await client.query("DELETE FROM connector_summary_evidence");
    }
  });
}

// ---------------------------------------------------------------------------
// Reconcile (light pass over dirty rows only)
// ---------------------------------------------------------------------------

/**
 * Reconcile dirty evidence rows by recomputing only those rows from canonical
 * state. Bounded to "dirty rows only" so it stays cheap relative to a full
 * rebuild. A no-op when no rows are dirty. Returns `{ reconciled }`.
 *
 * A dirty row whose connection has since been deleted is dropped. A dirty row
 * whose connection still exists is refreshed to clean (`dirty = 0`,
 * `state = 'fresh'`).
 */
export async function reconcileDirtyConnectorSummaryEvidence() {
  // Fold terminal-event deltas FIRST, independent of the dirty flag: a read
  // during an active run can clean the dirty flag before the terminal event
  // lands, so the fold compares the max terminal event_seq against each
  // row's checkpoint instead of trusting dirtiness alone. On fold failure
  // the rows were just marked stale with the error — do NOT run the normal
  // dirty-row refresh, which would re-clean them and erase the failure.
  const fold = await foldStreamFactsBestEffort();
  if (!fold.ok) {
    return { reconciled: 0 };
  }
  if (isPostgresStorageBackend()) {
    return reconcileDirtyPostgres();
  }
  return reconcileDirtySqlite();
}

function reconcileDirtySqlite() {
  const db = getDb();
  const dirty = db
    .prepare("SELECT connector_instance_id FROM connector_summary_evidence WHERE dirty <> 0")
    .all() as Row[];
  if (dirty.length === 0) {
    return { reconciled: 0 };
  }
  const dirtyIds = new Set<unknown>(dirty.map((r) => r.connector_instance_id));
  const instanceRows = readConnectorInstanceRowsSync(db).filter((row) => dirtyIds.has(row.connector_instance_id));
  const counts = readConnectionCountEvidenceSync(db);
  const recencies = readConnectionRecordRecencyEvidenceSync(db);
  const retainedBytes = readConnectionRetainedBytesEvidenceSync(db);
  const evidence = buildEvidenceRows(instanceRows, counts, recencies, retainedBytes);
  const computedAt = nowIso();
  let reconciled = 0;
  db.transaction(() => {
    const liveIds = new Set(evidence.map((row) => row.connector_instance_id));
    const update = db.prepare(
      `UPDATE connector_summary_evidence SET
         connector_id = ?,
         display_name = ?,
         status = ?,
         source_kind = ?,
         revoked_at = ?,
         total_records = ?,
         stream_count = ?,
         last_record_updated_at = ?,
         stream_records_json = ?,
         retained_bytes_json = ?,
         total_retained_bytes = ?,
         dirty = 0,
         computed_at = ?,
         state = 'fresh',
         last_error = NULL
       WHERE connector_instance_id = ?`
    );
    for (const row of evidence) {
      update.run(
        row.connector_id,
        row.display_name,
        row.status,
        row.source_kind,
        row.revoked_at,
        row.total_records,
        row.stream_count,
        row.last_record_updated_at,
        row.stream_records_json,
        row.retained_bytes_json,
        row.total_retained_bytes,
        computedAt,
        row.connector_instance_id
      );
      reconciled += 1;
    }
    // Dirty rows whose connection vanished from canonical state are dropped.
    const del = db.prepare("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?");
    for (const id of dirtyIds) {
      if (!liveIds.has(id)) {
        del.run(id);
        reconciled += 1;
      }
    }
  })();
  return { reconciled };
}

// Synchronous SQLite helpers used by reconcile so the whole pass stays inside
// one better-sqlite3 transaction without awaiting across statements.
function readConnectorInstanceRowsSync(db: Db) {
  return (
    db
      .prepare(
        `SELECT connector_instance_id, connector_id, display_name, status, source_kind, revoked_at
         FROM connector_instances
        WHERE owner_subject_id = ?
        ORDER BY connector_instance_id ASC`
      )
      .all(REFERENCE_OWNER_SUBJECT_ID) as Row[]
  ).map(normalizeInstanceRow);
}

function readConnectionCountEvidenceSync(db: Db) {
  const map = new Map<string, CountEvidence>();
  const rows = db
    .prepare(
      `SELECT connector_instance_id,
              stream,
              record_count
         FROM retained_size_stream
        ORDER BY connector_instance_id ASC, stream ASC`
    )
    .all() as Row[];
  for (const row of rows) {
    addStreamRecordEvidence(map, row);
  }
  return map;
}

function readConnectionRetainedBytesEvidenceSync(db: Db) {
  const map = new Map<string, RetainedBytes>();
  const rows = db
    .prepare(
      `SELECT connector_instance_id,
              current_record_json_bytes,
              record_history_json_bytes,
              blob_bytes
         FROM retained_size_connection`
    )
    .all() as Row[];
  for (const row of rows) {
    map.set(row.connector_instance_id as string, retainedBytesFromRow(row));
  }
  return map;
}

function readConnectionRecordRecencyEvidenceSync(db: Db) {
  const map = new Map<string, unknown>();
  const rows = db
    .prepare(
      `SELECT connector_instance_id,
              MAX(emitted_at) AS last_record_updated_at
         FROM records
        WHERE deleted = 0
        GROUP BY connector_instance_id`
    )
    .all() as Row[];
  for (const row of rows) {
    map.set(row.connector_instance_id as string, row.last_record_updated_at || null);
  }
  return map;
}

async function reconcileDirtyPostgres() {
  const dirty = await postgresQuery("SELECT connector_instance_id FROM connector_summary_evidence WHERE dirty <> 0");
  if (dirty.rows.length === 0) {
    return { reconciled: 0 };
  }
  const dirtyIds = new Set<unknown>((dirty.rows as Row[]).map((r) => r.connector_instance_id));
  const instanceRows = (await readConnectorInstanceRows()).filter((row) => dirtyIds.has(row.connector_instance_id));
  const counts = await readConnectionCountEvidence();
  const recencies = await readConnectionRecordRecencyEvidence();
  const retainedBytes = await readConnectionRetainedBytesEvidence();
  const evidence = buildEvidenceRows(instanceRows, counts, recencies, retainedBytes);
  const liveIds = new Set(evidence.map((row) => row.connector_instance_id));
  const computedAt = nowIso();
  let reconciled = 0;
  await withPostgresTransaction(async (client: Db) => {
    for (const row of evidence) {
      await client.query(
        `UPDATE connector_summary_evidence SET
           connector_id = $2,
           display_name = $3,
           status = $4,
           source_kind = $5,
           revoked_at = $6,
           total_records = $7,
           stream_count = $8,
           last_record_updated_at = $9,
           stream_records_json = $10,
           retained_bytes_json = $11,
           total_retained_bytes = $12,
           dirty = 0,
           computed_at = $13,
           state = 'fresh',
           last_error = NULL
         WHERE connector_instance_id = $1`,
        [
          row.connector_instance_id,
          row.connector_id,
          row.display_name,
          row.status,
          row.source_kind,
          row.revoked_at,
          row.total_records,
          row.stream_count,
          row.last_record_updated_at,
          row.stream_records_json,
          row.retained_bytes_json,
          row.total_retained_bytes,
          computedAt,
        ]
      );
      reconciled += 1;
    }
    for (const id of dirtyIds) {
      if (!liveIds.has(id)) {
        await client.query("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
        reconciled += 1;
      }
    }
  });
  return { reconciled };
}
