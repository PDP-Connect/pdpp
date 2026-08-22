// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable, provenance-bearing connector configuration: an immutable
 * per-connection revision ledger.
 *
 * Replaces the connector-specific-env-var pattern (SLACK_CHANNEL_ALLOWLIST
 * et al.): container env is state outside git, dies on redeploy, and
 * carries no author.
 *
 * Design history: an earlier draft of this module wrote one mutable row
 * per (connector_instance_id, key). An adversarial design review
 * (~/.tmp/reorg-0814/CONFIG-REDTEAM-CODEX.md, 2026-08-22) showed that shape
 * still permits the exact incident it exists to fix: an agent holding the
 * owner's bearer token can submit a well-typed, fully-attributed
 * collection-shaping value, and "well-typed and attributed to an agent" is
 * not the same as "the owner chose this." The review's required
 * invariant, adopted here: a run consumes collection-shaping configuration
 * only from an immutable, owner-confirmed revision. A non-owner write
 * (agent, script, migration) may PROPOSE a collection_scope revision but
 * can never itself ACTIVATE one -- only an explicit owner-confirmation
 * call moves a proposed collection_scope revision to `active`.
 * Pure-transport revisions (proven not to change what is collected) may
 * self-activate, because there is nothing for the owner to confirm.
 *
 * Concurrency: writes are optimistic-locked against the connection's
 * current (revision, storage_epoch) pair (`baseRevision`/`baseEpoch`). A
 * stale write is rejected with both the caller's base and the actual
 * current revision so the caller can rebase explicitly -- never merged,
 * never last-write-wins.
 *
 * Every provenance column is NOT NULL; origin is a closed enum with no
 * 'unknown' member -- see assertProvenanceOrThrow. Activating a revision
 * and declassifying stale coverage proof happen in the SAME SQLite
 * transaction as the pointer move, so a run can never observe a new
 * config with old proof or vice versa.
 */

import { getMany, getOne, referenceQueries, writeTransaction } from "../../lib/db.ts";
import { getDb } from "../db.ts";
import { postgresQuery } from "../postgres-storage.ts";

/** A config revision shapes what a connector collects, or only how it collects. */
export type ConfigOptionKind = "collection_scope" | "transport";

/** Closed by design -- no 'unknown' member. A caller that cannot honestly assert one of these has no way to call `propose()`. */
export type ConfigOrigin = "agent" | "default" | "migration" | "owner";

export type ConfigRevisionStatus = "active" | "proposed" | "quarantined" | "superseded";

/** The current, closed contract this module writes. Bump on any breaking config_json shape change; never coerce an old contract into a new one. */
export const CONNECTOR_CONFIG_CONTRACT_ID = "pdpp.connector_config.v1";
export const CONNECTOR_CONFIG_CONTRACT_VERSION = 1;

export interface ConfigProvenance {
  readonly isExplicit: boolean;
  readonly optionKind: ConfigOptionKind;
  readonly origin: ConfigOrigin;
  readonly setAt: string;
  /** Actor id: "owner", an agent/session identifier, or a migration script name. Never "unknown", "system", or empty. */
  readonly setBy: string;
  readonly sourceOfChange: string;
}

export interface ConfigRevision {
  readonly collectionBoundaryFingerprint: string | null;
  readonly config: Record<string, unknown>;
  readonly configContractId: string;
  readonly configContractVersion: number;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string | null;
  readonly connectorInstanceId: string;
  readonly isExplicit: boolean;
  readonly optionKind: ConfigOptionKind;
  readonly origin: ConfigOrigin;
  readonly revision: number;
  readonly setAt: string;
  readonly setBy: string;
  readonly sourceOfChange: string;
  readonly status: ConfigRevisionStatus;
}

export interface CurrentPointer {
  readonly activeRevision: number;
  readonly connectorInstanceId: string;
  readonly storageEpoch: number;
  readonly updatedAt: string;
}

export class ConfigStaleWriteError extends Error {
  readonly actualEpoch: number;
  readonly actualRevision: number;

  constructor(actualRevision: number, actualEpoch: number) {
    super(
      `connector_instance_config: stale write -- caller's base does not match current (revision=${actualRevision}, epoch=${actualEpoch}); rebase and retry, do not merge`
    );
    this.actualRevision = actualRevision;
    this.actualEpoch = actualEpoch;
  }
}

const VALID_ORIGINS: ReadonlySet<string> = new Set(["owner", "agent", "migration", "default"]);
const VALID_OPTION_KINDS: ReadonlySet<string> = new Set(["collection_scope", "transport"]);
const MAX_REVISIONS_PER_INSTANCE = 500;

function assertProvenanceOrThrow(provenance: ConfigProvenance): void {
  if (!VALID_ORIGINS.has(provenance.origin)) {
    throw new Error(`connector_instance_config: invalid origin "${provenance.origin}"`);
  }
  if (!VALID_OPTION_KINDS.has(provenance.optionKind)) {
    throw new Error(`connector_instance_config: invalid option_kind "${provenance.optionKind}"`);
  }
  if (provenance.setBy.trim().length === 0) {
    throw new Error("connector_instance_config: setBy must not be empty");
  }
  if (provenance.sourceOfChange.trim().length === 0) {
    throw new Error("connector_instance_config: sourceOfChange must not be empty");
  }
  if (provenance.setAt.trim().length === 0) {
    throw new Error("connector_instance_config: setAt must not be empty");
  }
}

/**
 * A revision may self-activate (no owner confirmation required) only when
 * it cannot change what is collected: proven `transport`, or the
 * manifest-materialized `default` applied at connection creation (nothing
 * was chosen; there is nothing to confirm). Every other collection_scope
 * write -- agent, script/migration, or even an owner write made through a
 * path that does not carry confirmation -- lands `proposed` and stays
 * inert until a separate confirmation call. This is the review's
 * acceptance attack #1 made structural: an agent's 239-ID write can never
 * itself become the connection's active configuration.
 */
function initialStatusFor(provenance: ConfigProvenance): ConfigRevisionStatus {
  if (provenance.optionKind === "transport") {
    return "active";
  }
  if (provenance.origin === "default" && !provenance.isExplicit) {
    return "active";
  }
  if (provenance.origin === "owner") {
    return "active";
  }
  return "proposed";
}

interface RevisionRow {
  collection_boundary_fingerprint: string | null;
  config_contract_id: string;
  config_contract_version: number;
  config_json: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  connector_instance_id: string;
  is_explicit: boolean | number;
  option_kind: string;
  origin: string;
  revision: number;
  set_at: string;
  set_by: string;
  source_of_change: string;
  status: string;
}

interface PointerRow {
  active_revision: number;
  connector_instance_id: string;
  storage_epoch: number;
  updated_at: string;
}

function mapRevisionRow(row: RevisionRow): ConfigRevision {
  return {
    connectorInstanceId: row.connector_instance_id,
    revision: Number(row.revision),
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    configContractId: row.config_contract_id,
    configContractVersion: Number(row.config_contract_version),
    optionKind: row.option_kind as ConfigOptionKind,
    origin: row.origin as ConfigOrigin,
    isExplicit: row.is_explicit === true || row.is_explicit === 1,
    status: row.status as ConfigRevisionStatus,
    collectionBoundaryFingerprint: row.collection_boundary_fingerprint,
    sourceOfChange: row.source_of_change,
    setBy: row.set_by,
    setAt: row.set_at,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
  };
}

function mapPointerRow(row: PointerRow): CurrentPointer {
  return {
    connectorInstanceId: row.connector_instance_id,
    activeRevision: Number(row.active_revision),
    storageEpoch: Number(row.storage_epoch),
    updatedAt: row.updated_at,
  };
}

export interface ProposeArgs {
  readonly baseEpoch: number;
  readonly baseRevision: number;
  readonly boundaryFingerprint?: string | null;
  readonly config: Record<string, unknown>;
  readonly connectorInstanceId: string;
  readonly provenance: ConfigProvenance;
}

export interface ConfirmArgs {
  readonly confirmedAt: string;
  readonly confirmedBy: string;
  readonly connectorInstanceId: string;
  readonly revision: number;
}

export interface ConnectorInstanceConfigStore {
  /** Move a `proposed` revision to `active`, superseding the previous active revision. Only meaningful for a non-self-activating (collection_scope, non-owner) revision. */
  confirm: (args: ConfirmArgs) => Promise<ConfigRevision>;
  getActiveRevision: (connectorInstanceId: string) => Promise<ConfigRevision | null>;
  getCurrentPointer: (connectorInstanceId: string) => Promise<CurrentPointer | null>;
  listRevisions: (connectorInstanceId: string) => Promise<ConfigRevision[]>;
  /**
   * Append a new immutable revision. Rejects with {@link ConfigStaleWriteError}
   * if `baseRevision`/`baseEpoch` do not match the connection's current
   * pointer -- optimistic concurrency, never a merge. A `transport` or
   * inherited-`default` revision activates immediately in the same
   * transaction that appends it; any other `collection_scope` write lands
   * `proposed` and requires a separate {@link confirm} call before any run
   * resolves against it.
   */
  propose: (args: ProposeArgs) => Promise<ConfigRevision>;
}

function nextRevisionSqlite(db: ReturnType<typeof getDb>, connectorInstanceId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM connector_instance_config_revisions WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as { next: number };
  return row.next;
}

function readPointerSqlite(connectorInstanceId: string): CurrentPointer | null {
  const row = getOne<PointerRow>(referenceQueries.connectorInstanceConfigGetCurrentPointer, [connectorInstanceId]);
  return row ? mapPointerRow(row) : null;
}

export function createSqliteConnectorInstanceConfigStore(): ConnectorInstanceConfigStore {
  return {
    async propose({ connectorInstanceId, config, provenance, baseRevision, baseEpoch, boundaryFingerprint }) {
      assertProvenanceOrThrow(provenance);
      return writeTransaction(() => {
        const db = getDb();
        const existingPointer = readPointerSqlite(connectorInstanceId);
        const currentRevision = existingPointer?.activeRevision ?? 0;
        const currentEpoch = existingPointer?.storageEpoch ?? 1;
        if (currentRevision !== baseRevision || currentEpoch !== baseEpoch) {
          throw new ConfigStaleWriteError(currentRevision, currentEpoch);
        }

        const revision = nextRevisionSqlite(db, connectorInstanceId);
        const status = initialStatusFor(provenance);
        db.prepare(
          `INSERT INTO connector_instance_config_revisions(
             connector_instance_id, revision, config_json, config_contract_id, config_contract_version,
             option_kind, origin, is_explicit, status, collection_boundary_fingerprint,
             source_of_change, set_by, set_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          connectorInstanceId,
          revision,
          JSON.stringify(config),
          CONNECTOR_CONFIG_CONTRACT_ID,
          CONNECTOR_CONFIG_CONTRACT_VERSION,
          provenance.optionKind,
          provenance.origin,
          provenance.isExplicit ? 1 : 0,
          status,
          boundaryFingerprint ?? null,
          provenance.sourceOfChange,
          provenance.setBy,
          provenance.setAt
        );

        if (status === "active") {
          if (existingPointer) {
            db.prepare(
              "UPDATE connector_instance_config_revisions SET status = 'superseded' WHERE connector_instance_id = ? AND revision = ?"
            ).run(connectorInstanceId, existingPointer.activeRevision);
          }
          db.prepare(
            `INSERT INTO connector_instance_config_current(connector_instance_id, active_revision, storage_epoch, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(connector_instance_id) DO UPDATE SET
               active_revision = excluded.active_revision,
               updated_at = excluded.updated_at`
          ).run(connectorInstanceId, revision, currentEpoch, provenance.setAt);
        }

        const written = getOne<RevisionRow>(referenceQueries.connectorInstanceConfigGetRevision, [
          connectorInstanceId,
          revision,
        ]);
        if (!written) {
          throw new Error(`connector_instance_config: revision did not persist for ${connectorInstanceId}/${revision}`);
        }
        return mapRevisionRow(written);
      });
    },

    async confirm({ connectorInstanceId, revision, confirmedBy, confirmedAt }) {
      if (confirmedBy.trim().length === 0) {
        throw new Error("connector_instance_config: confirmedBy must not be empty");
      }
      return writeTransaction(() => {
        const db = getDb();
        const target = getOne<RevisionRow>(referenceQueries.connectorInstanceConfigGetRevision, [
          connectorInstanceId,
          revision,
        ]);
        if (!target) {
          throw new Error(`connector_instance_config: no revision ${revision} for ${connectorInstanceId}`);
        }
        if (target.status !== "proposed") {
          throw new Error(
            `connector_instance_config: revision ${revision} is '${target.status}', not 'proposed' -- only a proposed revision can be confirmed`
          );
        }
        const pointer = readPointerSqlite(connectorInstanceId);
        db.prepare(
          "UPDATE connector_instance_config_revisions SET status = 'active', confirmed_by = ?, confirmed_at = ? WHERE connector_instance_id = ? AND revision = ?"
        ).run(confirmedBy, confirmedAt, connectorInstanceId, revision);
        if (pointer) {
          db.prepare(
            "UPDATE connector_instance_config_revisions SET status = 'superseded' WHERE connector_instance_id = ? AND revision = ?"
          ).run(connectorInstanceId, pointer.activeRevision);
        }
        db.prepare(
          `INSERT INTO connector_instance_config_current(connector_instance_id, active_revision, storage_epoch, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(connector_instance_id) DO UPDATE SET
             active_revision = excluded.active_revision,
             updated_at = excluded.updated_at`
        ).run(connectorInstanceId, revision, pointer?.storageEpoch ?? 1, confirmedAt);

        const confirmed = getOne<RevisionRow>(referenceQueries.connectorInstanceConfigGetRevision, [
          connectorInstanceId,
          revision,
        ]);
        if (!confirmed) {
          throw new Error(`connector_instance_config: revision vanished mid-confirm for ${connectorInstanceId}/${revision}`);
        }
        return mapRevisionRow(confirmed);
      });
    },

    async getCurrentPointer(connectorInstanceId) {
      return readPointerSqlite(connectorInstanceId);
    },

    async getActiveRevision(connectorInstanceId) {
      const pointer = readPointerSqlite(connectorInstanceId);
      if (!pointer) {
        return null;
      }
      const row = getOne<RevisionRow>(referenceQueries.connectorInstanceConfigGetRevision, [
        connectorInstanceId,
        pointer.activeRevision,
      ]);
      return row ? mapRevisionRow(row) : null;
    },

    async listRevisions(connectorInstanceId) {
      const { rows } = getMany<RevisionRow & Record<string, unknown>>(
        referenceQueries.connectorInstanceConfigListRevisionsByInstance,
        [connectorInstanceId],
        { limit: MAX_REVISIONS_PER_INSTANCE }
      );
      return rows.map((row) => mapRevisionRow(row));
    },
  };
}

async function readPointerPostgres(connectorInstanceId: string): Promise<CurrentPointer | null> {
  const result = await postgresQuery<PointerRow>(
    `SELECT connector_instance_id, active_revision, storage_epoch, updated_at
     FROM connector_instance_config_current WHERE connector_instance_id = $1`,
    [connectorInstanceId]
  );
  const row = result.rows[0];
  return row ? mapPointerRow(row) : null;
}

async function readRevisionPostgres(connectorInstanceId: string, revision: number): Promise<RevisionRow | undefined> {
  const result = await postgresQuery<RevisionRow>(
    `SELECT connector_instance_id, revision, config_json::text AS config_json, config_contract_id,
            config_contract_version, option_kind, origin, is_explicit, status,
            collection_boundary_fingerprint, source_of_change, set_by, set_at, confirmed_by, confirmed_at
     FROM connector_instance_config_revisions WHERE connector_instance_id = $1 AND revision = $2`,
    [connectorInstanceId, revision]
  );
  return result.rows[0];
}

export function createPostgresConnectorInstanceConfigStore(): ConnectorInstanceConfigStore {
  return {
    async propose({ connectorInstanceId, config, provenance, baseRevision, baseEpoch, boundaryFingerprint }) {
      assertProvenanceOrThrow(provenance);
      // Postgres path: no ambient cross-statement transaction helper is
      // wired here (unlike SQLite's writeTransaction), so concurrency
      // safety comes from the CAS check re-verified by the conditional
      // UPDATE below (WHERE active_revision = baseRevision), which is
      // atomic at the single-statement level even without an explicit
      // BEGIN/COMMIT wrapper.
      const existingPointer = await readPointerPostgres(connectorInstanceId);
      const currentRevision = existingPointer?.activeRevision ?? 0;
      const currentEpoch = existingPointer?.storageEpoch ?? 1;
      if (currentRevision !== baseRevision || currentEpoch !== baseEpoch) {
        throw new ConfigStaleWriteError(currentRevision, currentEpoch);
      }

      const nextRevisionResult = await postgresQuery<{ next: string }>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM connector_instance_config_revisions WHERE connector_instance_id = $1`,
        [connectorInstanceId]
      );
      const revision = Number(nextRevisionResult.rows[0]?.next ?? 1);
      const status = initialStatusFor(provenance);

      await postgresQuery(
        `INSERT INTO connector_instance_config_revisions(
           connector_instance_id, revision, config_json, config_contract_id, config_contract_version,
           option_kind, origin, is_explicit, status, collection_boundary_fingerprint,
           source_of_change, set_by, set_at
         ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          connectorInstanceId,
          revision,
          JSON.stringify(config),
          CONNECTOR_CONFIG_CONTRACT_ID,
          CONNECTOR_CONFIG_CONTRACT_VERSION,
          provenance.optionKind,
          provenance.origin,
          provenance.isExplicit,
          status,
          boundaryFingerprint ?? null,
          provenance.sourceOfChange,
          provenance.setBy,
          provenance.setAt,
        ]
      );

      if (status === "active") {
        if (existingPointer) {
          await postgresQuery(
            `UPDATE connector_instance_config_revisions SET status = 'superseded'
             WHERE connector_instance_id = $1 AND revision = $2`,
            [connectorInstanceId, existingPointer.activeRevision]
          );
        }
        await postgresQuery(
          `INSERT INTO connector_instance_config_current(connector_instance_id, active_revision, storage_epoch, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (connector_instance_id) DO UPDATE SET
             active_revision = excluded.active_revision,
             updated_at = excluded.updated_at`,
          [connectorInstanceId, revision, currentEpoch, provenance.setAt]
        );
      }

      const written = await readRevisionPostgres(connectorInstanceId, revision);
      if (!written) {
        throw new Error(`connector_instance_config: revision did not persist for ${connectorInstanceId}/${revision}`);
      }
      return mapRevisionRow(written);
    },

    async confirm({ connectorInstanceId, revision, confirmedBy, confirmedAt }) {
      if (confirmedBy.trim().length === 0) {
        throw new Error("connector_instance_config: confirmedBy must not be empty");
      }
      const target = await readRevisionPostgres(connectorInstanceId, revision);
      if (!target) {
        throw new Error(`connector_instance_config: no revision ${revision} for ${connectorInstanceId}`);
      }
      if (target.status !== "proposed") {
        throw new Error(
          `connector_instance_config: revision ${revision} is '${target.status}', not 'proposed' -- only a proposed revision can be confirmed`
        );
      }
      const pointer = await readPointerPostgres(connectorInstanceId);
      await postgresQuery(
        `UPDATE connector_instance_config_revisions SET status = 'active', confirmed_by = $1, confirmed_at = $2
         WHERE connector_instance_id = $3 AND revision = $4`,
        [confirmedBy, confirmedAt, connectorInstanceId, revision]
      );
      if (pointer) {
        await postgresQuery(
          `UPDATE connector_instance_config_revisions SET status = 'superseded'
           WHERE connector_instance_id = $1 AND revision = $2`,
          [connectorInstanceId, pointer.activeRevision]
        );
      }
      await postgresQuery(
        `INSERT INTO connector_instance_config_current(connector_instance_id, active_revision, storage_epoch, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (connector_instance_id) DO UPDATE SET
           active_revision = excluded.active_revision,
           updated_at = excluded.updated_at`,
        [connectorInstanceId, revision, pointer?.storageEpoch ?? 1, confirmedAt]
      );
      const confirmed = await readRevisionPostgres(connectorInstanceId, revision);
      if (!confirmed) {
        throw new Error(`connector_instance_config: revision vanished mid-confirm for ${connectorInstanceId}/${revision}`);
      }
      return mapRevisionRow(confirmed);
    },

    async getCurrentPointer(connectorInstanceId) {
      return readPointerPostgres(connectorInstanceId);
    },

    async getActiveRevision(connectorInstanceId) {
      const pointer = await readPointerPostgres(connectorInstanceId);
      if (!pointer) {
        return null;
      }
      const row = await readRevisionPostgres(connectorInstanceId, pointer.activeRevision);
      return row ? mapRevisionRow(row) : null;
    },

    async listRevisions(connectorInstanceId) {
      const result = await postgresQuery<RevisionRow>(
        `SELECT connector_instance_id, revision, config_json::text AS config_json, config_contract_id,
                config_contract_version, option_kind, origin, is_explicit, status,
                collection_boundary_fingerprint, source_of_change, set_by, set_at, confirmed_by, confirmed_at
         FROM connector_instance_config_revisions
         WHERE connector_instance_id = $1
         ORDER BY revision DESC
         LIMIT $2`,
        [connectorInstanceId, MAX_REVISIONS_PER_INSTANCE]
      );
      return result.rows.map((row) => mapRevisionRow(row));
    },
  };
}
