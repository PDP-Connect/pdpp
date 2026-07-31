// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Kind-neutral run-history writer — Authority Slice A.
//
// `run_history` (renamed from `scheduler_run_history`) is generalizing from
// a scheduler-only projection into a run-grain durable projection written
// by every run kind (scheduled, manual, browser, cancelled). This module
// is the writer: it observes the same `run.started` / `run.completed` /
// `run.failed` / `run.cancelled` spine events every run kind already emits
// through `emitSpineEvent` (lib/spine.ts), and creates/finalizes exactly
// one `run_history` row per `run_id`.
//
// See openspec/changes/generalize-run-history-write-authority and
// terminal-read-architecture-fable-0730.md §7 (R7.1) for the design
// rationale. This slice does NOT touch LIST readers or backfill historical
// spine-only runs — see that document for the follow-up slices.
//
// Identity: `run_id` is NOT globally unique. It is minted independently by
// several call sites (runtime/scheduler/run-executor.ts,
// runtime/controller.ts, runtime/index.ts) using Date.now()-based
// generators with no connection-scoped entropy, so two different
// connections can legitimately produce the same run_id (confirmed live —
// see openspec/changes/run-history-backfill-list-cutover). The real
// identity is the pair (run_id, connector_instance_id).
//
// Idempotency: `run_history(run_id, connector_instance_id)` carries a
// unique index (partial, NULLs excluded — `ON CONFLICT` targets must
// repeat that `WHERE run_id IS NOT NULL` clause verbatim to match a
// partial index). `startRunHistory` is `INSERT ... ON CONFLICT(run_id,
// connector_instance_id) WHERE run_id IS NOT NULL DO NOTHING` — a
// retried/duplicate `run.started` is a no-op. `finalizeRunHistory` first
// tries `UPDATE ... WHERE run_id = ? AND connector_instance_id = ? AND
// status = 'running'` (a retried/duplicate terminal event no-ops because
// the row is no longer `running`); if that affects zero rows (the
// started row raced, was lost, or predates this writer), it falls back
// to inserting the run already terminal, which uses the same conflict
// target for the same reason. The `connector_instance_id` fence on every
// UPDATE is load-bearing, not defensive: without it, a terminal or
// progress write for one connection's run could match and corrupt a
// DIFFERENT connection's still-running row sharing the same run_id.
//
// Transaction alignment: SQLite's `emitSpineEvent` insert and this writer's
// insert both go through the same synchronous single-connection handle
// (`better-sqlite3`), so they succeed or fail together whether or not the
// caller wraps both in an explicit `db.transaction()` — there is no partial-
// commit window on that backend. PostgreSQL has no such single-statement
// guarantee, so the postgres path wraps both writes in one
// `withPostgresTransaction` call for run/terminal event types only (every
// other spine event type keeps its original single-statement write, to
// avoid transaction overhead on the hot non-run path).

import type { PoolClient } from "pg";
import { exec, referenceQueries } from "../../lib/db.ts";

const RUN_STARTED_EVENT_TYPE = "run.started";
// Keep this in lock-step with Spine's canonical terminal set. In particular,
// browser-surface acquisition can fail before connector execution begins, so
// it has no later run.failed event to repair the durable projection.
const RUN_TERMINAL_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.browser_surface_failed",
  "run.cancelled",
  "run.abandoned",
]);
const RUN_PROGRESS_EVENT_TYPE = "run.progress_reported";

export function isRunHistoryRelevantEventType(eventType: string | null | undefined): boolean {
  return (
    eventType === RUN_STARTED_EVENT_TYPE ||
    RUN_TERMINAL_EVENT_TYPES.has(eventType ?? "") ||
    eventType === RUN_PROGRESS_EVENT_TYPE
  );
}

export interface RunHistorySpineEvent {
  readonly connectorId: string | null;
  readonly connectorInstanceId: string | null;
  readonly data: Record<string, unknown>;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly runId: string | null;
  readonly status: string;
}

function toTerminalStatus(eventType: string, status: string): string {
  if (eventType === "run.completed") {
    return status || "succeeded";
  }
  if (eventType === "run.cancelled") {
    return "cancelled";
  }
  if (eventType === "run.abandoned") {
    return "abandoned";
  }
  if (eventType === "run.browser_surface_failed") {
    // The browser lease's terminal vocabulary (`surface_failed`) is already
    // the established run-summary status for this pre-launch path. Preserve
    // it so live writes match historical backfill's existing Spine fold.
    return status || "surface_failed";
  }
  return "failed";
}

// Bounded facts payload (R7.1): the SpineSummary-relevant fields present on
// the terminal event's own `data` that this writer does not promote to
// indexed scalars. This is NOT the full SpineSummary — `summarizeEvents`
// (lib/spine.ts) folds across every event in a run's window (e.g.
// browser-surface fields usually arrive on an earlier
// `run.browser_surface_released` sub-event, not the terminal event
// itself); reproducing that full fold is explicitly out of scope for
// Slice A's writer. Kept small and terminal-event-only on purpose.
//
// `known_gaps`, `collection_facts`, `recovery_only` (added for the
// run-history LIST cutover, terminal-read-architecture-fable-0730.md §9)
// let `toConnectorRunSummary`-equivalent readers build a full
// `ConnectorRunSummary` from this row alone — no per-run
// `readRunTerminalEventData` spine read on GET (G1).
const FACTS_JSON_KEYS = [
  "collection_facts",
  "needs_input",
  "browser_surface_lease_id",
  "browser_surface_profile_key",
  "browser_surface_status",
  "browser_surface_wait_reason",
  "known_gaps",
  "recovery_only",
  "collection_rate",
] as const;

function factsJsonFromTerminalData(data: Record<string, unknown>): string {
  const facts: Record<string, unknown> = {};
  // Browser-surface lifecycle events carry their projection as a bounded
  // nested object. Persist the same whitelisted fields as flattened terminal
  // data so product readers remain run_history-only.
  const browserSurface =
    typeof data.browser_surface === "object" && data.browser_surface !== null && !Array.isArray(data.browser_surface)
      ? (data.browser_surface as Record<string, unknown>)
      : null;
  for (const key of FACTS_JSON_KEYS) {
    if (data[key] !== undefined) {
      facts[key] = data[key];
    } else if (key.startsWith("browser_surface_") && browserSurface?.[key] !== undefined) {
      facts[key] = browserSurface[key];
    }
  }
  return JSON.stringify(facts);
}

function connectorErrorJsonFromTerminalData(data: Record<string, unknown>): string | null {
  // The executor flattens connector-error fields onto the terminal event's
  // data (buildTerminalConnectorFields, runtime/index.ts) rather than
  // nesting a `connectorError` object — reassemble the subset this writer
  // cares about.
  const { connector_error_code, connector_error_message, connector_error_retryable } = data as {
    connector_error_code?: unknown;
    connector_error_message?: unknown;
    connector_error_retryable?: unknown;
  };
  if (
    connector_error_message === undefined &&
    connector_error_code === undefined &&
    connector_error_retryable === undefined
  ) {
    return null;
  }
  return JSON.stringify({
    code: connector_error_code ?? null,
    message: connector_error_message ?? null,
    retryable: connector_error_retryable ?? null,
  });
}

/**
 * Best-effort record of the run.started `data` payload for the eventual
 * `insert-finalized-run-history` fallback (a terminal event arriving with
 * no prior started row). Kept intentionally minimal — the source_json
 * column mirrors the shape scheduler's own writer already stores.
 */
function sourceJsonForStart(data: Record<string, unknown>): string {
  return JSON.stringify({
    automation_mode: data.automation_mode ?? null,
    collection_mode: data.collection_mode ?? null,
    grant_id: data.grant_id ?? null,
    persist_state: data.persist_state ?? null,
    scope: data.scope ?? null,
  });
}

// The run.progress_reported handler emits collection_rate only when the
// connector reports one (runtime/index.ts's handleProgressMessage); most
// progress events carry no rate change and must not overwrite facts_json
// with an empty merge.
function collectionRateMergeJson(data: Record<string, unknown>): string | null {
  if (data.collection_rate === undefined) {
    return null;
  }
  return JSON.stringify({ collection_rate: data.collection_rate });
}

export function writeSqliteRunHistoryForSpineEvent(event: RunHistorySpineEvent): void {
  if (!(event.runId && event.connectorInstanceId && event.connectorId)) {
    // A run event with no connector_instance_id is rejected upstream in
    // emitSpineEvent (assertRunEventHasConnectorInstanceId) for
    // run.started; a terminal event missing identity here means the
    // caller did not thread run connection identity through — skip
    // rather than write a row with fabricated identity.
    return;
  }

  if (event.eventType === RUN_PROGRESS_EVENT_TYPE) {
    // Merge-only, fenced by status='running' (see the query's own
    // comment): a terminal write that already landed makes this a
    // no-op, never overwriting finalized facts_json with a stale
    // in-flight progress snapshot.
    const mergeJson = collectionRateMergeJson(event.data);
    if (mergeJson !== null) {
      exec(referenceQueries.controllerMergeRunHistoryCollectionRate, [
        mergeJson,
        event.runId,
        event.connectorInstanceId,
      ]);
    }
    return;
  }

  if (event.eventType === RUN_STARTED_EVENT_TYPE) {
    exec(referenceQueries.controllerStartRunHistory, [
      event.runId,
      event.connectorInstanceId,
      event.connectorId,
      typeof event.data.trigger_kind === "string" ? event.data.trigger_kind : null,
      sourceJsonForStart(event.data),
      event.occurredAt,
    ]);
    return;
  }

  const terminalStatus = toTerminalStatus(event.eventType, event.status);
  const connectorErrorJson = connectorErrorJsonFromTerminalData(event.data);
  // Slice A scope: the general executor's terminal `data.reason`
  // (e.g. "connector_reported_failed", "owner_cancelled") maps to
  // `terminal_reason` only. `failure_reason` is a narrower scheduler-only
  // classification (see runtime/scheduler/run-executor.ts) this writer
  // does not reproduce for general-executor runs — left null rather than
  // fabricated, since no Slice A reader depends on it for non-scheduled
  // runs.
  const terminalReason = typeof event.data.reason === "string" ? event.data.reason : null;
  const failureReason: string | null = null;
  const factsJson = factsJsonFromTerminalData(event.data);
  const recordsEmitted = typeof event.data.records_emitted === "number" ? event.data.records_emitted : 0;

  const finalizeResult = exec(referenceQueries.controllerFinalizeRunHistory, [
    terminalStatus,
    event.occurredAt,
    recordsEmitted,
    connectorErrorJson,
    failureReason,
    terminalReason,
    factsJson,
    event.runId,
    event.connectorInstanceId,
  ]);
  if (finalizeResult.changes > 0) {
    return;
  }

  exec(referenceQueries.controllerInsertFinalizedRunHistory, [
    event.runId,
    event.connectorInstanceId,
    event.connectorId,
    typeof event.data.trigger_kind === "string" ? event.data.trigger_kind : null,
    sourceJsonForStart(event.data),
    terminalStatus,
    event.occurredAt,
    event.occurredAt,
    recordsEmitted,
    connectorErrorJson,
    failureReason,
    terminalReason,
    factsJson,
  ]);
}

export async function writePostgresRunHistoryForSpineEvent(
  client: PoolClient,
  event: RunHistorySpineEvent
): Promise<void> {
  if (!(event.runId && event.connectorInstanceId && event.connectorId)) {
    return;
  }

  if (event.eventType === RUN_PROGRESS_EVENT_TYPE) {
    // Merge-only, fenced by status='running': a terminal write that
    // already landed makes this a no-op, never overwriting finalized
    // facts_json with a stale in-flight progress snapshot. jsonb `||`
    // is a single atomic statement — no read-then-write race window.
    if (event.data.collection_rate !== undefined) {
      await client.query(
        `UPDATE run_history
         SET facts_json = COALESCE(facts_json, '{}'::jsonb) || jsonb_build_object('collection_rate', $1::jsonb)
         WHERE run_id = $2
           AND connector_instance_id = $3
           AND status = 'running'`,
        [JSON.stringify(event.data.collection_rate), event.runId, event.connectorInstanceId]
      );
    }
    return;
  }

  if (event.eventType === RUN_STARTED_EVENT_TYPE) {
    await client.query(
      `INSERT INTO run_history(
         run_id, connector_instance_id, connector_id, trigger_kind, source_json,
         status, known_gaps_json, started_at, attempt
       ) VALUES($1, $2, $3, $4, $5::jsonb, 'running', '[]'::jsonb, $6, 1)
       ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO NOTHING`,
      [
        event.runId,
        event.connectorInstanceId,
        event.connectorId,
        typeof event.data.trigger_kind === "string" ? event.data.trigger_kind : null,
        sourceJsonForStart(event.data),
        event.occurredAt,
      ]
    );
    return;
  }

  const terminalStatus = toTerminalStatus(event.eventType, event.status);
  const connectorErrorJson = connectorErrorJsonFromTerminalData(event.data);
  // Slice A scope: the general executor's terminal `data.reason`
  // (e.g. "connector_reported_failed", "owner_cancelled") maps to
  // `terminal_reason` only. `failure_reason` is a narrower scheduler-only
  // classification (see runtime/scheduler/run-executor.ts) this writer
  // does not reproduce for general-executor runs — left null rather than
  // fabricated, since no Slice A reader depends on it for non-scheduled
  // runs.
  const terminalReason = typeof event.data.reason === "string" ? event.data.reason : null;
  const failureReason: string | null = null;
  const factsJson = factsJsonFromTerminalData(event.data);
  const recordsEmitted = typeof event.data.records_emitted === "number" ? event.data.records_emitted : 0;

  const finalizeResult = await client.query(
    `UPDATE run_history
     SET status = $1,
         completed_at = $2,
         records_emitted = $3,
         connector_error_json = $4::jsonb,
         failure_reason = $5,
         terminal_reason = $6,
         facts_json = $7::jsonb
     WHERE run_id = $8
       AND connector_instance_id = $9
       AND status = 'running'`,
    [
      terminalStatus,
      event.occurredAt,
      recordsEmitted,
      connectorErrorJson,
      failureReason,
      terminalReason,
      factsJson,
      event.runId,
      event.connectorInstanceId,
    ]
  );
  if ((finalizeResult.rowCount ?? 0) > 0) {
    return;
  }

  await client.query(
    `INSERT INTO run_history(
       run_id, connector_instance_id, connector_id, trigger_kind, source_json,
       status, known_gaps_json, started_at, completed_at, records_emitted,
       connector_error_json, failure_reason, terminal_reason, facts_json, attempt
     ) VALUES($1, $2, $3, $4, $5::jsonb, $6, '[]'::jsonb, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, 1)
     ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO NOTHING`,
    [
      event.runId,
      event.connectorInstanceId,
      event.connectorId,
      typeof event.data.trigger_kind === "string" ? event.data.trigger_kind : null,
      sourceJsonForStart(event.data),
      terminalStatus,
      event.occurredAt,
      event.occurredAt,
      recordsEmitted,
      connectorErrorJson,
      failureReason,
      terminalReason,
      factsJson,
    ]
  );
}
