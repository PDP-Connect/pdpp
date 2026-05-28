// HTTP adapter for the reference-only `/_ref/{traces,grants,runs}` list
// endpoints.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`. Each `mount...` function
// registers one route at the same point in registration order where
// `server/index.js` previously registered it inline. Owner-session posture,
// query-string parsing, response envelopes, and error handling are unchanged.
//
// The canonical `ref.spine.correlations.list` operation (see
// `operations/ref-spine-correlations-list`) owns the envelope shape; this
// adapter owns owner-auth, query-string parsing, and error→HTTP mapping.

import {
  executeRefSpineCorrelationsList,
  type RefSpineCorrelationFilters,
  type RefSpineCorrelationKind,
  type RefSpineCorrelationPage,
} from "../../operations/ref-spine-correlations-list/index.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/root-and-discovery.ts`.

interface RouteRequest {
  readonly query: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown;
type MiddlewareHandler = (...args: unknown[]) => unknown;

interface AppLike {
  get(path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]): AppLike;
}

export interface MountRefSpineCorrelationsContext {
  handleError(res: unknown, err: unknown): void;
  listSpineCorrelations(
    kind: RefSpineCorrelationKind,
    filters: RefSpineCorrelationFilters
  ): Promise<RefSpineCorrelationPage> | RefSpineCorrelationPage;
  requireOwnerSession: MiddlewareHandler;
}

// `parseListFilters` matches the inline closure that previously lived in
// `buildAsApp`. Filters are forwarded opaquely to the operation, which
// forwards them to `listSpineCorrelations`. Keeping parsing here (host
// adapter) preserves the operation's free-form filter bag contract.
function parseListFilters(query: Readonly<Record<string, unknown>>): RefSpineCorrelationFilters {
  const rawConnectorId = query.connector_id;
  const legacyConnectorId = typeof rawConnectorId === "string" && rawConnectorId.trim() ? rawConnectorId.trim() : null;
  return {
    limit: query.limit,
    cursor: query.cursor,
    since: query.since,
    until: query.until,
    status: query.status,
    clientId: query.client_id,
    sourceKind: query.source_kind || (legacyConnectorId ? "connector" : undefined),
    sourceId: query.source_id || legacyConnectorId || undefined,
    grantId: query.grant_id,
    q: query.q,
  };
}

function mountKind(
  app: AppLike,
  ctx: MountRefSpineCorrelationsContext,
  path: string,
  kind: RefSpineCorrelationKind
): void {
  const deps = {
    listSpineCorrelations: (k: RefSpineCorrelationKind, filters: RefSpineCorrelationFilters) =>
      ctx.listSpineCorrelations(k, filters),
  };
  app.get(path, ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const envelope = await executeRefSpineCorrelationsList({ kind, filters: parseListFilters(req.query) }, deps);
      res.json(envelope);
    } catch (err) {
      ctx.handleError(res, err);
    }
  });
}

// Spine correlation list routes delegate envelope assembly to the canonical
// `ref.spine.correlations.list` operation. The host adapter retains
// ownership of owner-auth, query-string parsing, and error→HTTP mapping;
// the operation owns response shape (per-kind discriminators, pagination
// fields, and live-bearer redaction on timelines). See
// openspec/changes/mount-ref-spine-operations.

export function mountRefTraces(app: AppLike, ctx: MountRefSpineCorrelationsContext): void {
  mountKind(app, ctx, "/_ref/traces", "trace");
}

export function mountRefGrants(app: AppLike, ctx: MountRefSpineCorrelationsContext): void {
  mountKind(app, ctx, "/_ref/grants", "grant");
}

export function mountRefRuns(app: AppLike, ctx: MountRefSpineCorrelationsContext): void {
  mountKind(app, ctx, "/_ref/runs", "run");
}
