// Reference-only owner-session static-secret DRAFT-connection creation.
//
// This is the owner-trusted surface that creates the FIRST connection for a
// static-secret connector (Gmail, GitHub) without writing a phantom active
// zero-record row. It creates a `draft` connector instance — a real row that is
// invisible to every connection read surface — and points the owner at the
// existing capture route to seal the credential. The draft flips to `active`
// only on its first successful ingest (handled at the RS ingest boundary).
//
// It is NOT an owner-agent bearer route: `requireOwnerSession` (cookie) gates
// it, and it never accepts or returns a provider secret. Non-static-secret
// connectors are refused. Each call mints a fresh random source-binding key, so
// two mailboxes become two distinct `connection_id`s. See
// add-static-secret-owner-session-connect-path design Decision 4.

import { randomBytes } from "node:crypto";

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import { expectedStaticSecretCredentialKind } from "./ref-static-secret-credentials.ts";

interface RouteRequest {
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

export interface MountRefStaticSecretDraftConnectionContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  getOwnerSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  now?(): string;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  // Resolves a registered connector manifest, throwing a typed not_found when
  // the connector is unknown. Used only to reject an unknown connector id with
  // 404 before creating a draft.
  resolveRegisteredConnectorManifest(connectorId: string): Promise<unknown>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
}

function errWithCode(code: string): { code: string } {
  return { code };
}

function buildAuditTrace(ctx: MountRefStaticSecretDraftConnectionContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return {
    request_id: requestId,
    scenario_id: trace.scenario_id,
    trace_id: trace.trace_id,
  };
}

async function emitDraftAudit(
  ctx: MountRefStaticSecretDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorId?: string | null;
    credentialKind?: string | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const ownerSubjectId = args.ownerSubjectId ?? req.ownerSession?.sub ?? null;
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    event_type: "owner.connection.static_secret_draft.create",
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
      operation: "create_static_secret_draft_connection",
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

// POST /_ref/connectors/:connectorId/draft-connection
//
// Owner-session-only. Creates one invisible `draft` connection for a
// static-secret connector and returns its `connection_id` plus a typed next
// step pointing at the capture route. No secret is accepted or returned.
export function mountRefStaticSecretDraftConnection(
  app: AppLike,
  ctx: MountRefStaticSecretDraftConnectionContext
): void {
  app.post(
    "/_ref/connectors/:connectorId/draft-connection",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      let ownerSubjectId: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);

        // Reject an unknown connector before doing anything else (404).
        await ctx.resolveRegisteredConnectorManifest(connectorId);

        const credentialKind = expectedStaticSecretCredentialKind(connectorId);
        if (!credentialKind) {
          await emitDraftAudit(ctx, req, res, {
            connectorId,
            error: errWithCode("static_secret_credential_unsupported"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            409,
            "static_secret_credential_unsupported",
            `Connector '${connectorId}' is not a static-secret connector; a draft connection is only created for static-secret connectors.`
          );
          return;
        }

        // A fresh random binding key makes every draft a distinct connection
        // identity (two mailboxes → two connection_ids) and deliberately avoids
        // the deterministic default-account key, which is the phantom-
        // resurrection key. The store derives the connector_instance_id from
        // the binding key.
        const sourceBindingKey = `draft_${randomBytes(24).toString("hex")}`;
        const now = ctx.now ? ctx.now() : new Date().toISOString();
        const store = ctx.createRequestConnectorInstanceStore();
        const instance = await store.upsert({
          ownerSubjectId,
          connectorId,
          displayName: connectorId,
          status: "draft",
          sourceKind: "account",
          sourceBindingKey,
          sourceBinding: { kind: "static_secret_draft" },
          createdAt: now,
          updatedAt: now,
        });

        await emitDraftAudit(ctx, req, res, {
          connectionId: instance.connectorInstanceId,
          connectorId,
          credentialKind,
          outcome: "succeeded",
          ownerSubjectId,
        });

        res.status(201).json({
          object: "static_secret_draft_connection",
          connection_id: instance.connectorInstanceId,
          connector_instance_id: instance.connectorInstanceId,
          connector_id: connectorId,
          status: instance.status,
          credential_kind: credentialKind,
          next_step: {
            kind: "capture_static_secret_credential",
            method: "POST",
            url: `/_ref/connections/${encodeURIComponent(instance.connectorInstanceId)}/static-secret-credential`,
            reason:
              "Capture the provider static secret onto this draft from the owner session. The connection stays invisible until its first successful ingest.",
          },
        });
      } catch (err) {
        await emitDraftAudit(ctx, req, res, {
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
