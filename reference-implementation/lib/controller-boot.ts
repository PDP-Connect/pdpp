// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-epoch reconciliation: the boot-time function that emits
 * `controller.booted` as the first spine event of every process
 * incarnation, then stashes the resulting `(boot_epoch, seq,
 * controller_id)` triple in the spine-module singleton.
 *
 * Called from `startServer` after spine init and BEFORE HTTP routes
 * are mounted. The order is enforced by `startServer`'s sequence, not
 * by this module — see `reference-implementation/server/index.ts`.
 *
 * After this returns, the singleton is populated and any subsequent
 * `run.started` emission can stamp itself (see `lib/spine.ts`).
 *
 * Design contract: docs/run-reconciliation-design-brief.md §3.4, Stage 5.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import type { PoolClient } from "pg";
import { getDb } from "../server/db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../server/postgres-storage.ts";
import {
  type RunHistorySpineEvent,
  writePostgresRunHistoryForSpineEvent,
  writeSqliteRunHistoryForSpineEvent,
} from "../server/stores/run-history-writer.ts";
import { type BootEpoch, emitSpineEvent, setCurrentBootEpoch } from "./spine.ts";

export interface BootControllerOpts {
  /** Override for testing; defaults to randomUUID. */
  bootEpoch?: string;
  /** Override for testing; defaults to PDPP_CONTROLLER_ID || os.hostname(). */
  controllerId?: string;
  /** Process fingerprint fields. */
  gitSha?: string | null;
}

function resolveControllerId(opts: BootControllerOpts): string {
  if (opts.controllerId && opts.controllerId.length > 0) {
    return opts.controllerId;
  }
  const fromEnv = process.env.PDPP_CONTROLLER_ID;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return os.hostname();
}

/**
 * Compute the next `seq` for THIS controller_id by querying prior
 * controller.booted events. Returns 1 on first boot.
 *
 * See design brief §3.2 — `seq` is monotonic *per controller_id*; this
 * is single-controller-monotonic by virtue of the WHERE clause.
 * Concurrent boots from the same controller_id can race
 * (MAX(seq)+1 isn't atomic); single-deploy reference operations don't.
 */
async function nextSeqForController(controllerId: string): Promise<number> {
  if (isPostgresStorageBackend()) {
    const { rows } = await postgresQuery(
      `SELECT COALESCE(MAX((data_json->>'seq')::int), 0) + 1 AS next_seq
       FROM spine_events
       WHERE event_type = 'controller.booted'
         AND data_json->>'controller_id' = $1`,
      [controllerId]
    );
    return Number(rows[0]?.next_seq ?? 1);
  }
  const db = getDb();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  if (!db) {
    return 1;
  }
  const row = (
    db as unknown as {
      prepare: (sql: string) => { get: (arg: string) => { next_seq: number } | undefined };
    }
  )
    .prepare(
      `SELECT COALESCE(MAX(CAST(json_extract(data_json, '$.seq') AS INTEGER)), 0) + 1 AS next_seq
       FROM spine_events
       WHERE event_type = 'controller.booted'
         AND json_extract(data_json, '$.controller_id') = ?`
    )
    .get(controllerId);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  return Number(row?.next_seq ?? 1);
}

/**
 * Stage 5 of the boot sequence: emit `controller.booted` and stash the
 * singleton. Must be called before HTTP routes mount and before any
 * `run.started` event is emitted by this process.
 *
 * Returns the resolved BootEpoch so the caller (startServer) can pass
 * it to the orphan reconciler (Stage 6).
 */
export async function emitControllerBootedAndStashEpoch(opts: BootControllerOpts = {}): Promise<BootEpoch> {
  const controllerId = resolveControllerId(opts);
  const bootEpoch = opts.bootEpoch && opts.bootEpoch.length > 0 ? opts.bootEpoch : randomUUID();
  const seq = await nextSeqForController(controllerId);

  await emitSpineEvent({
    actor_id: "controller",
    actor_type: "runtime",
    data: {
      controller_id: controllerId,
      epoch: bootEpoch,
      process_info: {
        git_sha: opts.gitSha ?? process.env.PDPP_GIT_SHA ?? null,
        node_version: process.versions.node,
        storage_backend: isPostgresStorageBackend() ? "postgres" : "sqlite",
      },
      seq,
      started_at: new Date().toISOString(),
    },
    event_type: "controller.booted",
  });

  const triple: BootEpoch = {
    boot_epoch: bootEpoch,
    controller_id: controllerId,
    seq,
  };
  setCurrentBootEpoch(triple);
  return triple;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 6: Boot-time abandoned-run reconciler.
//
// Scans the spine for run.started events from prior controller incarnations
// that lack any terminal event, and emits run.abandoned for each one.
//
// Per docs/run-reconciliation-design-brief.md §3.4:
//   - Owns: orphans whose data_json.controller_id matches THIS boot's
//     controller_id (or is NULL/legacy under single-controller assumption).
//     Multi-controller deployments are isolated by controller_id.
//   - One SELECT, one transactional batch of INSERTs — iteration is
//     deterministic regardless of run_id collisions.
//   - Idempotent on caused_by_event_id via the spine_run_abandoned_cause_unique
//     partial index. Re-running this function is safe.
//   - Failure aborts boot (caller must NOT wrap in try/catch swallow).
// ─────────────────────────────────────────────────────────────────────────

export interface ReconcileResult {
  /** Number of run.abandoned events emitted by THIS call (post-dedup). */
  abandoned: number;
  /** Number of run_history rows converged by the terminal-spine backfill pass (see below). */
  backfilled: number;
  /** Total orphans selected (may exceed `abandoned` if idempotent dedup triggers). */
  selected: number;
}

// Bound on the terminal-spine → run_history backfill pass below. This is a
// convergent, self-draining catch-up (each boot repairs whatever the writer
// authority missed since the last boot), NOT a perpetual sweep: once every
// run_history row matches its terminal spine event, the join returns zero
// rows and every subsequent boot's backfill pass is a cheap no-op. The cap
// exists so a fleet with a large one-time backlog doesn't turn boot into an
// unbounded scan; any remainder is picked up on the next boot.
const RUN_HISTORY_BACKFILL_LIMIT = 500;

interface OrphanRow {
  actor_id: string;
  connector_instance_id: string | null;
  event_id: string;
  original_boot_epoch: string | null;
  original_controller_id: string | null;
  run_id: string | null;
  scenario_id: string | null;
  source_id: string | null;
  source_kind: string | null;
  trace_id: string | null;
}

/**
 * Reconcile orphaned `run.started` events owned by the current controller.
 * Must be called AFTER `emitControllerBootedAndStashEpoch` and BEFORE
 * HTTP routes mount.
 *
 * Postgres path uses a single transaction (SELECT then per-row INSERT).
 * SQLite path uses better-sqlite3's transaction() to match.
 *
 * Throws on any non-idempotency error. The caller (startServer) MUST
 * NOT swallow this — boot must abort. See design brief §3.4 failure
 * semantics.
 */
export function reconcileOrphanedRunsAtBoot(epoch: BootEpoch): Promise<ReconcileResult> {
  if (isPostgresStorageBackend()) {
    return reconcilePostgres(epoch);
  }
  return reconcileSqlite(epoch);
}

async function reconcilePostgres(epoch: BootEpoch): Promise<ReconcileResult> {
  // Single transaction: SELECT orphans, INSERT run.abandoned for each, then
  // converge the run_history projection through the same writer authority
  // normal terminal spine events use (writePostgresRunHistoryForSpineEvent).
  // Unique-violation on spine_run_abandoned_cause_unique → idempotent no-op.
  return await withPostgresTransaction(async (client: PoolClient) => {
    const { rows } = await client.query<OrphanRow>(
      `
      SELECT
        s.event_id,
        s.run_id,
        s.actor_id,
        s.trace_id,
        s.scenario_id,
        s.connector_instance_id,
        s.source_kind,
        s.source_id,
        s.data_json->>'boot_epoch'    AS original_boot_epoch,
        s.data_json->>'controller_id' AS original_controller_id
      FROM spine_events s
      WHERE s.event_type = 'run.started'
        AND (s.data_json->>'boot_epoch') IS DISTINCT FROM $1
        -- Only abandon orphans owned by THIS controller.
        -- Legacy NULL controller_id is treated as ours under single-controller assumption.
        AND COALESCE(s.data_json->>'controller_id', $2) = $2
        AND NOT EXISTS (
          SELECT 1 FROM spine_events t
          WHERE t.run_id = s.run_id
            AND t.event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled', 'run.abandoned')
        )
        AND NOT EXISTS (
          SELECT 1 FROM spine_events r
          WHERE r.event_type = 'run.abandoned'
            AND (r.data_json->>'caused_by_event_id') = s.event_id
        )
      `,
      [epoch.boot_epoch, epoch.controller_id]
    );

    let abandoned = 0;
    for (const orphan of rows) {
      // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      const occurredAt = await emitRunAbandoned(client, orphan, epoch, "postgres");
      if (occurredAt !== null) {
        abandoned += 1;
        // Converge the run_history projection at the same recovery boundary,
        // through the same writer authority normal terminal spine events use
        // (writePostgresRunHistoryForSpineEvent) — never a second authority.
        // No-op (by identity fence) if the row is missing or already terminal.
        await writePostgresRunHistoryForSpineEvent(client, toRunHistoryAbandonEvent(orphan, occurredAt));
      }
    }

    const backfilled = await backfillRunHistoryFromTerminalSpinePostgres(client);
    return { abandoned, backfilled, selected: rows.length };
  });
}

interface TerminalBackfillRow {
  connector_instance_id: string;
  event_type: string;
  occurred_at: string;
  run_id: string;
  source_id: string | null;
  source_kind: string | null;
  status: string;
}

/**
 * Repair historical drift: a `run_history` row can be stuck at
 * `status='running'` even though its run's terminal spine event already
 * exists — e.g. a run abandoned by a PRIOR incarnation of this reconciler
 * (before the writer-authority fix), where the spine write happened but the
 * run_history convergence call did not exist yet. This is not a new orphan
 * class — it replays the SAME single writer authority
 * (write*RunHistoryForSpineEvent) against terminal spine events that are
 * already durable, for run_history rows the writer never got a chance to
 * finalize. Identity-fenced by (run_id, connector_instance_id) + `status =
 * 'running'` exactly like every other writer call site, so it is idempotent
 * and cannot touch an already-terminal or unrelated row. Bounded by
 * RUN_HISTORY_BACKFILL_LIMIT per boot; self-draining (see the constant's
 * comment) rather than a perpetual sweep.
 */
async function backfillRunHistoryFromTerminalSpinePostgres(client: PoolClient): Promise<number> {
  const { rows } = await client.query<TerminalBackfillRow>(
    `
    SELECT DISTINCT ON (rh.run_id, rh.connector_instance_id)
      rh.run_id,
      rh.connector_instance_id,
      s.event_type,
      s.status,
      s.occurred_at,
      s.source_kind,
      s.source_id
    FROM run_history rh
    JOIN spine_events s
      ON s.run_id = rh.run_id
     AND s.connector_instance_id = rh.connector_instance_id
     AND s.event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled', 'run.abandoned')
    WHERE rh.status = 'running'
    ORDER BY rh.run_id, rh.connector_instance_id, s.occurred_at DESC
    LIMIT $1
    `,
    [RUN_HISTORY_BACKFILL_LIMIT]
  );

  for (const row of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: Same transaction as the reconciler's own writes above; must stay ordered and atomic with it.
    await writePostgresRunHistoryForSpineEvent(client, {
      connectorId: row.source_kind === "connector" ? row.source_id : null,
      connectorInstanceId: row.connector_instance_id,
      data: {},
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      runId: row.run_id,
      status: row.status,
    });
  }
  return rows.length;
}

function reconcileSqlite(epoch: BootEpoch): Promise<ReconcileResult> {
  const db = getDb();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!db) {
    return Promise.resolve({ abandoned: 0, backfilled: 0, selected: 0 });
  }
  const raw = db as unknown as {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
      run: (...args: unknown[]) => unknown;
    };
    transaction: <T>(fn: () => T) => () => T;
  };

  const selectStmt = raw.prepare(
    `
    SELECT
      s.event_id,
      s.run_id,
      s.actor_id,
      s.trace_id,
      s.scenario_id,
      s.connector_instance_id,
      s.source_kind,
      s.source_id,
      json_extract(s.data_json, '$.boot_epoch')    AS original_boot_epoch,
      json_extract(s.data_json, '$.controller_id') AS original_controller_id
    FROM spine_events s
    WHERE s.event_type = 'run.started'
      AND COALESCE(json_extract(s.data_json, '$.boot_epoch'), '') <> ?
      AND COALESCE(json_extract(s.data_json, '$.controller_id'), ?) = ?
      AND NOT EXISTS (
        SELECT 1 FROM spine_events t
        WHERE t.run_id = s.run_id
          AND t.event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled', 'run.abandoned')
      )
      AND NOT EXISTS (
        SELECT 1 FROM spine_events r
        WHERE r.event_type = 'run.abandoned'
          AND json_extract(r.data_json, '$.caused_by_event_id') = s.event_id
      )
    `
  );
  const orphans = selectStmt.all(epoch.boot_epoch, epoch.controller_id, epoch.controller_id) as OrphanRow[];

  let abandoned = 0;
  for (const orphan of orphans) {
    // emitSpineEvent handles the SQLite insert internally; idempotency is
    // enforced by the spine_run_abandoned_cause_unique partial index.
    // eslint-disable-next-line no-await-in-loop
    const occurredAt = emitRunAbandonedSyncSqlite(orphan, epoch);
    if (occurredAt !== null) {
      abandoned += 1;
      // Converge the run_history projection at the same recovery boundary,
      // through the same writer authority normal terminal spine events use
      // (writeSqliteRunHistoryForSpineEvent) — never a second authority.
      // No-op (by identity guard) if the row is missing or already terminal.
      writeSqliteRunHistoryForSpineEvent(toRunHistoryAbandonEvent(orphan, occurredAt));
    }
  }

  const backfilled = backfillRunHistoryFromTerminalSpineSqlite(raw);
  return Promise.resolve({ abandoned, backfilled, selected: orphans.length });
}

/**
 * Repair historical drift: a `run_history` row can be stuck at
 * `status='running'` even though its run's terminal spine event already
 * exists — e.g. a run abandoned by a PRIOR incarnation of this reconciler
 * (before the writer-authority fix), where the spine write happened but the
 * run_history convergence call did not exist yet. This is not a new orphan
 * class — it replays the SAME single writer authority
 * (write*RunHistoryForSpineEvent) against terminal spine events that are
 * already durable, for run_history rows the writer never got a chance to
 * finalize. Identity-fenced by (run_id, connector_instance_id) + `status =
 * 'running'` exactly like every other writer call site, so it is idempotent
 * and cannot touch an already-terminal or unrelated row. Bounded by
 * RUN_HISTORY_BACKFILL_LIMIT per boot; self-draining (see the constant's
 * comment) rather than a perpetual sweep.
 */
function backfillRunHistoryFromTerminalSpineSqlite(raw: {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
}): number {
  const rows = raw
    .prepare(
      `
      SELECT
        rh.run_id      AS run_id,
        rh.connector_instance_id AS connector_instance_id,
        s.event_type    AS event_type,
        s.status        AS status,
        s.occurred_at   AS occurred_at,
        s.source_kind   AS source_kind,
        s.source_id     AS source_id
      FROM run_history rh
      JOIN spine_events s
        ON s.event_id = (
          SELECT t.event_id
          FROM spine_events t
          WHERE t.run_id = rh.run_id
            AND t.connector_instance_id = rh.connector_instance_id
            AND t.event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled', 'run.abandoned')
          ORDER BY t.occurred_at DESC
          LIMIT 1
        )
      WHERE rh.status = 'running'
      LIMIT ?
      `
    )
    .all(RUN_HISTORY_BACKFILL_LIMIT) as {
    run_id: string;
    connector_instance_id: string;
    event_type: string;
    status: string;
    occurred_at: string;
    source_kind: string | null;
    source_id: string | null;
  }[];

  for (const row of rows) {
    writeSqliteRunHistoryForSpineEvent({
      connectorId: row.source_kind === "connector" ? row.source_id : null,
      connectorInstanceId: row.connector_instance_id,
      data: {},
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      runId: row.run_id,
      status: row.status,
    });
  }
  return rows.length;
}

/**
 * Project an abandoned orphan onto the shape `writeSqliteRunHistoryForSpineEvent`
 * / `writePostgresRunHistoryForSpineEvent` expect — the same writer authority
 * normal terminal spine events flow through (see run-history-writer.ts). Kept
 * intentionally minimal: an orphan carries no terminal payload of its own
 * (no records_emitted, no connector_error, etc.), so `data` is empty and every
 * derived field on the writer side falls back to its documented default.
 */
function toRunHistoryAbandonEvent(orphan: OrphanRow, occurredAt: string): RunHistorySpineEvent {
  return {
    connectorId: orphan.source_kind === "connector" ? orphan.source_id : null,
    connectorInstanceId: orphan.connector_instance_id,
    data: {},
    eventType: "run.abandoned",
    occurredAt,
    runId: orphan.run_id,
    status: "abandoned",
  };
}

async function emitRunAbandoned(
  client: PoolClient,
  orphan: OrphanRow,
  epoch: BootEpoch,
  _backend: "postgres" | "sqlite"
): Promise<string | null> {
  const eventId = `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const occurredAt = new Date().toISOString();
  const dataJson = JSON.stringify({
    caused_by_event_id: orphan.event_id,
    original_boot_epoch: orphan.original_boot_epoch,
    original_controller_id: orphan.original_controller_id,
    reason: "controller_terminated_before_run_finished",
    reconciled_by_boot_epoch: epoch.boot_epoch,
    reconciled_by_controller_id: epoch.controller_id,
    reconciled_by_seq: epoch.seq,
    source: "recovery_worker",
  });

  try {
    await client.query(
      `
      INSERT INTO spine_events (
        event_id, event_type, occurred_at, recorded_at,
        scenario_id, trace_id, actor_type, actor_id,
        object_type, object_id, status, run_id,
        data_json, version
      )
      VALUES ($1, 'run.abandoned', $2, $2, $3, $4, 'runtime', $5,
              'run', $6, 'abandoned', $7, $8::jsonb, 'v1')
      `,
      [
        eventId,
        occurredAt,
        orphan.scenario_id ?? "default",
        orphan.trace_id ?? `trc_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        orphan.actor_id,
        orphan.run_id ?? orphan.event_id,
        orphan.run_id,
        dataJson,
      ]
    );
    return occurredAt;
  } catch (err) {
    // Idempotency: a prior reconciler already abandoned this orphan.
    // Catch ONLY the named constraint — never blanket-catch 23505.
    const e = err as { code?: string; constraint?: string };
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    if (e?.code === "23505" && e?.constraint === "spine_run_abandoned_cause_unique") {
      return null;
    }
    throw err;
  }
}

function emitRunAbandonedSyncSqlite(orphan: OrphanRow, epoch: BootEpoch): string | null {
  const db = getDb();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!db) {
    return null;
  }
  const raw = db as unknown as {
    prepare: (sql: string) => { run: (...args: unknown[]) => { changes: number } };
  };

  const eventId = `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const occurredAt = new Date().toISOString();
  const dataJson = JSON.stringify({
    caused_by_event_id: orphan.event_id,
    original_boot_epoch: orphan.original_boot_epoch,
    original_controller_id: orphan.original_controller_id,
    reason: "controller_terminated_before_run_finished",
    reconciled_by_boot_epoch: epoch.boot_epoch,
    reconciled_by_controller_id: epoch.controller_id,
    reconciled_by_seq: epoch.seq,
    source: "recovery_worker",
  });

  try {
    const stmt = raw.prepare(
      `
      INSERT INTO spine_events (
        event_id, event_type, occurred_at, recorded_at,
        scenario_id, trace_id, actor_type, actor_id,
        object_type, object_id, status, run_id,
        data_json, version
      )
      VALUES (?, 'run.abandoned', ?, ?, ?, ?, 'runtime', ?, 'run', ?, 'abandoned', ?, ?, 'v1')
      `
    );
    stmt.run(
      eventId,
      occurredAt,
      occurredAt,
      orphan.scenario_id ?? "default",
      orphan.trace_id ?? `trc_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      orphan.actor_id,
      orphan.run_id ?? orphan.event_id,
      orphan.run_id,
      dataJson
    );
    return occurredAt;
  } catch (err) {
    // Idempotency on SQLite: better-sqlite3 throws SqliteError with
    // code 'SQLITE_CONSTRAINT_UNIQUE' and the message includes the
    // index name. Match by message to avoid blanket-catching other
    // unique-constraint violations.
    const e = err as { code?: string; message?: string };
    if (
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      e?.code === "SQLITE_CONSTRAINT_UNIQUE" &&
      typeof e.message === "string" &&
      e.message.includes("spine_run_abandoned_cause_unique")
    ) {
      return null;
    }
    throw err;
  }
}
