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
import { projectStorageDisplayName } from './connection-id-request.js';
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
