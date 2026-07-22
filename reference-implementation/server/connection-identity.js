// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connection-identity binding helpers shared by records and search runtimes.
 *
 * Lives outside `records.js` and `search.js` so both consumers can import the
 * binding -> (connection_id, display_name) resolution without creating a
 * circular module dependency.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Records, search, and blob items SHALL carry canonical connection identity")
 */

import { isPostgresStorageBackend } from './postgres-storage.js';
import {
  projectStorageDisplayName,
  resolveRequestConnectionId,
} from './connection-id-request.js';
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from './stores/connector-instance-store.js';

/**
 * Look up the owner-facing display name for a pinned connector-instance
 * binding. Returns `null` when the runtime cannot pin a non-placeholder
 * label without guessing; callers MUST omit `display_name` on the response
 * in that case so the wire never carries the storage-layer placeholder
 * ("legacy", "default_account", or the connector_id default).
 */
export async function lookupConnectionDisplayName(connectorInstanceId, connectorId) {
  if (typeof connectorInstanceId !== 'string' || !connectorInstanceId) return null;
  const store = isPostgresStorageBackend()
    ? createPostgresConnectorInstanceStore()
    : createSqliteConnectorInstanceStore();
  try {
    const instance = await store.get(connectorInstanceId);
    if (!instance) return null;
    return projectStorageDisplayName(instance.displayName, {
      connectorId: connectorId || instance.connectorId,
      connectorInstanceId,
    });
  } catch {
    return null;
  }
}

/**
 * Resolve `{ connectionId, displayName? }` for a single pinned binding.
 * Returns `null` for empty bindings so callers can short-circuit without a
 * store roundtrip.
 */
export async function resolveRecordIdentityForBinding(connectorInstanceId, connectorId) {
  if (!connectorInstanceId) return null;
  const displayName = await lookupConnectionDisplayName(connectorInstanceId, connectorId);
  const identity = { connectionId: connectorInstanceId };
  if (displayName) identity.displayName = displayName;
  return identity;
}

/**
 * Resolve display names for many `(connectorInstanceId, connectorId)`
 * bindings at once. Returns a `Map<connectorInstanceId, displayName>` where
 * placeholder labels are omitted (no entry rather than null/empty string).
 *
 * Search snapshots commonly carry results from multiple bindings; this lets
 * the snapshot builder cache one lookup per binding instead of one per hit.
 */
export async function resolveDisplayNamesForBindings(bindings) {
  const out = new Map();
  if (!bindings || bindings.length === 0) return out;
  const seen = new Set();
  const unique = [];
  for (const binding of bindings) {
    const cii = binding?.connectorInstanceId;
    if (typeof cii !== 'string' || !cii || seen.has(cii)) continue;
    seen.add(cii);
    unique.push({ connectorInstanceId: cii, connectorId: binding.connectorId || null });
  }
  await Promise.all(
    unique.map(async ({ connectorInstanceId, connectorId }) => {
      const displayName = await lookupConnectionDisplayName(connectorInstanceId, connectorId);
      if (displayName) out.set(connectorInstanceId, displayName);
    }),
  );
  return out;
}

/**
 * Typed error emitted by record-detail / blob-read when an addressed
 * identifier resolves to more than one connection under the caller's grant.
 *
 * The error envelope carries `available_connections: [{ connection_id,
 * display_name? }]` so the client can recover without an extra round trip.
 *
 * Spec: openspec/changes/expose-connection-identity-on-public-read/
 *       specs/reference-implementation-architecture/spec.md
 *       (#"Identifier-ambiguous reads SHALL emit a typed
 *         ambiguous-connection error")
 */
export class AmbiguousConnectionError extends Error {
  constructor(message, availableConnections) {
    super(message);
    this.name = 'AmbiguousConnectionError';
    this.code = 'ambiguous_connection';
    this.available_connections = Array.isArray(availableConnections)
      ? availableConnections.map((c) => ({
          connection_id: c.connection_id,
          ...(c.display_name ? { display_name: c.display_name } : {}),
        }))
      : [];
    this.retry_with = 'connection_id';
  }
}

function getStore() {
  return isPostgresStorageBackend()
    ? createPostgresConnectorInstanceStore()
    : createSqliteConnectorInstanceStore();
}

/**
 * Project a store instance row to the wire `connection` envelope used by
 * `available_connections` in the typed `ambiguous_connection` error.
 */
export function projectBindingForWire(instance) {
  if (!instance || !instance.connectorInstanceId) return null;
  const displayName = projectStorageDisplayName(instance.displayName, {
    connectorId: instance.connectorId || null,
    connectorInstanceId: instance.connectorInstanceId,
  });
  const out = { connection_id: instance.connectorInstanceId };
  if (displayName) out.display_name = displayName;
  return out;
}

/**
 * List all active connector_instances for a connector under an owner. Awaits
 * an async-or-sync store result so callers can use one shape regardless of
 * SQLite vs Postgres backend.
 */
export async function listActiveBindingsForGrant({ ownerSubjectId, connectorId }) {
  if (!ownerSubjectId || !connectorId) return [];
  const store = getStore();
  const rows = await Promise.resolve(store.listActiveByConnector(ownerSubjectId, connectorId));
  return Array.isArray(rows) ? rows : [];
}

/**
 * Resolve the set of bindings to read across for a grant-authorized public
 * read.
 *
 * Inputs:
 *   - `ownerSubjectId`: owner subject backing the grant.
 *   - `connectorId`: connector_id from the grant's storage binding.
 *   - `connectorInstanceIdHint`: the previously-pinned single binding
 *     (today's `grant_storage_binding.connector_instance_id` or the
 *     namespace resolver's first pick). When the runtime can fan in across
 *     many connections the hint is ignored unless explicitly requested.
 *   - `requestConnectionId`: canonical `connection_id` filter parsed from
 *     the request (or its deprecated `connector_instance_id` alias).
 *   - `grantStreamConnectionId`: per-stream `connection_id` constraint
 *     from the grant scope. Absent constraint preserves fan-in.
 *
 * Returns `{ bindings: [...], warnings: [...] }`. Bindings are
 * `{ connectorInstanceId, connectorId, displayName? }` ordered by
 * created_at ASC. Empty array means no active binding addressable under
 * the grant — callers should map that to `not_found` or
 * `connection_not_found` per their surface.
 */
export async function resolveFanInBindings({
  ownerSubjectId,
  connectorId,
  connectorInstanceIdHint = null,
  requestConnectionId = null,
  grantStreamConnectionId = null,
}) {
  const warnings = [];
  if (!connectorId) return { bindings: [], warnings };

  const active = await listActiveBindingsForGrant({ ownerSubjectId, connectorId });

  // Honor grant-scope per-stream connection_id constraint first; absent
  // constraint preserves fan-in across all active bindings.
  let candidates = active;
  if (grantStreamConnectionId) {
    candidates = candidates.filter((row) => row.connectorInstanceId === grantStreamConnectionId);
    if (candidates.length === 0) {
      const err = new Error(
        `Grant scope connection_id '${grantStreamConnectionId}' is not currently active for connector '${connectorId}'.`,
      );
      err.code = 'connection_not_found';
      err.param = 'connection_id';
      throw err;
    }
  }

  // Narrow further by request-time `connection_id` (canonical or alias).
  if (requestConnectionId) {
    const narrowed = candidates.filter(
      (row) => row.connectorInstanceId === requestConnectionId,
    );
    if (narrowed.length === 0) {
      const err = new Error(
        `connection_id '${requestConnectionId}' is not addressable under this grant.`,
      );
      err.code = 'connection_not_found';
      err.param = 'connection_id';
      throw err;
    }
    candidates = narrowed;
  }

  // Fallback to the previously-pinned single binding when no active rows
  // are registered yet. Today the reference runtime pins the binding at
  // ingest time via `ensureDefaultAccountConnection`, so this path mainly
  // covers boot-time / freshly-issued grants whose default-account row
  // has not yet materialized; the caller's storage layer continues to
  // operate against `connectorInstanceIdHint` in that case.
  if (candidates.length === 0 && connectorInstanceIdHint) {
    return {
      bindings: [
        {
          connectorInstanceId: connectorInstanceIdHint,
          connectorId,
          displayName: null,
        },
      ],
      warnings,
    };
  }

  return {
    bindings: candidates.map((row) => ({
      connectorInstanceId: row.connectorInstanceId,
      connectorId: row.connectorId,
      displayName: row.displayName,
    })),
    warnings,
  };
}

/**
 * Enumerate every active owner-visible binding for a list of connectors.
 *
 * Used by the search fan-in path so owner-mode search fans across each
 * connector's bindings (e.g. two Gmail accounts) rather than picking a
 * single default. Returns `[{ connectorId, connectorInstanceId, displayName? }, ...]`
 * with placeholder display names suppressed (consistent with
 * `projectBindingForWire`).
 */
export async function listActiveOwnerBindingsForConnectors({
  ownerSubjectId,
  connectorIds,
}) {
  if (!ownerSubjectId || !Array.isArray(connectorIds) || connectorIds.length === 0) {
    return [];
  }
  const lists = await Promise.all(
    connectorIds.map((connectorId) =>
      listActiveBindingsForGrant({ ownerSubjectId, connectorId }),
    ),
  );
  const out = [];
  for (let i = 0; i < connectorIds.length; i += 1) {
    const connectorId = connectorIds[i];
    for (const row of lists[i] || []) {
      const projected = projectBindingForWire({
        connectorInstanceId: row.connectorInstanceId,
        connectorId: row.connectorId || connectorId,
        displayName: row.displayName,
      });
      const entry = {
        connectorId: row.connectorId || connectorId,
        connectorInstanceId: row.connectorInstanceId,
      };
      if (projected?.display_name) entry.displayName = projected.display_name;
      out.push(entry);
    }
  }
  return out;
}

/**
 * Enumerate the granted connections visible to the caller for a given stream
 * under one connector. Returns `[{ connection_id, display_name? }, ...]`
 * ordered by created_at ASC (the listing order from the store).
 *
 * Inputs:
 *   - `ownerSubjectId`: owner subject backing the grant.
 *   - `connectorId`: connector_id from the storage binding.
 *   - `grantStreamConnectionId`: per-stream `grant.streams[].connection_id`
 *     constraint. When set, the result is narrowed to that one binding
 *     (returns empty when the constraint is no longer active).
 *
 * Used by `GET /v1/schema` to advertise the discoverable set of connections
 * per stream so grant-authorized clients can call subsequent reads with an
 * explicit `connection_id` without trial-and-error.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"`/v1/schema` SHALL be the canonical public read capability document")
 */
export async function listGrantedConnectionsForStream({
  ownerSubjectId,
  connectorId,
  grantStreamConnectionId = null,
}) {
  if (!ownerSubjectId || !connectorId) return [];
  const active = await listActiveBindingsForGrant({ ownerSubjectId, connectorId });
  const filtered = grantStreamConnectionId
    ? active.filter((row) => row.connectorInstanceId === grantStreamConnectionId)
    : active;
  return filtered
    .map((row) => projectBindingForWire({
      connectorInstanceId: row.connectorInstanceId,
      connectorId: row.connectorId,
      displayName: row.displayName,
    }))
    .filter(Boolean);
}

/**
 * Convenience: resolve the request-time `connection_id` (canonical or
 * deprecated alias) and combine with the grant-scope constraint into the
 * final `bindings` list to read from.
 *
 * Throws `invalid_argument` when both `connection_id` and the deprecated
 * `connector_instance_id` alias are sent with conflicting values; throws
 * `connection_not_found` when the requested or grant-pinned identity is
 * not active under the owner's connector.
 */
export async function resolveRequestBindings({
  ownerSubjectId,
  connectorId,
  connectorInstanceIdHint = null,
  requestParams = {},
  grantStreamConnectionId = null,
}) {
  const { connectionId: requestConnectionId, warnings: aliasWarnings } =
    resolveRequestConnectionId(requestParams);
  const { bindings, warnings } = await resolveFanInBindings({
    ownerSubjectId,
    connectorId,
    connectorInstanceIdHint,
    requestConnectionId,
    grantStreamConnectionId,
  });
  return {
    bindings,
    requestConnectionId,
    warnings: [...aliasWarnings, ...warnings],
  };
}

