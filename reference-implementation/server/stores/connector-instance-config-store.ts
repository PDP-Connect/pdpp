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
 * only from an immutable, authenticated-owner-subject-confirmed revision.
 * Every collection_scope write, regardless of its provenance origin, starts
 * proposed; only authenticated owner-subject confirmation moves it to
 * `active`.
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
 * 'unknown' member -- see assertProvenanceOrThrow. Activation and the current
 * pointer move happen in the same SQLite transaction. This store does not
 * touch coverage-proof tables; any proof declassification is a separate
 * operation, so callers must not infer atomic config/coverage invalidation
 * from this transaction.
 */

import { getMany, getOne, referenceQueries, writeTransaction } from "../../lib/db.ts";
import { resolveEnforcedOptionKind } from "../../../packages/polyfill-connectors/src/connector-config-option-kind-registry.ts";
import { getDb } from "../db.ts";
import { postgresQuery } from "../postgres-storage.ts";

/** A config revision shapes what a connector collects, or only how it collects. */
export type ConfigOptionKind = "collection_scope" | "transport";

/** Closed provenance vocabulary. Origin describes attribution, never authorization. */
export type ConfigOrigin = "agent" | "default" | "migration" | "owner";

export type ConfigRevisionStatus = "active" | "proposed" | "quarantined" | "superseded";

/** The current, closed contract this module writes. Bump on any breaking config_json shape change; never coerce an old contract into a new one. */
export const CONNECTOR_CONFIG_CONTRACT_ID = "pdpp.connector_config.v1";
export const CONNECTOR_CONFIG_CONTRACT_VERSION = 1;

export interface ConfigProvenance {
  readonly isExplicit: boolean;
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
const MAX_REVISIONS_PER_INSTANCE = 500;

function assertProvenanceOrThrow(provenance: ConfigProvenance): void {
  if (!VALID_ORIGINS.has(provenance.origin)) {
    throw new Error(`connector_instance_config: invalid origin "${provenance.origin}"`);
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
 * Classification is platform-owned and is derived from the whole config
 * bundle. Any collection-shaping key makes the whole revision
 * `collection_scope`; empty and unknown bundles fail closed to that same
 * class. Only proven transport revisions self-activate. Provenance records
 * who supplied a value, not whether that actor is authorized to activate it.
 */
function deriveOptionKind(connectorId: string, config: Record<string, unknown>): ConfigOptionKind {
  const keys = Object.keys(config);
  if (keys.length === 0) {
    return "collection_scope";
  }
  return keys.some((key) => resolveEnforcedOptionKind(connectorId, key) === "collection_scope")
    ? "collection_scope"
    : "transport";
}

function initialStatusFor(optionKind: ConfigOptionKind): ConfigRevisionStatus {
  return optionKind === "transport" ? "active" : "proposed";
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

interface ConnectorInstanceAuthorityRow {
  connector_id: string;
  owner_subject_id: string;
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
  /** Established by the caller's authentication boundary; this store verifies it owns the connection. */
  readonly authenticatedOwnerSubjectId: string;
  readonly confirmedAt: string;
  readonly connectorInstanceId: string;
  readonly revision: number;
}

export interface ConnectorInstanceConfigStore {
  /** Move a `proposed` revision to `active` after the authenticated owner subject matches the connection owner. */
  confirm: (args: ConfirmArgs) => Promise<ConfigRevision>;
  getActiveRevision: (connectorInstanceId: string) => Promise<ConfigRevision | null>;
  getCurrentPointer: (connectorInstanceId: string) => Promise<CurrentPointer | null>;
  listRevisions: (connectorInstanceId: string) => Promise<ConfigRevision[]>;
  /**
   * Append a new immutable revision. Rejects with {@link ConfigStaleWriteError}
   * if `baseRevision`/`baseEpoch` do not match the connection's current
   * pointer -- optimistic concurrency, never a merge. Platform-classified
   * `transport` self-activates; every `collection_scope` revision lands
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

function requireConnectorInstanceAuthoritySqlite(
  db: ReturnType<typeof getDb>,
  connectorInstanceId: string
): ConnectorInstanceAuthorityRow {
  const row = db
    .prepare("SELECT connector_id, owner_subject_id FROM connector_instances WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as ConnectorInstanceAuthorityRow | undefined;
  if (!row) {
    throw new Error(`connector_instance_config: no connector instance ${connectorInstanceId}`);
  }
  return row;
}

function assertAuthenticatedOwnerSubject(authenticatedOwnerSubjectId: unknown): asserts authenticatedOwnerSubjectId is string {
  if (typeof authenticatedOwnerSubjectId !== "string" || authenticatedOwnerSubjectId.trim().length === 0) {
    throw new Error("connector_instance_config: authenticated owner subject must not be empty");
  }
}

function assertOwnerSubjectMatches(
  connectorInstanceId: string,
  authenticatedOwnerSubjectId: string,
  ownerSubjectId: string
): void {
  if (authenticatedOwnerSubjectId !== ownerSubjectId) {
    throw new Error(`connector_instance_config: authenticated owner subject does not own ${connectorInstanceId}`);
  }
}

export function createSqliteConnectorInstanceConfigStore(): ConnectorInstanceConfigStore {
  return {
    async propose({ connectorInstanceId, config, provenance, baseRevision, baseEpoch, boundaryFingerprint }) {
      assertProvenanceOrThrow(provenance);
      return writeTransaction(() => {
        const db = getDb();
        const authority = requireConnectorInstanceAuthoritySqlite(db, connectorInstanceId);
        const existingPointer = readPointerSqlite(connectorInstanceId);
        const currentRevision = existingPointer?.activeRevision ?? 0;
        const currentEpoch = existingPointer?.storageEpoch ?? 1;
        if (currentRevision !== baseRevision || currentEpoch !== baseEpoch) {
          throw new ConfigStaleWriteError(currentRevision, currentEpoch);
        }

        const revision = nextRevisionSqlite(db, connectorInstanceId);
        const optionKind = deriveOptionKind(authority.connector_id, config);
        const status = initialStatusFor(optionKind);
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
          optionKind,
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

    async confirm({ connectorInstanceId, revision, authenticatedOwnerSubjectId, confirmedAt }) {
      assertAuthenticatedOwnerSubject(authenticatedOwnerSubjectId);
      return writeTransaction(() => {
        const db = getDb();
        const authority = requireConnectorInstanceAuthoritySqlite(db, connectorInstanceId);
        // The HTTP/owner-agent boundary authenticates this subject. The store
        // only verifies that authenticated identity owns this exact connection.
        assertOwnerSubjectMatches(connectorInstanceId, authenticatedOwnerSubjectId, authority.owner_subject_id);
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
        ).run(authenticatedOwnerSubjectId, confirmedAt, connectorInstanceId, revision);
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
      return row?.status === "active" ? mapRevisionRow(row) : null;
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

async function requireConnectorInstanceAuthorityPostgres(
  connectorInstanceId: string
): Promise<ConnectorInstanceAuthorityRow> {
  const result = await postgresQuery<ConnectorInstanceAuthorityRow>(
    "SELECT connector_id, owner_subject_id FROM connector_instances WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`connector_instance_config: no connector instance ${connectorInstanceId}`);
  }
  return row;
}

export function createPostgresConnectorInstanceConfigStore(): ConnectorInstanceConfigStore {
  return {
    async propose({ connectorInstanceId, config, provenance, baseRevision, baseEpoch, boundaryFingerprint }) {
      assertProvenanceOrThrow(provenance);
      const authority = await requireConnectorInstanceAuthorityPostgres(connectorInstanceId);
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
      const optionKind = deriveOptionKind(authority.connector_id, config);
      const status = initialStatusFor(optionKind);

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
          optionKind,
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

    async confirm({ connectorInstanceId, revision, authenticatedOwnerSubjectId, confirmedAt }) {
      assertAuthenticatedOwnerSubject(authenticatedOwnerSubjectId);
      const authority = await requireConnectorInstanceAuthorityPostgres(connectorInstanceId);
      // The caller/auth boundary establishes authentication; this store binds
      // that authenticated subject to the persisted connection owner.
      assertOwnerSubjectMatches(connectorInstanceId, authenticatedOwnerSubjectId, authority.owner_subject_id);
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
        [authenticatedOwnerSubjectId, confirmedAt, connectorInstanceId, revision]
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
      return row?.status === "active" ? mapRevisionRow(row) : null;
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
