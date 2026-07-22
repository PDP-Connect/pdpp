// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.connector-state.put` operation.
 *
 * Owns the Collection Profile owner-authenticated state-write
 * semantics for `PUT /v1/state/:connectorId`. The host adapter wires
 * auth (owner + bearer), request id / trace id, instrumentation events
 * (`state.requested`, `state.updated`, `state.rejected`), the manifest
 * resolver, the grant-scope resolver, the sync-state writer, and the
 * response writing. The operation owns the validation order, the
 * stream-membership and grant-scope checks, the typed error shape
 * for those checks, and the storage call shape.
 *
 * Validation order (preserved from the previous inline route):
 *   1. Resolve connector manifest (host throws on unknown connector).
 *   2. Resolve grant scope when `grantId` is present (host throws on
 *      unknown / non-scoped / non-continuous grant).
 *   3. Notify the host that grant resolution is complete so it can
 *      refresh trace id state and emit `state.requested`. The
 *      remaining validation runs after this notification — failures
 *      emit `state.rejected` on the correlated trace.
 *   4. For each requested stream: assert manifest membership, then
 *      assert grant-scope membership (when a grant scope is in use).
 *   5. Write the sync state, scoped to the grant's allowed streams.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules, the records module,
 *   `server/index.js`, or `process` / `process.env`.
 */

export type RsConnectorStatePutErrorCode = "not_found" | "invalid_request";

export class RsConnectorStatePutValidationError extends Error {
  readonly code: RsConnectorStatePutErrorCode;
  constructor(code: RsConnectorStatePutErrorCode, message: string) {
    super(message);
    this.name = "RsConnectorStatePutValidationError";
    this.code = code;
  }
}

export interface RsConnectorStatePutGrantScope {
  readonly grantId: string;
  readonly grantedStreams: ReadonlySet<string>;
  readonly traceId?: string | null;
  readonly scenarioId?: string;
  readonly [extra: string]: unknown;
}

export interface RsConnectorStatePutManifestStream {
  readonly name: string;
  readonly [extra: string]: unknown;
}

export interface RsConnectorStatePutManifest {
  readonly streams?: ReadonlyArray<RsConnectorStatePutManifestStream>;
  readonly [extra: string]: unknown;
}

export interface RsConnectorStatePutState {
  readonly state?: Record<string, unknown> | null;
  readonly updated_at?: string | null;
  readonly [extra: string]: unknown;
}

export interface RsConnectorStatePutDependencies {
  /**
   * Resolve and validate the connector's manifest. The host throws
   * a typed error (`code: 'not_found'`) when the connector is not
   * registered. The operation reads `streams[].name` from the result
   * for stream-membership validation.
   */
  resolveRegisteredConnectorManifest(
    connectorId: string,
  ): Promise<RsConnectorStatePutManifest> | RsConnectorStatePutManifest;
  /**
   * Resolve the grant scope when `grantId` is provided.
   */
  resolveGrantScope(
    connectorId: string,
    grantId: string,
  ): Promise<RsConnectorStatePutGrantScope> | RsConnectorStatePutGrantScope;
  /**
   * Notification hook: invoked after grant scope is resolved (or
   * skipped) and before stream validation, so the host can refresh
   * trace id state and emit `state.requested` on the correlated
   * trace. Stream-validation failures and the storage write happen
   * after this notification.
   */
  onGrantResolved(
    grantScope: RsConnectorStatePutGrantScope | null,
  ): Promise<void> | void;
  /**
   * Persist the sync state, scoped to the grant's allowed streams
   * when present.
   */
  putSyncState(
    connectorId: string,
    stateMap: Record<string, unknown>,
    args: {
      grantId: string | null;
      allowedStreams: ReadonlySet<string> | null;
    },
  ): Promise<RsConnectorStatePutState> | RsConnectorStatePutState;
}

export interface RsConnectorStatePutInput {
  readonly connectorId: string;
  readonly grantId: string | null;
  /**
   * Already-coerced `state` map from the request body. The host pulls
   * `req.body?.state` and asserts it is a plain object before calling.
   */
  readonly stateMap: Record<string, unknown>;
}

export interface RsConnectorStatePutOutput {
  readonly state: RsConnectorStatePutState;
  readonly grantScope: RsConnectorStatePutGrantScope | null;
}

/**
 * Execute the canonical `rs.connector-state.put` operation.
 */
export async function executeRsConnectorStatePut(
  input: RsConnectorStatePutInput,
  dependencies: RsConnectorStatePutDependencies,
): Promise<RsConnectorStatePutOutput> {
  const manifest = await dependencies.resolveRegisteredConnectorManifest(
    input.connectorId,
  );

  const grantScope: RsConnectorStatePutGrantScope | null = input.grantId
    ? await dependencies.resolveGrantScope(input.connectorId, input.grantId)
    : null;

  await dependencies.onGrantResolved(grantScope);

  const manifestStreamNames = new Set(
    (manifest.streams || []).map((s) => s.name),
  );

  for (const stream of Object.keys(input.stateMap)) {
    if (!manifestStreamNames.has(stream)) {
      throw new RsConnectorStatePutValidationError(
        "not_found",
        `Stream '${stream}' not found for connector ${input.connectorId}`,
      );
    }
    if (grantScope && !grantScope.grantedStreams.has(stream)) {
      throw new RsConnectorStatePutValidationError(
        "invalid_request",
        `Grant '${input.grantId}' is not scoped to stream ${stream}`,
      );
    }
  }

  const state = await dependencies.putSyncState(
    input.connectorId,
    input.stateMap,
    {
      grantId: input.grantId,
      allowedStreams: grantScope?.grantedStreams ?? null,
    },
  );

  return { state, grantScope };
}
