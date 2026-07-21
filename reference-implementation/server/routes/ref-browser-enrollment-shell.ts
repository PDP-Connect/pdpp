// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reference-only owner-session browser-enrollment-shell creation and abandonment.
//
// A browser-enrollment shell is the pre-credential connection record created
// when an owner starts the in-dashboard browser-bound setup flow. It mirrors
// the static-secret draft pattern (invisible `draft` status, hidden from all
// list/read surfaces) but carries a TTL in its sourceBinding so it is
// automatically retired to `revoked` if the owner abandons it without
// completing enrollment.
//
// Two endpoints:
//   POST /_ref/connectors/:connectorId/browser-enrollment-shell
//     Creates a browser-enrollment shell. Returns connection_id + TTL deadline.
//
//   POST /_ref/connections/:connectorInstanceId/abandon-enrollment
//     Explicit owner dismissal. Retires the shell immediately (revoked). No-op
//     if already retired; typed error if not a shell or wrong owner.
//
// TTL retirement runs either at explicit abandon time OR via
// `retireExpiredBrowserEnrollmentShells()` (callable from a periodic sweep or
// startup). Shells that completed enrollment are `active` and are never
// touched by retirement.
//
// Security constraints:
//   - Owner-session (cookie) only — no bearer, no grant-scoped access.
//   - No provider secret, browser session cookie, or credential accepted/returned.
//   - Only browser-bound connectors accepted; static-secret/local-collector
//     connectors are refused with a typed 409.
//   - Shells are invisible to every list/count/owner-console surface until enrollment
//     captures source identity and flips the shell to `active`.

import { randomBytes } from "node:crypto";

import {
  type ConnectorManifestLike,
  displayNameForConnector,
  isBrowserBoundConnector,
} from "../connection-setup-plan.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// TTL applied to every new browser-enrollment shell: 2 hours. This is long
// enough for an owner to complete a manual MFA / CAPTCHA flow in the embedded
// browser surface, and short enough that an abandoned shell does not sit in
// `draft` indefinitely. Per data-ops retirement contract, every draft row must
// have a retirement rule at creation time.
export const BROWSER_ENROLLMENT_SHELL_TTL_MS = 2 * 60 * 60 * 1000;

export interface BrowserEnrollmentShellSourceBinding {
  readonly connector_id: string;
  readonly enrollment_expires_at: string;
  readonly kind: "browser_enrollment_shell";
}

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

interface ConnectorInstance {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly displayName?: string | null;
  readonly ownerSubjectId: string;
  readonly sourceBinding?: Record<string, unknown> | null;
  readonly status: string;
}

interface ConnectorInstanceStore {
  get(id: string): Promise<ConnectorInstance | null> | ConnectorInstance | null;
  updateStatus(
    connectorInstanceId: string,
    args: { status: string; updatedAt: string; revokedAt?: string | null }
  ): Promise<ConnectorInstance | null> | ConnectorInstance | null;
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

interface BrowserEnrollmentShellCreateBody {
  readonly display_name?: unknown;
}

export interface MountRefBrowserEnrollmentShellContext {
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
  resolveRegisteredConnectorManifest(connectorId: string): Promise<ConnectorManifestLike>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
}

function buildAuditTrace(ctx: MountRefBrowserEnrollmentShellContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return { request_id: requestId, scenario_id: trace.scenario_id, trace_id: trace.trace_id };
}

async function emitShellAudit(
  ctx: MountRefBrowserEnrollmentShellContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorId?: string | null;
    error?: unknown;
    operation: string;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const ownerSubjectId = args.ownerSubjectId ?? req.ownerSession?.sub ?? null;
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    event_type: `owner.connection.browser_enrollment_shell.${args.operation}`,
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
      operation: args.operation,
      outcome: args.outcome,
      ...(args.error ? { error: { code: typeof code === "string" ? code : "api_error" } } : {}),
    },
  });
}

function parseBrowserEnrollmentShellDisplayName(
  body: unknown,
  fallbackDisplayName: string
): { displayName: string } | { error: { message: string; param?: "display_name" } } {
  if (body === undefined || body === null || body === "") {
    return { displayName: fallbackDisplayName };
  }

  if (typeof body === "string") {
    if (!body.trim()) {
      return { displayName: fallbackDisplayName };
    }
    return { error: { message: "Request body must be a JSON object" } };
  }

  if (typeof body !== "object" || Array.isArray(body)) {
    return { error: { message: "Request body must be a JSON object" } };
  }

  const record = body as BrowserEnrollmentShellCreateBody;
  if (!Object.hasOwn(record, "display_name")) {
    return { displayName: fallbackDisplayName };
  }

  if (typeof record.display_name !== "string") {
    return { error: { message: "display_name must be a string", param: "display_name" } };
  }

  const trimmed = record.display_name.trim();
  if (!trimmed) {
    return { displayName: fallbackDisplayName };
  }
  if (trimmed.length > 200) {
    return {
      error: {
        message: "display_name must be a string up to 200 characters when provided",
        param: "display_name",
      },
    };
  }

  return { displayName: trimmed };
}

// POST /_ref/connectors/:connectorId/browser-enrollment-shell
//
// Owner-session-only. Creates one invisible `draft` browser-enrollment shell for
// a browser-bound connector. Returns connection_id + enrollment_expires_at
// (ISO8601 UTC). No secret is accepted or returned.
//
// Every shell is uniquely identified by a fresh random source-binding-key so two
// concurrent enrollment attempts create two independent shell rows.
//
// POST /_ref/connections/:connectorInstanceId/abandon-enrollment
//
// Owner-session-only. Retires a browser-enrollment shell immediately (status →
// revoked). No-op when already retired (idempotent). Typed 409 when the shell is
// already active (enrollment completed). Typed 404 when not found or wrong owner.
export function mountRefBrowserEnrollmentShell(app: AppLike, ctx: MountRefBrowserEnrollmentShellContext): void {
  app.post(
    "/_ref/connectors/:connectorId/browser-enrollment-shell",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      let ownerSubjectId: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);

        // Reject unknown connector before doing anything else (404).
        const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);

        if (!isBrowserBoundConnector(connectorId)) {
          await emitShellAudit(ctx, req, res, {
            connectorId,
            error: { code: "connector_not_browser_bound" },
            operation: "create",
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            409,
            "connector_not_browser_bound",
            `Connector '${connectorId}' is not browser-bound. Browser enrollment shells are only created for browser-bound connectors.`
          );
          return;
        }

        const parsedDisplayName = parseBrowserEnrollmentShellDisplayName(
          req.body,
          displayNameForConnector(connectorId, manifest)
        );
        if ("error" in parsedDisplayName) {
          await emitShellAudit(ctx, req, res, {
            connectorId,
            error: { code: "invalid_request", message: parsedDisplayName.error.message },
            operation: "create",
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(res, 400, "invalid_request", parsedDisplayName.error.message, parsedDisplayName.error.param);
          return;
        }

        const now = ctx.now ? ctx.now() : new Date().toISOString();
        const expiresAt = new Date(new Date(now).getTime() + BROWSER_ENROLLMENT_SHELL_TTL_MS).toISOString();

        // Fresh random binding key: two concurrent enrollment attempts produce two
        // independent shell rows rather than colliding on one upsert.
        const sourceBindingKey = `browser_shell_${randomBytes(24).toString("hex")}`;
        const sourceBinding: BrowserEnrollmentShellSourceBinding = {
          kind: "browser_enrollment_shell",
          connector_id: connectorId,
          enrollment_expires_at: expiresAt,
        };

        const store = ctx.createRequestConnectorInstanceStore();
        const instance = await store.upsert({
          ownerSubjectId,
          connectorId,
          displayName: parsedDisplayName.displayName,
          status: "draft",
          sourceKind: "account",
          sourceBindingKey,
          sourceBinding: sourceBinding as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        });

        await emitShellAudit(ctx, req, res, {
          connectionId: instance.connectorInstanceId,
          connectorId,
          operation: "create",
          outcome: "succeeded",
          ownerSubjectId,
        });

        res.status(201).json({
          object: "browser_enrollment_shell",
          connection_id: instance.connectorInstanceId,
          connector_instance_id: instance.connectorInstanceId,
          connector_id: connectorId,
          display_name: parsedDisplayName.displayName,
          status: instance.status,
          enrollment_expires_at: expiresAt,
          next_step: {
            kind: "browser_enrollment_run",
            reason:
              "Start a bounded enrollment run for this shell. The run embeds the existing browser surface in the dashboard. When the owner completes login and the connector captures the session, the shell transitions to active and first sync begins as a normal run.",
          },
        });
      } catch (err) {
        await emitShellAudit(ctx, req, res, {
          connectorId,
          error: err,
          operation: "create",
          outcome: "failed",
          ownerSubjectId,
        });
        ctx.handleError(res, err);
      }
    }
  );

  app.post(
    "/_ref/connections/:connectorInstanceId/abandon-enrollment",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
      let ownerSubjectId: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        const store = ctx.createRequestConnectorInstanceStore();
        const instance = await store.get(connectorInstanceId);

        if (!instance || instance.ownerSubjectId !== ownerSubjectId) {
          ctx.pdppError(
            res,
            404,
            "connection_not_found",
            `Connection '${connectorInstanceId}' was not found or does not belong to this owner.`
          );
          return;
        }

        const binding = instance.sourceBinding as Partial<BrowserEnrollmentShellSourceBinding> | null;
        if (binding?.kind !== "browser_enrollment_shell") {
          ctx.pdppError(
            res,
            409,
            "not_an_enrollment_shell",
            `Connection '${connectorInstanceId}' is not a browser-enrollment shell.`
          );
          return;
        }

        if (instance.status === "active") {
          ctx.pdppError(
            res,
            409,
            "enrollment_already_complete",
            `Connection '${connectorInstanceId}' has already completed enrollment and is active.`
          );
          return;
        }

        // Already retired — idempotent success.
        if (instance.status === "revoked") {
          await emitShellAudit(ctx, req, res, {
            connectionId: connectorInstanceId,
            connectorId: instance.connectorId,
            operation: "abandon",
            outcome: "succeeded",
            ownerSubjectId,
          });
          res.status(200).json({
            object: "enrollment_abandoned",
            connection_id: connectorInstanceId,
            connector_id: instance.connectorId,
            status: "revoked",
          });
          return;
        }

        const now = ctx.now ? ctx.now() : new Date().toISOString();
        await store.updateStatus(connectorInstanceId, {
          status: "revoked",
          updatedAt: now,
          revokedAt: now,
        });

        await emitShellAudit(ctx, req, res, {
          connectionId: connectorInstanceId,
          connectorId: instance.connectorId,
          operation: "abandon",
          outcome: "succeeded",
          ownerSubjectId,
        });

        res.status(200).json({
          object: "enrollment_abandoned",
          connection_id: connectorInstanceId,
          connector_id: instance.connectorId,
          status: "revoked",
        });
      } catch (err) {
        await emitShellAudit(ctx, req, res, {
          connectorId: null,
          connectionId: connectorInstanceId,
          error: err,
          operation: "abandon",
          outcome: "failed",
          ownerSubjectId,
        });
        ctx.handleError(res, err);
      }
    }
  );
}
