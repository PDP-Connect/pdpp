// Reference-only owner-session static-secret credential capture.
//
// This is the owner-trusted surface for sealing a provider static secret
// (Gmail app password, GitHub PAT) onto one existing connection. It is NOT an
// owner-agent bearer route and it never returns the submitted secret. The
// owner-agent intent branch remains `unsupported` until the committed
// end-to-end proof lands.

import { expectedStaticSecretCredentialKind } from "../connection-setup-plan.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import { codeToStatus } from "./ref-error-status.ts";

interface RouteRequest {
  readonly body?: unknown;
  ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  getHeader(name: string): string | number | string[] | undefined;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): void;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

interface ConnectorNamespace {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
}

interface CredentialMetadata {
  readonly capturedAt?: string | null;
  readonly connectorInstanceId?: string | null;
  readonly credentialKind?: string | null;
  readonly fingerprint?: string | null;
  readonly present?: boolean;
  readonly revokedAt?: string | null;
  readonly rotatedAt?: string | null;
  readonly status?: string | null;
}

interface ConnectorInstanceCredentialStore {
  capture(input: {
    connectorInstanceId: string;
    ownerSubjectId: string;
    credentialKind: string;
    secret: string;
    now: string;
  }): Promise<CredentialMetadata> | CredentialMetadata;
  getMetadata(connectorInstanceId: string): Promise<CredentialMetadata | null> | CredentialMetadata | null;
}

export interface MountRefStaticSecretCredentialsContext {
  createRequestConnectorInstanceCredentialStore(): ConnectorInstanceCredentialStore;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  getOwnerSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  now?(): string;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  resolveOwnerConnectorNamespace(
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly allowStatuses?: readonly string[];
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ): Promise<ConnectorNamespace>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
}

const MAX_SECRET_LENGTH = 64 * 1024;

function errWithCode(code: string): { code: string } {
  return { code };
}

function expectedCredentialKindForConnector(connectorId: string): string | null {
  return expectedStaticSecretCredentialKind(connectorId);
}

function projectCredentialMetadata(meta: CredentialMetadata): Record<string, unknown> {
  return {
    present: meta.present === true,
    credential_kind: meta.credentialKind ?? null,
    status: meta.status ?? null,
    fingerprint: meta.fingerprint ?? null,
    captured_at: meta.capturedAt ?? null,
    rotated_at: meta.rotatedAt ?? null,
    revoked_at: meta.revokedAt ?? null,
  };
}

function credentialCaptureErrorStatus(err: unknown): number {
  const code = (err as { code?: unknown })?.code;
  if (code === "credential_encryption_key_missing" || code === "credential_encryption_key_invalid") {
    return 503;
  }
  return typeof code === "string" ? (codeToStatus[code] ?? 500) : 500;
}

function buildAuditTrace(ctx: MountRefStaticSecretCredentialsContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return {
    request_id: requestId,
    scenario_id: trace.scenario_id,
    trace_id: trace.trace_id,
  };
}

async function emitCaptureAudit(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorId?: string | null;
    credentialKind?: string | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
    rotated?: boolean;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const ownerSubjectId = args.ownerSubjectId ?? req.ownerSession?.sub ?? null;
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    event_type: "owner.connection.static_secret_credential.capture",
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    request_id: trace.request_id,
    actor_type: "owner_session",
    actor_id: ownerSubjectId ?? "owner_session",
    subject_type: "subject",
    subject_id: ownerSubjectId,
    object_type: "connection",
    object_id: args.connectionId ?? "unknown_connection",
    status: args.outcome,
    data: {
      connection_id: args.connectionId ?? null,
      connector_id: args.connectorId ?? null,
      credential_kind: args.credentialKind ?? null,
      operation: "capture_static_secret_credential",
      outcome: args.outcome,
      rotated: args.rotated ?? false,
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

function parseCaptureBody(
  ctx: MountRefStaticSecretCredentialsContext,
  res: RouteResponse,
  body: unknown
): { credentialKind: string | null; secret: string } | null {
  const objectBody = (body as Record<string, unknown> | null) || {};
  const secret = objectBody.secret;
  if (typeof secret !== "string" || secret.length === 0 || Buffer.byteLength(secret, "utf8") > MAX_SECRET_LENGTH) {
    ctx.pdppError(
      res,
      400,
      "invalid_request",
      `secret must be a non-empty string no longer than ${MAX_SECRET_LENGTH} bytes`,
      "secret"
    );
    return null;
  }
  return {
    credentialKind: typeof objectBody.credential_kind === "string" ? objectBody.credential_kind.trim() : null,
    secret,
  };
}

// POST /_ref/connections/:connectorInstanceId/static-secret-credential
//
// Owner-session-only credential capture for one existing connection. The
// plaintext appears only in the request body and the store's sealing call; the
// response and audit event contain non-secret metadata only.
export function mountRefStaticSecretCredentialCapture(app: AppLike, ctx: MountRefStaticSecretCredentialsContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/static-secret-credential",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
      let ownerSubjectId: string | null = null;
      let namespace: ConnectorNamespace | null = null;
      let credentialKind: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        const capture = parseCaptureBody(ctx, res, req.body);
        if (!capture) {
          await emitCaptureAudit(ctx, req, res, {
            connectionId: connectorInstanceId,
            credentialKind,
            error: errWithCode("invalid_request"),
            outcome: "failed",
            ownerSubjectId,
          });
          return;
        }
        credentialKind = capture.credentialKind;
        namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
          ownerSubjectId,
          allowDefaultAccount: false,
          // Admit a `draft` target so the owner can seal a credential onto a
          // not-yet-ingested first static-secret connection. This is owner-
          // session-only; no bearer/agent path passes allowStatuses. See
          // add-static-secret-owner-session-connect-path design Decisions 3 & 5.
          allowStatuses: ["active", "draft"],
          connectorInstanceId,
        });
        const expectedKind = expectedCredentialKindForConnector(namespace.connectorId);
        if (!expectedKind) {
          await emitCaptureAudit(ctx, req, res, {
            connectionId: namespace.connectorInstanceId,
            connectorId: namespace.connectorId,
            credentialKind,
            error: errWithCode("static_secret_credential_unsupported"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            409,
            "static_secret_credential_unsupported",
            `Connection '${namespace.connectorInstanceId}' belongs to connector '${namespace.connectorId}', which is not a static-secret connector.`
          );
          return;
        }
        if (credentialKind !== expectedKind) {
          await emitCaptureAudit(ctx, req, res, {
            connectionId: namespace.connectorInstanceId,
            connectorId: namespace.connectorId,
            credentialKind,
            error: errWithCode("credential_kind_mismatch"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            400,
            "credential_kind_mismatch",
            `credential_kind must be '${expectedKind}' for connector '${namespace.connectorId}'.`,
            "credential_kind"
          );
          return;
        }
        const store = ctx.createRequestConnectorInstanceCredentialStore();
        const previous = await store.getMetadata(namespace.connectorInstanceId);
        const now = ctx.now ? ctx.now() : new Date().toISOString();
        const metadata = await store.capture({
          connectorInstanceId: namespace.connectorInstanceId,
          ownerSubjectId,
          credentialKind,
          secret: capture.secret,
          now,
        });
        const rotated = Boolean(previous);
        await emitCaptureAudit(ctx, req, res, {
          connectionId: namespace.connectorInstanceId,
          connectorId: namespace.connectorId,
          credentialKind,
          outcome: "succeeded",
          ownerSubjectId,
          rotated,
        });
        res.status(rotated ? 200 : 201).json({
          object: "static_secret_credential_capture",
          connection_id: namespace.connectorInstanceId,
          connector_instance_id: namespace.connectorInstanceId,
          connector_id: namespace.connectorId,
          credential: projectCredentialMetadata(metadata),
          next_step: {
            kind: "run_connection",
            method: "POST",
            url: `/_ref/connections/${encodeURIComponent(namespace.connectorInstanceId)}/run`,
            reason:
              "Run this connection from the owner session or scheduler. The owner-agent initiate_connection branch remains unsupported until live end-to-end proof lands.",
          },
        });
      } catch (err) {
        await emitCaptureAudit(ctx, req, res, {
          connectionId: namespace?.connectorInstanceId ?? connectorInstanceId,
          connectorId: namespace?.connectorId ?? null,
          credentialKind,
          error: err,
          outcome: "failed",
          ownerSubjectId,
        });
        const status = credentialCaptureErrorStatus(err);
        const code = (err as { code?: unknown })?.code;
        if (typeof code === "string" && status !== 500) {
          ctx.pdppError(res, status, code, (err as Error).message);
          return;
        }
        ctx.handleError(res, err);
      }
    }
  );
}
