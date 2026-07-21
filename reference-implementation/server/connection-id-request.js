// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { canonicalConnectorKey, isRegistryUrlConnectorId } from './connector-key.js';

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
 * - `limit_clamped`: emitted by the records list path when a request asks
 *   for more records per page than the contract maximum (`limit` > 100). The
 *   server returns the bounded page rather than rejecting, and surfaces this
 *   warning so an agent learns the effective page size instead of silently
 *   reasoning against a 500-record page it never received.
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
  LIMIT_CLAMPED: 'limit_clamped',
  SOURCE_SKIPPED_NOT_APPLICABLE: 'source_skipped_not_applicable',
  PARTIAL_RESULTS: 'partial_results',
  COMPATIBILITY_FALLBACK: 'compatibility_fallback',
});

// Records-list page sizing. spec-core §8 ("List records") fixes the public
// contract: `limit` defaults to 25 and is capped at 100. These were previously
// inline magic numbers duplicated at the SQLite and Postgres clamp sites;
// naming them here — the module both record paths already import — gives one
// source of truth for the runtime, the warning message, and the tests.
export const RECORDS_DEFAULT_PAGE_LIMIT = 25;
export const RECORDS_MAX_PAGE_LIMIT = 100;

/**
 * Clamp a request's `limit` to the records-list page contract (default 25,
 * max 100) without throwing. Returns the effective `limit`, the parsed
 * `requested` value (or null when absent/unparseable), and whether the cap
 * was applied.
 *
 * The runtime clamps rather than rejects an over-max `limit` so a client that
 * optimistically asks for a big page still gets a valid bounded page; the
 * `clamped` flag lets the caller surface a `limit_clamped` warning so the
 * reduction is never silent. A non-positive or unparseable `limit` falls back
 * to the default and is not treated as a clamp (there is nothing to report).
 */
export function clampRecordsPageLimit(rawLimit) {
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { limit: RECORDS_DEFAULT_PAGE_LIMIT, requested: null, clamped: false };
  }
  if (parsed > RECORDS_MAX_PAGE_LIMIT) {
    return { limit: RECORDS_MAX_PAGE_LIMIT, requested: parsed, clamped: true };
  }
  return { limit: parsed, requested: parsed, clamped: false };
}

/**
 * Build the structured `limit_clamped` warning for a clamped records page.
 * `detail` carries the stable machine-readable values; `message` is only for
 * human diagnostics.
 */
export function buildLimitClampedWarning(requested) {
  return {
    code: CANONICAL_WARNING_CODES.LIMIT_CLAMPED,
    param: 'limit',
    detail: {
      requested_limit: requested,
      max_limit: RECORDS_MAX_PAGE_LIMIT,
    },
    message: `Requested limit=${requested} exceeds the maximum page size of ${RECORDS_MAX_PAGE_LIMIT}; returned ${RECORDS_MAX_PAGE_LIMIT} records per page. Page forward with the returned cursor.`,
  };
}

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
 * equality, registry-URL connector ids, and the documented placeholder strings
 * as "no useful label" and return `null` so callers omit the field entirely.
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
  const displayNameKey = canonicalConnectorKey(trimmed);
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  if (connectorKey && displayNameKey && displayNameKey === connectorKey) return null;
  if (isRegistryUrlConnectorId(trimmed)) return null;
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
