// HTTP adapters for the AS agent-connect route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`. Each `mount...` function
// registers one route at the same point in registration order where
// `server/index.js` previously registered it inline. Auth posture, status
// codes, error envelopes, and operation delegation are all unchanged.
//
// Routes covered:
//   POST /agent-connect               - register a PAR request for CLI polling
//   POST /agent-connect/:attemptId/token - poll for / redeem the issued bearer
//
// Auth posture: none (unauthenticated). Possession of the opaque polling_code
// is the only gate on token redemption.
//
// The in-progress attempt state lives in an `AgentConnectAttemptStore` created
// by `createAgentConnectAttemptStore`. The store is instantiated once in
// `buildAsApp` and passed to both route adapters AND to the consent
// approve/deny handlers so all three share the same Map.

import type { PdppErrorFn, RouteArg } from "./_route-contract.ts";

// ─── Attempt store ───────────────────────────────────────────────────────────

export interface AgentConnectAttempt {
  readonly approvalUrl: string;
  readonly clientId: string | null;
  completedAt?: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  grant?: Record<string, unknown>;
  grantId?: string | null;
  readonly id: string;
  readonly interval: number;
  readonly pollingCode: string;
  readonly requestUri: string;
  status: "pending" | "approved" | "denied" | "expired";
  token?: string;
  readonly tokenUrl: string;
}

export interface AgentConnectAttemptStore {
  /**
   * Complete all pending attempts matching `requestUri`. Called by the consent
   * approve handler with `status: 'approved'` (plus token/grant) and by the
   * deny handler with `status: 'denied'`.
   */
  complete(
    requestUri: string,
    outcome:
      | { status: "approved"; token: string; grant: Record<string, unknown>; grantId?: string | null }
      | { status: "denied" | "expired" }
  ): void;
  /** Create and register a new pending attempt. Returns the stored attempt. */
  create(opts: {
    id: string;
    pollingCode: string;
    requestUri: string;
    clientId: string | null;
    expiresAt: number;
    approvalUrl: string;
    tokenUrl: string;
  }): AgentConnectAttempt;
  /** Remove an attempt by id. */
  delete(id: string): void;
  /**
   * Shorthand for `complete(requestUri, { status })` for non-approval outcomes.
   * Called by the consent deny handler.
   */
  fail(requestUri: string, status: "denied" | "expired"): void;
  /** Look up an attempt by id. */
  get(id: string): AgentConnectAttempt | undefined;
  /** Evict expired/completed attempts (call before creating new ones). */
  prune(now?: number): void;
}

export function createAgentConnectAttemptStore(): AgentConnectAttemptStore {
  const attempts = new Map<string, AgentConnectAttempt>();

  return {
    create(opts): AgentConnectAttempt {
      const attempt: AgentConnectAttempt = {
        id: opts.id,
        pollingCode: opts.pollingCode,
        requestUri: opts.requestUri,
        clientId: opts.clientId,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: opts.expiresAt,
        interval: 2,
        approvalUrl: opts.approvalUrl,
        tokenUrl: opts.tokenUrl,
      };
      attempts.set(opts.id, attempt);
      return attempt;
    },

    get(id): AgentConnectAttempt | undefined {
      return attempts.get(id);
    },

    delete(id): void {
      attempts.delete(id);
    },

    prune(now = Date.now()): void {
      for (const [id, attempt] of attempts) {
        if (attempt.status !== "pending" || attempt.expiresAt <= now) {
          attempts.delete(id);
        }
      }
    },

    complete(requestUri, outcome): void {
      for (const attempt of attempts.values()) {
        if (attempt.requestUri !== requestUri || attempt.status !== "pending") {
          continue;
        }
        attempt.status = outcome.status;
        attempt.completedAt = new Date().toISOString();
        if (outcome.status === "approved") {
          attempt.token = outcome.token;
          attempt.grant = outcome.grant;
          attempt.grantId = (outcome.grant.grant_id as string | null | undefined) ?? outcome.grantId ?? null;
        }
      }
    },

    fail(requestUri, status): void {
      for (const attempt of attempts.values()) {
        if (attempt.requestUri !== requestUri || attempt.status !== "pending") {
          continue;
        }
        attempt.status = status;
        attempt.completedAt = new Date().toISOString();
      }
    },
  };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function buildAgentConnectError(status: string): { error: string; error_description: string } {
  if (status === "denied") {
    return { error: "access_denied", error_description: "Owner denied the scoped access request" };
  }
  if (status === "expired") {
    return { error: "expired_token", error_description: "The agent-connect request expired before approval" };
  }
  return { error: "authorization_pending", error_description: "Owner approval is still pending" };
}

function publicAttemptEnvelope(attempt: AgentConnectAttempt, now: number): Record<string, unknown> {
  return {
    id: attempt.id,
    object: "agent_connect_attempt",
    status: attempt.status,
    approval_url: attempt.approvalUrl,
    poll_url: attempt.tokenUrl,
    token_url: attempt.tokenUrl,
    expires_in: Math.max(Math.ceil((attempt.expiresAt - now) / 1000), 0),
    interval: attempt.interval,
  };
}

// ─── Route types ─────────────────────────────────────────────────────────────

interface RouteRequest {
  readonly body?: Record<string, unknown>;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// ─── POST /agent-connect ─────────────────────────────────────────────────────

interface PendingGrantResult {
  /** The client_id from the pending grant request, or null if not present. */
  readonly pendingClientId: string | null;
}

interface InitiateNativeGrantResult {
  readonly request_uri: string;
}

export interface MountAsAgentConnectContext {
  agentConnectAttemptStore: AgentConnectAttemptStore;
  /** How long (ms) a pending attempt lives before it expires. */
  agentConnectTtlMs: number;
  /** Build the owner approval URL for a given request_uri and base URL. */
  buildApprovalUrl(baseUrl: string, requestUri: string): string;
  /** Build the token poll URL for a given attempt id and base URL. */
  buildTokenUrl(baseUrl: string, attemptId: string): string;
  /** Generate a unique attempt id (e.g. `agc_<hex>`). */
  generateAttemptId(): string;
  /** Generate an opaque polling code (e.g. `agc_poll_<hex>`). */
  generatePollingCode(): string;
  /**
   * Looks up the pending consent request for a given request_uri.
   * Returns `{ pendingClientId }` where `pendingClientId` is null if the
   * request is unknown/expired or if no client_id is on the pending record.
   * Returns null if the pending request is not found.
   */
  getPendingGrantFromRequestUri(
    requestUri: string,
    opts?: { baseUrl?: string | null }
  ): Promise<PendingGrantResult | null>;
  handleError(res: unknown, err: unknown): void;
  /**
   * Initiates a grant for the native-manifest shortcut path (no explicit
   * request_uri). Returns `{ request_uri }`, or null if the server is not
   * in native mode (i.e. no nativeManifest configured).
   */
  initiateNativeGrant(opts: {
    baseUrl: string;
    clientId: string;
    clientName: string;
  }): Promise<InitiateNativeGrantResult | null>;
  /** Returns the current wall-clock time in ms (for `expiresAt` calculation). */
  now(): number;
  /** Default client_id for the PDPP CLI. */
  pdppCliDefaultClientId: string;
  pdppError: PdppErrorFn;
  /** Resolve the public base URL for the AS from the inbound request. */
  resolveBaseUrl(req: RouteRequest): string;
}

async function resolveRequestUri(
  req: RouteRequest,
  baseUrl: string,
  clientId: string | null,
  ctx: MountAsAgentConnectContext
): Promise<{ requestUri: string; clientId: string | null } | null> {
  const bodyRequestUri = typeof req.body?.request_uri === "string" ? req.body.request_uri : null;
  if (bodyRequestUri) {
    return { requestUri: bodyRequestUri, clientId };
  }
  const clientName =
    typeof req.body?.client_name === "string" && req.body.client_name.trim() ? req.body.client_name.trim() : "PDPP CLI";
  const effectiveClientId = clientId ?? ctx.pdppCliDefaultClientId;
  const staged = await ctx.initiateNativeGrant({ baseUrl, clientId: effectiveClientId, clientName });
  if (!staged) {
    return null;
  }
  return { requestUri: staged.request_uri, clientId: effectiveClientId };
}

export function mountAsAgentConnect(app: AppLike, ctx: MountAsAgentConnectContext): void {
  // Narrow hosted completion handoff for CLI `connect`: the CLI first stages a
  // normal PAR request, then registers that request_uri here to receive a
  // polling handle. Owner approval still happens through the existing consent
  // page, but the bearer is returned only to the caller holding the polling
  // code, never rendered into the owner browser.
  const handler: RouteHandler = async (req, res) => {
    try {
      const baseUrl = ctx.resolveBaseUrl(req);
      const bodyClientId =
        typeof req.body?.client_id === "string" && req.body.client_id.trim() ? req.body.client_id : null;

      const resolved = await resolveRequestUri(req, baseUrl, bodyClientId, ctx);
      if (!resolved) {
        return ctx.pdppError(
          res,
          400,
          "invalid_request",
          "request_uri is required unless the reference provider is running with a native manifest"
        );
      }
      const { requestUri, clientId } = resolved;

      const pendingResult = await ctx.getPendingGrantFromRequestUri(requestUri, { baseUrl });
      if (!pendingResult) {
        return ctx.pdppError(res, 400, "expired_token", "Pending grant request is unknown or expired");
      }
      const { pendingClientId } = pendingResult;

      if (clientId && pendingClientId !== clientId) {
        return ctx.pdppError(res, 403, "invalid_client", "client_id does not match pending request");
      }

      const now = ctx.now();
      ctx.agentConnectAttemptStore.prune(now);
      const id = ctx.generateAttemptId();
      const pollingCode = ctx.generatePollingCode();

      const attempt = ctx.agentConnectAttemptStore.create({
        id,
        pollingCode,
        requestUri,
        clientId: pendingClientId ?? clientId,
        expiresAt: now + ctx.agentConnectTtlMs,
        approvalUrl: ctx.buildApprovalUrl(baseUrl, requestUri),
        tokenUrl: ctx.buildTokenUrl(baseUrl, id),
      });

      return res.status(201).json({
        ...publicAttemptEnvelope(attempt, now),
        polling_code: pollingCode,
      });
    } catch (err) {
      return ctx.handleError(res, err);
    }
  };
  app.post("/agent-connect", handler);
}

// ─── POST /agent-connect/:attemptId/token ────────────────────────────────────

export interface MountAsAgentConnectTokenContext {
  agentConnectAttemptStore: AgentConnectAttemptStore;
  handleError(res: unknown, err: unknown): void;
  pdppError: PdppErrorFn;
}

export function mountAsAgentConnectToken(app: AppLike, ctx: MountAsAgentConnectTokenContext): void {
  const handler: RouteHandler = (req, res) => {
    try {
      const attemptId = req.params.attemptId ?? "";
      const attempt = ctx.agentConnectAttemptStore.get(attemptId);
      const pollingCode = typeof req.body?.polling_code === "string" ? req.body.polling_code : null;
      if (!attempt || pollingCode !== attempt.pollingCode) {
        return ctx.pdppError(res, 401, "invalid_grant", "Unknown agent-connect polling handle");
      }
      if (attempt.status === "pending" && attempt.expiresAt <= Date.now()) {
        attempt.status = "expired";
      }
      if (attempt.status === "pending") {
        return res.status(202).json({
          status: "pending",
          error: "authorization_pending",
          error_description: "Owner approval is still pending",
          interval: attempt.interval,
        });
      }
      if (attempt.status !== "approved") {
        const error = buildAgentConnectError(attempt.status);
        ctx.agentConnectAttemptStore.delete(attempt.id);
        return ctx.pdppError(res, attempt.status === "denied" ? 403 : 400, error.error, error.error_description);
      }
      ctx.agentConnectAttemptStore.delete(attempt.id);
      return res.json({
        access_token: attempt.token,
        token_type: "Bearer",
        grant_id: attempt.grantId,
        grant: attempt.grant,
      });
    } catch (err) {
      return ctx.handleError(res, err);
    }
  };
  app.post("/agent-connect/:attemptId/token", handler);
}
