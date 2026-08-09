// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-facing read/write surface for a local connection's declared collection
// scope:
//
//   GET    /v1/owner/connections/:connectionId/collection-scope
//   PUT    /v1/owner/connections/:connectionId/collection-scope
//   DELETE /v1/owner/connections/:connectionId/collection-scope
//
// This is the mechanism that makes a bounded collection horizon reachable. The
// scope machinery is worthless without it: an owner who cannot declare a
// boundary runs unscoped by construction, so every "complete" claim is a
// whole-corpus claim.
//
// Persistence deliberately reuses `connector_state` under the reserved
// `$collection_scope` key rather than adding a column, because that row is
// already the durable per-connection store the collector reads at run start —
// so writing here both persists the boundary AND delivers it, with no migration
// and no second transport. See `server/local-collection-scope.ts` for why the
// alternatives (identity-bearing `source_binding_json`, heartbeat-clobbered
// diagnostics columns) are not viable homes.
//
// Changing or clearing the scope DECLASSIFIES prior coverage proof for this
// connection: evidence measured against a different region does not describe
// the new one, so it must be recomputed by a fresh run rather than
// reinterpreted. The route performs that declassification as part of the write,
// so proof can never outlive the boundary it was measured against.

import { buildStoredCollectionScope, COLLECTION_SCOPE_STATE_KEY } from "../local-collection-scope.ts";

interface RouteRequest {
  readonly body?: unknown;
  readonly params: Readonly<Record<string, string>>;
  readonly tokenInfo?: {
    readonly pdpp_token_kind?: string | null;
    readonly subject_id?: string | null;
  } | null;
}

interface RouteResponse {
  end: () => unknown;
  json: (body: unknown) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  delete: (path: string, ...args: unknown[]) => AppLike;
  get: (path: string, ...args: unknown[]) => AppLike;
  put: (path: string, ...args: unknown[]) => AppLike;
}

export interface MountOwnerConnectionCollectionScopeContext {
  /**
   * Drops committed coverage proof for this connection so it cannot outlive the
   * boundary it was measured against. Optional: a host without the read model
   * warmed simply has nothing to declassify.
   */
  declassifyCollectionProof?: (input: {
    connectorInstanceId: string;
    reason: string;
  }) => Promise<void> | void;
  getOwnerTokenSubjectId: (req: unknown) => string;
  getSyncState: (
    target: unknown,
    opts: { grantId: null }
  ) => Promise<{ state?: Record<string, unknown> | null }> | { state?: Record<string, unknown> | null };
  handleError: (res: unknown, err: unknown) => void;
  /** Run-clock, injected so the handler stays testable and total. */
  now?: () => Date;
  pdppError: (res: RouteResponse, status: number, code: string, message: string) => void;
  putSyncState: (target: unknown, stateMap: Record<string, unknown>, opts: { grantId: null }) => Promise<unknown>;
  referenceLocalDeviceStorageTarget: (connectorId: string, connectorInstanceId: string) => unknown;
  requireOwner: unknown;
  requireToken: unknown;
  resolveOwnerConnectorNamespace: (
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ) => Promise<{ connectorId: string; connectorInstanceId: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the owner's declared boundary.
 *
 * Rejects rather than coerces: a `since` the server cannot parse would become a
 * boundary that silently matches everything, and a non-string root would widen
 * the selection. An owner who mistypes a bound must be told, not quietly given
 * a full-corpus run that reports itself as scoped.
 */
function parseScopeBody(body: unknown): { error: string } | { scope: { since?: string; source_roots?: string[] } } {
  if (!isRecord(body)) {
    return { error: "body must be an object" };
  }
  const out: { since?: string; source_roots?: string[] } = {};
  if (body.since !== undefined && body.since !== null) {
    if (typeof body.since !== "string" || !body.since.trim()) {
      return { error: "since must be a non-empty ISO-8601 string" };
    }
    if (Number.isNaN(Date.parse(body.since.trim()))) {
      return { error: `since is not a parseable instant: ${body.since}` };
    }
    out.since = body.since.trim();
  }
  // Root format, stated here because it is the field an owner most easily gets
  // wrong: give a natural absolute project path (`/home/you/code/project`) or a
  // bare project directory name. Connectors translate that to their own on-disk
  // layout (Claude Code flattens paths into single directory names), so the
  // owner never types an encoded form. A root that matches nothing is reported
  // by the connector as a skip rather than silently collecting an empty set.
  if (body.source_roots !== undefined && body.source_roots !== null) {
    if (!Array.isArray(body.source_roots)) {
      return { error: "source_roots must be an array of strings" };
    }
    const roots: string[] = [];
    for (const root of body.source_roots) {
      if (typeof root !== "string" || !root.trim()) {
        return { error: "source_roots entries must be non-empty strings" };
      }
      roots.push(root.trim());
    }
    if (roots.length > 0) {
      out.source_roots = roots;
    }
  }
  if (out.since === undefined && out.source_roots === undefined) {
    return { error: "declare at least one of since or source_roots (use DELETE to clear)" };
  }
  return { scope: out };
}

async function writeScope(
  ctx: MountOwnerConnectionCollectionScopeContext,
  namespace: { connectorId: string; connectorInstanceId: string },
  scope: { since?: string; source_roots?: string[] } | null
): Promise<{ declared_at: string; fingerprint: string; scope: unknown }> {
  const now = (ctx.now?.() ?? new Date()).toISOString();
  const stored = buildStoredCollectionScope(scope, now);
  const target = ctx.referenceLocalDeviceStorageTarget(namespace.connectorId, namespace.connectorInstanceId);
  await ctx.putSyncState(target, { [COLLECTION_SCOPE_STATE_KEY]: stored }, { grantId: null });
  // The boundary just changed, so any coverage committed under the previous one
  // no longer describes what is now declared. Declassify rather than reinterpret.
  await ctx.declassifyCollectionProof?.({
    connectorInstanceId: namespace.connectorInstanceId,
    reason: `collection scope changed to ${stored.fingerprint}`,
  });
  return stored;
}

function buildGetHandler(ctx: MountOwnerConnectionCollectionScopeContext): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    try {
      const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
      const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
        allowDefaultAccount: false,
        connectorInstanceId: decodeURIComponent(req.params.connectionId as string),
        ownerSubjectId,
      });
      const target = ctx.referenceLocalDeviceStorageTarget(namespace.connectorId, namespace.connectorInstanceId);
      const projection = await ctx.getSyncState(target, { grantId: null });
      const { readStoredCollectionScope } = await import("../local-collection-scope.ts");
      const current = readStoredCollectionScope(projection.state ?? {});
      res.json({
        connection_id: namespace.connectorInstanceId,
        fingerprint: current.fingerprint,
        object: "collection_scope",
        scope: current.scope,
      });
    } catch (err) {
      ctx.handleError(res, err);
    }
  };
}

function buildPutHandler(ctx: MountOwnerConnectionCollectionScopeContext): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    try {
      const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
      const parsed = parseScopeBody(req.body);
      if ("error" in parsed) {
        ctx.pdppError(res, 400, "invalid_request", parsed.error);
        return;
      }
      const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
        allowDefaultAccount: false,
        connectorInstanceId: decodeURIComponent(req.params.connectionId as string),
        ownerSubjectId,
      });
      const stored = await writeScope(ctx, namespace, parsed.scope);
      res.json({
        connection_id: namespace.connectorInstanceId,
        declared_at: stored.declared_at,
        fingerprint: stored.fingerprint,
        object: "collection_scope",
        scope: stored.scope,
      });
    } catch (err) {
      ctx.handleError(res, err);
    }
  };
}

function buildDeleteHandler(ctx: MountOwnerConnectionCollectionScopeContext): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    try {
      const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
      const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
        allowDefaultAccount: false,
        connectorInstanceId: decodeURIComponent(req.params.connectionId as string),
        ownerSubjectId,
      });
      // Clearing is a boundary CHANGE (to `unscoped`), not an absence of one, so
      // it declassifies prior proof exactly like any other change.
      await writeScope(ctx, namespace, null);
      res.status(204).end();
    } catch (err) {
      ctx.handleError(res, err);
    }
  };
}

export function mountOwnerConnectionCollectionScope(
  app: AppLike,
  ctx: MountOwnerConnectionCollectionScopeContext
): void {
  app.get(
    "/v1/owner/connections/:connectionId/collection-scope",
    ctx.requireToken,
    ctx.requireOwner,
    buildGetHandler(ctx)
  );
  app.put(
    "/v1/owner/connections/:connectionId/collection-scope",
    ctx.requireToken,
    ctx.requireOwner,
    buildPutHandler(ctx)
  );
  app.delete(
    "/v1/owner/connections/:connectionId/collection-scope",
    ctx.requireToken,
    ctx.requireOwner,
    buildDeleteHandler(ctx)
  );
}
