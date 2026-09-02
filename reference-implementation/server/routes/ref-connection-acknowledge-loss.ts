// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-session (cookie-authed) route that stamps a durable, attributed
// acknowledgement of permanent, externally-caused data loss:
//
//   POST /_ref/connections/:connectorInstanceId/acknowledge-loss
//
// This is the missing write path for `runtime/acknowledged-loss.ts`, which
// already defines the record shape, validation, and rendering (read side is
// wired through `ref-control.ts` -> `connector-verdict-input.ts` ->
// `rendered-verdict.ts`) but had no caller that could ever produce a stamped
// record. `updateSourceBindingPatch` (`connector-instance-store.ts`) is the
// generic merge-patch primitive this route calls — the same one the SQL
// query's own doc comment already documents as the intended acknowledgement
// writer.
//
// Deliberately connector-agnostic: the request body carries `cause`, `scope`,
// and an optional `note`/`streams`, never a connector id branch. The SAME
// route stamps GroupMe's confirmed pre-2013 retention cliff and H-E-B's
// owner-confirmed upstream purge — two instances of one mechanism, per
// BANNER-ZERO-PLAN.md workstream E's "no RI branches on connector IDs" rule.
//
// Acknowledging a loss does NOT pause, revoke, or otherwise change the
// connection's status: the source keeps collecting anything still reachable
// (see acknowledged-loss.ts's module doc comment). That is why this cannot
// reuse the status-flip pause/resume routes and instead calls
// `updateSourceBindingPatch` directly, exactly as the SQL query's own comment
// prescribes.
//
// Error taxonomy:
//   - foreign/unknown id -> connector_instance_not_found (404)
//   - malformed body (bad cause/scope/actor/timestamp) -> invalid_request (400)

import {
  type AcknowledgedLossCause,
  type AcknowledgedLossRecord,
  type AcknowledgedLossScope,
  isAcknowledgedLossRecord,
} from "../../runtime/acknowledged-loss.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  readonly body?: unknown;
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

export interface MountRefConnectionAcknowledgeLossContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  getOwnerSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  now?: () => string;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
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
  updateSourceBindingPatch: (
    connectorInstanceId: string,
    options: { sourceBindingPatch: Record<string, unknown>; updatedAt: string }
  ) => Promise<unknown> | unknown;
}

const CAUSES: ReadonlySet<string> = new Set<AcknowledgedLossCause>([
  "provider_access_withdrawn",
  "provider_data_contradictory",
  "provider_deleted_upstream",
]);
const SCOPES: ReadonlySet<string> = new Set<AcknowledgedLossScope>(["partial", "total"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate and normalize the request body into an `AcknowledgedLossRecord`,
 * or return the specific field that failed so the caller can report a precise
 * `invalid_request`. `acknowledgedBy` is supplied by the caller (there is no
 * owner-display-name concept on the server; the owner states their own name,
 * matching the design note's "the confirmation act itself... should write a
 * record with an actor"). `acknowledgedAt` defaults to now if absent.
 */
export function parseAcknowledgeLossBody(
  body: unknown,
  nowIso: string
): { error: string; ok: false } | { ok: true; record: AcknowledgedLossRecord } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "request body must be a JSON object", ok: false };
  }
  const b = body as Record<string, unknown>;
  if (!(isNonEmptyString(b.cause) && CAUSES.has(b.cause))) {
    return {
      error: "cause must be one of provider_access_withdrawn, provider_data_contradictory, provider_deleted_upstream",
      ok: false,
    };
  }
  if (!(isNonEmptyString(b.scope) && SCOPES.has(b.scope))) {
    return { error: "scope must be one of partial, total", ok: false };
  }
  if (!isNonEmptyString(b.acknowledged_by)) {
    return { error: "acknowledged_by must be a non-empty string", ok: false };
  }
  const acknowledgedAt = isNonEmptyString(b.acknowledged_at) ? b.acknowledged_at : nowIso;
  if (Number.isNaN(Date.parse(acknowledgedAt))) {
    return { error: "acknowledged_at must be a parseable ISO-8601 instant", ok: false };
  }
  let streams: readonly string[] | undefined;
  const { streams: rawStreams } = b;
  if (rawStreams !== undefined) {
    if (!(Array.isArray(rawStreams) && rawStreams.every((s) => typeof s === "string"))) {
      return { error: "streams must be an array of strings when present", ok: false };
    }
    streams = rawStreams;
  }
  const record: AcknowledgedLossRecord = {
    acknowledgedAt,
    acknowledgedBy: b.acknowledged_by.trim(),
    // Cast is safe: both fields were just checked against their closed Set
    // above, mirroring `isAcknowledgedLossRecord`'s own narrowing shape.
    cause: b.cause as AcknowledgedLossCause,
    ...(isNonEmptyString(b.note) ? { note: b.note.trim() } : {}),
    scope: b.scope as AcknowledgedLossScope,
    ...(streams ? { streams } : {}),
  };
  // Defense in depth: the record built above must itself pass the shared
  // reader's validator, so this route can never stamp something
  // `readAcknowledgedLoss` would refuse to read back.
  return isAcknowledgedLossRecord(record)
    ? { ok: true, record }
    : { error: "constructed record failed validation", ok: false };
}

function buildAuditTrace(ctx: MountRefConnectionAcknowledgeLossContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return { request_id: requestId, scenario_id: trace.scenario_id, trace_id: trace.trace_id };
}

async function emitAcknowledgeLossAudit(
  ctx: MountRefConnectionAcknowledgeLossContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    cause?: string | null;
    connectionId: string | null;
    connectorId?: string | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
    scope?: string | null;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const ownerSubjectId = args.ownerSubjectId ?? req.ownerSession?.sub ?? null;
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    actor_id: ownerSubjectId ?? "owner_session",
    actor_type: "owner_session",
    data: {
      cause: args.cause ?? null,
      connection_id: args.connectionId ?? null,
      connector_id: args.connectorId ?? null,
      operation: "acknowledge_loss",
      outcome: args.outcome,
      scope: args.scope ?? null,
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
            },
          }
        : {}),
    },
    event_type: "owner.connection.acknowledge_loss",
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

async function resolveAcknowledgeLossNamespace(
  ctx: MountRefConnectionAcknowledgeLossContext,
  req: RouteRequest,
  res: RouteResponse,
  ownerSubjectId: string,
  connectorInstanceId: string
): Promise<ConnectorNamespace | null> {
  try {
    // No `allowStatuses` restriction: an acknowledgement is a durable fact
    // about data the connection holds (or once held), which is meaningful
    // whether the connection is currently active or paused. It is meaningless
    // for a revoked connection (nothing left to explain), so revoked is the
    // only status excluded.
    return await ctx.resolveOwnerConnectorNamespace(req, null, {
      allowDefaultAccount: false,
      allowStatuses: ["active", "paused"],
      connectorInstanceId,
      ownerSubjectId,
    });
  } catch (resolveErr) {
    const code = (resolveErr as { code?: unknown } | null)?.code;
    if (code === "connector_instance_inactive") {
      ctx.pdppError(
        res,
        409,
        "connector_instance_not_active",
        `Connection '${connectorInstanceId}' is revoked; there is nothing left to acknowledge.`
      );
      return null;
    }
    throw resolveErr;
  }
}

// POST /_ref/connections/:connectorInstanceId/acknowledge-loss
//
// Owner-session-only. Stamps a durable, attributed record that some of this
// connection's data is permanently gone for a reason outside PDPP, which the
// owner has examined and accepted. Does not pause, revoke, delete, or retry
// anything — see the module doc comment.
export function mountRefConnectionAcknowledgeLoss(app: AppLike, ctx: MountRefConnectionAcknowledgeLossContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/acknowledge-loss",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
      let ownerSubjectId: string | null = null;
      let connectorKey: string | null = null;
      let parsedCause: string | null = null;
      let parsedScope: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        const namespace = await resolveAcknowledgeLossNamespace(ctx, req, res, ownerSubjectId, connectorInstanceId);
        if (!namespace) {
          return;
        }
        connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;

        const nowIso = ctx.now ? ctx.now() : new Date().toISOString();
        const parsed = parseAcknowledgeLossBody(req.body, nowIso);
        if (!parsed.ok) {
          ctx.pdppError(res, 400, "invalid_request", parsed.error);
          return;
        }
        parsedCause = parsed.record.cause;
        parsedScope = parsed.record.scope;

        await Promise.resolve(
          ctx.updateSourceBindingPatch(namespace.connectorInstanceId, {
            sourceBindingPatch: { acknowledged_loss: parsed.record },
            updatedAt: nowIso,
          })
        );

        await emitAcknowledgeLossAudit(ctx, req, res, {
          cause: parsedCause,
          connectionId: connectorInstanceId,
          connectorId: connectorKey,
          outcome: "succeeded",
          ownerSubjectId,
          scope: parsedScope,
        });
        res.status(200).json({
          acknowledged_loss: parsed.record,
          connection_id: connectorInstanceId,
          connector_id: connectorKey,
          object: "owner_connection_acknowledge_loss",
        });
      } catch (err) {
        await emitAcknowledgeLossAudit(ctx, req, res, {
          cause: parsedCause,
          connectionId: connectorInstanceId,
          connectorId: connectorKey,
          error: err,
          outcome: "failed",
          ownerSubjectId,
          scope: parsedScope,
        });
        ctx.handleError(res, err);
      }
    }
  );
}
