/**
 * Single source of truth for the
 * `(connection_id, connector_instance_id)` canonical / deprecated-alias
 * contract on public read routes.
 *
 * `connection_id` is the canonical public connection identifier;
 * `connector_instance_id` is the deprecated wire alias accepted during the
 * migration window declared by
 * `openspec/changes/expose-connection-identity-on-public-read` and
 * `openspec/changes/canonicalize-public-read-contract`.
 *
 * Centralizing the helper here lets records.js, postgres-records.js, and
 * any future read-path runtime share one resolution + one warning code
 * without re-implementing the alias semantics per route.
 *
 * Empty-string values are treated as "absent" so callers may forward
 * undefined-shaped query params from intermediate adapters without
 * tripping the conflict check.
 */

/**
 * Canonical warning code emitted when a request used the deprecated
 * `connector_instance_id` alias. Surface this via the operation's
 * `meta.warnings[]` array so clients can detect deprecated-alias usage
 * without parsing free-form messages.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Public read warnings SHALL be structured")
 */
export const CONNECTION_ALIAS_DEPRECATED_WARNING_CODE = 'deprecated_alias_used';

/**
 * Canonical structured-warning codes the runtime is allowed to emit on
 * `meta.warnings[]`. Mirrors the closed `WarningCodeSchema` enum in the
 * reference contract so the wire vocabulary is single-sourced.
 *
 * - `deprecated_alias_used`: emitted by `resolveRequestConnectionId` when
 *   the deprecated `connector_instance_id` alias was sent on the wire.
 * - `count_downgraded`: emitted when the server downgraded a requested
 *   count grade (e.g. estimated → exact, or estimated → none).
 * - `source_skipped_not_applicable`, `partial_results`,
 *   `compatibility_fallback`: reserved for multi-source read fan-in and
 *   compatibility paths that do not yet emit warnings; the constants
 *   exist so future tranches share the canonical spelling.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Public read warnings SHALL be structured")
 */
export const CANONICAL_WARNING_CODES = Object.freeze({
  DEPRECATED_ALIAS_USED: 'deprecated_alias_used',
  COUNT_DOWNGRADED: 'count_downgraded',
  SOURCE_SKIPPED_NOT_APPLICABLE: 'source_skipped_not_applicable',
  PARTIAL_RESULTS: 'partial_results',
  COMPATIBILITY_FALLBACK: 'compatibility_fallback',
});

/**
 * Throw a typed `invalid_argument` error when both identifiers are present
 * with conflicting values. Mirrors `validateSearchConnectionAlias` in the
 * rs.search.* operations so REST and search reject the same conflict shape.
 */
export function validateConnectionAlias(requestParams) {
  if (!requestParams || typeof requestParams !== 'object') return;
  const canonical = requestParams.connection_id;
  const alias = requestParams.connector_instance_id;
  const canonicalSet = typeof canonical === 'string' && canonical.length > 0;
  const aliasSet = typeof alias === 'string' && alias.length > 0;
  if (canonicalSet && aliasSet && canonical !== alias) {
    const err = new Error(
      'connection_id and connector_instance_id refer to the same connection. Send only `connection_id` (canonical) or supply matching values.',
    );
    err.code = 'invalid_argument';
    err.param = 'connector_instance_id';
    throw err;
  }
}

/**
 * Resolve a request's connection identity into the canonical
 * `connection_id` plus a structured warning list.
 *
 * Behavior:
 *   - Both present and equal: returns the value plus a
 *     `deprecated_alias_used` warning (the alias is observable on the wire,
 *     so we surface it even when matched).
 *   - Both present and different: throws via `validateConnectionAlias`.
 *   - Only deprecated alias present: returns value plus warning.
 *   - Only canonical present: returns value with no warning.
 *   - Neither present: returns `{ connectionId: null, warnings: [] }`.
 */
export function resolveRequestConnectionId(requestParams) {
  if (!requestParams || typeof requestParams !== 'object') {
    return { connectionId: null, warnings: [] };
  }
  validateConnectionAlias(requestParams);
  const canonical = requestParams.connection_id;
  const alias = requestParams.connector_instance_id;
  const canonicalSet = typeof canonical === 'string' && canonical.length > 0;
  const aliasSet = typeof alias === 'string' && alias.length > 0;
  const warnings = [];
  if (aliasSet) {
    warnings.push({
      code: CONNECTION_ALIAS_DEPRECATED_WARNING_CODE,
      param: 'connector_instance_id',
      message: '`connector_instance_id` is deprecated; send `connection_id` instead.',
    });
  }
  let connectionId = null;
  if (canonicalSet) connectionId = canonical;
  else if (aliasSet) connectionId = alias;
  return { connectionId, warnings };
}

/**
 * Filter a stored connector-instance `display_name` value to the public-read
 * contract: emit `display_name` only when the runtime has an owner-meaningful
 * label, never a storage-layer placeholder.
 *
 * The connector-instance-store defaults `displayName` to the `connectorId`
 * during default-account materialization, so an unset / never-edited name
 * matches the connector identifier verbatim. The wire `display_name` is
 * "owner-meaningful label for the connection. Never the storage-layer
 * placeholder (`legacy`, `default_account`)." (reference-contract
 * `ConnectionDisplayNameSchema`); we treat connectorId / connectorInstanceId
 * equality and the documented placeholder strings as "no useful label" and
 * return `null` so callers omit the field entirely.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Records, search, and blob items SHALL carry canonical connection identity")
 */
const PLACEHOLDER_DISPLAY_NAMES = new Set(['legacy', 'default_account', 'Default account']);

export function projectStorageDisplayName(displayName, { connectorId = null, connectorInstanceId = null } = {}) {
  if (typeof displayName !== 'string') return null;
  const trimmed = displayName.trim();
  if (!trimmed) return null;
  if (PLACEHOLDER_DISPLAY_NAMES.has(trimmed)) return null;
  if (connectorId && trimmed === connectorId) return null;
  if (connectorInstanceId && trimmed === connectorInstanceId) return null;
  return trimmed;
}

/**
 * Enforce `connection_id` narrowing against the grant's resolved storage
 * binding. The reference runtime today pins one storage binding per grant,
 * so a request that supplies a `connection_id` (canonical) or the deprecated
 * `connector_instance_id` alias MUST address that binding; anything else
 * would be a silent zero-result no-op. Throws a typed `connection_not_found`
 * error when the requested identity does not address the bound storage.
 *
 * The deprecated alias is honored for compatibility — equality with the
 * canonical binding identifier is the contract; the canonical
 * `deprecated_alias_used` warning is still emitted by
 * `resolveRequestConnectionId`.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Public read parameters SHALL be strictly validated")
 *       (#"Public record identity SHALL be connection-scoped")
 */
export function enforceConnectionNarrowing(requestParams, boundConnectorInstanceId) {
  const { connectionId } = resolveRequestConnectionId(requestParams);
  if (connectionId == null) return;
  if (typeof boundConnectorInstanceId !== 'string' || !boundConnectorInstanceId) {
    const err = new Error('connection_id is not addressable under this grant.');
    err.code = 'connection_not_found';
    err.param = 'connection_id';
    throw err;
  }
  if (connectionId !== boundConnectorInstanceId) {
    const err = new Error(
      `connection_id '${connectionId}' is not addressable under this grant.`,
    );
    err.code = 'connection_not_found';
    err.param = 'connection_id';
    throw err;
  }
}
