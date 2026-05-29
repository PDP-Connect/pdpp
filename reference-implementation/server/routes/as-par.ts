// HTTP adapter for the AS Pushed Authorization Request (PAR) route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§6).
//
// Covers:
//   POST /oauth/par — RFC 9126 pushed-authorization-request initiation
//
// Auth posture: none (public endpoint). Auth/grants are resolved inside the
// operation via the injected `initiateGrant` store capability.
//
// Canonical operation:
//   operations/as-par-create/index.ts → grant initiation, request_uri +
//     authorization_url + expires_in envelope, trace_context extraction

import { type AsParCreateStoreResult, executeAsParCreate } from "../../operations/as-par-create/index.ts";
import type { RouteArg } from "./_route-contract.ts";

// ─── Minimal structural types ────────────────────────────────────────────────

interface RouteRequest {
  readonly body: Record<string, unknown> | null | undefined;
}

interface RouteResponse {
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

interface AppLike {
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// ─── Injected capabilities ───────────────────────────────────────────────────

export interface MountAsParContext {
  /** Generic error handler for unexpected thrown errors. */
  handleError(res: unknown, err: unknown): void;
  /** Initiates a new PAR grant in the consent store. */
  initiateGrant(
    body: Record<string, unknown> | null | undefined,
    opts: { baseUrl: string; nativeManifest: unknown }
  ): Promise<AsParCreateStoreResult> | AsParCreateStoreResult;
  /** The native manifest for this server instance, or null if not set. */
  nativeManifest: unknown;
  /** Resolves the full base URL for the running AS given the inbound request. */
  resolveBaseUrl(req: RouteRequest): string;
  /** Attaches a trace-id header to the response. */
  setReferenceTraceId(res: unknown, traceId: string): void;
}

// ─── Route mount ─────────────────────────────────────────────────────────────

export function mountAsPar(app: AppLike, ctx: MountAsParContext): void {
  // RFC 9126-style PAR envelope semantics live in the canonical
  // `as.par.create` operation (operations/as-par-create). The host adapter
  // owns base-URL resolution from explicit opts or ambient env, native
  // manifest resolution, header propagation, and response writing.
  const handler: RouteHandler = async (req, res): Promise<void> => {
    try {
      const output = await executeAsParCreate(
        {
          body: req.body,
          baseUrl: ctx.resolveBaseUrl(req),
          nativeManifest: ctx.nativeManifest,
        },
        {
          initiateGrant: (body, opts) => ctx.initiateGrant(body, opts),
        }
      );
      if (output.traceContext?.request_id) {
        res.setHeader("Request-Id", output.traceContext.request_id);
      }
      if (output.traceContext?.trace_id) {
        ctx.setReferenceTraceId(res, output.traceContext.trace_id);
      }
      res.status(output.status).json(output.envelope);
    } catch (err) {
      ctx.handleError(res, err);
    }
  };

  app.post("/oauth/par", { contract: "createPushedAuthorizationRequest" } as RouteArg<RouteHandler>, handler);
}
