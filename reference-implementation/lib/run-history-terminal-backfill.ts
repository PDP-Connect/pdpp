// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Historical-drift repair for the boot-time orphan reconciler
 * (`lib/controller-boot.ts`, Stage 6).
 *
 * A `run_history` row can be stuck at `status='running'` even though its
 * run's terminal spine event already exists — e.g. a run abandoned by a
 * PRIOR incarnation of the reconciler (before the writer-authority fix),
 * where the spine write happened but the run_history convergence call did
 * not exist yet. This is not a new orphan class — it replays the SAME
 * single writer authority (write*RunHistoryForSpineEvent, from
 * server/stores/run-history-writer.ts) against terminal spine events that
 * are already durable, for run_history rows the writer never got a chance
 * to finalize.
 *
 * Faithful replay: the terminal event's OWN data_json is carried through
 * unchanged, so records_emitted / connector_error / known_gaps / checkpoint
 * accounting / browser-surface facts converge exactly as they would have
 * via the normal write path — not an abandon-shaped empty payload for
 * every terminal type.
 *
 * Identity-fenced by (run_id, connector_instance_id) + `status = 'running'`
 * exactly like every other writer call site, so it is idempotent and cannot
 * touch an already-terminal or unrelated row. Bounded by
 * RUN_HISTORY_BACKFILL_LIMIT per boot; self-draining — once every
 * run_history row matches its terminal spine event, the join returns zero
 * rows and every subsequent boot's pass is a cheap no-op, not a perpetual
 * sweep. Ties on `occurred_at` (millisecond-resolution timestamps can
 * collide) are broken deterministically by `recorded_at` then `event_id` so
 * SQLite and Postgres pick the same "latest" terminal event.
 *
 * NULL connector_instance_id on the terminal spine event: the orphan
 * reconciler's PRE-writer-authority incarnation (before 3614e31f9) wrote
 * `run.abandoned` via a raw INSERT that never populated
 * connector_instance_id/source_kind/source_id — those columns default to
 * NULL. `run_history.connector_instance_id` is NOT NULL, so a strict `s.
 * connector_instance_id = rh.connector_instance_id` join can never match
 * such a row (SQL NULL = value is UNKNOWN, not true) — this is exactly why
 * run_1785516896273_1 stayed unrepaired after this backfill shipped.
 *
 * Identity recovery for a NULL-instance terminal event, in priority order:
 *
 * 1. PRIMARY — every `run.abandoned` event carries
 *    `data_json.caused_by_event_id`, pointing at the original orphaned
 *    `run.started` event it closes out (see `emitRunAbandoned`/
 *    `emitRunAbandonedSyncSqlite`, lib/controller-boot.ts). That
 *    `run.started` row is a DIFFERENT spine_events row than the
 *    NULL-instance `run.abandoned` row, and durably carries its own
 *    connector_instance_id independent of whether the abandon event's own
 *    column was ever populated. Following this durable relation resolves
 *    the true identity directly — no run_id-uniqueness guesswork needed —
 *    so it is tried first and is the only path that can converge a row
 *    when two connections collide on the same run_id.
 *
 * 2. FALLBACK — if `caused_by_event_id` is absent, unresolvable, or the
 *    event is some other terminal type (only `run.abandoned` ever carries
 *    it), fall back to treating the NULL connector_instance_id as a
 *    wildcard — but ONLY when NO OTHER run_history row of ANY status
 *    shares this run_id with a different connector_instance_id. `run_id`
 *    is not globally unique (two different connections can share one — see
 *    run-history-duplicate-run-id-identity.test.ts), so this guard must
 *    check every sibling row regardless of status: a terminal sibling with
 *    a different connector_instance_id is just as disqualifying as a
 *    running one — matching only 'running' siblings (an earlier version of
 *    this fix) let a legacy NULL-instance event tied to connection A wrongly
 *    apply to connection B's still-running row whenever A's own row had
 *    already terminalized through some other path, because a
 *    status='running' filter made A's terminal row invisible to the
 *    disambiguation check.
 */

import type { PoolClient } from "pg";
import {
  type RunHistorySpineEvent,
  writePostgresRunHistoryForSpineEvent,
  writeSqliteRunHistoryForSpineEvent,
} from "../server/stores/run-history-writer.ts";

// See the module-level doc comment for why this exists and why it's bounded.
export const RUN_HISTORY_BACKFILL_LIMIT = 500;

const TERMINAL_EVENT_TYPES_SQL =
  "'run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled', 'run.abandoned'";

interface TerminalBackfillRow {
  connector_id: string;
  connector_instance_id: string;
  data_json: unknown;
  event_type: string;
  occurred_at: string;
  run_id: string;
  source_id: string | null;
  source_kind: string | null;
  status: string;
}

function terminalBackfillDataFromRow(dataJson: unknown): Record<string, unknown> {
  // Postgres returns jsonb already parsed to a JS value via `pg`; SQLite
  // returns the raw TEXT column and must be parsed explicitly. Faithful
  // replay requires the SAME data the original terminal event carried —
  // an empty object here would silently drop every writer-consumed field
  // (records_emitted, connector_error_*, known_gaps, checkpoint_commit_*,
  // browser_surface_*, reason) for every non-abandoned terminal type.
  if (dataJson && typeof dataJson === "object" && !Array.isArray(dataJson)) {
    return dataJson as Record<string, unknown>;
  }
  if (typeof dataJson === "string") {
    try {
      const parsed = JSON.parse(dataJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to the empty-object default below.
    }
  }
  return {};
}

function toRunHistorySpineEvent(row: TerminalBackfillRow): RunHistorySpineEvent {
  return {
    // Legacy pre-writer-authority terminal events (e.g. run_1785516896273_1's
    // run.abandoned) wrote no source_kind/source_id at all, so the spine
    // event's own identity resolves to null here. Fall back to run_history's
    // own connector_id (NOT NULL in schema) rather than let the writer's
    // `event.connectorId` guard silently reject an otherwise-legitimate
    // convergence.
    connectorId: row.source_kind === "connector" ? row.source_id : row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    data: terminalBackfillDataFromRow(row.data_json),
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    runId: row.run_id,
    status: row.status,
  };
}

export async function backfillRunHistoryFromTerminalSpinePostgres(client: PoolClient): Promise<number> {
  const { rows } = await client.query<TerminalBackfillRow>(
    `
    SELECT DISTINCT ON (rh.run_id, rh.connector_instance_id)
      rh.run_id,
      rh.connector_instance_id,
      rh.connector_id,
      s.event_type,
      s.status,
      s.occurred_at,
      s.source_kind,
      s.source_id,
      s.data_json
    FROM run_history rh
    JOIN spine_events s
      ON s.run_id = rh.run_id
     AND (
       s.connector_instance_id = rh.connector_instance_id
       OR (
         s.connector_instance_id IS NULL
         AND (
           -- Primary: recover true identity via the abandon event's own
           -- durable relation to the run.started event it closes out. Only
           -- accept a POSITIVE match — a resolved run.started with a
           -- different (non-NULL) connector_instance_id proves this event
           -- belongs to a DIFFERENT connection and must never fall through
           -- to the singleton fallback below.
           EXISTS (
             SELECT 1 FROM spine_events started
             WHERE started.event_id = s.data_json->>'caused_by_event_id'
               AND started.connector_instance_id = rh.connector_instance_id
           )
           OR (
             -- Fallback: only when caused_by_event_id is absent/unresolvable
             -- or itself NULL-identity, AND no run_history row of ANY status
             -- shares this run_id with a different connector_instance_id.
             NOT EXISTS (
               SELECT 1 FROM spine_events started
               WHERE started.event_id = s.data_json->>'caused_by_event_id'
                 AND started.connector_instance_id IS NOT NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM run_history other
               WHERE other.run_id = rh.run_id
                 AND other.connector_instance_id <> rh.connector_instance_id
             )
           )
         )
       )
     )
     AND s.event_type IN (${TERMINAL_EVENT_TYPES_SQL})
    WHERE rh.status = 'running'
    ORDER BY rh.run_id, rh.connector_instance_id, s.occurred_at DESC, s.recorded_at DESC, s.event_id DESC
    LIMIT $1
    `,
    [RUN_HISTORY_BACKFILL_LIMIT]
  );

  for (const row of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: Caller (controller-boot.ts) runs this inside the same Postgres transaction as its own writes; must stay ordered and atomic with it.
    await writePostgresRunHistoryForSpineEvent(client, toRunHistorySpineEvent(row));
  }
  return rows.length;
}

interface SqliteStatementLike {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
}

export function backfillRunHistoryFromTerminalSpineSqlite(raw: SqliteStatementLike): number {
  const rows = raw
    .prepare(
      `
      SELECT
        rh.run_id      AS run_id,
        rh.connector_instance_id AS connector_instance_id,
        rh.connector_id AS connector_id,
        s.event_type    AS event_type,
        s.status        AS status,
        s.occurred_at   AS occurred_at,
        s.source_kind   AS source_kind,
        s.source_id     AS source_id,
        s.data_json     AS data_json
      FROM run_history rh
      JOIN spine_events s
        ON s.event_id = (
          SELECT t.event_id
          FROM spine_events t
          WHERE t.run_id = rh.run_id
            AND (
              t.connector_instance_id = rh.connector_instance_id
              OR (
                t.connector_instance_id IS NULL
                AND (
                  -- Primary: recover true identity via the abandon event's
                  -- own durable relation to the run.started event it closes
                  -- out. Only accept a POSITIVE match — a resolved
                  -- run.started with a different (non-NULL)
                  -- connector_instance_id proves this event belongs to a
                  -- DIFFERENT connection and must never fall through to the
                  -- singleton fallback below.
                  EXISTS (
                    SELECT 1 FROM spine_events started
                    WHERE started.event_id = json_extract(t.data_json, '$.caused_by_event_id')
                      AND started.connector_instance_id = rh.connector_instance_id
                  )
                  OR (
                    -- Fallback: only when caused_by_event_id is
                    -- absent/unresolvable or itself NULL-identity, AND no
                    -- run_history row of ANY status shares this run_id with
                    -- a different connector_instance_id.
                    NOT EXISTS (
                      SELECT 1 FROM spine_events started
                      WHERE started.event_id = json_extract(t.data_json, '$.caused_by_event_id')
                        AND started.connector_instance_id IS NOT NULL
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM run_history other
                      WHERE other.run_id = rh.run_id
                        AND other.connector_instance_id <> rh.connector_instance_id
                    )
                  )
                )
              )
            )
            AND t.event_type IN (${TERMINAL_EVENT_TYPES_SQL})
          ORDER BY t.occurred_at DESC, t.recorded_at DESC, t.event_id DESC
          LIMIT 1
        )
      WHERE rh.status = 'running'
      LIMIT ?
      `
    )
    .all(RUN_HISTORY_BACKFILL_LIMIT) as TerminalBackfillRow[];

  for (const row of rows) {
    writeSqliteRunHistoryForSpineEvent(toRunHistorySpineEvent(row));
  }
  return rows.length;
}
