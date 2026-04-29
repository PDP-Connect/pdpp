/**
 * Canonical `rs.connector-state.get` operation.
 *
 * Owns the Collection Profile owner-authenticated state-read semantics
 * for `GET /v1/state/:connectorId`. The host adapter wires auth (owner
 * + bearer), request id / trace id, instrumentation events
 * (`state.requested`, `state.served`, `state.rejected`), the manifest
 * resolver, the grant-scope resolver, the sync-state read, and the
 * response writing. The operation owns the validation order and the
 * storage call shape.
 *
 * Validation order (preserved from the previous inline route):
 *   1. Resolve connector manifest (host throws on unknown connector).
 *   2. Resolve grant scope when `grantId` is present (host throws on
 *      unknown / non-scoped / non-continuous grant; the resolved
 *      scope carries the persisted `trace_id` / `scenario_id` so the
 *      host can emit on the correlated trace).
 *   3. Notify the host that grant resolution is complete so it can
 *      refresh trace id state and emit `state.requested` before any
 *      storage IO. (`onGrantResolved` dependency callback.)
 *   4. Read sync state, scoped to the grant's allowed streams.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules, the records module,
 *   `server/index.js`, or `process` / `process.env`.
 */

export interface RsConnectorStateGetGrantScope {
  readonly grantId: string;
  readonly grantedStreams: ReadonlySet<string>;
  readonly traceId?: string | null;
  readonly scenarioId?: string;
  readonly [extra: string]: unknown;
}

export interface RsConnectorStateGetState {
  readonly state?: Record<string, unknown> | null;
  readonly updated_at?: string | null;
  readonly [extra: string]: unknown;
}

export interface RsConnectorStateGetDependencies {
  /**
   * Resolve and validate the connector's manifest. The host throws
   * a typed error (`code: 'not_found'`) when the connector is not
   * registered.
   */
  resolveRegisteredConnectorManifest(connectorId: string): Promise<unknown> | unknown;
  /**
   * Resolve the grant scope when `grantId` is provided. Returns
   * `null`-valued result is not allowed; the host throws on
   * unknown / non-scoped / non-continuous grant.
   */
  resolveGrantScope(
    connectorId: string,
    grantId: string,
  ): Promise<RsConnectorStateGetGrantScope> | RsConnectorStateGetGrantScope;
  /**
   * Notification hook: invoked after grant scope is resolved (or
   * skipped) and before any storage IO, so the host can refresh
   * trace id state and emit `state.requested` on the correlated
   * trace.
   */
  onGrantResolved(
    grantScope: RsConnectorStateGetGrantScope | null,
  ): Promise<void> | void;
  /**
   * Read the persisted sync state for the connector, scoped to the
   * grant's allowed streams when present.
   */
  getSyncState(
    connectorId: string,
    args: {
      grantId: string | null;
      allowedStreams: ReadonlySet<string> | null;
    },
  ): Promise<RsConnectorStateGetState> | RsConnectorStateGetState;
}

export interface RsConnectorStateGetInput {
  readonly connectorId: string;
  readonly grantId: string | null;
}

export interface RsConnectorStateGetOutput {
  readonly state: RsConnectorStateGetState;
  readonly grantScope: RsConnectorStateGetGrantScope | null;
}

/**
 * Execute the canonical `rs.connector-state.get` operation.
 */
export async function executeRsConnectorStateGet(
  input: RsConnectorStateGetInput,
  dependencies: RsConnectorStateGetDependencies,
): Promise<RsConnectorStateGetOutput> {
  await dependencies.resolveRegisteredConnectorManifest(input.connectorId);

  const grantScope: RsConnectorStateGetGrantScope | null = input.grantId
    ? await dependencies.resolveGrantScope(input.connectorId, input.grantId)
    : null;

  await dependencies.onGrantResolved(grantScope);

  const state = await dependencies.getSyncState(input.connectorId, {
    grantId: input.grantId,
    allowedStreams: grantScope?.grantedStreams ?? null,
  });

  return { state, grantScope };
}
