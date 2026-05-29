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
// Auth posture: none (no requireToken / requireOwner). These routes are
// intentionally unauthenticated in the original — the polyfill connector
// registry only holds connector manifests, not user data.
//
// The canonical operations own semantic logic:
//   - `as.polyfill.connector.register` (operations/as-polyfill-connector-register)
//   - `as.polyfill.connector.detail`   (operations/as-polyfill-connector-detail)
//
// This adapter owns Express plumbing only.

import { executeAsPolyfillConnectorDetail } from "../../operations/as-polyfill-connector-detail/index.ts";
import { executeAsPolyfillConnectorRegister } from "../../operations/as-polyfill-connector-register/index.ts";
import type { PdppErrorFn, RouteArg } from "./_route-contract.ts";

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
