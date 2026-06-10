import { createHash } from 'node:crypto';

import { allowUnboundedReadAcknowledged, exec, getMany, getOne, referenceQueries, writeTransaction } from '../../lib/db.ts';
import { postgresQuery, withPostgresTransaction } from '../postgres-storage.js';

const ACTIVE_RESOLUTION_LIMIT = 2;
const ACTIVE_FANIN_LIMIT = 64;
const LIST_LIMIT = 500;
// `draft` is reserved for static-secret owner-session connection setup: a real
// connector_instances row that is excluded from every connection read surface
// until its first successful ingest flips it to `active`. Only the owner-session
// static-secret draft-create surface produces a `draft`; no other
// materialization path does. See add-static-secret-owner-session-connect-path
// design Decision 1.
const VALID_STATUSES = new Set(['active', 'paused', 'revoked', 'draft']);
// Statuses hidden from `listByOwner` (the single choke point for every
// connection read surface). A draft must never appear in a list, count, or
// dashboard view. See Decision 2.
const READ_SURFACE_HIDDEN_STATUSES = new Set(['draft']);
// `browser_collector` is a peer of `local_device` on the connector-instance
// source-binding axis: a binding collected by a local collector driving a
// browser session for a browser-bound connector. See
// add-browser-collector-enrollment-primitive design Decision 1.
const VALID_SOURCE_KINDS = new Set(['account', 'local_device', 'browser_collector', 'manual']);
const DEFAULT_ACCOUNT_SOURCE_BINDING_KEY = 'default';
const DEFAULT_ACCOUNT_SOURCE_BINDING = Object.freeze({ kind: 'default_account' });

export class ConnectorInstanceResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConnectorInstanceResolutionError';
    this.code = code;
    Object.assign(this, details);
  }
}

// Thrown by `deleteConnection` when the cascade is refused for a typed reason
// (an in-flight run holds the active-run lease, or the connection is a
// default-account binding whose deterministic id would silently re-materialize
// — see Decision 1). The route maps `code` to the HTTP status via
// `codeToStatus` (connection_run_active → 409, default_account_delete_unsupported
// → 409). Distinct from ConnectorInstanceResolutionError so a delete-refusal is
// never confused with a not-found/ownership outcome.
export class ConnectorInstanceDeleteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConnectorInstanceDeleteError';
    this.code = code;
    Object.assign(this, details);
  }
}

// Shared precondition check for `deleteConnection` on both backends. Resolves
// the row, verifies owner ownership BEFORE any mutation (foreign/unknown id →
// connector_instance_not_found, which the route maps to 404 without leaking
// existence — invariant I5), refuses an in-flight active run (I7), and refuses a
// default-account binding whose deterministic id would re-materialize (I6,
// Decision 1 fallback: typed-unsupported rather than a half-built tombstone).
// Returns the resolved instance when the delete may proceed.
function assertDeletableConnection(instance, { connectorInstanceId, ownerSubjectId, hasActiveRun }) {
  if (!instance || instance.ownerSubjectId !== ownerSubjectId) {
    // Absent OR foreign — both surface as not-found so existence is not leaked
    // across owners and a repeat delete of an already-deleted id is typed.
    throw new ConnectorInstanceResolutionError(
      'connector_instance_not_found',
      `Connector instance '${connectorInstanceId}' does not exist for owner '${ownerSubjectId}'.`,
      { ownerSubjectId, connectorInstanceId },
    );
  }
  if (hasActiveRun) {
    throw new ConnectorInstanceDeleteError(
      'connection_run_active',
      `Connection '${connectorInstanceId}' has an active collection run; stop or await the run before deleting.`,
      { ownerSubjectId, connectorInstanceId },
    );
  }
  if (instance.sourceKind === 'account' && instance.sourceBindingKey === DEFAULT_ACCOUNT_SOURCE_BINDING_KEY) {
    // The default-account id is deterministic, so a hard row delete would be
    // silently re-materialized to active (with zero records) by the next
    // `ensureDefaultAccountConnection` read. This slice does not ship the
    // tombstone ledger that would let the materialization path refuse a
    // deleted binding, so default-account delete stays typed-unsupported
    // rather than shipping silent resurrection. Device-collected and explicit
    // (non-default) account connections have non-deterministic binding keys and
    // are deletable. See add-owner-connection-delete-contract Decision 1.
    throw new ConnectorInstanceDeleteError(
      'default_account_delete_unsupported',
      `Connection '${connectorInstanceId}' is a default-account binding; deleting it is not supported until a deletion tombstone exists, because the deterministic default-account id would otherwise silently re-materialize on the next owner read. Revoke it instead, or re-initiate to replace it.`,
      { ownerSubjectId, connectorInstanceId, connectorId: instance.connectorId },
    );
  }
  return instance;
}

// Non-secret deletion summary returned by `deleteConnection` for the audit
// event + route response. Carries only counts and stable identifiers — never
// record contents or secrets.
function buildDeleteSummary(instance, { deletedRecordCount, deletedStreamCount, scheduleDeleted, deviceRefsCleared }) {
  return {
    connection_id: instance.connectorInstanceId,
    connector_id: instance.connectorId,
    source_kind: instance.sourceKind,
    deleted_record_count: deletedRecordCount,
    deleted_stream_count: deletedStreamCount,
    schedule_deleted: scheduleDeleted,
    device_refs_cleared: deviceRefsCleared,
  };
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

export function makeConnectorInstanceSourceBindingKey(sourceBinding) {
  return hashKey(stableJson(sourceBinding ?? {}));
}

export function makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId) {
  return `cin_${hashKey(`${ownerSubjectId}\n${connectorId}\naccount\n${DEFAULT_ACCOUNT_SOURCE_BINDING_KEY}`).slice(0, 24)}`;
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
  const sourceBindingKey = record.sourceBindingKey ?? makeConnectorInstanceSourceBindingKey(record.sourceBinding ?? {});
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

function namespaceFromInstance(instance, { selector, createdDefaultAccount = false } = {}) {
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
    createdDefaultAccount,
  };
}

export async function resolveOwnerConnectorInstanceNamespace({
  ownerSubjectId,
  connectorId = null,
  connectorInstanceId = null,
  connectorInstanceStore,
  allowDefaultAccount = false,
  // Statuses admissible when an instance is addressed explicitly by
  // connector_instance_id. Defaults to active-only. ONLY the owner-session
  // capture path and the owner-authenticated first-ingest path pass
  // `['active', 'draft']` to reach a static-secret draft. No grant-scoped,
  // client, MCP, or owner-agent READ path passes a non-default value, so a
  // draft is never resolvable as a read target. See
  // add-static-secret-owner-session-connect-path design Decision 3.
  allowStatuses = ['active'],
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
      // Older grant/storage bindings can use connector_id as a default
      // account instance hint. Resolve that through the same default-account
      // path instead of treating the connector id as a literal instance id.
      if (allowDefaultAccount && connectorId && connectorInstanceId === connectorId) {
        // intentional fall-through to the connector_id resolution path
      } else {
        throw new ConnectorInstanceResolutionError(
          'connector_instance_not_found',
          `Connector instance '${connectorInstanceId}' does not exist.`,
          { ownerSubjectId, connectorId, connectorInstanceId },
        );
      }
    } else {
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
      if (!allowStatuses.includes(instance.status)) {
        throw new ConnectorInstanceResolutionError(
          'connector_instance_inactive',
          `Connector instance '${connectorInstanceId}' is '${instance.status}', not active.`,
          { ownerSubjectId, connectorId: instance.connectorId, connectorInstanceId, status: instance.status },
        );
      }
      return namespaceFromInstance(instance, { selector: 'connector_instance_id' });
    }
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
    if (!allowDefaultAccount || !(err instanceof ConnectorInstanceResolutionError) || err.code !== 'connector_instance_not_found') {
      throw err;
    }
  }

  try {
    const instance = await connectorInstanceStore.ensureDefaultAccountConnection({
      ownerSubjectId,
      connectorId,
      displayName: displayName ?? connectorId,
      now,
    });
    // The default-account materialization respects a deliberate revoke (it
    // returns the revoked row unchanged rather than resurrecting it). A
    // non-active row is therefore NOT a usable namespace: surface it as
    // "no active connection" so the ingest/write path fails closed (the write
    // is refused) and read callers that tolerate connector_instance_not_found
    // fall through to their no-active-source handling, instead of binding to
    // a revoked connection. This is the load-bearing half of the durability
    // guard — without it, the store-level guard alone would still hand back a
    // revoked namespace. See add-owner-agent-control-surface design
    // "Deferred: connection-revoke durability" → Unit 1.
    if (instance.status !== 'active') {
      throw new ConnectorInstanceResolutionError(
        'connector_instance_not_found',
        `No active default-account connection exists for owner '${ownerSubjectId}' and connector '${connectorId}'; the default-account connection is '${instance.status}'.`,
        { ownerSubjectId, connectorId, connectorInstanceId: instance.connectorInstanceId, status: instance.status },
      );
    }
    return namespaceFromInstance(instance, { selector: 'connector_id', createdDefaultAccount: true });
  } catch (err) {
    // The connector_instances row references connectors(connector_id). If
    // the connector is not registered (e.g. the grant points at a stale
    // connector id or a synthetic native-storage id that never lived in
    // the catalog), the default-account upsert fails its FK check. Surface
    // this as a clean connector_instance_not_found so the caller can map
    // it to the right "unknown connector" 404 instead of bubbling SQLite's
    // 500.
    if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || err?.code === '23503') {
      throw new ConnectorInstanceResolutionError(
        'connector_instance_not_found',
        `Connector '${connectorId}' is not registered; no connector instance namespace available.`,
        { ownerSubjectId, connectorId },
      );
    }
    throw err;
  }
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

    ensureDefaultAccountConnection({ ownerSubjectId, connectorId, displayName, now }) {
      // Durability guard: a deliberately-revoked default-account connection
      // MUST NOT be silently resurrected to active. Read the deterministically
      // keyed row first; if the owner revoked it, return it unchanged so the
      // revoke survives. Only a missing or active row materializes/upserts.
      // The device re-enroll path upserts under a different source_binding_key
      // and never reaches this method, so its reactivation semantics are
      // untouched. See add-owner-agent-control-surface design "Deferred:
      // connection-revoke durability" → Unit 1.
      const existing = this.getByBinding({
        ownerSubjectId,
        connectorId,
        sourceKind: 'account',
        sourceBindingKey: DEFAULT_ACCOUNT_SOURCE_BINDING_KEY,
      });
      if (existing && existing.status === 'revoked') {
        return existing;
      }
      return this.upsert({
        connectorInstanceId: makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId),
        ownerSubjectId,
        connectorId,
        displayName: displayName ?? connectorId,
        status: 'active',
        sourceKind: 'account',
        sourceBindingKey: DEFAULT_ACCOUNT_SOURCE_BINDING_KEY,
        sourceBinding: { ...DEFAULT_ACCOUNT_SOURCE_BINDING },
        createdAt: now,
        updatedAt: now,
      });
    },

    get(connectorInstanceId) {
      return mapInstance(getOne(referenceQueries.connectorInstancesGetById, [connectorInstanceId]));
    },

    // Non-secret in-flight-run lookup for ONE connection, keyed on
    // connector_instance_id. `controller_active_runs` holds exactly one row per
    // connection with a controller-managed run currently in flight (the same
    // table `deleteConnection` reads to refuse an active-run delete). Returns
    // `{ runId, connectorId, startedAt }` for the live run or `null` when idle.
    // This is the persistent link from a static-secret `draft` connection to
    // its first sync, so the owner setup-status surface can show "first sync
    // running" without scanning connector-keyed run history. The enumeration is
    // bounded (one row per registered connector) and read-only.
    getActiveRun(connectorInstanceId) {
      const rows = allowUnboundedReadAcknowledged(referenceQueries.controllerListActiveRuns);
      const row = rows.find((run) => run.connector_instance_id === connectorInstanceId);
      if (!row) {
        return null;
      }
      return { runId: row.run_id, connectorId: row.connector_id, startedAt: row.started_at };
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
      // Draft instances are invisible to every connection read surface; the
      // `connectorInstancesListByOwner` query excludes `status = 'draft'` in
      // SQL (so the LIMIT window counts only visible rows). The JS post-filter
      // below is defense-in-depth in case the query is ever swapped. This is
      // the single choke point that hides drafts from the dashboard,
      // /_ref/connections, /_ref/connector-instances, owner-agent reads,
      // templates, and device-exporter listings. See Decision 2.
      return getMany(referenceQueries.connectorInstancesListByOwner, [ownerSubjectId], { limit })
        .rows.map(mapInstance)
        .filter((instance) => !READ_SURFACE_HIDDEN_STATUSES.has(instance.status));
    },

    resolveActiveByConnector(ownerSubjectId, connectorId) {
      const rows = getMany(
        referenceQueries.connectorInstancesListActiveByOwnerConnector,
        [ownerSubjectId, connectorId],
        { limit: ACTIVE_RESOLUTION_LIMIT },
      ).rows.map(mapInstance);
      return resolveSingleActive(rows, ownerSubjectId, connectorId);
    },

    listActiveByConnector(ownerSubjectId, connectorId, { limit = ACTIVE_FANIN_LIMIT } = {}) {
      return getMany(
        referenceQueries.connectorInstancesListActiveByOwnerConnector,
        [ownerSubjectId, connectorId],
        { limit },
      ).rows.map(mapInstance);
    },

    updateStatus(connectorInstanceId, { status, updatedAt, revokedAt = null }) {
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`Invalid connector instance status '${status}'.`);
      }
      exec(referenceQueries.connectorInstancesUpdateStatus, [status, updatedAt, revokedAt, connectorInstanceId]);
      return this.get(connectorInstanceId);
    },

    // Flip a static-secret draft to active on its first successful ingest.
    // No-op when the row is missing or not `draft` (idempotent and safe under a
    // concurrent first run — a second activation finds the row already active).
    // Never moves a paused/revoked row to active. See
    // add-static-secret-owner-session-connect-path design Decision 5.
    activateDraft(connectorInstanceId, { now } = {}) {
      const instance = this.get(connectorInstanceId);
      if (!instance || instance.status !== 'draft') {
        return instance;
      }
      return this.updateStatus(connectorInstanceId, {
        status: 'active',
        updatedAt: now ?? new Date().toISOString(),
        revokedAt: null,
      });
    },

    setDisplayName(connectorInstanceId, { ownerSubjectId, displayName, updatedAt }) {
      assertOwnerSetDisplayNameArgs({ connectorInstanceId, ownerSubjectId, displayName });
      const result = exec(
        referenceQueries.connectorInstancesUpdateDisplayName,
        [displayName, updatedAt ?? new Date().toISOString(), connectorInstanceId, ownerSubjectId],
      );
      if (!result || result.changes === 0) {
        throw new ConnectorInstanceResolutionError(
          'connector_instance_not_found',
          `Connector instance '${connectorInstanceId}' does not exist for owner '${ownerSubjectId}'.`,
          { ownerSubjectId, connectorInstanceId },
        );
      }
      return this.get(connectorInstanceId);
    },

    // Returns all draft browser-enrollment shells (any owner). Used by the TTL
    // retirement sweep to find shells whose enrollment_expires_at has passed.
    // The optional ownerSubjectId filter is applied client-side after the
    // bounded read to avoid dynamic SQL.
    listDraftBrowserEnrollmentShells(ownerSubjectId = null) {
      const rows = allowUnboundedReadAcknowledged(
        referenceQueries.connectorInstancesListDraftBrowserEnrollmentShells,
      );
      const instances = rows.map(mapInstance);
      if (ownerSubjectId) {
        return instances.filter((i) => i.ownerSubjectId === ownerSubjectId);
      }
      return instances;
    },

    // Connection-scoped destructive delete of ONE connection, keyed strictly on
    // connector_instance_id. Erases the connection's records/history/blobs/
    // attention/search, its schedule, clears its device source-instance
    // back-reference, and removes the connector_instances row LAST. Preserves
    // the audit spine, disclosure grants, sibling connections, the device edge
    // itself, and any controller_active_runs row (an in-flight run is REFUSED,
    // never erased).
    //
    // Order (matches the contract's store-primitive section):
    //   1. resolve + verify ownership, refuse active-run, refuse default-account
    //      (assertDeletableConnection) — BEFORE any mutation (I5/I6/I7).
    //   2. enumerate the connection's streams (pre-commit read) so the
    //      post-commit search teardown knows what to clear.
    //   3. in ONE writeTransaction: erase the record-family/blob/attention rows
    //      (`purge.deleteRecordRowsSqlite`, which opens NO transaction of its
    //      own), then delete the schedule, clear the device back-reference, and
    //      delete the connector_instances row LAST. The ENTIRE durable cascade
    //      is one transaction (I8): a failure in EITHER the record purge OR the
    //      schedule/device/row cleanup rolls the whole cascade back, leaving the
    //      connection fully intact — no half-deleted connection.
    //   4. AFTER the durable commit: tear down the rebuildable search-index
    //      projection (`purge.teardownProjection`). Its failure does NOT undo or
    //      invalidate the committed source-of-truth delete.
    //
    // `purge` is injected (rather than imported) to avoid a records.js ↔ store
    // import cycle. It exposes `enumerateStreams`, `deleteRecordRowsSqlite`, and
    // `teardownProjection`; the host wires these to the `records.js` phases.
    async deleteConnection(connectorInstanceId, { ownerSubjectId, now, purge }) {
      const instance = this.get(connectorInstanceId);
      const activeRuns = allowUnboundedReadAcknowledged(referenceQueries.controllerListActiveRuns);
      const hasActiveRun = activeRuns.some((run) => run.connector_instance_id === connectorInstanceId);
      assertDeletableConnection(instance, { connectorInstanceId, ownerSubjectId, hasActiveRun });

      const storageTarget = { connector_id: instance.connectorId, connector_instance_id: connectorInstanceId };
      const { streams } = await purge.enumerateStreams(storageTarget);

      const stamp = now ?? new Date().toISOString();
      const { deletedRecordCount, scheduleDeleted, deviceRefsCleared } = writeTransaction(() => {
        // Record-family + blob + attention purge runs INSIDE this transaction
        // (no inner transaction of its own), so it is atomic with the schedule /
        // device / row deletes below.
        const recordCount = purge.deleteRecordRowsSqlite(connectorInstanceId);
        const schedule = exec(referenceQueries.controllerDeleteSchedule, [connectorInstanceId]);
        const device = exec(referenceQueries.deviceExportersClearSourceInstanceConnectorRef, [stamp, connectorInstanceId]);
        exec(referenceQueries.connectorInstancesDeleteById, [connectorInstanceId]);
        return {
          deletedRecordCount: recordCount,
          scheduleDeleted: (schedule?.changes ?? 0) > 0,
          deviceRefsCleared: device?.changes ?? 0,
        };
      });

      // Post-commit, rebuildable projection teardown. A failure here leaves
      // orphaned (but unreachable — the records are gone) index rows; it does
      // NOT mean the committed delete failed.
      await purge.teardownProjection({
        connectorId: instance.connectorId,
        connectorInstanceId,
        streams,
        deletedRecordCount,
      });

      return buildDeleteSummary(instance, {
        deletedRecordCount,
        deletedStreamCount: streams.length,
        scheduleDeleted,
        deviceRefsCleared,
      });
    },
  };
}

function assertOwnerSetDisplayNameArgs({ connectorInstanceId, ownerSubjectId, displayName }) {
  if (typeof connectorInstanceId !== 'string' || !connectorInstanceId) {
    throw new ConnectorInstanceResolutionError(
      'connector_instance_selector_required',
      'connectorInstanceId is required to set a display name.',
    );
  }
  if (typeof ownerSubjectId !== 'string' || !ownerSubjectId) {
    throw new ConnectorInstanceResolutionError(
      'owner_subject_required',
      'ownerSubjectId is required to set a display name.',
    );
  }
  if (typeof displayName !== 'string') {
    const err = new Error('display_name must be a string.');
    err.code = 'invalid_request';
    err.param = 'display_name';
    throw err;
  }
  const trimmed = displayName.trim();
  if (!trimmed) {
    const err = new Error('display_name must be a non-empty string.');
    err.code = 'invalid_request';
    err.param = 'display_name';
    throw err;
  }
  if (trimmed.length > 200) {
    const err = new Error('display_name must be at most 200 characters.');
    err.code = 'invalid_request';
    err.param = 'display_name';
    throw err;
  }
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

    async ensureDefaultAccountConnection({ ownerSubjectId, connectorId, displayName, now }) {
      // Durability guard: a deliberately-revoked default-account connection
      // MUST NOT be silently resurrected to active. Read the deterministically
      // keyed row first; if the owner revoked it, return it unchanged so the
      // revoke survives. Only a missing or active row materializes/upserts.
      // The device re-enroll path upserts under a different source_binding_key
      // and never reaches this method, so its reactivation semantics are
      // untouched. See add-owner-agent-control-surface design "Deferred:
      // connection-revoke durability" → Unit 1.
      const existing = await this.getByBinding({
        ownerSubjectId,
        connectorId,
        sourceKind: 'account',
        sourceBindingKey: DEFAULT_ACCOUNT_SOURCE_BINDING_KEY,
      });
      if (existing && existing.status === 'revoked') {
        return existing;
      }
      return await this.upsert({
        connectorInstanceId: makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId),
        ownerSubjectId,
        connectorId,
        displayName: displayName ?? connectorId,
        status: 'active',
        sourceKind: 'account',
        sourceBindingKey: DEFAULT_ACCOUNT_SOURCE_BINDING_KEY,
        sourceBinding: { ...DEFAULT_ACCOUNT_SOURCE_BINDING },
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

    // Non-secret in-flight-run lookup for ONE connection (see the SQLite arm).
    // Direct keyed read on the Postgres `controller_active_runs` table.
    async getActiveRun(connectorInstanceId) {
      const result = await postgresQuery(
        `SELECT run_id, connector_id, started_at
         FROM controller_active_runs WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      return { runId: row.run_id, connectorId: row.connector_id, startedAt: row.started_at };
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
      // Draft instances are invisible to every connection read surface (the
      // single choke point — see SQLite arm / Decision 2). Filtered in SQL here
      // so the LIMIT applies to visible rows.
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1 AND status <> 'draft'
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

    async listActiveByConnector(ownerSubjectId, connectorId, { limit = ACTIVE_FANIN_LIMIT } = {}) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         FROM connector_instances
         WHERE owner_subject_id = $1 AND connector_id = $2 AND status = 'active'
         ORDER BY created_at ASC, connector_instance_id ASC
         LIMIT $3`,
        [ownerSubjectId, connectorId, limit],
      );
      return result.rows.map(mapInstance);
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

    // Flip a static-secret draft to active on its first successful ingest. A
    // single conditional UPDATE keyed on `status = 'draft'` is the no-op /
    // concurrency guard: a row that is missing or not draft is untouched. See
    // add-static-secret-owner-session-connect-path design Decision 5.
    async activateDraft(connectorInstanceId, { now } = {}) {
      await postgresQuery(
        `UPDATE connector_instances
         SET status = 'active', updated_at = $1, revoked_at = NULL
         WHERE connector_instance_id = $2 AND status = 'draft'`,
        [now ?? new Date().toISOString(), connectorInstanceId],
      );
      return await this.get(connectorInstanceId);
    },

    async setDisplayName(connectorInstanceId, { ownerSubjectId, displayName, updatedAt }) {
      assertOwnerSetDisplayNameArgs({ connectorInstanceId, ownerSubjectId, displayName });
      const result = await postgresQuery(
        `UPDATE connector_instances
         SET display_name = $1, updated_at = $2
         WHERE connector_instance_id = $3 AND owner_subject_id = $4`,
        [displayName, updatedAt ?? new Date().toISOString(), connectorInstanceId, ownerSubjectId],
      );
      if (!result || result.rowCount === 0) {
        throw new ConnectorInstanceResolutionError(
          'connector_instance_not_found',
          `Connector instance '${connectorInstanceId}' does not exist for owner '${ownerSubjectId}'.`,
          { ownerSubjectId, connectorInstanceId },
        );
      }
      return await this.get(connectorInstanceId);
    },

    // Returns all draft browser-enrollment shells (any owner, or filtered by
    // ownerSubjectId). Used by the TTL retirement sweep.
    async listDraftBrowserEnrollmentShells(ownerSubjectId = null) {
      const result = ownerSubjectId
        ? await postgresQuery(
            `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
             FROM connector_instances
             WHERE status = 'draft'
               AND source_binding_json->>'kind' = 'browser_enrollment_shell'
               AND owner_subject_id = $1`,
            [ownerSubjectId],
          )
        : await postgresQuery(
            `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
             FROM connector_instances
             WHERE status = 'draft'
               AND source_binding_json->>'kind' = 'browser_enrollment_shell'`,
          );
      return result.rows.map(mapInstance);
    },

    // Postgres connection-scoped delete. Mirrors the SQLite arm exactly: resolve
    // + verify ownership, refuse active-run (I7) and default-account (I6/Decision
    // 1), enumerate streams, then erase the record-family rows AND the schedule +
    // device back-ref + connector_instances row inside ONE withPostgresTransaction
    // — the record purge binds against the SAME `client`, so the whole durable
    // cascade is one BEGIN/COMMIT (I8). Search-index teardown runs post-commit.
    // See the SQLite `deleteConnection` for the full ordering rationale.
    async deleteConnection(connectorInstanceId, { ownerSubjectId, now, purge }) {
      const instance = await this.get(connectorInstanceId);
      const activeRuns = await postgresQuery(
        `SELECT connector_instance_id FROM controller_active_runs WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      const hasActiveRun = activeRuns.rows.length > 0;
      assertDeletableConnection(instance, { connectorInstanceId, ownerSubjectId, hasActiveRun });

      const storageTarget = { connector_id: instance.connectorId, connector_instance_id: connectorInstanceId };
      const { streams } = await purge.enumerateStreams(storageTarget);

      const stamp = now ?? new Date().toISOString();
      const { deletedRecordCount, scheduleDeleted, deviceRefsCleared } = await withPostgresTransaction(async (client) => {
        // Record-family + blob + attention purge runs against the SAME client,
        // so it is atomic with the schedule / device / row deletes below.
        const recordCount = await purge.deleteRecordRowsPostgres(client, connectorInstanceId);
        const schedule = await client.query(
          `DELETE FROM connector_schedules WHERE connector_instance_id = $1`,
          [connectorInstanceId],
        );
        const device = await client.query(
          `UPDATE device_source_instances SET connector_instance_id = NULL, updated_at = $1 WHERE connector_instance_id = $2`,
          [stamp, connectorInstanceId],
        );
        await client.query(
          `DELETE FROM connector_instances WHERE connector_instance_id = $1`,
          [connectorInstanceId],
        );
        return {
          deletedRecordCount: recordCount,
          scheduleDeleted: (schedule?.rowCount ?? 0) > 0,
          deviceRefsCleared: device?.rowCount ?? 0,
        };
      });

      // Post-commit, rebuildable projection teardown (see SQLite arm).
      await purge.teardownProjection({
        connectorId: instance.connectorId,
        connectorInstanceId,
        streams,
        deletedRecordCount,
      });

      return buildDeleteSummary(instance, {
        deletedRecordCount,
        deletedStreamCount: streams.length,
        scheduleDeleted,
        deviceRefsCleared,
      });
    },
  };
}
