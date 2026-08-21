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
import { getDb } from "../server/db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../server/postgres-storage.ts";
import { type BootEpoch, emitSpineEvent, setCurrentBootEpoch } from "./spine.ts";

export interface BootControllerOpts {
  /** Override for testing; defaults to randomUUID. */
  bootEpoch?: string;
  /**
   * Override for testing; otherwise resolved from `PDPP_CONTROLLER_ID`, then
   * from the durable `controller_identity` row (seeded from the hostname on
   * first boot). See `resolveControllerId`.
   */
  controllerId?: string;
  /** Process fingerprint fields. */
  gitSha?: string | null;
}

/**
 * The single row id in `controller_identity`. The table holds one row for
 * the whole deployment; the constant keeps that intent in the SQL.
 */
const CONTROLLER_IDENTITY_ROW_ID = "singleton";

/**
 * Resolve the identity this deployment uses to claim and adjudicate runs.
 *
 * Precedence, and the reason for each step:
 *
 *  1. An explicit `opts.controllerId` — tests and multi-controller callers
 *     that must pin an identity.
 *  2. `PDPP_CONTROLLER_ID` — the operator override. Kept first among the
 *     durable options so a genuine multi-controller deployment can still
 *     partition ownership without touching the database.
 *  3. The `controller_identity` row — the durable default. Written once, on
 *     the first boot that finds the table empty, then read back unchanged
 *     forever.
 *
 * Step 3 is the fix for the production defect. The previous fallback was
 * `os.hostname()`, which under Docker is the container ID and is therefore
 * fresh on every `docker run`. Because the boot reconciler only adjudicates
 * orphans whose `controller_id` matches its own, a hostname identity meant
 * every container replacement started with an empty claim: 121 production
 * runs from 106 distinct controller ids were left permanently non-terminal.
 *
 * `os.hostname()` survives only as the seed for the first row, never as the
 * live answer. That keeps a fresh deployment's identity readable to a human
 * without making process-lifetime the identity's lifetime.
 */
async function resolveControllerId(opts: BootControllerOpts): Promise<string> {
  if (opts.controllerId && opts.controllerId.length > 0) {
    return opts.controllerId;
  }
  const fromEnv = process.env.PDPP_CONTROLLER_ID;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return await loadOrCreateDurableControllerId();
}

/**
 * Read the persisted controller identity, seeding it on first boot.
 *
 * The seed is `os.hostname()` so a fresh deployment gets a human-readable
 * id; what matters is that it is written down once rather than recomputed
 * per process.
 *
 * The INSERT is conditional on the row's absence and the value is re-read
 * after writing, so two processes racing a first boot converge on whichever
 * row landed rather than each trusting its own seed.
 *
 * If no database is available (SQLite tests that never open one), this falls
 * back to the hostname. That path cannot strand orphans because without a
 * database there is no spine to strand them in.
 */
async function loadOrCreateDurableControllerId(): Promise<string> {
  const seed = os.hostname();

  if (isPostgresStorageBackend()) {
    const existing = await postgresQuery<{ controller_id: string }>(
      "SELECT controller_id FROM controller_identity WHERE id = $1",
      [CONTROLLER_IDENTITY_ROW_ID]
    );
    const found = existing.rows[0]?.controller_id;
    if (found) {
      return found;
    }
    await postgresQuery(
      `INSERT INTO controller_identity (id, controller_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [CONTROLLER_IDENTITY_ROW_ID, seed, new Date().toISOString()]
    );
    // Re-read rather than assume the seed won: a concurrent first boot may
    // have inserted its own, and both processes must agree on one identity.
    const settled = await postgresQuery<{ controller_id: string }>(
      "SELECT controller_id FROM controller_identity WHERE id = $1",
      [CONTROLLER_IDENTITY_ROW_ID]
    );
    return settled.rows[0]?.controller_id ?? seed;
  }

  const db = getDb();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!db) {
    return seed;
  }
  const raw = db as unknown as {
    prepare: (sql: string) => {
      get: (...args: unknown[]) => { controller_id: string } | undefined;
      run: (...args: unknown[]) => unknown;
    };
  };
  const found = raw
    .prepare("SELECT controller_id FROM controller_identity WHERE id = ?")
    .get(CONTROLLER_IDENTITY_ROW_ID)?.controller_id;
  if (found) {
    return found;
  }
  raw
    .prepare(
      `INSERT INTO controller_identity (id, controller_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT (id) DO NOTHING`
    )
    .run(CONTROLLER_IDENTITY_ROW_ID, seed, new Date().toISOString());
  return (
    raw.prepare("SELECT controller_id FROM controller_identity WHERE id = ?").get(CONTROLLER_IDENTITY_ROW_ID)
      ?.controller_id ?? seed
  );
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
  const controllerId = await resolveControllerId(opts);
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
  /**
   * Number of `run_history` rows still claiming `running` against an
   * already-terminal spine that this call re-projected. Distinct from
   * `abandoned`: these runs were already terminalised in the event log,
   * only their durable projection had drifted.
   */
  repaired: number;
  /** Total orphans selected (may exceed `abandoned` if idempotent dedup triggers). */
  selected: number;
}

/**
 * The typed terminal reason for a run whose controller died mid-flight.
 * Written to both the spine event's `data_json.reason` and the projected
 * `run_history.terminal_reason`, so the durable projection and the event
 * log give the same account of why the run ended.
 */
const ABANDONED_AT_BOOT_REASON = "controller_terminated_before_run_finished";
/**
 * The typed terminal reason for the subset of those runs that died while
 * BLOCKED ON A PENDING OWNER INTERACTION — the connector had asked the owner
 * for input (an OTP, a security code) and was still waiting when the
 * controller died.
 *
 * This is a distinct reason because the owner has already paid a real-world
 * cost by the time it happens: an OTP is single-use and is delivered out of
 * band to a real phone. "We asked you for a code and then crashed" is a
 * materially different account from "the run was cut short", and only the
 * former tells the owner why a code they were sent became useless.
 *
 * It does NOT imply the interaction is recoverable. The owner's answer is
 * delivered over the connector child's stdin to a live browser session that
 * holds the authenticated pre-OTP page state, and that child is SIGTERMed by
 * the runtime's `process.on('exit')` sweep when the controller dies. The
 * session cannot outlive the process, so a successor cannot reattach and the
 * next attempt necessarily costs a fresh code. This reason reports that
 * honestly rather than implying a resumable state that does not exist.
 */
const ABANDONED_AWAITING_INTERACTION_REASON = "controller_terminated_while_awaiting_owner_interaction";
/** Matches the status `run-history-writer.ts` derives for `run.abandoned`. */
const ABANDONED_RUN_HISTORY_STATUS = "abandoned";

/**
 * Picks the honest terminal reason for one orphan. A run counts as
 * interaction-blocked only when its last interaction lifecycle event was a
 * REQUEST that never reached a terminal interaction event — i.e. the owner
 * was genuinely still being waited on at the moment the controller died.
 */
function terminalReasonFor(orphan: OrphanRow): string {
  return orphan.awaiting_interaction ? ABANDONED_AWAITING_INTERACTION_REASON : ABANDONED_AT_BOOT_REASON;
}

interface OrphanRow {
  actor_id: string;
  /**
   * True when this run had an interaction request outstanding at the moment
   * the controller died: at least one `run.interaction_required` /
   * `run.assistance_requested` event whose `interaction_id` never reached a
   * terminal interaction event. Selected in SQL (rather than derived later)
   * so both backends answer the question from the same spine facts.
   *
   * `1`/`0` from SQLite, boolean from Postgres; normalized by `readOrphanRows`.
   */
  awaiting_interaction: boolean;
  /**
   * The abandoned run's connection. Carried from the `run.started` event so
   * the `run_history` projection can be fenced by the real run identity —
   * the pair (run_id, connector_instance_id), since run_id alone is not
   * unique across connections (see stores/run-history-writer.ts).
   */
  connector_instance_id: string | null;
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
        s.connector_instance_id,
        s.data_json->>'boot_epoch'    AS original_boot_epoch,
        s.data_json->>'controller_id' AS original_controller_id,
        -- Was the owner still being waited on when the controller died?
        -- True iff some interaction was REQUESTED for this run and that same
        -- interaction_id never reached a terminal interaction event.
        EXISTS (
          SELECT 1 FROM spine_events q
          WHERE q.run_id = s.run_id
            AND q.event_type IN ('run.interaction_required', 'run.assistance_requested')
            AND q.interaction_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM spine_events d
              WHERE d.interaction_id = q.interaction_id
                AND d.event_type IN (
                  'run.interaction_completed', 'run.assistance_resolved',
                  'run.assistance_cancelled', 'run.assistance_timed_out'
                )
            )
        ) AS awaiting_interaction
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
        const inserted = await emitRunAbandoned(client, orphan, epoch, "postgres");
        if (inserted) {
          abandoned += 1;
        }
      }
      const repaired = await repairTerminalRunHistoryDriftPostgres(client);
      return { abandoned, repaired, selected: rows.length };
    }
  );
}

function reconcileSqlite(epoch: BootEpoch): Promise<ReconcileResult> {
  const db = getDb();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!db) {
    return Promise.resolve({ abandoned: 0, repaired: 0, selected: 0 });
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
      json_extract(s.data_json, '$.boot_epoch')    AS original_boot_epoch,
      json_extract(s.data_json, '$.controller_id') AS original_controller_id,
      -- Mirrors the Postgres EXISTS above: an interaction was requested for
      -- this run and never reached a terminal interaction event.
      EXISTS (
        SELECT 1 FROM spine_events q
        WHERE q.run_id = s.run_id
          AND q.event_type IN ('run.interaction_required', 'run.assistance_requested')
          AND q.interaction_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM spine_events d
            WHERE d.interaction_id = q.interaction_id
              AND d.event_type IN (
                'run.interaction_completed', 'run.assistance_resolved',
                'run.assistance_cancelled', 'run.assistance_timed_out'
              )
          )
      ) AS awaiting_interaction
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
  // SQLite has no boolean type: EXISTS(...) yields 1/0, so normalize to the
  // boolean `OrphanRow.awaiting_interaction` declares before any consumer
  // reads it. (`0` is falsy in JS, but relying on that would leave the row
  // shape lying about its own type.)
  const orphans = (
    selectStmt.all(epoch.boot_epoch, epoch.controller_id, epoch.controller_id) as (Omit<
      OrphanRow,
      "awaiting_interaction"
    > & {
      awaiting_interaction: unknown;
    })[]
  ).map((row) => ({ ...row, awaiting_interaction: Boolean(row.awaiting_interaction) }));

  let abandoned = 0;
  for (const orphan of orphans) {
    // The raw INSERT below carries its own idempotency via the
    // spine_run_abandoned_cause_unique partial index.
    // eslint-disable-next-line no-await-in-loop
    const inserted = emitRunAbandonedSyncSqlite(orphan, epoch);
    if (inserted) {
      abandoned += 1;
    }
  }
  const repaired = repairTerminalRunHistoryDriftSqlite();
  return Promise.resolve({ abandoned, repaired, selected: orphans.length });
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
    reason: terminalReasonFor(orphan),
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
    await projectAbandonedRunHistoryPostgres(client, orphan, occurredAt);
    return true;
  } catch (err) {
    // Idempotency: a prior reconciler already abandoned this orphan.
    // Catch ONLY the named constraint — never blanket-catch 23505.
    const e = err as { code?: string; constraint?: string };
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    if (e?.code === "23505" && e?.constraint === "spine_run_abandoned_cause_unique") {
      return false;
    }
    throw err;
  }
}

function emitRunAbandonedSyncSqlite(orphan: OrphanRow, epoch: BootEpoch): boolean {
  const db = getDb();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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
    reason: terminalReasonFor(orphan),
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
    projectAbandonedRunHistorySqlite(orphan, occurredAt);
    return true;
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
      return false;
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Project the abandon onto `run_history`.
//
// The two emitters above INSERT into `spine_events` directly rather than
// going through `emitSpineEvent`, because they need the named-constraint
// idempotency the raw INSERT gives them. But `run_history` is written
// ONLY from inside `emitSpineEvent` (lib/spine.ts) — so those raw INSERTs
// terminalise the event log while leaving the durable projection saying
// `running` forever. A row stuck that way is not cosmetic: `getActiveRun`
// reads it, so the connection is refused a new run with 409
// `active_run_exists` and its coverage checkpoint never leaves
// not_staged/not_committed.
//
// These helpers close that gap on the same transaction as the INSERT, so
// the event and its projection commit together or not at all.
//
// `records_emitted` is deliberately NOT written. The generic writer's
// finalize overwrites it from the terminal event's own payload, which for
// an abandon is zero — that would revise a run's committed yield down to
// nothing. Per the RI-owner ruling, records validly collected before the
// controller died stay committed, so the column is left untouched.
//
// The UPDATE is fenced `AND status = 'running'`, which makes it both
// idempotent (a re-run finds nothing to change) and safe against
// finalizing a run some other path already terminalised. The
// `connector_instance_id` fence is load-bearing for the same reason it is
// on the generic writer: run_id alone is not unique across connections.
// ─────────────────────────────────────────────────────────────────────────

async function projectAbandonedRunHistoryPostgres(client: PgClient, orphan: OrphanRow, at: string): Promise<void> {
  if (!(orphan.run_id && orphan.connector_instance_id)) {
    // No connection identity on the started event means no row can be
    // matched without guessing. Leave it rather than fence on run_id alone.
    return;
  }
  await client.query(
    `UPDATE run_history
     SET status = $1,
         completed_at = $2,
         terminal_reason = $3
     WHERE run_id = $4
       AND connector_instance_id = $5
       AND status = 'running'`,
    [ABANDONED_RUN_HISTORY_STATUS, at, terminalReasonFor(orphan), orphan.run_id, orphan.connector_instance_id]
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Repair projection drift against an ALREADY-terminal spine.
//
// The orphan SELECT above deliberately skips any run that already has a
// terminal event, so it can never heal a run whose spine is terminal but
// whose `run_history` row still says `running`. That combination is not
// hypothetical — it is what every raw-INSERT abandon written before this
// module projected its own writes left behind, and any future writer that
// reaches `spine_events` without going through `emitSpineEvent` will
// reproduce it.
//
// So rather than encode "runs this reconciler happens to know about", this
// states the invariant directly: a run_history row must not claim
// `running` when the spine says the run ended. The terminal event is the
// authority; the projection is repaired to match it, adopting that event's
// own status/reason/timestamp rather than inventing a second vocabulary.
//
// Deliberately NOT time-based. A lease/heartbeat would answer "has this
// run been quiet too long?", which is a guess that needs a threshold and
// can be wrong in both directions — killing a slow-but-live run, or
// waiting out the window before freeing a run that is already provably
// dead. Here there is a durable fact (the terminal event) that settles it
// exactly, so this reads that fact. `server/heartbeat-lease.ts` was
// considered and is the wrong primitive twice over: it is presentation-only
// (it derives what to *display* and writes nothing), and it answers the
// device-collector liveness question, not run terminality.
//
// `records_emitted` is left untouched for the same reason as above:
// records validly committed before the run died stay committed.
// ─────────────────────────────────────────────────────────────────────────

/** The spine's canonical terminal set, as SQL literals for the drift query. */
const TERMINAL_EVENT_TYPES_SQL =
  "'run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled', 'run.abandoned'";

/**
 * Map a terminal event type to the `run_history.status` the generic writer
 * would have derived for it (stores/run-history-writer.ts `toTerminalStatus`),
 * so a repaired row is indistinguishable from one the writer finalized.
 */
function terminalStatusForEventType(eventType: string, eventStatus: string | null): string {
  if (eventType === "run.completed") {
    return eventStatus || "succeeded";
  }
  if (eventType === "run.cancelled") {
    return "cancelled";
  }
  if (eventType === "run.abandoned") {
    return ABANDONED_RUN_HISTORY_STATUS;
  }
  if (eventType === "run.browser_surface_failed") {
    return eventStatus || "surface_failed";
  }
  return "failed";
}

interface DriftedRunRow {
  connector_instance_id: string;
  event_status: string | null;
  event_type: string;
  occurred_at: string;
  reason: string | null;
  run_id: string;
}

function repairTerminalRunHistoryDriftSqlite(): number {
  const db = getDb();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!db) {
    return 0;
  }
  const raw = db as unknown as {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
      run: (...args: unknown[]) => { changes: number };
    };
  };

  // One terminal event per drifted row — the EARLIEST, so the recorded
  // completion is when the run actually ended rather than whichever
  // duplicate terminal event sorted last.
  const drifted = raw
    .prepare(
      `
      SELECT
        h.run_id,
        h.connector_instance_id,
        t.event_type,
        t.status AS event_status,
        t.occurred_at,
        json_extract(t.data_json, '$.reason') AS reason
      FROM run_history h
      JOIN spine_events t
        ON t.run_id = h.run_id
       AND t.event_type IN (${TERMINAL_EVENT_TYPES_SQL})
      WHERE h.status = 'running'
        AND h.run_id IS NOT NULL
        AND h.connector_instance_id IS NOT NULL
        AND t.occurred_at = (
          SELECT MIN(t2.occurred_at) FROM spine_events t2
          WHERE t2.run_id = h.run_id
            AND t2.event_type IN (${TERMINAL_EVENT_TYPES_SQL})
        )
      GROUP BY h.run_id, h.connector_instance_id
      `
    )
    .all() as DriftedRunRow[];

  const updateStmt = raw.prepare(
    `UPDATE run_history
     SET status = ?,
         completed_at = ?,
         terminal_reason = ?
     WHERE run_id = ?
       AND connector_instance_id = ?
       AND status = 'running'`
  );

  let repaired = 0;
  for (const row of drifted) {
    const result = updateStmt.run(
      terminalStatusForEventType(row.event_type, row.event_status),
      row.occurred_at,
      row.reason,
      row.run_id,
      row.connector_instance_id
    );
    repaired += result.changes;
  }
  return repaired;
}

async function repairTerminalRunHistoryDriftPostgres(client: PgClient): Promise<number> {
  // Set-based on Postgres: DISTINCT ON picks the earliest terminal event
  // per run, and the same `status = 'running'` fence keeps it idempotent.
  const { rowCount } = await client.query(
    `
    UPDATE run_history h
    SET status = CASE t.event_type
                   WHEN 'run.completed' THEN COALESCE(NULLIF(t.status, ''), 'succeeded')
                   WHEN 'run.cancelled' THEN 'cancelled'
                   WHEN 'run.abandoned' THEN '${ABANDONED_RUN_HISTORY_STATUS}'
                   WHEN 'run.browser_surface_failed' THEN COALESCE(NULLIF(t.status, ''), 'surface_failed')
                   ELSE 'failed'
                 END,
        completed_at = t.occurred_at,
        terminal_reason = t.data_json->>'reason'
    FROM (
      SELECT DISTINCT ON (run_id) run_id, event_type, status, occurred_at, data_json
      FROM spine_events
      WHERE event_type IN (${TERMINAL_EVENT_TYPES_SQL})
        AND run_id IS NOT NULL
      ORDER BY run_id, occurred_at ASC
    ) t
    WHERE h.run_id = t.run_id
      AND h.status = 'running'
      AND h.connector_instance_id IS NOT NULL
    `
  );
  return rowCount ?? 0;
}

function projectAbandonedRunHistorySqlite(orphan: OrphanRow, at: string): void {
  if (!(orphan.run_id && orphan.connector_instance_id)) {
    return;
  }
  const db = getDb();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!db) {
    return;
  }
  const raw = db as unknown as {
    prepare: (sql: string) => { run: (...args: unknown[]) => { changes: number } };
  };
  raw
    .prepare(
      `UPDATE run_history
       SET status = ?,
           completed_at = ?,
           terminal_reason = ?
       WHERE run_id = ?
         AND connector_instance_id = ?
         AND status = 'running'`
    )
    .run(ABANDONED_RUN_HISTORY_STATUS, at, terminalReasonFor(orphan), orphan.run_id, orphan.connector_instance_id);
}
