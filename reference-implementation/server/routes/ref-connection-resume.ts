// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-session (cookie-authed) sibling of the bearer owner-agent
// `POST /v1/owner/connections/:connectionId/resume` route
// (`owner-connection-resume.ts`):
//
//   POST /_ref/connections/:connectorInstanceId/resume
//
// Reuses the SAME status-flip primitive (`applyResume` from
// `owner-connection-resume.ts`) — this file adds ONLY a cookie auth adapter,
// never a second resume implementation.
//
// Unlike the bearer route, this session-facing entrypoint targets exactly one
// connectorInstanceId (no connector-only/auto-select variant — the console
// always knows the exact connection it is acting on).
//
// It does NOT restrict the target's `source_binding.kind`. An earlier revision
// required `historical_archive` here, because the only shipped use of
// owner-session resume was the recovered-archive reconnect journey. Pause is
// now a first-class owner ACTION (`ref-connection-pause.ts`), so any
// connection the owner paused must be resumable from the same console — a
// guard admitting only archive rows would strand every ordinarily-paused
// source in exactly the dead end this pair of routes exists to remove.
//
// `applyResume`'s optional `requireSourceBindingKind` parameter is
// deliberately still supported and still used: the credential-capture and
// browser-run AUTO-resume hooks in `index.ts` pass `historical_archive`
// because those fire implicitly, without an owner deciding to resume this
// connection. An implicit hook stays narrow; an explicit owner click does not.
//
// Error taxonomy (same codes as the bearer route):
//   - foreign/unknown id -> connector_instance_not_found (404)
//   - non-paused id -> connector_instance_not_paused (409)

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import { applyResume, type ResumeApplyContext, resumeResponse } from "./owner-connection-resume.ts";

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

// The binding kind that the IMPLICIT auto-resume hooks require on a target
// row. This route no longer applies it (see the file header), but the
// credential-capture and browser-run auto-resume call sites — which invoke
// `applyResume` directly rather than through HTTP, without an owner deciding
// to resume this connection — still pin this identical literal, with no risk
// of those call sites drifting apart.
export const HISTORICAL_ARCHIVE_SOURCE_BINDING_KIND = "historical_archive";

export interface MountRefConnectionResumeContext extends ResumeApplyContext {
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
  // `allowStatuses: ['paused']` so a non-paused target surfaces
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

function buildAuditTrace(ctx: MountRefConnectionResumeContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return { request_id: requestId, scenario_id: trace.scenario_id, trace_id: trace.trace_id };
}

async function emitSessionResumeAudit(
  ctx: MountRefConnectionResumeContext,
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
      operation: "resume",
      outcome: args.outcome,
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
            },
          }
        : {}),
    },
    event_type: "owner.connection.resume",
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

async function resolveSessionResumeNamespace(
  ctx: MountRefConnectionResumeContext,
  req: RouteRequest,
  res: RouteResponse,
  ownerSubjectId: string,
  connectorInstanceId: string
): Promise<ConnectorNamespace | null> {
  try {
    return await ctx.resolveOwnerConnectorNamespace(req, null, {
      allowDefaultAccount: false,
      allowStatuses: ["paused"],
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
        "connector_instance_not_paused",
        `Connection '${connectorInstanceId}' is not paused; only paused connections can be resumed.`
      );
      return null;
    }
    throw resolveErr;
  }
}

// POST /_ref/connections/:connectorInstanceId/resume
//
// Owner-session-only. Resumes exactly one paused connection back to active,
// whatever its source-binding kind. No credential validation, no run trigger —
// the caller (e.g. the console's Resume action, or the credential-capture and
// browser-run flows) is responsible for sequencing this before starting a run.
export function mountRefConnectionResume(app: AppLike, ctx: MountRefConnectionResumeContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/resume",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
      let ownerSubjectId: string | null = null;
      let connectorKey: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        const namespace = await resolveSessionResumeNamespace(ctx, req, res, ownerSubjectId, connectorInstanceId);
        if (!namespace) {
          return;
        }
        connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;

        const { resumed, stamp } = await applyResume(ctx, namespace.connectorInstanceId);

        await emitSessionResumeAudit(ctx, req, res, {
          connectionId: connectorInstanceId,
          connectorId: connectorKey,
          outcome: "succeeded",
          ownerSubjectId,
        });
        res.status(200).json(resumeResponse(connectorInstanceId, connectorKey, resumed, stamp));
      } catch (err) {
        await emitSessionResumeAudit(ctx, req, res, {
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
