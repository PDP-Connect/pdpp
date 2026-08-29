// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-session (cookie-authed) route that records a durable, attributed
// coverage horizon — the boundary of what a source can ever provide:
//
//   POST /_ref/connections/:connectorInstanceId/coverage-horizon
//
// This is the missing write path for `ConnectorCoverageHorizonStore`, whose
// `confirmCoverageHorizon` had no production caller: the read side is wired
// (`ref-control.ts` -> `connection-health.ts` -> `rendered-verdict.ts`), but
// nothing could put a row in `connector_coverage_horizons` without manual SQL,
// which the banner-zero plan forbids.
//
// DISTINCT FROM `acknowledge-loss`, deliberately. That route stamps
// `source_binding.acknowledged_loss`: "data I once had, or could have had, is
// permanently gone." This route records a different fact in a different store:
// "this provider will never serve anything before <date>, and here is who
// established that, when, and on what basis." One is a statement about loss;
// the other is a statement about SCOPE. They are not interchangeable and must
// not be merged — a source can have a horizon with no loss (the provider simply
// never offered older history) and a loss with no horizon (a one-off deletion
// inside an otherwise-servable window).
//
// Connector-agnostic by construction: the body carries `basis`, `reason`,
// `earliest_available` and an optional `stream`/`note`, never a connector id
// branch. The SAME route records GroupMe's pre-2013 retention cliff and any
// other provider's boundary, per BANNER-ZERO-PLAN.md workstream E's
// "no RI branches on connector IDs" rule.
//
// Recording a horizon does NOT pause, revoke, or change the connection's
// status, never rewrites or deletes retained records, and does NOT narrow the
// coverage denominator or alter any health classification — it is disclosure
// an owner reads, nothing more (see `server/connector-gap-classification.ts`).
// The structural precedent from `upstream-retention-loss-health-ux-prior-art.md`
// is PyPI's yank: a fact recorded once, reversible only by explicit revision,
// that never participates in the "is this broken" verdict.
//
// Error taxonomy:
//   - foreign/unknown id -> connector_instance_not_found (404)
//   - malformed body (bad basis/reason/actor/timestamp) -> invalid_request (400)

import type { CoverageHorizonBasis, CoverageHorizonReason } from "../../runtime/coverage-horizon.ts";
import type { ConfirmCoverageHorizonInput } from "../stores/connector-coverage-horizon-store.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

/**
 * Closed vocabularies, mirrored from `runtime/coverage-horizon.ts`. Kept as
 * runtime Sets because a TypeScript union cannot validate a JSON body: an
 * unrecognized value must be REFUSED, never coerced or guessed.
 */
const BASES: ReadonlySet<string> = new Set<CoverageHorizonBasis>([
  "inferred_from_stable_boundary",
  "provider_confirmed",
  "provider_stated",
]);

const REASONS: ReadonlySet<string> = new Set<CoverageHorizonReason>([
  "consent_window",
  "provider_deleted_history",
  "provider_never_had_data",
  "provider_retention_policy",
]);

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

export interface MountRefConnectionConfirmCoverageHorizonContext {
  readonly canonicalConnectorKey: (connectorId: string) => string | null;
  readonly confirmCoverageHorizon: (input: ConfirmCoverageHorizonInput) => Promise<unknown>;
  readonly createTraceContext: () => { readonly scenario_id: string; readonly trace_id: string };
  readonly emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  readonly ensureRequestId: (res: RouteResponse) => string;
  readonly getOwnerSubjectId: (req: RouteRequest) => string | null;
  readonly handleError: (res: RouteResponse, err: unknown) => void;
  readonly now?: () => string;
  readonly pdppError: PdppErrorFn;
  readonly requireOwnerSession: MiddlewareHandler;
  readonly resolveOwnerConnectorNamespace: (
    req: RouteRequest,
    res: RouteResponse | null,
    opts: {
      readonly allowDefaultAccount?: boolean;
      readonly allowStatuses?: readonly string[];
      readonly connectorInstanceId: string;
      readonly ownerSubjectId: string | null;
    }
  ) => Promise<{ readonly connectorId: string; readonly connectorInstanceId: string } | null>;
  readonly setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
}

function buildAuditTrace(ctx: MountRefConnectionConfirmCoverageHorizonContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return { request_id: requestId, scenario_id: trace.scenario_id, trace_id: trace.trace_id };
}

/**
 * Bounded audit: closed-vocabulary fields and an error CODE only. The owner's
 * free-text `note` and the boundary date are deliberately NOT emitted — the
 * durable horizon row already carries them, and an audit stream is the wrong
 * place to duplicate owner prose.
 */
async function emitCoverageHorizonAudit(
  ctx: MountRefConnectionConfirmCoverageHorizonContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    basis?: string | null;
    connectionId: string | null;
    connectorId?: string | null;
    error?: unknown;
    outcome: "failed" | "succeeded";
    ownerSubjectId?: string | null;
    reason?: string | null;
    stream?: string | null;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const ownerSubjectId = args.ownerSubjectId ?? req.ownerSession?.sub ?? null;
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    actor_id: ownerSubjectId ?? "owner_session",
    actor_type: "owner_session",
    data: {
      basis: args.basis ?? null,
      connection_id: args.connectionId ?? null,
      connector_id: args.connectorId ?? null,
      operation: "confirm_coverage_horizon",
      outcome: args.outcome,
      reason: args.reason ?? null,
      stream: args.stream ?? null,
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
            },
          }
        : {}),
    },
    event_type: "owner.connection.confirm_coverage_horizon",
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type ParsedCoverageHorizonBody =
  | { readonly error: string; readonly ok: false }
  | { readonly ok: true; readonly record: Omit<ConfirmCoverageHorizonInput, "connectorInstanceId"> };

/**
 * Validate a body into store input, or return the exact field that failed so
 * the caller reports a precise reason rather than a generic rejection.
 *
 * Fails closed on every axis. Two controls are load-bearing for evidence
 * integrity, not mere hygiene:
 *
 *  - `confirmedBy` is NOT read from the body. It is the authenticated owner
 *    subject, passed in by the route. A caller-supplied actor on an evidence
 *    record is a fabricable attribution: the whole point of `basis`/`reason`
 *    provenance is that "who confirmed this" is checkable, and a body field
 *    would let any authenticated request attribute the confirmation to anyone.
 *    The body may still carry a free-text `note` for the owner's own words.
 *  - `confirmed_at` must not be in the FUTURE. A horizon is disclosure an
 *    owner reads and an auditor walks, and every read treats a current
 *    (non-superseded) row as live. A future-stamped row would present as live
 *    disclosure immediately while appearing not-yet-valid to a human reader —
 *    the exact shape that turns an audit record into a lie. This holds
 *    independently of classification: the horizon no longer narrows the
 *    coverage denominator at all (see `server/connector-gap-classification.ts`),
 *    and an honest timestamp is required for the disclosure's own sake.
 */
export function parseCoverageHorizonBody(
  body: unknown,
  nowIso: string,
  confirmedBy: string
): ParsedCoverageHorizonBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "request body must be a JSON object", ok: false };
  }
  const b = body as Record<string, unknown>;
  if (!(isNonEmptyString(b.basis) && BASES.has(b.basis))) {
    return {
      error: `basis must be one of ${[...BASES].sort().join(", ")}`,
      ok: false,
    };
  }
  if (!(isNonEmptyString(b.reason) && REASONS.has(b.reason))) {
    return { error: `reason must be one of ${[...REASONS].sort().join(", ")}`, ok: false };
  }
  // Deliberately refused rather than ignored: a caller who believes they are
  // setting the actor must be told they are not, or they will trust an
  // attribution the system did not honour.
  if (b.confirmed_by !== undefined) {
    return {
      error: "confirmed_by is not accepted; the actor is the authenticated owner session",
      ok: false,
    };
  }
  if (!isNonEmptyString(confirmedBy)) {
    return { error: "an authenticated owner subject is required to confirm a coverage horizon", ok: false };
  }
  const confirmedAt = isNonEmptyString(b.confirmed_at) ? b.confirmed_at : nowIso;
  const confirmedAtMs = Date.parse(confirmedAt);
  if (Number.isNaN(confirmedAtMs)) {
    return { error: "confirmed_at must be a parseable ISO-8601 instant", ok: false };
  }
  if (confirmedAtMs > Date.parse(nowIso)) {
    return { error: "confirmed_at must not be in the future", ok: false };
  }
  // `earliest_available: null` is meaningful — "the provider never had ANY of
  // this" (`provider_never_had_data`) — so absence is allowed, but a supplied
  // value must be a real, non-future instant.
  let earliestAvailable: string | null = null;
  if (b.earliest_available !== undefined && b.earliest_available !== null) {
    if (!isNonEmptyString(b.earliest_available)) {
      return { error: "earliest_available must be an ISO-8601 instant or null", ok: false };
    }
    const parsedEarliest = Date.parse(b.earliest_available);
    if (Number.isNaN(parsedEarliest)) {
      return { error: "earliest_available must be a parseable ISO-8601 instant", ok: false };
    }
    if (parsedEarliest > Date.parse(confirmedAt)) {
      return {
        error: "earliest_available must not be later than confirmed_at; a future boundary would exclude all history",
        ok: false,
      };
    }
    earliestAvailable = b.earliest_available;
  }
  // An unknown stream name is INERT, not dangerous, so it is not validated
  // against the manifest here. A horizon declassifies nothing for ANY stream
  // name — it is disclosure, never a coverage authority (see
  // `server/connector-gap-classification.ts`) — so a horizon recorded for a
  // stream this connector does not have is simply disclosure nobody reads.
  // Rejecting it would need the route to load and read the connection's
  // manifest — real cost for no safety gain, and it would wrongly refuse a
  // legitimate horizon for a stream a future manifest adds.
  if (b.stream !== undefined && b.stream !== null && !isNonEmptyString(b.stream)) {
    return { error: "stream must be a non-empty string when present", ok: false };
  }
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") {
    return { error: "note must be a string when present", ok: false };
  }
  return {
    ok: true,
    record: {
      basis: b.basis as CoverageHorizonBasis,
      confirmedAt,
      confirmedBy,
      earliestAvailable,
      note: typeof b.note === "string" ? b.note : null,
      reason: b.reason as CoverageHorizonReason,
      stream: isNonEmptyString(b.stream) ? b.stream : null,
    },
  };
}

export function mountRefConnectionConfirmCoverageHorizon(
  app: AppLike,
  ctx: MountRefConnectionConfirmCoverageHorizonContext
): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/coverage-horizon",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
      let ownerSubjectId: string | null = null;
      let connectorKey: string | null = null;
      let parsedBasis: string | null = null;
      let parsedReason: string | null = null;
      let parsedStream: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        // Second argument is `null`, matching acknowledge-loss: passing `res`
        // here makes the resolver read it as the connector-id argument and
        // report a mismatch against `[object Object]`.
        //
        // No `allowDefaultAccount`, and `active`/`paused` only: a horizon is a
        // durable fact about what the provider can ever serve, meaningful
        // whether the connection is currently collecting or paused, and
        // meaningless once revoked.
        const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
          allowDefaultAccount: false,
          allowStatuses: ["active", "paused"],
          connectorInstanceId,
          ownerSubjectId,
        });
        if (!namespace) {
          return;
        }
        connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;
        const nowIso = ctx.now ? ctx.now() : new Date().toISOString();
        // The actor is the authenticated session, never the body.
        const parsed = parseCoverageHorizonBody(req.body, nowIso, ownerSubjectId ?? "");
        if (!parsed.ok) {
          await emitCoverageHorizonAudit(ctx, req, res, {
            connectionId: connectorInstanceId,
            connectorId: connectorKey,
            error: { code: "invalid_request" },
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(res, 400, "invalid_request", parsed.error);
          return;
        }
        parsedBasis = parsed.record.basis;
        parsedReason = parsed.record.reason;
        parsedStream = parsed.record.stream ?? null;

        const horizon = await ctx.confirmCoverageHorizon({
          ...parsed.record,
          connectorInstanceId: namespace.connectorInstanceId,
        });

        await emitCoverageHorizonAudit(ctx, req, res, {
          basis: parsedBasis,
          connectionId: connectorInstanceId,
          connectorId: connectorKey,
          outcome: "succeeded",
          ownerSubjectId,
          reason: parsedReason,
          stream: parsedStream,
        });
        res.status(200).json({
          connection_id: connectorInstanceId,
          connector_id: connectorKey,
          coverage_horizon: horizon,
          object: "owner_connection_coverage_horizon",
        });
      } catch (err) {
        await emitCoverageHorizonAudit(ctx, req, res, {
          basis: parsedBasis,
          connectionId: connectorInstanceId,
          connectorId: connectorKey,
          error: err,
          outcome: "failed",
          ownerSubjectId,
          reason: parsedReason,
          stream: parsedStream,
        });
        ctx.handleError(res, err);
      }
    }
  );
}
