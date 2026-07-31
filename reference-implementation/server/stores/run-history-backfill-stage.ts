// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bounded, resumable backfill of historical spine-only runs into
// `run_history` — terminal-read-architecture-fable-0730.md §9 (R9.1-R9.3).
//
// Scope: every run whose lifecycle predates (or bypassed) the generalized
// run-grain writer (server/stores/run-history-writer.ts) has no
// `run_history` row yet. This stage walks `spine_events` once per
// run-lifecycle event batch, seq-ascending, folds each candidate's own
// CONNECTION-SCOPED event window with the EXISTING `summarizeEvents`/
// `summarizeRows` fold (unchanged fold logic — only the input window is
// pre-scoped; run_id alone is NOT a globally unique identity, see
// openspec/changes/run-history-backfill-list-cutover), and inserts the
// terminal result — never touching a run a live write has already landed
// (`ON CONFLICT(run_id, connector_instance_id) DO NOTHING`, live terminal
// write always wins).
//
// Chassis reuse (R9.1 struck a dedicated table + startup-blocking loop):
// this stage registers its own name-keyed row
// (`connector_maintenance_cursor.name = 'run_history_backfill'`) on the
// SAME fenced-lease cursor store the evidence sweep uses, and runs as one
// more bounded branch on `runConnectorMaintenanceSweep`'s periodic tick +
// the existing one-shot startup sweep. No new table, no new column
// (provenance lives in `facts_json`, not a schema column), no traffic gate.

import { exec, iterateDynamicSqlAcknowledged, referenceQueries } from "../../lib/db.ts";
import {
  fetchRowsForSummaries,
  type Summary as PostgresSpineSummary,
  summarizeRows,
} from "../../lib/postgres-spine.ts";
import {
  connectionIdFromEventData,
  loadEventsForSummaries,
  type SpineEventRecord,
  type SpineSummary,
  summarizeEvents,
} from "../../lib/spine.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";
import {
  getConnectorInstanceStore,
  isPublicReferenceConnector,
  listRegisteredConnectorRows,
  REFERENCE_OWNER_SUBJECT_ID,
  resolveSummaryManifest,
} from "../ref-control.ts";
import {
  type ConnectorMaintenanceCursorStore,
  createConnectorMaintenanceCursorStore,
} from "./connector-maintenance-cursor-store.ts";

// Mirrors the writer's RUN_STARTED_EVENT_TYPE / RUN_TERMINAL_EVENT_TYPES
// (server/stores/run-history-writer.ts) plus the wider terminal set
// lib/spine.ts's summarizeEvents fold itself recognizes
// (run.browser_surface_failed, run.abandoned) — the backfill discovers
// candidate runs from ANY lifecycle event, then lets the unmodified fold
// derive status from whatever window it finds.
const RUN_LIFECYCLE_EVENT_TYPES = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.browser_surface_failed",
  "run.cancelled",
  "run.abandoned",
] as const;

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_DURATION_BUDGET_MS = 2000;
const DEFAULT_LEASE_DURATION_MS = 30_000;

// run_id alone is NOT globally unique: two different connections can
// independently mint the same run_id (Date.now()-based generators with no
// connection-scoped entropy — confirmed live). Candidate discovery,
// idempotency-skip, and event-window folding all key on the pair (run_id,
// connector_instance_id) — the real identity — sourced from
// `spine_events.connector_instance_id` (a real, indexed, write-time-
// populated column; see openspec/changes/reconcile-active-summary-evidence
// and the terminal-event backfill migration
// migrateSpineEventsConnectorInstanceIdBackfill/
// stamp_terminal_manifest_generation), never `data_json` parsing at
// discovery time. A legacy run whose events predate that column (both
// NULL) groups into its own NULL-instance candidate and flows through the
// existing resolveLegacyConnectorWideInstanceId singleton-resolution path
// unchanged (R9.2) — SQL GROUP BY already treats NULL as equal to NULL for
// grouping. See openspec/changes/run-history-backfill-list-cutover.
interface CandidateRun {
  readonly connectorInstanceId: string | null;
  readonly maxEventSeq: number;
  readonly runId: string;
}

function toFiniteEventSeq(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sqliteFindCandidateRuns(afterSeq: number, limit: number): CandidateRun[] {
  const placeholders = RUN_LIFECYCLE_EVENT_TYPES.map(() => "?").join(", ");
  // REVIEWED-DYNAMIC: fixed event-type IN-list, bounded LIMIT; (run_id,
  // connector_instance_id) membership against run_history is the
  // idempotency skip (never re-fold a run a live write or a prior
  // backfill tick already landed) — NOT run_id alone, which is not a
  // unique identity (see header comment above CandidateRun).
  const rows = [
    ...iterateDynamicSqlAcknowledged<{ connector_instance_id: string | null; run_id: string; max_seq: number }>(
      `SELECT run_id, connector_instance_id, MAX(event_seq) AS max_seq
       FROM spine_events
       WHERE run_id IS NOT NULL
         AND event_seq > ?
         AND event_type IN (${placeholders})
         AND NOT EXISTS (
           SELECT 1 FROM run_history
           WHERE run_history.run_id = spine_events.run_id
             AND (
               run_history.connector_instance_id = spine_events.connector_instance_id
               OR (run_history.connector_instance_id IS NULL AND spine_events.connector_instance_id IS NULL)
             )
         )
       GROUP BY run_id, connector_instance_id
       ORDER BY max_seq ASC
       LIMIT ?`,
      [afterSeq, ...RUN_LIFECYCLE_EVENT_TYPES, limit]
    ),
  ];
  return rows
    .map((row) => {
      const maxEventSeq = toFiniteEventSeq(row.max_seq);
      return maxEventSeq === null
        ? null
        : { connectorInstanceId: row.connector_instance_id, maxEventSeq, runId: row.run_id };
    })
    .filter((row): row is CandidateRun => row !== null);
}

async function postgresFindCandidateRuns(afterSeq: number, limit: number): Promise<CandidateRun[]> {
  const result = await postgresQuery<{ connector_instance_id: string | null; run_id: string; max_seq: string }>(
    `SELECT run_id, connector_instance_id, MAX(event_seq)::text AS max_seq
     FROM spine_events
     WHERE run_id IS NOT NULL
       AND event_seq > $1
       AND event_type = ANY($2::text[])
       AND NOT EXISTS (
         SELECT 1 FROM run_history
         WHERE run_history.run_id = spine_events.run_id
           AND run_history.connector_instance_id IS NOT DISTINCT FROM spine_events.connector_instance_id
       )
     GROUP BY run_id, connector_instance_id
     ORDER BY MAX(event_seq) ASC
     LIMIT $3`,
    [afterSeq, [...RUN_LIFECYCLE_EVENT_TYPES], limit]
  );
  return result.rows
    .map((row) => {
      const maxEventSeq = toFiniteEventSeq(row.max_seq);
      return maxEventSeq === null
        ? null
        : { connectorInstanceId: row.connector_instance_id, maxEventSeq, runId: row.run_id };
    })
    .filter((row): row is CandidateRun => row !== null);
}

// A run whose fold never resolved a connection identity (legacy
// connector-wide run, pre-dates connection_id on the spine). Resolvable
// only when the connector currently has exactly one active, owner-visible
// instance — applied ONCE here, at backfill time (R9.2); unattributable
// runs are skipped (connector_instance_id is NOT NULL on run_history, so
// "never surfaced" means "never inserted", not a null-instance row).
// `resolveActiveByConnector` already throws on zero or multiple active
// instances — exactly the singleton-or-reject semantics this rule needs.
async function resolveLegacyConnectorWideInstanceId(connectorId: string): Promise<string | null> {
  const connectorRows = await listRegisteredConnectorRows();
  const connectorRow = connectorRows.find((row) => row.connector_id === connectorId);
  if (!connectorRow) {
    return null;
  }
  const { manifest } = resolveSummaryManifest(connectorRow.manifest);
  if (!isPublicReferenceConnector(connectorRow, manifest)) {
    return null;
  }
  try {
    const instance = await Promise.resolve(
      getConnectorInstanceStore().resolveActiveByConnector(REFERENCE_OWNER_SUBJECT_ID, connectorId)
    );
    return instance.connectorInstanceId;
  } catch {
    return null;
  }
}

interface ResolvedRunAttribution {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
}

async function resolveRunAttribution(summary: {
  readonly connection_id?: string | null;
  readonly connector_id: string | null;
  readonly connector_instance_id?: string | null;
  readonly source_id: string | null;
  readonly source_kind: string | null;
}): Promise<ResolvedRunAttribution | null> {
  const connectorInstanceId = summary.connection_id ?? summary.connector_instance_id ?? null;
  const connectorId = summary.connector_id ?? (summary.source_kind === "connector" ? summary.source_id : null);
  if (!connectorId) {
    return null;
  }
  if (connectorInstanceId) {
    return { connectorId, connectorInstanceId };
  }
  if (summary.source_kind !== "connector") {
    return null;
  }
  const legacyInstanceId = await resolveLegacyConnectorWideInstanceId(connectorId);
  return legacyInstanceId ? { connectorId, connectorInstanceId: legacyInstanceId } : null;
}

// Mirrors run-history-writer.ts's FACTS_JSON_KEYS exactly (plus
// `origin: "backfill"`, the provenance marker R9.1 keeps out of the
// schema). Read from the terminal event's own raw `data` — the fold
// (`SpineSummary`/`Summary`) does not carry these fields at all, so
// sourcing them from the summary object (as an earlier draft of this
// stage did) would have silently written empty facts for every backfilled
// row.
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

function factsJsonForBackfill(terminalData: Record<string, unknown> | null): string {
  const facts: Record<string, unknown> = { origin: "backfill" };
  if (terminalData) {
    const browserSurface =
      typeof terminalData.browser_surface === "object" &&
      terminalData.browser_surface !== null &&
      !Array.isArray(terminalData.browser_surface)
        ? (terminalData.browser_surface as Record<string, unknown>)
        : null;
    for (const key of FACTS_JSON_KEYS) {
      let value = terminalData[key];
      if (value === undefined && key.startsWith("browser_surface_")) {
        value = browserSurface?.[key];
      }
      if (value !== undefined) {
        facts[key] = value;
      }
    }
  }
  return JSON.stringify(facts);
}

const RUN_TERMINAL_EVENT_TYPES_FOR_FACTS = new Set([
  "run.completed",
  "run.failed",
  "run.browser_surface_failed",
  "run.cancelled",
  "run.abandoned",
]);

// Composite candidate key: run_id alone is NOT globally unique (see the
// CandidateRun header comment above). Every per-candidate map in this
// module (summaries, terminal facts data) is keyed by this string, never
// by bare run_id, so two candidates sharing a run_id on different
// connections never collide on the same map entry. U+0000 cannot appear
// in a run_id/connector_instance_id (both are opaque application-minted
// identifiers, never raw user input), so it is a safe separator.
function candidateKey(runId: string, connectorInstanceId: string | null): string {
  return `${runId} ${connectorInstanceId ?? ""}`;
}

// SQLite: extract the terminal event's `data` from the already-fetched,
// per-candidate-scoped event window — zero extra query.
function sqliteTerminalDataByCandidate(
  candidates: readonly CandidateRun[],
  eventsByCandidate: ReadonlyMap<string, readonly { readonly data: unknown; readonly event_type: string }[]>
): Map<string, Record<string, unknown> | null> {
  const byCandidate = new Map<string, Record<string, unknown> | null>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate.runId, candidate.connectorInstanceId);
    const events = eventsByCandidate.get(key) ?? [];
    const terminal = [...events].reverse().find((e) => RUN_TERMINAL_EVENT_TYPES_FOR_FACTS.has(e.event_type));
    const data = terminal?.data;
    byCandidate.set(
      key,
      data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null
    );
  }
  return byCandidate;
}

// Postgres: one small batched query for the terminal event's data_json
// per (run_id, connector_instance_id) candidate in this bounded set
// (never a per-run GET-path read — this runs inside the maintenance
// sweep only). Scoped by connector_instance_id (IS NOT DISTINCT FROM,
// so a NULL-instance legacy candidate matches only NULL-instance rows,
// never a different connection's rows) — a bare run_id filter would
// blend two connections' terminal events into one candidate's facts.
async function postgresTerminalDataByCandidate(
  candidates: readonly CandidateRun[]
): Promise<Map<string, Record<string, unknown> | null>> {
  const byCandidate = new Map<string, Record<string, unknown> | null>(
    candidates.map((c) => [candidateKey(c.runId, c.connectorInstanceId), null])
  );
  if (candidates.length === 0) {
    return byCandidate;
  }
  const runIds = candidates.map((c) => c.runId);
  const result = await postgresQuery<{ connector_instance_id: string | null; data_json: string; run_id: string }>(
    `SELECT DISTINCT ON (run_id, connector_instance_id) run_id, connector_instance_id, data_json::text AS data_json
     FROM spine_events
     WHERE run_id = ANY($1::text[])
       AND event_type = ANY($2::text[])
     ORDER BY run_id, connector_instance_id, event_seq DESC`,
    [runIds, [...RUN_TERMINAL_EVENT_TYPES_FOR_FACTS]]
  );
  for (const row of result.rows) {
    const key = candidateKey(row.run_id, row.connector_instance_id);
    if (!byCandidate.has(key)) {
      continue;
    }
    try {
      const parsed = JSON.parse(row.data_json);
      byCandidate.set(key, parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
    } catch {
      byCandidate.set(key, null);
    }
  }
  return byCandidate;
}

function toRunHistoryStatus(status: string): string {
  // The fold's "in_progress" means a live lease still holds the run —
  // never write that as a terminal backfilled row; treat it as not yet
  // eligible (its own live run.started/finalize writer owns that row).
  return status === "in_progress" ? "running" : status;
}

function sourceJsonForBackfill(): string {
  return JSON.stringify({});
}

function sqliteInsertBackfilledRun(input: {
  readonly attribution: ResolvedRunAttribution;
  readonly factsJson: string;
  readonly finishedAt: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly status: string;
}): void {
  exec(referenceQueries.controllerInsertFinalizedRunHistory, [
    input.runId,
    input.attribution.connectorInstanceId,
    input.attribution.connectorId,
    null,
    sourceJsonForBackfill(),
    input.status,
    input.startedAt,
    input.finishedAt,
    0,
    null,
    null,
    null,
    input.factsJson,
  ]);
}

async function postgresInsertBackfilledRun(input: {
  readonly attribution: ResolvedRunAttribution;
  readonly factsJson: string;
  readonly finishedAt: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly status: string;
}): Promise<void> {
  await postgresQuery(
    `INSERT INTO run_history(
       run_id, connector_instance_id, connector_id, trigger_kind, source_json,
       status, known_gaps_json, started_at, completed_at, records_emitted,
       connector_error_json, failure_reason, terminal_reason, facts_json, attempt
     ) VALUES($1, $2, $3, NULL, $4::jsonb, $5, '[]'::jsonb, $6, $7, 0, NULL, NULL, NULL, $8::jsonb, 1)
     ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO NOTHING`,
    [
      input.runId,
      input.attribution.connectorInstanceId,
      input.attribution.connectorId,
      sourceJsonForBackfill(),
      input.status,
      input.startedAt,
      input.finishedAt,
      input.factsJson,
    ]
  );
}

export interface RunHistoryBackfillTickResult {
  readonly attempted: number;
  readonly backfilled: number;
  readonly incomplete: boolean;
  readonly resumeAfterSeq: number | null;
}

// One candidate's attribution-resolve + insert, extracted out of
// runRunHistoryBackfillRound's loop to keep that function's cognitive
// complexity bounded. Returns whether a row landed (false = unattributable,
// skipped — never surfaced, per R9.2).
async function backfillOneCandidate(
  postgres: boolean,
  candidate: CandidateRun,
  summary: PostgresSpineSummary | SpineSummary,
  terminalDataByCandidate: ReadonlyMap<string, Record<string, unknown> | null>
): Promise<boolean> {
  if (!summary.first_at) {
    return false;
  }
  const status = toRunHistoryStatus(summary.status);
  const attribution = await resolveRunAttribution(summary);
  if (!attribution) {
    return false;
  }
  const key = candidateKey(candidate.runId, candidate.connectorInstanceId);
  const factsJson = factsJsonForBackfill(terminalDataByCandidate.get(key) ?? null);
  const finishedAt = summary.last_at || summary.first_at;
  if (postgres) {
    await postgresInsertBackfilledRun({
      attribution,
      factsJson,
      finishedAt,
      runId: candidate.runId,
      startedAt: summary.first_at,
      status,
    });
  } else {
    sqliteInsertBackfilledRun({
      attribution,
      factsJson,
      finishedAt,
      runId: candidate.runId,
      startedAt: summary.first_at,
      status,
    });
  }
  return true;
}

// Fold every candidate's own CONNECTION-SCOPED event window (not merely
// its run_id window, which run_id alone is not a unique identity — see
// the CandidateRun header comment) with the unmodified fold
// (summarizeEvents / summarizeRows), plus its terminal event's raw facts
// data, in one batched pass per backend. Extracted out of
// runRunHistoryBackfillRound to keep that function's cognitive complexity
// bounded.
//
// Both backends fetch by run_id exactly as before (the SAME batched
// fetch this stage always used — loadEventsForSummaries /
// fetchRowsForSummaries, genuinely unmodified), then filter the returned
// window down to the candidate's own connector_instance_id BEFORE
// folding: Postgres via the real connector_instance_id column already on
// each fetched row; SQLite via connectionIdFromEventData (the same
// data.connector_instance_id/data.connection_id precedence
// summarizeEvents itself uses internally to resolve connection_id,
// since SpineEventRecord does not carry the raw column). A candidate
// with connectorInstanceId === null (legacy pre-migration run) matches
// events whose own resolved connection id is also null/absent — the
// existing resolveLegacyConnectorWideInstanceId singleton path (R9.2)
// then handles attribution for that filtered window exactly as it did
// before this fix, just now guaranteed not to have another connection's
// events mixed in.
async function loadCandidateFoldData(
  postgres: boolean,
  candidates: readonly CandidateRun[]
): Promise<{
  readonly summariesById: ReadonlyMap<string, PostgresSpineSummary | SpineSummary>;
  readonly terminalDataByCandidate: ReadonlyMap<string, Record<string, unknown> | null>;
}> {
  const runIds = [...new Set(candidates.map((c) => c.runId))];
  if (postgres) {
    const rowsByRunId = await fetchRowsForSummaries("run", "run_id", runIds);
    const summariesById = new Map<string, PostgresSpineSummary>();
    for (const candidate of candidates) {
      const rows = (rowsByRunId.get(candidate.runId) ?? []).filter(
        (row) => row.connector_instance_id === candidate.connectorInstanceId
      );
      if (rows.length === 0) {
        continue;
      }
      const key = candidateKey(candidate.runId, candidate.connectorInstanceId);
      // biome-ignore lint/performance/noAwaitInLoops: bounded per-batch candidate count; summarizeRows itself issues at most one lease-lookup query per in-progress candidate.
      summariesById.set(key, await summarizeRows(candidate.runId, rows));
    }
    return {
      summariesById,
      terminalDataByCandidate: await postgresTerminalDataByCandidate(candidates),
    };
  }
  const eventsByRunId = loadEventsForSummaries("run", runIds);
  const summariesById = new Map<string, SpineSummary>();
  const eventsByCandidate = new Map<string, SpineEventRecord[]>();
  for (const candidate of candidates) {
    const events = (eventsByRunId.get(candidate.runId) ?? []).filter(
      (event) => connectionIdFromEventData(event) === candidate.connectorInstanceId
    );
    const key = candidateKey(candidate.runId, candidate.connectorInstanceId);
    eventsByCandidate.set(key, events);
    if (events.length === 0) {
      continue;
    }
    const summary = summarizeEvents(events);
    if (summary) {
      summariesById.set(key, summary);
    }
  }
  return {
    summariesById,
    terminalDataByCandidate: sqliteTerminalDataByCandidate(candidates, eventsByCandidate),
  };
}

/**
 * One bounded backfill round: find a batch of candidate run ids (event_seq
 * > cursor), fold each with the unmodified summarize fold, resolve
 * attribution, and insert. Idempotent (ON CONFLICT DO NOTHING; a run
 * already in run_history is excluded from candidate discovery itself).
 * The cursor commits only after the batch has landed — the caller
 * (createResumableRunHistoryBackfillStage) owns the fenced-lease cursor
 * read/write; this function is pure given its `afterSeq` input.
 */
export async function runRunHistoryBackfillRound(options: {
  readonly afterSeq: number;
  readonly batchSize?: number;
  readonly maxDurationMs?: number;
}): Promise<RunHistoryBackfillTickResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const deadline = Date.now() + (options.maxDurationMs ?? DEFAULT_DURATION_BUDGET_MS);
  const postgres = isPostgresStorageBackend();

  const candidates = postgres
    ? await postgresFindCandidateRuns(options.afterSeq, batchSize)
    : sqliteFindCandidateRuns(options.afterSeq, batchSize);

  if (candidates.length === 0) {
    return { attempted: 0, backfilled: 0, incomplete: false, resumeAfterSeq: null };
  }

  const { summariesById, terminalDataByCandidate } = await loadCandidateFoldData(postgres, candidates);

  let backfilled = 0;
  let incomplete = false;
  let resumeAfterSeq: number | null = null;

  for (const candidate of candidates) {
    if (Date.now() >= deadline) {
      incomplete = true;
      break;
    }
    const key = candidateKey(candidate.runId, candidate.connectorInstanceId);
    const summary = summariesById.get(key);
    if (summary && toRunHistoryStatus(summary.status) === "running") {
      // Still-active run: its own live writer owns this row once it
      // terminates, or the read-time lease overlay discovers it orphaned.
      // Do NOT advance the cursor past this run's event_seq — a candidate
      // discovery query is `event_seq > cursor`, so advancing past it
      // would permanently drop this run from future candidate batches
      // before its own writer (or a later backfill pass, once it has
      // terminated) ever lands a row. Stop the batch here; the next round
      // resumes from the same point and re-finds it once terminal.
      incomplete = true;
      break;
    }
    resumeAfterSeq = candidate.maxEventSeq;
    if (!summary?.first_at) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: sequential per-candidate work within one bounded batch; ordering matches candidate discovery order.
    const landed = await backfillOneCandidate(postgres, candidate, summary, terminalDataByCandidate);
    if (landed) {
      backfilled += 1;
    }
  }

  return {
    attempted: candidates.length,
    backfilled,
    incomplete: incomplete || candidates.length >= batchSize,
    resumeAfterSeq,
  };
}

const CURSOR_NAME = "run_history_backfill" as const;

export interface ResumableRunHistoryBackfillStage {
  readonly run: (args: {
    readonly batchSize?: number;
    readonly maxDurationMs?: number;
  }) => Promise<RunHistoryBackfillTickResult | null>;
}

/**
 * Wraps `runRunHistoryBackfillRound` with the same fenced-lease cursor
 * bookkeeping pattern `createResumableConnectorMaintenanceSweep` uses for
 * the evidence sweep (connector-maintenance-sweep.ts) — a separate cursor
 * row (`name = 'run_history_backfill'`) on the SAME
 * `connector_maintenance_cursor` table, so two concurrent sweep owners
 * fence via the store's existing generation/lease-token compare-and-set.
 */
export function createResumableRunHistoryBackfillStage(
  cursorStore: ConnectorMaintenanceCursorStore = createConnectorMaintenanceCursorStore(CURSOR_NAME)
): ResumableRunHistoryBackfillStage {
  let inFlight = false;
  return {
    async run({ batchSize, maxDurationMs } = {}) {
      if (inFlight) {
        return null;
      }
      inFlight = true;
      let lease: Awaited<ReturnType<ConnectorMaintenanceCursorStore["acquire"]>> = null;
      let committed = false;
      try {
        const nowIso = new Date().toISOString();
        lease = await cursorStore.acquire({ leaseDurationMs: DEFAULT_LEASE_DURATION_MS, nowIso });
        if (!lease) {
          return null;
        }
        const afterSeq = lease.resumeAfterId ? (toFiniteEventSeq(lease.resumeAfterId) ?? 0) : 0;
        const result = await runRunHistoryBackfillRound({
          afterSeq,
          ...(typeof batchSize === "number" ? { batchSize } : {}),
          ...(typeof maxDurationMs === "number" ? { maxDurationMs } : {}),
        });
        const nextResumeAfterId = result.resumeAfterSeq === null ? lease.resumeAfterId : String(result.resumeAfterSeq);
        committed = await cursorStore.commit({
          lease,
          resumeAfterId: nextResumeAfterId,
          updatedAt: new Date().toISOString(),
        });
        if (!committed) {
          return null;
        }
        return result;
      } finally {
        if (lease && !committed) {
          await cursorStore.release(lease).catch(() => {
            // The bounded lease eventually expires; never mask the round's own error.
          });
        }
        inFlight = false;
      }
    },
  };
}

/**
 * One-shot startup accelerator (mirrors
 * `runStartupSummaryEvidenceSweepToCompletion`, server/index.ts): runs the
 * stage repeatedly, each round bounded by its own duration budget, until a
 * round finds nothing left to do, is not `incomplete`, or the round cap is
 * reached. NOT a traffic gate (R9.1 struck the blocking-startup-loop
 * proposal) — callers fire this via `setImmediate`/fire-and-forget the
 * same way the evidence sweep's startup walker runs, never awaited before
 * the HTTP listener opens. A connection this walk does not finish
 * reaching still converges on the next periodic tick; G4 honesty
 * (`not yet observed (backfilling)`) covers the gap, never a spine
 * fallback.
 */
export async function runStartupRunHistoryBackfillToCompletion(options: {
  readonly batchSize?: number;
  readonly maxDurationMs?: number;
  readonly maxRounds?: number;
  readonly onRound?: (result: RunHistoryBackfillTickResult, round: number) => void;
  readonly stage?: ResumableRunHistoryBackfillStage;
}): Promise<readonly RunHistoryBackfillTickResult[]> {
  const stage = options.stage ?? createResumableRunHistoryBackfillStage();
  const maxRounds = options.maxRounds ?? 20;
  const rounds: RunHistoryBackfillTickResult[] = [];
  for (let round = 0; round < maxRounds; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each round must observe the previous round's cursor commit before deciding whether to continue.
    const result = await stage.run({
      ...(typeof options.batchSize === "number" ? { batchSize: options.batchSize } : {}),
      ...(typeof options.maxDurationMs === "number" ? { maxDurationMs: options.maxDurationMs } : {}),
    });
    if (!result) {
      break;
    }
    rounds.push(result);
    options.onRound?.(result, round);
    if (!result.incomplete) {
      break;
    }
  }
  return rounds;
}
