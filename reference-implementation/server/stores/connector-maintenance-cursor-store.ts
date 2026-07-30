// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Durable fenced ownership for the bounded summary-evidence maintenance pass. */
import { randomUUID } from "node:crypto";

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged, writeTransaction } from "../../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

const CURSOR_NAME = "connector_summary_evidence";

interface CursorRow {
  readonly generation: number | string;
  readonly resume_after_id: string | null;
}

export interface ConnectorMaintenanceCursorLease {
  readonly generation: number;
  readonly resumeAfterId: string | null;
  readonly token: string;
}

export interface ConnectorMaintenanceCursorStore {
  acquire: (args: {
    readonly leaseDurationMs: number;
    readonly nowIso: string;
  }) => Promise<ConnectorMaintenanceCursorLease | null>;
  commit: (args: {
    readonly lease: ConnectorMaintenanceCursorLease;
    readonly resumeAfterId: string | null;
    readonly updatedAt: string;
  }) => Promise<boolean>;
  release: (lease: ConnectorMaintenanceCursorLease) => Promise<boolean>;
}

function readGeneration(value: number | string): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Maintenance cursor generation is invalid.");
  }
  return generation;
}

function assertLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("Maintenance cursor lease duration is invalid.");
  }
}

function leaseExpiresAt(nowIso: string, leaseDurationMs: number): string {
  const now = Date.parse(nowIso);
  assertLeaseDuration(leaseDurationMs);
  if (!Number.isFinite(now)) {
    throw new Error("Maintenance cursor lease clock is invalid.");
  }
  return new Date(now + leaseDurationMs).toISOString();
}

function createSqliteConnectorMaintenanceCursorStore(): ConnectorMaintenanceCursorStore {
  return {
    acquire({ leaseDurationMs, nowIso }) {
      const token = randomUUID();
      const expiresAt = leaseExpiresAt(nowIso, leaseDurationMs);
      const lease = writeTransaction(() => {
        // REVIEWED-DYNAMIC: singleton scheduling state is intentionally not a product query artifact.
        execDynamicSqlAcknowledged(
          `INSERT INTO connector_maintenance_cursor(name, resume_after_id, updated_at, generation, lease_token, lease_expires_at)
           VALUES (?, NULL, ?, 0, NULL, NULL)
           ON CONFLICT(name) DO NOTHING`,
          [CURSOR_NAME, nowIso]
        );
        // REVIEWED-DYNAMIC: BEGIN IMMEDIATE encloses the lease predicate and its fencing-token write.
        const before = [
          ...iterateDynamicSqlAcknowledged<CursorRow>(
            `SELECT resume_after_id, generation FROM connector_maintenance_cursor
             WHERE name = ? AND (lease_token IS NULL OR lease_expires_at <= ?)`,
            [CURSOR_NAME, nowIso]
          ),
        ].at(0);
        if (!before) {
          return null;
        }
        // REVIEWED-DYNAMIC: conditional generation predicate fences a stale owner before it can commit.
        const claimed = execDynamicSqlAcknowledged(
          `UPDATE connector_maintenance_cursor
             SET generation = generation + 1, lease_token = ?, lease_expires_at = ?
           WHERE name = ? AND generation = ? AND (lease_token IS NULL OR lease_expires_at <= ?)`,
          [token, expiresAt, CURSOR_NAME, before.generation, nowIso]
        );
        if (claimed.changes !== 1) {
          return null;
        }
        return {
          generation: readGeneration(before.generation) + 1,
          resumeAfterId:
            typeof before.resume_after_id === "string" && before.resume_after_id ? before.resume_after_id : null,
          token,
        };
      });
      return Promise.resolve(lease);
    },
    commit({ lease, resumeAfterId, updatedAt }) {
      // REVIEWED-DYNAMIC: token-plus-generation compare-and-set prevents an expired stale lease from replacing newer progress.
      const result = execDynamicSqlAcknowledged(
        `UPDATE connector_maintenance_cursor
           SET resume_after_id = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL
         WHERE name = ? AND generation = ? AND lease_token = ?`,
        [resumeAfterId, updatedAt, CURSOR_NAME, lease.generation, lease.token]
      );
      return Promise.resolve(result.changes === 1);
    },
    release(lease) {
      // REVIEWED-DYNAMIC: a failed owner releases only its own fenced lease and never changes cursor progress.
      const result = execDynamicSqlAcknowledged(
        `UPDATE connector_maintenance_cursor
           SET lease_token = NULL, lease_expires_at = NULL
         WHERE name = ? AND generation = ? AND lease_token = ?`,
        [CURSOR_NAME, lease.generation, lease.token]
      );
      return Promise.resolve(result.changes === 1);
    },
  };
}

function createPostgresConnectorMaintenanceCursorStore(): ConnectorMaintenanceCursorStore {
  return {
    async acquire({ leaseDurationMs }) {
      const token = randomUUID();
      assertLeaseDuration(leaseDurationMs);
      await postgresQuery(
        `INSERT INTO connector_maintenance_cursor(name, resume_after_id, updated_at, generation, lease_token, lease_expires_at)
         VALUES ($1, NULL, clock_timestamp()::text, 0, NULL, NULL)
         ON CONFLICT(name) DO NOTHING`,
        [CURSOR_NAME]
      );
      const result = await postgresQuery<CursorRow>(
        `UPDATE connector_maintenance_cursor
           SET generation = generation + 1,
               lease_token = $2,
               lease_expires_at = (clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond'))::text
         WHERE name = $1 AND (lease_token IS NULL OR lease_expires_at::timestamptz <= clock_timestamp())
         RETURNING resume_after_id, generation`,
        [CURSOR_NAME, token, leaseDurationMs]
      );
      const [row] = result.rows;
      if (!row) {
        return null;
      }
      return {
        generation: readGeneration(row.generation),
        resumeAfterId: typeof row.resume_after_id === "string" && row.resume_after_id ? row.resume_after_id : null,
        token,
      };
    },
    async commit({ lease, resumeAfterId, updatedAt }) {
      const result = await postgresQuery(
        `UPDATE connector_maintenance_cursor
           SET resume_after_id = $4, updated_at = $5, lease_token = NULL, lease_expires_at = NULL
         WHERE name = $1 AND generation = $2 AND lease_token = $3`,
        [CURSOR_NAME, lease.generation, lease.token, resumeAfterId, updatedAt]
      );
      return result.rowCount === 1;
    },
    async release(lease) {
      const result = await postgresQuery(
        `UPDATE connector_maintenance_cursor
           SET lease_token = NULL, lease_expires_at = NULL
         WHERE name = $1 AND generation = $2 AND lease_token = $3`,
        [CURSOR_NAME, lease.generation, lease.token]
      );
      return result.rowCount === 1;
    },
  };
}

export function createConnectorMaintenanceCursorStore(): ConnectorMaintenanceCursorStore {
  return isPostgresStorageBackend()
    ? createPostgresConnectorMaintenanceCursorStore()
    : createSqliteConnectorMaintenanceCursorStore();
}
