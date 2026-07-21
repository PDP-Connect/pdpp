// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the AS Dynamic Client Registration (DCR) route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`.
//
// Covers:
//   POST   /oauth/register           — RFC 7591 dynamic client registration
//   PATCH  /oauth/register/:clientId — RFC 7592 client management / update
//   DELETE /oauth/register/:clientId — RFC 7592 client management / deletion
//
// Auth posture:
//   POST   — public (no auth required), or Bearer initial-access-token, or
//            owner session cookie. Public registrations go through an IP-keyed
//            rate limiter before reaching the operation.
//   PATCH  — owner session required (enforced by injected `requireOwnerSession`
//            middleware). Edits the owner-facing `client_name` label only.
//   DELETE — owner session required (enforced by injected `requireOwnerSession`
//            middleware). Deliberate design choice: RFC 7592 registration-access-
//            token gating is NOT used; see
//            openspec/changes/dcr-per-owner-token-with-revoke/design.md.
//
// Canonical operations:
//   operations/as-dcr-register/index.ts → input sanitisation, IAT validation,
//     registration mode detection, typed outcome
//   operations/as-dcr-update/index.ts   → client_name-only update, typed error → status
//   operations/as-dcr-delete/index.ts   → cascade-delete, typed error → status

import { executeAsDcrDelete } from "../../operations/as-dcr-delete/index.ts";
import { executeAsDcrRegister, summarizeDcrRegisterRequest } from "../../operations/as-dcr-register/index.ts";
import { executeAsDcrUpdate } from "../../operations/as-dcr-update/index.ts";
import type { PdppErrorFn, RouteArg } from "./_route-contract.ts";

// ─── Minimal structural types ────────────────────────────────────────────────

interface RouteRequest {
  readonly body: unknown;
  readonly connection?: { remoteAddress?: string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string;
  ownerSession?: { sub?: string };
  readonly params: Readonly<Record<string, string>>;
  readonly socket?: { remoteAddress?: string };
}

interface RouteResponse {
  end(): unknown;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): RouteResponse;
}

type NextFn = () => void;
type MiddlewareFn = (req: RouteRequest, res: RouteResponse, next: NextFn) => Promise<void> | void;
type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

interface AppLike {
  delete(path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]): AppLike;
  patch(path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]): AppLike;
}

// ─── Injected capabilities ───────────────────────────────────────────────────

/** Thin rate-limiter returned by `createPublicDcrRateLimiter` in index.js. */
export interface PublicDcrRateLimiter {
  /** Returns the retry-after seconds if the IP is rate-limited, null otherwise. */
  check(req: RouteRequest): number | null;
}

export interface MountAsDcrContext {
  /** Creates a new trace context `{ request_id, trace_id, scenario_id }`. */
  createTraceContext(): { request_id: string; trace_id: string; scenario_id?: string };
  /** Whether DCR is enabled on this server instance. */
  dcrEnabled: boolean;
  /** Auth-layer capability: delete a registered client and cascade-revoke grants. */
  deleteRegisteredClient: Parameters<typeof executeAsDcrDelete>[1]["deleteRegisteredClient"];
  /** Emits a spine event (fire-and-forget; caller awaits). */
  emitSpineEvent(event: Record<string, unknown>): Promise<void>;
  /** Writes an OAuth error envelope (`error` / `error_description`). */
  oauthError(res: unknown, status: number, code: string, message: string): unknown;
  /** Subject ID to use for the DELETE actor when the session sub is absent. */
  ownerSubjectId: string;
  pdppError: PdppErrorFn;
  /** IP-keyed rate limiter for public (unauthenticated) registrations. */
  publicDcrRateLimiter: PublicDcrRateLimiter;
  /** Reads the owner session from the request, returns null if absent. */
  readOwnerSession(req: RouteRequest): { sub?: string } | null;
  /** Auth-layer capability: register a new dynamic client. */
  registerDynamicClient: Parameters<typeof executeAsDcrRegister>[1]["registerDynamicClient"];
  /** Owner-session enforcement middleware; rejects the request if not authenticated. */
  requireOwnerSession: MiddlewareFn;
  /** Initial-access-token values accepted for this request; filtered per origin. */
  resolveInitialAccessTokensForRequest(req: RouteRequest): readonly string[];
  /** Attaches a trace-id header to the response. */
  setReferenceTraceId(res: unknown, traceId: string): void;
  /** Auth-layer capability: update a registered client's owner-facing label. */
  updateRegisteredClientName: Parameters<typeof executeAsDcrUpdate>[1]["updateRegisteredClientName"];
}

// ─── Route mount ─────────────────────────────────────────────────────────────

export function mountAsDcr(app: AppLike, ctx: MountAsDcrContext): void {
  // POST /oauth/register ─ RFC 7591 dynamic client registration
  //
  // Three registration modes (resolved inside the operation):
  //   1. Owner session present          → owner-attributed client
  //   2. Bearer initial-access-token   → IAT-gated registration
  //   3. No auth                        → public self-registration (rate-limited)
  //
  // Rate limiting is checked here (adapter responsibility) before delegating to
  // the operation so the spine event uses the adapter's trace context.
  const registerHandler: RouteHandler = async (req, res): Promise<void> => {
    const traceContext = ctx.createTraceContext();
    res.setHeader("Request-Id", traceContext.request_id);
    ctx.setReferenceTraceId(res, traceContext.trace_id);

    const ownerSession = ctx.readOwnerSession(req);
    const authorizationHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : null;

    if (!(authorizationHeader || ownerSession)) {
      const retryAfter = ctx.publicDcrRateLimiter.check(req);
      if (retryAfter) {
        res.setHeader("Retry-After", String(retryAfter));
        await ctx.emitSpineEvent({
          event_type: "client.register_rejected",
          trace_id: traceContext.trace_id,
          scenario_id: traceContext.scenario_id,
          request_id: traceContext.request_id,
          actor_type: "client",
          actor_id: "dynamic_registration",
          object_type: "client_registration",
          object_id: traceContext.request_id,
          status: "rejected",
          data: {
            ...summarizeDcrRegisterRequest(req.body as Record<string, unknown> | null | undefined),
            error: {
              code: "slow_down",
              message: "Too many public client registration attempts; retry later",
            },
          },
        });
        ctx.oauthError(res, 429, "slow_down", "Too many public client registration attempts; retry later");
        return;
      }
    }

    const outcome = await executeAsDcrRegister(
      {
        body: req.body as Record<string, unknown> | null | undefined,
        authorizationHeader,
        dcrEnabled: ctx.dcrEnabled,
        initialAccessTokens: ctx.resolveInitialAccessTokensForRequest(req),
        ownerSessionSubjectId: ownerSession?.sub || null,
      },
      { registerDynamicClient: ctx.registerDynamicClient }
    );

    if (outcome.outcome === "success") {
      await ctx.emitSpineEvent({
        event_type: "client.registered",
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        request_id: traceContext.request_id,
        actor_type: "client",
        actor_id: outcome.registered.client_id,
        object_type: "client",
        object_id: outcome.registered.client_id,
        status: "succeeded",
        client_id: outcome.registered.client_id,
        data: outcome.spineData as unknown as Record<string, unknown>,
      });
      res.status(outcome.status).json(outcome.registered);
      return;
    }

    await ctx.emitSpineEvent({
      event_type: "client.register_rejected",
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      request_id: traceContext.request_id,
      actor_type: "client",
      actor_id: "dynamic_registration",
      object_type: "client_registration",
      object_id: traceContext.request_id,
      status: "rejected",
      data: outcome.spineData as unknown as Record<string, unknown>,
    });
    ctx.oauthError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  };

  // PATCH /oauth/register/:clientId ─ RFC 7592 client management (update)
  //
  // Owner-session-gated. Edits the owner-facing `client_name` label only;
  // scope and bearer material are not editable. Drives
  // `oauth_clients.updated_at` so the rename reflects on the next owner read.
  const updateHandler: RouteHandler = async (req, res): Promise<void> => {
    const traceContext = ctx.createTraceContext();
    res.setHeader("Request-Id", traceContext.request_id);
    ctx.setReferenceTraceId(res, traceContext.trace_id);

    const actingSubjectId: string = req.ownerSession?.sub ?? ctx.ownerSubjectId;
    const outcome = await executeAsDcrUpdate(
      {
        clientId: decodeURIComponent(req.params.clientId as string),
        body: req.body,
        actingSubjectId,
      },
      { updateRegisteredClientName: ctx.updateRegisteredClientName }
    );

    if (outcome.outcome === "success") {
      res.status(outcome.status).json(outcome.client);
      return;
    }
    ctx.pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  };

  // DELETE /oauth/register/:clientId ─ RFC 7592 client management
  //
  // Owner-session-gated. Cascades to revoke all active grants for the client.
  // Idempotent: a second call for an already-deleted client returns 404.
  const deleteHandler: RouteHandler = async (req, res): Promise<void> => {
    const traceContext = ctx.createTraceContext();
    res.setHeader("Request-Id", traceContext.request_id);
    ctx.setReferenceTraceId(res, traceContext.trace_id);

    const actingSubjectId: string = req.ownerSession?.sub ?? ctx.ownerSubjectId;
    const outcome = await executeAsDcrDelete(
      {
        clientId: decodeURIComponent(req.params.clientId as string),
        actingSubjectId,
        requestId: traceContext.request_id,
        traceId: traceContext.trace_id,
      },
      { deleteRegisteredClient: ctx.deleteRegisteredClient }
    );

    if (outcome.outcome === "success") {
      res.status(outcome.status).end();
      return;
    }
    ctx.pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  };

  app.post(
    "/oauth/register",
    { contract: "registerDynamicClient" } as RouteArg<RouteHandler | MiddlewareFn>,
    registerHandler
  );

  app.patch(
    "/oauth/register/:clientId",
    ctx.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>,
    updateHandler
  );

  app.delete(
    "/oauth/register/:clientId",
    ctx.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>,
    deleteHandler
  );
}
