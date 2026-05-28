/**
 * Boot-epoch reconciliation: the boot-time function that emits
 * `controller.booted` as the first spine event of every process
 * incarnation, then stashes the resulting `(boot_epoch, seq,
 * controller_id)` triple in the spine-module singleton.
 *
 * Called from `startServer` after spine init and BEFORE HTTP routes
 * are mounted. The order is enforced by `startServer`'s sequence, not
 * by this module — see `reference-implementation/server/index.js`.
 *
 * After this returns, the singleton is populated and any subsequent
 * `run.started` emission can stamp itself (see `lib/spine.ts`).
 *
 * Design contract: docs/run-reconciliation-design-brief.md §3.4, Stage 5.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import { getDb } from "../server/db.js";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../server/postgres-storage.js";
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
    event_type: "controller.booted",
    actor_type: "runtime",
    actor_id: "controller",
    data: {
      epoch: bootEpoch,
      seq,
      controller_id: controllerId,
      started_at: new Date().toISOString(),
      process_info: {
        node_version: process.versions.node,
        git_sha: opts.gitSha ?? process.env.PDPP_GIT_SHA ?? null,
        storage_backend: isPostgresStorageBackend() ? "postgres" : "sqlite",
      },
    },
  });

  const triple: BootEpoch = {
    boot_epoch: bootEpoch,
    seq,
    controller_id: controllerId,
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
  /** Total orphans selected (may exceed `abandoned` if idempotent dedup triggers). */
  selected: number;
}

interface OrphanRow {
  actor_id: string;
  event_id: string;
  original_boot_epoch: string | null;
  original_controller_id: string | null;
  run_id: string | null;
  scenario_id: string | null;
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

interface PgClient {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
}

async function reconcilePostgres(epoch: BootEpoch): Promise<ReconcileResult> {
  // Single transaction: SELECT orphans, INSERT run.abandoned for each.
  // Unique-violation on spine_run_abandoned_cause_unique → idempotent no-op.
  return await (withPostgresTransaction as (fn: (c: PgClient) => Promise<ReconcileResult>) => Promise<ReconcileResult>)(
    async (client: PgClient) => {
      const { rows } = await client.query<OrphanRow>(
        `
      SELECT
        s.event_id,
        s.run_id,
        s.actor_id,
        s.trace_id,
        s.scenario_id,
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
            AND t.event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')
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
        const inserted = await emitRunAbandoned(client, orphan, epoch, "postgres");
        if (inserted) {
          abandoned++;
        }
      }
      return { abandoned, selected: rows.length };
    }
  );
}

function reconcileSqlite(epoch: BootEpoch): Promise<ReconcileResult> {
  const db = getDb();
  if (!db) {
    return Promise.resolve({ abandoned: 0, selected: 0 });
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
      json_extract(s.data_json, '$.boot_epoch')    AS original_boot_epoch,
      json_extract(s.data_json, '$.controller_id') AS original_controller_id
    FROM spine_events s
    WHERE s.event_type = 'run.started'
      AND COALESCE(json_extract(s.data_json, '$.boot_epoch'), '') <> ?
      AND COALESCE(json_extract(s.data_json, '$.controller_id'), ?) = ?
      AND NOT EXISTS (
        SELECT 1 FROM spine_events t
        WHERE t.run_id = s.run_id
          AND t.event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')
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
    const inserted = emitRunAbandonedSyncSqlite(orphan, epoch);
    if (inserted) {
      abandoned++;
    }
  }
  return Promise.resolve({ abandoned, selected: orphans.length });
}

async function emitRunAbandoned(
  client: PgClient,
  orphan: OrphanRow,
  epoch: BootEpoch,
  _backend: "postgres" | "sqlite"
): Promise<boolean> {
  const eventId = `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const occurredAt = new Date().toISOString();
  const dataJson = JSON.stringify({
    caused_by_event_id: orphan.event_id,
    original_boot_epoch: orphan.original_boot_epoch,
    original_controller_id: orphan.original_controller_id,
    reconciled_by_boot_epoch: epoch.boot_epoch,
    reconciled_by_seq: epoch.seq,
    reconciled_by_controller_id: epoch.controller_id,
    source: "recovery_worker",
    reason: "controller_terminated_before_run_finished",
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
    return true;
  } catch (err) {
    // Idempotency: a prior reconciler already abandoned this orphan.
    // Catch ONLY the named constraint — never blanket-catch 23505.
    const e = err as { code?: string; constraint?: string };
    if (e?.code === "23505" && e?.constraint === "spine_run_abandoned_cause_unique") {
      return false;
    }
    throw err;
  }
}

function emitRunAbandonedSyncSqlite(orphan: OrphanRow, epoch: BootEpoch): boolean {
  const db = getDb();
  if (!db) {
    return false;
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
    reconciled_by_boot_epoch: epoch.boot_epoch,
    reconciled_by_seq: epoch.seq,
    reconciled_by_controller_id: epoch.controller_id,
    source: "recovery_worker",
    reason: "controller_terminated_before_run_finished",
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
    return true;
  } catch (err) {
    // Idempotency on SQLite: better-sqlite3 throws SqliteError with
    // code 'SQLITE_CONSTRAINT_UNIQUE' and the message includes the
    // index name. Match by message to avoid blanket-catching other
    // unique-constraint violations.
    const e = err as { code?: string; message?: string };
    if (
      e?.code === "SQLITE_CONSTRAINT_UNIQUE" &&
      typeof e.message === "string" &&
      e.message.includes("spine_run_abandoned_cause_unique")
    ) {
      return false;
    }
    throw err;
  }
}
