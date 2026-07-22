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
  exchangeCode(args: {
    connectorId: string;
    code: string;
    redirectUri: string;
    state: string;
  }): Promise<ProviderAuthTokens | null> | ProviderAuthTokens | null;
  /**
   * Build the provider authorization URL and any accompanying state that needs
   * to survive the round-trip (PKCE, nonce, etc.).
   * Called during the initiate step. MUST NOT perform network I/O in test doubles.
   */
  initiateAuthorization(args: {
    connectorId: string;
    redirectUri: string;
    state: string;
  }): Promise<ProviderAuthInitiateResult> | ProviderAuthInitiateResult;

  /**
   * Run an account inventory or connection test using the fresh tokens.
   * Returns one or more accounts on success; throws or returns empty array on
   * failure. The tokens are consumed here and MUST NOT be persisted by this call.
   */
  runInventoryOrTest(args: {
    connectorId: string;
    tokens: ProviderAuthTokens;
  }): Promise<ProviderAccount[]> | ProviderAccount[];

  /**
   * Seal and persist provider tokens for exactly one connection.
   * The plaintext tokens MUST NOT appear in any response or audit event.
   * Callers pass the tokens once; after this call returns the tokens are
   * considered consumed (the exchanger is responsible for encrypted storage).
   */
  storeTokens(args: {
    connectorInstanceId: string;
    ownerSubjectId: string;
    tokens: ProviderAuthTokens;
    now: string;
  }): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Pending-auth state store (in-process, short-lived)
// ---------------------------------------------------------------------------

export interface PendingAuthEntry {
  readonly connectorId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ownerSubjectId: string;
}

export interface PendingAuthStore {
  delete(stateToken: string): void;
  get(stateToken: string): PendingAuthEntry | null;
  put(stateToken: string, entry: PendingAuthEntry): void;
}

/** Default in-process pending-auth store backed by a plain Map. */
export function createInProcessPendingAuthStore(): PendingAuthStore {
  const map = new Map<string, PendingAuthEntry>();
  return {
    put(stateToken, entry) {
      map.set(stateToken, entry);
    },
    get(stateToken) {
      return map.get(stateToken) ?? null;
    },
    delete(stateToken) {
      map.delete(stateToken);
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
  json(body: unknown): unknown;
  redirect(url: string): void;
  setHeader(name: string, value: string): void;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
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
  upsert(record: {
    ownerSubjectId: string;
    connectorId: string;
    displayName: string;
    status: string;
    sourceKind: string;
    sourceBindingKey: string;
    sourceBinding: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }): Promise<ConnectorInstance> | ConnectorInstance;
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
  canonicalConnectorKey(value: string | null | undefined): string | null;
  configuredProviderAuthConnectorKeys?: readonly string[];
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  exchanger: ProviderAuthExchanger;
  // Generates a cryptographically random state token. Prefix is "pas" (provider auth state).
  generateReferenceSecret(prefix: string, bytes?: number): string;
  generateSpineId(prefix: string): string;
  getOwnerSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  now?(): string;
  pdppError: PdppErrorFn;
  pendingAuthStore: PendingAuthStore;
  requireOwnerSession: MiddlewareHandler;
  resolveCallbackBaseUrl(req: unknown): string;
  resolveRegisteredConnectorManifest(connectorId: string): Promise<ConnectorManifestLike | null>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
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
    kind: "provider_auth_account",
    account_id: account.accountId,
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
    ownerSubjectId,
    connectorId,
    displayName,
    sourceKind: "account",
    sourceBindingKey,
    sourceBinding,
    createdAt: now,
    updatedAt: now,
  };
  const draftInstance = await store.upsert({ ...sharedRecord, status: "draft" });
  await exchanger.storeTokens({ connectorInstanceId: draftInstance.connectorInstanceId, ownerSubjectId, tokens, now });
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
    event_type: "owner.connection.provider_auth.initiate",
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    request_id: trace.request_id,
    actor_type: "owner_session",
    actor_id: ownerSubjectId ?? "owner_session",
    subject_type: "subject",
    subject_id: ownerSubjectId,
    object_type: "connection",
    object_id: args.connectorId ?? "unknown_connector",
    status: args.outcome,
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
    event_type: "owner.connection.provider_auth.callback",
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    request_id: trace.request_id,
    actor_type: "provider_callback",
    actor_id: args.ownerSubjectId ?? "provider_callback",
    subject_type: "subject",
    subject_id: args.ownerSubjectId ?? null,
    object_type: "connection",
    object_id: args.connectionId ?? args.connectorId ?? "unknown_connection",
    status: args.outcome,
    data: {
      connector_id: args.connectorId ?? null,
      connection_id: args.connectionId ?? null,
      // Number of accounts created, never IDs/emails — no PII in audit events
      account_count: args.accountIds?.length ?? null,
      operation: "provider_auth_callback",
      outcome: args.outcome,
      failure_reason: args.failureReason ?? null,
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
            },
          }
        : {}),
    },
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
          manifest: ConnectorManifestLike;
        } = { connectorKey: connectorId, manifest };
        if (ctx.configuredProviderAuthConnectorKeys) {
          setupPlanArgs.configuredProviderAuthConnectorKeys = ctx.configuredProviderAuthConnectorKeys;
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

        ctx.pendingAuthStore.put(stateToken, {
          connectorId,
          ownerSubjectId,
          createdAt: now,
          expiresAt,
        });

        const redirectUri = buildCallbackRedirectUri(ctx, req);
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
          object: "provider_auth_initiate",
          connector_id: connectorId,
          setup_modality: plan.setupModality,
          next_step: {
            kind: "open_provider_auth",
            authorization_url: initResult.authorizationUrl,
            redirect_uri: redirectUri,
            expires_at: expiresAt,
            reason:
              "Open the authorization_url in a browser to authorize the provider account. " +
              "The callback will complete setup and activate the connection after authorization " +
              "and account inventory succeed.",
          },
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
    stateToken: typeof query.state === "string" ? query.state.trim() : null,
    code: typeof query.code === "string" ? query.code.trim() : null,
    providerError: typeof query.error === "string" ? query.error.trim() : null,
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
    connectorId: pending?.connectorId ?? null,
    ownerSubjectId: pending?.ownerSubjectId ?? null,
    error: errWithCode("provider_auth_denied"),
    outcome: "failed",
    failureReason: "provider_error",
  });
  ctx.pdppError(res, 400, "provider_auth_denied", `Provider returned an error: ${params.providerError}.`);
  return "rejected";
}

async function rejectWithStateInvalid(ctx: MountRefProviderAuthContext, res: RouteResponse): Promise<"rejected"> {
  await emitCallbackAudit(ctx, res, {
    connectorId: null,
    ownerSubjectId: null,
    error: errWithCode("provider_auth_state_invalid"),
    outcome: "failed",
    failureReason: "state_invalid_or_missing",
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
    ownerSubjectId,
    error: errWithCode("provider_auth_state_expired"),
    outcome: "failed",
    failureReason: "state_expired",
  });
  ctx.pdppError(
    res,
    400,
    "provider_auth_state_expired",
    "The provider authorization state has expired. Restart the authorization flow."
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
    ownerSubjectId,
    error: errWithCode("provider_auth_code_missing"),
    outcome: "failed",
    failureReason: "code_missing",
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
  params: CallbackParams
): Promise<ValidatedCallbackState | "rejected"> {
  const { stateToken, code, providerError } = params;
  const pending = stateToken ? ctx.pendingAuthStore.get(stateToken) : null;

  if (providerError) {
    return rejectWithProviderError(ctx, res, params, pending);
  }

  if (!(stateToken && pending)) {
    return rejectWithStateInvalid(ctx, res);
  }

  const connectorId = pending.connectorId;
  const ownerSubjectId = pending.ownerSubjectId;
  const now = ctx.now ? ctx.now() : new Date().toISOString();

  if (now > pending.expiresAt) {
    return rejectWithStateExpired(ctx, res, stateToken, connectorId, ownerSubjectId);
  }

  if (!code) {
    return rejectWithCodeMissing(ctx, res, stateToken, connectorId, ownerSubjectId);
  }

  return Promise.resolve({ stateToken, code, pending, connectorId, ownerSubjectId, now });
}

async function exchangeCodeAndRunInventory(
  ctx: MountRefProviderAuthContext,
  res: RouteResponse,
  validated: ValidatedCallbackState,
  redirectUri: string
): Promise<{ tokens: ProviderAuthTokens; accounts: ProviderAccount[] } | "rejected"> {
  const { stateToken, code, connectorId, ownerSubjectId } = validated;

  const tokens = await ctx.exchanger.exchangeCode({ connectorId, code, redirectUri, state: stateToken });

  if (!tokens) {
    await emitCallbackAudit(ctx, res, {
      connectorId,
      ownerSubjectId,
      error: errWithCode("provider_auth_code_invalid"),
      outcome: "failed",
      failureReason: "code_exchange_failed",
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
      ownerSubjectId,
      error: inventoryErr,
      outcome: "failed",
      failureReason: "inventory_test_failed",
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

  if (!accounts || accounts.length === 0) {
    await emitCallbackAudit(ctx, res, {
      connectorId,
      ownerSubjectId,
      error: errWithCode("provider_auth_no_accounts"),
      outcome: "failed",
      failureReason: "no_accounts_returned",
    });
    ctx.pdppError(
      res,
      422,
      "provider_auth_no_accounts",
      "Account inventory returned no accounts. No connection was activated."
    );
    return "rejected";
  }

  return { tokens, accounts };
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
    const instance = await activateConnectorInstanceForAccount(store, ctx.exchanger, {
      ownerSubjectId: validated.ownerSubjectId,
      connectorId: validated.connectorId,
      account,
      tokens,
      now: validated.now,
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
      const validated = await validateCallbackStateAndCode(ctx, res, params);
      if (validated === "rejected") {
        return;
      }

      resolvedConnectorId = validated.connectorId;
      resolvedOwnerSubjectId = validated.ownerSubjectId;

      // Consume the state token immediately — replay protection.
      ctx.pendingAuthStore.delete(validated.stateToken);

      const redirectUri = buildCallbackRedirectUri(ctx, req);
      const exchanged = await exchangeCodeAndRunInventory(ctx, res, validated, redirectUri);
      if (exchanged === "rejected") {
        return;
      }

      const activatedInstances = await activateAllAccounts(ctx, validated, exchanged.tokens, exchanged.accounts);

      await emitCallbackAudit(ctx, res, {
        connectorId: resolvedConnectorId,
        connectionId: activatedInstances[0]?.connectorInstanceId ?? null,
        accountIds: activatedInstances.map((i) => i.connectorInstanceId),
        outcome: "succeeded",
        ownerSubjectId: resolvedOwnerSubjectId,
      });

      res.status(201).json({
        object: "provider_auth_callback",
        connector_id: resolvedConnectorId,
        connections: activatedInstances.map((inst) => ({
          connection_id: inst.connectorInstanceId,
          connector_instance_id: inst.connectorInstanceId,
          connector_id: inst.connectorId,
          status: inst.status,
        })),
        next_step: {
          kind: "run_connection",
          reason: "Provider authorization completed and account inventory succeeded. The connection is now active.",
        },
      });
    } catch (err) {
      await emitCallbackAudit(ctx, res, {
        connectorId:
          resolvedConnectorId ||
          (params.stateToken ? (ctx.pendingAuthStore.get(params.stateToken)?.connectorId ?? null) : null),
        ownerSubjectId:
          resolvedOwnerSubjectId ||
          (params.stateToken ? (ctx.pendingAuthStore.get(params.stateToken)?.ownerSubjectId ?? null) : null),
        error: err,
        outcome: "failed",
        failureReason: "unexpected_error",
      });
      ctx.handleError(res, err);
    }
  });
}
