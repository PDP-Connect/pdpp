// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reconciles authorization artifacts after an exact client-deletion fact.
 *
 * `oauth_clients` is currently a registration record, not a tombstone. The
 * durable deletion fact is therefore the successful `client.deleted` spine
 * event. This store intentionally never infers deletion from a missing client
 * row: external/CIMD clients can have no local registration row while still
 * being valid identities.
 */

import type { PoolClient } from "pg";

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged, writeTransaction } from "../../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";
import {
  type ConnectorMaintenanceCursorLease,
  type ConnectorMaintenanceCursorStore,
  createConnectorMaintenanceCursorStore,
} from "./connector-maintenance-cursor-store.ts";

const AUTH_CLIENT_ACCESS_CURSOR_NAME = "auth_client_access" as const;
const DEFAULT_MAX_CLIENTS_PER_ROUND = 25;
const HARD_MAX_CLIENTS_PER_ROUND = 100;
const DEFAULT_MAX_DURATION_MS = 2000;
const HARD_MAX_DURATION_MS = 5000;
const DEFAULT_LEASE_DURATION_MS = 30_000;

interface ClientDeletionEvidenceRow {
  readonly client_id: string;
}

export interface AuthClientAccessReconciliationResult {
  readonly clientId: string;
  readonly grantsRevoked: number;
  readonly packageMembersRevoked: number;
  readonly packagesRevoked: number;
  readonly refreshTokensRevoked: number;
  readonly tokensRevoked: number;
}

export interface AuthClientAccessMaintenanceRound {
  readonly grantsRevoked: number;
  readonly incomplete: boolean;
  readonly packageMembersRevoked: number;
  readonly packagesRevoked: number;
  readonly processedClientIds: readonly string[];
  readonly reconciledClientCount: number;
  readonly refreshTokensRevoked: number;
  readonly resumeAfterId: string | null;
  readonly tokensRevoked: number;
}

export interface AuthClientAccessMaintenanceRunOptions {
  readonly leaseDurationMs?: number;
  readonly maxClients?: number;
  readonly maxDurationMs?: number;
  readonly nowIso?: () => string;
}

export interface AuthClientAccessMaintenanceReconciler {
  readonly runRound: (
    options?: AuthClientAccessMaintenanceRunOptions
  ) => Promise<AuthClientAccessMaintenanceRound | null>;
}

function assertClientId(clientId: string): void {
  if (typeof clientId !== "string" || clientId.trim().length === 0) {
    throw new Error("Auth client reconciliation requires a non-empty client_id.");
  }
}

function assertIsoTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Auth client reconciliation requires a valid timestamp.");
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number, hardMax: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Math.min(candidate, hardMax);
}

function emptyReconciliationCounts() {
  return {
    grantsRevoked: 0,
    packageMembersRevoked: 0,
    packagesRevoked: 0,
    refreshTokensRevoked: 0,
    tokensRevoked: 0,
  };
}

function addReconciliationCounts(
  totals: ReturnType<typeof emptyReconciliationCounts>,
  result: AuthClientAccessReconciliationResult
): void {
  totals.grantsRevoked += result.grantsRevoked;
  totals.packageMembersRevoked += result.packageMembersRevoked;
  totals.packagesRevoked += result.packagesRevoked;
  totals.refreshTokensRevoked += result.refreshTokensRevoked;
  totals.tokensRevoked += result.tokensRevoked;
}

async function updatePostgresClientAccessArtifacts(
  client: PoolClient,
  clientId: string,
  revokedAt: string
): Promise<AuthClientAccessReconciliationResult> {
  const grants = await client.query(
    `UPDATE grants
        SET status = 'revoked'
      WHERE client_id = $1 AND status = 'active'`,
    [clientId]
  );
  const packages = await client.query(
    `UPDATE grant_packages
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
      WHERE client_id = $1 AND status = 'active'`,
    [clientId, revokedAt]
  );
  const packageMembers = await client.query(
    `UPDATE grant_package_members
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
      WHERE status = 'active'
        AND (
          package_id IN (SELECT package_id FROM grant_packages WHERE client_id = $1)
          OR grant_id IN (SELECT grant_id FROM grants WHERE client_id = $1)
        )`,
    [clientId, revokedAt]
  );
  const tokens = await client.query(
    `UPDATE tokens
        SET revoked = TRUE
      WHERE revoked = FALSE
        AND (
          client_id = $1
          OR package_id IN (SELECT package_id FROM grant_packages WHERE client_id = $1)
          OR grant_id IN (SELECT grant_id FROM grants WHERE client_id = $1)
        )`,
    [clientId]
  );
  const refreshTokens = await client.query(
    `UPDATE oauth_refresh_tokens
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
      WHERE status = 'active'
        AND (
          client_id = $1
          OR package_id IN (SELECT package_id FROM grant_packages WHERE client_id = $1)
          OR grant_id IN (SELECT grant_id FROM grants WHERE client_id = $1)
        )`,
    [clientId, revokedAt]
  );
  return {
    clientId,
    grantsRevoked: grants.rowCount ?? 0,
    packageMembersRevoked: packageMembers.rowCount ?? 0,
    packagesRevoked: packages.rowCount ?? 0,
    refreshTokensRevoked: refreshTokens.rowCount ?? 0,
    tokensRevoked: tokens.rowCount ?? 0,
  };
}

function updateSqliteClientAccessArtifacts(clientId: string, revokedAt: string): AuthClientAccessReconciliationResult {
  // REVIEWED-DYNAMIC: this is a fixed dialect-specific maintenance batch; it is not a request query and has no user-controlled SQL fragments.
  const update = (sql: string, params: readonly (string | number)[]) => execDynamicSqlAcknowledged(sql, params).changes;
  const grantsRevoked = update(
    `UPDATE grants
        SET status = 'revoked'
      WHERE client_id = ? AND status = 'active'`,
    [clientId]
  );
  const packagesRevoked = update(
    `UPDATE grant_packages
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
      WHERE client_id = ? AND status = 'active'`,
    [revokedAt, clientId]
  );
  const packageMembersRevoked = update(
    `UPDATE grant_package_members
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
      WHERE status = 'active'
        AND (
          package_id IN (SELECT package_id FROM grant_packages WHERE client_id = ?)
          OR grant_id IN (SELECT grant_id FROM grants WHERE client_id = ?)
        )`,
    [revokedAt, clientId, clientId]
  );
  const tokensRevoked = update(
    `UPDATE tokens
        SET revoked = TRUE
      WHERE revoked = FALSE
        AND (
          client_id = ?
          OR package_id IN (SELECT package_id FROM grant_packages WHERE client_id = ?)
          OR grant_id IN (SELECT grant_id FROM grants WHERE client_id = ?)
        )`,
    [clientId, clientId, clientId]
  );
  const refreshTokensRevoked = update(
    `UPDATE oauth_refresh_tokens
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
      WHERE status = 'active'
        AND (
          client_id = ?
          OR package_id IN (SELECT package_id FROM grant_packages WHERE client_id = ?)
          OR grant_id IN (SELECT grant_id FROM grants WHERE client_id = ?)
        )`,
    [revokedAt, clientId, clientId, clientId]
  );
  return {
    clientId,
    grantsRevoked,
    packageMembersRevoked,
    packagesRevoked,
    refreshTokensRevoked,
    tokensRevoked,
  };
}

/**
 * Status-only, idempotent reconciliation for one exact client identity.
 * Existing revoked timestamps are retained; no authority or audit row is
 * deleted.
 */
export async function reconcileClientAccessArtifacts(
  clientId: string,
  revokedAt = new Date().toISOString()
): Promise<AuthClientAccessReconciliationResult> {
  assertClientId(clientId);
  assertIsoTimestamp(revokedAt);
  if (isPostgresStorageBackend()) {
    return await withPostgresTransaction((client) => updatePostgresClientAccessArtifacts(client, clientId, revokedAt));
  }
  return writeTransaction(() => updateSqliteClientAccessArtifacts(clientId, revokedAt));
}

async function listDeletedClientIds(afterId: string | null, limit: number): Promise<string[]> {
  if (isPostgresStorageBackend()) {
    const result =
      afterId === null
        ? await postgresQuery<ClientDeletionEvidenceRow>(
            `SELECT DISTINCT e.client_id
               FROM spine_events e
              WHERE e.event_type = 'client.deleted'
                AND e.status = 'succeeded'
                AND e.object_type = 'client'
                AND e.client_id IS NOT NULL
                AND NULLIF(BTRIM(e.client_id), '') IS NOT NULL
                AND e.object_id = e.client_id
              ORDER BY e.client_id ASC
              LIMIT $1`,
            [limit]
          )
        : await postgresQuery<ClientDeletionEvidenceRow>(
            `SELECT DISTINCT e.client_id
               FROM spine_events e
              WHERE e.event_type = 'client.deleted'
                AND e.status = 'succeeded'
                AND e.object_type = 'client'
                AND e.client_id IS NOT NULL
                AND NULLIF(BTRIM(e.client_id), '') IS NOT NULL
                AND e.object_id = e.client_id
                AND e.client_id > $1
              ORDER BY e.client_id ASC
              LIMIT $2`,
            [afterId, limit]
          );
    return result.rows.map((row) => row.client_id).filter((clientId): clientId is string => Boolean(clientId));
  }

  // REVIEWED-DYNAMIC: the SQL is fixed and the LIMIT is an internal capped batch; dialect-specific query registration would not share this lease-owned keyset walk.
  const sqliteRows =
    afterId === null
      ? iterateDynamicSqlAcknowledged<ClientDeletionEvidenceRow>(
          `SELECT DISTINCT e.client_id
             FROM spine_events e
            WHERE e.event_type = 'client.deleted'
              AND e.status = 'succeeded'
              AND e.object_type = 'client'
              AND e.client_id IS NOT NULL
              AND NULLIF(TRIM(e.client_id), '') IS NOT NULL
              AND e.object_id = e.client_id
            ORDER BY e.client_id ASC
            LIMIT ?`,
          [limit]
        )
      : iterateDynamicSqlAcknowledged<ClientDeletionEvidenceRow>(
          `SELECT DISTINCT e.client_id
             FROM spine_events e
            WHERE e.event_type = 'client.deleted'
              AND e.status = 'succeeded'
              AND e.object_type = 'client'
              AND e.client_id IS NOT NULL
              AND NULLIF(TRIM(e.client_id), '') IS NOT NULL
              AND e.object_id = e.client_id
              AND e.client_id > ?
            ORDER BY e.client_id ASC
            LIMIT ?`,
          [afterId, limit]
        );
  return [...sqliteRows].map((row) => row.client_id).filter((clientId): clientId is string => Boolean(clientId));
}

interface ProcessedClientAccessCandidates {
  readonly processedClientIds: string[];
  readonly totals: ReturnType<typeof emptyReconciliationCounts>;
}

async function processClientAccessCandidates(
  candidates: readonly string[],
  maxClients: number,
  maxDurationMs: number,
  nowIso: () => string
): Promise<ProcessedClientAccessCandidates> {
  const startedAt = Date.now();
  const processedClientIds: string[] = [];
  const totals = emptyReconciliationCounts();
  for (const clientId of candidates.slice(0, maxClients)) {
    // Always process the first candidate so a positive budget cannot turn
    // into a no-progress cursor loop. One exact client's updates are a fixed
    // five-statement transaction; the batch remains bounded.
    if (processedClientIds.length > 0 && Date.now() - startedAt >= maxDurationMs) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Reconciliation is intentionally sequential so the wall-clock budget and one-client cursor advance remain explicit.
    const result = await reconcileClientAccessArtifacts(clientId, nowIso());
    processedClientIds.push(clientId);
    addReconciliationCounts(totals, result);
  }
  return { processedClientIds, totals };
}

function emptyMaintenanceRound(
  processedClientIds: readonly string[],
  incomplete: boolean,
  resumeAfterId: string | null,
  totals: ReturnType<typeof emptyReconciliationCounts>
): AuthClientAccessMaintenanceRound {
  return {
    ...totals,
    incomplete,
    processedClientIds,
    reconciledClientCount: processedClientIds.length,
    resumeAfterId,
  };
}

export function createAuthClientAccessMaintenanceReconciler(
  cursorStore: ConnectorMaintenanceCursorStore = createConnectorMaintenanceCursorStore(AUTH_CLIENT_ACCESS_CURSOR_NAME)
): AuthClientAccessMaintenanceReconciler {
  let inFlight = false;

  return {
    runRound: async (options = {}) => {
      if (inFlight) {
        return null;
      }
      const maxClients = boundedPositiveInteger(
        options.maxClients,
        DEFAULT_MAX_CLIENTS_PER_ROUND,
        HARD_MAX_CLIENTS_PER_ROUND,
        "maxClients"
      );
      const maxDurationMs = boundedPositiveInteger(
        options.maxDurationMs,
        DEFAULT_MAX_DURATION_MS,
        HARD_MAX_DURATION_MS,
        "maxDurationMs"
      );
      const leaseDurationMs = boundedPositiveInteger(
        options.leaseDurationMs,
        DEFAULT_LEASE_DURATION_MS,
        5 * 60_000,
        "leaseDurationMs"
      );
      const nowIso = options.nowIso ?? (() => new Date().toISOString());
      inFlight = true;
      let lease: ConnectorMaintenanceCursorLease | null = null;
      let committed = false;
      try {
        const acquiredAt = nowIso();
        assertIsoTimestamp(acquiredAt);
        lease = await cursorStore.acquire({ leaseDurationMs, nowIso: acquiredAt });
        if (!lease) {
          return null;
        }

        const candidates = await listDeletedClientIds(lease.resumeAfterId, maxClients + 1);
        const processed = await processClientAccessCandidates(candidates, maxClients, maxDurationMs, nowIso);
        const { processedClientIds, totals } = processed;

        const reachedEvidenceTail = candidates.length <= maxClients && processedClientIds.length === candidates.length;
        const incomplete = !reachedEvidenceTail;
        const nextCursor = incomplete ? (processedClientIds.at(-1) ?? lease.resumeAfterId) : null;
        if (incomplete && !nextCursor) {
          throw new Error("Auth client access maintenance made no cursor progress.");
        }
        committed = await cursorStore.commit({
          lease,
          resumeAfterId: nextCursor,
          updatedAt: nowIso(),
        });
        if (!committed) {
          return null;
        }
        return emptyMaintenanceRound(processedClientIds, incomplete, nextCursor, totals);
      } finally {
        if (lease && !committed) {
          await cursorStore.release(lease).catch(() => {
            // The bounded lease expires if release itself cannot reach storage.
          });
        }
        inFlight = false;
      }
    },
  };
}
