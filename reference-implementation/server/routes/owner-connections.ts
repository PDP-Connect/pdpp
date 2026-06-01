// HTTP adapter for the bearer-authed owner-agent control surface route
// `GET /v1/owner/connections`.
//
// This is the owner-agent (bearer) sibling of the cookie-authed
// `/_ref/connections` listing in `server/routes/ref-connectors.ts`. Per the
// owner-agent control-surface audit (Lane B) it lives in the `/v1/owner/*`
// route family so it reuses the existing owner-bearer guards
// (`requireToken` + `requireOwner`) without teaching `requireOwnerSession`
// (cookie) a second identity source. `/mcp` owner-bearer rejection
// (`requireClientOrMcpPackage`) is untouched.
//
// The route reuses the connector-instance store, the connector-key
// canonicalizer, and the public-read display-name projection so the
// owner-agent surface agrees with public read on `connection_id`,
// `display_name`, and the fallback/label-needed distinction.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL distinguish connector templates from
//         connection instances")
//       openspec/changes/add-owner-agent-control-surface/specs/
//       reference-connector-instances/spec.md
//       (#"Owner control surfaces SHALL expose connection identity before
//         instance operations")

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-connectors.ts` and `server/routes/rs-mutation.ts`.

interface RouteRequest {
  readonly query: Readonly<Record<string, unknown>>;
  readonly tokenInfo?: { readonly subject_id?: string | null } | null;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// Minimal connector-instance shape this adapter projects. The substrate
// store carries additional fields; these are the ones the projection reads.
interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt?: string | null;
  readonly displayName?: string | null;
  readonly revokedAt?: string | null;
  readonly sourceBinding?: unknown;
  readonly sourceKind?: string | null;
  readonly status?: string | null;
  readonly updatedAt?: string | null;
}

interface ScheduleRow {
  readonly connector_instance_id?: string | null;
}

interface ConnectorInstanceStore {
  listByOwner(ownerSubjectId: string): Promise<ConnectorInstanceRow[]> | ConnectorInstanceRow[];
}

export interface MountOwnerConnectionsContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  getOwnerTokenSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  listSchedules(): Promise<ScheduleRow[]> | ScheduleRow[];
  pdppError: PdppErrorFn;
  // Filters a stored `display_name` to an owner-meaningful label, or `null`
  // when the value is a storage-layer placeholder / connector-type fallback.
  // Reused from `server/connection-id-request.js` so this surface agrees
  // with public read on what counts as "label-needed".
  projectStorageDisplayName(
    displayName: string | null | undefined,
    options: { connectorId?: string | null; connectorInstanceId?: string | null }
  ): string | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  resolveSingleConnectorIdQueryValue(raw: unknown): string | null;
}

// Owner-agent projection of a connector instance. Standardizes on
// `connection_id` as the stable selector and keeps `connector_instance_id`
// as a deprecated alias for compatibility with older clients. Emits both
// `connector_id` and `connector_key` (canonicalized) so an agent can match
// the connector type regardless of which identifier it persisted. Surfaces
// `label_status` so an agent can tell an owner-chosen label
// (`owner_set`) from a storage-layer fallback (`fallback`, i.e.
// label-needed) without re-deriving the placeholder rules.
function projectOwnerConnection(
  ctx: MountOwnerConnectionsContext,
  instance: ConnectorInstanceRow,
  schedulesByInstanceId: ReadonlyMap<string, unknown>
): Record<string, unknown> {
  const connectorKey = ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId;
  const ownerMeaningfulName = ctx.projectStorageDisplayName(instance.displayName, {
    connectorId: connectorKey,
    connectorInstanceId: instance.connectorInstanceId,
  });
  const labelStatus = ownerMeaningfulName ? "owner_set" : "fallback";
  return {
    object: "owner_connection",
    connection_id: instance.connectorInstanceId,
    // Deprecated alias for the stable `connection_id` selector. Kept for
    // compatibility; agents SHOULD persist `connection_id`.
    connector_instance_id: instance.connectorInstanceId,
    connector_id: connectorKey,
    connector_key: connectorKey,
    // The raw stored display name (may be a fallback). `label_status`
    // tells the agent whether this is owner-meaningful or label-needed.
    display_name: instance.displayName,
    label_status: labelStatus,
    status: instance.status,
    source_kind: instance.sourceKind,
    source_binding: instance.sourceBinding,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
    revoked_at: instance.revokedAt,
    schedule: schedulesByInstanceId.get(instance.connectorInstanceId) || null,
  };
}

function connectorIdMatchesFilter(
  ctx: MountOwnerConnectionsContext,
  instance: ConnectorInstanceRow,
  connectorId: string | null
): boolean {
  if (!connectorId) {
    return true;
  }
  return (ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId) === connectorId;
}

// GET /v1/owner/connections — bearer-authed owner-agent listing of every
// configured connection instance for the authenticated owner. Mirrors the
// cookie-authed `/_ref/connections` listing's filtering and projection
// semantics but emits the owner-agent contract (`connection_id`,
// `connector_key`, `label_status`).
export function mountOwnerConnectionsList(app: AppLike, ctx: MountOwnerConnectionsContext): void {
  app.get(
    "/v1/owner/connections",
    { contract: "ownerListConnections" },
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
        const rawConnectorId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id);
        // Canonicalize the owner-supplied connector_id filter so a URL-shaped
        // value (e.g. https://registry.pdpp.org/connectors/amazon) matches the
        // canonical key the instances are stored under. Same boundary handling
        // as `/_ref/connections`.
        const connectorId = rawConnectorId
          ? (ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId)
          : rawConnectorId;
        const status = ctx.resolveSingleConnectorIdQueryValue(req.query.status);
        const store = ctx.createRequestConnectorInstanceStore();
        const instances = await store.listByOwner(ownerSubjectId);
        const schedules = await ctx.listSchedules();
        const schedulesByInstanceId = new Map<string, unknown>(
          schedules
            .filter((schedule) => schedule?.connector_instance_id)
            .map((schedule) => [schedule.connector_instance_id as string, schedule])
        );
        const data = instances
          .filter((instance) => connectorIdMatchesFilter(ctx, instance, connectorId))
          .filter((instance) => !status || instance.status === status)
          .map((instance) => projectOwnerConnection(ctx, instance, schedulesByInstanceId));
        res.json({ object: "list", data });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}
