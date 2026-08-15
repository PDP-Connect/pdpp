// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reference-only owner-session provider-authorization lifecycle.
//
// This module implements task 6.3 of the `complete-self-service-connection-onboarding`
// OpenSpec change: provider callback/token exchange SHALL materialize active
// connections only after authorization and required account inventory or
// connection test succeeds.
//
// Two routes are exported:
//
//   POST /_ref/connectors/:connectorId/provider-auth-initiate
//     Owner-session only. Verifies provider-app deployment readiness, mints a
//     signed state token (CSRF-bound to the owner session), and delegates to the
//     injectable ProviderAuthExchanger to produce the authorization URL.  Returns
//     a typed `open_provider_auth` next step with the URL — no connection row is
//     written here.
//
//   GET /_ref/provider-auth/callback
//     No bearer. Validates the `state` parameter (owner-session-bound nonce),
//     exchanges `code` via the injectable exchanger, runs the injectable account
//     inventory/connection test, and only then upserts an `active` connector
//     instance.  A failed exchange, bad/expired state, or failed inventory/test
//     leaves no active connector instance.
//
// Both routes are OWNER-SESSION surfaces: they never accept owner-agent bearer
// tokens, MCP bearer tokens, or grant-scoped tokens. Provider tokens never
// appear in any response body, audit event, or log.
//
// Injectable interfaces allow deterministic test coverage without live provider
// credentials (see spec requirement: "No live provider credentials").

import { buildConnectionSetupPlan } from "../connection-setup-plan.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// ---------------------------------------------------------------------------
// Injectable provider-auth exchanger interface
// ---------------------------------------------------------------------------

/** Authorization URL + extra metadata returned by the exchanger's initiate step. */
export interface ProviderAuthInitiateResult {
  /** The URL the owner must open in a browser to authorize. */
  readonly authorizationUrl: string;
}

/** Tokens returned by a successful code exchange. Treated as opaque within this module. */
export interface ProviderAuthTokens {
  readonly accessToken: string;
  readonly expiresAt?: string | null;
  readonly refreshToken?: string | null;
  readonly tokenKind: string;
}

/** One account returned by inventory. */
export interface ProviderAccount {
  /** Stable provider account ID used as the source binding key. */
  readonly accountId: string;
  /** Display label for the account (e.g. email address). */
  readonly displayLabel?: string | null;
  /** Non-secret provider/account metadata persisted on the connector instance. */
  readonly sourceBinding?: Record<string, unknown> | null;
}

/**
 * Injectable interface for all provider-side operations. Tests supply a
 * deterministic implementation; production deployments wire real HTTP calls.
 */
export interface ProviderAuthExchanger {
  /**
   * Exchange an authorization code for provider tokens.
   * Returns `null` on failure (bad code, expired code, provider error).
   * MUST NOT return tokens to callers — only return a success/failure signal for
   * store wiring; the tokens are passed immediately to `runInventoryOrTest`.
   */
  exchangeCode: (args: {
    connectorId: string;
    code: string;
    redirectUri: string;
    state: string;
  }) => Promise<ProviderAuthTokens | null> | ProviderAuthTokens | null;
  /**
   * Build the provider authorization URL and any accompanying state that needs
   * to survive the round-trip (PKCE, nonce, etc.).
   * Called during the initiate step. MUST NOT perform network I/O in test doubles.
   */
  initiateAuthorization: (args: {
    connectorId: string;
    redirectUri: string;
    state: string;
  }) => Promise<ProviderAuthInitiateResult> | ProviderAuthInitiateResult;

  /**
   * Run an account inventory or connection test using the fresh tokens.
   * Returns one or more accounts on success; throws or returns empty array on
   * failure. The tokens are consumed here and MUST NOT be persisted by this call.
   */
  runInventoryOrTest: (args: {
    connectorId: string;
    tokens: ProviderAuthTokens;
  }) => Promise<ProviderAccount[]> | ProviderAccount[];

  /**
   * Seal and persist provider tokens for exactly one connection.
   * The plaintext tokens MUST NOT appear in any response or audit event.
   * Callers pass the tokens once; after this call returns the tokens are
   * considered consumed (the exchanger is responsible for encrypted storage).
   *
   * `sourceBinding` is the SAME non-secret object `runInventoryOrTest`
   * returned on the matching `ProviderAccount` for this connection, passed
   * back within the same request (never persisted or looked up by a global
   * map) so an exchanger that needs data from its own inventory step (e.g. a
   * resource-group inventory in a token bundle) can read it here without
   * keeping any request-spanning state of its own.
   */
  storeTokens: (args: {
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId: string;
    tokens: ProviderAuthTokens;
    now: string;
    sourceBinding?: Record<string, unknown> | null;
  }) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Pending-auth state store (in-process, short-lived)
// ---------------------------------------------------------------------------

export interface PendingAuthEntry {
  readonly connectorId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ownerSubjectId: string;
  /**
   * The exact `redirect_uri` sent to the provider's authorization endpoint
   * in `initiateAuthorization`. The callback recomputes a redirect_uri from
   * its own request (`buildCallbackRedirectUri`) and must match this stored
   * value before the code is exchanged — an OAuth code is only valid for the
   * redirect_uri it was issued against, so a mismatch here means either a
   * misconfigured/rotated callback base URL or a forged callback request,
   * and either way the exchange must not proceed with a different URI than
   * what the owner actually authorized.
   */
  readonly redirectUri: string;
}

export interface PendingAuthStore {
  delete: (stateToken: string) => void;
  get: (stateToken: string) => PendingAuthEntry | null;
  put: (stateToken: string, entry: PendingAuthEntry) => void;
}

/** Default in-process pending-auth store backed by a plain Map. */
export function createInProcessPendingAuthStore(): PendingAuthStore {
  const map = new Map<string, PendingAuthEntry>();
  return {
    delete(stateToken) {
      map.delete(stateToken);
    },
    get(stateToken) {
      return map.get(stateToken) ?? null;
    },
    put(stateToken, entry) {
      map.set(stateToken, entry);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface RouteRequest {
  ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | string[] | undefined>>;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  redirect: (url: string) => void;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

interface ConnectorInstance {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly displayName?: string | null;
  readonly status: string;
}

interface ConnectorInstanceStore {
  upsert: (record: {
    ownerSubjectId: string;
    connectorId: string;
    displayName: string;
    status: string;
    sourceKind: string;
    sourceBindingKey: string;
    sourceBinding: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }) => Promise<ConnectorInstance> | ConnectorInstance;
}

interface ConnectorManifestLike {
  readonly capabilities?: {
    readonly auth?: {
      readonly kind?: string | null;
      readonly mode?: string | null;
      readonly type?: string | null;
      readonly deployment_config?: readonly string[] | null;
    } | null;
  } | null;
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
  readonly display_name?: string | null;
  readonly name?: string | null;
  readonly runtime_requirements?: {
    readonly bindings?: Readonly<Record<string, unknown>> | null;
  } | null;
  readonly setup?: {
    readonly modality?: string | null;
    readonly deployment_config?: readonly string[] | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Mount context
// ---------------------------------------------------------------------------

export interface MountRefProviderAuthContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  configuredProviderAuthConnectorKeys?: readonly string[];
  createRequestConnectorInstanceStore: () => ConnectorInstanceStore;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  exchanger: ProviderAuthExchanger;
  // Generates a cryptographically random state token. Prefix is "pas" (provider auth state).
  generateReferenceSecret: (prefix: string, bytes?: number) => string;
  generateSpineId: (prefix: string) => string;
  getOwnerSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  now?: () => string;
  pdppError: PdppErrorFn;
  pendingAuthStore: PendingAuthStore;
  requireOwnerSession: MiddlewareHandler;
  resolveCallbackBaseUrl: (req: unknown) => string;
  /**
   * Resolves the deployment-config env view for one connector's manifest,
   * merging the DB-backed provider-app-config store (authoritative) with
   * `process.env` (fallback, consulted only when the store has no value) —
   * the same DB-first, env-fallback order `createDeploymentConfigResolver`
   * uses for the actual OAuth exchange, so the readiness check answered here
   * never disagrees with whether the exchange itself can proceed. Optional:
   * defaults to `process.env` alone (env-only, matching the pre-store
   * behavior) when omitted.
   */
  resolveDeploymentEnv?: (manifest: ConnectorManifestLike) => Promise<Readonly<Record<string, string | undefined>>>;
  resolveRegisteredConnectorManifest: (connectorId: string) => Promise<ConnectorManifestLike | null>;
  setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PENDING_AUTH_TTL_SECONDS = 10 * 60; // 10 minutes

function buildAuditTrace(ctx: MountRefProviderAuthContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return {
    request_id: requestId,
    scenario_id: trace.scenario_id,
    trace_id: trace.trace_id,
  };
}

function errWithCode(code: string): { code: string } {
  return { code };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function providerErrorCode(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.trim() ? code.trim() : fallback;
}

function providerErrorStatus(err: unknown, fallback: number): number {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600 ? status : fallback;
}

function providerErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback;
}

function buildProviderAccountSourceBinding(account: ProviderAccount): Record<string, unknown> {
  const extra =
    account.sourceBinding && typeof account.sourceBinding === "object" && !Array.isArray(account.sourceBinding)
      ? account.sourceBinding
      : {};
  return {
    ...extra,
    account_id: account.accountId,
    kind: "provider_auth_account",
  };
}

function buildCallbackRedirectUri(ctx: MountRefProviderAuthContext, req: unknown): string {
  return `${stripTrailingSlash(ctx.resolveCallbackBaseUrl(req))}/_ref/provider-auth/callback`;
}

async function activateConnectorInstanceForAccount(
  store: ConnectorInstanceStore,
  exchanger: ProviderAuthExchanger,
  args: {
    ownerSubjectId: string;
    connectorId: string;
    account: ProviderAccount;
    tokens: ProviderAuthTokens;
    now: string;
  }
): Promise<ConnectorInstance> {
  const { ownerSubjectId, connectorId, account, tokens, now } = args;
  const sourceBindingKey = account.accountId;
  const displayName = account.displayLabel ?? account.accountId;
  const sourceBinding = buildProviderAccountSourceBinding(account);
  const sharedRecord = {
    connectorId,
    createdAt: now,
    displayName,
    ownerSubjectId,
    sourceBinding,
    sourceBindingKey,
    sourceKind: "account",
    updatedAt: now,
  };
  const draftInstance = await store.upsert({ ...sharedRecord, status: "draft" });
  await exchanger.storeTokens({
    connectorId,
    connectorInstanceId: draftInstance.connectorInstanceId,
    now,
    ownerSubjectId,
    sourceBinding,
    tokens,
  });
  return store.upsert({ ...sharedRecord, status: "active" });
}

async function emitInitiateAudit(
  ctx: MountRefProviderAuthContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectorId?: string | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const ownerSubjectId = args.ownerSubjectId ?? req.ownerSession?.sub ?? null;
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    actor_id: ownerSubjectId ?? "owner_session",
    actor_type: "owner_session",
    data: {
      connector_id: args.connectorId ?? null,
      operation: "initiate_provider_auth",
      outcome: args.outcome,
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
            },
          }
        : {}),
    },
    event_type: "owner.connection.provider_auth.initiate",
    object_id: args.connectorId ?? "unknown_connector",
    object_type: "connection",
    request_id: trace.request_id,
    scenario_id: trace.scenario_id,
    status: args.outcome,
    subject_id: ownerSubjectId,
    subject_type: "subject",
    trace_id: trace.trace_id,
  });
}

async function emitCallbackAudit(
  ctx: MountRefProviderAuthContext,
  res: RouteResponse,
  args: {
    connectorId?: string | null;
    connectionId?: string | null;
    accountIds?: readonly string[] | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
    failureReason?: string | null;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    actor_id: args.ownerSubjectId ?? "provider_callback",
    actor_type: "provider_callback",
    data: {
      // Number of accounts created, never IDs/emails — no PII in audit events
      account_count: args.accountIds?.length ?? null,
      connection_id: args.connectionId ?? null,
      connector_id: args.connectorId ?? null,
      failure_reason: args.failureReason ?? null,
      operation: "provider_auth_callback",
      outcome: args.outcome,
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
            },
          }
        : {}),
    },
    event_type: "owner.connection.provider_auth.callback",
    object_id: args.connectionId ?? args.connectorId ?? "unknown_connection",
    object_type: "connection",
    request_id: trace.request_id,
    scenario_id: trace.scenario_id,
    status: args.outcome,
    subject_id: args.ownerSubjectId ?? null,
    subject_type: "subject",
    trace_id: trace.trace_id,
  });
}

// ---------------------------------------------------------------------------
// POST /_ref/connectors/:connectorId/provider-auth-initiate
// ---------------------------------------------------------------------------

export function mountRefProviderAuthInitiate(app: AppLike, ctx: MountRefProviderAuthContext): void {
  app.post(
    "/_ref/connectors/:connectorId/provider-auth-initiate",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      let ownerSubjectId: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);

        // Resolve manifest — 404 for unknown connectors.
        const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
        if (!manifest) {
          await emitInitiateAudit(ctx, req, res, {
            connectorId,
            error: errWithCode("not_found"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(res, 404, "not_found", `Connector '${connectorId}' is not registered.`);
          return;
        }

        // Check setup plan: must be provider_authorization with deployment ready.
        const setupPlanArgs: {
          connectorKey: string;
          configuredProviderAuthConnectorKeys?: readonly string[];
          deploymentEnv?: Readonly<Record<string, string | undefined>>;
          manifest: ConnectorManifestLike;
        } = { connectorKey: connectorId, manifest };
        if (ctx.configuredProviderAuthConnectorKeys) {
          setupPlanArgs.configuredProviderAuthConnectorKeys = ctx.configuredProviderAuthConnectorKeys;
        }
        if (ctx.resolveDeploymentEnv) {
          setupPlanArgs.deploymentEnv = await ctx.resolveDeploymentEnv(manifest);
        }
        const plan = buildConnectionSetupPlan(setupPlanArgs);

        if (plan.setupModality !== "provider_authorization") {
          await emitInitiateAudit(ctx, req, res, {
            connectorId,
            error: errWithCode("provider_auth_not_applicable"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            409,
            "provider_auth_not_applicable",
            `Connector '${connectorId}' does not use provider authorization (setup modality: ${plan.setupModality}).`
          );
          return;
        }

        if (plan.deploymentReadiness.state === "needs_config") {
          await emitInitiateAudit(ctx, req, res, {
            connectorId,
            error: errWithCode("provider_app_deployment_config_missing"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            503,
            "provider_app_deployment_config_missing",
            plan.deploymentReadiness.guidance ??
              `Provider application deployment config is missing for connector '${connectorId}'.`
          );
          return;
        }

        // Mint a cryptographically random state token bound to this owner session.
        const stateToken = ctx.generateReferenceSecret("pas", 24);
        const now = ctx.now ? ctx.now() : new Date().toISOString();
        const expiresAt = new Date(Date.parse(now) + PENDING_AUTH_TTL_SECONDS * 1000).toISOString();
        const redirectUri = buildCallbackRedirectUri(ctx, req);

        ctx.pendingAuthStore.put(stateToken, {
          connectorId,
          createdAt: now,
          expiresAt,
          ownerSubjectId,
          redirectUri,
        });

        const initResult = await ctx.exchanger.initiateAuthorization({
          connectorId,
          redirectUri,
          state: stateToken,
        });

        await emitInitiateAudit(ctx, req, res, {
          connectorId,
          outcome: "succeeded",
          ownerSubjectId,
        });

        res.status(201).json({
          connector_id: connectorId,
          next_step: {
            authorization_url: initResult.authorizationUrl,
            expires_at: expiresAt,
            kind: "open_provider_auth",
            reason:
              "Open the authorization_url in a browser to authorize the provider account. " +
              "The callback will complete setup and activate the connection after authorization " +
              "and account inventory succeed.",
            redirect_uri: redirectUri,
          },
          object: "provider_auth_initiate",
          setup_modality: plan.setupModality,
        });
      } catch (err) {
        await emitInitiateAudit(ctx, req, res, {
          connectorId,
          error: err,
          outcome: "failed",
          ownerSubjectId,
        });
        ctx.handleError(res, err);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// GET /_ref/provider-auth/callback — helpers
// ---------------------------------------------------------------------------

interface CallbackParams {
  code: string | null;
  providerError: string | null;
  stateToken: string | null;
}

function parseCallbackQueryParams(req: RouteRequest): CallbackParams {
  const query = req.query ?? {};
  return {
    code: typeof query.code === "string" ? query.code.trim() : null,
    providerError: typeof query.error === "string" ? query.error.trim() : null,
    stateToken: typeof query.state === "string" ? query.state.trim() : null,
  };
}

async function rejectWithProviderError(
  ctx: MountRefProviderAuthContext,
  res: RouteResponse,
  params: CallbackParams,
  pending: PendingAuthEntry | null
): Promise<"rejected"> {
  if (params.stateToken && pending) {
    ctx.pendingAuthStore.delete(params.stateToken);
  }
  await emitCallbackAudit(ctx, res, {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    connectorId: pending?.connectorId ?? null,
    error: errWithCode("provider_auth_denied"),
    failureReason: "provider_error",
    outcome: "failed",
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    ownerSubjectId: pending?.ownerSubjectId ?? null,
  });
  ctx.pdppError(res, 400, "provider_auth_denied", `Provider returned an error: ${params.providerError}.`);
  return "rejected";
}

async function rejectWithStateInvalid(ctx: MountRefProviderAuthContext, res: RouteResponse): Promise<"rejected"> {
  await emitCallbackAudit(ctx, res, {
    connectorId: null,
    error: errWithCode("provider_auth_state_invalid"),
    failureReason: "state_invalid_or_missing",
    outcome: "failed",
    ownerSubjectId: null,
  });
  ctx.pdppError(
    res,
    400,
    "provider_auth_state_invalid",
    "The provider authorization state is missing, invalid, or expired."
  );
  return "rejected";
}

async function rejectWithStateExpired(
  ctx: MountRefProviderAuthContext,
  res: RouteResponse,
  stateToken: string,
  connectorId: string,
  ownerSubjectId: string
): Promise<"rejected"> {
  ctx.pendingAuthStore.delete(stateToken);
  await emitCallbackAudit(ctx, res, {
    connectorId,
    error: errWithCode("provider_auth_state_expired"),
    failureReason: "state_expired",
    outcome: "failed",
    ownerSubjectId,
  });
  ctx.pdppError(
    res,
    400,
    "provider_auth_state_expired",
    "The provider authorization state has expired. Restart the authorization flow."
  );
  return "rejected";
}

async function rejectWithRedirectUriMismatch(
  ctx: MountRefProviderAuthContext,
  res: RouteResponse,
  stateToken: string,
  connectorId: string,
  ownerSubjectId: string
): Promise<"rejected"> {
  ctx.pendingAuthStore.delete(stateToken);
  await emitCallbackAudit(ctx, res, {
    connectorId,
    error: errWithCode("provider_auth_redirect_uri_mismatch"),
    failureReason: "redirect_uri_mismatch",
    outcome: "failed",
    ownerSubjectId,
  });
  ctx.pdppError(
    res,
    400,
    "provider_auth_redirect_uri_mismatch",
    "The callback redirect_uri does not match the redirect_uri used to start this authorization. Restart the authorization flow."
  );
  return "rejected";
}

async function rejectWithCodeMissing(
  ctx: MountRefProviderAuthContext,
  res: RouteResponse,
  stateToken: string,
  connectorId: string,
  ownerSubjectId: string
): Promise<"rejected"> {
  ctx.pendingAuthStore.delete(stateToken);
  await emitCallbackAudit(ctx, res, {
    connectorId,
    error: errWithCode("provider_auth_code_missing"),
    failureReason: "code_missing",
    outcome: "failed",
    ownerSubjectId,
  });
  ctx.pdppError(res, 400, "provider_auth_code_missing", "Authorization code is missing from the callback.");
  return "rejected";
}

interface ValidatedCallbackState {
  code: string;
  connectorId: string;
  now: string;
  ownerSubjectId: string;
  pending: PendingAuthEntry;
  stateToken: string;
}

function validateCallbackStateAndCode(
  ctx: MountRefProviderAuthContext,
  res: RouteResponse,
  params: CallbackParams,
  redirectUri: string
): Promise<ValidatedCallbackState | "rejected"> {
  const { stateToken, code, providerError } = params;
  const pending = stateToken ? ctx.pendingAuthStore.get(stateToken) : null;

  if (providerError) {
    return rejectWithProviderError(ctx, res, params, pending);
  }

  if (!(stateToken && pending)) {
    return rejectWithStateInvalid(ctx, res);
  }

  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const connectorId = pending.connectorId;
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const ownerSubjectId = pending.ownerSubjectId;
  const now = ctx.now ? ctx.now() : new Date().toISOString();

  if (now > pending.expiresAt) {
    return rejectWithStateExpired(ctx, res, stateToken, connectorId, ownerSubjectId);
  }

  if (pending.redirectUri !== redirectUri) {
    return rejectWithRedirectUriMismatch(ctx, res, stateToken, connectorId, ownerSubjectId);
  }

  if (!code) {
    return rejectWithCodeMissing(ctx, res, stateToken, connectorId, ownerSubjectId);
  }

  return Promise.resolve({ code, connectorId, now, ownerSubjectId, pending, stateToken });
}

async function exchangeCodeAndRunInventory(
  ctx: MountRefProviderAuthContext,
  res: RouteResponse,
  validated: ValidatedCallbackState,
  redirectUri: string
): Promise<{ tokens: ProviderAuthTokens; accounts: ProviderAccount[] } | "rejected"> {
  const { stateToken, code, connectorId, ownerSubjectId } = validated;

  const tokens = await ctx.exchanger.exchangeCode({ code, connectorId, redirectUri, state: stateToken });

  if (!tokens) {
    await emitCallbackAudit(ctx, res, {
      connectorId,
      error: errWithCode("provider_auth_code_invalid"),
      failureReason: "code_exchange_failed",
      outcome: "failed",
      ownerSubjectId,
    });
    ctx.pdppError(
      res,
      400,
      "provider_auth_code_invalid",
      "Authorization code exchange failed. The code may be expired or invalid."
    );
    return "rejected";
  }

  let accounts: ProviderAccount[];
  try {
    accounts = await ctx.exchanger.runInventoryOrTest({ connectorId, tokens });
  } catch (inventoryErr) {
    const errCode = providerErrorCode(inventoryErr, "provider_auth_inventory_failed");
    await emitCallbackAudit(ctx, res, {
      connectorId,
      error: inventoryErr,
      failureReason: "inventory_test_failed",
      outcome: "failed",
      ownerSubjectId,
    });
    ctx.pdppError(
      res,
      providerErrorStatus(inventoryErr, 502),
      errCode,
      providerErrorMessage(
        inventoryErr,
        "Account inventory or connection test failed after authorization. No connection was activated."
      )
    );
    return "rejected";
  }

  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!accounts || accounts.length === 0) {
    await emitCallbackAudit(ctx, res, {
      connectorId,
      error: errWithCode("provider_auth_no_accounts"),
      failureReason: "no_accounts_returned",
      outcome: "failed",
      ownerSubjectId,
    });
    ctx.pdppError(
      res,
      422,
      "provider_auth_no_accounts",
      "Account inventory returned no accounts. No connection was activated."
    );
    return "rejected";
  }

  return { accounts, tokens };
}

async function activateAllAccounts(
  ctx: MountRefProviderAuthContext,
  validated: ValidatedCallbackState,
  tokens: ProviderAuthTokens,
  accounts: ProviderAccount[]
): Promise<ConnectorInstance[]> {
  const store = ctx.createRequestConnectorInstanceStore();
  const activated: ConnectorInstance[] = [];
  for (const account of accounts) {
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    const instance = await activateConnectorInstanceForAccount(store, ctx.exchanger, {
      account,
      connectorId: validated.connectorId,
      now: validated.now,
      ownerSubjectId: validated.ownerSubjectId,
      tokens,
    });
    activated.push(instance);
  }
  return activated;
}

// ---------------------------------------------------------------------------
// GET /_ref/provider-auth/callback
// ---------------------------------------------------------------------------

export function mountRefProviderAuthCallback(app: AppLike, ctx: MountRefProviderAuthContext): void {
  app.get("/_ref/provider-auth/callback", async (req: RouteRequest, res: RouteResponse) => {
    const params = parseCallbackQueryParams(req);
    let resolvedConnectorId = "";
    let resolvedOwnerSubjectId = "";

    try {
      const redirectUri = buildCallbackRedirectUri(ctx, req);
      const validated = await validateCallbackStateAndCode(ctx, res, params, redirectUri);
      if (validated === "rejected") {
        return;
      }

      resolvedConnectorId = validated.connectorId;
      resolvedOwnerSubjectId = validated.ownerSubjectId;

      // Consume the state token immediately — replay protection.
      ctx.pendingAuthStore.delete(validated.stateToken);

      const exchanged = await exchangeCodeAndRunInventory(ctx, res, validated, redirectUri);
      if (exchanged === "rejected") {
        return;
      }

      const activatedInstances = await activateAllAccounts(ctx, validated, exchanged.tokens, exchanged.accounts);

      await emitCallbackAudit(ctx, res, {
        accountIds: activatedInstances.map((i) => i.connectorInstanceId),
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        connectionId: activatedInstances[0]?.connectorInstanceId ?? null,
        connectorId: resolvedConnectorId,
        outcome: "succeeded",
        ownerSubjectId: resolvedOwnerSubjectId,
      });

      res.status(201).json({
        connections: activatedInstances.map((inst) => ({
          connection_id: inst.connectorInstanceId,
          connector_id: inst.connectorId,
          connector_instance_id: inst.connectorInstanceId,
          status: inst.status,
        })),
        connector_id: resolvedConnectorId,
        next_step: {
          kind: "run_connection",
          reason: "Provider authorization completed and account inventory succeeded. The connection is now active.",
        },
        object: "provider_auth_callback",
      });
    } catch (err) {
      await emitCallbackAudit(ctx, res, {
        connectorId:
          resolvedConnectorId ||
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          (params.stateToken ? (ctx.pendingAuthStore.get(params.stateToken)?.connectorId ?? null) : null),
        error: err,
        failureReason: "unexpected_error",
        outcome: "failed",
        ownerSubjectId:
          resolvedOwnerSubjectId ||
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          (params.stateToken ? (ctx.pendingAuthStore.get(params.stateToken)?.ownerSubjectId ?? null) : null),
      });
      ctx.handleError(res, err);
    }
  });
}
