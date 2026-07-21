// HTTP adapters for the AS OAuth route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` section 6. Each `mount...`
// function registers one route at the same point in registration order where
// `server/index.js` previously registered it inline. Auth posture, request-id
// / trace-id wiring, response-envelope shape, status codes, and error-to-HTTP
// mapping are all unchanged.
//
// This first slice covers the three machine-to-machine routes whose handlers
// delegate entirely to operations with no inline HTML and no closure-local
// state (`agentConnectAttempts`, `consentStore`):
//
//   POST /oauth/device_authorization - RFC 8628 device-code initiation
//   POST /oauth/token                - RFC 6749 / RFC 8628 token exchange
//   POST /introspect                 - RFC 7662 token introspection
//
// Remaining AS OAuth routes (DCR, authorize, consent, device UI, agent-connect)
// carry significant closure-local state and HTML-rendering dependencies;
// they stay inline in `server/index.js` pending a second owner-approved slice.
//
// Route registration order mirrors `buildAsApp` in `server/index.js`:
//   1. POST /oauth/device_authorization
//   2. POST /oauth/token
//   3. POST /introspect
//
// The canonical `as.*` operations own the semantic logic. This adapter owns
// HTTP wiring only. Every host capability the routes touch is injected via the
// `MountAs*Context` interfaces so the adapter never reaches back into the
// `buildAsApp` closure or imports `server/auth.js` / `server/index.js` directly.

import type { AsDeviceAuthInitStoreResult } from "../../operations/as-device-authorization-init/index.ts";
import { executeAsDeviceAuthInit } from "../../operations/as-device-authorization-init/index.ts";
import type { AsDeviceTokenExchangeStoreResult } from "../../operations/as-device-token-exchange/index.ts";
import { executeAsDeviceTokenExchange } from "../../operations/as-device-token-exchange/index.ts";
import type { AsIntrospectInfo } from "../../operations/as-introspect/index.ts";
import { executeAsIntrospect } from "../../operations/as-introspect/index.ts";
import type { PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Each interface documents only the fields
// this adapter actually reads.

interface RouteRequest {
  readonly body?: Record<string, unknown>;
  get(name: string): string | undefined;
  readonly protocol: string;
}

interface RouteResponse {
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<unknown>;

interface AppLike {
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

const HOSTED_MCP_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

// Narrows an unknown body field to `string | null | undefined` as required by
// operation input types. Non-string values are treated as absent (undefined).
function bodyString(value: unknown): string | null | undefined {
  return typeof value === "string" ? value : undefined;
}

// POST /oauth/device_authorization

export interface MountAsDeviceAuthorizationContext {
  /**
   * Initiates a new RFC 8628 device-code flow.
   * Bare owner-agent requests delegate to `ownerDeviceAuthStore.initiate`.
   */
  initiateDeviceAuth(
    clientId: string,
    opts: { baseUrl: string }
  ): Promise<AsDeviceAuthInitStoreResult> | AsDeviceAuthInitStoreResult;
  /**
   * Initiates grant-scoped MCP device authorization. This is distinct from
   * owner-agent onboarding: it stages a normal pending-consent request and
   * eventually redeems to a scoped client token, not an owner bearer.
   */
  initiateMcpDeviceAuth(
    args: {
      clientId: string;
      resource: string;
      authorizationDetails: unknown;
    },
    opts: { baseUrl: string }
  ): Promise<AsDeviceAuthInitStoreResult> | AsDeviceAuthInitStoreResult;
  oauthError: PdppErrorFn;
  /** Resolves the full base URL for the running AS given the inbound request. */
  resolveBaseUrl(req: RouteRequest): string;
  setReferenceTraceId(res: unknown, traceId: string): void;
}

function isMcpDeviceAuthorizationRequest(body: Record<string, unknown> | undefined): boolean {
  return body?.resource !== undefined || body?.authorization_details !== undefined;
}

function parseAuthorizationDetails(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    const err = new Error("authorization_details must be valid JSON when form encoded");
    (err as { code?: string }).code = "invalid_request";
    throw err;
  }
}

async function handleMcpDeviceAuthorization(
  req: RouteRequest,
  res: RouteResponse,
  ctx: MountAsDeviceAuthorizationContext
): Promise<unknown> {
  const baseUrl = ctx.resolveBaseUrl(req);
  const clientId = bodyString(req.body?.client_id);
  const resource = bodyString(req.body?.resource);
  if (!clientId) {
    return ctx.oauthError(res, 400, "invalid_request", "client_id is required");
  }
  if (!resource) {
    return ctx.oauthError(res, 400, "invalid_request", "resource is required for MCP device authorization");
  }
  if (req.body?.authorization_details === undefined) {
    return ctx.oauthError(
      res,
      400,
      "invalid_request",
      "authorization_details is required for MCP device authorization"
    );
  }

  let authorizationDetails: unknown;
  try {
    authorizationDetails = parseAuthorizationDetails(req.body.authorization_details);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return ctx.oauthError(res, 400, e.code ?? "invalid_request", e.message ?? "Invalid authorization_details");
  }

  try {
    const result = await ctx.initiateMcpDeviceAuth({ clientId, resource, authorizationDetails }, { baseUrl });
    const traceContext = result.trace_context ?? null;
    const { trace_context: _ignored, ...publicResult } = result as Record<string, unknown>;
    if (traceContext && typeof traceContext === "object") {
      const requestId = (traceContext as { request_id?: string | null }).request_id;
      const traceId = (traceContext as { trace_id?: string | null }).trace_id;
      if (requestId) {
        res.setHeader("Request-Id", String(requestId));
      }
      if (traceId) {
        ctx.setReferenceTraceId(res, String(traceId));
      }
    }
    return res.status(200).json(publicResult);
  } catch (err) {
    const e = err as { code?: string; message?: string; request_id?: string; trace_id?: string };
    if (e.request_id) {
      res.setHeader("Request-Id", String(e.request_id));
    }
    if (e.trace_id) {
      ctx.setReferenceTraceId(res, String(e.trace_id));
    }
    return ctx.oauthError(res, 400, e.code ?? "invalid_request", e.message ?? "Device authorization rejected");
  }
}

export function mountAsDeviceAuthorization(app: AppLike, ctx: MountAsDeviceAuthorizationContext): void {
  // Device-authorization initiation semantics (client_id presence
  // validation, store call, trace_context-stripped public envelope) live
  // in the canonical `as.device.authorization.init` operation
  // (operations/as-device-authorization-init).
  const handler: RouteHandler = async (req, res) => {
    if (isMcpDeviceAuthorizationRequest(req.body)) {
      return handleMcpDeviceAuthorization(req, res, ctx);
    }

    const outcome = await executeAsDeviceAuthInit(
      {
        clientId: bodyString(req.body?.client_id),
        baseUrl: ctx.resolveBaseUrl(req),
      },
      {
        initiate: (clientId, opts2) => ctx.initiateDeviceAuth(clientId, opts2),
      }
    );
    if (outcome.outcome === "success") {
      if (outcome.traceContext?.request_id) {
        res.setHeader("Request-Id", String(outcome.traceContext.request_id));
      }
      if (outcome.traceContext?.trace_id) {
        ctx.setReferenceTraceId(res, String(outcome.traceContext.trace_id));
      }
      return res.status(outcome.status as number).json(outcome.publicResult);
    }
    if (outcome.requestId) {
      res.setHeader("Request-Id", String(outcome.requestId));
    }
    if (outcome.traceId) {
      ctx.setReferenceTraceId(res, String(outcome.traceId));
    }
    return ctx.oauthError(
      res,
      outcome.status as number,
      outcome.errorCode as string,
      outcome.errorMessage as string | undefined
    );
  };
  app.post(
    "/oauth/device_authorization",
    { contract: "startOwnerDeviceAuthorization" } as RouteArg<RouteHandler>,
    handler
  );
}

// POST /oauth/token

export interface MountAsTokenContext {
  /**
   * Exchanges a device-code for an access token.
   * The composition root routes owner-agent and grant-scoped MCP device
   * codes to their separate lifecycle stores.
   */
  exchangeDeviceCode(args: {
    clientId: string | null | undefined;
    deviceCode: string | null | undefined;
  }): Promise<AsDeviceTokenExchangeStoreResult> | AsDeviceTokenExchangeStoreResult;
  /**
   * Exchanges an OAuth authorization code for an access token.
   * Delegated to `auth.js#exchangeOAuthAuthorizationCode` via context so
   * this adapter does not import `server/auth.js` directly.
   */
  exchangeOAuthAuthorizationCode(args: {
    baseUrl: string;
    code: unknown;
    clientId: unknown;
    redirectUri: unknown;
    codeVerifier: unknown;
  }): Promise<{
    access_token: string;
    token_type: string;
    refresh_token?: string | null;
    grant_id?: string | null;
    grant_package_id?: string | null;
  }>;
  /**
   * Exchanges a refresh token for a new access token.
   * Delegated to `auth.js#exchangeOAuthRefreshToken` via context.
   */
  exchangeOAuthRefreshToken(args: { refreshToken: unknown; clientId: unknown }): Promise<{
    access_token: string;
    token_type: string;
    refresh_token: string;
    grant_id?: string | null;
    grant_package_id?: string | null;
  }>;
  oauthError: PdppErrorFn;
  /** Resolves the full base URL for the running AS given the inbound request. */
  resolveBaseUrl(req: RouteRequest): string;
  setReferenceTraceId(res: unknown, traceId: string): void;
}

function buildGrantIdPayload(token: {
  grant_id?: string | null;
  grant_package_id?: string | null;
}): { grant_package_id: string | null } | { grant_id: string | null | undefined } {
  return token.grant_package_id ? { grant_package_id: token.grant_package_id } : { grant_id: token.grant_id };
}

async function handleAuthCodeExchange(
  req: RouteRequest,
  body: Record<string, unknown>,
  res: RouteResponse,
  ctx: MountAsTokenContext
): Promise<unknown> {
  try {
    const token = await ctx.exchangeOAuthAuthorizationCode({
      baseUrl: ctx.resolveBaseUrl(req),
      code: body.code,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
    });
    return res.json({
      access_token: token.access_token,
      token_type: token.token_type,
      expires_in: HOSTED_MCP_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
      ...buildGrantIdPayload(token),
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return ctx.oauthError(res, 400, e.code ?? "invalid_grant", e.message ?? "Authorization code exchange failed");
  }
}

async function handleRefreshTokenExchange(
  body: Record<string, unknown>,
  res: RouteResponse,
  ctx: MountAsTokenContext
): Promise<unknown> {
  try {
    const token = await ctx.exchangeOAuthRefreshToken({
      refreshToken: body.refresh_token,
      clientId: body.client_id,
    });
    return res.json({
      access_token: token.access_token,
      token_type: token.token_type,
      expires_in: HOSTED_MCP_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      refresh_token: token.refresh_token,
      ...buildGrantIdPayload(token),
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return ctx.oauthError(res, 400, e.code ?? "invalid_grant", e.message ?? "Refresh token exchange failed");
  }
}

export function mountAsToken(app: AppLike, ctx: MountAsTokenContext): void {
  // Device-code token-exchange semantics (grant-type allowlist, store
  // call, RFC 8628 client-fault to 400 mapping, trace_context propagation)
  // live in the canonical `as.device.token.exchange` operation
  // (operations/as-device-token-exchange). The authorization_code and
  // refresh_token branches delegate to `auth.js` capabilities injected
  // via context.
  const handler: RouteHandler = async (req, res) => {
    const body = req.body;
    if (body?.grant_type === "authorization_code") {
      return handleAuthCodeExchange(req, body, res, ctx);
    }
    if (body?.grant_type === "refresh_token") {
      return handleRefreshTokenExchange(body, res, ctx);
    }
    const outcome = await executeAsDeviceTokenExchange(
      {
        grantType: bodyString(body?.grant_type),
        clientId: bodyString(body?.client_id),
        deviceCode: bodyString(body?.device_code),
      },
      { exchangeDeviceCode: (args) => ctx.exchangeDeviceCode(args) }
    );
    if (outcome.outcome === "success") {
      if (outcome.traceContext?.request_id) {
        res.setHeader("Request-Id", String(outcome.traceContext.request_id));
      }
      if (outcome.traceContext?.trace_id) {
        ctx.setReferenceTraceId(res, String(outcome.traceContext.trace_id));
      }
      return res.status(outcome.status as number).json(outcome.publicResult);
    }
    if (outcome.requestId) {
      res.setHeader("Request-Id", String(outcome.requestId));
    }
    if (outcome.traceId) {
      ctx.setReferenceTraceId(res, String(outcome.traceId));
    }
    return ctx.oauthError(
      res,
      outcome.status as number,
      outcome.errorCode as string,
      outcome.errorMessage as string | undefined
    );
  };
  app.post("/oauth/token", { contract: "exchangeOwnerDeviceToken" } as RouteArg<RouteHandler>, handler);
}

// POST /introspect

export interface MountAsIntrospectContext {
  /**
   * Resolves a token's grant/introspection payload.
   * Delegated to `auth.js#introspect` via context.
   */
  introspect(token: string): Promise<AsIntrospectInfo> | AsIntrospectInfo;
  pdppError: PdppErrorFn;
}

export function mountAsIntrospect(app: AppLike, ctx: MountAsIntrospectContext): void {
  // RFC 7662-style token introspection with PDPP extensions. Token-presence
  // validation and the AS-internal `grant_storage_binding` redaction live
  // in the canonical `as.introspect` operation (operations/as-introspect).
  const handler: RouteHandler = async (req, res) => {
    const outcome = await executeAsIntrospect({ token: bodyString(req.body?.token) }, { introspect: ctx.introspect });
    if (outcome.outcome === "success") {
      return res.json(outcome.publicInfo);
    }
    return ctx.pdppError(
      res,
      outcome.status as number,
      outcome.errorCode as string,
      outcome.errorMessage as string | undefined
    );
  };
  app.post("/introspect", { contract: "introspectToken" } as RouteArg<RouteHandler>, handler);
}
