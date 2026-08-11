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

import { projectStorageDisplayName, resolveRequestConnectionId } from "./connection-id-request.ts";
import { isPostgresStorageBackend } from "./postgres-storage.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "./stores/connector-instance-store.ts";

interface ActiveBinding {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
}

interface BindingInput {
  connectorId?: string | null;
  connectorInstanceId?: string | null;
}

interface ConnectionWireBinding {
  connection_id: string;
  display_name?: string;
}

interface ConnectionWarning {
  code: string;
  message: string;
  param: string;
}

class ConnectionNotFoundError extends Error {
  code = "connection_not_found";
  param = "connection_id";
}

/**
 * Look up the owner-facing display name for a pinned connector-instance
 * binding. Returns `null` when the runtime cannot pin a non-placeholder
 * label without guessing; callers MUST omit `display_name` on the response
 * in that case so the wire never carries the storage-layer placeholder
 * ("legacy", "default_account", or the connector_id default).
 */
export async function lookupConnectionDisplayName(
  connectorInstanceId: unknown,
  connectorId: string | null | undefined
): Promise<string | null> {
  if (typeof connectorInstanceId !== "string" || !connectorInstanceId) {
    return null;
  }
  const store = isPostgresStorageBackend()
    ? createPostgresConnectorInstanceStore()
    : createSqliteConnectorInstanceStore();
  try {
    const instance = await store.get(connectorInstanceId);
    if (!instance) {
      return null;
    }
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
export async function resolveRecordIdentityForBinding(
  connectorInstanceId: string | null | undefined,
  connectorId: string | null | undefined
): Promise<{ connectionId: string; displayName?: string } | null> {
  if (!connectorInstanceId) {
    return null;
  }
  const displayName = await lookupConnectionDisplayName(connectorInstanceId, connectorId);
  const identity: { connectionId: string; displayName?: string } = { connectionId: connectorInstanceId };
  if (displayName) {
    identity.displayName = displayName;
  }
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
export async function resolveDisplayNamesForBindings(
  bindings: readonly BindingInput[] | null | undefined
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!bindings || bindings.length === 0) {
    return out;
  }
  const seen = new Set<string>();
  const unique: Array<{ connectorId: string | null; connectorInstanceId: string }> = [];
  for (const binding of bindings) {
    const cii = binding?.connectorInstanceId;
    if (typeof cii !== "string" || !cii || seen.has(cii)) {
      continue;
    }
    seen.add(cii);
    unique.push({ connectorId: binding.connectorId || null, connectorInstanceId: cii });
  }
  await Promise.all(
    unique.map(async ({ connectorInstanceId, connectorId }) => {
      const displayName = await lookupConnectionDisplayName(connectorInstanceId, connectorId);
      if (displayName) {
        out.set(connectorInstanceId, displayName);
      }
    })
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
  available_connections: ConnectionWireBinding[];
  code = "ambiguous_connection";
  retry_with = "connection_id";

  constructor(message: string, availableConnections: readonly ConnectionWireBinding[] | null | undefined) {
    super(message);
    this.name = "AmbiguousConnectionError";
    this.available_connections = Array.isArray(availableConnections)
      ? availableConnections.map((c) => ({
          connection_id: c.connection_id,
          ...(c.display_name ? { display_name: c.display_name } : {}),
        }))
      : [];
  }
}

function getStore() {
  return isPostgresStorageBackend() ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
}

/**
 * Project a store instance row to the wire `connection` envelope used by
 * `available_connections` in the typed `ambiguous_connection` error.
 */
export function projectBindingForWire(
  instance: Pick<ActiveBinding, "connectorId" | "connectorInstanceId" | "displayName"> | null | undefined
): ConnectionWireBinding | null {
  if (!instance?.connectorInstanceId) {
    return null;
  }
  const displayName = projectStorageDisplayName(instance.displayName, {
    connectorId: instance.connectorId || null,
    connectorInstanceId: instance.connectorInstanceId,
  });
  const out: ConnectionWireBinding = { connection_id: instance.connectorInstanceId };
  if (displayName) {
    out.display_name = displayName;
  }
  return out;
}

/**
 * List all active connector_instances for a connector under an owner. Awaits
 * an async-or-sync store result so callers can use one shape regardless of
 * SQLite vs Postgres backend.
 */
export async function listActiveBindingsForGrant({
  ownerSubjectId,
  connectorId,
}: {
  ownerSubjectId: string | null | undefined;
  connectorId: string | null | undefined;
}): Promise<ActiveBinding[]> {
  if (!(ownerSubjectId && connectorId)) {
    return [];
  }
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
 *   - `authorizedInstanceIds`: the closed grant stream's non-empty
 *     `instance_ids` authority. This is the upper bound for every client
 *     read; request-time selectors may only narrow it.
 *
 * Returns `{ bindings: [...], warnings: [...] }`. The closed grant ids are
 * the authority. Current instance rows may enrich display names, but cannot
 * widen or revoke the set named by the grant.
 */
export async function resolveFanInBindings({
  ownerSubjectId: _ownerSubjectId,
  connectorId,
  connectorInstanceIdHint: _connectorInstanceIdHint = null,
  requestConnectionId = null,
  authorizedInstanceIds,
}: {
  authorizedInstanceIds: readonly string[];
  connectorId: string | null | undefined;
  connectorInstanceIdHint?: string | null;
  ownerSubjectId: string | null | undefined;
  requestConnectionId?: string | null;
}): Promise<{
  bindings: Array<ActiveBinding | { connectorId: string; connectorInstanceId: string; displayName: null }>;
  warnings: ConnectionWarning[];
}> {
  const warnings: ConnectionWarning[] = [];
  if (!connectorId) {
    return { bindings: [], warnings };
  }

  if (!Array.isArray(authorizedInstanceIds) || authorizedInstanceIds.length === 0) {
    throw new ConnectionNotFoundError("The grant does not authorize any source instances for this stream.");
  }

  let candidates = await Promise.all(
    [...new Set(authorizedInstanceIds)].map(async (connectorInstanceId) => ({
      connectorId,
      connectorInstanceId,
      displayName: await lookupConnectionDisplayName(connectorInstanceId, connectorId),
    }))
  );

  // Narrow further by request-time `connection_id` (canonical or alias).
  if (requestConnectionId) {
    const narrowed = candidates.filter((row) => row.connectorInstanceId === requestConnectionId);
    if (narrowed.length === 0) {
      const err = new ConnectionNotFoundError(
        `connection_id '${requestConnectionId}' is not addressable under this grant.`
      );
      throw err;
    }
    candidates = narrowed;
  }

  return {
    bindings: candidates.map((row) => ({
      connectorId: row.connectorId,
      connectorInstanceId: row.connectorInstanceId,
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
}: {
  ownerSubjectId: string | null | undefined;
  connectorIds: readonly string[] | null | undefined;
}): Promise<Array<{ connectorId: string; connectorInstanceId: string; displayName?: string }>> {
  if (!(ownerSubjectId && Array.isArray(connectorIds)) || connectorIds.length === 0) {
    return [];
  }
  const lists = await Promise.all(
    connectorIds.map((connectorId) => listActiveBindingsForGrant({ connectorId, ownerSubjectId }))
  );
  const out: Array<{ connectorId: string; connectorInstanceId: string; displayName?: string }> = [];
  for (let i = 0; i < connectorIds.length; i += 1) {
    const connectorId = connectorIds[i];
    if (!connectorId) {
      continue;
    }
    for (const row of lists[i] || []) {
      const projected = projectBindingForWire({
        connectorId: row.connectorId || connectorId,
        connectorInstanceId: row.connectorInstanceId,
        displayName: row.displayName,
      });
      const entry: { connectorId: string; connectorInstanceId: string; displayName?: string } = {
        connectorId: row.connectorId || connectorId,
        connectorInstanceId: row.connectorInstanceId,
      };
      if (projected?.display_name) {
        entry.displayName = projected.display_name;
      }
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
 *   - `authorizedInstanceIds`: per-stream `grant.streams[].instance_ids`
 *     authority. When present, these frozen ids are the result set; current
 *     instance rows may enrich display names but cannot revoke grant scope.
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
  authorizedInstanceIds = null,
}: {
  authorizedInstanceIds?: readonly string[] | null;
  ownerSubjectId: string | null | undefined;
  connectorId: string | null | undefined;
}): Promise<ConnectionWireBinding[]> {
  if (!(ownerSubjectId && connectorId)) {
    return [];
  }
  if (authorizedInstanceIds) {
    const identities = await Promise.all(
      [...new Set(authorizedInstanceIds)].map((connectorInstanceId) =>
        resolveRecordIdentityForBinding(connectorInstanceId, connectorId)
      )
    );
    return identities
      .filter((identity): identity is { connectionId: string; displayName?: string } => identity !== null)
      .map((identity) => ({
        connection_id: identity.connectionId,
        ...(identity.displayName ? { display_name: identity.displayName } : {}),
      }));
  }
  const active = await listActiveBindingsForGrant({ connectorId, ownerSubjectId });
  return active
    .map((row) =>
      projectBindingForWire({
        connectorId: row.connectorId,
        connectorInstanceId: row.connectorInstanceId,
        displayName: row.displayName,
      })
    )
    .filter((binding): binding is ConnectionWireBinding => binding !== null);
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
  authorizedInstanceIds,
}: {
  authorizedInstanceIds: readonly string[];
  connectorId: string | null | undefined;
  connectorInstanceIdHint?: string | null;
  ownerSubjectId: string | null | undefined;
  requestParams?: Record<string, unknown>;
}) {
  const { connectionId: requestConnectionId, warnings: aliasWarnings } = resolveRequestConnectionId(requestParams);
  const { bindings, warnings } = await resolveFanInBindings({
    authorizedInstanceIds,
    connectorId,
    connectorInstanceIdHint,
    ownerSubjectId,
    requestConnectionId,
  });
  return {
    bindings,
    requestConnectionId,
    warnings: [...aliasWarnings, ...warnings],
  };
}
