// HTTP adapter for the AS grant-revoke route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` section 6 continuation.
//
// Covers:
//   POST /grants/:grantId/revoke  — RFC 9396 / PDPP grant revocation
//
// The `requireRevokeAuth` middleware is also extracted here because it is
// solely a gate for this one route and has no callers in index.js after the
// move.
//
// Auth posture: custom `requireRevokeAuth` middleware — accepts owner bearer
// OR the client bearer whose grant_id matches the URL param. Token-level
// expired/revoked bearers are rejected; grant-state inactive bearers whose
// grant_id matches are accepted (so a holder can revoke their own
// malformed/expired grant).
//
// Post-revoke side effects: client-event-subscription rows are transitioned
// to `disabled_revoked` and a fire-and-forget delivery tick is kicked off.
// Failures in this hook MUST NOT affect the revoke HTTP response.
//
// Canonical operation:
//   operations/as-grant-revoke/index.ts  → owns envelope, trace_id surface
//   operations/as-client-event-subscriptions/index.ts → owns side-effect

import { executeApplyGrantRevoke } from "../../operations/as-client-event-subscriptions/index.ts";
import type { AsGrantRevokeOutput } from "../../operations/as-grant-revoke/index.ts";
import { executeAsGrantRevoke } from "../../operations/as-grant-revoke/index.ts";
import type { PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}

type NextFn = () => void;
type MiddlewareFn = (req: RouteRequest & { tokenInfo?: unknown }, res: RouteResponse, next: NextFn) => Promise<void>;
type RouteHandler = (req: RouteRequest & { tokenInfo?: unknown }, res: RouteResponse) => Promise<unknown>;

interface AppLike {
  post(path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]): AppLike;
}

interface IntrospectInfo {
  readonly active?: boolean;
  readonly grant_id?: string;
  readonly inactive_reason?: string;
  readonly pdpp_token_kind?: string;
}

export interface MountAsGrantRevokeContext {
  /** Transitions client-event-subscription rows for the revoked grant. */
  applyGrantRevokeSideEffects(grantId: string): Promise<void>;
  /** Ensures/returns a request-id header on `res`. Delegated to `ensureRequestId`. */
  ensureRequestId(res: unknown): string;
  handleError(res: unknown, err: unknown): void;
  /** Introspects a bearer token for auth checks in the middleware. */
  introspect(token: string): Promise<IntrospectInfo>;
  logger?: { warn?(obj: Record<string, unknown>, msg: string): void };
  pdppError: PdppErrorFn;
  /** Revokes the grant row, returns trace_id for header propagation. */
  revokeGrant(
    grantId: string,
    context: { request_id: string }
  ): Promise<{ trace_id?: string | null; [extra: string]: unknown }>;
  setReferenceTraceId(res: unknown, traceId: string): void;
}

// Token-level inactive reasons: the bearer string itself is bad (not just the
// grant state). These always yield 401 regardless of grant_id match.
const TOKEN_LEVEL_INACTIVE = new Set(["token_revoked", "token_expired"]);

function resolveRevokeAuthDecision(
  info: IntrospectInfo,
  grantId: string
): { allow: true } | { allow: false; status: number; code: string; message: string } {
  if (!info || (info.active === false && !info.inactive_reason)) {
    return { allow: false, status: 401, code: "authentication_error", message: "Invalid or expired token" };
  }
  if (info.active === false && TOKEN_LEVEL_INACTIVE.has(info.inactive_reason ?? "")) {
    return { allow: false, status: 401, code: "authentication_error", message: "Invalid or expired token" };
  }
  if (info.pdpp_token_kind === "owner") {
    return { allow: true };
  }
  if (info.pdpp_token_kind === "client" || (info.active === false && info.grant_id)) {
    if (info.grant_id && info.grant_id === grantId) {
      return { allow: true };
    }
    return { allow: false, status: 403, code: "permission_error", message: "Client token is not bound to this grant" };
  }
  return { allow: false, status: 403, code: "permission_error", message: "Token kind not permitted to revoke" };
}

function buildRequireRevokeAuth(ctx: MountAsGrantRevokeContext): MiddlewareFn {
  // Accepts:
  //   1. Owner bearer (pdpp_token_kind === 'owner') — may revoke any grant.
  //   2. Client bearer whose grant_id matches the URL :grantId — may revoke
  //      its own grant even when the grant-state is inactive (but NOT when the
  //      token itself is revoked/expired).
  // Rejects everything else with 401/403.
  return async (req, res, next) => {
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      ctx.pdppError(res, 401, "authentication_error", "Missing Bearer token");
      return;
    }
    const token = auth.slice(7);
    let info: IntrospectInfo;
    try {
      info = await ctx.introspect(token);
    } catch {
      ctx.pdppError(res, 401, "authentication_error", "Invalid or expired token");
      return;
    }
    const grantId = req.params.grantId as string;
    const decision = resolveRevokeAuthDecision(info, grantId);
    if (!decision.allow) {
      ctx.pdppError(res, decision.status, decision.code, decision.message);
      return;
    }
    req.tokenInfo = info;
    next();
  };
}

export function mountAsGrantRevoke(app: AppLike, ctx: MountAsGrantRevokeContext): void {
  const requireRevokeAuth = buildRequireRevokeAuth(ctx);

  const handler: RouteHandler = async (req, res) => {
    try {
      const requestId = ctx.ensureRequestId(res) as string;
      const grantId = req.params.grantId as string;
      const output: AsGrantRevokeOutput = await executeAsGrantRevoke(
        { grantId, requestId },
        { revokeGrant: ctx.revokeGrant }
      );
      if (output.traceId) {
        ctx.setReferenceTraceId(res, output.traceId);
      }
      // Apply client-event-subscription grant-revoke side effects after the
      // grant row has transitioned. Failures here MUST NOT leak through to
      // the revoke envelope or retroactively undo the revocation.
      try {
        await ctx.applyGrantRevokeSideEffects(grantId);
      } catch (hookErr) {
        const e = hookErr as { message?: string } | null;
        ctx.logger?.warn?.({ err: String(e?.message ?? hookErr) }, "client-event-subscriptions: revoke hook failed");
      }
      res.json(output.envelope);
    } catch (err) {
      ctx.handleError(res, err);
    }
  };

  app.post(
    "/grants/:grantId/revoke",
    { contract: "revokeGrant" } as RouteArg<RouteHandler | MiddlewareFn>,
    requireRevokeAuth as RouteArg<RouteHandler | MiddlewareFn>,
    handler
  );
}

/** Builds the `applyGrantRevokeSideEffects` capability for injection into ctx. */
export function buildApplyGrantRevokeSideEffects(deps: {
  getDeliveryWorker(): { tick(): Promise<void> };
  getStore(): {
    dropQueuedForSubscription: unknown;
    enqueueEvent: unknown;
    listSubscriptionsByGrant: unknown;
    updateStatus: unknown;
  };
}): (grantId: string) => Promise<void> {
  return async (grantId: string) => {
    await executeApplyGrantRevoke(grantId, {
      store: deps.getStore() as Parameters<typeof executeApplyGrantRevoke>[1]["store"],
      nowIso: () => new Date().toISOString(),
    });
    deps
      .getDeliveryWorker()
      .tick()
      .catch(() => {
        /* surfaced via attempt log */
      });
  };
}
