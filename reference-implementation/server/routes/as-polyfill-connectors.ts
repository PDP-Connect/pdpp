// HTTP adapters for the AS polyfill-mode connector registry routes.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` section 5.4 / §6.
// Each `mount...` function registers one route at the same point in
// registration order where `server/index.js` previously registered it inline.
// Both routes are only mounted when the server is in polyfill mode (`!nativeMode`).
//
// Routes covered:
//   POST /connectors            - register a polyfill connector manifest
//   GET  /connectors/:connectorId - retrieve a registered connector manifest
//
// Auth posture:
//   GET  /connectors/:connectorId — unauthenticated. Manifest read exposes no
//     user data and is needed by the unauthenticated client-side connect flow.
//   POST /connectors — gated by owner session on any internet-facing posture
//     (or when PDPP_LOCK_CONNECTOR_REGISTRY=1). A manifest upsert that bumps
//     `version` invalidates every existing grant — a one-request grant-wipe
//     DoS — so it must be owner-authenticated on a hosted surface. In a
//     local-dev posture the register route stays open so the `pnpm dev` / test
//     harness can self-register manifests frictionlessly. The host decides the
//     posture and passes `requireOwnerSessionForRegister` accordingly (security
//     audit S-2, lane A1).
//
// The canonical operations own semantic logic:
//   - `as.polyfill.connector.register` (operations/as-polyfill-connector-register)
//   - `as.polyfill.connector.detail`   (operations/as-polyfill-connector-detail)
//
// This adapter owns Express plumbing only.

import { executeAsPolyfillConnectorDetail } from "../../operations/as-polyfill-connector-detail/index.ts";
import { executeAsPolyfillConnectorRegister } from "../../operations/as-polyfill-connector-register/index.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  readonly body?: Record<string, unknown>;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

export interface MountAsPolyfillConnectorsContext {
  /**
   * Retrieves a registered connector manifest by connector ID.
   * Delegated to `getConnectorManifest` in the `buildAsApp` closure.
   */
  getConnectorManifest(
    connectorId: string
  ): Promise<Record<string, unknown> | null | undefined> | Record<string, unknown> | null | undefined;
  handleError(res: unknown, err: unknown): void;
  pdppError: PdppErrorFn;
  /**
   * Registers a connector manifest in the polyfill store.
   * Delegated to `registerConnector` in the `buildAsApp` closure.
   */
  registerConnector(manifest: Record<string, unknown>): Promise<unknown> | unknown;
  /**
   * Owner-session middleware to gate `POST /connectors`, or `null`/`undefined`
   * to leave the register route unauthenticated (local-dev posture). The host
   * supplies `ownerAuth.requireOwnerSession` on an internet-facing posture so a
   * manifest upsert cannot wipe grants unauthenticated (security audit S-2).
   */
  requireOwnerSessionForRegister?: MiddlewareHandler | null;
}

// POST /connectors

export function mountAsPolyfillConnectorRegister(app: AppLike, ctx: MountAsPolyfillConnectorsContext): void {
  const handler: RouteHandler = async (req, res) => {
    try {
      const outcome = await executeAsPolyfillConnectorRegister(
        { manifest: req.body },
        { registerConnector: ctx.registerConnector }
      );
      if (outcome.outcome === "success") {
        res.status(outcome.status).json(outcome.envelope);
        return;
      }
      ctx.pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
    } catch (err) {
      ctx.handleError(res, err);
    }
  };
  // Insert the owner-session gate before the handler when the host supplied
  // one (hosted posture). The transport forwards extra positional args as
  // middlewares, matching `requireOwnerSession`'s `(req, res, next)` shape.
  if (ctx.requireOwnerSessionForRegister) {
    app.post("/connectors", ctx.requireOwnerSessionForRegister, handler);
    return;
  }
  app.post("/connectors", handler);
}

// GET /connectors/:connectorId

export function mountAsPolyfillConnectorDetail(app: AppLike, ctx: MountAsPolyfillConnectorsContext): void {
  const handler: RouteHandler = async (req, res) => {
    try {
      const connectorId = req.params.connectorId;
      if (!connectorId) {
        ctx.pdppError(res, 400, "invalid_request", "connectorId is required");
        return;
      }
      const outcome = await executeAsPolyfillConnectorDetail(
        { connectorId: decodeURIComponent(connectorId) },
        { getConnectorManifest: ctx.getConnectorManifest }
      );
      if (outcome.outcome === "success") {
        res.json(outcome.envelope);
        return;
      }
      ctx.pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
    } catch (err) {
      ctx.handleError(res, err);
    }
  };
  app.get("/connectors/:connectorId", handler);
}
