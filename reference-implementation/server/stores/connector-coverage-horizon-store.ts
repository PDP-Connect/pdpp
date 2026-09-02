// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable store for provider coverage-horizon/provenance disclosures.
 *
 * A coverage horizon is a structured, reversible fact about the BOUNDARY of
 * what a source can ever provide — e.g. "GroupMe does not retain messages
 * before 2013." It is orthogonal to connection health: recording, reading,
 * or superseding a horizon never rewrites/deletes retained records, and
 * never by itself marks a connection unhealthy (see
 * `runtime/coverage-horizon.ts` and `openspec/specs/reference-connection-
 * health/spec.md`). This store owns persistence only; classification stays
 * out of it.
 *
 * Reference-only, not a PDPP Core surface. This module carries NO
 * connector/provider-ID branching — every operation is keyed by
 * `connectorInstanceId`/`stream`, exactly as `connector-attention-store.ts`
 * and `connector-detail-gap-store.ts` are.
 */

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import type {
  ConnectionCoverageHorizon,
  CoverageHorizonBasis,
  CoverageHorizonReason,
} from "../../runtime/coverage-horizon.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

const CONNECTION_WIDE_STREAM = "*";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface ConfirmCoverageHorizonInput {
  readonly basis: CoverageHorizonBasis;
  readonly confirmedAt?: string | null;
  readonly confirmedBy: string;
  readonly connectorInstanceId: string;
  readonly earliestAvailable?: string | null;
  readonly note?: string | null;
  readonly reason: CoverageHorizonReason;
  /** Omit/`"*"` for a connection-wide horizon. */
  readonly stream?: string | null;
}

interface HorizonRow {
  basis: string;
  confirmed_at: string;
  confirmed_by: string;
  connector_instance_id: string;
  earliest_available: string | null;
  horizon_id: string;
  note: string | null;
  reason: string;
  stream: string;
  superseded_at: string | null;
  superseded_by_horizon_id: string | null;
}

function rowToHorizon(row: HorizonRow): ConnectionCoverageHorizon {
  return {
    basis: row.basis as CoverageHorizonBasis,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    connectorInstanceId: row.connector_instance_id,
    earliestAvailable: row.earliest_available,
    horizonId: row.horizon_id,
    note: row.note,
    reason: row.reason as CoverageHorizonReason,
    stream: row.stream,
    supersededAt: row.superseded_at,
    supersededByHorizonId: row.superseded_by_horizon_id,
  };
}

export interface ConnectorCoverageHorizonStore {
  /**
   * Record a new coverage-horizon confirmation, superseding the prior
   * current row for the same (connection, stream) in the same transaction.
   * The prior row is NEVER deleted or overwritten — only its
   * `superseded_at`/`superseded_by_horizon_id` columns are set — so
   * provenance survives a later contradiction exactly as the plan requires.
   */
  confirmCoverageHorizon: (input: ConfirmCoverageHorizonInput) => Promise<ConnectionCoverageHorizon>;
  /** Every CURRENT (non-superseded) horizon for a connection, across all streams. */
  getCurrentCoverageHorizons: (connectorInstanceId: string) => Promise<readonly ConnectionCoverageHorizon[]>;
  /**
   * Batched form of {@link getCurrentCoverageHorizons} for a page-scoped
   * fleet read (`/sources`, `loadPageProductEvidence` in `ref-control.ts`) —
   * one query for every requested connection instead of N. An id with no
   * current horizon is simply absent from the returned map (never a
   * fabricated empty-array entry vs. a missing one; the caller reads
   * `.get(id) ?? []`, matching every other batched-by-ids store in this
   * file, e.g. `getMetadataByInstanceIds`).
   */
  getCurrentCoverageHorizonsByInstanceIds: (
    connectorInstanceIds: readonly string[]
  ) => Promise<ReadonlyMap<string, readonly ConnectionCoverageHorizon[]>>;
}

const MAX_HORIZONS_PER_CONNECTION = 200;
const SQLITE_INSTANCE_ID_CHUNK_SIZE = 900;

function groupHorizonsByInstance(
  rows: readonly HorizonRow[]
): ReadonlyMap<string, readonly ConnectionCoverageHorizon[]> {
  const result = new Map<string, ConnectionCoverageHorizon[]>();
  for (const row of rows) {
    const horizon = rowToHorizon(row);
    const existing = result.get(horizon.connectorInstanceId);
    if (existing) {
      existing.push(horizon);
    } else {
      result.set(horizon.connectorInstanceId, [horizon]);
    }
  }
  return result;
}

export function createSqliteConnectorCoverageHorizonStore(): ConnectorCoverageHorizonStore {
  return {
    // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared store contract.
    async confirmCoverageHorizon(input: ConfirmCoverageHorizonInput): Promise<ConnectionCoverageHorizon> {
      const connectorInstanceId = nonEmptyString(input.connectorInstanceId);
      const confirmedBy = nonEmptyString(input.confirmedBy);
      if (!connectorInstanceId) {
        throw new Error("confirmCoverageHorizon: connectorInstanceId is required");
      }
      if (!confirmedBy) {
        throw new Error("confirmCoverageHorizon: confirmedBy is required");
      }
      const stream = nonEmptyString(input.stream) ?? CONNECTION_WIDE_STREAM;
      const confirmedAt = nonEmptyString(input.confirmedAt) ?? nowIso();
      const horizonId = `covhz_${crypto.randomUUID()}`;
      const earliestAvailable = nonEmptyString(input.earliestAvailable);
      const note = nonEmptyString(input.note);

      // Supersede the prior current row for this (connection, stream) FIRST,
      // then insert — never the reverse, so the partial unique index
      // (superseded_at IS NULL) can never see two current rows at once.
      execDynamicSqlAcknowledged(
        `UPDATE connector_coverage_horizons
            SET superseded_at = ?, superseded_by_horizon_id = ?
          WHERE connector_instance_id = ? AND stream = ? AND superseded_at IS NULL`,
        [confirmedAt, horizonId, connectorInstanceId, stream]
      );
      execDynamicSqlAcknowledged(
        `INSERT INTO connector_coverage_horizons
           (horizon_id, connector_instance_id, stream, earliest_available, confirmed_at, basis, reason, confirmed_by, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          horizonId,
          connectorInstanceId,
          stream,
          earliestAvailable,
          confirmedAt,
          input.basis,
          input.reason,
          confirmedBy,
          note,
        ]
      );
      return {
        basis: input.basis,
        confirmedAt,
        confirmedBy,
        connectorInstanceId,
        earliestAvailable,
        horizonId,
        note,
        reason: input.reason,
        stream,
        supersededAt: null,
        supersededByHorizonId: null,
      };
    },
    // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared store contract.
    async getCurrentCoverageHorizons(connectorInstanceId: string): Promise<readonly ConnectionCoverageHorizon[]> {
      const id = nonEmptyString(connectorInstanceId);
      if (!id) {
        return [];
      }
      const rows = [
        ...iterateDynamicSqlAcknowledged<HorizonRow>(
          `SELECT horizon_id, connector_instance_id, stream, earliest_available, confirmed_at, basis, reason, confirmed_by, note, superseded_at, superseded_by_horizon_id
             FROM connector_coverage_horizons
            WHERE connector_instance_id = ? AND superseded_at IS NULL
            ORDER BY stream ASC
            LIMIT ?`,
          [id, MAX_HORIZONS_PER_CONNECTION]
        ),
      ];
      return rows.map(rowToHorizon);
    },
    // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared store contract.
    async getCurrentCoverageHorizonsByInstanceIds(connectorInstanceIds: readonly string[]) {
      const ids = [...new Set(connectorInstanceIds.filter((id) => typeof id === "string" && id.length > 0))];
      if (ids.length === 0) {
        return new Map();
      }
      const rows: HorizonRow[] = [];
      for (let start = 0; start < ids.length; start += SQLITE_INSTANCE_ID_CHUNK_SIZE) {
        const chunk = ids.slice(start, start + SQLITE_INSTANCE_ID_CHUNK_SIZE);
        rows.push(
          ...iterateDynamicSqlAcknowledged<HorizonRow>(
            `SELECT horizon_id, connector_instance_id, stream, earliest_available, confirmed_at, basis, reason, confirmed_by, note, superseded_at, superseded_by_horizon_id
               FROM connector_coverage_horizons
              WHERE connector_instance_id IN (${chunk.map(() => "?").join(", ")}) AND superseded_at IS NULL
              ORDER BY connector_instance_id ASC, stream ASC`,
            chunk
          )
        );
      }
      return groupHorizonsByInstance(rows);
    },
  };
}

export function createPostgresConnectorCoverageHorizonStore(): ConnectorCoverageHorizonStore {
  return {
    async confirmCoverageHorizon(input: ConfirmCoverageHorizonInput): Promise<ConnectionCoverageHorizon> {
      const connectorInstanceId = nonEmptyString(input.connectorInstanceId);
      const confirmedBy = nonEmptyString(input.confirmedBy);
      if (!connectorInstanceId) {
        throw new Error("confirmCoverageHorizon: connectorInstanceId is required");
      }
      if (!confirmedBy) {
        throw new Error("confirmCoverageHorizon: confirmedBy is required");
      }
      const stream = nonEmptyString(input.stream) ?? CONNECTION_WIDE_STREAM;
      const confirmedAt = nonEmptyString(input.confirmedAt) ?? nowIso();
      const horizonId = `covhz_${crypto.randomUUID()}`;
      const earliestAvailable = nonEmptyString(input.earliestAvailable);
      const note = nonEmptyString(input.note);

      await postgresQuery(
        `UPDATE connector_coverage_horizons
            SET superseded_at = $1, superseded_by_horizon_id = $2
          WHERE connector_instance_id = $3 AND stream = $4 AND superseded_at IS NULL`,
        [confirmedAt, horizonId, connectorInstanceId, stream]
      );
      await postgresQuery(
        `INSERT INTO connector_coverage_horizons
           (horizon_id, connector_instance_id, stream, earliest_available, confirmed_at, basis, reason, confirmed_by, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          horizonId,
          connectorInstanceId,
          stream,
          earliestAvailable,
          confirmedAt,
          input.basis,
          input.reason,
          confirmedBy,
          note,
        ]
      );
      return {
        basis: input.basis,
        confirmedAt,
        confirmedBy,
        connectorInstanceId,
        earliestAvailable,
        horizonId,
        note,
        reason: input.reason,
        stream,
        supersededAt: null,
        supersededByHorizonId: null,
      };
    },
    async getCurrentCoverageHorizons(connectorInstanceId: string): Promise<readonly ConnectionCoverageHorizon[]> {
      const id = nonEmptyString(connectorInstanceId);
      if (!id) {
        return [];
      }
      const result = await postgresQuery<HorizonRow>(
        `SELECT horizon_id, connector_instance_id, stream, earliest_available, confirmed_at, basis, reason, confirmed_by, note, superseded_at, superseded_by_horizon_id
           FROM connector_coverage_horizons
          WHERE connector_instance_id = $1 AND superseded_at IS NULL
          ORDER BY stream ASC
          LIMIT $2`,
        [id, MAX_HORIZONS_PER_CONNECTION]
      );
      return result.rows.map(rowToHorizon);
    },
    async getCurrentCoverageHorizonsByInstanceIds(connectorInstanceIds: readonly string[]) {
      const ids = [...new Set(connectorInstanceIds.filter((id) => typeof id === "string" && id.length > 0))];
      if (ids.length === 0) {
        return new Map();
      }
      const result = await postgresQuery<HorizonRow>(
        `SELECT horizon_id, connector_instance_id, stream, earliest_available, confirmed_at, basis, reason, confirmed_by, note, superseded_at, superseded_by_horizon_id
           FROM connector_coverage_horizons
          WHERE connector_instance_id = ANY($1::text[]) AND superseded_at IS NULL
          ORDER BY connector_instance_id ASC, stream ASC`,
        [ids]
      );
      return groupHorizonsByInstance(result.rows);
    },
  };
}

export function createConnectorCoverageHorizonStore(): ConnectorCoverageHorizonStore {
  return isPostgresStorageBackend()
    ? createPostgresConnectorCoverageHorizonStore()
    : createSqliteConnectorCoverageHorizonStore();
}

let defaultStore: ConnectorCoverageHorizonStore | null = null;
let defaultBackend: string | null = null;

/** Cached singleton, mirroring `getDefaultConnectorAttentionStore` (`connector-attention-store.ts`). */
export function getDefaultConnectorCoverageHorizonStore(): ConnectorCoverageHorizonStore {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultBackend !== backend) {
    defaultStore = createConnectorCoverageHorizonStore();
    defaultBackend = backend;
  }
  return defaultStore;
}
