// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Closes the activation+schedule transition by construction: a draft
// connection whose first run genuinely authenticates and completes a pass
// over a required stream (see hasAuthenticatedRequiredStreamEvidence in
// connection-activation-schedules.ts) must never end up `active` with no
// schedule row — a silent state that would require a later manual run to
// notice and repair. `connector_instances` and `connector_schedules` are the
// SAME backend (one SQLite file, or one Postgres database), so both writes
// run inside ONE transaction: either both land, or neither does, and a
// connection that fails partway rolls back to its prior `draft` state to be
// retried on the very next authenticated run — never a stranded
// active-but-unscheduled row.
//
// Mirrors the exact composition pattern connector-instance-store.ts's own
// deleteConnection already uses for cross-table atomicity: SQLite via
// writeTransaction (one better-sqlite3 BEGIN IMMEDIATE), Postgres via
// withPostgresTransaction (one client, raw client.query calls) — because
// neither store module's createSchedule/updateStatus accepts an externally
// supplied transaction handle, the writes are inlined here against the same
// tables/columns those methods already use, rather than composed by nesting
// those higher-level methods.
//
// Idempotency (re-verified inside the SAME transaction, not just by the
// caller): the status flip is a conditional `WHERE status = 'draft'` UPDATE
// (a no-op on an already-active/paused/revoked row, matching activateDraft's
// existing contract exactly), and the schedule write only INSERTs when no
// row exists yet for this connector_instance_id — an owner-paused or
// custom-interval row already present is read but never touched.
//
// connector_summary_evidence dirty-mark parity: a genuine status flip also
// marks this connection's maintained summary evidence dirty/stale, using the
// SAME canonical statement and last_error wording connector-instance-store.ts's
// own updateStatus already uses on both backends — inside the SAME
// transaction as the status flip, so a rollback undoes the dirty-mark too.
// Both backends perform this write; a prior revision only wired it into the
// SQLite branch, which was a real Postgres parity gap (evidence stayed
// unmarked-dirty after a real Postgres activation), closed here.

import { exec, getOne, referenceQueries, writeTransaction } from "../lib/db.ts";
import {
  type ActivationRefreshContract,
  resolveActivationRefreshContract,
} from "./connection-activation-schedules.ts";
import { isPostgresStorageBackend, withPostgresTransaction } from "./postgres-storage.ts";

export interface AuthenticatedDraftActivationResult {
  /** Whether the draft row was flipped to active by THIS call (false when it was already non-draft). */
  readonly activated: boolean;
  readonly contract: ActivationRefreshContract;
  /** Whether a new schedule row was created by THIS call (false when one already existed, or the manifest is not automatic). */
  readonly scheduleAttached: boolean;
}

interface ConnectorInstanceRow extends Record<string, unknown> {
  readonly status: string;
}

interface ScheduleRow extends Record<string, unknown> {
  readonly connector_instance_id: string;
}

/**
 * Postgres transaction client shape (structurally typed to avoid importing
 * the pg PoolClient type here — matches connector-instance-store.ts's own
 * inline client typing for the same reason).
 */
interface TransactionClient {
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: Row[] }>;
}

/**
 * Deterministic, test-only interruption seam proving this module's atomicity
 * claim (mirrors ref-device-exporters.ts's __setEnrollPhaseFaultHookForTest
 * pattern exactly). Production never installs this hook. `"after_activate_
 * before_schedule"` fires AFTER the connector_instances write executes but
 * BEFORE the connector_schedules write — the exact partial-state window a
 * real mid-transaction failure (disk full, connection drop, deadlock) would
 * hit — so a thrown fault here proves the already-executed activation write
 * rolls back too, not just that the schedule write never lands.
 */
let atomicActivationFaultHook: ((point: "after_activate_before_schedule") => void) | null = null;

export function __setAuthenticatedDraftActivationFaultHookForTest(
  hook: ((point: "after_activate_before_schedule") => void) | null
): void {
  atomicActivationFaultHook = typeof hook === "function" ? hook : null;
}

function maybeAtomicActivationFault(point: "after_activate_before_schedule"): void {
  atomicActivationFaultHook?.(point);
}

function activateDraftAndAttachScheduleSqlite(
  connectorId: string,
  connectorInstanceId: string,
  contract: ActivationRefreshContract,
  now: string
): AuthenticatedDraftActivationResult {
  return writeTransaction(() => {
    const instance = getOne<ConnectorInstanceRow>(referenceQueries.connectorInstancesGetById, [connectorInstanceId]);
    const activated = instance?.status === "draft";
    if (activated) {
      exec(referenceQueries.connectorInstancesUpdateStatus, ["active", now, null, connectorInstanceId]);
      exec(referenceQueries.connectorSummaryEvidenceMarkDirtyByConnectorInstance, [
        "connector instance status changed to active",
        connectorInstanceId,
      ]);
    }
    // A schedule is only ever attached for a connection that IS (or just
    // became) active — never for a status this call did not itself resolve
    // to active (paused, revoked, or a missing row). `activated` covers the
    // just-flipped case; `instance?.status === "active"` covers a call
    // reaching an already-active connection (the idempotent-retry path).
    const isActive = activated || instance?.status === "active";

    maybeAtomicActivationFault("after_activate_before_schedule");

    let scheduleAttached = false;
    if (isActive && contract.mode === "automatic") {
      const existing = getOne<ScheduleRow>(referenceQueries.controllerGetScheduleByConnector, [connectorInstanceId]);
      if (!existing) {
        exec(referenceQueries.controllerInsertSchedule, [
          connectorInstanceId,
          connectorId,
          contract.intervalSeconds,
          0,
          1,
          now,
          now,
        ]);
        scheduleAttached = true;
      }
    }

    return { activated, contract, scheduleAttached };
  });
}

async function activateDraftAndAttachSchedulePostgres(
  connectorId: string,
  connectorInstanceId: string,
  contract: ActivationRefreshContract,
  now: string
): Promise<AuthenticatedDraftActivationResult> {
  return await withPostgresTransaction(async (client: TransactionClient) => {
    const statusResult = await client.query<ConnectorInstanceRow>(
      "SELECT status FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
      [connectorInstanceId]
    );
    const instance = statusResult.rows[0] ?? null;
    const activated = instance?.status === "draft";
    if (activated) {
      await client.query(
        "UPDATE connector_instances SET status = 'active', updated_at = $1, revoked_at = NULL WHERE connector_instance_id = $2",
        [now, connectorInstanceId]
      );
      // Canonical mark-dirty statement/semantics, matching
      // connector-instance-store.ts's own updateStatus exactly (same SQL,
      // same last_error wording) — inside this SAME transaction, so a
      // rollback (fault or otherwise) undoes the dirty-mark along with the
      // status flip, never leaving evidence marked dirty for a rolled-back
      // activation.
      await client.query(
        "UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', last_error = $1 WHERE connector_instance_id = $2",
        ["connector instance status changed to active", connectorInstanceId]
      );
    }
    // A schedule is only ever attached for a connection that IS (or just
    // became) active — never for a status this call did not itself resolve
    // to active (paused, revoked, or a missing row). `activated` covers the
    // just-flipped case; `instance?.status === "active"` covers a call
    // reaching an already-active connection (the idempotent-retry path).
    const isActive = activated || instance?.status === "active";

    maybeAtomicActivationFault("after_activate_before_schedule");

    let scheduleAttached = false;
    if (isActive && contract.mode === "automatic") {
      const existing = await client.query<ScheduleRow>(
        "SELECT connector_instance_id FROM connector_schedules WHERE connector_instance_id = $1 FOR UPDATE",
        [connectorInstanceId]
      );
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO connector_schedules(
             connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
           ) VALUES($1, $2, $3, $4, $5, $6, $7)`,
          [connectorInstanceId, connectorId, contract.intervalSeconds, 0, true, now, now]
        );
        scheduleAttached = true;
      }
    }

    return { activated, contract, scheduleAttached };
  });
}

/**
 * Atomically flips a draft connection to `active` and (when the manifest
 * resolves to automatic) attaches its schedule, in ONE transaction per
 * backend. Returns the outcome without throwing on ordinary idempotent
 * no-ops (already-active row, already-existing schedule); a genuine DB
 * failure partway through rolls back BOTH writes, so a connection can never
 * observably become active-with-no-schedule from this call.
 *
 * `connectorId`/`connectorInstanceId` are the schedule's own connector-key
 * columns — this mirrors attachActivationScheduleIfAutomatic's existing
 * per-connection-instance-keyed schedule shape (a schedule row is keyed by
 * connector_instance_id; connector_id rides along for the connector-type
 * projection).
 */
export async function activateDraftAndAttachScheduleAtomically(input: {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly manifest: unknown;
  readonly now?: string;
}): Promise<AuthenticatedDraftActivationResult> {
  const contract = resolveActivationRefreshContract(input.manifest);
  const now = input.now ?? new Date().toISOString();
  return isPostgresStorageBackend()
    ? await activateDraftAndAttachSchedulePostgres(input.connectorId, input.connectorInstanceId, contract, now)
    : activateDraftAndAttachScheduleSqlite(input.connectorId, input.connectorInstanceId, contract, now);
}
