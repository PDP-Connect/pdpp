// HTTP adapter for the reference-only run-interaction control surface and
// developer stream playground.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§5.1). Owner-session
// posture, response envelopes, status codes, error codes, and contract
// metadata are unchanged.
//
// Two routes:
//   POST /_ref/runs/:runId/interaction   — owner-only, answers the current
//     pending interaction for a live controller-managed run. This is NOT a
//     public PDPP protocol endpoint. Submitted data is not written to any
//     spine event payload, .env.local, or persistent config.
//   POST /_ref/dev/playground/session    — developer/testing surface,
//     gated at the call site on NODE_ENV !== 'production' or
//     PDPP_ENABLE_STREAM_PLAYGROUND=1. Owner-session required when
//     owner-auth is enabled.

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in transport
// ambient types. Config objects (e.g. `{ contract: 'opId' }`) may appear
// in the args list alongside middlewares and the final handler, matching
// transport.js's registration convention.

interface RouteRequest {
  readonly body?: unknown;
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

export interface RunInteractionController {
  respondToInteraction(
    runId: string,
    input: {
      readonly interaction_id: string;
      readonly status: string;
      readonly data?: Record<string, unknown> | null | undefined;
    }
  ): { readonly status: string } | Promise<{ readonly status: string }>;
}

export interface MountRefRunInteractionContext {
  readonly controller: RunInteractionController | null | undefined;
  handleError(res: unknown, err: unknown): void;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

export function mountRefRunInteraction(app: AppLike, ctx: MountRefRunInteractionContext): void {
  app.post(
    "/_ref/runs/:runId/interaction",
    { contract: "refRunInteraction" },
    ctx.requireOwnerSession,
    (req: RouteRequest, res: RouteResponse) => {
      try {
        if (!ctx.controller || typeof ctx.controller.respondToInteraction !== "function") {
          return ctx.pdppError(res, 404, "not_found", "Controller is not configured on this server");
        }
        const runId = decodeURIComponent(req.params.runId as string);
        const body =
          req.body != null && typeof req.body === "object"
            ? (req.body as Record<string, unknown>)
            : ({} as Record<string, unknown>);
        if (typeof body.interaction_id !== "string" || !body.interaction_id.trim()) {
          return ctx.pdppError(res, 400, "invalid_request", "interaction_id is required", "interaction_id");
        }
        if (body.status !== "success" && body.status !== "cancelled") {
          return ctx.pdppError(res, 400, "invalid_status", 'status must be "success" or "cancelled"', "status");
        }
        if (body.data != null && (typeof body.data !== "object" || Array.isArray(body.data))) {
          return ctx.pdppError(res, 400, "invalid_request", "data must be an object if provided", "data");
        }
        const result = ctx.controller.respondToInteraction(runId, {
          interaction_id: body.interaction_id as string,
          status: body.status as string,
          data: body.data as Record<string, unknown> | null | undefined,
        });
        const acknowledge = (resolved: { readonly status: string }) =>
          res.status(202).json({
            object: "run_interaction_ack",
            run_id: runId,
            interaction_id: body.interaction_id,
            status: resolved.status,
          });
        if (isPromiseLike(result)) {
          return result.then(acknowledge).catch((err) => ctx.handleError(res, err));
        }
        return acknowledge(result);
      } catch (err) {
        return ctx.handleError(res, err);
      }
    }
  );
}

export interface PlaygroundSession {
  readonly backend: string;
  readonly interactionId: string;
  readonly runId: string;
}

export interface PlaygroundLike {
  getOrCreatePlaygroundSession(opts: {
    backend?: string | undefined;
    streamDebug?: string | undefined;
  }): Promise<PlaygroundSession> | PlaygroundSession;
}

interface LoggerLike {
  warn?(obj: Record<string, unknown>, msg: string): void;
}

export interface MountRefDevPlaygroundSessionContext {
  logger?: LoggerLike | null | undefined;
  pdppError: PdppErrorFn;
  playground: PlaygroundLike;
  requireOwnerSession: MiddlewareHandler;
}

export function mountRefDevPlaygroundSession(app: AppLike, ctx: MountRefDevPlaygroundSessionContext): void {
  app.post("/_ref/dev/playground/session", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const body = req.body != null && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
      let backend: string | undefined;
      if (typeof req.query?.backend === "string") {
        backend = req.query.backend;
      } else if (body && typeof body.backend === "string") {
        backend = body.backend;
      }
      let streamDebug: string | undefined;
      if (typeof req.query?.stream_debug === "string") {
        streamDebug = req.query.stream_debug;
      } else if (body && typeof body.stream_debug === "string") {
        streamDebug = body.stream_debug;
      }
      const session = await ctx.playground.getOrCreatePlaygroundSession({ backend, streamDebug });
      return res.status(200).json({
        object: "stream_playground_session",
        backend: session.backend,
        run_id: session.runId,
        interaction_id: session.interactionId,
      });
    } catch (err) {
      const message = (err as { message?: string } | null)?.message ?? "playground session failed";
      ctx.logger?.warn?.({ err: message }, "stream_playground_session_failed");
      return ctx.pdppError(res, 500, "playground_failed", message);
    }
  });
}
