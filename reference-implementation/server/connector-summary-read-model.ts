// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * The maintenance sweep runs `reconcileDirtyConnectorSummaryEvidence` before
 * its bounded observation passes; ordinary `/_ref/connectors` reads are
 * read-only and do not reconcile inline.
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

import { iterateDynamicSqlAcknowledged } from "../lib/db.ts";
import type { EphemeralBrowserRuntimeProjection } from "../runtime/browser-surface/ephemeral-health-projection.ts";
import { readConnectorInstanceIdPage as readInstanceIdPage } from "./connector-summary-evidence-bounded-reconciliation.ts";
import type { RepairCandidateReason } from "./connector-summary-evidence-engine.ts";
import {
  pruneOrphanedEvidenceComplete,
  reconcileConnectorSummaryEvidence,
} from "./connector-summary-evidence-engine.ts";
import type { ConnectorSummaryReconcileObservation } from "./connector-summary-reconcile-observability.ts";
import { getDb } from "./db.ts";
import { isPostgresStorageBackend, PostgresStatementTimeoutError, postgresQuery } from "./postgres-storage.ts";
import type { ConnectorMaintenanceCursorLease } from "./stores/connector-maintenance-cursor-store.ts";

/** A raw database row (column-keyed) crossing the untyped storage boundary. */
type Row = Record<string, unknown>;

type ConnectorSummaryReconcileObservationSink = (observation: ConnectorSummaryReconcileObservation) => void;

const GENERIC_REPAIR_CANDIDATE_REASONS: readonly RepairCandidateReason[] = [
  "dirty",
  "state_stale",
  "record_checkpoint_mismatch",
  "identity_mismatch",
  "manifest_mismatch",
  "retained_bytes_changed_or_unavailable",
  "schedule_mismatch",
  "lifecycle_checkpoint_lag",
  "source_revision_mismatch",
];

/** Bounded maintenance never creates more than one ordinary page of cold evidence. */
const BOUNDED_MISSING_REPAIR_CANDIDATES = 25;
/** A bounded fold reads at most this many terminal events in one started batch. */
const BOUNDED_FOLD_MAX_EVENTS = 500;

function resolveCooperativeDeadline(options: {
  readonly deadline?: number;
  readonly maxDurationMs?: number;
}): number | null {
  if (typeof options.deadline === "number") {
    return options.deadline;
  }
  if (typeof options.maxDurationMs === "number") {
    return Date.now() + options.maxDurationMs;
  }
  return null;
}

let connectorSummaryReconcileObservationSink: ConnectorSummaryReconcileObservationSink | null = null;

/** Configure best-effort process-local telemetry; no persisted read-model state changes. */
export function setConnectorSummaryReconcileObservationSink(
  sink: ConnectorSummaryReconcileObservationSink | null
): void {
  connectorSummaryReconcileObservationSink = sink;
}

function emitConnectorSummaryReconcileObservation(observation: ConnectorSummaryReconcileObservation): void {
  try {
    connectorSummaryReconcileObservationSink?.(observation);
  } catch {
    // Observability must not affect reconciliation or its caller's result.
  }
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

/**
 * Reason codes for the failure-specific component-degradation markers below
 * (`markTerminalFactsFailedForAllRows`, `markAllConnectorSummaryEvidenceDiscoveryFailed`).
 * Distinct from — and never confused with — the normal happy-path dirty
 * marking (`markConnectorSummaryEvidenceDirty`/`markAllConnectorSummaryEvidenceDirty`),
 * which correctly leaves component states untouched because nothing failed.
 */
const REASON_CODES = {
  DISCOVERY_FAILED: "summary_discovery_failed",
  /**
   * A row's stored `stream_facts_fold_version` is AHEAD of this binary's own
   * `STREAM_FACTS_FOLD_LOGIC_VERSION` — the row was folded by a newer
   * deploy's fold contract. An older binary has no way to validate that
   * output against its own (older) merge semantics, so it must never fold,
   * replay, or overwrite it; this reason fails the row closed instead.
   */
  FOLD_LOGIC_VERSION_INCOMPATIBLE_FUTURE: "fold_logic_version_incompatible_future",
  // A source-attributed terminal event without a matching durable generation
  // is historical, never an empty/current fold result.
  TERMINAL_FACTS_HISTORICAL: "terminal_facts_historical",
  // A bounded replay lost its CAS race on every attempt. The route receives
  // an in-memory stale overlay instead of trusting the competing durable map.
  TERMINAL_FOLD_CONTENTION: "terminal_fold_contention",
  TERMINAL_FOLD_FAILED: "terminal_fold_failed",
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
} as const;

function parseEvidenceJson(value: unknown, fallback: unknown): unknown {
  if (value === null) {
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

/**
 * Narrow handoff for the separately-owned scoped runtime observer. The
 * terminal list projection stores the observer's already-classified result;
 * it never discovers surfaces, reads runtime history, or treats an omitted
 * observation as healthy.
 */
export interface ConnectorListSummaryRuntimeEvidence {
  readonly observed_at: string;
  readonly projection: EphemeralBrowserRuntimeProjection | null;
}

export interface ConnectorListSummaryTerminalProjection {
  readonly runtime: ConnectorListSummaryRuntimeEvidence | null;
  /** Exact owner LIST-item shape, retained as one named projection payload. */
  readonly summary: Record<string, unknown>;
}

export interface ConnectorListSummaryTerminalProjectionEnvelope {
  readonly computed_at: string | null;
  readonly projection: ConnectorListSummaryTerminalProjection | null;
  readonly reason_code: string | null;
  readonly state: "current" | "stale" | "unobserved" | "failed";
}

const TERMINAL_PROJECTION_STATES = new Set(["current", "stale", "failed"]);
export const TERMINAL_PROJECTION_PUBLICATION_RACE = "ConnectorListSummaryProjectionRace";
const DECIMAL_SOURCE_REVISION_RE = /^\d+$/;
const LEADING_ZEROES_SOURCE_REVISION_RE = /^0+(?=\d)/;
const MAX_SOURCE_REVISION = "9223372036854775807";

function terminalProjectionState(value: unknown): ConnectorListSummaryTerminalProjectionEnvelope["state"] {
  return typeof value === "string" && TERMINAL_PROJECTION_STATES.has(value)
    ? (value as ConnectorListSummaryTerminalProjectionEnvelope["state"])
    : "unobserved";
}

function knownSourceRevision(value: unknown): boolean {
  return value !== null && value !== undefined && DECIMAL_SOURCE_REVISION_RE.test(String(value));
}

function sourceRevisionIsExhausted(value: unknown): boolean {
  if (!knownSourceRevision(value)) {
    return false;
  }
  return String(value).replace(LEADING_ZEROES_SOURCE_REVISION_RE, "") === MAX_SOURCE_REVISION;
}

function parseTerminalProjection(value: unknown): ConnectorListSummaryTerminalProjection | null {
  const parsed = parseEvidenceJson(value, null);
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (!(candidate.summary && typeof candidate.summary === "object" && !Array.isArray(candidate.summary))) {
    return null;
  }
  return {
    runtime: (candidate.runtime as ConnectorListSummaryRuntimeEvidence | null | undefined) ?? null,
    summary: candidate.summary as Record<string, unknown>,
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

/**
 * Normalizes `markDirty`'s optional `sourceEventSeq` to a value both backends
 * bind identically: a finite number, or SQL `NULL` meaning "leave the stored
 * `source_event_seq` alone" (every caller's UPDATE wraps it in
 * `COALESCE(?, source_event_seq)`).
 *
 * Both backends previously inlined their own guard and they did not agree.
 * Postgres guarded `null` AND `undefined` — it had to, because `Number(undefined)`
 * is `NaN` and Postgres's bigint column rejects it outright ("invalid input
 * syntax for type bigint: 'NaN'"), throwing before the UPDATE ran and turning
 * every omitted-`sourceEventSeq` dirty-mark into a silent no-op (swallowed by
 * `markConnectorSummaryEvidenceDirty`'s best-effort catch). SQLite guarded only
 * `null`, so it bound `NaN` — which better-sqlite3 coerces to SQL NULL, making
 * `COALESCE` preserve the prior value. That accident is why the drift never
 * produced a SQLite symptom, and why no test caught it.
 *
 * The genuine cross-backend divergence is a non-nullish UNPARSEABLE value
 * (`"abc"`, `{}`): SQLite silently preserves the prior seq, Postgres throws and
 * loses the whole dirty mark. Both now agree on the SQLite-shaped outcome —
 * preserve, never throw — because a dirty marker is a best-effort latency hint
 * and must never be the reason a connection fails to converge. Fail-open here
 * is strictly safer than fail-closed: the reconcile sweep still repairs the row.
 */
export function normalizeSourceEventSeq(sourceEventSeq: unknown): number | null {
  if (sourceEventSeq === null || sourceEventSeq === undefined) {
    return null;
  }
  const parsed = Number(sourceEventSeq);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
function createConnectorSummaryStore() {
  if (isPostgresStorageBackend()) {
    return {
      async countDirty(): Promise<number> {
        const result = await postgresQuery<{ n: string | number }>(
          "SELECT COUNT(*)::text AS n FROM connector_summary_evidence WHERE dirty <> 0"
        );
        return Number(result.rows[0]?.n ?? 0);
      },
      async listDirtyInstanceIds({ afterId = null, limit }: { afterId?: string | null; limit: number }) {
        const result = afterId
          ? await postgresQuery(
              `SELECT connector_instance_id
                 FROM connector_summary_evidence
                WHERE dirty <> 0 AND connector_instance_id > $1
                ORDER BY connector_instance_id ASC
                LIMIT $2`,
              [afterId, limit]
            )
          : await postgresQuery(
              `SELECT connector_instance_id
                 FROM connector_summary_evidence
                WHERE dirty <> 0
                ORDER BY connector_instance_id ASC
                LIMIT $1`,
              [limit]
            );
        const ids = (result.rows as Row[]).map((row) => String(row.connector_instance_id));
        if (ids.length > 0 || afterId === null) {
          return ids;
        }
        // Wraparound: nothing dirty remains after the rotating cursor's
        // position (every id at/after it has since been repaired or the
        // cursor ran off the end) — restart from the beginning of the dirty
        // set rather than reporting a false "nothing dirty" for the rest of
        // this sweep's lifetime.
        const wrapped = await postgresQuery(
          `SELECT connector_instance_id
             FROM connector_summary_evidence
            WHERE dirty <> 0
            ORDER BY connector_instance_id ASC
            LIMIT $1`,
          [limit]
        );
        return (wrapped.rows as Row[]).map((row) => String(row.connector_instance_id));
      },
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
                  canonical_evidence_revision,
                  source_revision::text AS source_revision,
                  manifest_generation, schedule_checkpoint, run_lifecycle_event_seq,
                  list_summary_projection_json, list_summary_projection_state,
                  list_summary_projection_reason_code, list_summary_projection_computed_at
             FROM connector_summary_evidence
             ${where}
             ORDER BY connector_instance_id ASC`,
          params
        );
        return result.rows;
      },
      async listPendingMaintenanceInstanceIds({
        includeIncomplete,
        limit,
      }: {
        includeIncomplete: boolean;
        limit: number;
      }) {
        const dirty = await postgresQuery(
          `SELECT connector_instance_id
             FROM connector_summary_evidence
            WHERE dirty <> 0
            ORDER BY connector_instance_id ASC
            LIMIT $1`,
          [limit]
        );
        if (dirty.rows.length > 0) {
          return (dirty.rows as Row[]).map((row) => String(row.connector_instance_id));
        }
        if (!includeIncomplete) {
          return [];
        }
        const incomplete = await postgresQuery(
          `SELECT connector_instance_id
             FROM connector_summary_evidence
            WHERE terminal_facts_reason_code = $1
            ORDER BY connector_instance_id ASC
            LIMIT $2`,
          [REASON_CODES.TERMINAL_FOLD_INCOMPLETE, limit]
        );
        return (incomplete.rows as Row[]).map((row) => String(row.connector_instance_id));
      },
      async markAllDirty({ sanitized }: { sanitized?: string | null }) {
        await postgresQuery(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = $1,
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = 'stale',
                  list_summary_projection_reason_code = 'canonical_evidence_dirty'`,
          [sanitized]
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
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = 'stale',
                  list_summary_projection_reason_code = 'canonical_evidence_dirty',
                  record_snapshot_state = 'failed',
                  record_snapshot_reason_code = $2,
                  manifest_declaration_state = 'failed',
                  manifest_declaration_reason_code = $2
              ${where}`,
          params
        );
      },
      async markAllTerminalFactsFailed({
        sanitized,
        connectorInstanceIds,
        terminalFactsState = "failed",
        reasonCode = REASON_CODES.TERMINAL_FOLD_FAILED,
      }: {
        sanitized?: string | null;
        connectorInstanceIds?: readonly string[] | null;
        terminalFactsState?: string;
        reasonCode?: string;
      }) {
        if (connectorInstanceIds && connectorInstanceIds.length === 0) {
          return;
        }
        const where = connectorInstanceIds ? "WHERE connector_instance_id = ANY($4::text[])" : "";
        const params: unknown[] = [sanitized, terminalFactsState, reasonCode];
        if (connectorInstanceIds) {
          params.push(connectorInstanceIds);
        }
        await postgresQuery(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = $1,
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = 'stale',
                  list_summary_projection_reason_code = 'canonical_evidence_dirty',
                  terminal_facts_state = $2,
                  terminal_facts_reason_code = $3
              ${where}`,
          params
        );
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
        // Every write-hook call site (record ingest/delete, owner mutations,
        // the connector-wide bulk delete) omits `sourceEventSeq` entirely —
        // only a handful of callers pass it explicitly. `sourceEventSeq ===
        // null ? null : Number(sourceEventSeq)` mishandled the common
        // omitted (`undefined`) case: `Number(undefined)` is `NaN`, which
        // Postgres's bigint column rejects outright ("invalid input syntax
        // for type bigint: 'NaN'"), throwing before the UPDATE could run at
        // all — silently swallowed by this function's caller-facing
        // best-effort catch, so every omitted-sourceEventSeq dirty-mark call
        // was a complete no-op against Postgres. Nullish (both `null` and
        // `undefined`) must bind SQL `NULL`, not `NaN`.
        const boundSourceEventSeq = normalizeSourceEventSeq(sourceEventSeq);
        await postgresQuery(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = $2,
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = 'stale',
                  list_summary_projection_reason_code = 'canonical_evidence_dirty',
                  source_event_seq = COALESCE($3, source_event_seq)
            WHERE connector_instance_id = $1`,
          [connectorInstanceId, sanitized, boundSourceEventSeq]
        );
      },
    };
  }
  return {
    countDirty(): number {
      const row = getDb().prepare("SELECT COUNT(*) AS n FROM connector_summary_evidence WHERE dirty <> 0").get() as {
        n: number;
      };
      return row.n;
    },
    listDirtyInstanceIds({ afterId = null, limit }: { afterId?: string | null; limit: number }) {
      const rows = (
        afterId
          ? getDb()
              .prepare(
                `SELECT connector_instance_id
                   FROM connector_summary_evidence
                  WHERE dirty <> 0 AND connector_instance_id > ?
                  ORDER BY connector_instance_id ASC
                  LIMIT ?`
              )
              .all(afterId, limit)
          : getDb()
              .prepare(
                `SELECT connector_instance_id
                   FROM connector_summary_evidence
                  WHERE dirty <> 0
                  ORDER BY connector_instance_id ASC
                  LIMIT ?`
              )
              .all(limit)
      ) as Row[];
      if (rows.length > 0 || afterId === null) {
        return rows.map((row) => String(row.connector_instance_id));
      }
      // Wraparound: see the Postgres branch's identical comment — restart
      // from the beginning of the dirty set rather than reporting a false
      // "nothing dirty" once the rotating cursor runs past the last id.
      const wrapped = getDb()
        .prepare(
          `SELECT connector_instance_id
             FROM connector_summary_evidence
            WHERE dirty <> 0
            ORDER BY connector_instance_id ASC
            LIMIT ?`
        )
        .all(limit) as Row[];
      return wrapped.map((row) => String(row.connector_instance_id));
    },
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
                    canonical_evidence_revision,
                    CAST(source_revision AS TEXT) AS source_revision,
                    manifest_generation, schedule_checkpoint, run_lifecycle_event_seq,
                    list_summary_projection_json, list_summary_projection_state,
                    list_summary_projection_reason_code, list_summary_projection_computed_at`;
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
      return [
        ...iterateDynamicSqlAcknowledged<Row>(
          `SELECT ${columns} FROM connector_summary_evidence ORDER BY connector_instance_id ASC`
        ),
      ];
    },
    listPendingMaintenanceInstanceIds({ includeIncomplete, limit }: { includeIncomplete: boolean; limit: number }) {
      const dirty = getDb()
        .prepare(
          `SELECT connector_instance_id
             FROM connector_summary_evidence
            WHERE dirty <> 0
            ORDER BY connector_instance_id ASC
            LIMIT ?`
        )
        .all(limit) as Row[];
      if (dirty.length > 0) {
        return dirty.map((row) => String(row.connector_instance_id));
      }
      if (!includeIncomplete) {
        return [];
      }
      const incomplete = getDb()
        .prepare(
          `SELECT connector_instance_id
             FROM connector_summary_evidence
            WHERE terminal_facts_reason_code = ?
            ORDER BY connector_instance_id ASC
            LIMIT ?`
        )
        .all(REASON_CODES.TERMINAL_FOLD_INCOMPLETE, limit) as Row[];
      return incomplete.map((row) => String(row.connector_instance_id));
    },
    markAllDirty({ sanitized }: { sanitized?: string | null }) {
      getDb()
        .prepare(
          `UPDATE connector_summary_evidence
              SET dirty = 1,
                  state = 'stale',
                  last_error = ?,
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = 'stale',
                  list_summary_projection_reason_code = 'canonical_evidence_dirty'`
        )
        .run(sanitized);
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
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = 'stale',
                  list_summary_projection_reason_code = 'canonical_evidence_dirty',
                  record_snapshot_state = 'failed',
                  record_snapshot_reason_code = ?,
                  manifest_declaration_state = 'failed',
                  manifest_declaration_reason_code = ?
              ${where}`
        )
        .run(sanitized, REASON_CODES.DISCOVERY_FAILED, REASON_CODES.DISCOVERY_FAILED, ...(connectorInstanceIds ?? []));
    },
    markAllTerminalFactsFailed({
      sanitized,
      connectorInstanceIds,
      terminalFactsState = "failed",
      reasonCode = REASON_CODES.TERMINAL_FOLD_FAILED,
    }: {
      sanitized?: string | null;
      connectorInstanceIds?: readonly string[] | null;
      terminalFactsState?: string;
      reasonCode?: string;
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
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = 'stale',
                  list_summary_projection_reason_code = 'canonical_evidence_dirty',
                  terminal_facts_state = ?,
                  terminal_facts_reason_code = ?
              ${where}`
        )
        .run(sanitized, terminalFactsState, reasonCode, ...(connectorInstanceIds ?? []));
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
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = 'stale',
                  list_summary_projection_reason_code = 'canonical_evidence_dirty',
                  source_event_seq = COALESCE(?, source_event_seq)
            WHERE connector_instance_id = ?`
        )
        .run(sanitized, normalizeSourceEventSeq(sourceEventSeq), connectorInstanceId);
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

async function invalidateAllConnectorListSummaryTerminalProjections(reasonCode: string): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `UPDATE connector_summary_evidence
          SET canonical_evidence_revision = canonical_evidence_revision + 1,
              list_summary_projection_state = CASE
                WHEN list_summary_projection_state = 'current' THEN 'stale'
                ELSE list_summary_projection_state
              END,
              list_summary_projection_reason_code = CASE
                WHEN list_summary_projection_state = 'current' THEN $1
                ELSE list_summary_projection_reason_code
              END`,
      [reasonCode]
    );
    return;
  }
  getDb()
    .prepare(
      `UPDATE connector_summary_evidence
          SET canonical_evidence_revision = canonical_evidence_revision + 1,
              list_summary_projection_state = CASE
                WHEN list_summary_projection_state = 'current' THEN 'stale'
                ELSE list_summary_projection_state
              END,
              list_summary_projection_reason_code = CASE
                WHEN list_summary_projection_state = 'current' THEN ?
                ELSE list_summary_projection_reason_code
              END`
    )
    .run(reasonCode);
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
  const eventSeq = row.stream_facts_event_seq === null ? null : Number(row.stream_facts_event_seq);
  if (rowIsFoldLogicVersionAhead(row)) {
    return {
      as_of: row.computed_at || null,
      event_seq: eventSeq,
      reason_code: REASON_CODES.FOLD_LOGIC_VERSION_INCOMPATIBLE_FUTURE,
      state: "stale",
    };
  }
  return {
    as_of: row.computed_at || null,
    event_seq: eventSeq,
    reason_code: row.terminal_facts_reason_code || null,
    state: row.terminal_facts_state || "unobserved",
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
    as_of: row.computed_at || null,
    reason_code: reasonCode || null,
    state,
  };
}

function shapeListSummaryProjection(row: Row): ConnectorListSummaryTerminalProjectionEnvelope {
  if (!knownSourceRevision(row.source_revision)) {
    return {
      computed_at: null,
      projection: null,
      reason_code: "canonical_source_revision_unknown",
      state: "stale",
    };
  }
  if (sourceRevisionIsExhausted(row.source_revision)) {
    return {
      computed_at: null,
      projection: null,
      reason_code: "canonical_source_revision_exhausted",
      state: "stale",
    };
  }
  const state = terminalProjectionState(row.list_summary_projection_state);
  return {
    computed_at:
      typeof row.list_summary_projection_computed_at === "string" ? row.list_summary_projection_computed_at : null,
    projection: state === "current" ? parseTerminalProjection(row.list_summary_projection_json) : null,
    reason_code:
      typeof row.list_summary_projection_reason_code === "string" ? row.list_summary_projection_reason_code : null,
    state,
  };
}

function shapeSourceRevision(row: Row): {
  readonly dirty: boolean;
  readonly source_revision: string | null;
  readonly state: unknown;
} {
  const known = knownSourceRevision(row.source_revision);
  const exhausted = sourceRevisionIsExhausted(row.source_revision);
  return {
    dirty: !known || exhausted || Number(row.dirty || 0) !== 0,
    source_revision: known ? String(row.source_revision) : null,
    state: !known || exhausted ? "stale" : row.state || "unknown",
  };
}

export function shapeEvidenceRow(row: Row) {
  const retainedBytesState = String(row.retained_bytes_state || "unobserved");
  const sourceRevision = shapeSourceRevision(row);
  return {
    canonical_evidence_revision: String(row.canonical_evidence_revision ?? "0"),
    computed_at: row.computed_at || null,
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id,
    ...sourceRevision,
    display_name: row.display_name,
    last_error: row.last_error || null,
    last_record_updated_at: row.last_record_updated_at || null,
    list_summary_projection: shapeListSummaryProjection(row),
    manifest_declaration: shapeComponentEnvelope(
      row,
      row.manifest_declaration_state || "unavailable",
      row.manifest_declaration_reason_code
    ),
    manifest_generation: Number(row.manifest_generation ?? 0),
    // The record-source checkpoint (`version_counter` as of the repair) —
    // shaped here so the READ boundary can reach the same record-side
    // observation proof `buildRepairedRow` used when it derived the row's
    // `count_state`. Parsed defensively; a malformed column reads as no
    // checkpoint at all rather than a fabricated observation.
    record_checkpoint: parseEvidenceJson(row.record_checkpoint_json, null),
    record_snapshot: shapeComponentEnvelope(
      row,
      row.record_snapshot_state || "unobserved",
      row.record_snapshot_reason_code
    ),
    retained_bytes: retainedBytesState === "current" ? parseEvidenceJson(row.retained_bytes_json, null) : null,
    retained_bytes_evidence: shapeComponentEnvelope(row, retainedBytesState, row.retained_bytes_reason_code),
    revoked_at: row.revoked_at || null,
    run_lifecycle_event_seq: row.run_lifecycle_event_seq === null ? null : Number(row.run_lifecycle_event_seq),
    schedule_checkpoint: row.schedule_checkpoint === undefined ? "unobserved" : String(row.schedule_checkpoint),
    source_event_seq: row.source_event_seq === null ? null : Number(row.source_event_seq),
    source_kind: row.source_kind,
    status: row.status,
    stream_count: Number(row.stream_count || 0),
    stream_facts_event_seq: row.stream_facts_event_seq === null ? null : Number(row.stream_facts_event_seq),
    stream_latest_facts: parseEvidenceJson(row.stream_latest_facts_json, null),
    stream_records: parseEvidenceJson(row.stream_records_json, []),
    terminal_facts: shapeTerminalFacts(row),
    total_records: Number(row.total_records || 0),
    total_retained_bytes: retainedBytesState === "current" ? Number(row.total_retained_bytes || 0) : null,
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
      last_error: sanitized,
      state: "failed",
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
    await store.markAllTerminalFactsFailed({ connectorInstanceIds, sanitized });
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
      { terminal_facts_reason_code: REASON_CODES.TERMINAL_FOLD_FAILED, terminal_facts_state: "failed" },
      sanitized
    );
  }
}

/**
 * Durably records a bounded CAS-replay contention outcome (terminal-gate
 * revision, 2026-07-29): before this fix, `foldStreamFactsBestEffort`
 * deliberately left the row's `terminal_facts_state`/`reason_code`
 * untouched on CAS rejection — the comment's rationale ("the final
 * competing writer may own a future fold version") is about the FACTS
 * PAYLOAD (`stream_latest_facts_json`/`stream_facts_event_seq`/
 * `stream_facts_fold_version`), which this function never touches, exactly
 * like `markTerminalFactsFailedForAllRows` above. The in-memory-only overlay
 * this branch computed was designed to be merged by "the central route
 * loader" in the SAME barrier pass that observed the contention — a
 * consumer that no longer exists now that GET never calls the barrier
 * inline. Without a durable mark, a subsequent independent GET would read
 * the stale `current` row as trustworthy until the NEXT maintenance-sweep
 * fold happens to converge it, silently widening the honest-staleness
 * window this pass itself already measured. Marking the SAME metadata
 * columns `markAllTerminalFactsFailed` already safely marks for a harder
 * failure — scoped to exactly the ids this fold round found in contention —
 * closes that gap without touching the facts payload the original comment
 * protects.
 */
export async function markTerminalFactsContentionForRows(
  connectorInstanceIds: readonly string[]
): Promise<ReadonlyMap<string, Row>> {
  if (connectorInstanceIds.length === 0) {
    return new Map();
  }
  const existingById = await readExistingRowsForFailureOverlay(connectorInstanceIds);
  try {
    const store = createConnectorSummaryStore();
    await store.markAllTerminalFactsFailed({
      connectorInstanceIds,
      reasonCode: REASON_CODES.TERMINAL_FOLD_CONTENTION,
      sanitized: null,
      terminalFactsState: "stale",
    });
    return new Map();
  } catch {
    // The durable marker write itself failed — fall back to the same
    // in-memory overlay shape the caller already builds, so a same-pass
    // reader (if one exists) still sees the contention rather than nothing.
    return buildComponentFailedRows(
      connectorInstanceIds,
      existingById,
      { terminal_facts_reason_code: REASON_CODES.TERMINAL_FOLD_CONTENTION, terminal_facts_state: "stale" },
      null
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
    await store.markAllDiscoveryFailed({ connectorInstanceIds, sanitized });
    return new Map();
  } catch {
    if (effectiveIds.length === 0) {
      return new Map();
    }
    return buildComponentFailedRows(
      effectiveIds,
      existingById,
      {
        manifest_declaration_reason_code: REASON_CODES.DISCOVERY_FAILED,
        manifest_declaration_state: "failed",
        record_snapshot_reason_code: REASON_CODES.DISCOVERY_FAILED,
        record_snapshot_state: "failed",
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
// fold pass — the maintenance sweep (including startup acceleration) folds
// their full attributable
// terminal history once. On fold failure every row is marked stale with the
// sanitized error so the state is visible, and the projection's fail-closed
// default (missing facts read unknown) keeps verdicts truthful.
// ---------------------------------------------------------------------------

const TERMINAL_RUN_EVENT_TYPES = ["run.completed", "run.failed", "run.browser_surface_failed", "run.cancelled"];
const TERMINAL_TYPES_SQL = TERMINAL_RUN_EVENT_TYPES.map((t) => `'${t}'`).join(", ");

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
 * maintenance reconcile pass (including startup acceleration) — no
 * per-connector/per-
 * provider special case, no manual data mutation. Bump this whenever a
 * change to `mergeEventStreamFacts`'s merge semantics could change the
 * output for existing already-folded event history.
 */
// Version 3 makes source manifest-generation provenance part of the fold
// contract. A v2 current map may have folded events created before that
// provenance existed, so it is never a valid baseline after this upgrade:
// `seedFoldState` replays it from an empty map on the first observation.
//
// Version 4 refines the v3 generation-match predicate: an unstamped
// (pre-provenance) terminal event is now accepted as current-generation
// evidence while the connection's durable generation has never advanced past
// 0 (see `foldTerminalEventFacts`). A v3 current map may have refused such
// events outright (treating every NULL stamp as historical regardless of the
// connection's generation), so it is never a valid baseline after this
// upgrade either: `seedFoldState` replays it from an empty map on the first
// observation, exactly like the v2->v3 upgrade.
//
// Version 5 teaches the fold to read a recovery-only run's terminal
// `recovery_gap_closure_facts` block (`applyRecoveryGapClosureFacts`) — a
// narrower, durable-gap-sourced fact that narrows an existing fact's
// `covered` count. A row whose checkpoint already sits past such a
// recovery-only event under OLD v4 logic folded it as a complete no-op
// (the event carried no `collection_facts`, so `parseTerminalFactEvent`
// alone gated the entire row out before this change). This is crucial
// for rolling mixed-version deployments: a NEW v5 runtime emits the
// `recovery_gap_closure_facts` block for recovery-only runs, but an OLD
// v4 folder has no `applyRecoveryGapClosureFacts` hook and ignores it.
// That v4 folder's stored fact remains stale. Under v5, replay healing
// matters: a v5 folder re-reading an old v4-folded row will see the
// missed recovery-gap-closure event and narrow the fact. Genuinely
// pre-change (pre-v5) terminal events for recovery-only runs never carry
// the block (the old runtime never emitted it), so they are unaffected:
// the fold only re-reads to narrow EXISTING facts, never to originate
// fresh ones. A v4 current map is never a valid baseline after this
// upgrade, for the same self-healing reason as v2->v3 and v3->v4.
//
// Version 6 adds the measured-boundary guard to `mergeEventStreamFacts`: a
// newer fact carrying no measured `considered` denominator no longer erases
// a stored fact that carries one. A v5 map may already have folded exactly
// that erasure — an incremental change-feed run (or any run that commits a
// checkpoint without emitting DETAIL_COVERAGE) overwriting a full
// enumeration's proof — and parked its checkpoint past the erasing event,
// so the destroyed proof would stay destroyed even after this fix ships.
// A v5 current map is therefore never a valid baseline: `seedFoldState`
// replays it from an empty map on the first observation, exactly like every
// upgrade above, and the true proof is recovered from the retained terminal
// event history that still holds it.
// Exported so tests can assert "the row carries THIS binary's fold version"
// against the constant itself rather than against a copied literal. Several
// tests previously hardcoded the then-current number and had to be edited on
// every semantics bump, which makes a stale literal — not a real regression —
// look like a failure.
export const STREAM_FACTS_FOLD_LOGIC_VERSION = 6;
// A route may retry a replay once after a concurrent writer wins its CAS.
// This is deliberately small: each retry rereads the durable baseline, and
// persistent contention fails closed in memory rather than spinning or
// trusting a version-behind map.
const STREAM_FACTS_CAS_REPLAY_ATTEMPTS = 2;

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
    return { params: [], sql: "" };
  }
  const placeholders = scope.map((_, i) => `$${startParamIndex + i}`).join(", ");
  return { params: [...scope], sql: ` AND connector_instance_id IN (${placeholders})` };
}

function buildTerminalScopeFragmentSqlite(scope: readonly string[] | null): { sql: string; params: unknown[] } {
  if (scope === null || scope.length === 0) {
    return { params: [], sql: "" };
  }
  const placeholders = scope.map(() => "?").join(", ");
  return { params: [...scope], sql: ` AND connector_instance_id IN (${placeholders})` };
}

/**
 * `INDEXED BY idx_spine_events_terminal_instance_seq` for the three terminal
 * SQLite fold queries below, but ONLY when the query is genuinely scoped to
 * `connector_instance_id` (mirrors `buildTerminalScopeFragmentSqlite`'s own
 * null/empty branching exactly) -- forcing this index without that predicate
 * would still be CORRECT (its own WHERE clause guarantees `event_type IN
 * (terminal)`, a superset the partial index always satisfies) but pins a
 * fleet-wide, unscoped read to an index keyed on a column it never filters
 * by, which can only be worse, never better, for that one caller shape.
 *
 * Added alongside `idx_spine_events_instance_seq` (the general,
 * every-event-type lifecycle-checkpoint index, connector-summary-evidence-
 * engine.ts): once that general index existed as an alternative, SQLite's
 * planner -- lacking cardinality stats for a partial index's WHERE clause --
 * started preferring the general (larger) index for these terminal-only,
 * `connector_instance_id`-scoped queries even though the terminal partial
 * index is a strict subset match for the exact same predicate. Measured
 * directly against a 100k-row single-connection terminal backlog: ~1.4-1.9x
 * slower per call with the general index, compounding across an entire
 * bounded fold pass into real wall-clock drift
 * (connector-summary-sweep-stuck-page-starvation.test.ts's deliberately
 * tight ROUND_MS=50 budget went from reliably green to reliably red before
 * this hint existed). This does not undo the general index -- both indexes
 * are real and independently load-bearing -- it only breaks the tie in
 * SQLite's planner back toward the smaller, already-correct index for the
 * queries that were always meant to use it.
 */
function terminalScopeIndexHintSqlite(scope: readonly string[] | null): string {
  return scope === null || scope.length === 0 ? "" : " INDEXED BY idx_spine_events_terminal_instance_seq";
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
        return value === null ? null : Number(value);
      },
      async readMaxTerminalEventSeqByInstance(scope: readonly string[] | null): Promise<ReadonlyMap<string, number>> {
        const { sql: scopeSql, params: scopeParams } = buildTerminalScopeFragmentPostgres(scope, 1);
        const result = await postgresQuery(
          `SELECT connector_instance_id, MAX(event_seq) AS max_seq
             FROM spine_events
            WHERE event_type IN (${TERMINAL_TYPES_SQL})
              AND connector_instance_id IS NOT NULL${scopeSql}
            GROUP BY connector_instance_id`,
          scopeParams
        );
        const byInstance = new Map<string, number>();
        for (const row of result.rows as Row[]) {
          byInstance.set(String(row.connector_instance_id), Number(row.max_seq));
        }
        return byInstance;
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
          `SELECT event_seq, occurred_at, run_id, manifest_generation, data_json::text AS data_json
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
                  terminal_facts_reason_code = $7,
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = CASE
                    WHEN list_summary_projection_state = 'current' THEN 'stale'
                    ELSE list_summary_projection_state
                  END,
                  list_summary_projection_reason_code = CASE
                    WHEN list_summary_projection_state = 'current' THEN 'canonical_evidence_changed'
                    ELSE list_summary_projection_reason_code
                  END
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
      const indexHint = terminalScopeIndexHintSqlite(scope);
      const row = getDb()
        .prepare(
          `SELECT MAX(event_seq) AS max_seq FROM spine_events${indexHint} WHERE event_type IN (${TERMINAL_TYPES_SQL})${scopeSql}`
        )
        .get(...scopeParams) as Row | undefined;
      const value = row?.max_seq;
      return value === null ? null : Number(value);
    },
    readMaxTerminalEventSeqByInstance(scope: readonly string[] | null): ReadonlyMap<string, number> {
      const { sql: scopeSql, params: scopeParams } = buildTerminalScopeFragmentSqlite(scope);
      const indexHint = terminalScopeIndexHintSqlite(scope);
      const rows = getDb()
        .prepare(
          `SELECT connector_instance_id, MAX(event_seq) AS max_seq
             FROM spine_events${indexHint}
            WHERE event_type IN (${TERMINAL_TYPES_SQL})
              AND connector_instance_id IS NOT NULL${scopeSql}
            GROUP BY connector_instance_id`
        )
        .all(...scopeParams) as Row[];
      const byInstance = new Map<string, number>();
      for (const row of rows) {
        byInstance.set(String(row.connector_instance_id), Number(row.max_seq));
      }
      return byInstance;
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
      // See `terminalScopeIndexHintSqlite`'s doc: without this hint, SQLite's
      // planner started preferring the general `idx_spine_events_instance_seq`
      // index (added alongside this one) over the smaller, already-correct
      // terminal partial index for this exact scoped/terminal-filtered shape
      // -- measured ~1.4-1.9x slower per call, which compounds across an
      // entire bounded fold pass into enough wall-clock drift to break
      // connector-summary-sweep-stuck-page-starvation.test.ts's deliberately
      // tight ROUND_MS=50 budget.
      const indexHint = terminalScopeIndexHintSqlite(scope);
      return getDb()
        .prepare(
          `SELECT event_seq, occurred_at, run_id, manifest_generation, data_json
             FROM spine_events${indexHint}
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
                  terminal_facts_reason_code = ?,
                  canonical_evidence_revision = canonical_evidence_revision + 1,
                  list_summary_projection_state = CASE
                    WHEN list_summary_projection_state = 'current' THEN 'stale'
                    ELSE list_summary_projection_state
                  END,
                  list_summary_projection_reason_code = CASE
                    WHEN list_summary_projection_state = 'current' THEN 'canonical_evidence_changed'
                    ELSE list_summary_projection_reason_code
                  END
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
    terminalFactsReasonCode: args.terminalFactsReasonCode ?? null,
    terminalFactsState: args.terminalFactsState ?? "current",
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

/** Parse a terminal event row's raw JSON payload, or `null` on a malformed row. */
function parseTerminalEventPayload(row: Row): Row | null {
  let data: unknown;
  try {
    data = JSON.parse(String(row.data_json ?? "null"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  return data as Row;
}

/** Parse a terminal event row's payload into its fact stream array, or `null` when it carries none. */
function parseTerminalFactEvent(row: Row): { payload: Row; streams: unknown[] } | null {
  const payload = parseTerminalEventPayload(row);
  if (!payload) {
    return null;
  }
  const block = payload.collection_facts as Row | undefined;
  const streams = block && typeof block === "object" && Array.isArray(block.streams) ? block.streams : null;
  return streams && streams.length > 0 ? { payload, streams } : null;
}

/**
 * Parse a terminal event row's payload into its `recovery_gap_closure_facts`
 * stream array, or `null` when it carries none. Distinct from
 * `parseTerminalFactEvent`/`collection_facts`: see
 * `buildRecoveryGapClosureFacts` (`runtime/connector-gap-bounding.ts`) for
 * why this is a separate block with separate merge semantics
 * (`applyRecoveryGapClosureFacts`, below).
 */
function parseRecoveryGapClosureFactEvent(row: Row): { payload: Row; streams: unknown[] } | null {
  const payload = parseTerminalEventPayload(row);
  if (!payload) {
    return null;
  }
  const block = payload.recovery_gap_closure_facts as Row | undefined;
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
 * `test/connector-summary-stream-facts.test.js`'s "monotonic guard" cases
 * (this predicate's `committed`/`disabled` behavior at the store layer) and
 * `test/connector-coverage-policy.test.js` (the same boundary's behavior at
 * the coverage-derivation layer).
 */
function factCheckpointProvesDurableCoverage(fact: Row): boolean {
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const checkpoint = fact.checkpoint;
  return checkpoint === "committed" || checkpoint === "disabled";
}

/**
 * Whether a stream fact carries a MEASURED enumeration boundary — a
 * `considered` denominator the connector measured at the enumeration site.
 *
 * This is deliberately a test of PRESENCE, never of magnitude. A measured
 * `considered: 0` is a positive statement ("I enumerated the boundary and it
 * held nothing"), which is exactly how a zero-result run legitimately proves
 * verified emptiness — so it counts as measured here, and a genuine zero
 * therefore stays able to replace a larger prior proof. The predicate mirrors
 * the contract's own `readCount` acceptance rule (a finite, non-negative
 * number), so a malformed denominator reads as UNMEASURED rather than being
 * laundered into a boundary; it is the same question
 * `evaluateStreamCoherence` asks before it can return `enumeration_boundary`,
 * and the same one `isCheckpointOnlyClaim` asks to name a checkpoint-only
 * claim. Mirrored rather than imported for the reason documented on
 * `factCheckpointProvesDurableCoverage` above: this raw-facts store must not
 * depend on how coverage is derived.
 */
function factCarriesMeasuredBoundary(fact: Row): boolean {
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const considered = fact.considered;
  return typeof considered === "number" && Number.isFinite(considered) && considered >= 0;
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
 * Measured-boundary guard (a second, INDEPENDENT floor): once a stream's
 * stored fact carries a measured enumeration boundary (a `considered`
 * denominator — see `factCarriesMeasuredBoundary`), a newer attempt that
 * carries none does not replace it. The checkpoint floor above cannot cover
 * this case, because a run that structurally cannot measure still commits
 * its checkpoint honestly: an incremental change-feed pass (CardDAV
 * `sync-collection`, RFC 6578) makes real durable cursor progress while
 * deliberately WITHHOLDING coverage keys, since its `considered` would count
 * only CHANGED resources and a quiet run would otherwise read as a
 * proven-empty inventory. Such a fact clears the checkpoint floor and would
 * erase a genuine proof.
 *
 * The guard keys on PRESENCE of the measurement, never its magnitude, so it
 * is a floor on EVIDENCE KIND rather than on counts: the newest MEASURING
 * fact always wins, even when it measures a smaller number or a genuine
 * zero. That is what keeps a truthful zero expressible and stops the fold
 * from freezing a stale high-water mark after an upstream deletion. The
 * fold retains the newest fact that actually measured — not the newest fact,
 * and not the largest.
 *
 * A stream with no prior durably-proven fact is unaffected by the guard:
 * every attempt — resolved or not — still replaces it, so an honestly-never-
 * proven stream keeps surfacing its newest (possibly unresolved) attempt
 * rather than silently freezing on the first thing recorded for it. The same
 * holds for a never-measured stream under the measured-boundary guard. Run
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
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
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
    if (existing && factCarriesMeasuredBoundary(existing.fact) && !factCarriesMeasuredBoundary(rawFact as Row)) {
      // The stored fact measured an enumeration boundary; this newer attempt
      // measured none. A run that structurally CANNOT measure — an
      // incremental change-feed pass, whose `considered` would count only
      // CHANGED resources — commits its checkpoint legitimately and so
      // clears the checkpoint floor above, yet carries no coverage keys at
      // all. Letting it win would silently destroy a proof an earlier full
      // enumeration genuinely earned, resetting the stream to "Not
      // measured". Absence of measurement is not newer information than a
      // measurement, so the measured fact stands.
      continue;
    }
    facts[stream] = {
      event_seq: provenance.eventSeq,
      evidence_as_of: provenance.evidenceAsOf,
      fact: rawFact as Row,
      run_id: provenance.runId,
    };
    counters.folded += 1;
  }
}

/**
 * Merge one recovery-only terminal event's `recovery_gap_closure_facts` into
 * a connection's stream-fact map. Unlike `mergeEventStreamFacts` (newest
 * attempt WINS, wholesale), this NARROWS an existing durably-proven fact —
 * it never originates a fresh fact for a stream this run did not otherwise
 * measure, and never changes a stream's `considered` denominator.
 *
 * Preconditions to apply, per stream (all must hold, else the stream's
 * closure count for THIS event is silently dropped — never queued or
 * retried, since a later genuine measurement or recovery event is the only
 * thing that can ever produce new proof for it):
 *   - a stored fact already exists AND its own `checkpoint` proves durable
 *     coverage (`committed`/`disabled` — same predicate the ordinary
 *     monotonicity guard uses). A stream with no durably-proven fact yet has
 *     nothing this can narrow: closing gaps against unmeasured inventory
 *     would be inventing a `considered` denominator this run never proved.
 *   - the stored fact declares a known `considered` (else there is no
 *     denominator to close against).
 *
 * The delta itself: `covered` advances by `recovered_count`, floored at the
 * stream's current `covered ?? collected` and capped at `considered` (a
 * recovered gap can never push `covered` past the stream's own proven
 * denominator — that would be claiming MORE than the last genuine
 * measurement itself claimed). `collected`/`checkpoint`/every other field on
 * the stored fact is left untouched. Provenance (`run_id`/`evidence_as_of`/
 * `event_seq`) DOES advance to this recovery event — this is honest, not
 * provenance falsification, because the delta being stamped (`covered`
 * narrowing toward `considered`) is exactly what this run durably proved
 * (real `DETAIL_GAP_RECOVERED` store transitions), not a carried-forward
 * inventory claim dressed up as fresh.
 *
 * Composes correctly across multiple recovery events for the same stream
 * within one fold pass: each call reads/writes `facts[stream]` in place, so
 * a second recovery event's delta narrows the first's already-narrowed
 * result, in ascending `event_seq` order (see `drainTerminalEventBatches`).
 */
function applyRecoveryGapClosureFacts(
  facts: Record<string, StoredStreamFactEntry>,
  streams: readonly unknown[],
  provenance: { evidenceAsOf: string | null; runId: string | null; eventSeq: number },
  counters: { folded: number; refused: number }
): void {
  for (const rawEntry of streams) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const stream = (rawEntry as Row).stream;
    const recoveredCount = (rawEntry as Row).recovered_count;
    if (typeof stream !== "string" || !stream || typeof recoveredCount !== "number" || recoveredCount <= 0) {
      continue;
    }
    const existing = facts[stream];
    if (!existing || existing.event_seq > provenance.eventSeq) {
      continue;
    }
    if (!factCheckpointProvesDurableCoverage(existing.fact)) {
      // No durably-proven inventory to narrow — never originate a fact here.
      continue;
    }
    // biome-ignore lint/style/useDestructuring: Explicit property access documents this compatibility boundary.
    const considered = existing.fact.considered;
    if (typeof considered !== "number") {
      // No known denominator to close gaps against.
      continue;
    }
    const priorCovered = typeof existing.fact.covered === "number" ? existing.fact.covered : existing.fact.collected;
    if (typeof priorCovered !== "number") {
      continue;
    }
    const nextCovered = Math.min(considered, priorCovered + recoveredCount);
    if (nextCovered === priorCovered) {
      continue;
    }
    facts[stream] = {
      event_seq: provenance.eventSeq,
      evidence_as_of: provenance.evidenceAsOf,
      fact: { ...existing.fact, covered: nextCovered },
      run_id: provenance.runId,
    };
    counters.folded += 1;
  }
}

/** Fold one terminal event's fact block(s) into the per-instance maps. */
function foldTerminalEventFacts(
  factsByInstance: Map<string, Record<string, StoredStreamFactEntry>>,
  checkpointByInstance: Map<string, number | null>,
  generationByInstance: ReadonlyMap<string, number>,
  generationCurrentByInstance: Map<string, boolean>,
  row: Row,
  counters: { folded: number; refused: number }
): void {
  const parsed = parseTerminalFactEvent(row);
  // Distinct, independently-optional block (see `buildRecoveryGapClosureFacts`):
  // a recovery-only run's `run.completed` carries THIS but never
  // `collection_facts`, so `parsed` alone must not gate whether the row is
  // worth attributing/generation-fenced/checkpoint-gated below.
  const parsedGapClosure = parseRecoveryGapClosureFactEvent(row);
  if (!(parsed || parsedGapClosure)) {
    return;
  }
  const payload = (parsed || parsedGapClosure)?.payload as Row;
  const instanceId = readEventConnectionId(payload);
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
  const eventGeneration = row.manifest_generation;
  const currentGeneration = generationByInstance.get(instanceId);
  // A NULL stamp means the event predates generation provenance
  // (`stamp_terminal_manifest_generation`, introduced alongside this gate).
  // It is safe to treat as generation 0 evidence ONLY while the connection's
  // durable generation has never advanced past 0 — generation 0 is by
  // construction the only generation such a connection has ever had, so an
  // unstamped event cannot belong to any other generation. The moment the
  // connection's generation advances to >= 1, its NULL rows become
  // permanently ambiguous (they could predate or postdate any earlier
  // untracked manifest change) and must stay historical forever, exactly
  // like a genuinely mismatched non-NULL stamp.
  const eventGenerationMatches =
    eventGeneration === null ? currentGeneration === 0 : Number(eventGeneration) === currentGeneration;
  if (!eventGenerationMatches) {
    // A missing stamp on a never-advanced connection is handled above; this
    // is either a missing stamp on an already-advanced connection, or an
    // unequal stamp belonging to a prior manifest generation. Both are
    // historical, never current proof.
    generationCurrentByInstance.set(instanceId, false);
    counters.refused += 1;
    return;
  }
  generationCurrentByInstance.set(instanceId, true);
  const eventSeq = Number(row.event_seq);
  const checkpoint = checkpointByInstance.get(instanceId);
  if (!Number.isFinite(eventSeq) || (checkpoint !== null && checkpoint !== undefined && eventSeq <= checkpoint)) {
    return;
  }
  const provenance = {
    eventSeq,
    evidenceAsOf: typeof row.occurred_at === "string" && row.occurred_at ? row.occurred_at : null,
    runId: typeof row.run_id === "string" && row.run_id ? row.run_id : null,
  };
  if (parsed) {
    mergeEventStreamFacts(facts, parsed.streams, provenance, counters);
  }
  if (parsedGapClosure) {
    applyRecoveryGapClosureFacts(facts, parsedGapClosure.streams, provenance, counters);
  }
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
  const version = row.stream_facts_fold_version === null ? null : Number(row.stream_facts_fold_version);
  return version === null || version < STREAM_FACTS_FOLD_LOGIC_VERSION;
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
  const version = row.stream_facts_fold_version === null ? null : Number(row.stream_facts_fold_version);
  return version !== null && version > STREAM_FACTS_FOLD_LOGIC_VERSION;
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
 *
 * `instanceIdsWithAnyTerminalHistory` (`maxSeqByInstance`'s key set, from
 * the caller) is what makes the historical-reason seed below TRUTHFUL. It
 * answers "does this instance have ANY attributable terminal fact event,
 * ever, at any generation" — not "was this row's own stored reason code
 * historical last time," which is a description of the fold's PRIOR
 * VERDICT, not of the underlying event log, and self-perpetuates once
 * wrong (see the reproduction in
 * connector-summary-fold-page-scope-zero-history-reproduction.test.ts): a
 * zero-terminal-event row that is ever externally or transiently stamped
 * `terminal_facts_historical` can never produce a fact-carrying event to
 * flip `generationCurrentByInstance` back to `true` during the drain (its
 * scoped read is always empty), so seeding straight from its own incoming
 * reason code re-writes the identical wrong verdict every single pass,
 * forever.
 */
function seedFoldState(
  participants: readonly Row[],
  instanceIdsWithAnyTerminalHistory: ReadonlySet<string>
): {
  casBaselineByInstance: Map<string, FoldCasBaseline>;
  checkpointByInstance: Map<string, number | null>;
  factsByInstance: Map<string, Record<string, StoredStreamFactEntry>>;
  generationByInstance: Map<string, number>;
  generationCurrentSeedByInstance: Map<string, boolean>;
  sinceSeq: number;
} {
  const factsByInstance = new Map<string, Record<string, StoredStreamFactEntry>>();
  const checkpointByInstance = new Map<string, number | null>();
  const casBaselineByInstance = new Map<string, FoldCasBaseline>();
  const generationByInstance = new Map<string, number>();
  const generationCurrentSeedByInstance = new Map<string, boolean>();
  let sinceSeq = Number.POSITIVE_INFINITY;
  for (const row of participants) {
    const instanceId = String(row.connector_instance_id);
    generationByInstance.set(instanceId, Number(row.manifest_generation ?? 0));
    const versionBehind = rowIsFoldLogicVersionBehind(row);
    const parsed = versionBehind ? null : parseEvidenceJson(row.stream_latest_facts_json, null);
    factsByInstance.set(
      instanceId,
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, StoredStreamFactEntry>) }
        : {}
    );
    const checkpoint = versionBehind || row.stream_facts_event_seq === null ? null : Number(row.stream_facts_event_seq);
    checkpointByInstance.set(instanceId, checkpoint);
    casBaselineByInstance.set(instanceId, {
      eventSeq: row.stream_facts_event_seq === null ? null : Number(row.stream_facts_event_seq),
      foldVersion: row.stream_facts_fold_version === null ? null : Number(row.stream_facts_fold_version),
    });
    // The pass's default verdict for an instance no qualifying event touches
    // THIS round (e.g. a generation-transition boundary whose checkpoint
    // already sits at this round's high-water mark, so the drain genuinely
    // reads zero events for it): inherit the row's OWN incoming generation
    // verdict, never a blind `true`. A row already refused as historical for
    // a GENERATION reason (`terminal_facts_historical` — no attributable
    // event ever matched; or `manifest_generation_changed` — a fresh
    // transition just cleared it) must stay non-current when nothing new is
    // found — "no new events" is silence, not proof the source generation is
    // still current.
    //
    // This carry-forward is only truthful when a real attributable terminal
    // event actually exists somewhere in this instance's history (that is
    // the fact `terminal_facts_historical` is supposed to describe — see
    // `foldTerminalEventFacts`'s generation-mismatch refusal). A row with NO
    // attributable terminal event EVER (`instanceIdsWithAnyTerminalHistory`
    // does not contain it) has nothing historical to carry forward; its
    // reason code, if already `terminal_facts_historical`, can only be the
    // fold's own prior verdict about itself, which must not be treated as
    // new evidence — doing so makes a zero-history row that was ever
    // wrongly/transiently stamped historical re-confirm the identical wrong
    // verdict every pass, permanently, since its own drain read is always
    // empty and can never produce the flip back to `true` any other way.
    //
    // Deliberately NARROW beyond that: this must NOT catch every non-
    // `current` state. `terminal_fold_incomplete` (a still-in-progress
    // BUDGETED replay of a generation-CURRENT row) is an orthogonal reason —
    // seeding `false` for it would make `writeParticipantStreamFacts` floor
    // the checkpoint at its stale baseline every resumption round
    // (`sourceGenerationCurrent ? writeSeq : checkpointByInstance.get(...)`),
    // which never advances and starves the bounded-resume contract's own
    // convergence. Only the two generation-refusal reason codes, AND only
    // when real terminal history exists to refuse, seed `false`; every other
    // case (`terminal_fold_incomplete`, `terminal_fold_failed`,
    // `terminal_fold_contention`, `unobserved`, `current`, or a historical
    // reason with no attributable history behind it) seeds `true` — the
    // neutral "assume still current, let a real refused event this round
    // override it" default this predicate always had.
    generationCurrentSeedByInstance.set(
      instanceId,
      !instanceIdsWithAnyTerminalHistory.has(instanceId) ||
        (row.terminal_facts_reason_code !== REASON_CODES.TERMINAL_FACTS_HISTORICAL &&
          row.terminal_facts_reason_code !== "manifest_generation_changed")
    );
    // A participant with NO checkpoint has never had a terminal event folded
    // into it, so it holds no position in the event log to resume from.
    // Seeding it as 0 makes it the floor for EVERY participant, because
    // `sinceSeq` is the minimum across the pass -- one such row rewinds the
    // whole fold to the beginning of the log.
    //
    // Observed in production 2026-08-17: three sources whose records arrived
    // outside a collection run each sat at checkpoint 0, so the fold floor was
    // 0 against a 1,438,556-event log while the oldest real checkpoint was
    // 1,350,342 (~88k events of genuine work). Every bounded 2s pass restarted
    // at 0, read ZERO qualifying events, wrote nothing, reported `incomplete`,
    // and repeated -- leaving every row stale indefinitely.
    //
    // Such a participant still takes part in the pass and is still written by
    // it; it simply must not drag the shared read cursor backward. When EVERY
    // participant lacks a checkpoint the floor stays 0, so a fresh install
    // still reads from the beginning.
    // Guard 0 as well as null. A row that has never had a terminal event
    // folded into it stores a literal 0 checkpoint, not NULL, so guarding
    // only null still let it pull the shared floor to the beginning of the
    // log -- observed after the first fix shipped: the floor read 0 again
    // with four participants, and the sweep resumed burning its budget from
    // seq 0 against a 1.44M-event log.
    if (checkpoint !== null && checkpoint > 0) {
      sinceSeq = Math.min(sinceSeq, checkpoint);
    }
  }
  if (!Number.isFinite(sinceSeq)) {
    sinceSeq = 0;
  }
  return {
    casBaselineByInstance,
    checkpointByInstance,
    factsByInstance,
    generationByInstance,
    generationCurrentSeedByInstance,
    sinceSeq,
  };
}

export interface FoldStreamFactsResult {
  /** Participant ids whose CAS write still lost after the bounded replay attempts. */
  readonly casRejectedInstanceIds: readonly string[];
  /** Terminal events read from the scoped event log during this pass. */
  readonly eventsRead: number;
  readonly folded: number;
  /**
   * `true` when this call's own work budget (`maxDurationMs`/`maxEvents`)
   * was exhausted before every participant reached the pass's high-water
   * mark (Sol fourth-verdict P1.2: "the fold itself must be budgeted and
   * resumable, not merely the connection-page enumeration around it").
   * `false` for every unbudgeted call (the exact prior behavior) and for a
   * budgeted call that genuinely finished within its budget.
   */
  readonly incomplete: boolean;
  /** The checkpoint written for this pass, or null without participants. */
  readonly minimumCheckpointAfter: number | null;
  /** The oldest participating checkpoint before this pass, or null without participants. */
  readonly minimumCheckpointBefore: number | null;
  readonly participants: number;
  readonly refused: number;
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
 * runs a complete pass as a sequence of instance-scoped folds, preserving
 * complete coverage without a fleet-global terminal receipt.
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
 * checkpoint genuinely lags `maxSeq`, OR it is fold-logic-version-behind
 * (see `rowIsFoldLogicVersionBehind`) — in which case it participates
 * regardless of how far its stale checkpoint already advanced, so a
 * fold-semantics fix self-heals every existing row rather than only
 * affecting future terminal events. A row left mid-UPGRADE-REPLAY by a
 * budget-exhausted prior pass needs no separate branch here: its stored
 * `stream_facts_event_seq` is necessarily below `maxSeq` (the drain that
 * wrote it stopped short — see `drainTerminalEventBatches`), so the
 * ordinary checkpoint-lag predicate below already selects it, resuming
 * (not restarting) from its own genuine partial progress. A fold-logic-
 * version-AHEAD row (see `rowIsFoldLogicVersionAhead`) NEVER participates —
 * this binary must not fold, replay, or overwrite output a newer fold
 * contract produced.
 *
 * `maxSeq` here is the CALLER-CHOSEN high-water to judge this one row
 * against — `foldConnectorSummaryStreamFactsOnce` passes this row's own
 * per-instance `MAX(event_seq)`, never the shared page-wide one, so a row
 * whose own attributable history was already fully folded does not keep
 * re-participating in every subsequent page-scoped pass merely because an
 * unrelated connection sharing the page still has a higher event_seq.
 */
function rowNeedsFoldParticipation(row: Row, maxSeq: number | null): boolean {
  if (rowIsFoldLogicVersionAhead(row)) {
    return false;
  }
  // A manifest fingerprint transition intentionally clears the terminal map
  // while retaining the current event high-water as its generation boundary.
  // It still needs a fold pass to attempt converging: a NEW post-boundary
  // fact-carrying event (stamped with the connection's new current
  // generation) DOES turn it current again — but with zero such events since
  // the boundary, the pass converges to the SAME non-current verdict it
  // started with (see `seedFoldState`'s `generationCurrentSeedByInstance`,
  // which seeds `false` from exactly this row's own incoming
  // `manifest_generation_changed`/`terminal_facts_historical` reason code, so
  // silence is never misread as proof the source generation is still
  // current). This is distinct from a genuinely checkpointed-EMPTY history
  // (`stampZeroCheckpointForBootstrap`'s zero-terminal-events-ever case),
  // which IS current — a connection that has never had any terminal history
  // has nothing to be historical ABOUT. The same retry behavior (participate
  // every pass until genuinely converged) is correct for other recoverable
  // terminal-fold failures too.
  // A row refused as `terminal_facts_historical` has no attributable event at
  // its own generation. Re-running the fold changes nothing until a NEW
  // fact-carrying event lands at that generation -- which is exactly what
  // `maxSeq` movement detects below. Participating unconditionally makes such
  // a row rejoin every pass forever, converging to the identical verdict each
  // time while consuming the shared budget.
  //
  // Observed in production 2026-08-17: seven sources whose records arrived
  // outside a collection run (manual imports, device uploads, recovered
  // archives) held this reason permanently. The sweep ran 10.5s against its
  // 2s budget with those seven as participants, so eight OTHER rows that had
  // genuinely just collected sat `dirty` and never got repaired -- the same
  // starvation shape as the checkpoint floor, one layer up.
  //
  // Fall through to the checkpoint-lag predicate instead: the row still
  // rejoins the moment the log advances past its checkpoint, so a real new
  // event converges it, and pure silence no longer costs a pass. Every other
  // non-current state (fold failure, contention, incomplete replay) is
  // genuinely retryable and still participates unconditionally.
  if (row.terminal_facts_state !== "current" && row.terminal_facts_reason_code !== "terminal_facts_historical") {
    return true;
  }
  if (rowIsFoldLogicVersionBehind(row)) {
    return true;
  }
  const checkpoint = row.stream_facts_event_seq;
  // A row refused as historical with a zero checkpoint has no terminal event
  // at its own generation AND no position in the log. Checkpoint-lag is
  // trivially true for it (0 < maxSeq always), so falling through to that
  // predicate makes it rejoin every pass forever -- exactly the starvation
  // the historical carve-out above was meant to end.
  //
  // `dirty` is the re-entry signal, and it has to be checked HERE: this
  // predicate is the only gate into `participants`, and the fold's write path
  // is the only thing that advances `stream_facts_event_seq`. Without the
  // dirty term below, a row already sitting at zero had no way back in --
  // marking it dirty cleared the flag via the repair path while
  // `terminal_fold_participants` stayed 0, so the exclusion was permanent.
  // Three production rows reached that state, one an active connection.
  //
  // Admitting a dirty row costs one pass, not a return to the livelock: once
  // it participates, the write path stamps its checkpoint to at least the
  // round's own high-water and never re-freezes at zero, so this clause
  // cannot match that row again.
  if (
    Number(checkpoint ?? 0) === 0 &&
    row.terminal_facts_reason_code === "terminal_facts_historical" &&
    Number(row.dirty ?? 0) === 0
  ) {
    return false;
  }
  return checkpoint === null || (maxSeq !== null && Number(checkpoint) < maxSeq);
}

/**
 * No terminal events exist yet for this scope: stamp a zero checkpoint on
 * every participant so fresh rows do not re-participate on every pass. An
 * unbounded pass converges because there is no terminal history to replay;
 * a bounded pass checks its cooperative deadline before every durable stamp
 * and returns incomplete when it defers remaining rows. Every accepted write
 * is `terminal_facts_state = 'current'` with a fresh
 * `stream_latest_facts_json = NULL` (exact replacement, never a stale
 * carry-forward from a superseded fold-logic version). `participants` never
 * includes a fold-logic-version-
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
  participants: readonly Row[],
  deadline: number | null
): Promise<{ readonly casRejectedInstanceIds: readonly string[]; readonly incomplete: boolean }> {
  const casRejectedInstanceIds: string[] = [];
  for (const row of participants) {
    if (deadline !== null && Date.now() >= deadline) {
      return { casRejectedInstanceIds, incomplete: true };
    }
    const connectorInstanceId = String(row.connector_instance_id);
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    const accepted = await foldStore.updateStreamFacts({
      baselineEventSeq: row.stream_facts_event_seq === null ? null : Number(row.stream_facts_event_seq),
      baselineFoldVersion: row.stream_facts_fold_version === null ? null : Number(row.stream_facts_fold_version),
      connectorInstanceId,
      eventSeq: 0,
      factsJson: null,
      foldVersion: STREAM_FACTS_FOLD_LOGIC_VERSION,
      terminalFactsReasonCode: null,
      terminalFactsState: "current",
    });
    if (!accepted) {
      casRejectedInstanceIds.push(connectorInstanceId);
    }
  }
  return { casRejectedInstanceIds, incomplete: false };
}

/** One round-robin slice's read size per participant per rotation. */
const STREAM_FACTS_FOLD_ROUND_ROBIN_SLICE = 200;

/**
 * Drain terminal-event batches per PARTICIPANT, round-robin, until every
 * participant's own cursor reaches its own `ownMaxSeqByInstance` high-water
 * or the caller's shared budget (`deadline`/`maxEvents`) is exhausted.
 * Folds each read row into `factsByInstance`/`checkpointByInstance`, exactly
 * as the prior single-cursor drain did. Checked between per-participant
 * slices, never mid-slice, so a slice already in flight always finishes
 * cleanly (Sol fourth-verdict P1.2).
 *
 * FAIRNESS (this function's reason to exist): a single shared cursor
 * scanning the whole scope in one ascending `event_seq` order lets a
 * connection with a large backlog and the LOWEST checkpoint consume the
 * entire shared budget before the cursor ever reaches a later
 * participant's own high-water — even when that later participant's own
 * attributable history is short or already fully read. Round-robin gives
 * every participant a bounded `STREAM_FACTS_FOLD_ROUND_ROBIN_SLICE`-sized
 * turn each rotation, in `ownCursorByInstance` order, so a participant whose
 * own history is short (or already caught up) converges within its own
 * first turn or two regardless of how large another participant's backlog
 * is. A participant already at/above its own high-water (`ownCursor >=
 * ownMaxSeq`) is skipped entirely — zero read cost, not merely a fast
 * no-op read — so it cannot be starved of a turn by participants still
 * mid-backlog.
 *
 * Each per-participant read is itself scoped to exactly that one
 * `connector_instance_id` (`scope: [instanceId]`) and bounded above by that
 * participant's OWN `ownMaxSeq`, never the page-wide `maxSeq` — the same
 * per-instance high-water the 05b7ac592 write-phase fairness fix already
 * introduced (`maxSeqByInstance`). This is what makes a fully-caught-up
 * participant's read return in one empty/short round-trip rather than
 * scanning past other participants' interleaved events to find its own.
 *
 * `maxEvents`, when provided, remains ONE real budget shared across every
 * participant's slices this call makes (summed, not per-participant) —
 * exactly the existing "one real overall maxEvents/maxDuration budget"
 * contract. `deadline` is likewise one shared wall-clock cutoff.
 *
 * Returns the per-instance cursor every participant's replay actually
 * reached (`cursorByInstance`) plus the aggregate `eventsRead` and whether
 * ANY participant's own high-water was not reached before the budget ran
 * out (`budgetExhausted`) — the caller (`foldConnectorSummaryStreamFactsOnce`)
 * already judges each participant's OWN convergence against its OWN
 * `ownMaxSeq`/cursor pair, never a shared one.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The round-robin fairness scheduler owns interleaved per-participant budget/convergence state that must remain local.
async function drainTerminalEventBatches({
  foldStore,
  factsByInstance,
  checkpointByInstance,
  generationByInstance,
  generationCurrentByInstance,
  counters,
  ownMaxSeqByInstance,
  startCursorByInstance,
  deadline,
  maxEvents,
}: {
  foldStore: ReturnType<typeof createStreamFactsFoldStore>;
  factsByInstance: Map<string, Record<string, StoredStreamFactEntry>>;
  checkpointByInstance: Map<string, number | null>;
  generationByInstance: ReadonlyMap<string, number>;
  generationCurrentByInstance: Map<string, boolean>;
  counters: { folded: number; refused: number };
  ownMaxSeqByInstance: ReadonlyMap<string, number>;
  startCursorByInstance: ReadonlyMap<string, number>;
  deadline: number | null;
  maxEvents: number | null;
}): Promise<{ cursorByInstance: Map<string, number>; budgetExhausted: boolean; eventsRead: number }> {
  const instanceIds = [...startCursorByInstance.keys()];
  const cursorByInstance = new Map<string, number>(startCursorByInstance);
  let eventsProcessed = 0;
  // A participant reaches its own high-water and drops out of the
  // rotation permanently — re-checking it every round would waste a
  // round-trip on a guaranteed-empty read once it has already converged.
  const pending = new Set(
    instanceIds.filter((id) => (cursorByInstance.get(id) ?? 0) < (ownMaxSeqByInstance.get(id) ?? 0))
  );
  while (pending.size > 0) {
    if ((deadline !== null && Date.now() >= deadline) || (maxEvents !== null && eventsProcessed >= maxEvents)) {
      return { budgetExhausted: true, cursorByInstance, eventsRead: eventsProcessed };
    }
    let madeProgressThisRotation = false;
    // Recomputed once per ROTATION (not per turn): an even share of the
    // remaining budget across every participant still pending THIS
    // rotation. Without this, a single busy participant's first turn could
    // request up to `STREAM_FACTS_FOLD_ROUND_ROBIN_SLICE` and, if that
    // alone consumes the entire remaining `maxEvents`, starve every OTHER
    // pending participant of a turn before the budget check ever runs
    // again — reproducing the exact fairness bug this drain exists to fix,
    // just at the per-rotation granularity instead of the whole-pass one.
    const remainingBudget = maxEvents === null ? null : maxEvents - eventsProcessed;
    const fairShareThisRotation =
      remainingBudget === null ? null : Math.max(1, Math.floor(remainingBudget / pending.size));
    for (const instanceId of pending) {
      if ((deadline !== null && Date.now() >= deadline) || (maxEvents !== null && eventsProcessed >= maxEvents)) {
        return { budgetExhausted: true, cursorByInstance, eventsRead: eventsProcessed };
      }
      const ownMaxSeq = ownMaxSeqByInstance.get(instanceId) ?? 0;
      const cursor = cursorByInstance.get(instanceId) ?? 0;
      const limit =
        fairShareThisRotation === null
          ? STREAM_FACTS_FOLD_ROUND_ROBIN_SLICE
          : Math.min(STREAM_FACTS_FOLD_ROUND_ROBIN_SLICE, fairShareThisRotation);
      // biome-ignore lint/performance/noAwaitInLoops: Round-robin turns are intentionally sequential so the shared budget check between them is exact.
      const batch = await foldStore.readTerminalFactEvents({
        limit,
        maxSeq: ownMaxSeq,
        scope: [instanceId],
        sinceSeq: cursor,
      });
      for (const row of batch) {
        foldTerminalEventFacts(
          factsByInstance,
          checkpointByInstance,
          generationByInstance,
          generationCurrentByInstance,
          row,
          counters
        );
      }
      eventsProcessed += batch.length;
      if (batch.length > 0) {
        madeProgressThisRotation = true;
        cursorByInstance.set(instanceId, Number((batch.at(-1) as Row).event_seq));
      }
      if (batch.length < limit) {
        // A short/empty batch already proves there is nothing further
        // below `ownMaxSeq` attributable to this instance — the scoped
        // read requested up to `ownMaxSeq` and got back fewer rows than
        // asked for, so every attributable event through `ownMaxSeq` has
        // genuinely been read. Advance the cursor to `ownMaxSeq` itself
        // (not merely to the last event's own `event_seq`, which for a
        // zero-history participant never moves off its start cursor) —
        // this is what lets a zero-or-short-history participant converge
        // to the pass's true high-water at write time, exactly like the
        // pre-round-robin single-cursor drain did for it.
        cursorByInstance.set(instanceId, ownMaxSeq);
        madeProgressThisRotation = true;
        pending.delete(instanceId);
      } else if (cursorByInstance.get(instanceId) === ownMaxSeq) {
        pending.delete(instanceId);
      }
    }
    if (!madeProgressThisRotation && pending.size > 0) {
      // No participant's slice returned any row and none converged this
      // rotation (impossible under correct data, but fail closed rather
      // than spin): treat remaining participants as budget-exhausted so
      // their checkpoints hold at partial progress instead of looping
      // forever.
      return { budgetExhausted: true, cursorByInstance, eventsRead: eventsProcessed };
    }
  }
  return { budgetExhausted: false, cursorByInstance, eventsRead: eventsProcessed };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The complete-fold wrapper owns the instance-scoped budget and aggregate receipt contract.
export async function foldConnectorSummaryStreamFacts(
  connectorInstanceIds: readonly string[] | null = null,
  options: { readonly deadline?: number; readonly maxDurationMs?: number; readonly maxEvents?: number } = {}
): Promise<FoldStreamFactsResult> {
  // Keep the terminal high-water receipt instance-scoped even for a complete
  // maintenance pass. A fleet-wide MAX(event_seq) lets one busy connection
  // make an unrelated connection claim that it folded history it never saw.
  if (connectorInstanceIds === null) {
    const rows = (await createConnectorSummaryStore().listEvidence({})) as Row[];
    const aggregate = {
      casRejectedInstanceIds: [] as string[],
      eventsRead: 0,
      folded: 0,
      incomplete: false,
      minimumCheckpointAfter: null as number | null,
      minimumCheckpointBefore: null as number | null,
      participants: 0,
      refused: 0,
      resumeAfterSeq: null as number | null,
    };
    const deadline = resolveCooperativeDeadline(options);
    let remainingEvents = options.maxEvents;
    for (const row of rows) {
      if (deadline !== null && Date.now() >= deadline) {
        aggregate.incomplete = true;
        break;
      }
      const foldOptions = {
        ...(deadline === null ? {} : { deadline }),
        ...(remainingEvents === undefined ? {} : { maxEvents: remainingEvents }),
      };
      // biome-ignore lint/performance/noAwaitInLoops: Instance-scoped folds are intentionally sequential so one complete pass has a deterministic budget and receipt order.
      const result = await foldConnectorSummaryStreamFacts([String(row.connector_instance_id)], foldOptions);
      aggregate.casRejectedInstanceIds.push(...result.casRejectedInstanceIds);
      aggregate.eventsRead += result.eventsRead;
      aggregate.folded += result.folded;
      aggregate.incomplete ||= result.incomplete;
      aggregate.participants += result.participants;
      aggregate.refused += result.refused;
      if (result.minimumCheckpointBefore !== null) {
        aggregate.minimumCheckpointBefore =
          aggregate.minimumCheckpointBefore === null
            ? result.minimumCheckpointBefore
            : Math.min(aggregate.minimumCheckpointBefore, result.minimumCheckpointBefore);
      }
      if (result.minimumCheckpointAfter !== null) {
        aggregate.minimumCheckpointAfter =
          aggregate.minimumCheckpointAfter === null
            ? result.minimumCheckpointAfter
            : Math.min(aggregate.minimumCheckpointAfter, result.minimumCheckpointAfter);
      }
      if (result.resumeAfterSeq !== null) {
        aggregate.resumeAfterSeq =
          aggregate.resumeAfterSeq === null
            ? result.resumeAfterSeq
            : Math.min(aggregate.resumeAfterSeq, result.resumeAfterSeq);
      }
      if (remainingEvents !== undefined) {
        remainingEvents = Math.max(0, remainingEvents - result.eventsRead);
        if (remainingEvents === 0) {
          aggregate.incomplete = true;
          break;
        }
      }
      if (result.incomplete) {
        aggregate.incomplete = true;
        break;
      }
    }
    return aggregate;
  }
  let result: FoldStreamFactsResult | null = null;
  for (let attempt = 0; attempt < STREAM_FACTS_CAS_REPLAY_ATTEMPTS; attempt += 1) {
    if (result !== null && typeof options.deadline === "number" && Date.now() >= options.deadline) {
      return result;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    result = await foldConnectorSummaryStreamFactsOnce(connectorInstanceIds, options);
    if (result.casRejectedInstanceIds.length === 0) {
      return result;
    }
  }
  return result as FoldStreamFactsResult;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
async function foldConnectorSummaryStreamFactsOnce(
  connectorInstanceIds: readonly string[] | null,
  options: { readonly deadline?: number; readonly maxDurationMs?: number; readonly maxEvents?: number }
): Promise<FoldStreamFactsResult> {
  const store = createConnectorSummaryStore();
  const foldStore = createStreamFactsFoldStore();
  const rows = (await store.listEvidence(connectorInstanceIds === null ? {} : { connectorInstanceIds })) as Row[];
  if (rows.length === 0) {
    return {
      casRejectedInstanceIds: [],
      eventsRead: 0,
      folded: 0,
      incomplete: false,
      minimumCheckpointAfter: null,
      minimumCheckpointBefore: null,
      participants: 0,
      refused: 0,
      resumeAfterSeq: null,
    };
  }
  const maxSeq = await foldStore.readMaxTerminalEventSeq(connectorInstanceIds);
  // Each participant's OWN attributable high-water — never the shared
  // page-wide `maxSeq` — is what fairly gates whether ITS replay converged
  // and whether it must keep re-participating on a follow-up pass. A
  // page-wide `maxSeq`/cursor is still the correct upper bound for the
  // drain's single interleaved batch read (below), but using it alone to
  // judge convergence/participation let one connection with a large backlog
  // consume the whole page's budget and leave every OTHER participant —
  // including ones whose own history the drain had already fully read —
  // durably marked `stale` (or re-selected for participation every
  // subsequent pass despite having nothing left to fold), merely because
  // the shared cursor had not yet reached the page's global max. Queried
  // once per pass, scoped to this page's rows only.
  const maxSeqByInstance =
    maxSeq === null
      ? new Map<string, number>()
      : await foldStore.readMaxTerminalEventSeqByInstance(connectorInstanceIds);
  // A row absent from `maxSeqByInstance` has genuinely ZERO attributable
  // terminal events of its own — its own scoped read below is instant and
  // empty regardless of what high-water it is judged against, so falling
  // back to the shared page-wide `maxSeq` here (the existing contract: a
  // zero-history row's checkpoint tracks the page's high-water, so it
  // never needs re-scanning once the page has been observed) costs it
  // nothing extra and preserves that existing self-heal/converge contract.
  const participants = rows.filter((row) =>
    rowNeedsFoldParticipation(row, maxSeqByInstance.get(String(row.connector_instance_id)) ?? maxSeq)
  );
  if (participants.length === 0) {
    return {
      casRejectedInstanceIds: [],
      eventsRead: 0,
      folded: 0,
      incomplete: false,
      minimumCheckpointAfter: null,
      minimumCheckpointBefore: null,
      participants: 0,
      refused: 0,
      resumeAfterSeq: null,
    };
  }
  const deadline = resolveCooperativeDeadline(options);
  const minimumCheckpointBefore = Math.min(
    ...participants.map((participant) => Number(participant.stream_facts_event_seq ?? 0))
  );
  if (deadline !== null && Date.now() >= deadline) {
    return {
      casRejectedInstanceIds: [],
      eventsRead: 0,
      folded: 0,
      incomplete: true,
      minimumCheckpointAfter: minimumCheckpointBefore,
      minimumCheckpointBefore,
      participants: participants.length,
      refused: 0,
      resumeAfterSeq: minimumCheckpointBefore,
    };
  }
  if (maxSeq === null) {
    const bootstrap = await stampZeroCheckpointForBootstrap(foldStore, participants, deadline);
    return {
      casRejectedInstanceIds: bootstrap.casRejectedInstanceIds,
      eventsRead: 0,
      folded: 0,
      incomplete: bootstrap.incomplete,
      minimumCheckpointAfter: 0,
      minimumCheckpointBefore: null,
      participants: participants.length,
      refused: 0,
      resumeAfterSeq: bootstrap.incomplete ? 0 : null,
    };
  }
  const {
    factsByInstance,
    checkpointByInstance,
    casBaselineByInstance,
    generationByInstance,
    generationCurrentSeedByInstance,
    sinceSeq,
  } = seedFoldState(participants, new Set(maxSeqByInstance.keys()));
  // Test-only: see `testOnlyFoldPauseHook` — a no-op unless a test installs
  // a hook. Held here, immediately after the baseline (checkpointByInstance)
  // is captured and before this pass's own terminal-event read/CAS write —
  // the exact window Sol's verdict named ("deterministic pause hooks around
  // high-water capture and CAS write") for making two REAL, genuinely
  // overlapping `foldConnectorSummaryStreamFacts()` calls deterministically
  // interleave, instead of one pass completing before the next starts.
  await testOnlyFoldPauseHook("after_seed_before_read");
  const counters = { folded: 0, refused: 0 };
  const generationCurrentByInstance = new Map<string, boolean>(generationCurrentSeedByInstance);
  // Each participant's own high-water/start-cursor, never the page-wide
  // `maxSeq`/shared minimum — this is what makes the round-robin drain
  // below fair: a participant whose own history is short (or already
  // caught up) gets its own bounded turn instead of waiting behind another
  // participant's much larger backlog in one shared ascending-`event_seq`
  // scan.
  const ownMaxSeqByInstance = new Map<string, number>();
  const startCursorByInstance = new Map<string, number>();
  for (const row of participants) {
    const instanceId = String(row.connector_instance_id);
    ownMaxSeqByInstance.set(instanceId, maxSeqByInstance.get(instanceId) ?? maxSeq);
    startCursorByInstance.set(instanceId, checkpointByInstance.get(instanceId) ?? 0);
  }
  const drain = await drainTerminalEventBatches({
    checkpointByInstance,
    counters,
    deadline,
    factsByInstance,
    foldStore,
    generationByInstance,
    generationCurrentByInstance,
    maxEvents: typeof options.maxEvents === "number" ? options.maxEvents : null,
    ownMaxSeqByInstance,
    startCursorByInstance,
  });
  const { cursorByInstance, budgetExhausted, eventsRead } = drain;
  // Every participant advances to ITS OWN pass max sequence when the
  // round-robin drain genuinely reached it — all attributable events at or
  // below it have been folded, so later passes read only the delta. When
  // the shared budget was exhausted first, a participant not yet caught up
  // instead advances only to its own `cursorByInstance` entry (the exact
  // event_seq that participant's own slices actually reached) — a genuine
  // partial-progress checkpoint a follow-up call resumes from, never the
  // pass's full high-water (which would falsely claim events this
  // participant's own read never reached were folded).
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
  const casRejectedInstanceIds: string[] = [];
  let writePhaseIncomplete = false;
  let minimumWriteSeq: number | null = null;
  for (const [instanceId, facts] of factsByInstance) {
    // The same absolute cooperative deadline gates EVERY independent
    // participant checkpoint write. A write already entered below may finish
    // after the deadline, but this guard prevents a delayed first write from
    // turning into a page-sized tail of new writes. Unwritten participants
    // retain their prior checkpoint and therefore re-participate safely on
    // the next durable page retry.
    if (deadline !== null && Date.now() >= deadline) {
      writePhaseIncomplete = true;
      break;
    }
    // Every participant is seeded above (`generationCurrentSeedByInstance`)
    // from its OWN incoming `terminal_facts_state`, so this is never an
    // absent-key default — a row that entered the pass already non-current
    // (e.g. a fresh generation-transition boundary with zero qualifying
    // events this round) reads `false` here exactly like a row a real
    // refused event flipped to `false`, rather than silently healing to
    // `true` on pure silence.
    const sourceGenerationCurrent = generationCurrentByInstance.get(instanceId) !== false;
    // Fairness fix (round-robin drain): a participant's OWN replay
    // converged when ITS OWN drain cursor has reached (or passed) THIS
    // instance's own attributable high-water — never a shared page-wide
    // cursor/`maxSeq`. The round-robin drain above gives every participant
    // its own bounded turns against its own `ownMaxSeq`, so a busy
    // connection elsewhere in the same bounded page consuming the shared
    // budget cannot leave an already-caught-up participant's own cursor
    // short of its own high-water. Fail-closed is preserved: `ownMaxSeq`
    // defaults to the page's shared `maxSeq` for the (impossible-in-
    // practice) case a participant has no attributable terminal-event row
    // at all (its own scoped read is instant/empty regardless, so this
    // costs nothing), and a participant whose own history genuinely was
    // not fully drained (`ownCursor < ownMaxSeq`) still correctly reads
    // incomplete.
    const ownMaxSeq = ownMaxSeqByInstance.get(instanceId) ?? maxSeq;
    const ownCursor = cursorByInstance.get(instanceId) ?? 0;
    const ownReplayConverged = ownCursor >= ownMaxSeq;
    const terminalFactsCurrent = ownReplayConverged && sourceGenerationCurrent;
    // A participant's durable checkpoint is always floored at its OWN
    // drain cursor — converged participants write exactly their own
    // `ownMaxSeq` (the round-robin drain proved it read every attributable
    // event up to there), and a not-yet-converged participant writes
    // exactly the event_seq its own slices actually reached, never a
    // shared page-wide value that could falsely claim coverage of events
    // this participant's own read never saw.
    //
    // This checkpoint ALWAYS advances to `participantWriteSeq`, regardless of
    // `sourceGenerationCurrent` — a refused/historical row's own drain still
    // genuinely searched its attributable history up to this point and found
    // nothing, exactly like `terminalFactsForRepair`'s
    // `manifest_generation_changed` write already stamps
    // `terminal_facts_generation_boundary` (the high-water AT the refusal) as
    // that reason code's checkpoint (`connector-summary-evidence-engine.ts`).
    // Freezing the checkpoint at its stale prior value here instead (as this
    // branch previously did) is what made `rowNeedsFoldParticipation`'s
    // zero-checkpoint historical carve-out permanent: with the checkpoint
    // pinned at 0 forever, the row can never re-enter the fold to notice a
    // genuinely NEW post-refusal event, because nothing besides this write
    // path ever advances `stream_facts_event_seq`, and this write path was
    // never reached again. Advancing it here instead makes the checkpoint-lag
    // predicate meaningful: `checkpoint < maxSeq` is false immediately after
    // this write (nothing to do, no re-participation), and becomes true again
    // only once a real new terminal event pushes `maxSeq` past it — the same
    // "silence costs nothing, a genuine new event still converges it"
    // contract the historical carve-out was designed to provide.
    const participantWriteSeq = ownReplayConverged ? ownMaxSeq : ownCursor;
    minimumWriteSeq = minimumWriteSeq === null ? participantWriteSeq : Math.min(minimumWriteSeq, participantWriteSeq);
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    const accepted = await writeParticipantStreamFacts(
      foldStore,
      instanceId,
      facts,
      participantWriteSeq,
      terminalFactsCurrent
        ? null
        : // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
          sourceGenerationCurrent
          ? REASON_CODES.TERMINAL_FOLD_INCOMPLETE
          : REASON_CODES.TERMINAL_FACTS_HISTORICAL,
      terminalFactsCurrent,
      checkpointByInstance,
      casBaselineByInstance
    );
    if (!accepted) {
      casRejectedInstanceIds.push(instanceId);
    }
  }
  const incomplete = budgetExhausted || writePhaseIncomplete;
  // The minimum of every participant's OWN written checkpoint this pass —
  // the round-robin drain's per-instance fairness means participants can
  // legitimately land at DIFFERENT event_seq values in the same pass (one
  // converged to its own high-water, another still mid-backlog), so there
  // is no single shared `writeSeq` any more; this mirrors
  // `minimumCheckpointBefore`'s existing "worst case across participants"
  // contract for the after-pass receipt.
  const writtenMinimum = minimumWriteSeq ?? minimumCheckpointBefore;
  let resumeAfterSeq: number | null = null;
  if (writePhaseIncomplete) {
    resumeAfterSeq = minimumCheckpointBefore;
  } else if (budgetExhausted) {
    resumeAfterSeq = writtenMinimum;
  }
  return {
    casRejectedInstanceIds,
    eventsRead,
    folded: counters.folded,
    incomplete,
    // A write-phase cutoff can leave later participants at their original
    // checkpoint, so the durable minimum remains the pre-pass minimum even
    // when an earlier, already-started write finished successfully.
    minimumCheckpointAfter: writePhaseIncomplete ? minimumCheckpointBefore : writtenMinimum,
    minimumCheckpointBefore: sinceSeq,
    participants: participants.length,
    refused: counters.refused,
    resumeAfterSeq,
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
// biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
async function writeParticipantStreamFacts(
  foldStore: ReturnType<typeof createStreamFactsFoldStore>,
  instanceId: string,
  facts: Record<string, StoredStreamFactEntry>,
  writeSeq: number,
  terminalFactsReasonCode: string | null,
  replayConverged: boolean,
  checkpointByInstance: Map<string, number | null>,
  casBaselineByInstance: Map<string, FoldCasBaseline>
): Promise<boolean> {
  const effectiveCheckpoint = checkpointByInstance.get(instanceId) ?? null;
  const participantEventSeq = effectiveCheckpoint === null ? writeSeq : Math.max(writeSeq, effectiveCheckpoint);
  const casBaseline = casBaselineByInstance.get(instanceId) ?? { eventSeq: null, foldVersion: null };
  return foldStore.updateStreamFacts({
    baselineEventSeq: casBaseline.eventSeq,
    baselineFoldVersion: casBaseline.foldVersion,
    connectorInstanceId: instanceId,
    eventSeq: participantEventSeq,
    factsJson: Object.keys(facts).length > 0 ? JSON.stringify(facts) : null,
    foldVersion: STREAM_FACTS_FOLD_LOGIC_VERSION,
    terminalFactsReasonCode,
    terminalFactsState: replayConverged ? "current" : "stale",
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
 * advances to. `null` (the default) runs a complete pass as a sequence of
 * instance-scoped folds, preserving complete coverage without a fleet-global
 * terminal receipt.
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
  options: { readonly deadline?: number; readonly maxDurationMs?: number; readonly maxEvents?: number } = {}
): Promise<{
  eventsRead: number;
  ok: boolean;
  failedRows: ReadonlyMap<string, Row>;
  incomplete: boolean;
  minimumCheckpointAfter: number | null;
  minimumCheckpointBefore: number | null;
  participants: number;
  resumeAfterSeq: number | null;
}> {
  try {
    const result = await foldConnectorSummaryStreamFacts(connectorInstanceIds, options);
    if (result.casRejectedInstanceIds.length > 0) {
      // Terminal-gate revision (2026-07-29): the facts PAYLOAD
      // (`stream_latest_facts_json`/`stream_facts_event_seq`/
      // `stream_facts_fold_version`) is still left byte-for-byte untouched —
      // the final competing writer may yet own a future fold version. But
      // the metadata (`terminal_facts_state`/`reason_code`) is now ALSO
      // durably marked via `markTerminalFactsContentionForRows`: the
      // in-memory-only overlay this branch used to return exclusively was
      // designed for a "central route loader" that merged it in the SAME
      // barrier pass — a consumer that no longer exists now that GET never
      // calls this barrier inline. Without a durable mark, an independent
      // GET after this pass would read the stale `current` row as
      // trustworthy until the next fold happens to converge it.
      const failedRows = await markTerminalFactsContentionForRows(result.casRejectedInstanceIds);
      return {
        eventsRead: result.eventsRead,
        failedRows,
        incomplete: false,
        minimumCheckpointAfter: result.minimumCheckpointAfter,
        minimumCheckpointBefore: result.minimumCheckpointBefore,
        ok: false,
        participants: result.participants,
        resumeAfterSeq: null,
      };
    }
    return {
      eventsRead: result.eventsRead,
      failedRows: new Map(),
      incomplete: result.incomplete,
      minimumCheckpointAfter: result.minimumCheckpointAfter,
      minimumCheckpointBefore: result.minimumCheckpointBefore,
      ok: true,
      participants: result.participants,
      resumeAfterSeq: result.resumeAfterSeq,
    };
  } catch (err) {
    // A fold failure is specifically a terminal-facts failure: nothing this
    // pass could verify about any row's per-stream latest-attempt facts.
    // Durably degrade terminal_facts_state (not just the generic dirty/state
    // columns) so `evidenceUnreliableSources` sees the specific failure.
    // Scoped to the same set the fold itself was scoped to — an unscoped
    // failure-mark here would degrade every OTHER connection's terminal
    // facts too, which is not what a scoped fold's own failure proves.
    const failedRows = await markTerminalFactsFailedForAllRows(err, connectorInstanceIds);
    return {
      eventsRead: 0,
      failedRows,
      incomplete: false,
      minimumCheckpointAfter: null,
      minimumCheckpointBefore: null,
      ok: false,
      participants: 0,
      resumeAfterSeq: null,
    };
  }
}

type ReconcilePhaseResult = Awaited<ReturnType<typeof reconcileConnectorSummaryEvidence>>;
type FoldOutcome = Awaited<ReturnType<typeof foldStreamFactsBestEffort>>;

function emptyReconcilePhaseResult(): ReconcilePhaseResult {
  return {
    attemptedIds: [],
    candidateReasonCounts: {} as ReconcilePhaseResult["candidateReasonCounts"],
    candidatesInspected: 0,
    discovered: 0,
    failed: 0,
    failedRows: new Map(),
    repaired: 0,
    skipped: 0,
  };
}

function emptyFoldOutcome(): FoldOutcome {
  return {
    eventsRead: 0,
    failedRows: new Map(),
    incomplete: false,
    minimumCheckpointAfter: null,
    minimumCheckpointBefore: null,
    ok: true,
    participants: 0,
    resumeAfterSeq: null,
  };
}

function mergeReconcilePhaseResults(first: ReconcilePhaseResult, second: ReconcilePhaseResult): ReconcilePhaseResult {
  const candidateReasonCounts: Record<string, number> = { ...first.candidateReasonCounts };
  for (const [reason, count] of Object.entries(second.candidateReasonCounts)) {
    candidateReasonCounts[reason] = (candidateReasonCounts[reason] ?? 0) + count;
  }
  return {
    // `missing` and `generic` classify disjoint candidate-reason subsets of
    // the SAME requested scope, so concatenation here never double-attempts
    // an id; the two phases' relative wall-clock order (`genericFirst`) does
    // not need to be reflected in this concatenation order because callers
    // (`runDirtyPriorityAcceleration`) only need the SET of attempted ids,
    // not their cross-phase sequence.
    attemptedIds: [...first.attemptedIds, ...second.attemptedIds],
    candidateReasonCounts: candidateReasonCounts as ReconcilePhaseResult["candidateReasonCounts"],
    candidatesInspected: Math.max(first.candidatesInspected, second.candidatesInspected),
    discovered: Math.max(first.discovered, second.discovered),
    failed: first.failed + second.failed,
    failedRows: new Map([...first.failedRows, ...second.failedRows]),
    repaired: first.repaired + second.repaired,
    skipped: first.skipped + second.skipped,
  };
}

interface BoundedObservationPhases {
  readonly foldOutcome: FoldOutcome;
  readonly incomplete: boolean;
  readonly repairDurationMs: number;
  readonly result: ReconcilePhaseResult;
}

/**
 * Alternates which repair phase — `missing` (rare: no evidence row at all,
 * bounded/capped) or `generic` (the everyday case: dirty/stale/checkpoint-
 * mismatched rows) — gets first opportunity at the deadline REMAINING after
 * the fold (the fold itself always runs first, unconditionally — see its
 * own comment in `runBoundedObservationPhases`). `missing`'s own discovery
 * is a FIXED, batched read over the whole requested scope regardless of how
 * few (or zero) rows it will actually repair — cheap in the common case, but
 * not reserved-against, so under load (contended pool connections, a large
 * scope) it can legitimately consume the rest of the round's cooperative
 * deadline before `generic` ever starts. Observed in production
 * (2026-08-17): 11 connections sat dirty with SUCCEEDED runs and current
 * terminal facts for over an hour, every round reporting
 * `candidatesInspected` from `missing`'s discovery alone and
 * `candidateReasonCounts: {}` / `repaired: 0` / `skipped: 0` — `generic`'s
 * own discovery, the only phase that ever classifies `"dirty"`, never ran.
 * Fixed the same way `connector-maintenance-sweep.ts` closes the identical
 * walk-vs-acceleration starvation: alternating first opportunity gives
 * `generic` a hard 2-round bound on how long it can be denied its turn,
 * rather than a reordering that would just relocate the same unbounded risk
 * onto `missing`.
 */
let nextFirstObservationPhase: "missing" | "generic" = "missing";

/** Test-only: pin the alternation state so a test does not depend on prior calls' ordering. */
export function __testOnlySetNextFirstObservationPhase(phase: "missing" | "generic"): void {
  nextFirstObservationPhase = phase;
}

/**
 * Run bounded phases under one cooperative deadline. The helper owns the
 * time-versus-work policy: a fold batch or writer-fenced repair may finish
 * after entry, but no later unit starts once the absolute deadline expires.
 */
async function runBoundedObservationPhases(
  connectorInstanceIds: readonly string[] | null,
  deadline: number,
  options: { readonly maxCandidates?: number; readonly maxEvents?: number }
): Promise<BoundedObservationPhases> {
  let repairDurationMs = 0;
  let maintenanceIncomplete = false;
  let foldOutcome = emptyFoldOutcome();
  const canStartWork = () => Date.now() < deadline;
  const startFold = (): Promise<FoldOutcome | null> => {
    if (!canStartWork()) {
      maintenanceIncomplete = true;
      return Promise.resolve(null);
    }
    return foldStreamFactsBestEffort(connectorInstanceIds, {
      deadline,
      maxEvents: options.maxEvents ?? BOUNDED_FOLD_MAX_EVENTS,
    });
  };
  const startRepair = async (
    candidateReasons: readonly RepairCandidateReason[],
    maxCandidates: number | undefined
  ): Promise<ReconcilePhaseResult> => {
    if (!canStartWork()) {
      maintenanceIncomplete = true;
      return emptyReconcilePhaseResult();
    }
    const startedAt = Date.now();
    const result = await reconcileConnectorSummaryEvidence(connectorInstanceIds, {
      candidateReasons,
      deadline,
      ...(maxCandidates === undefined ? {} : { maxCandidates }),
    });
    repairDurationMs += Date.now() - startedAt;
    return result;
  };

  // The fold always runs FIRST, unconditionally — existing participants'
  // terminal-fact progress must never be held hostage by either repair
  // phase's latency (a separately load-bearing, separately tested
  // invariant: "SQLite: a 25-row first page folds before slow generic
  // repairs..." in connector-summary-evidence-bounded-sweep.test.ts).
  // Alternation below applies ONLY to `missing` vs `generic`'s relative
  // order, after the fold has already had its turn.
  const firstFold = await startFold();
  if (firstFold !== null) {
    foldOutcome = firstFold;
  }

  const runMissing = () => startRepair(["missing"], BOUNDED_MISSING_REPAIR_CANDIDATES);
  const runGeneric = () => startRepair(GENERIC_REPAIR_CANDIDATE_REASONS, options.maxCandidates);
  const runColdFoldIfWarranted = async (missingResult: ReconcilePhaseResult) => {
    if (foldOutcome.participants === 0 && missingResult.repaired > 0) {
      const coldFold = await startFold();
      if (coldFold !== null) {
        foldOutcome = coldFold;
      }
    }
  };

  // Committed before either repair phase runs, and flipped for the NEXT
  // call regardless of this call's outcome — same contract as
  // `connector-maintenance-sweep.ts`'s `nextFirstTranche`: `generic` can be
  // denied first opportunity for at most one consecutive call.
  const genericFirst = nextFirstObservationPhase === "generic";
  nextFirstObservationPhase = genericFirst ? "missing" : "generic";

  let missing: ReconcilePhaseResult;
  let generic: ReconcilePhaseResult;
  if (genericFirst) {
    generic = await runGeneric();
    missing = await runMissing();
    await runColdFoldIfWarranted(missing);
  } else {
    missing = await runMissing();
    await runColdFoldIfWarranted(missing);
    generic = await runGeneric();
  }
  const result = mergeReconcilePhaseResults(missing, generic);
  // A repair that started before the deadline may finish after it. The
  // cooperative contract makes that unit finish cleanly; it is incomplete
  // only when the deadline actually deferred remaining candidates, not merely
  // because the completed final unit crossed the clock boundary.
  maintenanceIncomplete ||= result.skipped > 0 || foldOutcome.incomplete;
  return { foldOutcome, incomplete: maintenanceIncomplete, repairDurationMs, result };
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * The one internal observation barrier (design.md "Central consumer and
 * cache boundary"): discover+repair every row the complete canonical
 * `connector_instances` set classifies as needing it (missing, dirty, stale,
 * checkpoint-mismatched, manifest-mismatched, and retained-bytes-changed —
 * see `reconcileConnectorSummaryEvidence` in
 * `connector-summary-evidence-engine.ts`), then fold terminal-event deltas
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
 * For an unbounded call, repair runs before the fold and retains the
 * one-pass cold-start behavior above. A bounded maintenance page carries one
 * cooperative absolute deadline through every phase. Existing participants
 * get the first finite fold batch; a cold page may start one capped missing
 * repair phase, then resumes from its existing durable evidence/checkpoint on
 * a later round. No repair or fold batch starts after the deadline, although
 * one already-started SQL unit can finish cooperatively. Omitting both
 * bounds preserves complete, unbounded behavior for existing callers.
 *
 * Returns `{ reconciled, incomplete, resumeAfterSeq }`: `reconciled` is the
 * count of candidates repaired plus rows dropped by orphan cleanup.
 * `incomplete`/`resumeAfterSeq` surface a bounded fold's cooperative deadline
 * or finite-event outcome — `true`/non-null only when it stopped before every
 * participant reached the pass's high-water mark.
 *
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 */
async function observeConnectorSummaryEvidence(
  connectorInstanceIds: readonly string[] | null = null,
  options: {
    readonly deadline?: number;
    readonly maxCandidates?: number;
    readonly maxDurationMs?: number;
    readonly maxEvents?: number;
  } = {}
): Promise<{
  /**
   * Every id the repair phases actually invoked `repairCandidate` for this
   * call, regardless of success/failure/deferred outcome — see
   * `ReconcileResult.attemptedIds`. Empty when discovery itself failed
   * (nothing about ANY row could be verified, so nothing was attempted) or
   * when every requested id was fetched but the deadline expired before any
   * repair started.
   */
  attemptedIds: readonly string[];
  candidateReasonCounts: Readonly<Record<string, number>>;
  candidatesInspected: number;
  failed: number;
  failureClasses: readonly string[];
  reconciled: number;
  skipped: number;
  failedRows: ReadonlyMap<string, Row>;
  incomplete: boolean;
  repairDurationMs: number;
  resumeAfterSeq: number | null;
  terminalFoldEventsRead: number;
  terminalFoldMinimumCheckpointAfter: number | null;
  terminalFoldMinimumCheckpointBefore: number | null;
  terminalFoldParticipants: number;
  terminalFoldZeroProgress: boolean;
}> {
  const overallDeadline = resolveCooperativeDeadline(options);
  let result: ReconcilePhaseResult;
  let foldOutcome = emptyFoldOutcome();
  let repairDurationMs = 0;
  let maintenanceIncomplete = false;
  try {
    if (overallDeadline === null) {
      const repairStartedAt = Date.now();
      result = await reconcileConnectorSummaryEvidence(connectorInstanceIds, options);
      repairDurationMs = Date.now() - repairStartedAt;
      foldOutcome = await foldStreamFactsBestEffort(connectorInstanceIds, {
        ...(typeof options.maxEvents === "number" ? { maxEvents: options.maxEvents } : {}),
      });
    } else {
      ({
        foldOutcome,
        incomplete: maintenanceIncomplete,
        repairDurationMs,
        result,
      } = await runBoundedObservationPhases(connectorInstanceIds, overallDeadline, options));
    }
  } catch (err) {
    // A `PostgresStatementTimeoutError` reaching here (production,
    // 2026-08-18) means discovery's OWN batched read was cancelled by the
    // per-unit `statement_timeout` bound (design review P1-2) — the bound
    // firing as designed under load, not a broken canonical-authority
    // table. Treating it the same as a genuine discovery failure below
    // (durably degrading `record_snapshot`/`manifest_declaration` to
    // `failed` for EVERY row in scope) is exactly the regression this
    // fixes: 25 of 29 rows flipped from `current` to `failed` within
    // minutes, with nothing logged anywhere to explain why. A cancelled
    // statement says nothing about whether those rows' canonical facts
    // actually changed, so the correct response is to leave existing
    // evidence completely untouched and let the next observation pass
    // (this call retries from scratch every time) discover it again —
    // `incomplete: true` honestly reports that this round made no
    // discovery progress, without lying about the DATA being bad.
    if (err instanceof PostgresStatementTimeoutError) {
      console.error(
        `[connector-summary-evidence] discovery cancelled by Postgres statement_timeout (per-unit bound, design review P1-2)${
          connectorInstanceIds ? ` for ${connectorInstanceIds.length} scoped id(s)` : " (complete census)"
        } — existing evidence left untouched, not marked failed; retrying next pass: ${sanitizeProjectionError(err)}`
      );
      return {
        attemptedIds: [],
        candidateReasonCounts: {},
        candidatesInspected: 0,
        failed: 0,
        failedRows: new Map(),
        failureClasses: ["discovery_statement_timeout"],
        incomplete: true,
        reconciled: 0,
        repairDurationMs,
        resumeAfterSeq: null,
        skipped: 0,
        terminalFoldEventsRead: 0,
        terminalFoldMinimumCheckpointAfter: null,
        terminalFoldMinimumCheckpointBefore: null,
        terminalFoldParticipants: 0,
        terminalFoldZeroProgress: false,
      };
    }
    // Discovery itself failed for a reason OTHER than a mere per-unit
    // cancellation (e.g. a canonical-authority table is genuinely
    // unreadable) — broader than any one row's repair failure: NOTHING
    // about ANY row's canonical facts could be verified this pass, so
    // record_snapshot and manifest_declaration (the components discovery
    // itself is responsible for classifying) must not keep reading
    // `current`. Durably degrade both, in addition to the generic
    // dirty/stale marking. The next call's discovery retries from scratch.
    console.error(
      `[connector-summary-evidence] discovery failed${
        connectorInstanceIds ? ` for ${connectorInstanceIds.length} scoped id(s)` : " (complete census)"
      }, degrading affected rows to failed: ${sanitizeProjectionError(err)}`
    );
    const failedRows = await markAllConnectorSummaryEvidenceDiscoveryFailed(err, connectorInstanceIds);
    return {
      attemptedIds: [],
      candidateReasonCounts: {},
      candidatesInspected: 0,
      failed: failedRows.size,
      failedRows,
      failureClasses: ["discovery"],
      incomplete: false,
      reconciled: 0,
      repairDurationMs,
      resumeAfterSeq: null,
      skipped: 0,
      terminalFoldEventsRead: 0,
      terminalFoldMinimumCheckpointAfter: null,
      terminalFoldMinimumCheckpointBefore: null,
      terminalFoldParticipants: 0,
      terminalFoldZeroProgress: false,
    };
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
  const failedRows =
    foldOutcome.failedRows.size === 0 ? result.failedRows : new Map([...result.failedRows, ...foldOutcome.failedRows]);
  return {
    attemptedIds: result.attemptedIds,
    candidateReasonCounts: result.candidateReasonCounts,
    candidatesInspected: result.candidatesInspected,
    failed: result.failed + foldOutcome.failedRows.size,
    failedRows,
    failureClasses: foldOutcome.ok ? [] : ["terminal_facts"],
    incomplete: maintenanceIncomplete || foldOutcome.incomplete,
    reconciled: result.repaired,
    repairDurationMs,
    resumeAfterSeq: foldOutcome.resumeAfterSeq,
    skipped: result.skipped,
    terminalFoldEventsRead: foldOutcome.eventsRead,
    terminalFoldMinimumCheckpointAfter: foldOutcome.minimumCheckpointAfter,
    terminalFoldMinimumCheckpointBefore: foldOutcome.minimumCheckpointBefore,
    terminalFoldParticipants: foldOutcome.participants,
    terminalFoldZeroProgress:
      foldOutcome.incomplete &&
      foldOutcome.participants > 0 &&
      foldOutcome.minimumCheckpointBefore === foldOutcome.minimumCheckpointAfter,
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
  await invalidateAllConnectorListSummaryTerminalProjections("canonical_evidence_rebuilt");
  return listConnectorSummaryEvidence();
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * The maintenance barrier that repairs summary evidence before its bounded
 * sweep passes — over the
 * COMPLETE canonical `connector_instances` set, not filtered to `dirty = 1`
 * rows. Filtering to only-dirty was the exact defect design.md fixes: a
 * MISSING row (no evidence row at all) has no `dirty` flag to filter on, so
 * a dirty-only pass could never discover it. Batched discovery classifies
 * every row against canonical authorities regardless of its own dirty
 * claim; only classified candidates take the writer fence and get
 * repaired, so an idle system with no changes still does a fixed number of
 * reads and zero repairs — this is not "always touch every row."
 *
 * Delegates to the same observation barrier `rebuildConnectorSummaryEvidence`
 * uses, so an unbounded call from a cold (missing-row) start fully converges:
 * creates the row, then folds its terminal history — never leaving a
 * caller needing a second call to reach `current`.
 *
 * `connectorInstanceIds`, when provided, narrows the reconcile/discovery/
 * repair phase to exactly that connection set — a scoped consumer (a route
 * that already resolved the one `connectorInstanceId` it needs) must not
 * pay for a complete census of every other connection the owner has.
 * Defaults to `null` (complete census), the exact existing behavior, so
 * maintenance callers that do not pass a scope retain fleet-wide semantics;
 * interactive reads do not call this function.
 *
 * `options.maxCandidates`/`options.maxDurationMs`, when provided, bound the
 * repair loop and the fold this call runs — by candidate count and/or an
 * admission deadline checked BETWEEN phase units, never a preemptive
 * wall-clock cap on any single unit's own execution (design review P1-2
 * naming correction, 2026-08-18 — see `runBoundedSummaryEvidenceSweep`'s
 * doc for the full two-contract framing) (design.md "Startup is
 * acceleration, not authority"; Sol P2.2 closed the gap where a small
 * candidate count did not bound total elapsed time when individual repairs
 * are slow; Sol fourth-verdict P1.2 closed the further gap where the fold
 * itself, within one connection, was unconditionally unbounded regardless
 * of this option) — used ONLY by the startup one-shot acceleration pass,
 * never by an interactive read. `options.maxEvents`, when provided,
 * additionally bounds the
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
  const startedAt = Date.now();
  try {
    const outcome = await observeConnectorSummaryEvidence(connectorInstanceIds, options);
    emitConnectorSummaryReconcileObservation({
      candidateReasonCounts: outcome.candidateReasonCounts,
      candidatesInspected: outcome.candidatesInspected,
      durationMs: Date.now() - startedAt,
      failed: outcome.failed,
      failureClasses: outcome.failureClasses,
      incomplete: outcome.incomplete,
      repairDurationMs: outcome.repairDurationMs,
      repaired: outcome.reconciled,
      resumePending: outcome.resumeAfterSeq !== null,
      scopeKind: connectorInstanceIds === null ? "complete" : "scoped",
      scopeSize: connectorInstanceIds === null ? outcome.candidatesInspected : connectorInstanceIds.length,
      skipped: outcome.skipped,
      terminalFoldEventsRead: outcome.terminalFoldEventsRead,
      terminalFoldMinimumCheckpointAfter: outcome.terminalFoldMinimumCheckpointAfter,
      terminalFoldMinimumCheckpointBefore: outcome.terminalFoldMinimumCheckpointBefore,
      terminalFoldParticipants: outcome.terminalFoldParticipants,
      terminalFoldZeroProgress: outcome.terminalFoldZeroProgress,
    });
    return outcome;
  } catch (err) {
    emitConnectorSummaryReconcileObservation({
      candidateReasonCounts: {},
      candidatesInspected: 0,
      durationMs: Date.now() - startedAt,
      failed: 0,
      failureClasses: ["discovery"],
      incomplete: false,
      repairDurationMs: 0,
      repaired: 0,
      resumePending: false,
      scopeKind: connectorInstanceIds === null ? "complete" : "scoped",
      scopeSize: connectorInstanceIds?.length ?? 0,
      skipped: 0,
      terminalFoldEventsRead: 0,
      terminalFoldMinimumCheckpointAfter: null,
      terminalFoldMinimumCheckpointBefore: null,
      terminalFoldParticipants: 0,
      terminalFoldZeroProgress: false,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Resumable bounded sweep — a genuine deadline spanning discovery + fold +
// repair across the COMPLETE set, not just a repair-loop count/time cap
// (Sol P2.2: "maxDurationMs checked only inside the repair loop does NOT
// close Sol's finding... a full discovery can already exceed the budget
// before the loop begins, and an unscoped fold can exceed it afterward").
// ---------------------------------------------------------------------------

/**
 * One bounded page of prioritized maintenance work. Fresh canonical writes
 * (`dirty <> 0`) always go first. Once that queue is empty, a bounded terminal
 * replay that previously exhausted its event budget resumes immediately
 * instead of waiting for the fleet cursor to wrap. Best-effort by
 * construction: the cursor walk remains the correctness backstop.
 */
async function readPendingMaintenanceInstanceIdPage(
  limit: number,
  includeIncomplete: boolean
): Promise<readonly string[]> {
  try {
    return await createConnectorSummaryStore().listPendingMaintenanceInstanceIds({ includeIncomplete, limit });
  } catch {
    return [];
  }
}

/**
 * One bounded page of connections whose evidence is durably marked dirty,
 * for the sweep's dirty-priority tranche. Best-effort by construction: the
 * cursor walk is the correctness backstop, so a read failure here degrades
 * to "no acceleration this round" (the walk still converges) rather than failing
 * the whole maintenance tick.
 *
 * `afterId` rotates this page's starting point across rounds (see
 * `nextDirtyAfterId`'s doc) — without it, `ORDER BY connector_instance_id ASC
 * LIMIT` always returns the SAME prefix of the dirty set every round. A
 * dirty backlog bigger than one page's budget can genuinely repair (never
 * merely `deferred`/`skipped`) individual candidates without the round-wide
 * `dirty` count ever visibly dropping, and every one of THOSE repairs still
 * lands durably; what a fixed, non-rotating prefix prevents is any candidate
 * PAST whatever the page's budget can reach ever getting a turn, forever
 * (production, 2026-08-18: 16 dirty connections, same 16 reselected every
 * round, `repaired: 0` sustained for a 110s+ window under contention from an
 * unrelated background job).
 */
async function readDirtyInstanceIdPage(afterId: string | null, limit: number): Promise<readonly string[]> {
  try {
    return await createConnectorSummaryStore().listDirtyInstanceIds({ afterId, limit });
  } catch {
    return [];
  }
}

/**
 * Cheap fleet-wide `COUNT(*) WHERE dirty <> 0`, read ONCE per bounded-sweep
 * call, before either tranche runs (design reviewer P2-4: "no-progress
 * telemetry"). This is the eligible-backlog half of the round's progress
 * signal (see `runBoundedSummaryEvidenceSweep`'s progress-definition doc for
 * the full reasoning and why `repaired > 0` alone is the wrong signal).
 * Best-effort exactly like `readDirtyInstanceIdPage`: a count-read failure
 * must never fail the sweep itself, only make this one round's progress
 * telemetry report `0` (indistinguishable from "genuinely no backlog" to a
 * caller that only sees the count) — the same fail-open posture design.md
 * requires of every telemetry read in this file.
 */
async function readEligibleBacklogCount(): Promise<number> {
  try {
    return await createConnectorSummaryStore().countDirty();
  } catch {
    return 0;
  }
}

function isExpectedProjectionRace(error: unknown): boolean {
  return error instanceof Error && error.name === TERMINAL_PROJECTION_PUBLICATION_RACE;
}

/**
 * The keyset cursor walk over the canonical `connector_instances` set — the
 * sweep's correctness backstop, which eventually covers EVERY connection
 * regardless of any dirty marker. Each page runs the same scoped
 * discovery+fold+repair+prune barrier (`observeConnectorSummaryEvidence`) a
 * scoped read-time consumer would, so the unit is bounded by `pageSize`, not
 * by N. The deadline is checked BETWEEN pages so a page already starting
 * always gets its full remaining-budget allotment.
 */
async function runCursorWalk(args: {
  readonly cursor: string | null;
  readonly deadline: number;
  readonly foldEventCap: { maxEvents?: number };
  readonly maxPages: number;
  readonly maintenanceLease?: ConnectorMaintenanceCursorLease;
  readonly onPageConverged?: (
    connectorInstanceIds: readonly string[],
    maintenanceLease?: ConnectorMaintenanceCursorLease
  ) => Promise<void>;
  readonly pageSize: number;
}): Promise<{
  readonly anyFoldIncomplete: boolean;
  readonly coveredCompleteSet: boolean;
  readonly cursor: string | null;
  readonly discovered: number;
  readonly failed: number;
  readonly repaired: number;
  readonly skipped: number;
}> {
  const { cursor: initialCursor, deadline, maxPages, pageSize } = args;
  let cursor = initialCursor;
  let discovered = 0;
  let repaired = 0;
  let skipped = 0;
  let failed = 0;
  let pages = 0;
  let coveredCompleteSet = false;
  let anyFoldIncomplete = false;

  for (;;) {
    // Strictly deadline-gated, including the first page: `maxDurationMs` is
    // a genuine PASS ADMISSION deadline (design review P1-2 — not a
    // wall-clock bound on this loop's total running time; see
    // `runBoundedSummaryEvidenceSweep`'s doc for the exact two-contract
    // framing), so no page — the most expensive unit here (discovery + fold
    // + repair over `pageSize` connections) — may BEGIN after expiry. A page
    // already admitted still runs to completion uninterrupted. The walk's
    // guarantee that clean rows still converge comes from running BEFORE
    // any acceleration under the round's one deadline (see
    // `runBoundedSummaryEvidenceSweep`), never from starting late.
    if (pages >= maxPages || sweepNow() >= deadline) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    const pageIds = await readInstanceIdPage(cursor, pageSize);
    testOnlySweepDiscoveryHook("walk_page_ids");
    if (pageIds.length === 0) {
      coveredCompleteSet = true;
      break;
    }
    // The discovery read above is itself awaited work and can consume what
    // remained of the budget. Re-check BEFORE the expensive unit: a page whose
    // observe would begin after expiry must not begin at all, and must not
    // count as a processed page. The cursor is deliberately left where it was,
    // so the next round revisits exactly these connections rather than
    // skipping past a page nothing ever repaired.
    if (sweepNow() >= deadline) {
      break;
    }
    pages += 1;
    // The cursor position BEFORE this page — the resume point when this
    // page's OWN fold is incomplete, so a follow-up call revisits exactly
    // these connections rather than advancing past them.
    const cursorBeforeCurrentPage = cursor;
    const pageStartedAt = Date.now();
    const pageResult = await observeConnectorSummaryEvidence(pageIds, {
      deadline,
      ...args.foldEventCap,
    });
    discovered += pageIds.length;
    repaired += pageResult.reconciled;
    skipped += pageResult.skipped;
    failed += pageResult.failed;
    emitScopedObservationUnit(pageResult, pageIds.length, pageStartedAt);
    if (pageResult.incomplete) {
      // Evidence folding and terminal projection publication are separate
      // convergence axes. A page may have more terminal history to fold, yet
      // already contain clean rows whose captured terminal facts are ready to
      // publish. Give the bounded publisher that page before resuming the
      // fold; otherwise one fold-heavy connection can indefinitely suppress
      // publication for every unrelated stale-clean row on the page.
      try {
        await args.onPageConverged?.(pageIds, args.maintenanceLease);
      } catch (error) {
        if (!isExpectedProjectionRace(error)) {
          throw error;
        }
      }
      // This page's fold did not fully converge within its budget — the
      // sweep as a whole is incomplete regardless of how many pages
      // followed, and the resume point is BEFORE this page (not past it).
      anyFoldIncomplete = true;
      cursor = cursorBeforeCurrentPage;
      break;
    }
    try {
      await args.onPageConverged?.(pageIds, args.maintenanceLease);
    } catch (error) {
      if (!isExpectedProjectionRace(error)) {
        throw error;
      }
      // The publisher's revision/lease CAS correctly rejected this page.
      // Preserve the page as the durable resume point; the next bounded round
      // will re-observe and republish it. Unexpected publication failures
      // still escape and remain visible to the worker.
      anyFoldIncomplete = true;
      cursor = cursorBeforeCurrentPage;
      break;
    }
    cursor = pageIds.at(-1) ?? cursor;
    if (pageIds.length < pageSize) {
      // Short page: this was genuinely the last page of the complete set.
      coveredCompleteSet = true;
      break;
    }
  }

  return { anyFoldIncomplete, coveredCompleteSet, cursor, discovered, failed, repaired, skipped };
}

/**
 * Complete-set orphan pruning, run only when a sweep genuinely covered every
 * page AND every fold converged.
 *
 * The sweep's own pages already scoped-pruned every id they discovered was
 * gone. What per-page scoped pruning CANNOT catch: an evidence row whose
 * `connector_instance_id` was NEVER discovered by any page at all —
 * impossible if every page's ids came from the same live instance table,
 * EXCEPT for evidence rows that are pure orphans (their `connector_instances`
 * row is gone, so no page ever produced their id). A genuinely complete run
 * is safe to complete-prune exactly like `reconcileConnectorSummaryEvidence(null)`
 * does, using the same complete live-instance read and prune primitive.
 */
async function pruneCompleteSetOrphans(): Promise<number> {
  return await pruneOrphanedEvidenceComplete();
}

/**
 * Emits the reconcile observation for one scoped observation unit — a
 * dirty-priority tranche or a cursor-walk page. Both run the identical barrier
 * (`observeConnectorSummaryEvidence`) over a bounded id set, so both report
 * the same shape; the sole difference is which ids the unit covered.
 */
function emitScopedObservationUnit(
  result: Awaited<ReturnType<typeof observeConnectorSummaryEvidence>>,
  scopeSize: number,
  startedAt: number
): void {
  emitConnectorSummaryReconcileObservation({
    candidateReasonCounts: result.candidateReasonCounts,
    candidatesInspected: result.candidatesInspected,
    durationMs: Date.now() - startedAt,
    failed: result.failed,
    failureClasses: result.failureClasses,
    incomplete: result.incomplete,
    repairDurationMs: result.repairDurationMs,
    repaired: result.reconciled,
    resumePending: result.resumeAfterSeq !== null,
    scopeKind: "scoped",
    scopeSize,
    skipped: result.skipped,
    terminalFoldEventsRead: result.terminalFoldEventsRead,
    terminalFoldMinimumCheckpointAfter: result.terminalFoldMinimumCheckpointAfter,
    terminalFoldMinimumCheckpointBefore: result.terminalFoldMinimumCheckpointBefore,
    terminalFoldParticipants: result.terminalFoldParticipants,
    terminalFoldZeroProgress: result.terminalFoldZeroProgress,
  });
}

/**
 * Services ONE bounded page of prioritized maintenance work through the SAME
 * scoped discovery+fold+repair+prune barrier (`observeConnectorSummaryEvidence`)
 * the walk's own pages use. Freshly dirty rows are never mixed with an older
 * incomplete replay: the latter may consume the fold budget before a newer
 * row's terminal event is reached. Incomplete replay is selected only when
 * the dirty queue is empty.
 *
 * Runs AFTER the cursor walk, from whatever budget the walk left, under the
 * round's one absolute deadline. That ordering is what makes the walk's turn
 * structural: this tranche can never consume the round before the correctness
 * backstop has had its chance. It is pure acceleration — it shortens the wait
 * for a freshly-dirtied row from "whenever the cursor wraps" to "this round"
 * whenever the round has time left, and is skipped entirely when it does not.
 * Bounded by construction: at most `limit` connections.
 *
 * It deliberately does NOT de-duplicate against the page the walk just
 * processed. An earlier revision read the walk's next page to skip overlapping
 * ids, which made sense only while this tranche ran FIRST. With the walk
 * running first that read is both obsolete and counterproductive: rows the
 * walk genuinely repaired are no longer dirty, so they cannot be selected
 * here anyway, while a row re-dirtied DURING the walk is precisely the row
 * worth accelerating — and the skip would have suppressed it. Dropping the
 * read removes one query and one post-await gate per round.
 *
 * The one awaited discovery read here is itself work that can consume what is
 * left, so `deadline` is re-checked after it and immediately before the
 * observe — a started unit may finish, but none may BEGIN late.
 */
/**
 * Rotating start-of-page cursor for the dirty-priority tranche, in-process
 * closure state (reset on restart — worst case one extra round before
 * rotation resumes, same bounded-harmless contract as `nextFirstTranche`/
 * `nextFirstObservationPhase`; a durable per-item cursor was considered and
 * rejected for THIS patch — see the "durable fairness" note on
 * `lastAttemptedDirtyId` below for exactly what that restart cost means and
 * why it was judged acceptable rather than silently left unstated).
 *
 * Advanced to the last id THIS round's page genuinely ATTEMPTED — repair was
 * actually invoked for it, whether it then succeeded, failed, or was
 * deferred — never merely the last id the page's discovery FETCHED
 * (`lastAttemptedDirtyId` below computes this). Fetched-but-never-attempted
 * ids stay eligible for the very next round's page instead of being skipped
 * over.
 *
 * This distinction is load-bearing, not cosmetic (production, 2026-08-18):
 * with a backlog SMALLER than one page (e.g. 8 dirty ids against a 25-id
 * page limit), advancing to the last FETCHED id committed the cursor to id
 * #8 every round regardless of how many candidates the deadline actually let
 * `repairCandidates` reach. Because the "repair at least one" floor
 * (`connector-summary-evidence-bounded-reconciliation.ts`'s
 * `repairCandidates`) only guarantees candidate #1 a turn under an
 * already-expired deadline, every round re-fetched the SAME 8 ids, attempted
 * only #1 again, and reported alternating `repaired: 1` / `repaired: 0`
 * while ids 2-8 were never attempted and the backlog never drained. The same
 * class of gap exists for a backlog LARGER than one page: a permanently
 * expired deadline advancing on "fetched" cycles through ids 1, 26, 51,
 * 76, ... forever, since each page's fetch always reaches its full width
 * even when the deadline lets almost none of it be attempted. Advancing on
 * "attempted" instead means a page that only manages to attempt its first
 * candidate rotates the cursor just past THAT candidate, so the next round's
 * page starts at candidate #2 rather than re-fetching the identical prefix.
 *
 * Advancing to the last ATTEMPTED id preserves the original "never wedge on
 * a permanently-failing page" property this cursor exists for: an attempt
 * that fails, throws, or is deferred still counts as attempted (see
 * `repairCandidates`'s `attemptedIds`), so a candidate that will never
 * succeed still gets rotated past exactly like a candidate that succeeds —
 * only a candidate NEVER GIVEN A TURN this round stays at the front of the
 * next page.
 *
 * `null` when there is nothing to resume from (either the tranche has never
 * run, or the dirty set was empty last round) — the next round's page then
 * starts from the beginning, same as before this fix for a fleet with no
 * rotation pressure.
 */
let nextDirtyAfterId: string | null = null;

/** Test-only: pin the rotation state so a test does not depend on prior calls' ordering. */
export function __testOnlySetNextDirtyAfterId(afterId: string | null): void {
  nextDirtyAfterId = afterId;
}

/**
 * The last id in `pageIds` order that `attemptedIds` actually contains, or
 * `null` if none of them were attempted. `pageIds` order (not
 * `attemptedIds` order) is authoritative here: `attemptedIds` can
 * concatenate multiple repair phases that ran over disjoint candidate-reason
 * subsets of the SAME page (see `mergeReconcilePhaseResults`), so it is not
 * itself in the page's keyset order — but the fairness rotation cursor must
 * advance monotonically along the SAME `connector_instance_id ASC` order
 * `readDirtyInstanceIdPage` paginates by, or the next page's `afterId >`
 * filter could skip an id that was fetched but never attempted.
 */
function lastAttemptedDirtyId(pageIds: readonly string[], attemptedIds: readonly string[]): string | null {
  if (attemptedIds.length === 0) {
    return null;
  }
  const attempted = new Set(attemptedIds);
  let last: string | null = null;
  for (const id of pageIds) {
    if (attempted.has(id)) {
      last = id;
    }
  }
  return last;
}

async function runDirtyPriorityAcceleration(args: {
  readonly deadline: number;
  readonly includeIncomplete: boolean;
  readonly limit: number;
  readonly foldEventCap: { maxEvents?: number };
  readonly maintenanceLease?: ConnectorMaintenanceCursorLease;
  readonly onPageConverged?: (
    connectorInstanceIds: readonly string[],
    maintenanceLease?: ConnectorMaintenanceCursorLease
  ) => Promise<void>;
}): Promise<{
  readonly discovered: number;
  readonly failed: number;
  readonly incomplete: boolean;
  readonly repaired: number;
  readonly skipped: number;
}> {
  const empty = { discovered: 0, failed: 0, incomplete: false, repaired: 0, skipped: 0 };
  if (sweepNow() >= args.deadline) {
    return empty;
  }
  // Dirty rows first, through the ROTATING cursor: a fixed `ORDER BY
  // connector_instance_id ASC LIMIT` prefix re-selects the same connections
  // every round, so a backlog larger than one page's budget starves every
  // candidate past that prefix forever (production, 2026-08-18). Once the
  // dirty set is genuinely empty, fall through to the prioritized-maintenance
  // page so a bounded terminal replay that exhausted its event budget still
  // resumes immediately instead of waiting for the fleet cursor to wrap.
  const rotatingDirtyIds = await readDirtyInstanceIdPage(nextDirtyAfterId, args.limit);
  const pendingIds =
    rotatingDirtyIds.length > 0
      ? rotatingDirtyIds
      : await readPendingMaintenanceInstanceIdPage(args.limit, args.includeIncomplete);
  testOnlySweepDiscoveryHook("acceleration_dirty_ids");
  if (pendingIds.length === 0) {
    nextDirtyAfterId = null;
    return empty;
  }
  // The discovery read above is itself work that can consume the budget, so
  // the deadline is re-checked here — immediately before the expensive unit
  // and never assumed to still hold from the entry check. Bailing HERE, before
  // `observe` ever runs, means literally nothing in this page was attempted —
  // there is no "last attempted id" to advance to, so the cursor still
  // advances to the last FETCHED id, exactly as before this fix. That is the
  // one case where fetched-order rotation is still correct: the alternative
  // (leaving the cursor unmoved) would re-fetch and re-decide-not-to-attempt
  // the identical page forever under a permanently tight budget, which is the
  // same "wedge on one page" failure mode this cursor exists to prevent.
  // Nothing durable is lost either way — the dirty markers stay set, so a
  // fetched-but-unattempted id is retried by a LATER round regardless of
  // which fallback fires.
  if (sweepNow() >= args.deadline) {
    nextDirtyAfterId = rotatingDirtyIds.length > 0 ? (rotatingDirtyIds.at(-1) ?? null) : null;
    return empty;
  }
  const startedAt = Date.now();
  const result = await observeConnectorSummaryEvidence(pendingIds, {
    deadline: args.deadline,
    ...args.foldEventCap,
  });
  // Advance to the last id THIS call actually gave a repair turn to — success,
  // failure, or deferred all count (see `repairCandidates`'s `attemptedIds`
  // and this cursor's own doc above for the production starvation this
  // closes). Only when NOTHING was attempted (discovery itself failed inside
  // `observeConnectorSummaryEvidence`, or every fetched id turned out not to
  // be a classified candidate at all — e.g. already clean) does this fall
  // back to the last FETCHED id, preserving the pre-existing "a page that
  // cannot make progress still rotates, never wedges" guarantee.
  //
  // Only the DIRTY tranche rotates. When this page came from #146's
  // incomplete-replay fallback instead, the dirty set was empty, so the cursor
  // resets to the start rather than holding a stale high-water id that would
  // skip past the next dirty row to appear.
  nextDirtyAfterId =
    rotatingDirtyIds.length > 0
      ? (lastAttemptedDirtyId(rotatingDirtyIds, result.attemptedIds) ?? rotatingDirtyIds.at(-1) ?? null)
      : null;
  emitScopedObservationUnit(result, pendingIds.length, startedAt);
  try {
    await args.onPageConverged?.(pendingIds, args.maintenanceLease);
  } catch (error) {
    if (!isExpectedProjectionRace(error)) {
      throw error;
    }
    return {
      discovered: pendingIds.length,
      failed: result.failed,
      incomplete: true,
      repaired: result.reconciled,
      skipped: result.skipped,
    };
  }
  return {
    discovered: pendingIds.length,
    failed: result.failed,
    incomplete: result.incomplete,
    repaired: result.reconciled,
    skipped: result.skipped,
  };
}

/**
 * Test-only deterministic seam fired immediately AFTER each awaited discovery
 * read inside the sweep's two tranches, and a complete no-op in production
 * (`__sweepDiscoveryHook` is never assigned outside a test).
 *
 * Exists so a test can prove the "no work unit BEGINS after expiry" contract
 * without sleeps or wall-clock races: the hook advances an injected clock past
 * the deadline at exactly the point a real slow discovery read would have
 * consumed the budget, and the test then asserts that no observe/fold ran.
 * `__testOnlySetSweepDiscoveryHook` is the only intended installer.
 */
let __sweepDiscoveryHook: ((point: "acceleration_dirty_ids" | "walk_page_ids") => void) | null = null;

export function __testOnlySetSweepDiscoveryHook(
  hook: ((point: "acceleration_dirty_ids" | "walk_page_ids") => void) | null
): void {
  __sweepDiscoveryHook = hook;
}

function testOnlySweepDiscoveryHook(point: "acceleration_dirty_ids" | "walk_page_ids"): void {
  __sweepDiscoveryHook?.(point);
}

/**
 * The sweep's clock, injectable for tests. Production always reads the real
 * one; a test can substitute a controllable clock so deadline behavior is
 * deterministic rather than a wall-clock race.
 * `__testOnlySetSweepClock` is the only intended installer.
 */
let __sweepClock: (() => number) | null = null;

export function __testOnlySetSweepClock(clock: (() => number) | null): void {
  __sweepClock = clock;
}

function sweepNow(): number {
  return __sweepClock ? __sweepClock() : Date.now();
}

export interface BoundedSweepResult {
  /** Total instances discovered+repaired+considered across every page processed this call. */
  readonly discovered: number;
  /**
   * The durably-dirty backlog (`COUNT(*) WHERE dirty <> 0`), read ONCE,
   * before either tranche runs this round (design reviewer finding P2-4).
   * This is the "eligible backlog" half of round-level progress — see
   * `createResumableConnectorMaintenanceSweep`'s no-progress-counter doc in
   * connector-maintenance-sweep.ts for the full progress definition, why
   * `repaired > 0` is the wrong signal, and the real production incident
   * (dirty backlog pinned at 8 rows for many minutes while passes alternated
   * `repaired: 1` / `repaired: 0`) this metric exists to catch. A cheap,
   * indexed read (same shape/cost as `readDirtyInstanceIdPage`'s own query,
   * minus the row payload) — never itself a source of round-budget pressure.
   */
  readonly eligibleBacklog: number;
  /** Round-level count of candidates/units this call's tranches reported as failed (discovery failure or a per-candidate repair failure — includes a `PostgresStatementTimeoutError` unit abort). Distinct from `skipped` (deferred, never attempted) and `incomplete` (deadline/fold budget exhausted). */
  readonly failed: number;
  /**
   * `true` when the sweep reached the deadline (or the page-count cap)
   * before covering the complete canonical set, OR when a page's OWN fold
   * exhausted its per-page budget before every participant in that page
   * converged (Sol fourth-verdict P1.2: "gate prunedComplete on both a
   * complete canonical connection census and complete folds") — the caller
   * should NOT treat this as a correctness gate (design.md "Startup is
   * acceleration, not authority"). NOTE (2026-08-10): this used to read
   * "the unbounded read-time barrier always covers whatever this sweep
   * missed" — that barrier was removed from ordinary GET by the 2026-07-29
   * terminal-gate revision, so the periodic sweep IS the only repair path
   * now. What covers a missed page is the NEXT tick (resuming from
   * `resumeAfterId`), plus the dirty-priority tranche for work that arrived
   * since. `resumeAfterId`, when set, is the
   * exact cursor position to resume from on a follow-up call — for a
   * fold-incomplete page this is the id BEFORE that page (not past it), so
   * a follow-up call revisits the SAME still-incomplete page's connections
   * rather than skipping past them.
   */
  readonly incomplete: boolean;
  /** Complete-set orphan pruning only ran when the sweep covered every page AND every page's fold genuinely converged this call (see below). */
  readonly prunedComplete: boolean;
  readonly repaired: number;
  readonly resumeAfterId: string | null;
  readonly skipped: number;
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
 * NAMING (design review P1-2, 2026-08-18): despite its name,
 * `options.maxDurationMs` is NOT a wall-clock duration bound on this
 * function's total running time, a maximum database-occupancy limit, a
 * maximum I/O limit, or even a strict admission deadline in the sense of
 * "no work happens after this instant" — a caller must not read it as
 * "this call returns within maxDurationMs." It creates one cooperative PASS
 * ADMISSION DEADLINE, checked only BETWEEN units (never inside one), so no
 * NEW repair/fold/discovery unit begins once it has passed, but a unit
 * already admitted always runs to completion uninterrupted — see the
 * fourth-verdict incident quoted above (a 1ms budget, one connection, still
 * folded all 2,001 events) and the live 2026-08-18 incident
 * (`repair_duration_ms: 5322` against a 2000ms pass budget, `incomplete:
 * true`, 5 candidates skipped — the overrun was not resource contention
 * alone, the bound genuinely was not enforced mid-unit).
 *
 * Two SEPARATE contracts now exist, matching the reviewer's required
 * correction:
 *   1. PASS SOFT DEADLINE (this option): no additional ordinary
 *      discovery/repair/fold unit is admitted once it has passed. Every
 *      unit boundary in this file and connector-summary-evidence-engine.ts
 *      already honored this.
 *   2. PER-UNIT HARD BOUND (new, design review P1-2): each admitted
 *      Postgres discovery/repair read query now carries its own
 *      transaction-local `SET LOCAL statement_timeout`, derived from the
 *      caller's remaining pass allowance
 *      (`postgresDiscoveryQuery`/`postgresRepairReadQuery` in
 *      connector-summary-evidence-engine.ts; `postgresQueryBounded` in
 *      postgres-storage.ts) — so a single slow query can no longer, on its
 *      own, silently consume the whole pass deadline the way the
 *      2026-08-18 incident's canonical-count aggregate did. The fold's own
 *      `maxEvents` row cap is a second, pre-existing per-unit hard bound
 *      (finite regardless of clock time). SQLite has NO per-unit hard
 *      bound — `better-sqlite3` is synchronous and exposes no
 *      interrupt/progress-handler hook on its public API, so a slow SQLite
 *      discovery/repair query cannot be cancelled once started. This is a
 *      disclosed, unclosed gap on SQLite: every hot-path SQLite query here
 *      is index-bounded (keyset `LIMIT`, or an indexed `MAX`/`GROUP BY`
 *      aggregate — see the P1-2 file:line audit), so it is expected to be
 *      fast in practice, but nothing in this codebase can force-cancel one
 *      that isn't.
 *
 * Each bounded fold has a finite event cap (the caller's `maxEventsPerFold`
 * or the local default), and a cold page has a one-page missing-evidence
 * cap. `options.maxPages` additionally caps the number of pages processed;
 * `options.pageSize` controls how many connections each page covers.
 *
 * `options.firstTranche` (2026-08-12) alternates which tranche gets the
 * round's genuine first opportunity — the FULL, undivided `maxDurationMs`
 * budget, before the other tranche runs at all. See the ordering comment
 * inside this function for why a fixed walk-always-first order left a
 * genuine, unbounded starvation hole, and why a soft time-slice (reserving
 * part of the walk's deadline for acceleration) cannot structurally close
 * it. Defaults to `"walk"`, reproducing the exact prior behavior for a
 * caller that does not opt in; callers that want the closed invariant must
 * alternate this value across calls (`connector-maintenance-sweep.ts` does).
 */
export async function runBoundedSummaryEvidenceSweep(options: {
  readonly maxDurationMs: number;
  readonly maintenanceLease?: ConnectorMaintenanceCursorLease;
  readonly maxPages?: number;
  readonly onPageConverged?: (
    connectorInstanceIds: readonly string[],
    maintenanceLease?: ConnectorMaintenanceCursorLease
  ) => Promise<void>;
  readonly pageSize?: number;
  readonly afterId?: string | null;
  readonly maxEventsPerFold?: number;
  readonly firstTranche?: "walk" | "acceleration";
}): Promise<BoundedSweepResult> {
  const deadline = sweepNow() + options.maxDurationMs;
  const pageSize = options.pageSize ?? 25;
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;

  // Read ONCE, before either tranche runs (design reviewer finding P2-4's
  // progress-definition requirement — see `eligibleBacklog`'s own doc on
  // `BoundedSweepResult`). Best-effort: a failed count read must never fail
  // or delay the sweep itself, so this is never awaited under the round's
  // deadline gate the way a page read is.
  const eligibleBacklog = await readEligibleBacklogCount();

  let discovered = 0;
  let repaired = 0;
  let skipped = 0;
  let failed = 0;

  // Maintenance-priority acceleration (2026-08-10, extended 2026-08-13).
  // The cursor walk is the
  // correctness backstop — it eventually covers every connection — but it is
  // ordered by `connector_instance_id`, NOT by when work arrived, so a
  // connection invalidated a moment ago waits for the cursor to wrap the whole
  // fleet: `ceil(N/pageSize)` ticks, entirely independent of when its run
  // completed. That is the live UAT defect: write invalidation set `dirty = 1`
  // correctly and nothing ever CONSUMED it (`dirty` is read only by
  // `classifyCandidate`, to classify an id the walk already selected — never
  // to select one), so a completed run's facts stayed unreadable on the
  // owner's normal list/detail read.
  //
  // One bounded bite of prioritized work is serviced each round, through the SAME
  // scoped discovery+fold+repair+prune barrier the walk's own pages use — no
  // new engine, no polling, no read-path write. It is a LATENCY hint on the
  // same contract as every other dirty marker here, never a correctness gate.
  // Once dirty work clears, `terminal_fold_incomplete` rows stay in this
  // acceleration path until their durable replay checkpoint reaches current;
  // without that continuation, the first bounded pass cleared `dirty` and
  // silently demoted the remaining replay to the fleet walk.
  // Threaded identically into both tranches; resolved once so the two call
  // sites cannot drift.
  const foldEventCap: { maxEvents?: number } =
    typeof options.maxEventsPerFold === "number" ? { maxEvents: options.maxEventsPerFold } : {};

  // ORDER: alternating first opportunity, both tranches under the ONE
  // absolute `deadline`.
  //
  // With cooperative, non-preemptible units, a "reserve" computed as a
  // shorter sub-deadline for one tranche does NOT structurally guarantee the
  // other tranche any time: an individual observe/fold/repair unit only
  // checks its deadline BETWEEN internal steps (never mid-step — that is the
  // whole cooperative-budget contract elsewhere in this file), so a single
  // slow unit inside the "capped" tranche can already overshoot past its own
  // shortened sub-deadline before the next check ever fires, consuming into
  // — or past — the time meant to be reserved for the other tranche. A
  // shorter deadline is therefore a probabilistic time-slice, not a
  // guarantee, and encoding a fixed number of reserved milliseconds as a
  // correctness property would be exactly the kind of unproven margin this
  // codebase's cooperative-deadline design otherwise refuses to rely on
  // (2026-08-12 correction — an earlier revision of this comment claimed a
  // `minAccelerationReserveMs` sub-deadline closed this gap; it did not).
  //
  // What DOES structurally bound worst-case starvation is alternating which
  // tranche receives first opportunity — the round's FULL, undivided
  // `maxDurationMs`, before the other tranche is even attempted:
  //
  //   - FIRST OPPORTUNITY, every round, for WHICHEVER tranche goes first.
  //     The first tranche is offered the round's complete budget before the
  //     second tranche can touch it — the same structural guarantee the
  //     walk-always-first design gave the walk, now available to either
  //     tranche on alternating rounds.
  //   - HARD 2-ROUND STARVATION BOUND. If round N's first tranche overshoots
  //     and consumes the entire round (leaving the second tranche zero
  //     time — the exact failure mode a fixed walk-first order could not
  //     avoid), round N+1 gives the OTHER tranche first opportunity instead.
  //     A tranche can therefore be denied first opportunity for at most one
  //     consecutive round, regardless of how badly any single unit inside
  //     the other tranche overshoots. This is the caller's structural
  //     contract to uphold (see `firstTranche`'s doc above) — this function
  //     only honors whichever value it is given each call; the CALLER must
  //     alternate the value across rounds for the bound to hold across
  //     rounds, which `connector-maintenance-sweep.ts` does.
  //   - DURABLE RESUME. A round that makes no progress on the walk leaves
  //     its cursor exactly where it was, so nothing is skipped and the next
  //     tick that walks retries the same page.
  //   - EVENTUAL CONVERGENCE under repeated normally-budgeted ticks, given
  //     folds that are finite and progressing.
  //
  // Neither tranche is starved of CORRECTNESS by losing a round's first
  // opportunity: a walk round with no progress leaves its cursor unmoved
  // (never lost), and an acceleration round with no turn leaves the dirty
  // marker set (never lost) — both converge via the walk regardless, exactly
  // as before. What alternation closes is the LATENCY bound: without it, a
  // sufficiently fold-heavy page could make acceleration's "eventually" mean
  // "not within this page's entire multi-round convergence window," which is
  // unbounded in the general case and is exactly the live UAT defect.
  const walkFirst = (options.firstTranche ?? "walk") === "walk";

  async function runWalkTranche() {
    // Whichever tranche runs SECOND uses `sweepNow()` — whatever the round's
    // clock reads after the first tranche's own await — as ITS effective
    // starting point, but both tranches are still handed the SAME absolute
    // `deadline`: the second tranche gets "whatever remains," the first
    // tranche gets the round's complete, undivided allotment.
    const walk = await runCursorWalk({
      cursor: options.afterId ?? null,
      deadline,
      foldEventCap,
      maxPages,
      ...(options.maintenanceLease ? { maintenanceLease: options.maintenanceLease } : {}),
      ...(options.onPageConverged ? { onPageConverged: options.onPageConverged } : {}),
      pageSize,
    });
    discovered += walk.discovered;
    repaired += walk.repaired;
    skipped += walk.skipped;
    failed += walk.failed;
    return walk;
  }

  async function runAccelerationTranche() {
    const acceleration =
      sweepNow() < deadline
        ? await runDirtyPriorityAcceleration({
            deadline,
            foldEventCap,
            // Only the scheduler opts into alternating tranches. A direct
            // sweep keeps its historical one-fold event cap; otherwise the
            // walk and acceleration tranches can drain the same incomplete
            // row twice in one call.
            includeIncomplete: options.firstTranche !== undefined,
            limit: pageSize,
            ...(options.maintenanceLease ? { maintenanceLease: options.maintenanceLease } : {}),
            ...(options.onPageConverged ? { onPageConverged: options.onPageConverged } : {}),
          })
        : { discovered: 0, failed: 0, incomplete: false, repaired: 0, skipped: 0 };
    discovered += acceleration.discovered;
    repaired += acceleration.repaired;
    skipped += acceleration.skipped;
    failed += acceleration.failed;
    return acceleration;
  }

  let walk: Awaited<ReturnType<typeof runWalkTranche>>;
  let acceleration: Awaited<ReturnType<typeof runAccelerationTranche>>;
  if (walkFirst) {
    walk = await runWalkTranche();
    acceleration = await runAccelerationTranche();
  } else {
    acceleration = await runAccelerationTranche();
    walk = await runWalkTranche();
  }

  const { coveredCompleteSet, cursor } = walk;
  // A tranche whose own fold did not converge within budget makes the sweep as
  // a whole incomplete, exactly like an incomplete walk page — it must not
  // license complete-set pruning, which requires every fold to have genuinely
  // converged.
  const anyFoldIncomplete = acceleration.incomplete || walk.anyFoldIncomplete;

  const prunedComplete = coveredCompleteSet && !anyFoldIncomplete;
  if (prunedComplete) {
    repaired += await pruneCompleteSetOrphans();
  }

  const incomplete = !coveredCompleteSet || anyFoldIncomplete;
  return {
    discovered,
    eligibleBacklog,
    failed,
    incomplete,
    prunedComplete,
    repaired,
    resumeAfterId: incomplete ? cursor : null,
    skipped,
  };
}
