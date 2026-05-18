import { createHash } from 'node:crypto';

import { exec, getMany, getOne, referenceQueries } from '../../lib/db.ts';
import { postgresQuery } from '../postgres-storage.js';

const ACTIVE_RESOLUTION_LIMIT = 2;
const LIST_LIMIT = 500;
const VALID_STATUSES = new Set(['active', 'paused', 'revoked']);
const VALID_SOURCE_KINDS = new Set(['account', 'local_device', 'manual', 'legacy']);

export class ConnectorInstanceResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConnectorInstanceResolutionError';
    this.code = code;
    Object.assign(this, details);
  }
}

function stableJson(value) {
  if (value == null) return '{}';
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashKey(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function makeLegacyConnectorInstanceId(ownerSubjectId, connectorId) {
  return `cin_legacy_${hashKey(`${ownerSubjectId}\n${connectorId}`).slice(0, 24)}`;
}

function normalizeRecord(record) {
  if (!record.ownerSubjectId) throw new Error('ownerSubjectId is required.');
  if (!record.connectorId) throw new Error('connectorId is required.');
  const sourceKind = record.sourceKind ?? 'manual';
  if (!VALID_SOURCE_KINDS.has(sourceKind)) {
    throw new Error(`Invalid connector instance sourceKind '${sourceKind}'.`);
  }
  const status = record.status ?? 'active';
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid connector instance status '${status}'.`);
  }
  const sourceBindingJson = stableJson(record.sourceBinding ?? {});
  const sourceBindingKey = record.sourceBindingKey ?? hashKey(sourceBindingJson);
  return {
    connectorInstanceId: record.connectorInstanceId ?? `cin_${hashKey(`${record.ownerSubjectId}\n${record.connectorId}\n${sourceKind}\n${sourceBindingKey}`).slice(0, 24)}`,
    ownerSubjectId: record.ownerSubjectId,
    connectorId: record.connectorId,
    displayName: record.displayName ?? record.connectorId,
    status,
    sourceKind,
    sourceBindingKey,
    sourceBindingJson,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt ?? null,
  };
}

function mapInstance(row) {
  if (!row) return null;
  return {
    connectorInstanceId: row.connector_instance_id,
    ownerSubjectId: row.owner_subject_id,
    connectorId: row.connector_id,
    displayName: row.display_name,
    status: row.status,
    sourceKind: row.source_kind,
    sourceBindingKey: row.source_binding_key,
    sourceBinding: typeof row.source_binding_json === 'string'
      ? JSON.parse(row.source_binding_json)
      : row.source_binding_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function resolveSingleActive(rows, ownerSubjectId, connectorId) {
  if (rows.length === 0) {
    throw new ConnectorInstanceResolutionError(
      'connector_instance_not_found',
      `No active connector instance exists for owner '${ownerSubjectId}' and connector '${connectorId}'.`,
      { ownerSubjectId, connectorId },
    );
  }
  if (rows.length > 1) {
    throw new ConnectorInstanceResolutionError(
      'ambiguous_connector_instance',
      `Connector '${connectorId}' has multiple active instances for owner '${ownerSubjectId}'.`,
      { ownerSubjectId, connectorId },
    );
  }
  return rows[0];
}

function namespaceFromInstance(instance, { selector, createdLegacyDefault = false } = {}) {
  return {
    ownerSubjectId: instance.ownerSubjectId,
    connectorId: instance.connectorId,
    connectorInstanceId: instance.connectorInstanceId,
    displayName: instance.displayName,
    status: instance.status,
    sourceKind: instance.sourceKind,
    sourceBindingKey: instance.sourceBindingKey,
    sourceBinding: instance.sourceBinding,
    selector,
    createdLegacyDefault,
  };
}

export async function resolveOwnerConnectorInstanceNamespace({
  ownerSubjectId,
  connectorId = null,
  connectorInstanceId = null,
  connectorInstanceStore,
  allowLegacyDefault = false,
  displayName = null,
  now = new Date().toISOString(),
}) {
  if (!ownerSubjectId) {
    throw new ConnectorInstanceResolutionError(
      'owner_subject_required',
      'ownerSubjectId is required to resolve a connector instance namespace.',
    );
  }
  if (!connectorInstanceStore) {
    throw new ConnectorInstanceResolutionError(
      'connector_instance_store_required',
      'connectorInstanceStore is required to resolve a connector instance namespace.',
      { ownerSubjectId, connectorId, connectorInstanceId },
    );
  }

  if (connectorInstanceId) {
    const instance = await connectorInstanceStore.get(connectorInstanceId);
    if (!instance) {
      throw new ConnectorInstanceResolutionError(
        'connector_instance_not_found',
        `Connector instance '${connectorInstanceId}' does not exist.`,
        { ownerSubjectId, connectorId, connectorInstanceId },
      );
    }
    if (instance.ownerSubjectId !== ownerSubjectId) {
      throw new ConnectorInstanceResolutionError(
        'connector_instance_owner_mismatch',
        `Connector instance '${connectorInstanceId}' does not belong to owner '${ownerSubjectId}'.`,
        { ownerSubjectId, actualOwnerSubjectId: instance.ownerSubjectId, connectorId, connectorInstanceId },
      );
    }
    if (connectorId && instance.connectorId !== connectorId) {
      throw new ConnectorInstanceResolutionError(
        'connector_instance_connector_mismatch',
        `Connector instance '${connectorInstanceId}' belongs to connector '${instance.connectorId}', not '${connectorId}'.`,
        { ownerSubjectId, connectorId, actualConnectorId: instance.connectorId, connectorInstanceId },
      );
    }
    if (instance.status !== 'active') {
      throw new ConnectorInstanceResolutionError(
        'connector_instance_inactive',
        `Connector instance '${connectorInstanceId}' is '${instance.status}', not active.`,
        { ownerSubjectId, connectorId: instance.connectorId, connectorInstanceId, status: instance.status },
      );
    }
    return namespaceFromInstance(instance, { selector: 'connector_instance_id' });
  }

  if (!connectorId) {
    throw new ConnectorInstanceResolutionError(
      'connector_instance_selector_required',
      'Provide connector_instance_id or connector_id to resolve a connector instance namespace.',
      { ownerSubjectId },
    );
  }

  try {
    const instance = await connectorInstanceStore.resolveActiveByConnector(ownerSubjectId, connectorId);
    return namespaceFromInstance(instance, { selector: 'connector_id' });
  } catch (err) {
    if (!allowLegacyDefault || !(err instanceof ConnectorInstanceResolutionError) || err.code !== 'connector_instance_not_found') {
      throw err;
    }
  }

  const instance = await connectorInstanceStore.ensureLegacyDefault({
    ownerSubjectId,
    connectorId,
    displayName: displayName ?? connectorId,
    now,
  });
  return namespaceFromInstance(instance, { selector: 'connector_id', createdLegacyDefault: true });
}

export function createSqliteConnectorInstanceStore() {
  return {
    upsert(record) {
      const normalized = normalizeRecord(record);
      exec(referenceQueries.connectorInstancesInsert, [
        normalized.connectorInstanceId,
        normalized.ownerSubjectId,
        normalized.connectorId,
        normalized.displayName,
        normalized.status,
        normalized.sourceKind,
        normalized.sourceBindingKey,
        normalized.sourceBindingJson,
        normalized.createdAt,
        normalized.updatedAt,
        normalized.revokedAt,
      ]);
      return this.get(normalized.connectorInstanceId);
    },

    ensureLegacyDefault({ ownerSubjectId, connectorId, displayName, now }) {
      return this.upsert({
        connectorInstanceId: makeLegacyConnectorInstanceId(ownerSubjectId, connectorId),
        ownerSubjectId,
        connectorId,
        displayName: displayName ?? connectorId,
        status: 'active',
        sourceKind: 'legacy',
        sourceBindingKey: 'default',
        sourceBinding: { kind: 'legacy_default' },
        createdAt: now,
        updatedAt: now,
      });
    },

    get(connectorInstanceId) {
      return mapInstance(getOne(referenceQueries.connectorInstancesGetById, [connectorInstanceId]));
    },

    getByBinding({ ownerSubjectId, connectorId, sourceKind, sourceBindingKey }) {
      return mapInstance(
        getOne(referenceQueries.connectorInstancesGetByBinding, [
          ownerSubjectId,
          connectorId,
          sourceKind,
          sourceBindingKey,
        ]),
      );
    },

    listByOwner(ownerSubjectId, { limit = LIST_LIMIT } = {}) {
      return getMany(referenceQueries.connectorInstancesListByOwner, [ownerSubjectId], { limit }).rows.map(mapInstance);
    },

    resolveActiveByConnector(ownerSubjectId, connectorId) {
      const rows = getMany(
        referenceQueries.connectorInstancesListActiveByOwnerConnector,
        [ownerSubjectId, connectorId],
        { limit: ACTIVE_RESOLUTION_LIMIT },
      ).rows.map(mapInstance);
      return resolveSingleActive(rows, ownerSubjectId, connectorId);
    },

    updateStatus(connectorInstanceId, { status, updatedAt, revokedAt = null }) {
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`Invalid connector instance status '${status}'.`);
      }
      exec(referenceQueries.connectorInstancesUpdateStatus, [status, updatedAt, revokedAt, connectorInstanceId]);
      return this.get(connectorInstanceId);
    },
  };
}

export function createPostgresConnectorInstanceStore() {
  return {
    async upsert(record) {
      const normalized = normalizeRecord(record);
      await postgresQuery(
        `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
         ON CONFLICT(owner_subject_id, connector_id, source_kind, source_binding_key) DO UPDATE SET
           display_name = excluded.display_name,
           status = excluded.status,
           source_binding_json = excluded.source_binding_json,
           updated_at = excluded.updated_at,
           revoked_at = excluded.revoked_at`,
        [
          normalized.connectorInstanceId,
          normalized.ownerSubjectId,
          normalized.connectorId,
          normalized.displayName,
          normalized.status,
          normalized.sourceKind,
          normalized.sourceBindingKey,
          normalized.sourceBindingJson,
          normalized.createdAt,
          normalized.updatedAt,
          normalized.revokedAt,
        ],
      );
      return await this.get(normalized.connectorInstanceId);
    },

    async ensureLegacyDefault({ ownerSubjectId, connectorId, displayName, now }) {
      return await this.upsert({
        connectorInstanceId: makeLegacyConnectorInstanceId(ownerSubjectId, connectorId),
        ownerSubjectId,
        connectorId,
        displayName: displayName ?? connectorId,
        status: 'active',
        sourceKind: 'legacy',
        sourceBindingKey: 'default',
        sourceBinding: { kind: 'legacy_default' },
        createdAt: now,
        updatedAt: now,
      });
    },

    async get(connectorInstanceId) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      return mapInstance(result.rows[0]);
    },

    async getByBinding({ ownerSubjectId, connectorId, sourceKind, sourceBindingKey }) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1 AND connector_id = $2 AND source_kind = $3 AND source_binding_key = $4`,
        [ownerSubjectId, connectorId, sourceKind, sourceBindingKey],
      );
      return mapInstance(result.rows[0]);
    },

    async listByOwner(ownerSubjectId, { limit = LIST_LIMIT } = {}) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1
         ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
         LIMIT $2`,
        [ownerSubjectId, limit],
      );
      return result.rows.map(mapInstance);
    },

    async resolveActiveByConnector(ownerSubjectId, connectorId) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1 AND connector_id = $2 AND status = 'active'
         ORDER BY created_at ASC, connector_instance_id ASC
         LIMIT $3`,
        [ownerSubjectId, connectorId, ACTIVE_RESOLUTION_LIMIT],
      );
      return resolveSingleActive(result.rows.map(mapInstance), ownerSubjectId, connectorId);
    },

    async updateStatus(connectorInstanceId, { status, updatedAt, revokedAt = null }) {
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`Invalid connector instance status '${status}'.`);
      }
      await postgresQuery(
        `UPDATE connector_instances SET status = $1, updated_at = $2, revoked_at = $3 WHERE connector_instance_id = $4`,
        [status, updatedAt, revokedAt, connectorInstanceId],
      );
      return await this.get(connectorInstanceId);
    },
  };
}
