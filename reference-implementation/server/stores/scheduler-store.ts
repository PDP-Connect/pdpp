// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// SchedulerStore — production storage interface for the connector
// schedule registry and the controller-managed active-run registry.
//
// The surface is deliberately *semantic*: it speaks in lifecycle terms
// (`createSchedule`, `setScheduleEnabled`, `upsertActiveRun`,
// `listActiveRuns`) and returns domain records, not SQLite rows. Callers
// see `enabled: boolean`, never the underlying `0 | 1` integer column,
// and never see registered query keys, prepared statements, or `getDb()`.
//
// Behavior preserved verbatim from the controller helpers being replaced:
//   - One schedule row per connector instance with semantic fields
//     (interval_seconds, jitter_seconds, enabled, created_at, updated_at).
//   - `enabled` round-trips as a boolean across the public surface; the
//     SQLite-flavored 0/1 conversion lives inside this module.
//   - Active-run records are one per connector instance with `run_id` unique
//     across the registry; `upsertActiveRun` fails closed on
//     connector-instance collisions and preserves the incumbent row rather
//     than replacing it.
//
// Spine reconciliation, in-memory `activeRuns` projections, and the
// `wasRunAdjudicatedAbandoned` accessor stay in the controller. The store
// is the persistence seam only.

import {
  allowUnboundedReadAcknowledged,
  exec,
  getMany,
  getOne,
  iterateDynamicSqlAcknowledged,
  referenceQueries,
  writeTransaction,
} from "../../lib/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../owner-auth.ts";
import {
  getStorageBackendKind,
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresTransaction,
} from "../postgres-storage.ts";
import { makeDefaultAccountConnectorInstanceId } from "./connector-instance-store.ts";

// ─── Domain records (public, semantic) ──────────────────────────────────────

export interface ScheduleRecord {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly created_at: string;
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

export interface ScheduleCreate {
  readonly connector_id: string;
  readonly connector_instance_id?: string;
  readonly created_at: string;
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

export interface ScheduleUpdate {
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

export interface ActiveRunRecord {
  readonly connector_id: string;
  readonly connector_instance_id?: string;
  readonly run_generation: number;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

/**
 * Durable source-webhook dispatch result. This is intentionally separate
 * from `controller_active_runs`: active rows are deleted when a run reaches a
 * terminal state, but a webhook retry must still recover the original handle.
 */
export interface SourceWebhookRunReceipt {
  readonly action: "schedule_run";
  readonly automation_mode: string | null;
  readonly automation_summary: string | null;
  readonly body_hash: string;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly event_id: string;
  readonly owner_subject_id: string;
  readonly run_id: string;
  readonly source_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

export interface SourceWebhookRunAdmissionInput {
  readonly active_run: ActiveRunRecord;
  readonly source_event: {
    readonly action: "schedule_run";
    readonly automation_mode: string | null;
    readonly automation_summary: string | null;
    readonly body_hash: string;
    readonly event_id: string;
    readonly owner_subject_id: string;
    readonly received_at: string;
    readonly source_id: string;
  };
}

export type SourceWebhookRunAdmission =
  | { readonly kind: "admitted" }
  | { readonly kind: "active_run_exists" }
  | { readonly kind: "generic_claim_exists" }
  | { readonly kind: "replay"; readonly receipt: SourceWebhookRunReceipt }
  | { readonly kind: "conflict"; readonly receipt: SourceWebhookRunReceipt };

export interface SchedulerRunHistoryRecord {
  readonly attempt: number;
  readonly checkpointSummary: Record<string, unknown> | null;
  readonly completedAt: string;
  readonly connectorError?: Record<string, unknown> | null;
  readonly connectorId: string;
  readonly connectorInstanceId?: string | null;
  readonly error?: string;
  /**
   * `run_history.facts_json` — SpineSummary-relevant fields not promoted to
   * indexed scalars (`known_gaps`, `collection_facts`, `recovery_only`,
   * browser-surface fields). Present only on rows the generalized run-grain
   * writer or backfill stage wrote; `null` for scheduler-only rows predating
   * that column's use and for rows read via readers that never selected it.
   */
  readonly factsJson?: Record<string, unknown> | null;
  readonly failureReason?: string | null;
  readonly knownGaps: readonly Record<string, unknown>[];
  readonly recordsEmitted: number;
  readonly reportedRecordsEmitted?: number | null;
  readonly runId?: string | null;
  readonly source: Record<string, unknown>;
  readonly startedAt: string;
  /**
   * Includes `"abandoned"` — the status restart reconciliation writes for a run
   * whose owning process died before terminalizing it (derived in
   * `run-history-writer.ts`, inserted by `lib/controller-boot.ts`). These rows
   * were always readable through this interface (28 in production); the union
   * simply did not admit the value it was already carrying.
   */
  readonly status: "abandoned" | "cancelled" | "failed" | "skipped" | "succeeded";
  readonly terminalReason?: string | null;
  readonly traceId?: string | null;
}

/**
 * Product-reader shape (`listLatestRunHistoryForProductByConnectionIds`):
 * the same record, but `status` additionally admits `"running"` — the
 * pre-terminal placeholder the generalized run-grain writer creates at
 * `run.started`, which scheduler-scoped readers filter out
 * (`status <> 'running'`) but product LIST readers need to compose the
 * live active-run/lease overlay (R9.2).
 */
export interface ProductRunHistoryRecord extends Omit<SchedulerRunHistoryRecord, "status"> {
  readonly status: SchedulerRunHistoryRecord["status"] | "running";
}

export interface SchedulerLastRunTimeRecord {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly last_run_time_ms: number;
  readonly updated_at: string;
}

// ─── Public store surface ───────────────────────────────────────────────────

// biome-ignore assist/source/useSortedInterfaceMembers: The interface is grouped by lifecycle concern, not alphabetically.
export interface SchedulerStore {
  // Scheduler run history + interval gate timestamps.
  appendRunHistory: (record: SchedulerRunHistoryRecord) => Promise<void> | void;

  // Schedule registry — semantic lifecycle verbs.
  createSchedule: (record: ScheduleCreate) => Promise<void> | void;

  // Active-run registry — semantic lifecycle verbs.
  /**
   * Atomically creates the durable source-event receipt and its active-run
   * admission. A replay returns the original receipt; a different identity
   * under the same source/event key is a conflict.
   */
  admitSourceWebhookRun?: (
    input: SourceWebhookRunAdmissionInput
  ) => Promise<SourceWebhookRunAdmission> | SourceWebhookRunAdmission;
  deleteActiveRun: (connectorInstanceId: string, runId: string) => Promise<void> | void;
  deleteSchedule: (connectorInstanceId: string) => Promise<void> | void;
  getActiveRun: (connectorInstanceId: string) => Promise<ActiveRunRecord | null> | ActiveRunRecord | null;
  getSourceWebhookRunReceipt?: (
    sourceId: string,
    eventId: string
  ) => Promise<SourceWebhookRunReceipt | null> | SourceWebhookRunReceipt | null;
  getLatestRunHistoryForConnection: (
    connectorInstanceId: string,
    status?: string | null
  ) => Promise<SchedulerRunHistoryRecord | null> | SchedulerRunHistoryRecord | null;
  /**
   * Product-reader (LIST/detail) single-connection fallback for callers
   * that did not pre-load the page batch — the newest run-history row of
   * EVERY kind (no `scheduler_managed` scope). Mirrors
   * `getLatestRunHistoryForConnection`'s role for
   * `listLatestRunHistoryForProductByConnectionIds`. R9.2.
   */
  getLatestRunHistoryForProductByConnectionId?: (
    connectorInstanceId: string,
    status?: string | null
  ) => Promise<ProductRunHistoryRecord | null> | ProductRunHistoryRecord | null;
  /**
   * Product-reader single-connection read of the newest TERMINAL/settled
   * run-history row — `status <> 'running'` at the SQL layer, mirroring
   * `getLatestRunHistoryForConnection`'s exclusion but WITHOUT the
   * `scheduler_managed` scope (every run kind, like the other product
   * readers). This is the health/failure classification authority
   * (`healthClassifyingRun`, ref-control.ts): distinct from
   * `getLatestRunHistoryForProductByConnectionId`, whose result may be a
   * live in-progress row that has not settled yet and therefore cannot
   * represent "the latest known failure/success". A `running` row with no
   * live lease (an orphan) is excluded here at the DB level even though
   * the JS-level `productRunHistoryToConnectorRunSummary` will eventually
   * map it to `failed` once read through the unfiltered reader — until a
   * maintenance sweep (or the next terminal write) resolves it, this falls
   * back to the last row that actually settled, which is a sound (if
   * temporarily stale) answer, never a fabricated one.
   */
  getLatestSettledRunHistoryForProductByConnectionId?: (
    connectorInstanceId: string
  ) => Promise<ProductRunHistoryRecord | null> | ProductRunHistoryRecord | null;
  /** Exact product run-history lookup fenced by the addressed connection. */
  getProductRunHistoryForConnectionRunId?: (
    connectorInstanceId: string,
    runId: string
  ) => Promise<ProductRunHistoryRecord | null> | ProductRunHistoryRecord | null;
  getSchedule: (connectorInstanceId: string) => Promise<ScheduleRecord | null> | ScheduleRecord | null;
  hasLegacySchedulerEventMarker?: (
    connectorId: string,
    connectorInstanceId: string,
    prefix: string,
    reasonClass: string,
    sinceCompletedAt: string | null
  ) => Promise<boolean> | boolean;
  listActiveRuns: () => Promise<readonly ActiveRunRecord[]> | readonly ActiveRunRecord[];
  listLastRunTimes: () => Promise<readonly SchedulerLastRunTimeRecord[]> | readonly SchedulerLastRunTimeRecord[];
  listLastRunTimesByConnectionIds?: (
    connectorInstanceIds: readonly string[]
  ) => Promise<readonly SchedulerLastRunTimeRecord[]> | readonly SchedulerLastRunTimeRecord[];
  listLatestRunHistoryByConnectionIds?: (
    connectorInstanceIds: readonly string[],
    status?: string | null
  ) => Promise<readonly SchedulerRunHistoryRecord[]> | readonly SchedulerRunHistoryRecord[];
  /**
   * Product-reader (LIST/detail) batch: the newest run-history row per
   * connection, EVERY run kind — no `scheduler_managed` scope, unlike
   * `listLatestRunHistoryByConnectionIds` (which stays scheduler-only per
   * §7/R7.5). Includes `running` rows (status not filtered to terminal)
   * so the caller can compose the live active-run/lease overlay; includes
   * `facts_json` so no per-run spine read is needed to build a full
   * `ConnectorRunSummary`. terminal-read-architecture-fable-0730.md §9/R9.2.
   */
  listLatestRunHistoryForProductByConnectionIds?: (
    connectorInstanceIds: readonly string[],
    status?: string | null
  ) => Promise<readonly ProductRunHistoryRecord[]> | readonly ProductRunHistoryRecord[];
  /**
   * Batch counterpart of {@link getLatestSettledRunHistoryForProductByConnectionId}:
   * the newest TERMINAL/settled (`status <> 'running'`) row per connection,
   * every run kind, no `scheduler_managed` scope. Used by
   * `loadConnectorSummaryProjectionDeps` (ref-control.ts) as the health/
   * failure classification authority for the whole page render.
   */
  listLatestSettledRunHistoryForProductByConnectionIds?: (
    connectorInstanceIds: readonly string[]
  ) => Promise<readonly ProductRunHistoryRecord[]> | readonly ProductRunHistoryRecord[];
  listRunHistory: (
    limit: number
  ) => Promise<readonly SchedulerRunHistoryRecord[]> | readonly SchedulerRunHistoryRecord[];
  listSchedules: () => Promise<readonly ScheduleRecord[]> | readonly ScheduleRecord[];
  listSchedulesByConnectionIds?: (
    connectorInstanceIds: readonly string[]
  ) => Promise<readonly ScheduleRecord[]> | readonly ScheduleRecord[];
  setScheduleEnabled: (connectorInstanceId: string, enabled: boolean, updatedAt: string) => Promise<void> | void;
  updateSchedule: (connectorInstanceId: string, patch: ScheduleUpdate) => Promise<void> | void;
  upsertActiveRun: (record: ActiveRunRecord) => Promise<boolean> | boolean;
  upsertLastRunTime: (
    connectorInstanceId: string,
    lastRunTimeMs: number,
    updatedAt: string,
    connectorId?: string
  ) => Promise<void> | void;
}

// SQLite's variable limit is configurable. Keep the page batch well below its
// historical 999 floor so a future query can add a small fixed bind set without
// coupling correctness to a deployment-specific compile option.
const SQLITE_CONNECTION_ID_BATCH_SIZE = 900;
// The summary page contract caps identity pages at 100. Keep PostgreSQL arrays
// at that accepted bound even if a future caller supplies a larger set.
const POSTGRES_CONNECTION_ID_BATCH_SIZE = 100;

function uniqueConnectionIds(connectorInstanceIds: readonly string[]): readonly string[] {
  return [...new Set(connectorInstanceIds)];
}

function connectionIdChunks(connectorInstanceIds: readonly string[]): readonly (readonly string[])[] {
  return connectionIdChunksOfSize(connectorInstanceIds, SQLITE_CONNECTION_ID_BATCH_SIZE);
}

function connectionIdChunksOfSize(
  connectorInstanceIds: readonly string[],
  chunkSize: number
): readonly (readonly string[])[] {
  const ids = uniqueConnectionIds(connectorInstanceIds);
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize));
  }
  return chunks;
}

function sqliteMembershipPlaceholders(ids: readonly string[]): string {
  return ids.map(() => "?").join(", ");
}

const SCHEDULER_RUN_HISTORY_COLUMNS = `
  id,
  connector_instance_id,
  connector_id,
  source_json,
  status,
  records_emitted,
  reported_records_emitted,
  checkpoint_summary_json,
  known_gaps_json,
  connector_error_json,
  run_id,
  trace_id,
  failure_reason,
  terminal_reason,
  started_at,
  completed_at,
  error,
  attempt`;

// Product-reader column set (run-history LIST cutover,
// terminal-read-architecture-fable-0730.md §9 / R9.2): adds `facts_json` so
// `toConnectorRunSummary`-equivalent product readers never need a
// per-run `readRunTerminalEventData` spine read on GET (G1).
const PRODUCT_RUN_HISTORY_COLUMNS = `${SCHEDULER_RUN_HISTORY_COLUMNS},
  facts_json`;

// ─── SQLite implementation ──────────────────────────────────────────────────

interface ScheduleSqliteRow {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly created_at: string;
  readonly enabled: 0 | 1 | boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

interface SchedulerRunHistoryRow extends Record<string, unknown> {
  readonly attempt: number;
  readonly checkpoint_summary_json: unknown;
  readonly completed_at: string;
  readonly connector_error_json: unknown;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly error: string | null;
  readonly facts_json?: unknown;
  readonly failure_reason: string | null;
  readonly known_gaps_json: unknown;
  readonly records_emitted: number;
  readonly reported_records_emitted: number | null;
  readonly run_id: string | null;
  readonly source_json: unknown;
  readonly started_at: string;
  readonly status: "cancelled" | "failed" | "running" | "skipped" | "succeeded";
  readonly terminal_reason: string | null;
  readonly trace_id: string | null;
}

function rowToScheduleRecord(row: ScheduleSqliteRow): ScheduleRecord {
  return {
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id,
    created_at: row.created_at,
    enabled: row.enabled === true || row.enabled === 1,
    interval_seconds: row.interval_seconds,
    jitter_seconds: row.jitter_seconds,
    updated_at: row.updated_at,
  };
}

function parseJsonValue(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function asObjectOrNull(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asObjectArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)
  );
}

// Returns the wider product shape (status admits "running"); scheduler-
// scoped call sites narrow via `rowToRunHistoryRecord` below, relying on
// their own SQL `status <> 'running'` filter to make that narrowing sound.
function rowToProductRunHistoryRecord(row: SchedulerRunHistoryRow): ProductRunHistoryRecord {
  const record: ProductRunHistoryRecord = {
    attempt: row.attempt,
    checkpointSummary: asObjectOrNull(parseJsonValue(row.checkpoint_summary_json, null)),
    completedAt: row.completed_at,
    connectorError: asObjectOrNull(parseJsonValue(row.connector_error_json, null)),
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    factsJson: row.facts_json === undefined ? null : asObjectOrNull(parseJsonValue(row.facts_json, null)),
    failureReason: row.failure_reason,
    knownGaps: asObjectArray(parseJsonValue(row.known_gaps_json, [])),
    recordsEmitted: row.records_emitted,
    reportedRecordsEmitted: row.reported_records_emitted,
    runId: row.run_id,
    source: asObjectOrNull(parseJsonValue(row.source_json, {})) ?? {},
    startedAt: row.started_at,
    status: row.status,
    terminalReason: row.terminal_reason,
    traceId: row.trace_id,
  };
  return row.error === null ? record : { ...record, error: row.error };
}

// Scheduler-scoped readers only ever see this row shape after their own
// SQL filters `status <> 'running'` — the cast is sound given that
// invariant, not a re-validation of it.
function rowToRunHistoryRecord(row: SchedulerRunHistoryRow): SchedulerRunHistoryRecord {
  return rowToProductRunHistoryRecord(row) as SchedulerRunHistoryRecord;
}

function serializeJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function requireRunHistoryConnectorInstanceId(record: SchedulerRunHistoryRecord): string {
  if (typeof record.connectorInstanceId !== "string" || record.connectorInstanceId.trim().length === 0) {
    throw new Error(
      "SchedulerStore.appendRunHistory: new run history requires connectorInstanceId (non-empty immutable connector instance identity); do not fall back to connectorId."
    );
  }
  return record.connectorInstanceId;
}

function rejectEmptyRunHistoryRunId(record: SchedulerRunHistoryRecord): void {
  if (typeof record.runId === "string" && record.runId.trim().length === 0) {
    throw new Error(
      "SchedulerStore.appendRunHistory: runId must be non-empty when provided; do not persist an empty run_id."
    );
  }
}

function sourceWebhookReceiptMatches(receipt: SourceWebhookRunReceipt, input: SourceWebhookRunAdmissionInput): boolean {
  const { active_run: activeRun, source_event: sourceEvent } = input;
  return (
    receipt.source_id === sourceEvent.source_id &&
    receipt.event_id === sourceEvent.event_id &&
    receipt.body_hash === sourceEvent.body_hash &&
    receipt.connector_id === activeRun.connector_id &&
    receipt.connector_instance_id === (activeRun.connector_instance_id ?? activeRun.connector_id) &&
    receipt.owner_subject_id === sourceEvent.owner_subject_id &&
    receipt.action === sourceEvent.action
  );
}

function sourceWebhookReplayOutcome(
  receipt: SourceWebhookRunReceipt,
  input: SourceWebhookRunAdmissionInput
): Extract<SourceWebhookRunAdmission, { kind: "conflict" | "replay" }> {
  return sourceWebhookReceiptMatches(receipt, input) ? { kind: "replay", receipt } : { kind: "conflict", receipt };
}

function sourceWebhookReceiptInsertParameters(input: SourceWebhookRunAdmissionInput): (string | null)[] {
  const { active_run: activeRun, source_event: sourceEvent } = input;
  return [
    sourceEvent.source_id,
    sourceEvent.event_id,
    sourceEvent.body_hash,
    activeRun.connector_id,
    activeRun.connector_instance_id ?? activeRun.connector_id,
    sourceEvent.owner_subject_id,
    sourceEvent.action,
    activeRun.run_id,
    activeRun.trace_id,
    sourceEvent.automation_mode,
    sourceEvent.automation_summary,
    activeRun.started_at,
  ];
}

class SourceWebhookRunAdmissionActiveConflict extends Error {
  constructor() {
    super("A controller active run already exists for this connector instance.");
  }
}

function activeRunInsertParameters(record: ActiveRunRecord): (string | number)[] {
  return [
    record.connector_instance_id ?? record.connector_id,
    record.connector_id,
    record.run_id,
    record.trace_id,
    record.scenario_id,
    record.started_at,
    record.run_generation,
  ];
}

// Legacy scheduler markers were backfilled through the same default-account
// migration as the other scheduler rows. The marker probe must therefore use
// the representable default instance identity, not a nullable instance column.
function legacySchedulerDefaultInstanceId(connectorId: string): string {
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

function parseLegacyMarkerPayload(error: string | null, prefix: string): unknown | null {
  if (typeof error !== "string" || !error.startsWith(prefix)) {
    return null;
  }
  try {
    return JSON.parse(error.slice(prefix.length).trim());
  } catch {
    // A namespaced marker with a malformed/non-JSON suffix is not marker evidence.
    return null;
  }
}

function hasLegacyMarkerReason(payload: unknown, reasonClass: string): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  return (payload as { reason_class?: unknown }).reason_class === reasonClass;
}

function hasLegacyMarkerPayload(
  rows: Iterable<{ readonly error: string | null }>,
  prefix: string,
  reasonClass: string
): boolean {
  for (const row of rows) {
    if (hasLegacyMarkerReason(parseLegacyMarkerPayload(row.error, prefix), reasonClass)) {
      return true;
    }
  }
  return false;
}

export function createSqliteSchedulerStore(): SchedulerStore {
  // biome-ignore assist/source/useSortedKeys: Store verbs follow the lifecycle order documented by SchedulerStore.
  return {
    appendRunHistory(record) {
      const connectorInstanceId = requireRunHistoryConnectorInstanceId(record);
      rejectEmptyRunHistoryRunId(record);
      exec(referenceQueries.controllerInsertRunHistory, [
        connectorInstanceId,
        record.connectorId,
        JSON.stringify(record.source),
        record.status,
        record.recordsEmitted,
        record.reportedRecordsEmitted ?? null,
        serializeJson(record.checkpointSummary ?? null),
        JSON.stringify(record.knownGaps),
        serializeJson(record.connectorError ?? null),
        record.runId ?? null,
        record.traceId ?? null,
        record.failureReason ?? null,
        record.terminalReason ?? null,
        record.startedAt,
        record.completedAt,
        record.error ?? null,
        record.attempt,
      ]);
    },

    createSchedule(record) {
      const connectorInstanceId = record.connector_instance_id ?? record.connector_id;
      exec(referenceQueries.controllerInsertSchedule, [
        connectorInstanceId,
        record.connector_id,
        record.interval_seconds,
        record.jitter_seconds,
        record.enabled ? 1 : 0,
        record.created_at,
        record.updated_at,
      ]);
    },

    admitSourceWebhookRun(input) {
      try {
        return writeTransaction(() => {
          const existing = getOne<SourceWebhookRunReceipt>(referenceQueries.sourceWebhookRunsGetReceipt, [
            input.source_event.source_id,
            input.source_event.event_id,
          ]);
          if (existing) {
            return sourceWebhookReplayOutcome(existing, input);
          }

          const genericClaim = exec(referenceQueries.sourceWebhooksClaimEvent, [
            input.source_event.source_id,
            input.source_event.event_id,
            input.source_event.body_hash,
            input.source_event.received_at,
          ]);
          if (genericClaim.changes === 0) {
            return { kind: "generic_claim_exists" } as const;
          }

          exec(referenceQueries.sourceWebhookRunsInsertReceipt, sourceWebhookReceiptInsertParameters(input));
          const activeRun = exec(
            referenceQueries.controllerUpsertActiveRun,
            activeRunInsertParameters(input.active_run)
          );
          if (activeRun.changes === 0) {
            // Throwing rolls back the receipt too. A bare receipt without its
            // corresponding durable admission would make a retry lie.
            throw new SourceWebhookRunAdmissionActiveConflict();
          }
          return { kind: "admitted" } as const;
        });
      } catch (err) {
        if (err instanceof SourceWebhookRunAdmissionActiveConflict) {
          return { kind: "active_run_exists" } as const;
        }
        throw err;
      }
    },

    deleteActiveRun(connectorInstanceId, runId) {
      exec(referenceQueries.controllerDeleteActiveRun, [runId, connectorInstanceId, connectorInstanceId]);
    },

    deleteSchedule(connectorInstanceId) {
      exec(referenceQueries.controllerDeleteSchedule, [connectorInstanceId]);
    },

    getActiveRun(connectorInstanceId) {
      const rows = allowUnboundedReadAcknowledged<ActiveRunRecord>(referenceQueries.controllerListActiveRuns);
      const found = rows.find((row) => (row.connector_instance_id ?? row.connector_id) === connectorInstanceId);
      return found ?? null;
    },

    getSourceWebhookRunReceipt(sourceId, eventId) {
      return getOne<SourceWebhookRunReceipt>(referenceQueries.sourceWebhookRunsGetReceipt, [sourceId, eventId]) ?? null;
    },

    getLatestRunHistoryForConnection(connectorInstanceId, status = null) {
      const row = getOne<SchedulerRunHistoryRow>(referenceQueries.controllerGetLatestRunHistoryForConnection, [
        connectorInstanceId,
        status,
        status,
      ]);
      return row ? rowToRunHistoryRecord(row) : null;
    },

    getLatestRunHistoryForProductByConnectionId(connectorInstanceId, status = null) {
      // REVIEWED-DYNAMIC: single-connection fallback for the product
      // reader — no scheduler_managed scope, every run kind. Mirrors
      // get-latest-run-history-for-connection.sql minus that scope.
      const row = [
        ...iterateDynamicSqlAcknowledged<SchedulerRunHistoryRow>(
          `SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
           FROM run_history
           WHERE connector_instance_id = ?
             AND (? IS NULL OR status = ?)
           ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
           LIMIT 1`,
          [connectorInstanceId, status, status]
        ),
      ].at(0);
      return row ? rowToProductRunHistoryRecord(row) : null;
    },

    getLatestSettledRunHistoryForProductByConnectionId(connectorInstanceId) {
      // REVIEWED-DYNAMIC: single-connection settled/terminal read for the
      // product reader — no scheduler_managed scope, `status <> 'running'`
      // excludes only the live in-progress placeholder.
      const row = [
        ...iterateDynamicSqlAcknowledged<SchedulerRunHistoryRow>(
          `SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
           FROM run_history
           WHERE connector_instance_id = ?
             AND status <> 'running'
           ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
           LIMIT 1`,
          [connectorInstanceId]
        ),
      ].at(0);
      return row ? rowToProductRunHistoryRecord(row) : null;
    },

    getProductRunHistoryForConnectionRunId(connectorInstanceId, runId) {
      // REVIEWED-DYNAMIC: both values are bound; the fixed projection is the
      // existing product run-history reader. The composite predicate is the
      // identity fence because run_id is not globally unique.
      const row = [
        ...iterateDynamicSqlAcknowledged<SchedulerRunHistoryRow>(
          `SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
           FROM run_history
           WHERE connector_instance_id = ?
             AND run_id = ?
           ORDER BY id DESC
           LIMIT 1`,
          [connectorInstanceId, runId]
        ),
      ].at(0);
      return row ? rowToProductRunHistoryRecord(row) : null;
    },

    getSchedule(connectorInstanceId) {
      const row = getOne<ScheduleSqliteRow>(referenceQueries.controllerGetScheduleByConnector, [connectorInstanceId]);
      return row ? rowToScheduleRecord(row) : null;
    },

    hasLegacySchedulerEventMarker(connectorId, connectorInstanceId, prefix, reasonClass, sinceCompletedAt) {
      if (connectorInstanceId !== legacySchedulerDefaultInstanceId(connectorId)) {
        return false;
      }
      return hasLegacyMarkerPayload(
        iterateDynamicSqlAcknowledged<{ error: string | null }>(
          // REVIEWED-DYNAMIC: legacy marker evidence is intentionally
          // uncapped; each candidate payload is parsed until a valid marker
          // is found, so a 500-row history window cannot hide evidence.
          `SELECT error FROM run_history
           WHERE connector_id = ? AND connector_instance_id = ? AND run_id IS NULL
             AND scheduler_managed AND substr(error, 1, length(?)) = ?
             AND (? IS NULL OR completed_at > ?)`,
          [connectorId, connectorInstanceId, prefix, prefix, sinceCompletedAt, sinceCompletedAt]
        ),
        prefix,
        reasonClass
      );
    },

    listActiveRuns() {
      // REVIEWED-BOUNDED: at most one row per configured connector instance.
      return allowUnboundedReadAcknowledged<ActiveRunRecord>(referenceQueries.controllerListActiveRuns);
    },

    listLastRunTimes() {
      return allowUnboundedReadAcknowledged<SchedulerLastRunTimeRecord>(
        referenceQueries.controllerListSchedulerLastRunTimes
      );
    },

    listLastRunTimesByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunks(connectorInstanceIds);
      if (chunks.length === 0) {
        return [];
      }
      const rows: SchedulerLastRunTimeRecord[] = [];
      for (const ids of chunks) {
        // REVIEWED-DYNAMIC: SQLite has no bound array type; membership is a
        // page-scoped, fixed-fragment IN list with every connection id bound.
        rows.push(
          ...iterateDynamicSqlAcknowledged<SchedulerLastRunTimeRecord>(
            `SELECT connector_instance_id, connector_id, last_run_time_ms, updated_at
             FROM scheduler_last_run_times
             WHERE connector_instance_id IN (${sqliteMembershipPlaceholders(ids)})
             ORDER BY connector_id ASC, connector_instance_id ASC`,
            ids
          )
        );
      }
      return rows.sort(
        (left, right) =>
          left.connector_id.localeCompare(right.connector_id) ||
          left.connector_instance_id.localeCompare(right.connector_instance_id)
      );
    },

    listLatestRunHistoryByConnectionIds(connectorInstanceIds, status = null) {
      const chunks = connectionIdChunks(connectorInstanceIds);
      if (chunks.length === 0) {
        return [];
      }
      const rows: SchedulerRunHistoryRecord[] = [];
      for (const ids of chunks) {
        // REVIEWED-DYNAMIC: SQLite has no bound array type; this ranks one
        // terminal/skip history row per bound page connection id. This is
        // the LIST last-run-facts batch fallback (ref-control.ts) and must
        // produce byte-identical output to before the generalized writer
        // landed — scoped to `scheduler_managed` so a manual/browser/
        // cancelled run's new row does not newly surface here (that
        // widening is a deliberate follow-up slice). `status <> 'running'`
        // excludes the started-but-not-yet-finalized rows the generalized
        // writer creates (openspec/changes/
        // generalize-run-history-write-authority).
        rows.push(
          ...[
            ...iterateDynamicSqlAcknowledged<SchedulerRunHistoryRow>(
              `SELECT ${SCHEDULER_RUN_HISTORY_COLUMNS}
             FROM (
               SELECT ${SCHEDULER_RUN_HISTORY_COLUMNS},
                 ROW_NUMBER() OVER (
                   PARTITION BY connector_instance_id
                   ORDER BY completed_at DESC, id DESC
                 ) AS row_rank
               FROM run_history
               WHERE connector_instance_id IN (${sqliteMembershipPlaceholders(ids)})
                 AND status <> 'running'
                 AND scheduler_managed
                 AND (? IS NULL OR status = ?)
            ) ranked
             WHERE row_rank = 1
             ORDER BY connector_id ASC, connector_instance_id ASC`,
              [...ids, status, status]
            ),
          ].map(rowToRunHistoryRecord)
        );
      }
      return rows.sort(
        (left, right) =>
          left.connectorId.localeCompare(right.connectorId) ||
          (left.connectorInstanceId ?? left.connectorId).localeCompare(right.connectorInstanceId ?? right.connectorId)
      );
    },

    listLatestRunHistoryForProductByConnectionIds(connectorInstanceIds, status = null) {
      const chunks = connectionIdChunks(connectorInstanceIds);
      if (chunks.length === 0) {
        return [];
      }
      const rows: ProductRunHistoryRecord[] = [];
      for (const ids of chunks) {
        // REVIEWED-DYNAMIC: SQLite has no bound array type; this ranks one
        // history row per bound page connection id, EVERY run kind (no
        // scheduler_managed filter). `status = null` includes `running`
        // rows so the caller can compose the live-lease overlay; a
        // non-null status (e.g. "succeeded") filters same as the
        // scheduler-scoped reader — a `running` row never matches a
        // non-null status filter, so the overlay is only reachable
        // through the unfiltered call.
        rows.push(
          ...[
            ...iterateDynamicSqlAcknowledged<SchedulerRunHistoryRow>(
              `SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
             FROM (
               SELECT ${PRODUCT_RUN_HISTORY_COLUMNS},
                 ROW_NUMBER() OVER (
                   PARTITION BY connector_instance_id
                   ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
                 ) AS row_rank
               FROM run_history
               WHERE connector_instance_id IN (${sqliteMembershipPlaceholders(ids)})
                 AND (? IS NULL OR status = ?)
            ) ranked
             WHERE row_rank = 1
             ORDER BY connector_id ASC, connector_instance_id ASC`,
              [...ids, status, status]
            ),
          ].map(rowToProductRunHistoryRecord)
        );
      }
      return rows.sort(
        (left, right) =>
          left.connectorId.localeCompare(right.connectorId) ||
          (left.connectorInstanceId ?? left.connectorId).localeCompare(right.connectorInstanceId ?? right.connectorId)
      );
    },

    listLatestSettledRunHistoryForProductByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunks(connectorInstanceIds);
      if (chunks.length === 0) {
        return [];
      }
      const rows: ProductRunHistoryRecord[] = [];
      for (const ids of chunks) {
        // REVIEWED-DYNAMIC: SQLite has no bound array type; ranks one
        // TERMINAL/settled history row per bound page connection id, every
        // run kind (no scheduler_managed filter). `status <> 'running'`
        // excludes only the live in-progress placeholder.
        rows.push(
          ...[
            ...iterateDynamicSqlAcknowledged<SchedulerRunHistoryRow>(
              `SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
             FROM (
               SELECT ${PRODUCT_RUN_HISTORY_COLUMNS},
                 ROW_NUMBER() OVER (
                   PARTITION BY connector_instance_id
                   ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
                 ) AS row_rank
               FROM run_history
               WHERE connector_instance_id IN (${sqliteMembershipPlaceholders(ids)})
                 AND status <> 'running'
            ) ranked
             WHERE row_rank = 1
             ORDER BY connector_id ASC, connector_instance_id ASC`,
              ids
            ),
          ].map(rowToProductRunHistoryRecord)
        );
      }
      return rows.sort(
        (left, right) =>
          left.connectorId.localeCompare(right.connectorId) ||
          (left.connectorInstanceId ?? left.connectorId).localeCompare(right.connectorInstanceId ?? right.connectorId)
      );
    },

    listRunHistory(limit) {
      return getMany<SchedulerRunHistoryRow>(referenceQueries.controllerListRunHistory, [], {
        limit,
      }).rows.map(rowToRunHistoryRecord);
    },

    listSchedules() {
      // REVIEWED-BOUNDED: connector_schedules holds at most one row per
      // configured connector instance; scan is bounded by instance count.
      const rows = allowUnboundedReadAcknowledged<ScheduleSqliteRow>(referenceQueries.controllerListSchedules);
      return rows.map(rowToScheduleRecord);
    },

    listSchedulesByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunks(connectorInstanceIds);
      if (chunks.length === 0) {
        return [];
      }
      const rows: ScheduleRecord[] = [];
      for (const ids of chunks) {
        // REVIEWED-DYNAMIC: SQLite has no bound array type; membership is a
        // page-scoped, fixed-fragment IN list with every connection id bound.
        rows.push(
          ...[
            ...iterateDynamicSqlAcknowledged<ScheduleSqliteRow>(
              `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
             FROM connector_schedules
             WHERE connector_instance_id IN (${sqliteMembershipPlaceholders(ids)})
             ORDER BY connector_id ASC, connector_instance_id ASC`,
              ids
            ),
          ].map(rowToScheduleRecord)
        );
      }
      return rows.sort(
        (left, right) =>
          left.connector_id.localeCompare(right.connector_id) ||
          left.connector_instance_id.localeCompare(right.connector_instance_id)
      );
    },

    setScheduleEnabled(connectorInstanceId, enabled, updatedAt) {
      exec(referenceQueries.controllerUpdateScheduleEnabled, [enabled ? 1 : 0, updatedAt, connectorInstanceId]);
    },

    updateSchedule(connectorInstanceId, patch) {
      exec(referenceQueries.controllerUpdateSchedule, [
        patch.interval_seconds,
        patch.jitter_seconds,
        patch.enabled ? 1 : 0,
        patch.updated_at,
        connectorInstanceId,
      ]);
    },

    upsertActiveRun(record) {
      // Fail closed: a live row already present for the connector instance
      // must preserve the incumbent row rather than replacing it.
      const result = exec(referenceQueries.controllerUpsertActiveRun, activeRunInsertParameters(record));
      return result.changes > 0;
    },

    upsertLastRunTime(connectorInstanceId, lastRunTimeMs, updatedAt, connectorId = connectorInstanceId) {
      exec(referenceQueries.controllerUpsertSchedulerLastRunTime, [
        connectorInstanceId,
        connectorId,
        lastRunTimeMs,
        updatedAt,
      ]);
    },
  };
}

export function createPostgresSchedulerStore(): SchedulerStore {
  // biome-ignore assist/source/useSortedKeys: Store verbs follow the lifecycle order documented by SchedulerStore.
  return {
    async appendRunHistory(record) {
      const connectorInstanceId = requireRunHistoryConnectorInstanceId(record);
      rejectEmptyRunHistoryRunId(record);
      await postgresQuery(
        `INSERT INTO run_history(
           connector_instance_id,
           connector_id,
           source_json,
           status,
           records_emitted,
           reported_records_emitted,
           checkpoint_summary_json,
           known_gaps_json,
           connector_error_json,
           run_id,
           trace_id,
           failure_reason,
           terminal_reason,
           started_at,
           completed_at,
           error,
           attempt,
           scheduler_managed
         ) VALUES($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, true)
         ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO UPDATE SET
           source_json = excluded.source_json,
           status = excluded.status,
           records_emitted = excluded.records_emitted,
           reported_records_emitted = excluded.reported_records_emitted,
           checkpoint_summary_json = excluded.checkpoint_summary_json,
           known_gaps_json = excluded.known_gaps_json,
           connector_error_json = excluded.connector_error_json,
           trace_id = excluded.trace_id,
           failure_reason = excluded.failure_reason,
           terminal_reason = excluded.terminal_reason,
           completed_at = excluded.completed_at,
           error = excluded.error,
           attempt = excluded.attempt,
           scheduler_managed = true`,
        [
          connectorInstanceId,
          record.connectorId,
          JSON.stringify(record.source),
          record.status,
          record.recordsEmitted,
          record.reportedRecordsEmitted ?? null,
          serializeJson(record.checkpointSummary ?? null),
          JSON.stringify(record.knownGaps),
          serializeJson(record.connectorError ?? null),
          record.runId ?? null,
          record.traceId ?? null,
          record.failureReason ?? null,
          record.terminalReason ?? null,
          record.startedAt,
          record.completedAt,
          record.error ?? null,
          record.attempt,
        ]
      );
    },

    async createSchedule(record) {
      const connectorInstanceId = record.connector_instance_id ?? record.connector_id;
      await postgresQuery(
        `INSERT INTO connector_schedules(
           connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
         ) VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [
          connectorInstanceId,
          record.connector_id,
          record.interval_seconds,
          record.jitter_seconds,
          record.enabled,
          record.created_at,
          record.updated_at,
        ]
      );
    },

    async admitSourceWebhookRun(input) {
      try {
        return await withPostgresTransaction(async (client) => {
          const genericClaim = await client.query(
            `INSERT INTO source_webhook_events(source_id, event_id, body_hash, received_at)
             VALUES($1, $2, $3, $4)
             ON CONFLICT(source_id, event_id) DO NOTHING`,
            [
              input.source_event.source_id,
              input.source_event.event_id,
              input.source_event.body_hash,
              input.source_event.received_at,
            ]
          );
          if ((genericClaim.rowCount ?? 0) === 0) {
            const existing = await client.query(
              `SELECT source_id, event_id, body_hash, connector_id, connector_instance_id, owner_subject_id,
                      action, run_id, trace_id, automation_mode, automation_summary, started_at
                 FROM source_webhook_run_receipts
                WHERE source_id = $1
                  AND event_id = $2`,
              [input.source_event.source_id, input.source_event.event_id]
            );
            const receipt = existing.rows[0] as SourceWebhookRunReceipt | undefined;
            return receipt ? sourceWebhookReplayOutcome(receipt, input) : ({ kind: "generic_claim_exists" } as const);
          }
          const insertedReceipt = await client.query(
            `INSERT INTO source_webhook_run_receipts(
               source_id,
               event_id,
               body_hash,
               connector_id,
               connector_instance_id,
               owner_subject_id,
               action,
               run_id,
               trace_id,
               automation_mode,
               automation_summary,
               started_at
             )
             VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (source_id, event_id) DO NOTHING
             RETURNING source_id, event_id, body_hash, connector_id, connector_instance_id, owner_subject_id,
                       action, run_id, trace_id, automation_mode, automation_summary, started_at`,
            sourceWebhookReceiptInsertParameters(input)
          );
          if ((insertedReceipt.rowCount ?? 0) === 0) {
            const existing = await client.query(
              `SELECT source_id, event_id, body_hash, connector_id, connector_instance_id, owner_subject_id,
                      action, run_id, trace_id, automation_mode, automation_summary, started_at
                 FROM source_webhook_run_receipts
                WHERE source_id = $1
                  AND event_id = $2`,
              [input.source_event.source_id, input.source_event.event_id]
            );
            const receipt = existing.rows[0] as SourceWebhookRunReceipt | undefined;
            if (!receipt) {
              throw new Error("Source-webhook receipt conflict did not expose an incumbent receipt.");
            }
            return sourceWebhookReplayOutcome(receipt, input);
          }

          const activeRun = await client.query(
            `INSERT INTO controller_active_runs(
               connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
             ) VALUES($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (connector_instance_id) DO NOTHING`,
            activeRunInsertParameters(input.active_run)
          );
          if ((activeRun.rowCount ?? 0) === 0) {
            // The transaction rolls back the fresh receipt, preserving the
            // invariant that every receipt names a real durable admission.
            throw new SourceWebhookRunAdmissionActiveConflict();
          }
          return { kind: "admitted" } as const;
        });
      } catch (err) {
        if (err instanceof SourceWebhookRunAdmissionActiveConflict) {
          return { kind: "active_run_exists" } as const;
        }
        throw err;
      }
    },

    async deleteActiveRun(connectorInstanceId, runId) {
      await postgresQuery(
        `DELETE FROM controller_active_runs
         WHERE run_id = $1
           AND (
             connector_instance_id = $2
             OR (connector_instance_id IS NULL AND connector_id = $2)
           )`,
        [runId, connectorInstanceId]
      );
    },

    async deleteSchedule(connectorInstanceId) {
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
    },

    async getActiveRun(connectorInstanceId) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
         FROM controller_active_runs
         WHERE connector_instance_id = $1`,
        [connectorInstanceId]
      );
      return result.rows[0] ? (result.rows[0] as ActiveRunRecord) : null;
    },

    async getSourceWebhookRunReceipt(sourceId, eventId) {
      const result = await postgresQuery(
        `SELECT source_id, event_id, body_hash, connector_id, connector_instance_id, owner_subject_id,
                action, run_id, trace_id, automation_mode, automation_summary, started_at
           FROM source_webhook_run_receipts
          WHERE source_id = $1
            AND event_id = $2`,
        [sourceId, eventId]
      );
      return result.rows[0] ? (result.rows[0] as SourceWebhookRunReceipt) : null;
    },

    async getLatestRunHistoryForConnection(connectorInstanceId, status = null) {
      const result = await postgresQuery(
        `SELECT
           id,
           connector_instance_id,
           connector_id,
           source_json,
           status,
           records_emitted,
           reported_records_emitted,
           checkpoint_summary_json,
           known_gaps_json,
           connector_error_json,
           run_id,
           trace_id,
           failure_reason,
           terminal_reason,
           started_at,
           completed_at,
           error,
           attempt
         FROM run_history
         WHERE connector_instance_id = $1
           AND status <> 'running'
           AND scheduler_managed
           AND ($2::text IS NULL OR status = $2)
         ORDER BY completed_at DESC, id DESC
         LIMIT 1`,
        [connectorInstanceId, status]
      );
      return result.rows[0] ? rowToRunHistoryRecord(result.rows[0] as SchedulerRunHistoryRow) : null;
    },

    async getLatestRunHistoryForProductByConnectionId(connectorInstanceId, status = null) {
      const result = await postgresQuery(
        `SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
         FROM run_history
         WHERE connector_instance_id = $1
           AND ($2::text IS NULL OR status = $2)
         ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
         LIMIT 1`,
        [connectorInstanceId, status]
      );
      return result.rows[0] ? rowToProductRunHistoryRecord(result.rows[0] as SchedulerRunHistoryRow) : null;
    },

    async getLatestSettledRunHistoryForProductByConnectionId(connectorInstanceId) {
      const result = await postgresQuery(
        `SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
         FROM run_history
         WHERE connector_instance_id = $1
           AND status <> 'running'
         ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
         LIMIT 1`,
        [connectorInstanceId]
      );
      return result.rows[0] ? rowToProductRunHistoryRecord(result.rows[0] as SchedulerRunHistoryRow) : null;
    },

    async getProductRunHistoryForConnectionRunId(connectorInstanceId, runId) {
      const result = await postgresQuery(
        `SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
         FROM run_history
         WHERE connector_instance_id = $1
           AND run_id = $2
         ORDER BY id DESC
         LIMIT 1`,
        [connectorInstanceId, runId]
      );
      return result.rows[0] ? rowToProductRunHistoryRecord(result.rows[0] as SchedulerRunHistoryRow) : null;
    },

    async getSchedule(connectorInstanceId) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
         FROM connector_schedules
         WHERE connector_instance_id = $1`,
        [connectorInstanceId]
      );
      return result.rows[0] ? rowToScheduleRecord(result.rows[0] as ScheduleSqliteRow) : null;
    },

    async hasLegacySchedulerEventMarker(connectorId, connectorInstanceId, prefix, reasonClass, sinceCompletedAt) {
      if (connectorInstanceId !== legacySchedulerDefaultInstanceId(connectorId)) {
        return false;
      }
      const result = await postgresQuery(
        `SELECT error FROM run_history
         WHERE connector_id = $1 AND connector_instance_id = $2 AND run_id IS NULL
           AND scheduler_managed AND LEFT(error, LENGTH($3)) = $3
           AND ($4::text IS NULL OR completed_at > $4::text)`,
        [connectorId, connectorInstanceId, prefix, sinceCompletedAt]
      );
      return hasLegacyMarkerPayload(result.rows as Array<{ error: string | null }>, prefix, reasonClass);
    },

    async listActiveRuns() {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
         FROM controller_active_runs
         ORDER BY connector_id, connector_instance_id`
      );
      return result.rows as ActiveRunRecord[];
    },

    async listLastRunTimes() {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, last_run_time_ms, updated_at
         FROM scheduler_last_run_times
         ORDER BY connector_id, connector_instance_id`
      );
      return result.rows as SchedulerLastRunTimeRecord[];
    },

    async listLastRunTimesByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunksOfSize(connectorInstanceIds, POSTGRES_CONNECTION_ID_BATCH_SIZE);
      if (chunks.length === 0) {
        return [];
      }
      const rows: SchedulerLastRunTimeRecord[] = [];
      for (const ids of chunks) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded chunks preserve deterministic result order.
        const result = await postgresQuery(
          `SELECT times.connector_instance_id, times.connector_id, times.last_run_time_ms, times.updated_at
         FROM unnest($1::text[]) AS input(connector_instance_id)
         JOIN scheduler_last_run_times AS times USING (connector_instance_id)
         ORDER BY times.connector_id ASC, times.connector_instance_id ASC`,
          [ids]
        );
        rows.push(
          ...(result.rows as SchedulerLastRunTimeRecord[]).map((row) => ({
            ...row,
            last_run_time_ms: Number(row.last_run_time_ms),
          }))
        );
      }
      return rows.sort(
        (left, right) =>
          left.connector_id.localeCompare(right.connector_id) ||
          left.connector_instance_id.localeCompare(right.connector_instance_id)
      );
    },

    async listLatestRunHistoryByConnectionIds(connectorInstanceIds, status = null) {
      const chunks = connectionIdChunksOfSize(connectorInstanceIds, POSTGRES_CONNECTION_ID_BATCH_SIZE);
      if (chunks.length === 0) {
        return [];
      }
      const rows: SchedulerRunHistoryRecord[] = [];
      for (const ids of chunks) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded chunks preserve deterministic result order.
        const result = await postgresQuery(
          `WITH scoped_history AS (
           SELECT history.id,
                  history.connector_instance_id,
                  history.connector_id,
                  history.source_json,
                  history.status,
                  history.records_emitted,
                  history.reported_records_emitted,
                  history.checkpoint_summary_json,
                  history.known_gaps_json,
                  history.connector_error_json,
                  history.run_id,
                  history.trace_id,
                  history.failure_reason,
                  history.terminal_reason,
                  history.started_at,
                  history.completed_at,
                  history.error,
                  history.attempt,
                  ROW_NUMBER() OVER (
                    PARTITION BY history.connector_instance_id
                    ORDER BY history.completed_at DESC, history.id DESC
                  ) AS row_rank
           FROM unnest($1::text[]) AS input(connector_instance_id)
           JOIN run_history AS history USING (connector_instance_id)
           WHERE history.status <> 'running'
             AND history.scheduler_managed
             AND ($2::text IS NULL OR history.status = $2)
         )
         SELECT ${SCHEDULER_RUN_HISTORY_COLUMNS}
         FROM scoped_history
         WHERE row_rank = 1
         ORDER BY connector_id ASC, connector_instance_id ASC`,
          [ids, status]
        );
        rows.push(...(result.rows as SchedulerRunHistoryRow[]).map(rowToRunHistoryRecord));
      }
      return rows.sort(
        (left, right) =>
          left.connectorId.localeCompare(right.connectorId) ||
          (left.connectorInstanceId ?? left.connectorId).localeCompare(right.connectorInstanceId ?? right.connectorId)
      );
    },

    async listLatestRunHistoryForProductByConnectionIds(connectorInstanceIds, status = null) {
      const chunks = connectionIdChunksOfSize(connectorInstanceIds, POSTGRES_CONNECTION_ID_BATCH_SIZE);
      if (chunks.length === 0) {
        return [];
      }
      const rows: ProductRunHistoryRecord[] = [];
      for (const ids of chunks) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded chunks preserve deterministic result order.
        const result = await postgresQuery(
          `WITH scoped_history AS (
           SELECT history.id,
                  history.connector_instance_id,
                  history.connector_id,
                  history.source_json,
                  history.status,
                  history.records_emitted,
                  history.reported_records_emitted,
                  history.checkpoint_summary_json,
                  history.known_gaps_json,
                  history.connector_error_json,
                  history.run_id,
                  history.trace_id,
                  history.failure_reason,
                  history.terminal_reason,
                  history.started_at,
                  history.completed_at,
                  history.error,
                  history.attempt,
                  history.facts_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY history.connector_instance_id
                    ORDER BY COALESCE(history.completed_at, history.started_at) DESC, history.id DESC
                  ) AS row_rank
           FROM unnest($1::text[]) AS input(connector_instance_id)
           JOIN run_history AS history USING (connector_instance_id)
           WHERE ($2::text IS NULL OR history.status = $2)
         )
         SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
         FROM scoped_history
         WHERE row_rank = 1
         ORDER BY connector_id ASC, connector_instance_id ASC`,
          [ids, status]
        );
        rows.push(...(result.rows as SchedulerRunHistoryRow[]).map(rowToProductRunHistoryRecord));
      }
      return rows.sort(
        (left, right) =>
          left.connectorId.localeCompare(right.connectorId) ||
          (left.connectorInstanceId ?? left.connectorId).localeCompare(right.connectorInstanceId ?? right.connectorId)
      );
    },

    async listLatestSettledRunHistoryForProductByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunksOfSize(connectorInstanceIds, POSTGRES_CONNECTION_ID_BATCH_SIZE);
      if (chunks.length === 0) {
        return [];
      }
      const rows: ProductRunHistoryRecord[] = [];
      for (const ids of chunks) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded chunks preserve deterministic result order.
        const result = await postgresQuery(
          `WITH scoped_history AS (
           SELECT history.id,
                  history.connector_instance_id,
                  history.connector_id,
                  history.source_json,
                  history.status,
                  history.records_emitted,
                  history.reported_records_emitted,
                  history.checkpoint_summary_json,
                  history.known_gaps_json,
                  history.connector_error_json,
                  history.run_id,
                  history.trace_id,
                  history.failure_reason,
                  history.terminal_reason,
                  history.started_at,
                  history.completed_at,
                  history.error,
                  history.attempt,
                  history.facts_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY history.connector_instance_id
                    ORDER BY COALESCE(history.completed_at, history.started_at) DESC, history.id DESC
                  ) AS row_rank
           FROM unnest($1::text[]) AS input(connector_instance_id)
           JOIN run_history AS history USING (connector_instance_id)
           WHERE history.status <> 'running'
         )
         SELECT ${PRODUCT_RUN_HISTORY_COLUMNS}
         FROM scoped_history
         WHERE row_rank = 1
         ORDER BY connector_id ASC, connector_instance_id ASC`,
          [ids]
        );
        rows.push(...(result.rows as SchedulerRunHistoryRow[]).map(rowToProductRunHistoryRecord));
      }
      return rows.sort(
        (left, right) =>
          left.connectorId.localeCompare(right.connectorId) ||
          (left.connectorInstanceId ?? left.connectorId).localeCompare(right.connectorInstanceId ?? right.connectorId)
      );
    },

    async listRunHistory(limit) {
      const boundedLimit = Math.max(1, Math.min(5000, Math.trunc(limit)));
      const result = await postgresQuery(
        `SELECT
           id,
           connector_instance_id,
           connector_id,
           source_json,
           status,
           records_emitted,
           reported_records_emitted,
           checkpoint_summary_json,
           known_gaps_json,
           connector_error_json,
           run_id,
           trace_id,
           failure_reason,
           terminal_reason,
           started_at,
           completed_at,
           error,
           attempt
         FROM (
           SELECT *
           FROM run_history
           WHERE status <> 'running'
             AND scheduler_managed
           ORDER BY completed_at DESC, id DESC
           LIMIT $1
         ) rows
         ORDER BY completed_at ASC, id ASC`,
        [boundedLimit]
      );
      return (result.rows as SchedulerRunHistoryRow[]).map(rowToRunHistoryRecord);
    },

    async listSchedules() {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
         FROM connector_schedules
         ORDER BY connector_id, connector_instance_id`
      );
      return (result.rows as ScheduleSqliteRow[]).map(rowToScheduleRecord);
    },

    async listSchedulesByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunksOfSize(connectorInstanceIds, POSTGRES_CONNECTION_ID_BATCH_SIZE);
      if (chunks.length === 0) {
        return [];
      }
      const rows: ScheduleRecord[] = [];
      for (const ids of chunks) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded chunks preserve deterministic result order.
        const result = await postgresQuery(
          `SELECT schedules.connector_instance_id, schedules.connector_id,
                schedules.interval_seconds, schedules.jitter_seconds, schedules.enabled,
                schedules.created_at, schedules.updated_at
         FROM unnest($1::text[]) AS input(connector_instance_id)
         JOIN connector_schedules AS schedules USING (connector_instance_id)
         ORDER BY schedules.connector_id ASC, schedules.connector_instance_id ASC`,
          [ids]
        );
        rows.push(...(result.rows as ScheduleSqliteRow[]).map(rowToScheduleRecord));
      }
      return rows.sort(
        (left, right) =>
          left.connector_id.localeCompare(right.connector_id) ||
          left.connector_instance_id.localeCompare(right.connector_instance_id)
      );
    },

    async setScheduleEnabled(connectorInstanceId, enabled, updatedAt) {
      await postgresQuery(
        `UPDATE connector_schedules
         SET enabled = $1,
             updated_at = $2
         WHERE connector_instance_id = $3`,
        [enabled, updatedAt, connectorInstanceId]
      );
    },

    async updateSchedule(connectorInstanceId, patch) {
      await postgresQuery(
        `UPDATE connector_schedules
         SET interval_seconds = $1,
             jitter_seconds = $2,
             enabled = $3,
             updated_at = $4
         WHERE connector_instance_id = $5`,
        [patch.interval_seconds, patch.jitter_seconds, patch.enabled, patch.updated_at, connectorInstanceId]
      );
    },

    async upsertActiveRun(record) {
      const result = await postgresQuery(
        `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation)
         VALUES($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (connector_instance_id) DO NOTHING`,
        [
          record.connector_instance_id ?? record.connector_id,
          record.connector_id,
          record.run_id,
          record.trace_id,
          record.scenario_id,
          record.started_at,
          record.run_generation,
        ]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async upsertLastRunTime(connectorInstanceId, lastRunTimeMs, updatedAt, connectorId = connectorInstanceId) {
      await postgresQuery(
        `INSERT INTO scheduler_last_run_times(connector_instance_id, connector_id, last_run_time_ms, updated_at)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(connector_instance_id) DO UPDATE SET
           connector_id = EXCLUDED.connector_id,
           last_run_time_ms = EXCLUDED.last_run_time_ms,
           updated_at = EXCLUDED.updated_at`,
        [connectorInstanceId, connectorId, lastRunTimeMs, updatedAt]
      );
    },
  };
}

export function createSchedulerStore(): SchedulerStore {
  return isPostgresStorageBackend() ? createPostgresSchedulerStore() : createSqliteSchedulerStore();
}

let defaultStore: SchedulerStore | null = null;
let defaultStoreBackend: string | null = null;

export function getDefaultSchedulerStore(): SchedulerStore {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultStoreBackend !== backend) {
    defaultStore = createSchedulerStore();
    defaultStoreBackend = backend;
  }
  return defaultStore;
}
