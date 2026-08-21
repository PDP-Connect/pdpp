// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-session (cookie-authed) sibling of the bearer owner-agent
// `POST /v1/owner/connections/:connectionId/pause` route
// (`owner-connection-pause.ts`):
//
//   POST /_ref/connections/:connectorInstanceId/pause
//
// Reuses the SAME status-flip primitive (`applyPause` from
// `owner-connection-pause.ts`) — this file adds ONLY a cookie auth adapter,
// never a second pause implementation. It is the exact mirror of the
// owner-session resume route (`ref-connection-resume.ts`).
//
// Unlike the bearer route, this session-facing entrypoint targets exactly one
// connectorInstanceId (no connector-only/auto-select variant — the console
// always knows the exact connection it is acting on).
//
// Error taxonomy (same codes as the bearer route):
//   - foreign/unknown id -> connector_instance_not_found (404)
//   - non-active id -> connector_instance_not_active (409)

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import { applyPause, type PauseApplyContext, pauseResponse } from "./owner-connection-pause.ts";

interface RouteRequest {
  ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  getHeader?: (name: string) => string | number | string[] | undefined;
  json: (body: unknown) => unknown;
  setHeader?: (name: string, value: string) => void;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

interface ConnectorNamespace {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
}

export interface MountRefConnectionPauseContext extends PauseApplyContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  getOwnerSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  // Resolves the connector-instance namespace for the given owner. Scoped to
  // an EXACT connectorInstanceId (no connector-only fallback); admits
  // `allowStatuses: ['active']` so a non-active target surfaces
  // `connector_instance_inactive` from the resolver, re-labelled below.
  resolveOwnerConnectorNamespace: (
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly allowStatuses?: readonly string[];
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ) => Promise<ConnectorNamespace>;
  setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
}

function buildAuditTrace(ctx: MountRefConnectionPauseContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return { request_id: requestId, scenario_id: trace.scenario_id, trace_id: trace.trace_id };
}

async function emitSessionPauseAudit(
  ctx: MountRefConnectionPauseContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId: string | null;
    connectorId?: string | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const ownerSubjectId = args.ownerSubjectId ?? req.ownerSession?.sub ?? null;
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    actor_id: ownerSubjectId ?? "owner_session",
    actor_type: "owner_session",
    data: {
      connection_id: args.connectionId ?? null,
      connector_id: args.connectorId ?? null,
      operation: "pause",
      outcome: args.outcome,
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
            },
          }
        : {}),
    },
    event_type: "owner.connection.pause",
    object_id: args.connectionId ?? "unknown_connection",
    object_type: "connection",
    request_id: trace.request_id,
    scenario_id: trace.scenario_id,
    status: args.outcome,
    subject_id: ownerSubjectId,
    subject_type: "subject",
    trace_id: trace.trace_id,
  });
}

async function resolveSessionPauseNamespace(
  ctx: MountRefConnectionPauseContext,
  req: RouteRequest,
  res: RouteResponse,
  ownerSubjectId: string,
  connectorInstanceId: string
): Promise<ConnectorNamespace | null> {
  try {
    return await ctx.resolveOwnerConnectorNamespace(req, null, {
      allowDefaultAccount: false,
      allowStatuses: ["active"],
      connectorInstanceId,
      ownerSubjectId,
    });
  } catch (resolveErr) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    const code = (resolveErr as { code?: unknown })?.code;
    if (code === "connector_instance_inactive") {
      ctx.pdppError(
        res,
        409,
        "connector_instance_not_active",
        `Connection '${connectorInstanceId}' is not active; only active connections can be paused.`
      );
      return null;
    }
    throw resolveErr;
  }
}

// POST /_ref/connections/:connectorInstanceId/pause
//
// Owner-session-only. Pauses exactly one active connection so no future run
// lands for it. Zero cascade: records, grants, schedule, stored credential,
// and audit spine are untouched, and the row is resumable through
// `POST /_ref/connections/:connectorInstanceId/resume`.
export function mountRefConnectionPause(app: AppLike, ctx: MountRefConnectionPauseContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/pause",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
      let ownerSubjectId: string | null = null;
      let connectorKey: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        const namespace = await resolveSessionPauseNamespace(ctx, req, res, ownerSubjectId, connectorInstanceId);
        if (!namespace) {
          return;
        }
        connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;

        const { paused, stamp } = await applyPause(ctx, namespace.connectorInstanceId);

        await emitSessionPauseAudit(ctx, req, res, {
          connectionId: connectorInstanceId,
          connectorId: connectorKey,
          outcome: "succeeded",
          ownerSubjectId,
        });
        res.status(200).json(pauseResponse(connectorInstanceId, connectorKey, paused, stamp));
      } catch (err) {
        await emitSessionPauseAudit(ctx, req, res, {
          connectionId: connectorInstanceId,
          connectorId: connectorKey,
          error: err,
          outcome: "failed",
          ownerSubjectId,
        });
        ctx.handleError(res, err);
      }
    }
  );
}
